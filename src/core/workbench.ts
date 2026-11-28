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
import { foldLessons } from "./lessons";
import { checkMemoryFile, extractMemoryFile, MemoryFileError, memoryFileName, writeMemoryFile } from "./memfile";
import type { MemoryFileManifest } from "./memfile";
import { MemoryRefused, MemoryStore } from "./memstore";
import { Refused } from "./refused";
import { CaseSession } from "./session";
import { builderMarking, builderOpen, CASE_TYPE_ID, caseFields, fold, isCard, isCaseCreated, unloadDue } from "./state";
import type { CaseState, RunState } from "./state";
import { CaseStoreFolder } from "./store";
import type { StoreListing } from "./store";
import { isMarking, strictest } from "./types";
import type { Actor, Card, Entry, EntryInput, Marking, Observable, TimeWindow } from "./types";
import { formatReport, verifyCase, verifyMemory } from "./verify";

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

/** A builder session, as the Loops page lists it: what it is about, its marking now, and what waits for the person. */
export interface BuilderSummary { id: string; title: string; loop: string | null; marking: Marking; created_ts: string; open_changes: number; open_probes: number; turns: number }
export interface NewCase { title: string; asked: string; why: string; starting: Observable[]; window: TimeWindow; objective: string | null; marking: Marking }
export interface CaseSummary { id: string; title: string; marking: Marking; created_ts: string; run_status: RunState["status"]; phase: string | null; incoming: number; kept: number;
  /** Jobs with status running: a job left so by a stopped process (a playbook started from the Pivot panel, say) has no run to say so. */
  jobs_running: number;
  /** archive.failed's reason; "an unload did not finish" while archive.pending is set; null otherwise. */
  unload_failed: string | null;
  /** The loop the case is for (state.loop.id); null when its ledger names none, which is read as the default loop. */
  loop: string | null;
  /** The case whose run made this one (state.loop.parent?.case); null for a case no case started. */
  parent: string | null;
  /** The child a pause of this case's run waits on (a `child` hold); null otherwise. */
  waiting_on: string | null;
  /** The case's type (state.memory.type); null for a case with none. */
  type: string | null }
/** What a child case's first commit names of the stage that made it: subloop.child's payload. */
export interface ChildLink { parent: string; run: string; stage: string; attempt: number; loop: string; input_hash: string; depth: number; floor: Marking }
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
  /** The shared store's folder; join(dataDir, "memory") when not given. */
  memory?: string;
  /** For tests: called before each step of an unload with the temporary file's path; a throw is that step failing. */
  beforeUnloadStep?: (step: UnloadStep, part: string) => void;
}

/** A builder session's id; `CASE_ID` never matches one, so nothing that walks the cases meets a builder session. */
export const BUILD_ID = /^BUILD-[1-9][0-9]{0,8}$/;
/** The folder of the builder sessions, under the data folder. */
const BUILDERS = "builders";
const BUILDER_ASKED = "Build or change a loop";

