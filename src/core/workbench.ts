import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BlobStore } from "./blobs";
import { ignoreThrow, logToStderr } from "./deliver";
import { Ledger } from "./ledger";
import { CaseSession } from "./session";
import type { RunState } from "./state";
import type { Actor, Entry, Marking, Observable, TimeWindow } from "./types";

export class CaseNotFoundError extends Error {
  constructor(id: string) {
    super(`case ${id} not found`);
    this.name = "CaseNotFoundError";
  }
}

export class WorkbenchLockedError extends Error {
  readonly pid: number;
  constructor(dataDir: string, pid: number) {
    super(`data directory ${dataDir} is in use by process ${pid}`);
    this.name = "WorkbenchLockedError";
    this.pid = pid;
  }
}

export interface NewCase { title: string; asked: string; why: string; starting: Observable[]; window: TimeWindow; objective: string | null; marking: Marking }
export interface CaseSummary { id: string; title: string; marking: Marking; created_ts: string; run_status: RunState["status"]; phase: string | null; incoming: number; kept: number }
export type ErrorHandler = (error: unknown, entry?: Entry) => void;

/** At most 9 digits, so the number is always an exact integer. */
const CASE_ID = /^CASE-[1-9][0-9]{0,8}$/;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One writer process per data directory: takes `<dataDir>/workbench.lock`, taking over one left by a dead process. */
function acquireLock(dataDir: string): string {
  const path = join(dataDir, "workbench.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let pid = NaN;
    try {
      pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    } catch {
      continue; // vanished since we looked; try again
    }
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) throw new WorkbenchLockedError(dataDir, pid);
    rmSync(path, { force: true }); // stale: owner is gone (or the file is unreadable junk)
  }
  throw new Error(`could not take the lock on ${dataDir}`);
}

export class Workbench {
  readonly dataDir: string;
  readonly chain: Ledger;
  private readonly now: (() => string) | undefined;
  private readonly onError: ErrorHandler;
  private readonly lockPath: string;
  private readonly sessions: Record<string, CaseSession> = Object.create(null) as Record<string, CaseSession>;

  private constructor(dataDir: string, chain: Ledger, now: (() => string) | undefined, onError: ErrorHandler, lockPath: string) {
    this.dataDir = dataDir;
    this.chain = chain;
    this.now = now;
    this.onError = onError;
    this.lockPath = lockPath;
  }

  static open(dataDir: string, opts: { now?: () => string; onError?: ErrorHandler } = {}): Workbench {
    if (typeof dataDir !== "string" || dataDir === "") throw new TypeError("dataDir must be a non-empty string");
    const onError: ErrorHandler = opts.onError ?? logToStderr("workbench");
    mkdirSync(dataDir, { recursive: true });
    const lockPath = acquireLock(dataDir);
    try {
      mkdirSync(join(dataDir, "cases"), { recursive: true });
      mkdirSync(join(dataDir, "blobs"), { recursive: true });
      const chain = Ledger.open(join(dataDir, "workbench.sqlite"), "workbench", opts.now ? { now: opts.now } : {});
      return new Workbench(dataDir, chain, opts.now, onError, lockPath);
    } catch (err) {
      rmSync(lockPath, { force: true });
      throw err;
    }
  }

  createCase(input: NewCase, actor: Actor): CaseSession {
    const id = `CASE-${this.nextNumber()}`;
    let session: CaseSession;
    try {
      session = this.load(id, true);
    } catch (err) {
      rmSync(join(this.dataDir, "cases", id), { recursive: true, force: true });
      throw err;
    }
    try {
      session.commit(() => [{ type: "case.created", payload: { id, ...input }, actor }]);
    } catch (err) {
      delete this.sessions[id];
      try {
        session.close();
      } finally {
        rmSync(session.dir, { recursive: true, force: true });
      }
      throw err;
    }
    return session;
  }

  session(id: string): CaseSession {
    if (typeof id !== "string" || !CASE_ID.test(id)) throw new CaseNotFoundError(String(id));
    if (Object.hasOwn(this.sessions, id)) return this.sessions[id]!;
    if (!existsSync(join(this.dataDir, "cases", id, "ledger.sqlite"))) throw new CaseNotFoundError(id);
    return this.load(id, false);
  }

  listCases(): CaseSummary[] {
    const out: CaseSummary[] = [];
    for (const n of this.caseNumbers().sort((a, b) => b - a)) {
      const id = `CASE-${n}`;
      if (!existsSync(join(this.dataDir, "cases", id, "ledger.sqlite"))) continue;
      try {
        const session = this.session(id);
        const s = session.state;
        if (s.meta === null) continue;
        out.push({
          id,
          title: s.meta.title,
          marking: s.meta.marking,
          created_ts: session.entries(0, 1)[0]?.ts ?? "",
          run_status: s.run.status,
          phase: s.phase,
          incoming: s.incoming.length,
          kept: s.lanes.reduce((count, l) => count + l.cards.length, 0),
        });
      } catch (err) {
        this.reportError(new Error(`case ${id} could not be loaded: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
      }
    }
    return out;
  }

  /** Closes every session and the chain even if some fail, releases the lock, then rethrows the first error. */
  close(): void {
    const errors: unknown[] = [];
    const attempt = (fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        errors.push(err);
      }
    };
    for (const id of Object.keys(this.sessions)) {
      const s = this.sessions[id]!;
      delete this.sessions[id];
      attempt(() => s.close());
    }
    attempt(() => this.chain.close());
    attempt(() => {
      if (existsSync(this.lockPath) && readFileSync(this.lockPath, "utf8").trim() === String(process.pid)) rmSync(this.lockPath, { force: true });
    });
    if (errors.length > 0) throw errors[0];
  }

  private reportError(error: unknown): void {
    ignoreThrow(() => this.onError(error));
  }

  private load(id: string, create: boolean): CaseSession {
    const dir = join(this.dataDir, "cases", id);
    if (create) mkdirSync(join(dir, "published"), { recursive: true });
    const ledger = Ledger.open(join(dir, "ledger.sqlite"), id, this.now ? { now: this.now } : {});
    try {
      const session = new CaseSession({ id, dir, ledger, blobs: new BlobStore(join(dir, "blobs")), onError: this.onError });
      this.sessions[id] = session;
      return session;
    } catch (err) {
      ledger.close();
      throw err;
    }
  }

  private caseNumbers(): number[] {
    const dir = join(this.dataDir, "cases");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => CASE_ID.test(n)).map((n) => Number(n.slice(5)));
  }

  private nextNumber(): number {
    return Math.max(0, ...this.caseNumbers()) + 1;
  }
}
