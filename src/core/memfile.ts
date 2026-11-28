// The memory file (slice 13): the shared lessons store's folder packed as a case is packed, through slice 11's tar code: a ustar inside gzip,
// memory.json first, every other member hashed in it. Server-side core: never imported by src/web or src/core/state. A memory file is untrusted
// input: the reader writes nothing it has not checked against memory.json, and a member's name, size and hash are checked before it is kept.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { canonical } from "./canonical";
import type { Json } from "./canonical";
import { WORKBENCH_VERSION } from "./casefile";
import { Refused } from "./refused";
import { isNum, isObj, isStr } from "./state/guards";
import { CHUNK, memberProblem, readTarGz, shown, TarError, writeAll, writeTarGz } from "./tar";
import type { TarMember, TarSink } from "./tar";
import { isMarking } from "./types";
import type { Marking } from "./types";

export const MEMORY_FILE_FORMAT = 1;
/** The most a memory file may unpack to. */
export const MAX_MEMORY_FILE_BYTES = 268435456;

/** A memory file that cannot be made, read or trusted. The message says why, in words a person can act on. */
export class MemoryFileError extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "MemoryFileError";
  }
}

export interface MemoryFileManifest {
  format: 1; workbench: string; origin: string; head: { seq: number; hash: string }; entries: number;
  lessons: { proposed: number; accepted: number; rejected: number; retired: number; superseded: number };
  /** The strictest marking of any lesson in it. */
  marking: Marking; exported_ts: string;
  files: { path: string; sha256: string; bytes: number }[];
}
type FileEntry = MemoryFileManifest["files"][number];

const MANIFEST_NAME = "memory.json";
const LEDGER = "ledger.sqlite";
/** What SQLite leaves beside a ledger while a write is unfinished: never packed, and a file that lists one is not a memory file. */
const JOURNALS = ["ledger.sqlite-journal", "ledger.sqlite-wal", "ledger.sqlite-shm"];
/** memory.json is read into memory to be parsed; one larger than this is not a manifest this workbench wrote. */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const UNREADABLE = "the file is not a readable memory file";
const HASH = /^[0-9a-f]{64}$/;
const FILE_NAME = /^memory\.([A-Za-z0-9+_-]+)\.([0-9a-f]{12})\.memory\.tar\.gz$/;
const STATUSES = ["proposed", "accepted", "rejected", "retired", "superseded"] as const;

const enc = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
const codeOf = (err: unknown): unknown => (isObj(err) ? err.code : undefined);
const sha256 = (): Bun.CryptoHasher => new Bun.CryptoHasher("sha256");
const isCount = (x: unknown, min: number): x is number => isNum(x) && Number.isSafeInteger(x) && x >= min;
const isHash = (x: unknown): x is string => isStr(x) && HASH.test(x);
/** A store folder holds its ledger and its blobs, nothing else. */
const isStorePath = (p: string): boolean => p === LEDGER || p.startsWith("blobs/");
const isFileEntry = (x: unknown): x is FileEntry =>
  isObj(x) && isStr(x.path) && memberProblem(x.path) === null && isStorePath(x.path) && isHash(x.sha256) && isCount(x.bytes, 0);

/** Sorted with `<`, no path twice, the ledger among them. */
const filesWellFormed = (files: FileEntry[]): boolean =>
  files.every((f, i) => i === 0 || files[i - 1]!.path < f.path) && files.some((f) => f.path === LEDGER);

export const isMemoryManifest = (x: unknown): x is MemoryFileManifest =>
  isObj(x) && x.format === MEMORY_FILE_FORMAT && isStr(x.workbench) && isHash(x.origin)
  && isObj(x.head) && isCount(x.head.seq, 1) && isHash(x.head.hash) && isCount(x.entries, 1) && x.entries === x.head.seq
  && isObj(x.lessons) && STATUSES.every((k) => isCount((x.lessons as Record<string, unknown>)[k], 0)) && Object.keys(x.lessons).length === STATUSES.length
  && isMarking(x.marking) && isStr(x.exported_ts)
  && Array.isArray(x.files) && x.files.every(isFileEntry) && filesWellFormed(x.files as FileEntry[]);

