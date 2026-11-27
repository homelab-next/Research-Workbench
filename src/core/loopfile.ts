// The loop file: a loop's manifests packed as a ustar archive inside gzip, loop.json first. Server-side core (like casefile.ts): never
// imported by src/web or src/core/state. It knows tar and loop.json and nothing of the registry. A loop file is untrusted input: the reader
// checks every member's kind, name, size and hash against loop.json, and writes nothing itself.
import { closeSync, fsyncSync, linkSync, openSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonical } from "./canonical";
import type { Json } from "./canonical";
import { WORKBENCH_VERSION } from "./casefile";
import { sha256Hex } from "./hash";
import { Refused } from "./refused";
import { isNum, isObj, isStr } from "./state/guards";
import { readTarGz, shown, TarError, writeTarGz } from "./tar";
import type { TarMember, TarSink } from "./tar";

export const LOOP_FILE_FORMAT = 1;
/** The most a loop file may hold, unpacked: loop.json and every member together. */
export const MAX_LOOP_FILE_BYTES = 16777216;

/** A loop file that cannot be made, read or trusted. The message says why, in words a person can act on. */
export class LoopFileError extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "LoopFileError";
  }
}

export interface LoopFileEntry { path: string; kind: string; id: string; sha256: string; bytes: number; origin: string | null }
export interface LoopFileManifest {
  format: 1; workbench: string; loop: string; version: number; title: string; about: string; hash: string; legacy_hash: string | null;
  lock: Json; subloops: Json[]; files: LoopFileEntry[];
}

const MANIFEST_NAME = "loop.json";
const PREFIX = "manifests/";
const HASH = /^[0-9a-f]{64}$/;
/** A loop id that may name a file and a folder: no separator, no leading dot. */
const LOOP_ID = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const FILE_NAME = /^([A-Za-z0-9_][A-Za-z0-9._-]*)\.v([1-9][0-9]{0,8})\.([0-9a-f]{12})\.loop\.tar\.gz$/;
const UNREADABLE = "the file is not a readable loop file";
const NOT_A_MANIFEST = "loop.json is not a loop file manifest of format 1";
const enc = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;

/** "triage", 3, "ab…" → "triage.v3.abababababab.loop.tar.gz". */
export function loopFileName(loop: string, version: number, hash: string): string {
  return `${loop}.v${version}.${hash.slice(0, 12)}.loop.tar.gz`;
}

/** The loop, version and 12 hex of a loop file's name; null when it is not one. */
export function parseLoopFileName(name: string): { loop: string; version: number; hash12: string } | null {
  const m = FILE_NAME.exec(name);
  return m === null ? null : { loop: m[1]!, version: Number(m[2]!), hash12: m[3]! };
}

/** Why a path may not be a member of a loop file, in the loop file's words; null when it may. */
function nameProblem(name: string): string | null {
  if (name === "") return "an empty name";
  if (name.includes("\0")) return "a NUL in a path";
  if (name.includes("\\")) return "a backslash in a path";
  if (name.startsWith("/")) return "an absolute path";
  const segments = name.split("/");
  if (segments.some((s) => s === "." || s === "..")) return "a path that leaves the loop file";
  if (segments.some((s) => s === "")) return "an empty path segment";
  return null;
}

const isCount = (x: unknown, min: number): x is number => isNum(x) && Number.isSafeInteger(x) && x >= min;
const isHash = (x: unknown): x is string => isStr(x) && HASH.test(x);
const isEntry = (x: unknown): x is LoopFileEntry =>
  isObj(x) && isStr(x.path) && nameProblem(x.path) === null && isStr(x.kind) && x.kind !== "" && isStr(x.id) && x.id !== ""
  && isHash(x.sha256) && isCount(x.bytes, 0) && (x.origin === null || isHash(x.origin));

