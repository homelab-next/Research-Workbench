import type { CaseSession } from "../core/session";
import { unloadDue } from "../core/state";
import type { Actor } from "../core/types";
import { CaseNotFoundError, CaseRefused, unloadProblem } from "../core/workbench";
import type { NewCase, UnloadResult, Workbench } from "../core/workbench";
import { Engine } from "../pipeline/engine";
import type { EngineDeps } from "../pipeline/engine";

/** Who unloads a case after publishing: the person chose it at approve; the workbench does it. */
const WORKBENCH: Actor = { kind: "system", id: "workbench" };
/** The queue store work runs in; no case id looks like it. */
const STORE_LINE = "store";

/** The one place that holds a case's session and engine for the server, so a case has one engine and background work has one account. */
export class CaseHub {
  private readonly engines = new Map<string, Engine>();
  /** The session each engine was made for: a session closed and opened again is a new one and needs a new engine. */
  private readonly sessionOf = new WeakMap<Engine, CaseSession>();
  private readonly flying = new Set<Promise<unknown>>();
  /** Work that may finish a run, in flight per case: while any is, the case is not unloaded. */
  private readonly working = new Map<string, number>();
  /** The streams open on each case, so they can be ended when it is unloaded. */
  private readonly streams = new Map<string, Set<(why?: "unloaded") => void>>();
  /** Proposals being run now, as "case:proposal", so a second press cannot start a second run while the first is still pricing. */
  readonly running = new Set<string>();

  constructor(private readonly wb: Workbench, readonly deps: EngineDeps, private readonly onError: (error: unknown) => void) {}

  /** For reads: the session, with no engine and no recovery. Throws CaseNotFoundError. */
  read(id: string): CaseSession {
    return this.wb.session(id);
  }

  /** For commands: the case's one engine, made with Engine.open (which recovers the case) on first use. */
  engine(id: string): Engine {
    const session = this.wb.session(id);
    const have = this.engines.get(id);
    if (have !== undefined && this.sessionOf.get(have) === session) return have;
    const made = Engine.open(session, this.deps);
    this.engines.set(id, made);
    this.sessionOf.set(made, session);
    return made;
  }
  private readonly lines = new Map<string, Promise<unknown>>();

  /** Runs `work` after every earlier piece of work for this case has finished, so commands for a case never interleave. */
  serial<T>(id: string, work: () => Promise<T> | T): Promise<T> {
    const after = this.lines.get(id) ?? Promise.resolve();
    const mine = after.then(work, work);
    const tail = mine.then(() => undefined, () => undefined);
    this.lines.set(id, tail);
    void tail.then(() => { if (this.lines.get(id) === tail) this.lines.delete(id); });
    return mine;
  }

  create(input: NewCase, actor: Actor): CaseSession {
    return this.wb.createCase(input, actor);
  }

  /** Calls engine.advance() without waiting; a failure goes to onError. */
  drive(id: string): void {
    let started: Promise<unknown>;
    try {
      started = this.engine(id).advance();
    } catch (error) {
      started = Promise.reject(error);
    }
    this.follow(id, started);
  }

  /** Registers a stream of a case, so it can be ended when the case is unloaded. Returns the function that forgets it. */
  track(id: string, close: (why?: "unloaded") => void): () => void {
    let set = this.streams.get(id);
    if (set === undefined) this.streams.set(id, set = new Set());
    set.add(close);
    return () => {
      const have = this.streams.get(id);
      if (have === undefined) return;
      have.delete(close);
      if (have.size === 0) this.streams.delete(id);
    };
  }

  /** Tracks work that may finish a run; when it settles, a case that is due is unloaded. `drive` uses it. */
  follow(id: string, work: Promise<unknown>): void {
    this.working.set(id, (this.working.get(id) ?? 0) + 1);
    this.background(work.finally(() => {
      const left = (this.working.get(id) ?? 1) - 1;
      if (left > 0) {
        this.working.set(id, left);
        return;
      }
      this.working.delete(id);
      // the person's choice at the publish gate, acted on once nothing is working on the case
      let due = false;
      try {
        due = unloadDue(this.wb.session(id).state);
      } catch (error) {
        if (!(error instanceof CaseNotFoundError || error instanceof CaseRefused)) throw error;
      }
      if (due) this.background(this.unloadAfterPublishing(id));
    }));
  }

  /** The unload the person asked for with approve. A refusal is recorded as case.unload_failed, which clears the choice, so it is not tried again. */
  private async unloadAfterPublishing(id: string): Promise<void> {
    try {
      await this.unload(id, WORKBENCH);
    } catch (error) {
      if (!(error instanceof CaseRefused)) throw error;
      await this.serial(id, () => {
        const session = this.wb.session(id);
        if (!unloadDue(session.state)) return;
        session.commit(() => [{ type: "case.unload_failed", payload: { reason: error.reasons[0]! }, actor: WORKBENCH }]);
      });
    }
  }

  /**
   * In the case's queue: refuses while a drive is in flight, ends the case's streams, forgets its engine, and unloads it. Throws CaseRefused
   * (nothing written) or CaseNotFoundError; an unload that fails after it began is `{ ok: false }`, recorded in the case.
   */
  unload(id: string, actor: Actor, opts: { to?: string } = {}): Promise<UnloadResult> {
    return this.serial(id, async () => {
      const problem = unloadProblem(this.wb.session(id).state);
      if (problem !== null) throw new CaseRefused(problem);
      if ((this.working.get(id) ?? 0) > 0) throw new CaseRefused("the workbench is still working on this case");
      let result: UnloadResult;
      try {
        result = await this.wb.unloadCase(id, { actor, ...(opts.to === undefined ? {} : { to: opts.to }) });
      } finally {
        // the session the engine held is closed, or the case was refused and the engine is still good
        const have = this.engines.get(id);
        if (have !== undefined && this.sessionOf.get(have)?.open !== true) this.engines.delete(id);
      }
      // a stream of the case was on the session the unload closed: unloaded, it ends saying so; failed, it ends and the client comes back to the new session
      for (const end of [...(this.streams.get(id) ?? [])]) end(result.ok ? "unloaded" : undefined);
      return result;
    });
  }

  /** Loads a file in the store by its name, one load at a time, so two loads cannot both take an id. Throws CaseFileError or CaseRefused. */
  load(file: string, actor: Actor): Promise<{ id: string }> {
    return this.serial(STORE_LINE, async () => {
      const { id } = await this.wb.loadCase(this.wb.store.path(file), { actor });
      return { id };
    });
  }

  /** Runs store work (a load, a delete) one at a time. */
  inStore<T>(work: () => Promise<T> | T): Promise<T> {
    return this.serial(STORE_LINE, work);
  }

  /** Tracks other work that goes on after a response (a resume, a model turn, a route); a failure goes to onError. */
  background(work: Promise<unknown>): void {
    const tracked: Promise<unknown> = work.then(() => undefined, (error: unknown) => {
      try {
        this.onError(error);
      } catch { /* a failing reporter must not end the process */ }
    }).finally(() => { this.flying.delete(tracked); });
    this.flying.add(tracked);
  }

  /** Resolves when no drive and no background work is in flight. Tests wait on it. */
  async idle(): Promise<void> {
    while (this.flying.size > 0) await Promise.all([...this.flying]);
  }
}