/** memory.<marking, written as a case file's name writes it>.<first 12 hex of the head hash>.memory.tar.gz */
export function memoryFileName(marking: string, head: string): string {
  return `memory.${marking.replace(/[^A-Za-z0-9+_-]/g, "-")}.${head.slice(0, 12)}.memory.tar.gz`;
}

/** The marking part and the 12 hex of a memory file's name; null when it is not one. */
export function parseMemoryFileName(name: string): { marking: string; hash12: string } | null {
  const m = FILE_NAME.exec(name);
  return m === null ? null : { marking: m[1]!, hash12: m[2]! };
}

/** A TarError said in a memory file's words. */
function fileError(err: TarError): MemoryFileError {
  const p = err.problem;
  switch (p.kind) {
    case "link": return new MemoryFileError(`${shown(p.name)} is a link; a memory file holds only regular files`);
    case "too_large": return new MemoryFileError(`the memory file is larger than the limit of ${p.max} bytes`);
    case "folder": return new MemoryFileError("it is a folder, not a memory file");
    case "long_name": return new MemoryFileError(`${shown(p.name)} is too long a path for a memory file`);
    case "member_too_large": return new MemoryFileError(`${shown(p.name)} is too large for a memory file`);
    case "write": return new MemoryFileError(`the memory file could not be written: ${p.reason}`);
    default: return new MemoryFileError(err.message);
  }
}

// ---------- the store folder ----------

/** Opens a regular file without following a link in its last segment. */
function openRegular(path: string, rel: string): { fd: number; size: number } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (codeOf(err) === "ELOOP") throw new MemoryFileError(`${shown(rel)} is a link; a memory file holds only regular files`);
    throw new MemoryFileError(`${shown(rel)} could not be read: ${reasonOf(err)}`);
  }
  const st = fstatSync(fd);
  if (!st.isFile()) {
    closeSync(fd);
    throw new MemoryFileError(`${shown(rel)} is not a regular file; a memory file holds only regular files`);
  }
  return { fd, size: st.size };
}

/** Reads `fd` in pieces, calling `each` with every piece, until `want` bytes (or the end, when `want` is null). The count read. */
function readPieces(fd: number, want: number | null, each: (piece: Uint8Array) => void): number {
  let total = 0;
  for (;;) {
    const len = want === null ? CHUNK : Math.min(CHUNK, want - total);
    if (len === 0) return total;
    const buf = new Uint8Array(len);
    const n = readSync(fd, buf, 0, len, null);
    if (n === 0) return total;
    each(n === len ? buf : buf.subarray(0, n));
    total += n;
  }
}

/** Every regular file of the store folder, hashed: the ledger and what is under blobs/. Anything else, a link, or a journal is refused. */
function listStoreFolder(dir: string): FileEntry[] {
  for (const journal of JOURNALS) {
    let found = false;
    try { lstatSync(join(dir, journal)); found = true; } catch { /* absent, as it should be */ }
    if (found) throw new MemoryFileError("the memory store's ledger has an unfinished journal");
  }
  const out: FileEntry[] = [];
  const walk = (rel: string): void => {
    for (const n of readdirSync(rel === "" ? dir : join(dir, rel)).sort(lt)) {
      const r = rel === "" ? n : `${rel}/${n}`;
      const st = lstatSync(join(dir, r));
      if (st.isSymbolicLink()) throw new MemoryFileError(`${shown(r)} is a link; a memory file holds only regular files`);
      if (st.isDirectory()) { walk(r); continue; }
      if (!st.isFile()) throw new MemoryFileError(`${shown(r)} is not a regular file; a memory file holds only regular files`);
      const problem = memberProblem(r);
      if (problem !== null) throw new MemoryFileError(`${shown(r)}: ${problem}`);
      if (!isStorePath(r)) throw new MemoryFileError(`${shown(r)} is not a file of a memory store; a memory file holds its ledger and its blobs`);
      const { fd, size } = openRegular(join(dir, r), r);
      try {
        const h = sha256();
        const bytes = readPieces(fd, null, (p) => h.update(p));
        if (bytes !== size) throw new MemoryFileError(`${shown(r)} changed while the store was packed`);
        out.push({ path: r, sha256: h.digest("hex"), bytes });
      } finally {
        closeSync(fd);
      }
    }
  };
  walk("");
  return out.sort((a, b) => lt(a.path, b.path));
}