/** Why `x` is not a loop file manifest: the sentence to refuse it with; null when it is one. */
function manifestProblem(x: unknown): string | null {
  if (!isObj(x) || x.format !== LOOP_FILE_FORMAT || !isStr(x.workbench) || !isStr(x.loop) || !LOOP_ID.test(x.loop) || !isCount(x.version, 1)
    || !isStr(x.title) || !isStr(x.about) || !isHash(x.hash) || !(x.legacy_hash === null || isHash(x.legacy_hash))
    || !isObj(x.lock) || !Array.isArray(x.subloops) || !x.subloops.every(isObj) || !Array.isArray(x.files) || !x.files.every(isEntry)) {
    return NOT_A_MANIFEST;
  }
  const paths = new Set<string>();
  for (const f of x.files as LoopFileEntry[]) {
    if (paths.has(f.path)) return `${shown(f.path)} is listed twice in loop.json`;
    paths.add(f.path);
  }
  for (const p of paths) {
    for (let cut = p.indexOf("/"); cut !== -1; cut = p.indexOf("/", cut + 1)) {
      if (paths.has(p.slice(0, cut))) return `${shown(p.slice(0, cut))} is listed in loop.json as a file and as a folder`;
    }
  }
  return null;
}

/** A TarError said in the loop file's words. */
function loopError(err: TarError): LoopFileError {
  const p = err.problem;
  switch (p.kind) {
    case "unreadable": return new LoopFileError(UNREADABLE);
    case "missing": return new LoopFileError("there is no loop file there");
    case "folder": return new LoopFileError("it is a folder, not a loop file");
    case "too_large": return new LoopFileError(`the loop file is larger than the limit of ${p.max} bytes unpacked`);
    case "link": return new LoopFileError(`${shown(p.name)} is a link; a loop file holds only regular files`);
    case "not_regular": return new LoopFileError(`${shown(p.name)} is not a regular file; a loop file holds only regular files`);
    case "bad_name": return new LoopFileError(`${shown(p.name)}: ${nameProblem(p.name) ?? p.problem}`);
    case "twice": return new LoopFileError(`${shown(p.name)} appears twice in the loop file`);
    case "long_name": return new LoopFileError(`${shown(p.name)} is too long a path for a loop file`);
    case "member_too_large": return new LoopFileError(`${shown(p.name)} is too large for a loop file`);
    case "wrong_size": return new LoopFileError(`${shown(p.name)} changed while the loop file was written`);
    case "exists": return new LoopFileError(`${basename(p.dest)} already exists`);
    case "write": return new LoopFileError(`the loop file could not be written: ${p.reason}`);
  }
}

// ---------- writing ----------