/** The highest case number this data folder has given out or taken in, kept so an id is never given twice. */
const MARK_FILE = ".high-water";
const MARK = /^(0|[1-9][0-9]{0,8})$/;
/** What a stopped load or unload, or a stopped write of the mark, leaves in cases/. */
const LEFTOVER = /^\.(loading-|unloading-|high-water\.)/;
const RECOVERY: Actor = { kind: "system", id: "recovery" };
const STOPPED = "the workbench stopped before the case was unloaded";
const UNFINISHED = "an unload did not finish";
const STOPPED_AFTER_PUBLISHING = "the workbench stopped before the case was unloaded after publishing";

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
  /** Builder sessions held open, by BUILD-N: kept apart from the cases, so nothing that walks the cases meets one. */
  private readonly builders: Record<string, CaseSession> = Object.create(null) as Record<string, CaseSession>;
  /** The cases an unload is packing, with their state as of case.unloaded. */
  private readonly unloading = new Map<string, { state: Readonly<CaseState>; created_ts: string }>();
  /** What checkedStore learned of each store file, so a file that has not changed is not read again. */
  private readonly storeChecks: StoreChecks = new Map();
  /** The shared memory store's folder, and the store once it is opened (on first use). */
  private readonly memoryDir: string;
  private memoryStore: MemoryStore | null = null;
  /** True while an export packs the store, which is then closed: nothing opens it again until the file is written. */
  private memoryPacking = false;

  private constructor(dataDir: string, chain: Ledger, opts: WorkbenchOptions, onError: ErrorHandler, lock: Database, lockKey: string) {
    this.dataDir = dataDir;
    this.chain = chain;
    this.chainBlobs = new BlobStore(join(dataDir, "blobs"));
    this.store = new CaseStoreFolder(opts.store ?? join(dataDir, "store"));
    this.now = opts.now;
    this.onError = onError;
    this.maxCaseBytes = opts.max_case_bytes ?? DEFAULT_MAX_CASE_BYTES;
    this.memoryDir = resolve(opts.memory ?? join(dataDir, "memory"));
    this.beforeUnloadStep = opts.beforeUnloadStep;
    this.lock = lock;
    this.lockKey = lockKey;
  }

  /** Opens the data folder, taking its lock, and removes what a stopped load or unload left in cases/ (each is reported through onError). */
  static open(dataDir: string, opts: WorkbenchOptions = {}): Workbench {
    if (typeof dataDir !== "string" || dataDir === "") throw new TypeError("dataDir must be a non-empty string");
    if (opts.store !== undefined && (typeof opts.store !== "string" || opts.store === "")) throw new TypeError("store must be a non-empty string");
    if (opts.memory !== undefined && (typeof opts.memory !== "string" || opts.memory === "")) throw new TypeError("memory must be a non-empty string");
    if (opts.max_case_bytes !== undefined && !(Number.isSafeInteger(opts.max_case_bytes) && opts.max_case_bytes >= 1)) throw new TypeError("max_case_bytes must be a positive integer");
    const onError: ErrorHandler = opts.onError ?? logToStderr("workbench");
    mkdirSync(dataDir, { recursive: true });
    const held = lockKeyOf(dataDir);
    const lock = acquireLock(dataDir, held);
    try {
      mkdirSync(join(dataDir, "cases"), { recursive: true });
      mkdirSync(join(dataDir, "blobs"), { recursive: true });
      sweep(join(dataDir, "cases"), onError);
      if (existsSync(join(dataDir, BUILDERS))) sweep(join(dataDir, BUILDERS), onError);
      repairMemory(resolve(opts.memory ?? join(dataDir, "memory")), onError);
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

  /**
   * Makes a case, in one commit. `loop`: the loop the case is for (case.loop_set). `default_loop`, used only when `loop` is omitted: the
   * configuration's default loop, recorded as case.created's `loop` (still one entry); with neither, none is recorded and the case is read as
   * the default loop's when its run starts. `link` and `cards`: a child case, with subloop.child and one card.created per card its inputs name, both by the engine. Throws
   * TypeError, having written nothing, for what the fold would not read: a link without a loop, a malformed link or card, cards without a link,
   * a child less strictly marked than its link's floor or than a card it is given, a child whose loop is not its link's. `type`: the case's type,
   * recorded as case.type_set in the commit of case.created (after subloop.child, before the cards): by `actor` for a case a person makes, by the
   * engine for a child. `type_by`: the system actor that stands for a type the person did not choose (a loop's default, or one inherited from a
   * parent); case.type_set is then by it, not by `actor` or the engine. A type that is not a case type's id, an agent as the actor, a `type_by`
   * that is not a system actor, or a `type_by` with no `type`, is a TypeError.
   */
  createCase(input: NewCase, actor: Actor, opts: { loop?: string; default_loop?: string; link?: ChildLink; cards?: Card[]; type?: string; type_by?: Actor } = {}): CaseSession {
    this.open();
    if (!isMarking(input?.marking)) throw new TypeError(`unknown marking ${JSON.stringify(input?.marking)}`);
    const { loop, link } = opts;
    const cards = opts.cards ?? [];
    if (loop !== undefined && !(typeof loop === "string" && loop !== "")) throw new TypeError("a case's loop is a non-empty string");
    if (loop !== undefined && actor?.kind === "agent") throw new TypeError("a case's loop is chosen by a person or the workbench");
    if (!Array.isArray(cards)) throw new TypeError("cards must be a list");
    const { type } = opts;
    if (type !== undefined && !(typeof type === "string" && CASE_TYPE_ID.test(type))) throw new TypeError("a case's type is a case type's id");
    if (type !== undefined && actor?.kind === "agent") throw new TypeError("a case's type is set by a person or the workbench");
    const { type_by } = opts;
    if (type_by !== undefined && (type === undefined || type_by?.kind !== "system")) throw new TypeError("a type's actor is a system actor, and only for a type");
    if (link !== undefined) {
      if (loop === undefined) throw new TypeError("a child case names the loop it is for");
      if (!isChildLink(link)) throw new TypeError("a child's link names its parent, run, stage, attempt (1 or more), loop, input hash, depth and floor marking");
      if (link.loop !== loop) throw new TypeError(`a child case is for the loop its link names ("${link.loop}"), not "${loop}"`);
      if (strictest(input.marking, link.floor) !== input.marking) throw new TypeError(`a child case is marked at least ${link.floor}, its floor; this one is ${input.marking}`);
    } else if (cards.length > 0) {
      throw new TypeError("only a child case is made with cards");
    }
    for (const c of cards) {
      if (!isCard({ ...c, id: "c1" })) throw new TypeError("a child's input card is not a card the fold would read");
      if (strictest(input.marking, c.marking) !== input.marking) throw new TypeError(`a child case is marked at least as strictly as each card it is given; one is ${c.marking}, the case ${input.marking}`);
    }
    const n = this.nextNumber();
    const id = `CASE-${n}`;
    // The seven case fields and nothing else, with the id last so nothing in the input can replace it.
    const { title, asked, why, starting, window, objective, marking } = input;
    // the default loop, when no loop is named, is recorded on case.created itself (no second entry), so a later change of the default does not re-home the case
    const { default_loop } = opts;
    if (default_loop !== undefined && (typeof default_loop !== "string" || default_loop === "")) throw new TypeError("a default loop is a loop's id");
    const fields = caseFields({ title, asked, why, starting, window, objective, marking, id });
    const payload = loop === undefined && default_loop !== undefined ? { ...fields, loop: default_loop } : fields;
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
      session.commit((_state, ids) => {
        const entries: EntryInput[] = [{ type: "case.created", payload, actor }];
        if (loop !== undefined) entries.push({ type: "case.loop_set", payload: { loop }, actor: link === undefined ? actor : ENGINE });
        if (link !== undefined) {
          const { parent, run, stage, attempt, input_hash, depth, floor } = link;
          entries.push({ type: "subloop.child", payload: { parent, run, stage, attempt, loop: link.loop, input_hash, depth, floor }, actor: ENGINE });
        }
        if (type !== undefined) entries.push({ type: "case.type_set", payload: { type }, actor: type_by ?? (link === undefined ? actor : ENGINE) });
        for (const c of cards) entries.push({ type: "card.created", payload: { card: { ...c, id: ids.next("card") } }, actor: ENGINE });
        return entries;
      });
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
          loop: s.loop.id,
          parent: s.loop.parent?.case ?? null,
          waiting_on: waitingOn(s),
          type: s.memory.type,
        });
      } catch (err) {
        this.reportError(new Error(`case ${id} could not be loaded: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
      }
    }
    return out;
  }

  /**
   * A builder session: a case-shaped ledger under <data>/builders/BUILD-N/. `loop` is the loop it is about (recorded as case.loop_set), null for
   * the Loops page's. Its case.created has asked "Build or change a loop", no starting values and an open window. Throws TypeError, having
   * written nothing, for an unknown marking, a loop that is not a non-empty string or null, or an agent as the actor.
   */
  createBuilder(input: { loop: string | null; marking: Marking }, actor: Actor): CaseSession {
    this.open();
    if (!isMarking(input?.marking)) throw new TypeError(`unknown marking ${JSON.stringify(input?.marking)}`);
    const loop = input.loop;
    if (loop !== null && !(typeof loop === "string" && loop !== "")) throw new TypeError("a builder session's loop is a non-empty string or null");
    if (actor?.kind === "agent") throw new TypeError("a builder session is started by a person or the workbench");
    mkdirSync(join(this.dataDir, BUILDERS), { recursive: true });
    const n = Math.max(0, ...this.builderNumbers(), this.readMark(BUILDERS)) + 1;
    if (n > MAX_CASE_NUMBER) throw new CaseRefused(`every builder id up to BUILD-${MAX_CASE_NUMBER} has been given out here; no new builder session can be made`);
    const id = `BUILD-${n}`;
    const payload = caseFields({
      title: loop === null ? "Build a loop" : `Change the loop ${loop}`, asked: BUILDER_ASKED, why: "a builder session",
      starting: [], window: { from: null, to: null }, objective: null, marking: input.marking, id,
    });
    // The mark first: once a folder can exist, its number can never be given out again.
    this.raiseMark(n, BUILDERS);
    let session: CaseSession;
    try {
      session = this.openBuilder(id, true);
    } catch (err) {
      rmSync(join(this.dataDir, BUILDERS, id), { recursive: true, force: true });
      throw err;
    }
    try {
      session.commit(() => {
        const entries: EntryInput[] = [{ type: "case.created", payload, actor }];
        if (loop !== null) entries.push({ type: "case.loop_set", payload: { loop }, actor });
        return entries;
      });
    } catch (err) {
      delete this.builders[id];
      try {
        session.close();
      } finally {
        rmSync(session.dir, { recursive: true, force: true });
      }
      throw err;
    }
    return session;
  }

  /** A builder session by its id. Throws CaseNotFoundError for an id that is not BUILD-N or has no ledger here. */
  builder(id: string): CaseSession {
    this.open();
    if (typeof id !== "string" || !BUILD_ID.test(id)) throw new CaseNotFoundError(String(id));
    if (Object.hasOwn(this.builders, id)) return this.builders[id]!;
    if (!existsSync(join(this.dataDir, BUILDERS, id, "ledger.sqlite"))) throw new CaseNotFoundError(id);
    return this.openBuilder(id, false);
  }

  /** A summary of every builder session, newest first. Reads each ledger and lets it go, as listCases does. */
  listBuilders(): BuilderSummary[] {
    this.open();
    const out: BuilderSummary[] = [];
    for (const n of this.builderNumbers().sort((a, b) => b - a)) {
      const id = `BUILD-${n}`;
      const path = join(this.dataDir, BUILDERS, id, "ledger.sqlite");
      if (!existsSync(path)) continue;
      try {
        let state: Readonly<CaseState>;
        let created_ts: string;
        if (Object.hasOwn(this.builders, id)) {
          const session = this.builders[id]!;
          state = session.state;
          created_ts = session.entries(0, 1)[0]?.ts ?? "";
        } else {
          const ledger = Ledger.open(path, id, { onError: this.onError });
          try {
            const entries = ledger.read();
            state = fold(entries);
            created_ts = entries[0]?.ts ?? "";
          } finally {
            ledger.close();
          }
        }
        if (state.meta === null) continue;
        const open = builderOpen(state);
        out.push({
          id, title: state.meta.title, loop: state.loop.id, marking: builderMarking(state), created_ts,
          open_changes: open.changes.length, open_probes: open.probes.length, turns: state.conversation.length,
        });
      } catch (err) {
        this.reportError(new Error(`builder session ${id} could not be loaded: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
      }
    }
    return out;
  }

  private builderNumbers(): number[] {
    const dir = join(this.dataDir, BUILDERS);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => BUILD_ID.test(n)).map((n) => Number(n.slice(6)));
  }

  /** Opens a builder session's ledger and keeps it. A builder session is never unloaded, so there is nothing to recover. */
  private openBuilder(id: string, create: boolean): CaseSession {
    const dir = join(this.dataDir, BUILDERS, id);
    if (create) mkdirSync(dir, { recursive: true });
    const ledger = Ledger.open(join(dir, "ledger.sqlite"), id, { ...(this.now ? { now: this.now } : {}), onError: this.onError });
    try {
      const session: CaseSession = new CaseSession({
        id, dir, ledger, blobs: new BlobStore(join(dir, "blobs")), onError: this.onError,
        onClose: () => {
          if (this.builders[id] === session) delete this.builders[id];
        },
      });
      this.builders[id] = session;
      return session;
    } catch (err) {
      ledger.close();
      throw err;
    }
  }

  /** The loaded case whose subloop.child names exactly this link; null when there is none. Reads ledgers, opens no session it does not already hold. */
  findChild(link: ChildLink): string | null {
    this.open();
    if (!isChildLink(link)) throw new TypeError("a child's link names its parent, run, stage, attempt (1 or more), loop, input hash, depth and floor marking");
    const want = canonical(linkFields(link) as unknown as Json);
    for (const n of this.caseNumbers().sort((a, b) => a - b)) {
      const id = `CASE-${n}`;
      if (!existsSync(join(this.dataDir, "cases", id, "ledger.sqlite"))) continue;
      let parent: CaseState["loop"]["parent"];
      try {
        parent = this.summaryOf(id).state.loop.parent;
      } catch (err) {
        this.reportError(new Error(`case ${id} could not be read while looking for a child of ${link.parent}: ${firstLine(err)}`, { cause: err }));
        continue;
      }
      if (parent === null) continue;
      const { case: of, ...rest } = parent;
      if (canonical(linkFields({ ...rest, parent: of }) as unknown as Json) === want) return id;
    }
    return null;
  }

  /**
   * Why a case may not be unloaded now for what it is linked to; null when it may. A parent is not unloaded while a child it started and has not
   * heard back from is running (its drive would settle into a case that is gone); a child is not unloaded alone while its loaded parent's run
   * waits on it. A case at the other end that is not loaded, or cannot be read, holds nothing back.
   */
  private linkProblem(id: string, state: Readonly<CaseState>): string | null {
    for (const c of Object.values(state.loop.children)) {
      if (c.finished !== null) continue;
      const child = this.linkedState(c.child);
      if (child === null) continue;
      if (child.loop.parent?.case !== id) continue;
      if (child.run.status === "running" || Object.values(child.jobs).some((j) => j.status === "running")) {
        return `${c.child}, a child of this case, is running; wait for it or pause it first`;
      }
    }
    const parentId = state.loop.parent?.case;
    if (parentId !== undefined) {
      const parent = this.linkedState(parentId);
      const waits = parent !== null && parent.run.status !== "none" && parent.run.status !== "finished"
        && Object.values(parent.loop.children).some((c) => c.child === id && c.finished === null);
      if (waits) return `${parentId} waits on this case; unload ${parentId} first`;
    }
    return null;
  }

  /** The state of another loaded case, for a link check; null when it is not loaded here or cannot be read. */
  private linkedState(id: string): Readonly<CaseState> | null {
    if (!CASE_ID.test(id)) return null;
    if (!Object.hasOwn(this.sessions, id) && !this.unloading.has(id) && !existsSync(join(this.dataDir, "cases", id, "ledger.sqlite"))) return null;
    try {
      return this.summaryOf(id).state;
    } catch {
      return null;
    }
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
    for (const id of Object.keys(this.builders)) {
      const s = this.builders[id]!;
      delete this.builders[id];
      attempt(() => s.close());
    }
    attempt(() => this.memoryStore?.close());
    this.memoryStore = null;
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

  /**
   * The shared store, opened on first use and closed with the workbench. After loadMemory it is the loaded one: do not keep it (an export closes
   * it while it packs it, and opens it again as a new object). While an export packs it, it is refused.
   */
  get memory(): MemoryStore {
    this.open();
    if (this.memoryPacking) throw new MemoryRefused("the memory store is being exported; try again when that is done");
    this.memoryStore ??= MemoryStore.open(this.memoryDir, { ...(this.now ? { now: this.now } : {}), onError: this.onError });
    return this.memoryStore;
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
      // an unload that never finished, or an unload after publishing the person asked for that a stop left undone (the host acts on that
      // only as the drive settles, in the process that drove it): either is recorded, so it is neither lost silently nor tried later
      const stopped = session.state.archive.pending !== null ? STOPPED : unloadDue(session.state) ? STOPPED_AFTER_PUBLISHING : null;
      if (!create && recover && stopped !== null) {
        try {
          session.commit(() => [{ type: "case.unload_failed", payload: { reason: stopped }, actor: RECOVERY }]);
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

  /** The number in `<folder>/.high-water` (cases/ when not given); 0 when there is none or it is not a number. */
  private readMark(folder = "cases"): number {
    let text: string;
    try {
      text = readFileSync(join(this.dataDir, folder, MARK_FILE), "utf8").trim();
    } catch {
      return 0;
    }
    return MARK.test(text) ? Number(text) : 0;
  }

  /** Raises the mark of `folder` (cases/ when not given) to `n`, never lowering it: a temporary file, fsync, rename, fsync of the folder. Throws when it cannot be written. */
  private raiseMark(n: number, folder = "cases"): void {
    if (n <= this.readMark(folder)) return;
    const dir = join(this.dataDir, folder);
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

  /**
   * Packs the store into `toDir` and records memory.exported on the chain. Throws MemoryRefused for an empty store or an actor that is not a
   * person. The store is closed while it is packed, then opened again: it is left in place, unchanged. The order: write
   * `<toDir>/.tmp-memory-<pid>-<uuid>.part`; read it back with checkMemoryFile and compare; rename it to its name (an existing file of that name
   * with the same bytes is kept); open the store again; append memory.exported.
   */
  async exportMemory(toDir: string, by: { actor: Actor }): Promise<{ file: string; path: string; manifest: MemoryFileManifest }> {
    this.open();
    if (typeof toDir !== "string" || toDir === "") throw new MemoryRefused("a memory file is written to a folder");
    if (by?.actor?.kind !== "human") throw new MemoryRefused("only a person exports the memory store");
    if (within(realOf(toDir), realOf(this.memoryDir))) throw new MemoryRefused("a memory file may not be written inside the memory store's folder; choose a folder outside it");
    const store = this.memory;
    const head = store.head();
    const origin = store.origin();
    if (head.seq === 0 || origin === null) throw new MemoryRefused("the memory store is empty; there is nothing to export");
    const state = store.state;
    const lessons = { proposed: 0, accepted: 0, rejected: 0, retired: 0, superseded: 0 };
    for (const id of state.order) lessons[state.lessons[id]!.status] += 1;
    const marking = strictest(...state.order.map((id) => state.lessons[id]!.marking));
    const exported_ts = this.now?.() ?? new Date().toISOString();
    const file = memoryFileName(marking, head.hash);
    const dest = join(toDir, file);
    const part = join(toDir, `.tmp-memory-${process.pid}-${randomUUID()}.part`);
    let manifest: MemoryFileManifest;
    // closed while it is packed, so no write lands between the listing and the archive
    this.closeMemory();
    this.memoryPacking = true;
    try {
      mkdirSync(toDir, { recursive: true });
      manifest = await writeMemoryFile(this.memoryDir, part, { origin, head, entries: head.seq, lessons, marking, exported_ts });
      const back = await checkMemoryFile(part);
      if (canonical(back as unknown as Json) !== canonical(manifest as unknown as Json)) throw new MemoryFileError("the memory file did not read back as written");
      if (existsSync(dest) && sameBytes(dest, part)) rmSync(part, { force: true });
      else renameSync(part, dest);
      syncDir(toDir);
    } catch (err) {
      rmSync(part, { force: true });
      throw err;
    } finally {
      this.memoryPacking = false;
      if (!this.closed) void this.memory;
    }
    this.open();
    this.chain.append({ type: "memory.exported", payload: { file, origin, head, lessons: state.order.length }, actor: by.actor });
    return { file, path: dest, manifest };
  }

  /**
   * Replaces the store with the file's, when the store here is empty, holds only seed proposals no person has decided, or the file is this store
   * further on; records memory.loaded, whose `before` is the head of the store replaced. Throws
   * MemoryFileError or MemoryRefused, and then the store is what it was. Stores are not merged: a file of another store, of this store behind or
   * beside it, or at its head is refused.
   */
  async loadMemory(file: string, by: { actor: Actor }): Promise<{ origin: string; head: { seq: number; hash: string }; lessons: number }> {
    this.open();
    if (typeof file !== "string" || file === "") throw new TypeError("file must be a non-empty string");
    if (by?.actor?.kind !== "human") throw new MemoryRefused("only a person loads a memory store");
    // 1. the whole archive against its memory.json; nothing is written
    const m = await checkMemoryFile(file);
    this.open();
    const parent = dirname(this.memoryDir);
    mkdirSync(parent, { recursive: true });
    const tmp = join(parent, `.memory-loading-${randomUUID()}`);
    let before: { seq: number; hash: string };
    let lessons: number;
    try {
      // 2. extracted beside the store; the second pass must read the file the first one checked
      const second = await extractMemoryFile(file, tmp);
      if (canonical(second as unknown as Json) !== canonical(m as unknown as Json)) throw new MemoryFileError("the file changed while it was loaded");
      mkdirSync(join(tmp, "blobs"), { recursive: true });
      // 3. the ledger is exactly what Ledger.open makes, it verifies, and it holds what memory.json says
      const ledgerPath = join(tmp, "ledger.sqlite");
      const schema = readOnly(ledgerPath, ledgerSchemaProblem);
      if (schema !== null) throw new MemoryFileError(`the memory store's ledger is not one this workbench writes: ${schema}`);
      let report: ReturnType<typeof verifyMemory>;
      try {
        report = verifyMemory(tmp);
      } catch (err) {
        throw new MemoryFileError(`the memory store in the file does not verify: ${firstLine(err)}`);
      }
      if (!report.ok) {
        const why = report.case !== "memory" ? `its ledger is ${report.case}, not a memory store`
          : !report.lessons.ok && report.firstBad === null && report.blobs.bad.length === 0
            ? report.lessons.bad.length > 0 ? `${report.lessons.bad[0]!.lesson}: ${report.lessons.bad[0]!.reason}` : `${report.lessons.skipped} entries its fold does not read`
            : formatReport(report).split("\n")[0]!;
        throw new MemoryFileError(`the memory store in the file does not verify: ${why}`);
      }
      if (report.head !== m.head.hash || report.entries !== m.entries) throw new MemoryFileError("the memory store in the file does not verify: its head is not the one memory.json names");
      if (hashAt(ledgerPath, 1) !== m.origin) throw new MemoryFileError("the memory store in the file does not verify: its first entry is not the one memory.json names");
      const folded = foldLessons(this.ledgerEntries(ledgerPath));
      const counts = { proposed: 0, accepted: 0, rejected: 0, retired: 0, superseded: 0 };
      for (const id of folded.order) counts[folded.lessons[id]!.status] += 1;
      const marking = strictest(...folded.order.map((id) => folded.lessons[id]!.marking));
      if (canonical(counts) !== canonical(m.lessons) || marking !== m.marking) throw new MemoryFileError("memory.json does not say what its ledger holds; this file cannot be loaded");
      lessons = folded.order.length;
      // no entry of the store's ledger names a blob (a lesson's text is in its payload): a file that holds one holds bytes nothing reads
      const blob = m.files.find((f) => f.path.startsWith("blobs/"));
      if (blob !== undefined) throw new MemoryFileError(`${blob.path} is a blob no entry of the memory store names; this file cannot be loaded`);
      // 4. only an empty store, a store of untouched seed proposals, or this store further on
      this.open();
      const here = this.memory;
      before = here.head();
      if (before.seq > 0) {
        if (here.origin() !== m.origin) {
          // a store of seed proposals no person has decided is what a first start files: the file's store replaces it (controller ruling)
          if (!onlyUntouchedSeeds(here.entries())) throw new MemoryRefused("this file is another workbench's memory store, and stores are not merged; to use it, start from an empty store");
        } else if (before.seq === m.head.seq && before.hash === m.head.hash) throw new MemoryRefused("this memory store is already at the file's head");
        else if (m.head.seq <= before.seq || hashAt(ledgerPath, before.seq) !== before.hash) {
          throw new MemoryRefused("this workbench's memory store has entries the file does not hold; stores are not merged");
        }
      }
      // 5. the swap: the store renamed away, the extracted folder renamed into place
      this.closeMemory();
      const replaced = join(parent, `.memory-replaced-${randomUUID()}`);
      const had = existsSync(this.memoryDir);
      if (had) renameSync(this.memoryDir, replaced);
      try {
        renameSync(tmp, this.memoryDir);
      } catch (err) {
        if (had) renameSync(replaced, this.memoryDir);
        throw err;
      }
      syncDir(parent);
      try {
        this.open();
        void this.memory;
        this.chain.append({ type: "memory.loaded", payload: { file: basename(file), origin: m.origin, head: { seq: m.head.seq, hash: m.head.hash }, before }, actor: by.actor });
      } catch (err) {
        // the load is not recorded, so it is undone: the store that was here is put back
        this.closeMemory();
        try {
          renameSync(this.memoryDir, tmp);
          if (had) renameSync(replaced, this.memoryDir);
          syncDir(parent);
        } catch (undo) {
          this.reportError(new Error(`the memory load could not be recorded, nor undone; ${replaced} holds the store that was here: ${firstLine(undo)}`, { cause: undo }));
        }
        throw err;
      }
      try {
        if (had) rmSync(replaced, { recursive: true, force: true });
      } catch (err) {
        this.reportError(new Error(`the memory store was loaded, but ${replaced} could not be removed (it goes when the workbench next opens): ${firstLine(err)}`, { cause: err }));
      }
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      // the store as it was, open again when it was closed for the swap
      if (!this.closed) void this.memory;
      throw err;
    }
    return { origin: m.origin, head: { seq: m.head.seq, hash: m.head.hash }, lessons };
  }

  /** Every entry of a ledger file, read through Ledger and closed again. */
  private ledgerEntries(path: string): Entry[] {
    const ledger = Ledger.open(path, "memory", { onError: this.onError });
    try {
      return ledger.read();
    } finally {
      ledger.close();
    }
  }

  /** Closes the shared store, if it is open; the next use of `memory` opens it again. */
  private closeMemory(): void {
    const s = this.memoryStore;
    this.memoryStore = null;
    s?.close();
  }

  /** The hash of entry 1 of the loaded case `id`, read without opening a session or writing anything; null when no case has that id here. */
  loadedOrigin(id: string): string | null {
    this.open();
    if (typeof id !== "string" || !CASE_ID.test(id)) return null;
    return this.originOf(id);
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
      const problem = unloadProblem(state) ?? this.linkProblem(id, state);
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
    // the marking is in its name too: a temporary file a stop leaves is a whole copy of the case
    const part = join(store.dir, `.tmp-${file.slice(0, -".tar.gz".length)}-${process.pid}-${randomUUID()}.part`);
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
      const cause = firstLine(err).split(part).join("the temporary file");
      // the cause may already say what was being done (writeCaseFile's own words): it is said once
      const reason = this.withoutPaths(cause.startsWith(`${doing}: `) ? cause : `${doing}: ${cause}`, store);
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
      // the second pass must read the file the first one checked: a file swapped between them is refused here, not only by its head
      const second = await extractCaseFile(file, tmp, { max_bytes: this.maxCaseBytes });
      if (canonical(second as unknown as Json) !== canonical(m as unknown as Json)) throw new CaseFileError("the file changed while it was loaded");
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

/** The engine, which writes a child's link and its input cards. */
const ENGINE: Actor = { kind: "system", id: "engine" };

const isLinkText = (x: unknown): x is string => typeof x === "string" && x !== "";
/** The shape the fold reads subloop.child by. */
function isChildLink(x: unknown): x is ChildLink {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const l = x as Record<string, unknown>;
  const count = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
  return isLinkText(l.parent) && isLinkText(l.run) && isLinkText(l.stage) && count(l.attempt) && (l.attempt as number) >= 1 && isLinkText(l.loop)
    && typeof l.input_hash === "string" && count(l.depth) && isMarking(l.floor);
}
/** A link's eight fields and nothing else. */
const linkFields = (l: ChildLink): ChildLink => ({
  parent: l.parent, run: l.run, stage: l.stage, attempt: l.attempt, loop: l.loop, input_hash: l.input_hash, depth: l.depth, floor: l.floor,
});
/** The child a pause of the case's run waits on; null when the run is not paused on a child. */
function waitingOn(s: Readonly<CaseState>): string | null {
  const hold = s.run.status === "paused" ? s.run.hold : null;
  return hold?.kind === "child" ? hold.child : null;
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

/** True when the two files hold the same bytes. */
function sameBytes(a: string, b: string): boolean {
  try {
    return Buffer.compare(readFileSync(a), readFileSync(b)) === 0;
  } catch {
    return false;
  }
}

/**
 * True when every entry of the store is a seed's proposal filed by the workbench: no person has proposed, accepted, rejected or retired
 * anything in it. Such a store is what a first start files from the roots' seeds, and a load may replace it.
 */
function onlyUntouchedSeeds(entries: readonly Entry[]): boolean {
  return entries.every((e) => {
    if (e.type !== "lesson.proposed" || e.actor.kind !== "system") return false;
    const from = (e.payload as { from?: unknown }).from;
    return typeof from === "object" && from !== null && (from as { kind?: unknown }).kind === "seed";
  });
}

/**
 * Repairs a load of the memory store that stopped part way. No store folder and one `.memory-replaced-*` folder beside it: the load stopped
 * between its two renames, and that folder is renamed back. A `.memory-replaced-*` folder beside a store folder is what a load that finished left
 * behind, and is removed; so is every `.memory-loading-*`. Each is reported through `onError`.
 */
function repairMemory(memoryDir: string, onError: ErrorHandler): void {
  const parent = dirname(memoryDir);
  let names: string[];
  try {
    names = readdirSync(parent).sort();
  } catch {
    return;
  }
  const say = (message: string, cause?: unknown): void => ignoreThrow(() => onError(new Error(message, cause === undefined ? undefined : { cause })));
  const replaced = names.filter((n) => n.startsWith(".memory-replaced-"));
  if (!existsSync(memoryDir) && replaced.length === 1) {
    try {
      renameSync(join(parent, replaced[0]!), memoryDir);
      syncDir(parent);
      say(`the memory store was put back from ${replaced[0]}: a load stopped before it finished`);
    } catch (err) {
      say(`${replaced[0]} in ${parent} could not be put back as the memory store: ${firstLine(err)}`, err);
    }
  } else if (existsSync(memoryDir)) {
    for (const n of replaced) {
      try {
        rmSync(join(parent, n), { recursive: true, force: true });
        say(`removed ${n} from ${parent}: the store a finished load replaced`);
      } catch (err) {
        say(`${n} in ${parent} could not be removed: ${firstLine(err)}`, err);
      }
    }
  } else if (replaced.length > 1) {
    say(`there is no memory store in ${parent}, and ${replaced.length} stores a load set aside; none is put back: choose one and rename it to ${basename(memoryDir)}`);
  }
  for (const n of names.filter((x) => x.startsWith(".memory-loading-"))) {
    try {
      rmSync(join(parent, n), { recursive: true, force: true });
      say(`removed ${n} from ${parent}: a load of the memory store stopped before it finished`);
    } catch (err) {
      say(`${n} in ${parent} could not be removed: ${firstLine(err)}`, err);
    }
  }
}