/** One listed file's pieces, read again and checked against what was listed. */
function* filePieces(dir: string, f: FileEntry): Generator<Uint8Array> {
  const { fd, size } = openRegular(join(dir, f.path), f.path);
  try {
    if (size !== f.bytes) throw new MemoryFileError(`${shown(f.path)} changed while the store was packed`);
    const h = sha256();
    const pieces: Uint8Array[] = [];
    let read = 0;
    for (;;) {
      pieces.length = 0;
      const n = readPieces(fd, Math.min(CHUNK, f.bytes - read), (p) => { h.update(p); pieces.push(p); });
      if (n === 0) break;
      read += n;
      yield* pieces;
    }
    const extra = readPieces(fd, 1, () => {});
    if (read !== f.bytes || extra !== 0 || h.digest("hex") !== f.sha256) throw new MemoryFileError(`${shown(f.path)} changed while the store was packed`);
  } finally {
    closeSync(fd);
  }
}

// ---------- writing ----------

/** Packs the store folder into `dest` (created with "wx", flushed with fsync before it resolves). memory.json is the first member. */
export async function writeMemoryFile(storeDir: string, dest: string, header: Omit<MemoryFileManifest, "format" | "workbench" | "files">): Promise<MemoryFileManifest> {
  const files = listStoreFolder(storeDir);
  const manifest: MemoryFileManifest = {
    format: MEMORY_FILE_FORMAT, workbench: WORKBENCH_VERSION, origin: header.origin, head: { seq: header.head.seq, hash: header.head.hash }, entries: header.entries,
    lessons: {
      proposed: header.lessons.proposed, accepted: header.lessons.accepted, rejected: header.lessons.rejected,
      retired: header.lessons.retired, superseded: header.lessons.superseded,
    },
    marking: header.marking, exported_ts: header.exported_ts, files,
  };
  if (!isMemoryManifest(manifest)) throw new MemoryFileError("the store's details do not make a memory manifest");
  const text = canonical(manifest as unknown as Json);
  const json = enc.encode(text);
  const members: TarMember[] = [
    { name: MANIFEST_NAME, size: json.length, open: () => [json] },
    ...files.map((f): TarMember => ({ name: f.path, size: f.bytes, open: () => filePieces(storeDir, f) })),
  ];
  try {
    await writeTarGz(dest, members);
  } catch (err) {
    throw err instanceof TarError ? fileError(err) : err instanceof MemoryFileError ? err : new MemoryFileError(`the memory file could not be written: ${reasonOf(err)}`);
  }
  return JSON.parse(text) as MemoryFileManifest;
}

// ---------- reading ----------

interface MemberWriter { write(piece: Uint8Array): void; end(): void }
interface Destination { open(name: string): MemberWriter }

/**
 * The one reader of a memory file, through readTarGz (which checks every header: checksum, kind, name, a name twice, the running total against
 * the limit, and counts what gzip inflates). Here: memory.json first and well formed; every other member listed in it, of the size it lists, and
 * hashed as it passes; every listed member present.
 */
