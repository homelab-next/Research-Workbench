import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BlobStore } from "./blobs";
import { ignoreThrow, logToStderr } from "./deliver";
import { Ledger } from "./ledger";
import { CaseSession } from "./session";
import type { RunState } from "./state";
import { isMarking } from "./types";
import type { Actor, Entry, Marking, Observable, TimeWindow } from "./types";

export class CaseNotFoundError extends Error {
  constructor(id: string) {
    super(`case ${id} not found`);
    this.name = "CaseNotFoundError";
  }
}

export class WorkbenchLockedError extends Error {
  /** The holder's pid, when it could be read; null otherwise. For the message only. */
  readonly pid: number | null;
  constructor(dataDir: string, pid: number | null) {
    super(`data directory ${dataDir} is in use by ${pid === null ? "another process" : `process ${pid}`}`);
    this.name = "WorkbenchLockedError";
    this.pid = pid;
  }
}

export interface NewCase { title: string; asked: string; why: string; starting: Observable[]; window: TimeWindow; objective: string | null; marking: Marking }
export interface CaseSummary { id: string; title: string; marking: Marking; created_ts: string; run_status: RunState["status"]; phase: string | null; incoming: number; kept: number }
export type ErrorHandler = (error: unknown, entry?: Entry) => void;

/** At most 9 digits, so the number is always an exact integer. */
const CASE_ID = /^CASE-[1-9][0-9]{0,8}$/;

/** The lock: a SQLite database the holding process keeps exclusively locked. */
const LOCK_FILE = "workbench.lock.sqlite";
const holderText = (pid: number): string => `[workbench lock holder pid=${pid}]`;
/** How long an opener keeps trying when the lock is busy, and the base of its random back-off. */
const LOCK_RETRY_MS = 100;
const LOCK_BACKOFF_MS = 5;
const HOLDER = /\[workbench lock holder pid=([1-9][0-9]{0,9})\]/g;

/**
 * One writer process per data directory. The operating system holds the lock: `<dataDir>/workbench.lock.sqlite`
 * is opened with locking_mode = EXCLUSIVE and a zero busy timeout, and a write takes the exclusive lock,
 * which SQLite then keeps until the connection closes. A second opener, in this process or another,
 * cannot even read the file and gets WorkbenchLockedError (after a short, bounded retry that only
 * resolves openers racing each other). The lock goes when the holder closes it or dies for any reason,
 * so there is no stale state and nothing to take over.
 */
function acquireLock(dataDir: string): Database {
  const path = join(dataDir, LOCK_FILE);
  const deadline = Date.now() + LOCK_RETRY_MS;
  for (;;) {
    const db = new Database(path, { create: true });
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      // So an earlier holder's pid never lingers in the file's free space.
      db.exec("PRAGMA secure_delete = ON");
      db.exec("BEGIN EXCLUSIVE");
      db.exec("CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY CHECK (id = 1), pid TEXT NOT NULL)");
      db.query("INSERT OR REPLACE INTO holder (id, pid) VALUES (1, ?)").run(holderText(process.pid));
      db.exec("COMMIT");
      return db;
    } catch (err) {
      db.close();
      if ((err as { code?: unknown }).code !== "SQLITE_BUSY") throw err;
      if (Date.now() >= deadline) throw new WorkbenchLockedError(dataDir, holderPid(path));
      // Busy can also mean another opener is half way up the same lock ladder (each holds SHARED while
      // asking for EXCLUSIVE, so with no wait both are refused). Back off for a random moment, having
      // released everything, and try again: one of them gets through. A real holder never lets go.
      Bun.sleepSync(LOCK_BACKOFF_MS + Math.random() * LOCK_BACKOFF_MS * 3);
    }
  }
}

/**
 * The pid the holder wrote, for the error message only; it plays no part in deciding who holds the lock.
 * The holder keeps SQLite out, so this reads the file's bytes (the operating system's lock is advisory).
 * A holder that has just taken the lock may not have written its pid yet, so the file can still name a
 * previous holder: a pid that is not a live process is not reported. Null when unknown.
 */
function holderPid(path: string): number | null {
  try {
    const found = new Set([...new TextDecoder("latin1").decode(readFileSync(path)).matchAll(HOLDER)].map((m) => Number(m[1])));
    const pid = found.size === 1 ? [...found][0]! : null;
    return pid !== null && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: unknown }).code === "EPERM";
  }
}

export class Workbench {
  readonly dataDir: string;
  readonly chain: Ledger;
  private readonly now: (() => string) | undefined;
  private readonly onError: ErrorHandler;
  private readonly lock: Database;
  private readonly sessions: Record<string, CaseSession> = Object.create(null) as Record<string, CaseSession>;

  private constructor(dataDir: string, chain: Ledger, now: (() => string) | undefined, onError: ErrorHandler, lock: Database) {
    this.dataDir = dataDir;
    this.chain = chain;
    this.now = now;
    this.onError = onError;
    this.lock = lock;
  }

  static open(dataDir: string, opts: { now?: () => string; onError?: ErrorHandler } = {}): Workbench {
    if (typeof dataDir !== "string" || dataDir === "") throw new TypeError("dataDir must be a non-empty string");
    const onError: ErrorHandler = opts.onError ?? logToStderr("workbench");
    mkdirSync(dataDir, { recursive: true });
    const lock = acquireLock(dataDir);
    try {
      mkdirSync(join(dataDir, "cases"), { recursive: true });
      mkdirSync(join(dataDir, "blobs"), { recursive: true });
      const chain = Ledger.open(join(dataDir, "workbench.sqlite"), "workbench", { ...(opts.now ? { now: opts.now } : {}), onError });
      return new Workbench(dataDir, chain, opts.now, onError, lock);
    } catch (err) {
      lock.close();
      throw err;
    }
  }

  createCase(input: NewCase, actor: Actor): CaseSession {
    if (!isMarking(input.marking)) throw new TypeError(`unknown marking ${JSON.stringify(input.marking)}`);
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
    attempt(() => this.lock.close());
    if (errors.length > 0) throw errors[0];
  }

  private reportError(error: unknown): void {
    ignoreThrow(() => this.onError(error));
  }

  private load(id: string, create: boolean): CaseSession {
    const dir = join(this.dataDir, "cases", id);
    if (create) mkdirSync(join(dir, "published"), { recursive: true });
    const ledger = Ledger.open(join(dir, "ledger.sqlite"), id, { ...(this.now ? { now: this.now } : {}), onError: this.onError });
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
