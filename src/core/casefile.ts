// The case file: one case folder packed as a ustar archive inside gzip, case.json first. Server-side core (like workbench.ts): never imported by
// src/web or src/core/state. A case file is untrusted input; the reader writes nothing it has not checked against case.json.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { canonical } from "./canonical";
import type { Json } from "./canonical";
import { Refused } from "./refused";
import { isNum, isObj, isStr } from "./state/guards";
import { CHUNK as TAR_CHUNK, memberProblem, readTarGz, shown, TarError, writeAll, writeTarGz } from "./tar";
import type { TarMember, TarSink } from "./tar";
import { isMarking } from "./types";
import type { Marking, Observable } from "./types";

export const WORKBENCH_VERSION = "0.13.0";
export const CASE_FILE_FORMAT = 1;
export const DEFAULT_MAX_CASE_BYTES = 2147483648;

/** A case file that cannot be made, read or trusted. `reasons[0]` says why, in words a person can act on. */
export class CaseFileError extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "CaseFileError";
  }
}

export interface CaseFileEntry { path: string; sha256: string; bytes: number }
export interface CaseManifest {
  format: 1;
  /** The id the case has on the workbench that packed it. */
  id: string;
  /** The id its ledger was made with: `Entry.case` of every entry. */
  chain: string;
  /** The hash of entry 1: the same in every copy of this case, whatever id it is given. */
  origin: string;
  title: string; asked: string; marking: Marking; starting: Observable[];
  status: string; outcome: "published" | "completed" | "stopped" | null;
  published: { n: number; draft_hash: string }[];
  head: { seq: number; hash: string }; entries: number;
  workbench: string; unloaded_ts: string;
  /** Every file of the case folder but case.json itself, sorted by path with `<`. */
  files: CaseFileEntry[];
}
export type ManifestHeader = Omit<CaseManifest, "format" | "workbench" | "files">;

const MANIFEST_NAME = "case.json";
/** What SQLite leaves beside a ledger while a write is unfinished. */
const JOURNALS = ["ledger.sqlite-journal", "ledger.sqlite-wal"];
/** A case id: CASE- and one to nine digits, so its number is always an exact integer. The one pattern for an id, everywhere. */
export const CASE_ID = /^CASE-[1-9][0-9]{0,8}$/;
/** The highest case number there can be. */
export const MAX_CASE_NUMBER = 999999999;
/** How a case file's name is made, for a sentence that refuses one. */
export const CASE_FILE_NAME_FORM = "CASE-<1 to 9 digits>.<marking>.tar.gz";
const HASH = /^[0-9a-f]{64}$/;
const FILE_NAME = /^(CASE-[1-9][0-9]{0,8})\.([A-Za-z0-9+_-]+)\.tar\.gz$/;

const isCount = (x: unknown, min: number): x is number => isNum(x) && Number.isSafeInteger(x) && x >= min;
const isHash = (x: unknown): x is string => isStr(x) && HASH.test(x);
const isObservable = (x: unknown): x is Observable => isObj(x) && isStr(x.type) && isStr(x.value);
const isFileEntry = (x: unknown): x is CaseFileEntry => isObj(x) && isStr(x.path) && memberProblem(x.path) === null && x.path !== MANIFEST_NAME && isHash(x.sha256) && isCount(x.bytes, 0);

/** Sorted with `<`, no path twice, and no path is the folder of another. */
function filesWellFormed(files: CaseFileEntry[]): boolean {
  const paths = new Set(files.map((f) => f.path));
  for (let i = 0; i < files.length; i++) {
    const p = files[i]!.path;
    if (i > 0 && !(files[i - 1]!.path < p)) return false;
    for (let cut = p.indexOf("/"); cut !== -1; cut = p.indexOf("/", cut + 1)) if (paths.has(p.slice(0, cut))) return false;
  }
  return true;
}

export const isCaseManifest = (x: unknown): x is CaseManifest =>
  isObj(x) && x.format === CASE_FILE_FORMAT && isStr(x.id) && CASE_ID.test(x.id) && isStr(x.chain) && CASE_ID.test(x.chain) && isHash(x.origin)
  && isStr(x.title) && isStr(x.asked) && isMarking(x.marking) && Array.isArray(x.starting) && x.starting.every(isObservable)
  && isStr(x.status) && (x.outcome === null || x.outcome === "published" || x.outcome === "completed" || x.outcome === "stopped")
  && Array.isArray(x.published) && x.published.every((p) => isObj(p) && isCount(p.n, 1) && isHash(p.draft_hash))
  && isObj(x.head) && isCount(x.head.seq, 1) && isHash(x.head.hash) && isCount(x.entries, 1)
  && isStr(x.workbench) && isStr(x.unloaded_ts)
  && Array.isArray(x.files) && x.files.every(isFileEntry) && filesWellFormed(x.files);

