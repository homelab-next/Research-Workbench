// The case file: one case folder packed as a ustar archive inside gzip, case.json first. Server-side core (like workbench.ts): never imported by
// src/web or src/core/state. A case file is untrusted input; the reader writes nothing it has not checked against case.json.
import { closeSync, constants, createReadStream, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import { canonical } from "./canonical";
import type { Json } from "./canonical";
import { Refused } from "./refused";
import { isNum, isObj, isStr } from "./state/guards";
import { isMarking } from "./types";
import type { Marking, Observable } from "./types";

export const WORKBENCH_VERSION = "0.11.0";
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
  status: string; outcome: "published" | "stopped" | null;
  published: { n: number; draft_hash: string }[];
  head: { seq: number; hash: string }; entries: number;
  workbench: string; unloaded_ts: string;
  /** Every file of the case folder but case.json itself, sorted by path with `<`. */
  files: CaseFileEntry[];
}
export type ManifestHeader = Omit<CaseManifest, "format" | "workbench" | "files">;

const MANIFEST_NAME = "case.json";
const CASE_ID = /^CASE-[1-9][0-9]*$/;
const HASH = /^[0-9a-f]{64}$/;
const FILE_NAME = /^(CASE-[1-9][0-9]*)\.([A-Za-z0-9+_-]+)\.tar\.gz$/;

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
  && isStr(x.status) && (x.outcome === null || x.outcome === "published" || x.outcome === "stopped")
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

/** Why a member name may not be written under a case folder; null when it may. */
export function memberProblem(name: string): string | null {
  if (name === "") return "an empty name";
  if (name.includes("\0")) return "a NUL in a path";
  if (name.includes("\\")) return "a backslash in a path";
  if (name.startsWith("/")) return "an absolute path";
  const segments = name.split("/");
  if (segments.some((s) => s === "." || s === "..")) return "a path that leaves the case folder";
  if (segments.some((s) => s === "")) return "an empty path segment";
  return null;
}

// ---------- the tar format: POSIX ustar, 512-byte blocks, fixed header fields ----------

const BLOCK = 512;
/** Read and write in pieces this large: a case is never held in memory whole. */
const CHUNK = 65536;
/** The largest size an 11-digit octal size field holds. */
const MAX_MEMBER_BYTES = 8 ** 11 - 1;
/** case.json is read into memory to be parsed; one larger than this is not a manifest this workbench wrote. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const enc = new TextEncoder();
const UNREADABLE = "the file is not a readable case file";

/** A name as it may appear in a sentence: control characters (a NUL among them) are shown as U+FFFD. */
const shown = (name: string): string => name.replace(/[\u0000-\u001f\u007f]/g, "\uFFFD");
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
const codeOf = (err: unknown): unknown => (isObj(err) ? err.code : undefined);
const sha256 = (): Bun.CryptoHasher => new Bun.CryptoHasher("sha256");

function writeAll(fd: number, bytes: Uint8Array): void {
  for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
}

/** The `name` and `prefix` fields of a path: the whole path in `name` when it fits, else split at a "/". */
function splitName(path: string): { name: Uint8Array; prefix: Uint8Array } {
  const whole = enc.encode(path);
  if (whole.length <= 100) return { name: whole, prefix: new Uint8Array(0) };
  for (let cut = path.indexOf("/"); cut !== -1; cut = path.indexOf("/", cut + 1)) {
    const prefix = enc.encode(path.slice(0, cut));
    const name = enc.encode(path.slice(cut + 1));
    if (prefix.length <= 155 && name.length <= 100) return { name, prefix };
  }
  throw new CaseFileError(`${shown(path)} is too long a path for a case file`);
}

function octalField(block: Uint8Array, at: number, len: number, value: number): void {
  block.set(enc.encode(value.toString(8).padStart(len - 1, "0") + "\0"), at);
}

