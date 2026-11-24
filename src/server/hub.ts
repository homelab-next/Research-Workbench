import type { CaseSession } from "../core/session";
import type { Actor } from "../core/types";
import type { NewCase, Workbench } from "../core/workbench";
import { Engine } from "../pipeline/engine";
import type { EngineDeps } from "../pipeline/engine";

/** The one place that holds a case's session and engine for the server, so a case has one engine and background work has one account. */
export class CaseHub {
  private readonly engines = new Map<string, Engine>();
  /** The session each engine was made for: a session closed and opened again is a new one and needs a new engine. */
  private readonly sessionOf = new WeakMap<Engine, CaseSession>();
  private readonly flying = new Set<Promise<unknown>>();

  constructor(private readonly wb: Workbench, private readonly deps: EngineDeps, private readonly onError: (error: unknown) => void) {}

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
    this.background(started);
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