/** "CASE-12" + "TLP:AMBER" → "CASE-12.TLP-AMBER.tar.gz": every character of the marking outside [A-Za-z0-9+_-] becomes "-". */
export function caseFileName(id: string, marking: string): string {
  return `${id}.${marking.replace(/[^A-Za-z0-9+_-]/g, "-")}.tar.gz`;
}

/** The id and the marking part of a case file's name; null when it is not one. */
export function parseCaseFileName(name: string): { id: string; marking: string } | null {
  const m = FILE_NAME.exec(name);
  return m === null ? null : { id: m[1]!, marking: m[2]! };
}

export { memberProblem };

/** Read and write in pieces this large: a case is never held in memory whole. */
const CHUNK = TAR_CHUNK;
/** case.json is read into memory to be parsed; one larger than this is not a manifest this workbench wrote. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const enc = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });
const UNREADABLE = "the file is not a readable case file";

const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
const codeOf = (err: unknown): unknown => (isObj(err) ? err.code : undefined);
const sha256 = (): Bun.CryptoHasher => new Bun.CryptoHasher("sha256");
const tooLarge = (max: number): CaseFileError => new CaseFileError(`the case is larger than the limit of ${max} bytes`);

/** A TarError said as the case file has always said it. */
function caseError(err: TarError): CaseFileError {
  const p = err.problem;
  switch (p.kind) {
    case "link": return new CaseFileError(`${shown(p.name)} is a link; a case file holds only regular files`);
    case "too_large": return tooLarge(p.max);
    case "folder": return new CaseFileError("it is a folder, not a case file");
    case "long_name": return new CaseFileError(`${shown(p.name)} is too long a path for a case file`);
    case "member_too_large": return new CaseFileError(`${shown(p.name)} is too large for a case file`);
    case "write": return new CaseFileError(`the case file could not be written: ${p.reason}`);
    default: return new CaseFileError(err.message);
  }
}

// ---------- the case folder ----------

/** Opens a regular file without following a link in its last segment. */
function openRegular(path: string, rel: string): { fd: number; size: number } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (codeOf(err) === "ELOOP") throw new CaseFileError(`${shown(rel)} is a link; a case file holds only regular files`);
    throw new CaseFileError(`${shown(rel)} could not be read: ${reasonOf(err)}`);
  }
  const st = fstatSync(fd);
  if (!st.isFile()) {
    closeSync(fd);
    throw new CaseFileError(`${shown(rel)} is not a regular file; a case file holds only regular files`);
  }
  return { fd, size: st.size };
}

/** Reads `fd` in pieces, calling `each` with every piece, until `want` bytes (or the end of the file, when `want` is null). The count read. */
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

/** Every regular file under `dir`, hashed. Throws CaseFileError for a link or a special file, naming it. */
export function listCaseFolder(dir: string): CaseFileEntry[] {
  for (const journal of JOURNALS) {
    let found = false;
    try { lstatSync(join(dir, journal)); found = true; } catch { /* absent, as it should be */ }
    if (found) throw new CaseFileError("the ledger has an unfinished journal");
  }
  const out: CaseFileEntry[] = [];
  const walk = (rel: string): void => {
    for (const n of readdirSync(rel === "" ? dir : join(dir, rel)).sort(lt)) {
      const r = rel === "" ? n : `${rel}/${n}`;
      const st = lstatSync(join(dir, r));
      if (st.isSymbolicLink()) throw new CaseFileError(`${shown(r)} is a link; a case file holds only regular files`);
      if (st.isDirectory()) { walk(r); continue; }
      if (!st.isFile()) throw new CaseFileError(`${shown(r)} is not a regular file; a case file holds only regular files`);
      if (r === MANIFEST_NAME) throw new CaseFileError("the case folder holds a file named case.json; a case file writes its own");
      const problem = memberProblem(r);
      if (problem !== null) throw new CaseFileError(`${shown(r)}: ${problem}`);
      const { fd, size } = openRegular(join(dir, r), r);
      try {
        const h = sha256();
        const bytes = readPieces(fd, null, (p) => h.update(p));
        if (bytes !== size) throw new CaseFileError(`${shown(r)} changed while the case was packed`);
        out.push({ path: r, sha256: h.digest("hex"), bytes });
      } finally {
        closeSync(fd);
      }
    }
  };
  walk("");
  return out.sort((a, b) => lt(a.path, b.path));
}

