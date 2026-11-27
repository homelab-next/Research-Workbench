import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BlobStore } from "./blobs";
import { checkedListing, summaryProblem } from "./case-check";
import type { StoreChecks } from "./case-check";
import { canonical } from "./canonical";
import type { Json } from "./canonical";
import { CASE_ID, CaseFileError, caseFileName, MAX_CASE_NUMBER, checkCaseFile, DEFAULT_MAX_CASE_BYTES, extractCaseFile, readManifest, writeCaseFile } from "./casefile";
import type { CaseManifest, ManifestHeader } from "./casefile";
import { ignoreThrow, logToStderr } from "./deliver";
import { Ledger, ledgerSchemaProblem } from "./ledger";
import { Refused } from "./refused";
import { CaseSession } from "./session";
import { caseFields, fold, isCaseCreated } from "./state";
import type { CaseState, RunState } from "./state";
import { CaseStoreFolder } from "./store";
import type { StoreListing } from "./store";
import { isMarking } from "./types";
import type { Actor, Entry, Marking, Observable, TimeWindow } from "./types";
import { formatReport, verifyCase } from "./verify";

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

/** The workbench was used after close(). */
export class WorkbenchClosedError extends Error {
  constructor() {
    super("the workbench is closed");
    this.name = "WorkbenchClosedError";
  }
}

/** A case the workbench will not unload or load as asked. Nothing was written. */
export class CaseRefused extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "CaseRefused";
  }
}

export interface NewCase { title: string; asked: string; why: string; starting: Observable[]; window: TimeWindow; objective: string | null; marking: Marking }
export interface CaseSummary { id: string; title: string; marking: Marking; created_ts: string; run_status: RunState["status"]; phase: string | null; incoming: number; kept: number;
  /** Jobs with status running: a job left so by a stopped process (a playbook started from the Pivot panel, say) has no run to say so. */
  jobs_running: number;
  /** archive.failed's reason; "an unload did not finish" while archive.pending is set; null otherwise. */
  unload_failed: string | null }
export type ErrorHandler = (error: unknown, entry?: Entry) => void;

export type UnloadResult = { ok: true; file: string; path: string; head: { seq: number; hash: string } } | { ok: false; reason: string };
/** The steps of an unload, in order. Up to and including "leave" a failure leaves the case loaded; "leave" is the commit point. */
export type UnloadStep = "close" | "write" | "check" | "store" | "mark" | "leave" | "remove";
export interface WorkbenchOptions {
  now?: () => string;
  onError?: ErrorHandler;
  /** The case store; join(dataDir, "store") when not given. */
  store?: string;
  /** The size cap of a case file (cases.max_bytes). */
  max_case_bytes?: number;
  /** For tests: called before each step of an unload with the temporary file's path; a throw is that step failing. */
  beforeUnloadStep?: (step: UnloadStep, part: string) => void;
}

/** The highest case number this data folder has given out or taken in, kept so an id is never given twice. */
const MARK_FILE = ".high-water";
const MARK = /^(0|[1-9][0-9]{0,8})$/;
/** What a stopped load or unload, or a stopped write of the mark, leaves in cases/. */
const LEFTOVER = /^\.(loading-|unloading-|high-water\.)/;
const RECOVERY: Actor = { kind: "system", id: "recovery" };
const STOPPED = "the workbench stopped before the case was unloaded";
const UNFINISHED = "an unload did not finish";

const numberOf = (id: string): number => Number(id.slice(5));
const firstLine = (err: unknown): string => (err instanceof Refused ? err.reasons[0]! : err instanceof Error ? err.message : String(err)).split("\n")[0]!;

/** Flushes a folder's entries (a rename in it) to disk; a file system that refuses fsync on a folder is let be. */
function syncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // some file systems refuse fsync on a directory
  } finally {
    closeSync(fd);
  }
}

