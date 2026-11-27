import { canonical } from "../core/canonical";
import type { Json } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { CaseSession } from "../core/session";
import { unloadDue } from "../core/state";
import { isMarking, strictest } from "../core/types";
import type { Actor, Card, Marking } from "../core/types";
import { CaseNotFoundError, CaseRefused, unloadProblem } from "../core/workbench";
import type { ChildLink, NewCase, UnloadResult, Workbench } from "../core/workbench";
import { Engine } from "../pipeline/engine";
import type { EngineDeps, RunSummary } from "../pipeline/engine";
import { notTheChild, readChild } from "../pipeline/subloop";
import type { ChildCases, ChildRef } from "../pipeline/subloop";

/** Who unloads a case after publishing: the person chose it at approve; the workbench does it. */
const WORKBENCH: Actor = { kind: "system", id: "workbench" };
/** Who makes a child case, starts its run and records what a loop's run gave: code, never a person, and it passes no gate. */
const ENGINE: Actor = { kind: "system", id: "engine" };
const gone = (error: unknown): boolean => error instanceof CaseNotFoundError || error instanceof CaseRefused;

/** The marking of one output value: a product's or findings' own; a list of cards, the strictest of theirs; else the case's. */
function markingOf(value: Json, fallback: Marking): Marking {
  if (typeof value === "object" && value !== null && !Array.isArray(value) && isMarking(value.marking)) return value.marking;
  if (Array.isArray(value)) {
    const marks = value.flatMap((c) => (typeof c === "object" && c !== null && !Array.isArray(c) && isMarking(c.marking) ? [c.marking] : []));
    if (marks.length > 0) return marks.reduce((a, b) => strictest(a, b));
  }
  return fallback;
}
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

  /**
   * The deps are the server's own (compose's, which a reload changes in place). The hub gives them the way a sub-loop stage reaches its
   * child cases (`children`) and the way a run's outputs reach the workbench chain (`onOutputs`, as loop.output).
   */
  constructor(private readonly wb: Workbench, readonly deps: EngineDeps, private readonly onError: (error: unknown) => void) {
    deps.children = this.children;
    deps.onOutputs = (o) => {
      const inputs: Parameters<Workbench["chain"]["appendMany"]>[0] = [];
      for (const output of Object.keys(o.outputs).sort()) {
        const value = o.outputs[output]!;
        const text = canonical(value);
        inputs.push({
          type: "loop.output", actor: ENGINE,
          payload: { loop: o.loop, output, case: o.case, run: o.run, head: o.head, outcome: o.outcome, marking: markingOf(value, o.marking), hash: sha256Hex(text), value: wb.chainBlobs.put(text) },
        });
      }
      if (inputs.length > 0) wb.chain.appendMany(inputs);
    };
  }

  /**
   * The child cases of a sub-loop stage, over this workbench and the hub's own engines: a child is an ordinary case, made by the engine, whose
   * run is started by the engine and carried as far as it goes without a person. Nothing here passes a gate.
   */
  readonly children: ChildCases = {
    find: (link: ChildLink) => {
      const id = this.wb.findChild(link);
      const origin = id === null ? null : this.wb.loadedOrigin(id);
      return id === null || origin === null ? null : { id, origin };
    },
    create: (input: NewCase, link: ChildLink, cards: Card[]) => {
      const made = this.wb.createCase(input, ENGINE, { loop: link.loop, link, cards });
      return { id: made.id, origin: made.entries(0, 1)[0]!.hash };
    },
    drive: async (ref: ChildRef): Promise<RunSummary> => {
      // never a run on a case that is not this child: ids repeat across workbenches
      if (this.children.read(ref) === null) throw new CaseRefused(notTheChild(ref));
      const engine = this.engine(ref.id);
      if (this.wb.session(ref.id).state.run.status === "none") engine.start(ENGINE);
      return engine.advance();
    },
    read: (ref: ChildRef) => {
      let session: CaseSession;
      try {
        session = this.wb.session(ref.id);
      } catch (error) {
        if (gone(error)) return null;
        throw error;
      }
      return readChild(session, ref);
    },
  };

  /**
   * The deps a case's reads use: Engine.bound of its engine when it has one, else what a new engine would bind (made, read and let go here:
   * nothing is written and nothing is recovered). Throws CaseNotFoundError.
   */
  depsFor(id: string): EngineDeps {
    const session = this.wb.session(id);
    const have = this.engines.get(id);
    if (have !== undefined && this.sessionOf.get(have) === session) return have.bound;
    const looking = new Engine(session, this.deps);
    try {
      return looking.bound;
    } finally {
      looking.close();
    }
  }

  /** For reads: the session, with no engine and no recovery. Throws CaseNotFoundError. */
  read(id: string): CaseSession {
    return this.wb.session(id);
  }

  /** For commands: the case's one engine, made with Engine.open (which recovers the case) on first use. */
  engine(id: string): Engine {
    const session = this.wb.session(id);
    const have = this.engines.get(id);
    if (have !== undefined && this.sessionOf.get(have) === session) return have;
    // the engine of a session closed since lets go of what its bound run held
    have?.close();
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

  create(input: NewCase, actor: Actor, opts: { loop?: string } = {}): CaseSession {
    return this.wb.createCase(input, actor, opts.loop === undefined ? {} : { loop: opts.loop });
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
      this.settled(id);
    }));
  }

  /**
   * A drive of `child` has settled: when it is a child whose parent is loaded, the parent's engine is told, in the parent's queue, as background
   * work (Engine.childSettled lifts only a pause that waits on this child, and passes no gate). A parent that is not loaded is left alone: it
   * looks again when it is loaded and resumed.
   */
  private settled(child: string): void {
    let parent: string | null;
    try {
      parent = this.wb.session(child).state.loop.parent?.case ?? null;
      if (parent !== null) this.wb.session(parent);
    } catch (error) {
      if (gone(error)) return;
      throw error;
    }
    if (parent === null) return;
    const id = parent;
    this.background(this.serial(id, () => {
      // the commit is made in the queue; the drive it starts goes on after it, as a command's does
      let engine: Engine;
      try {
        engine = this.engine(id);
      } catch (error) {
        if (gone(error)) return; // unloaded since
        throw error;
      }
      this.follow(id, engine.childSettled(child));
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
        if (have !== undefined && this.sessionOf.get(have)?.open !== true) {
          have.close();
          this.engines.delete(id);
        }
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