// ---------- writing ----------

/** One listed file's pieces, read again and checked against what was listed. */
function* filePieces(caseDir: string, f: CaseFileEntry): Generator<Uint8Array> {
  const { fd, size } = openRegular(join(caseDir, f.path), f.path);
  try {
    if (size !== f.bytes) throw new CaseFileError(`${shown(f.path)} changed while the case was packed`);
    const h = sha256();
    const pieces: Uint8Array[] = [];
    let read = 0;
    // Read a piece at a time and hand it on before the next is read.
    for (;;) {
      pieces.length = 0;
      const n = readPieces(fd, Math.min(CHUNK, f.bytes - read), (p) => { h.update(p); pieces.push(p); });
      if (n === 0) break;
      read += n;
      yield* pieces;
    }
    const extra = readPieces(fd, 1, () => {});
    if (read !== f.bytes || extra !== 0 || h.digest("hex") !== f.sha256) throw new CaseFileError(`${shown(f.path)} changed while the case was packed`);
  } finally {
    closeSync(fd);
  }
}

/** Packs `caseDir` into `dest` (created with "wx", flushed with fsync before it resolves). case.json is the first member. */
export async function writeCaseFile(caseDir: string, dest: string, header: ManifestHeader): Promise<CaseManifest> {
  const files = listCaseFolder(caseDir);
  const manifest: CaseManifest = {
    format: CASE_FILE_FORMAT, id: header.id, chain: header.chain, origin: header.origin, title: header.title, asked: header.asked,
    marking: header.marking, starting: header.starting, status: header.status, outcome: header.outcome, published: header.published,
    head: header.head, entries: header.entries, workbench: WORKBENCH_VERSION, unloaded_ts: header.unloaded_ts, files,
  };
  if (!isCaseManifest(manifest)) throw new CaseFileError("the case's details do not make a case manifest");
  const text = canonical(manifest as unknown as Json);
  const json = enc.encode(text);
  const members: TarMember[] = [
    { name: MANIFEST_NAME, size: json.length, open: () => [json] },
    ...files.map((f): TarMember => ({ name: f.path, size: f.bytes, open: () => filePieces(caseDir, f) })),
  ];
  try {
    await writeTarGz(dest, members);
  } catch (err) {
    throw err instanceof TarError ? caseError(err) : err instanceof CaseFileError ? err : new CaseFileError(`the case file could not be written: ${reasonOf(err)}`);
  }
  return JSON.parse(text) as CaseManifest;
}

// ---------- reading ----------

interface MemberWriter { write(piece: Uint8Array): void; end(): void }
interface Destination { open(name: string): MemberWriter }

/** Thrown by the reader's sink once case.json is read, when nothing more is wanted. */
class ManifestRead {
  constructor(readonly manifest: CaseManifest) {}
}

/**
 * The one reader of a case file, through readTarGz. Every header is checked (checksum, kind, name, a name twice, the running total
 * against `max`) by the tar reader, then (listed in case.json, the size case.json lists) here, before its body is read; every body is
 * hashed as it passes and compared with case.json. The bytes that come out of gzip are counted too, so a small file that inflates past
 * the limit is refused as it inflates.
 */