/** A ustar header with every field but name and size fixed, so the same folder always packs to the same bytes. */
function ustarHeader(path: string, size: number): Uint8Array {
  const b = new Uint8Array(BLOCK);
  const { name, prefix } = splitName(path);
  b.set(name, 0);
  octalField(b, 100, 8, 0o644);
  octalField(b, 108, 8, 0);
  octalField(b, 116, 8, 0);
  octalField(b, 124, 12, size);
  octalField(b, 136, 12, 0);
  b.set(enc.encode("        "), 148);
  b[156] = "0".charCodeAt(0);
  b.set(enc.encode("ustar\0"), 257);
  b.set(enc.encode("00"), 263);
  octalField(b, 329, 8, 0);
  octalField(b, 337, 8, 0);
  b.set(prefix, 345);
  let sum = 0;
  for (const x of b) sum += x;
  b.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return b;
}

const padding = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

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
  for (const journal of ["ledger.sqlite-journal", "ledger.sqlite-wal"]) {
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

/** The blocks of the archive: case.json, then each listed file read again and checked against what was listed, then two zero blocks. */
function* archiveBlocks(caseDir: string, json: Uint8Array, files: CaseFileEntry[]): Generator<Uint8Array> {
  yield ustarHeader(MANIFEST_NAME, json.length);
  yield json;
  if (padding(json.length) > 0) yield new Uint8Array(padding(json.length));
  for (const f of files) {
    yield ustarHeader(f.path, f.bytes);
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
    if (padding(f.bytes) > 0) yield new Uint8Array(padding(f.bytes));
  }
  yield new Uint8Array(2 * BLOCK);
}

/** Gzips `blocks` into `fd`, honouring the compressor's back-pressure. */
async function gzipInto(fd: number, blocks: Iterable<Uint8Array>): Promise<void> {
  const gz = createGzip();
  const ended = new Promise<void>((res, rej) => { gz.once("end", () => res()); gz.once("error", rej); });
  ended.catch(() => {}); // awaited below; this only keeps an early failure from being reported as unhandled
  gz.on("data", (c: Uint8Array) => {
    try { writeAll(fd, c); } catch (err) { gz.destroy(err instanceof Error ? err : new Error(String(err))); }
  });
  try {
    for (const b of blocks) {
      if (!gz.write(b)) await Promise.race([new Promise<void>((r) => gz.once("drain", () => r())), ended]);
    }
    gz.end();
    await ended;
  } finally {
    gz.destroy();
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
  for (const f of files) {
    splitName(f.path);
    if (f.bytes > MAX_MEMBER_BYTES) throw new CaseFileError(`${shown(f.path)} is too large for a case file`);
  }
  let fd: number;
  try {
    fd = openSync(dest, "wx");
  } catch (err) {
    throw new CaseFileError(codeOf(err) === "EEXIST" ? `${dest} already exists` : `the case file could not be written: ${reasonOf(err)}`);
  }
  let open = true;
  try {
    await gzipInto(fd, archiveBlocks(caseDir, json, files));
    fsyncSync(fd);
    closeSync(fd);
    open = false;
  } catch (err) {
    if (open) closeSync(fd);
    rmSync(dest, { force: true });
    throw err instanceof CaseFileError ? err : new CaseFileError(`the case file could not be written: ${reasonOf(err)}`);
  }
  return JSON.parse(text) as CaseManifest;
}

// ---------- reading ----------

/** The decompressed bytes, handed out in pieces; every byte handed out is counted and passed to `check` (the decompression-bomb guard). */
class Source {
  private readonly chunks: Uint8Array[] = [];
  private offset = 0;
  private have = 0;
  private eof = false;
  private consumed = 0;

  constructor(private readonly it: AsyncIterator<Uint8Array>, private readonly check: (consumed: number) => void) {}

  private async pull(): Promise<boolean> {
    if (this.eof) return false;
    const r = await this.it.next();
    if (r.done === true) { this.eof = true; return false; }
    const c = r.value;
    if (c.length > 0) { this.chunks.push(c); this.have += c.length; }
    return true;
  }

  /** Between 1 and `max` bytes; null at the end. The piece is valid until the next call. */
  async some(max: number): Promise<Uint8Array | null> {
    while (this.have === 0) if (!(await this.pull())) return null;
    const first = this.chunks[0]!;
    const n = Math.min(max, first.length - this.offset);
    const out = first.subarray(this.offset, this.offset + n);
    this.offset += n;
    this.have -= n;
    if (this.offset === first.length) { this.chunks.shift(); this.offset = 0; }
    this.consumed += n;
    this.check(this.consumed);
    return out;
  }

  /** Exactly `n` bytes; null when the stream ends first. */
  async exact(n: number): Promise<Uint8Array | null> {
    const out = new Uint8Array(n);
    for (let at = 0; at < n; ) {
      const p = await this.some(n - at);
      if (p === null) return null;
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  async skip(n: number): Promise<void> {
    for (let left = n; left > 0; ) {
      const p = await this.some(left);
      if (p === null) throw new CaseFileError(UNREADABLE);
      left -= p.length;
    }
  }
}

interface Header { name: string; type: string; size: number }

const strict = new TextDecoder("utf-8", { fatal: true });

/** A text field: its bytes up to the last non-NUL byte, so a NUL inside the name stays in it. */
function textField(b: Uint8Array, at: number, len: number): string {
  let end = at + len;
  while (end > at && b[end - 1] === 0) end--;
  try {
    return strict.decode(b.subarray(at, end));
  } catch {
    throw new CaseFileError(UNREADABLE);
  }
}

/** An octal number field (NUL- or space-terminated); null for anything else, base-256 among them. */
function octalValue(b: Uint8Array, at: number, len: number): number | null {
  let text = "";
  for (let i = at; i < at + len; i++) text += String.fromCharCode(b[i]!);
  const m = /^ *([0-7]+)[ \0]*$/.exec(text);
  return m === null ? null : parseInt(m[1]!, 8);
}

/** The next header; "end" at the two zero blocks; null when the stream ends first. Refuses a bad checksum or a header that is not ustar. */
async function readHeader(src: Source): Promise<Header | "end" | null> {
  const b = await src.exact(BLOCK);
  if (b === null) return null;
  if (b.every((x) => x === 0)) {
    const second = await src.exact(BLOCK);
    if (second === null || !second.every((x) => x === 0)) throw new CaseFileError(UNREADABLE);
    return "end";
  }
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : b[i]!;
  if (octalValue(b, 148, 8) !== sum) throw new CaseFileError(UNREADABLE);
  if (textField(b, 257, 6) !== "ustar" || b[262] !== 0 || b[263] !== 0x30 || b[264] !== 0x30) throw new CaseFileError(UNREADABLE);
  const size = octalValue(b, 124, 12);
  if (size === null) throw new CaseFileError(UNREADABLE);
  const name = textField(b, 0, 100);
  const prefix = textField(b, 345, 155);
  return { name: prefix === "" ? name : `${prefix}/${name}`, type: String.fromCharCode(b[156]!), size };
}

function kindProblem(h: Header): string | null {
  if (h.type === "0") return null;
  if (h.type === "1" || h.type === "2") return `${shown(h.name)} is a link; a case file holds only regular files`;
  return `${shown(h.name)} is not a regular file`;
}

interface MemberWriter { write(piece: Uint8Array): void; end(): void }
interface Destination { open(name: string): MemberWriter }

const tooLarge = (max: number): CaseFileError => new CaseFileError(`the case is larger than the limit of ${max} bytes`);

/**
 * The one reader of a case file. Every header is checked (checksum, kind, name, a name twice, listed in case.json, the running total
 * against `max`, the size case.json lists) before its body is read; every body is hashed as it passes and compared with case.json.
 * The bytes that come out of gzip are counted too, so a small file that inflates past the limit is refused as it inflates.
 */
async function readArchive(file: string, opts: { max: number; manifestOnly: boolean; out?: Destination }): Promise<CaseManifest> {
  const { max, out } = opts;
  const raw = createReadStream(file);
  const gz = createGunzip();
  raw.on("error", (err) => gz.destroy(err));
  raw.pipe(gz);
  let members = 0;
  // Each member adds at most a header and a block of padding to the bytes it declares; the end adds two blocks, and a little slack is left.
  const src = new Source(gz[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>, (consumed) => {
    if (consumed > max + 2 * BLOCK * (members + 2)) throw tooLarge(max);
  });
  try {
    const first = await readHeader(src);
    if (first === null) throw new CaseFileError(UNREADABLE);
    if (first === "end" || first.name !== MANIFEST_NAME) throw new CaseFileError("case.json is not the first member");
    const kind = kindProblem(first);
    if (kind !== null) throw new CaseFileError(kind);
    if (first.size > max) throw tooLarge(max);
    if (first.size > MAX_MANIFEST_BYTES) throw new CaseFileError("case.json is not a case manifest");
    members = 1;
    let total = first.size;
    const body = await src.exact(first.size);
    if (body === null) throw new CaseFileError(UNREADABLE);
    let manifest: unknown;
    try {
      manifest = JSON.parse(strict.decode(body));
    } catch {
      throw new CaseFileError("case.json is not a case manifest");
    }
    if (!isCaseManifest(manifest)) throw new CaseFileError("case.json is not a case manifest");
    if (opts.manifestOnly) return manifest;
    await src.skip(padding(first.size));

    const listed = new Map(manifest.files.map((f) => [f.path, f]));
    const seen = new Set<string>([MANIFEST_NAME]);
    for (;;) {
      const h = await readHeader(src);
      if (h === null) throw new CaseFileError(UNREADABLE);
      if (h === "end") break;
      const k = kindProblem(h);
      if (k !== null) throw new CaseFileError(k);
      const problem = memberProblem(h.name);
      if (problem !== null) throw new CaseFileError(`${shown(h.name)}: ${problem}`);
      if (seen.has(h.name)) throw new CaseFileError(`${shown(h.name)} appears twice`);
      seen.add(h.name);
      const entry = listed.get(h.name);
      if (entry === undefined) throw new CaseFileError(`${shown(h.name)} is not listed in case.json`);
      total += h.size;
      if (total > max) throw tooLarge(max);
      if (h.size !== entry.bytes) throw new CaseFileError(`${shown(h.name)} is not the size case.json lists`);
      members += 1;
      const hasher = sha256();
      const w = out?.open(h.name);
      for (let left = h.size; left > 0; ) {
        const p = await src.some(Math.min(left, CHUNK));
        if (p === null) throw new CaseFileError(UNREADABLE);
        hasher.update(p);
        w?.write(p);
        left -= p.length;
      }
      w?.end();
      if (hasher.digest("hex") !== entry.sha256) throw new CaseFileError(`${shown(h.name)} is not what case.json lists`);
      await src.skip(padding(h.size));
    }
    // After the end of the archive only zero bytes may follow (counted against the limit like any other).
    for (let p = await src.some(CHUNK); p !== null; p = await src.some(CHUNK)) if (!p.every((x) => x === 0)) throw new CaseFileError(UNREADABLE);
    for (const f of manifest.files) if (!seen.has(f.path)) throw new CaseFileError(`${shown(f.path)} is listed in case.json and is not in the file`);
    return manifest;
  } catch (err) {
    if (err instanceof CaseFileError) throw err;
    throw new CaseFileError(UNREADABLE);
  } finally {
    raw.unpipe(gz);
    raw.destroy();
    gz.destroy();
  }
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