/** Writes loop.json first, then each file under manifests/, to a temporary name beside `dest`, fsyncs and renames. */
export async function writeLoopFile(
  dest: string,
  header: Omit<LoopFileManifest, "format" | "workbench" | "files">,
  files: { path: string; kind: string; id: string; bytes: Uint8Array; origin: string | null }[],
): Promise<LoopFileManifest> {
  const sorted = [...files].sort((a, b) => lt(a.path, b.path));
  const manifest: LoopFileManifest = {
    format: LOOP_FILE_FORMAT, workbench: WORKBENCH_VERSION, loop: header.loop, version: header.version, title: header.title, about: header.about,
    hash: header.hash, legacy_hash: header.legacy_hash, lock: header.lock, subloops: header.subloops,
    files: sorted.map((f) => ({ path: f.path, kind: f.kind, id: f.id, sha256: sha256Hex(f.bytes), bytes: f.bytes.length, origin: f.origin })),
  };
  const problem = manifestProblem(JSON.parse(JSON.stringify(manifest)));
  if (problem !== null) throw new LoopFileError(problem === NOT_A_MANIFEST ? "the loop's details do not make a loop file manifest" : problem);
  const text = canonical(manifest as unknown as Json);
  const json = enc.encode(text);
  if (sorted.reduce((n, f) => n + f.bytes.length, json.length) > MAX_LOOP_FILE_BYTES) {
    throw new LoopFileError(`the loop file is larger than the limit of ${MAX_LOOP_FILE_BYTES} bytes unpacked`);
  }
  const members: TarMember[] = [
    { name: MANIFEST_NAME, size: json.length, open: () => [json] },
    ...sorted.map((f): TarMember => ({ name: PREFIX + f.path, size: f.bytes.length, open: () => [f.bytes] })),
  ];
  // a name of its own beside dest, so a stop leaves no half-written file under dest's name
  const tmp = join(dirname(dest), `.${basename(dest)}.${crypto.randomUUID()}.partial`);
  try {
    await writeTarGz(tmp, members);
  } catch (err) {
    throw err instanceof TarError ? loopError(err) : err instanceof LoopFileError ? err : new LoopFileError(`the loop file could not be written: ${reasonOf(err)}`);
  }
  try {
    // a link, not a rename: it does not write over a file already at dest
    linkSync(tmp, dest);
  } catch (err) {
    throw (err as { code?: unknown }).code === "EEXIST" ? new LoopFileError(`${basename(dest)} already exists`) : new LoopFileError(`the loop file could not be written: ${reasonOf(err)}`);
  } finally {
    rmSync(tmp, { force: true });
  }
  try {
    const fd = openSync(dirname(dest), "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // a folder that cannot be flushed: the file itself was flushed before it was linked
  }
  return JSON.parse(text) as LoopFileManifest;
}

// ---------- reading ----------

/** What a caller's `each` threw, carried out of the reader untouched. */
class FromEach {
  constructor(readonly err: unknown) {}
}

/**
 * The one reader, through readTarGz: the tar code checks every header (kind, name, a name twice, the running total against 16 MiB) before
 * its body is read; then here, loop.json first, every other member under manifests/, listed, of the listed size, and of the listed hash.
 * `each` is handed a member's bytes only once they are checked. Writes nothing.
 */
async function readArchive(file: string, each: ((entry: LoopFileEntry, bytes: Uint8Array) => void) | null): Promise<LoopFileManifest> {
  let manifest: LoopFileManifest | null = null;
  let listed = new Map<string, LoopFileEntry>();
  const seen = new Set<string>();
  const sink: TarSink = {
    open(name, size) {
      if (manifest === null) {
        if (name !== MANIFEST_NAME) throw new LoopFileError("loop.json is not the first member");
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
              throw new LoopFileError(NOT_A_MANIFEST);
            }
            const problem = manifestProblem(parsed);
            if (problem !== null) throw new LoopFileError(problem);
            manifest = parsed as LoopFileManifest;
            listed = new Map(manifest.files.map((f) => [f.path, f]));
          },
        };
      }
      if (!name.startsWith(PREFIX)) throw new LoopFileError(`${shown(name)} is outside manifests/`);
      const entry = listed.get(name.slice(PREFIX.length));
      if (entry === undefined) throw new LoopFileError(`${shown(name)} is not listed in loop.json`);
      if (size !== entry.bytes) throw new LoopFileError(`${shown(name)} is not the size loop.json lists`);
      seen.add(entry.path);
      const pieces: Uint8Array[] = [];
      return {
        write: (p) => void pieces.push(p.slice()),
        end: () => {
          const bytes = new Uint8Array(size);
          let at = 0;
          for (const p of pieces) { bytes.set(p, at); at += p.length; }
          if (sha256Hex(bytes) !== entry.sha256) throw new LoopFileError(`${shown(name)} is not what loop.json lists`);
          if (each !== null) {
            try { each(entry, bytes); } catch (err) { throw new FromEach(err); }
          }
        },
      };
    },
  };
  try {
    await readTarGz(file, { max: MAX_LOOP_FILE_BYTES, sink, unreadable: UNREADABLE });
  } catch (err) {
    if (err instanceof FromEach) throw err.err;
    if (err instanceof LoopFileError) throw err;
    if (err instanceof TarError) throw loopError(err);
    throw new LoopFileError(UNREADABLE);
  }
  const found = manifest as LoopFileManifest | null;
  if (found === null) throw new LoopFileError("loop.json is not the first member");
  for (const f of found.files) if (!seen.has(f.path)) throw new LoopFileError(`${shown(f.path)} is listed in loop.json and is not in the file`);
  return found;
}

/** Reads the file once and writes nothing. Throws LoopFileError for everything "A loop file" lists. */
export async function checkLoopFile(file: string): Promise<LoopFileManifest> {
  return readArchive(file, null);
}

/** The same reader; hands each checked member's bytes to `each`. What `each` throws is passed on as it was thrown. */
export async function readLoopFile(file: string, each: (entry: LoopFileEntry, bytes: Uint8Array) => void): Promise<LoopFileManifest> {
  return readArchive(file, each);
}
