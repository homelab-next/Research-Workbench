// The tar code: POSIX ustar inside gzip, regular files only, fixed header fields. Server-side core (like casefile.ts): never imported by
// src/web or src/core/state. Used by the case file and the loop file; each says its own sentences from a TarError's `problem`.
import { closeSync, createReadStream, fsyncSync, openSync, rmSync, writeSync } from "node:fs";
import { createGunzip, createGzip } from "node:zlib";
import { Refused } from "./refused";

/** What went wrong, for a caller that says it in its own words. `name` is a member's name as it was read or given. */
export type TarProblem =
  | { kind: "unreadable" }
  | { kind: "missing" }
  | { kind: "folder" }
  | { kind: "too_large"; max: number }
  | { kind: "link"; name: string }
  | { kind: "not_regular"; name: string }
  | { kind: "bad_name"; name: string; problem: string }
  | { kind: "twice"; name: string }
  | { kind: "long_name"; name: string }
  | { kind: "member_too_large"; name: string }
  | { kind: "wrong_size"; name: string }
  | { kind: "exists"; dest: string }
  | { kind: "write"; reason: string };

/** An archive that cannot be made or read. `message` is a plain sentence; `problem` lets a caller say it in its own words. */
export class TarError extends Refused {
  readonly problem: TarProblem;
  constructor(message: string, problem: TarProblem) {
    super(message);
    this.name = "TarError";
    this.problem = problem;
  }
}

/** Why a member name may not be used; null when it may. */
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

const BLOCK = 512;
/** Read and write in pieces this large: an archive is never held in memory whole. */
export const CHUNK = 65536;
/** The largest size an 11-digit octal size field holds. */
const MAX_MEMBER_BYTES = 8 ** 11 - 1;
const enc = new TextEncoder();

/** A name as it may appear in a sentence: control characters (a NUL among them) are shown as U+FFFD. */
export const shown = (name: string): string => name.replace(/[\u0000-\u001f\u007f]/g, "�");
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
const codeOf = (err: unknown): unknown => (typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined);

export function writeAll(fd: number, bytes: Uint8Array): void {
  for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
}

// ---------- writing ----------

/** The `name` and `prefix` fields of a path: the whole path in `name` when it fits, else split at a "/". */
function splitName(path: string): { name: Uint8Array; prefix: Uint8Array } {
  const whole = enc.encode(path);
  if (whole.length <= 100) return { name: whole, prefix: new Uint8Array(0) };
  for (let cut = path.indexOf("/"); cut !== -1; cut = path.indexOf("/", cut + 1)) {
    const prefix = enc.encode(path.slice(0, cut));
    const name = enc.encode(path.slice(cut + 1));
    if (prefix.length <= 155 && name.length <= 100) return { name, prefix };
  }
  throw new TarError(`${shown(path)} is too long a path for a tar member`, { kind: "long_name", name: path });
}

function octalField(block: Uint8Array, at: number, len: number, value: number): void {
  block.set(enc.encode(value.toString(8).padStart(len - 1, "0") + "\0"), at);
}

/** A ustar header with every field but name and size fixed, so the same members always pack to the same bytes. */
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

export interface TarMember { name: string; size: number; open(): Iterable<Uint8Array> }

/** The blocks of the archive: each member's header, its pieces (which must come to its size), its padding; then two zero blocks. */
function* archiveBlocks(members: TarMember[]): Generator<Uint8Array> {
  for (const m of members) {
    yield ustarHeader(m.name, m.size);
    let n = 0;
    for (const piece of m.open()) {
      n += piece.length;
      if (n > m.size) break;
      yield piece;
    }
    if (n !== m.size) throw new TarError(`${shown(m.name)} is not the size it was given as`, { kind: "wrong_size", name: m.name });
    if (padding(m.size) > 0) yield new Uint8Array(padding(m.size));
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

/**
 * Writes a gzipped ustar of regular files, in the order given, to `dest` (created with "wx", fsynced before it resolves). Fixed header
 * fields, so the same members pack to the same tar bytes. Every name and size is checked before `dest` is made; on any failure `dest` is
 * removed. A Refused thrown by a member's pieces is passed on as it was thrown.
 */
export async function writeTarGz(dest: string, members: Iterable<TarMember>): Promise<void> {
  const list = [...members];
  const seen = new Set<string>();
  for (const m of list) {
    const problem = memberProblem(m.name);
    if (problem !== null) throw new TarError(`${shown(m.name)}: ${problem}`, { kind: "bad_name", name: m.name, problem });
    if (seen.has(m.name)) throw new TarError(`${shown(m.name)} appears twice`, { kind: "twice", name: m.name });
    seen.add(m.name);
    splitName(m.name);
    if (!Number.isSafeInteger(m.size) || m.size < 0 || m.size > MAX_MEMBER_BYTES) {
      throw new TarError(`${shown(m.name)} is too large for a tar member`, { kind: "member_too_large", name: m.name });
    }
  }
  let fd: number;
  try {
    fd = openSync(dest, "wx");
  } catch (err) {
    if (codeOf(err) === "EEXIST") throw new TarError(`${dest} already exists`, { kind: "exists", dest });
    throw new TarError(`the file could not be written: ${reasonOf(err)}`, { kind: "write", reason: reasonOf(err) });
  }
  let open = true;
  try {
    await gzipInto(fd, archiveBlocks(list));
    fsyncSync(fd);
    closeSync(fd);
    open = false;
  } catch (err) {
    if (open) closeSync(fd);
    rmSync(dest, { force: true });
    if (err instanceof Refused) throw err;
    throw new TarError(`the file could not be written: ${reasonOf(err)}`, { kind: "write", reason: reasonOf(err) });
  }
}

// ---------- reading ----------

/** The decompressed bytes, handed out in pieces; every byte handed out is counted and passed to `check` (the decompression-bomb guard). */
class Source {
  private readonly chunks: Uint8Array[] = [];
  private offset = 0;
  private have = 0;
  private eof = false;
  private consumed = 0;

  constructor(private readonly it: AsyncIterator<Uint8Array>, private readonly check: (consumed: number) => void, private readonly unreadable: () => TarError) {}

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
      if (p === null) throw this.unreadable();
      left -= p.length;
    }
  }
}