/** `read` of the SQLite file at `path`, opened read-only. */
function readOnly<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Where a path really is: the real path of its deepest folder that exists, with the rest of it after. */
function realOf(path: string): string {
  const rest: string[] = [];
  for (let at = resolve(path); ; ) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return resolve(path);
      rest.push(basename(at));
      at = up;
    }
  }
}

/** True when `path` is `folder` or inside it. */
function within(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** The hash of entry `seq` of the ledger at `path`, read without writing; null when there is none or it cannot be read. */
function hashAt(path: string, seq: number): string | null {
  try {
    const db = new Database(path, { readonly: true });
    try {
      return (db.query("SELECT hash FROM entries WHERE seq = ?").get(seq) as { hash: string } | null)?.hash ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Why an unload may not put its file at `dest`, which may already hold a file; null when it may. Only a file of the same case (the same
 * origin) whose record is an earlier part of this one (its head is an entry of this ledger) is replaced: anything else is another case's,
 * or a later or diverging copy of this one, and may be the only copy there is.
 */
async function replaceProblem(dest: string, store: CaseStoreFolder, id: string, origin: string, ledger: string): Promise<string | null> {
  const file = basename(dest);
  const holds = `the folder ${store.name} already holds ${file}`;
  try {
    if (!lstatSync(dest).isFile()) return `${holds}, which is not a case file; it is not replaced`;
  } catch (err) {
    // nothing there, or no folder for it to be in (the write then says why)
    const code = (err as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return `${holds}, which cannot be read (${firstLine(err)}); it is not replaced`;
  }
  let m: CaseManifest;
  try {
    m = await readManifest(dest);
  } catch (err) {
    return `${holds}, which cannot be read as a case file (${firstLine(err)}); it is not replaced`;
  }
  if (m.origin !== origin) return `${holds}, which is another case with the id ${id}; it is not replaced`;
  if (hashAt(ledger, m.head.seq) !== m.head.hash) return `${holds}, whose record of ${id} is not an earlier part of this one; it is not replaced`;
  return null;
}

/** Puts `part` at `dest`. When `dest` was free, a link is made, so a file put there meanwhile is never replaced; when it held an earlier copy, a rename replaces it. */
function putInPlace(part: string, dest: string, replacing: boolean): void {
  if (!replacing) {
    try {
      linkSync(part, dest);
      rmSync(part, { force: true });
      return;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === "EEXIST") throw new CaseRefused(`${basename(dest)} was put in the folder while the case was packed; it is not replaced`);
      // a file system with no hard links: the rename below
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EXDEV" && code !== "ENOSYS") throw err;
    }
  }
  renameSync(part, dest);
}

/** Why the case may not be unloaded now; null when it may. Pure. */
export function unloadProblem(state: Readonly<CaseState>): string | null {
  if (state.run.status === "running") return "a run is running; pause or stop it first";
  const jobs = Object.values(state.jobs).filter((j) => j.status === "running").length;
  if (jobs > 0) return `${jobs} job(s) still running`;
  if (Object.values(state.queries).some((q) => q.status === "running")) return "a query is still running";
  if (state.conversation.some((t) => t.answer === null && t.ended === null)) return "your agent is still answering";
  if (state.meta === null) return "the case has no case.created entry";
  return null;
}

/** The lock: a SQLite database the holding process keeps exclusively locked. */
const LOCK_FILE = "workbench.lock.sqlite";
const holderText = (pid: number): string => `[workbench lock holder pid=${pid}]`;
/** How long an opener keeps trying when the lock is busy, and the base of its random back-off. */
const LOCK_RETRY_MS = 100;
const LOCK_BACKOFF_MS = 5;
const HOLDER = /\[workbench lock holder pid=([1-9][0-9]{0,9})\]/g;

/**
 * The lock files this process holds. Closing any file handle a process has on a file drops every POSIX
 * lock the process holds on it, SQLite's included, so the holder must never open or read its own lock
 * file again: a second open in the holding process is refused from this set, without touching the file.
 */
const heldLocks = new Set<string>();

/** The lock file's path by where the data directory really is, so a symlink to a held directory names the same lock. The directory must exist. */
function lockKeyOf(dataDir: string): string {
  return join(realpathSync(dataDir), LOCK_FILE);
}

/**
 * One writer process per data directory. The operating system holds the lock: `<dataDir>/workbench.lock.sqlite`
 * is opened with locking_mode = EXCLUSIVE and a zero busy timeout, and a write takes the exclusive lock,
 * which SQLite then keeps until the connection closes. A second opener, in this process or another,
 * cannot even read the file and gets WorkbenchLockedError (after a short, bounded retry that only
 * resolves openers racing each other). The lock goes when the holder closes it or dies for any reason,
 * so there is no stale state and nothing to take over.
 */
function acquireLock(dataDir: string, path: string): Database {
  if (heldLocks.has(path)) throw new WorkbenchLockedError(dataDir, process.pid);
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
      heldLocks.add(path);
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
  /** The blob store for the workbench chain, `<dataDir>/blobs`. */
  readonly chainBlobs: BlobStore;
  /** The case store unloads go to and loads come from by default. */
  readonly store: CaseStoreFolder;
  private readonly now: (() => string) | undefined;
  private readonly onError: ErrorHandler;
  private readonly maxCaseBytes: number;
  private readonly beforeUnloadStep: ((step: UnloadStep, part: string) => void) | undefined;
  private readonly lock: Database;
  /** The key of this workbench's lock in heldLocks, fixed at open so a later chdir cannot change it. */
  private readonly lockKey: string;
  private closed = false;
  private readonly sessions: Record<string, CaseSession> = Object.create(null) as Record<string, CaseSession>;
  /** The cases an unload is packing, with their state as of case.unloaded. */
  private readonly unloading = new Map<string, { state: Readonly<CaseState>; created_ts: string }>();
  /** What checkedStore learned of each store file, so a file that has not changed is not read again. */
  private readonly storeChecks: StoreChecks = new Map();

  private constructor(dataDir: string, chain: Ledger, opts: WorkbenchOptions, onError: ErrorHandler, lock: Database, lockKey: string) {
    this.dataDir = dataDir;
    this.chain = chain;
    this.chainBlobs = new BlobStore(join(dataDir, "blobs"));
    this.store = new CaseStoreFolder(opts.store ?? join(dataDir, "store"));
    this.now = opts.now;
    this.onError = onError;
    this.maxCaseBytes = opts.max_case_bytes ?? DEFAULT_MAX_CASE_BYTES;
    this.beforeUnloadStep = opts.beforeUnloadStep;
    this.lock = lock;
    this.lockKey = lockKey;
  }

  /** Opens the data folder, taking its lock, and removes what a stopped load or unload left in cases/ (each is reported through onError). */
  static open(dataDir: string, opts: WorkbenchOptions = {}): Workbench {
    if (typeof dataDir !== "string" || dataDir === "") throw new TypeError("dataDir must be a non-empty string");
    if (opts.store !== undefined && (typeof opts.store !== "string" || opts.store === "")) throw new TypeError("store must be a non-empty string");
    if (opts.max_case_bytes !== undefined && !(Number.isSafeInteger(opts.max_case_bytes) && opts.max_case_bytes >= 1)) throw new TypeError("max_case_bytes must be a positive integer");
    const onError: ErrorHandler = opts.onError ?? logToStderr("workbench");
    mkdirSync(dataDir, { recursive: true });
    const held = lockKeyOf(dataDir);
    const lock = acquireLock(dataDir, held);
    try {
      mkdirSync(join(dataDir, "cases"), { recursive: true });
      mkdirSync(join(dataDir, "blobs"), { recursive: true });
      sweep(join(dataDir, "cases"), onError);
      const chain = Ledger.open(join(dataDir, "workbench.sqlite"), "workbench", { ...(opts.now ? { now: opts.now } : {}), onError });
      return new Workbench(dataDir, chain, opts, onError, lock, held);
    } catch (err) {
      try {
        lock.close();
      } finally {
        heldLocks.delete(held);
      }
      throw err;
    }
  }

  createCase(input: NewCase, actor: Actor): CaseSession {
    this.open();
    if (!isMarking(input?.marking)) throw new TypeError(`unknown marking ${JSON.stringify(input?.marking)}`);
    const n = this.nextNumber();
    const id = `CASE-${n}`;
    // The seven case fields and nothing else, with the id last so nothing in the input can replace it.
    const { title, asked, why, starting, window, objective, marking } = input;
    const payload = caseFields({ title, asked, why, starting, window, objective, marking, id });
    // Refuse what the fold would refuse, before anything is written.
    if (!isCaseCreated(payload)) throw new TypeError("a new case needs title, asked and why strings, starting observables, a time window and an objective string or null");
    // The mark first: once a folder can exist, its number can never be given out again.
    this.raiseMark(n);
    let session: CaseSession;
    try {
      session = this.openSession(id, true);
    } catch (err) {
      rmSync(join(this.dataDir, "cases", id), { recursive: true, force: true });
      throw err;
    }
    try {
      session.commit(() => [{ type: "case.created", payload, actor }]);
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
    this.open();
    if (typeof id !== "string" || !CASE_ID.test(id)) throw new CaseNotFoundError(String(id));
    if (Object.hasOwn(this.sessions, id)) return this.sessions[id]!;
    if (this.unloading.has(id)) throw new CaseRefused(`${id} is being unloaded`);
    if (!existsSync(join(this.dataDir, "cases", id, "ledger.sqlite"))) throw new CaseNotFoundError(id);
    return this.openSession(id, false);
  }

  /** A summary of every case, newest first. Reads each ledger and lets it go: no session is opened or kept for it. */
  listCases(): CaseSummary[] {
    this.open();
    const out: CaseSummary[] = [];
    for (const n of this.caseNumbers().sort((a, b) => b - a)) {
      const id = `CASE-${n}`;
      if (!existsSync(join(this.dataDir, "cases", id, "ledger.sqlite"))) continue;
      try {
        const { state: s, created_ts } = this.summaryOf(id);
        if (s.meta === null) continue;
        out.push({
          id,
          title: s.meta.title,
          marking: s.meta.marking,
          created_ts,
          run_status: s.run.status,
          phase: s.phase,
          incoming: s.incoming.length,
          kept: s.lanes.reduce((count, l) => count + l.cards.length, 0),
          jobs_running: Object.values(s.jobs).filter((j) => j.status === "running").length,
          unload_failed: s.archive.pending !== null ? UNFINISHED : s.archive.failed?.reason ?? null,
        });
      } catch (err) {
        this.reportError(new Error(`case ${id} could not be loaded: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
      }
    }
    return out;
  }

  /** Closes every session and the chain even if some fail, releases the lock, then rethrows the first error. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
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
      try {
        this.lock.close();
      } finally {
        heldLocks.delete(this.lockKey);
      }
    });
    if (errors.length > 0) throw errors[0];
  }

  private open(): void {
    if (this.closed) throw new WorkbenchClosedError();
  }

  /** The state of a case: from its open session if there is one, else read from its ledger, which is closed again. */
  private summaryOf(id: string): { state: Readonly<CaseState>; created_ts: string } {
    if (Object.hasOwn(this.sessions, id)) {
      const session = this.sessions[id]!;
      return { state: session.state, created_ts: session.entries(0, 1)[0]?.ts ?? "" };
    }
    const packing = this.unloading.get(id);
    if (packing !== undefined) return packing;
    const ledger = Ledger.open(join(this.dataDir, "cases", id, "ledger.sqlite"), id, { onError: this.onError });
    try {
      const entries = ledger.read();
      return { state: fold(entries), created_ts: entries[0]?.ts ?? "" };
    } finally {
      ledger.close();
    }
  }

  private reportError(error: unknown): void {
    ignoreThrow(() => this.onError(error));
  }

  /**
   * Opens a case's session and keeps it. A case whose ledger ends in an unload that never finished (archive.pending set, yet the folder is
   * here) is loaded: unless `recover` is false, that is recorded as case.unload_failed by the recovery actor.
   */
  private openSession(id: string, create: boolean, recover = true): CaseSession {
    const dir = join(this.dataDir, "cases", id);
    if (create) mkdirSync(join(dir, "published"), { recursive: true });
    const ledger = Ledger.open(join(dir, "ledger.sqlite"), id, { ...(this.now ? { now: this.now } : {}), onError: this.onError });
    try {
      const session: CaseSession = new CaseSession({
        id, dir, ledger, blobs: new BlobStore(join(dir, "blobs")), onError: this.onError,
        // a session closed directly leaves the cache, so the next session(id) opens a fresh one
        onClose: () => {
          if (this.sessions[id] === session) delete this.sessions[id];
        },
      });
      this.sessions[id] = session;
      if (!create && recover && session.state.archive.pending !== null) {
        try {
          session.commit(() => [{ type: "case.unload_failed", payload: { reason: STOPPED }, actor: RECOVERY }]);
        } catch (err) {
          this.reportError(new Error(`case ${id}: the unfinished unload could not be recorded: ${firstLine(err)}`, { cause: err }));
        }
      }
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

  /**
   * 1 + the highest number among the folders in cases/, the store's file names and deleted.log, and the mark. A store that cannot be read, and a
   * name in it that is not an id, are reported and left out. Throws CaseRefused, rather than give out a number over nine digits.
   */
  private nextNumber(): number {
    const seen = this.store.seenNumbers((err) => this.reportError(err instanceof CaseFileError ? err
      : new Error(`the case store ${this.store.dir} could not be read, so its ids were not counted: ${firstLine(err)}`, { cause: err })));
    const n = Math.max(0, ...this.caseNumbers(), ...seen, this.readMark()) + 1;
    if (n > MAX_CASE_NUMBER) throw new CaseRefused(`every case id up to CASE-${MAX_CASE_NUMBER} has been given out here; no new case can be made`);
    return n;
  }

  /** The number in cases/.high-water; 0 when there is none or it is not a number. */
  private readMark(): number {
    let text: string;
    try {
      text = readFileSync(join(this.dataDir, "cases", MARK_FILE), "utf8").trim();
    } catch {
      return 0;
    }
    return MARK.test(text) ? Number(text) : 0;
  }

  /** Raises the mark to `n` (never lowers it): a temporary file, fsync, rename, fsync of cases/. Throws when it cannot be written. */
  private raiseMark(n: number): void {
    if (n <= this.readMark()) return;
    const dir = join(this.dataDir, "cases");
    const tmp = join(dir, `${MARK_FILE}.${randomUUID()}.tmp`);
    try {
      const fd = openSync(tmp, "wx");
      try {
        const bytes = new TextEncoder().encode(`${n}\n`);
        for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, join(dir, MARK_FILE));
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    syncDir(dir);
  }

  /** The hash of entry 1 of a loaded case; null when it cannot be read. */
  private originOf(id: string): string | null {
    if (Object.hasOwn(this.sessions, id)) return this.sessions[id]!.entries(0, 1)[0]?.hash ?? null;
    try {
      const db = new Database(join(this.dataDir, "cases", id, "ledger.sqlite"), { readonly: true });
      try {
        return (db.query("SELECT hash FROM entries WHERE seq = 1").get() as { hash: string } | null)?.hash ?? null;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  }

  /** The store's listing with each file checked against its own ledger: a case.json that says other than its ledger is listed as unreadable. */
  async checkedStore(search?: string): Promise<StoreListing> {
    this.open();
    return checkedListing(this.store, search, { max_bytes: this.maxCaseBytes, checks: this.storeChecks });
  }

  /** A path or an error message with this workbench's folders named rather than spelled out, for the ledger. */
  private withoutPaths(text: string, store: CaseStoreFolder): string {
    return text.split(store.dir).join(`the folder ${store.name}`).split(resolve(this.dataDir)).join("the data folder");
  }

  /**
   * Packs a loaded case into the store (or into `to`) and takes it out of the working set. Throws CaseRefused, having written nothing, when the case
   * may not be unloaded now. Once case.unloaded is written it does not throw: a failure leaves the case loaded, records case.unload_failed and
   * returns { ok: false }.
   *
   * The order: (1) commit case.unloaded; (2) close the session; (3) write `<store>/.tmp-<id>-<pid>-<uuid>.part` and fsync it; (4) read it back
   * with checkCaseFile and compare its manifest with the one written; (5) rename it to its name and fsync the store; (6) raise the mark; (7) rename
   * the case folder to `cases/.unloading-<id>-<uuid>` and fsync cases/ (the commit point); (8) remove that folder.
   */
  async unloadCase(id: string, opts: { actor: Actor; to?: string }): Promise<UnloadResult> {
    this.open();
    if (opts.to !== undefined && (typeof opts.to !== "string" || opts.to === "")) throw new CaseRefused("to must name a folder");
    const store = opts.to === undefined ? this.store : new CaseStoreFolder(opts.to);
    const session = this.session(id);
    // the file would be inside what step 7 takes away, or beside the cases themselves
    if (within(realOf(store.dir), realOf(join(this.dataDir, "cases")))) throw new CaseRefused("a case file may not be written inside the data folder's cases folder; choose a folder outside it");
    const meta = session.state.meta;
    // a file already there is replaced only when it is an earlier copy of this case; nothing is written otherwise
    const origin = session.entries(0, 1)[0]?.hash;
    if (meta !== null && origin !== undefined) {
      const problem = await replaceProblem(join(store.dir, caseFileName(id, meta.marking)), store, id, origin, join(session.dir, "ledger.sqlite"));
      this.open();
      if (problem !== null) throw new CaseRefused(problem);
    }
    const [entry] = session.commit((state) => {
      const problem = unloadProblem(state);
      if (problem !== null) throw new CaseRefused(problem);
      return [{ type: "case.unloaded", payload: { store: store.name, head: session.head() }, actor: opts.actor }];
    });
    if (entry === undefined || meta === null) throw new Error("case.unloaded was not written");
    const state = session.state;
    // While its folder is packed, the case is not opened again and its ledger is not read through Ledger.
    const first = session.entries(0, 1)[0]!;
    this.unloading.set(id, { state, created_ts: first.ts });
    const header: ManifestHeader = {
      id, chain: id, origin: first.hash,
      title: meta.title, asked: meta.asked, marking: meta.marking, starting: meta.starting,
      status: state.run.status, outcome: state.run.outcome, published: state.published.map((p) => ({ n: p.n, draft_hash: p.draft_hash })),
      head: { seq: entry.seq, hash: entry.hash }, entries: entry.seq, unloaded_ts: entry.ts,
    };
    const file = caseFileName(id, meta.marking);
    const dest = join(store.dir, file);
    const part = join(store.dir, `.tmp-${id}-${process.pid}-${randomUUID()}.part`);
    const cases = join(this.dataDir, "cases");
    const away = join(cases, `.unloading-${id}-${randomUUID()}`);
    const step = (name: UnloadStep): void => this.beforeUnloadStep?.(name, part);
    let doing = "the case could not be closed";
    try {
      step("close");
      session.close();
      doing = "the case file could not be written";
      step("write");
      mkdirSync(store.dir, { recursive: true });
      const written = await writeCaseFile(session.dir, part, header);
      doing = "the case file did not read back as written";
      step("check");
      const back: CaseManifest = await checkCaseFile(part, { max_bytes: this.maxCaseBytes });
      if (canonical(back as unknown as Json) !== canonical(written as unknown as Json)) throw new CaseFileError("its case.json is not the one written");
      doing = "the case file could not be put in the store";
      step("store");
      // looked at again: another workbench sharing the folder may have put a file there since
      const there = existsSync(dest);
      const problem = await replaceProblem(dest, store, id, first.hash, join(session.dir, "ledger.sqlite"));
      if (problem !== null) throw new CaseRefused(problem);
      putInPlace(part, dest, there);
      syncDir(store.dir);
      doing = "the id mark could not be written";
      step("mark");
      this.raiseMark(numberOf(id));
      doing = "the case could not be taken out of the working set";
      step("leave");
      if (this.closed) throw new WorkbenchClosedError();
      renameSync(session.dir, away);
      syncDir(cases);
    } catch (err) {
      try {
        rmSync(part, { force: true });
      } catch {
        // its folder is not there to hold it
      }
      this.unloading.delete(id);
      const reason = this.withoutPaths(`${doing}: ${firstLine(err)}`, store);
      this.recordFailedUnload(id, session, reason, opts.actor);
      return { ok: false, reason };
    }
    this.unloading.delete(id);
    try {
      step("remove");
      rmSync(away, { recursive: true, force: true });
    } catch (err) {
      this.reportError(new Error(`case ${id} was unloaded, but ${away} could not be removed (it goes when the workbench next opens): ${firstLine(err)}`, { cause: err }));
    }
    return { ok: true, file, path: dest, head: header.head };
  }

  /** The failure path of an unload: the case is still in the working set; its session is opened again (if closed) and the failure recorded. */
  private recordFailedUnload(id: string, session: CaseSession, reason: string, actor: Actor): void {
    try {
      this.open();
      const s = session.open ? session : this.openSession(id, false, false);
      s.commit(() => [{ type: "case.unload_failed", payload: { reason }, actor }]);
    } catch (err) {
      // the next open of the case records it (archive.pending is still set)
      this.reportError(new Error(`case ${id}: the failed unload could not be recorded: ${firstLine(err)}`, { cause: err }));
    }
  }

  /** Why `m`'s id cannot be used here: the same case already loaded, or another case holding the id in the working set. Null when it is free there. */
  private idTakenInWorkingSet(m: CaseManifest): string | null {
    if (!existsSync(join(this.dataDir, "cases", m.id))) return null;
    return this.originOf(m.id) === m.origin ? `${m.id} is already loaded` : `${m.id} is taken here by another case; this file cannot be loaded`;
  }

  /**
   * Loads a case file (a path). Throws CaseFileError or CaseRefused; then nothing is in the working set that was not there before. A case keeps
   * one id: a file whose id is held here by another case (another first entry), in the working set or by another file in the store, is refused.
   */
  async loadCase(file: string, opts: { actor: Actor }): Promise<{ id: string; session: CaseSession }> {
    this.open();
    if (typeof file !== "string" || file === "") throw new TypeError("file must be a non-empty string");
    // 1. the whole archive against its case.json; nothing is written
    const m = await checkCaseFile(file, { max_bytes: this.maxCaseBytes });
    this.open();
    const id = m.id;
    if (!CASE_ID.test(id)) throw new CaseRefused(`${id} is not a case id this workbench can hold`);
    if (m.chain !== id) throw new CaseFileError(`case.json names the case ${id} and the chain ${m.chain}; a case keeps one id`);
    // 2. the id
    const taken = this.idTakenInWorkingSet(m);
    if (taken !== null) throw new CaseRefused(taken);
    let listed: Awaited<ReturnType<CaseStoreFolder["list"]>>["cases"] = [];
    try {
      listed = (await this.store.list()).cases;
    } catch (err) {
      this.reportError(new Error(`the case store ${this.store.dir} could not be read, so its ids were not checked: ${firstLine(err)}`, { cause: err }));
    }
    const self = realpathSync(file);
    for (const c of listed) {
      if (c.manifest.id !== id || c.manifest.origin === m.origin) continue;
      let same = false;
      try {
        same = realpathSync(this.store.path(c.file)) === self;
      } catch {
        // gone since it was listed
      }
      if (!same) throw new CaseRefused(`${id} is taken here by another case, in the store's ${c.file}; this file cannot be loaded`);
    }
    // 3. extract to a folder of its own, which is not a case
    this.open();
    const cases = join(this.dataDir, "cases");
    const tmp = join(cases, `.loading-${randomUUID()}`);
    try {
      await extractCaseFile(file, tmp, { max_bytes: this.maxCaseBytes });
      mkdirSync(join(tmp, "blobs"), { recursive: true });
      mkdirSync(join(tmp, "published"), { recursive: true });
      // 4. the ledger is exactly what Ledger.open makes, so nothing in it runs when case.loaded is written (a trigger, say)
      const schema = readOnly(join(tmp, "ledger.sqlite"), ledgerSchemaProblem);
      if (schema !== null) throw new CaseFileError(`the case's ledger is not one this workbench writes: ${schema}`);
      // the chain, its head, its id and its first entry are the ones case.json names
      let report: ReturnType<typeof verifyCase>;
      try {
        report = verifyCase(tmp);
      } catch (err) {
        throw new CaseFileError(`the case does not verify: ${firstLine(err)}`);
      }
      if (!report.ok) throw new CaseFileError(`the case does not verify: ${formatReport(report).split("\n")[0]!}`);
      if (report.head !== m.head.hash || report.entries !== m.entries) throw new CaseFileError("the case does not verify: its head is not the one case.json names");
      if (report.case !== m.chain) throw new CaseFileError(`the case does not verify: its ledger is case ${report.case}, not ${m.chain}`);
      if (hashAt(join(tmp, "ledger.sqlite"), 1) !== m.origin) throw new CaseFileError("the case does not verify: its first entry is not the one case.json names");
      // 5. the load, recorded in the case's own ledger
      const ledger = Ledger.open(join(tmp, "ledger.sqlite"), m.chain, { ...(this.now ? { now: this.now } : {}), onError: this.onError });
      let loaded: Entry;
      try {
        // case.json is what the store view and the file's name are drawn from: it says what the ledger says, or the file is refused
        const lie = summaryProblem(m, ledger.read());
        if (lie !== null) throw new CaseFileError(`${lie}; this file cannot be loaded`);
        loaded = ledger.append({ type: "case.loaded", payload: { file: basename(file), head: { seq: m.head.seq, hash: m.head.hash }, id }, actor: opts.actor });
      } finally {
        ledger.close();
      }
      // and the chain is still the one verified, with case.loaded after it
      const after = verifyCase(tmp);
      if (!after.ok || after.entries !== m.entries + 1 || after.head !== loaded.hash || hashAt(join(tmp, "ledger.sqlite"), m.head.seq) !== m.head.hash) {
        throw new CaseFileError("the case does not verify after its load was recorded");
      }
      // 6. the mark, then the commit point
      this.open();
      const again = this.idTakenInWorkingSet(m);
      if (again !== null) throw new CaseRefused(again);
      this.raiseMark(numberOf(id));
      renameSync(tmp, join(cases, id));
      syncDir(cases);
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    // 7.
    return { id, session: this.openSession(id, false) };
  }
}

/** Removes what a stopped load or unload left in cases/, reporting each. */
function sweep(cases: string, onError: ErrorHandler): void {
  for (const name of readdirSync(cases)) {
    if (!LEFTOVER.test(name)) continue;
    try {
      rmSync(join(cases, name), { recursive: true, force: true });
      if (!name.startsWith(`${MARK_FILE}.`)) ignoreThrow(() => onError(new Error(`removed ${name} from ${cases}: a load or an unload stopped before it finished`)));
    } catch (err) {
      ignoreThrow(() => onError(new Error(`${name} in ${cases} could not be removed: ${firstLine(err)}`, { cause: err })));
    }
  }
}