async function readArchive(file: string, opts: { max: number; manifestOnly: boolean; out?: Destination }): Promise<CaseManifest> {
  const { out } = opts;
  let manifest: CaseManifest | null = null;
  let listed = new Map<string, CaseFileEntry>();
  const seen = new Set<string>();
  const sink: TarSink = {
    open(name, size) {
      seen.add(name);
      if (manifest === null) {
        if (name !== MANIFEST_NAME) throw new CaseFileError("case.json is not the first member");
        if (size > MAX_MANIFEST_BYTES) throw new CaseFileError("case.json is not a case manifest");
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
              throw new CaseFileError("case.json is not a case manifest");
            }
            if (!isCaseManifest(parsed)) throw new CaseFileError("case.json is not a case manifest");
            // the writer never packs a journal (it refuses a folder that has one); one in a file would be applied to the ledger when it is opened
            const journal = parsed.files.find((f) => JOURNALS.includes(f.path));
            if (journal !== undefined) throw new CaseFileError(`the case file holds ${journal.path}, a ledger journal; a case file holds none`);
            manifest = parsed;
            listed = new Map(parsed.files.map((f) => [f.path, f]));
            if (opts.manifestOnly) throw new ManifestRead(parsed);
          },
        };
      }
      const entry = listed.get(name);
      if (entry === undefined) throw new CaseFileError(`${shown(name)} is not listed in case.json`);
      if (size !== entry.bytes) throw new CaseFileError(`${shown(name)} is not the size case.json lists`);
      const hasher = sha256();
      const w = out?.open(name);
      return {
        write: (p) => { hasher.update(p); w?.write(p); },
        end: () => {
          w?.end();
          if (hasher.digest("hex") !== entry.sha256) throw new CaseFileError(`${shown(name)} is not what case.json lists`);
        },
      };
    },
  };
  try {
    await readTarGz(file, { max: opts.max, sink, unreadable: UNREADABLE });
  } catch (err) {
    if (err instanceof ManifestRead) return err.manifest;
    if (err instanceof CaseFileError) throw err;
    if (err instanceof TarError) throw caseError(err);
    throw new CaseFileError(UNREADABLE);
  }
  const found = manifest as CaseManifest | null;
  if (found === null) throw new CaseFileError("case.json is not the first member");
  for (const f of found.files) if (!seen.has(f.path)) throw new CaseFileError(`${shown(f.path)} is listed in case.json and is not in the file`);
  return found;
}

const limitOf = (opts?: { max_bytes?: number }): number => {
  const max = opts?.max_bytes ?? DEFAULT_MAX_CASE_BYTES;
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError("max_bytes must be a positive whole number");
  return max;
};

/** The manifest alone: reads no further than the first member. */
export async function readManifest(file: string): Promise<CaseManifest> {
  return readArchive(file, { max: DEFAULT_MAX_CASE_BYTES, manifestOnly: true });
}

/** Reads the whole file and checks every member against case.json. Writes nothing. Throws CaseFileError. */
export async function checkCaseFile(file: string, opts?: { max_bytes?: number }): Promise<CaseManifest> {
  return readArchive(file, { max: limitOf(opts), manifestOnly: false });
}

/**
 * One member's bytes, read into memory, the whole file checked against case.json as checkCaseFile does; null when case.json lists no such
 * member. Writes nothing. Throws CaseFileError.
 */
export async function readCaseMember(file: string, name: string, opts?: { max_bytes?: number }): Promise<{ manifest: CaseManifest; bytes: Uint8Array | null }> {
  const pieces: Uint8Array[] = [];
  let found = false;
  const out: Destination = {
    open: (member) => {
      if (member !== name) return { write: () => {}, end: () => {} };
      found = true;
      return { write: (piece) => void pieces.push(piece.slice()), end: () => {} };
    },
  };
  const manifest = await readArchive(file, { max: limitOf(opts), manifestOnly: false, out });
  if (!found) return { manifest, bytes: null };
  const bytes = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) { bytes.set(p, at); at += p.length; }
  return { manifest, bytes };
}

/** Writes members under `root`, a directory this run made: each opened "wx" at a path checked to be inside `root`, flushed before it is closed. */
class Extraction implements Destination {
  private fd: number | null = null;
  constructor(private readonly root: string) {}

  open(name: string): MemberWriter {
    const target = resolve(this.root, name);
    if (!target.startsWith(this.root + sep)) throw new CaseFileError(`${shown(name)}: a path that leaves the case folder`);
    try {
      mkdirSync(dirname(target), { recursive: true });
      this.fd = openSync(target, "wx");
    } catch (err) {
      throw new CaseFileError(`the case could not be written: ${reasonOf(err)}`);
    }
    const fd = this.fd;
    return {
      write: (piece) => {
        try { writeAll(fd, piece); } catch (err) { throw new CaseFileError(`the case could not be written: ${reasonOf(err)}`); }
      },
      end: () => {
        try { fsyncSync(fd); } catch (err) { throw new CaseFileError(`the case could not be written: ${reasonOf(err)}`); }
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

/** checkCaseFile, writing each member under `destDir` (which must not exist). On any failure `destDir` is removed. */
export async function extractCaseFile(file: string, destDir: string, opts?: { max_bytes?: number }): Promise<CaseManifest> {
  const max = limitOf(opts);
  const root = resolve(destDir);
  try {
    mkdirSync(root);
  } catch (err) {
    throw new CaseFileError(codeOf(err) === "EEXIST" ? `${destDir} already exists` : `the case could not be written: ${reasonOf(err)}`);
  }
  const out = new Extraction(root);
  try {
    return await readArchive(file, { max, manifestOnly: false, out });
  } catch (err) {
    out.abort();
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}