async function readArchive(file: string, out?: Destination): Promise<MemoryFileManifest> {
  let manifest: MemoryFileManifest | null = null;
  let listed = new Map<string, FileEntry>();
  const seen = new Set<string>();
  const sink: TarSink = {
    open(name, size) {
      seen.add(name);
      if (manifest === null) {
        if (name !== MANIFEST_NAME) throw new MemoryFileError("memory.json is not the first member");
        if (size > MAX_MANIFEST_BYTES) throw new MemoryFileError("memory.json is not a memory manifest");
        const pieces: Uint8Array[] = [];
        return {
          write: (p) => void pieces.push(p.slice()),
          end: () => {
            const body = new Uint8Array(size);
            let at = 0;
            for (const p of pieces) { body.set(p, at); at += p.length; }
            let parsed: unknown;
            try {
              parsed = JSON.parse(strict.decode(body));
            } catch {
              throw new MemoryFileError("memory.json is not a memory manifest");
            }
            if (!isMemoryManifest(parsed)) throw new MemoryFileError("memory.json is not a memory manifest");
            manifest = parsed;
            listed = new Map(parsed.files.map((f) => [f.path, f]));
          },
        };
      }
      const entry = listed.get(name);
      if (entry === undefined) throw new MemoryFileError(`${shown(name)} is not listed in memory.json`);
      if (size !== entry.bytes) throw new MemoryFileError(`${shown(name)} is not the size memory.json lists`);
      const hasher = sha256();
      const w = out?.open(name);
      return {
        write: (p) => { hasher.update(p); w?.write(p); },
        end: () => {
          w?.end();
          if (hasher.digest("hex") !== entry.sha256) throw new MemoryFileError(`${shown(name)} is not what memory.json lists`);
        },
      };
    },
  };
  try {
    await readTarGz(file, { max: MAX_MEMORY_FILE_BYTES, sink, unreadable: UNREADABLE });
  } catch (err) {
    if (err instanceof MemoryFileError) throw err;
    if (err instanceof TarError) throw fileError(err);
    throw new MemoryFileError(UNREADABLE);
  }
  const found = manifest as MemoryFileManifest | null;
  if (found === null) throw new MemoryFileError("memory.json is not the first member");
  for (const f of found.files) if (!seen.has(f.path)) throw new MemoryFileError(`${shown(f.path)} is listed in memory.json and is not in the file`);
  return found;
}

/** Reads the whole file and checks every member against memory.json. Writes nothing. */
export async function checkMemoryFile(file: string): Promise<MemoryFileManifest> {
  return readArchive(file);
}

/** Writes members under `root`, a folder this call made: each opened "wx" at a path checked to be inside `root`, flushed before it is closed. */
class Extraction implements Destination {
  private fd: number | null = null;
  constructor(private readonly root: string) {}

  open(name: string): MemberWriter {
    const target = resolve(this.root, name);
    if (!target.startsWith(this.root + sep)) throw new MemoryFileError(`${shown(name)}: a path that leaves the store's folder`);
    try {
      mkdirSync(dirname(target), { recursive: true });
      this.fd = openSync(target, "wx");
    } catch (err) {
      throw new MemoryFileError(`the memory store could not be written: ${reasonOf(err)}`);
    }
    const fd = this.fd;
    return {
      write: (piece) => {
        try { writeAll(fd, piece); } catch (err) { throw new MemoryFileError(`the memory store could not be written: ${reasonOf(err)}`); }
      },
      end: () => {
        try { fsyncSync(fd); } catch (err) { throw new MemoryFileError(`the memory store could not be written: ${reasonOf(err)}`); }
        closeSync(fd);
        this.fd = null;
      },
    };
  }

  /** Closes a member left open by a failure. */
  abort(): void {
    if (this.fd !== null) { try { closeSync(this.fd); } catch { /* already closed */ } this.fd = null; }
  }
}

/** checkMemoryFile, writing each member under `destDir` (which must not exist); on any failure `destDir` is removed. */
export async function extractMemoryFile(file: string, destDir: string): Promise<MemoryFileManifest> {
  const root = resolve(destDir);
  try {
    mkdirSync(root);
  } catch (err) {
    throw new MemoryFileError(codeOf(err) === "EEXIST" ? `${destDir} already exists` : `the memory store could not be written: ${reasonOf(err)}`);
  }
  const out = new Extraction(root);
  try {
    return await readArchive(file, out);
  } catch (err) {
    out.abort();
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}