interface Header { name: string; type: string; size: number }

const strict = new TextDecoder("utf-8", { fatal: true });

/** A text field: its bytes up to the last non-NUL byte, so a NUL inside the name stays in it. Null when it is not UTF-8. */
function textField(b: Uint8Array, at: number, len: number): string | null {
  let end = at + len;
  while (end > at && b[end - 1] === 0) end--;
  try {
    return strict.decode(b.subarray(at, end));
  } catch {
    return null;
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
async function readHeader(src: Source, unreadable: () => TarError): Promise<Header | "end" | null> {
  const b = await src.exact(BLOCK);
  if (b === null) return null;
  if (b.every((x) => x === 0)) {
    const second = await src.exact(BLOCK);
    if (second === null || !second.every((x) => x === 0)) throw unreadable();
    return "end";
  }
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : b[i]!;
  if (octalValue(b, 148, 8) !== sum) throw unreadable();
  if (textField(b, 257, 6) !== "ustar" || b[262] !== 0 || b[263] !== 0x30 || b[264] !== 0x30) throw unreadable();
  const size = octalValue(b, 124, 12);
  if (size === null) throw unreadable();
  const name = textField(b, 0, 100);
  const prefix = textField(b, 345, 155);
  if (name === null || prefix === null) throw unreadable();
  return { name: prefix === "" ? name : `${prefix}/${name}`, type: String.fromCharCode(b[156]!), size };
}

function kindProblem(h: Header): TarError | null {
  if (h.type === "0") return null;
  if (h.type === "1" || h.type === "2") return new TarError(`${shown(h.name)} is a link; an archive here holds only regular files`, { kind: "link", name: h.name });
  return new TarError(`${shown(h.name)} is not a regular file`, { kind: "not_regular", name: h.name });
}

export interface TarSink { open(name: string, size: number): { write(piece: Uint8Array): void; end(): void } }

/** What a sink threw, carried out of the reader untouched. */
class FromSink {
  constructor(readonly err: unknown) {}
}

const tooLarge = (max: number): TarError => new TarError(`the archive is larger than the limit of ${max} bytes`, { kind: "too_large", max });

/**
 * Reads a gzipped ustar once. Every header is checked (checksum, kind, name, a name twice, the running total against `max`) before its
 * body is read and before `sink` is asked for the member; the bytes that come out of gzip are counted too, so a small file that inflates
 * past the limit is refused as it inflates. After the end of the archive only zero bytes may follow. `sink.open` (or a writer it returns)
 * may refuse a member by throwing; what it throws is passed on as it was thrown. Everything else is a TarError; damaged bytes are
 * `unreadable`, the caller's sentence.
 */
export async function readTarGz(file: string, opts: { max: number; sink: TarSink; unreadable: string }): Promise<void> {
  const { max, sink } = opts;
  const unreadable = (): TarError => new TarError(opts.unreadable, { kind: "unreadable" });
  const raw = createReadStream(file);
  const gz = createGunzip();
  raw.on("error", (err) => gz.destroy(err));
  raw.pipe(gz);
  let members = 0;
  // Each member adds at most a header and a block of padding to the bytes it declares; the end adds two blocks, and a little slack is left.
  const src = new Source(gz[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>, (consumed) => {
    if (consumed > max + 2 * BLOCK * (members + 2)) throw tooLarge(max);
  }, unreadable);
  const call = <T>(f: () => T): T => {
    try { return f(); } catch (err) { throw new FromSink(err); }
  };
  try {
    const seen = new Set<string>();
    let total = 0;
    for (;;) {
      const h = await readHeader(src, unreadable);
      if (h === null) throw unreadable();
      if (h === "end") break;
      const k = kindProblem(h);
      if (k !== null) throw k;
      const problem = memberProblem(h.name);
      if (problem !== null) throw new TarError(`${shown(h.name)}: ${problem}`, { kind: "bad_name", name: h.name, problem });
      if (seen.has(h.name)) throw new TarError(`${shown(h.name)} appears twice`, { kind: "twice", name: h.name });
      seen.add(h.name);
      total += h.size;
      if (total > max) throw tooLarge(max);
      members += 1;
      const w = call(() => sink.open(h.name, h.size));
      for (let left = h.size; left > 0; ) {
        const p = await src.some(Math.min(left, CHUNK));
        if (p === null) throw unreadable();
        call(() => w.write(p));
        left -= p.length;
      }
      call(() => w.end());
      await src.skip(padding(h.size));
    }
    for (let p = await src.some(CHUNK); p !== null; p = await src.some(CHUNK)) if (!p.every((x) => x === 0)) throw unreadable();
  } catch (err) {
    if (err instanceof FromSink) throw err.err;
    if (err instanceof TarError) throw err;
    if (codeOf(err) === "ENOENT") throw new TarError("there is no file there", { kind: "missing" });
    if (codeOf(err) === "EISDIR") throw new TarError("it is a folder, not a file", { kind: "folder" });
    throw unreadable();
  } finally {
    raw.unpipe(gz);
    raw.destroy();
    gz.destroy();
  }
}
