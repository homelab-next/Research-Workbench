// The loop file: a loop's manifests packed as a ustar archive inside gzip, loop.json first, every other member under manifests/. Server-side core
// (like casefile.ts): never imported by src/web or src/core/state. It knows loop.json and nothing of the registry. A loop file is untrusted input.
// The packer and the reader are packfile.ts's, the same as a case file's and a memory file's, so every refusal made there is made for a loop file
// too: this file holds only the manifest, its rule for its list of files, and the words, which are the loop file's own.
import { closeSync, fsyncSync, linkSync, openSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { canonical } from "./canonical";
import type { Json } from "./canonical";
import { WORKBENCH_VERSION } from "./casefile";
import { sha256Hex } from "./hash";
import { intoMemory, readPackFile, writePackMembers } from "./packfile";
import type { PackEntry, PackKind } from "./packfile";
import { Refused } from "./refused";
import { isNum, isObj, isStr } from "./state/guards";
import { shown } from "./tar";
import type { TarProblem } from "./tar";

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

/** Whether `x` has the shape of a loop file manifest of format 1 (its list of files is filesProblem's to judge). */
const isLoopManifest = (x: unknown): x is LoopFileManifest =>
  isObj(x) && x.format === LOOP_FILE_FORMAT && isStr(x.workbench) && isStr(x.loop) && LOOP_ID.test(x.loop) && isCount(x.version, 1)
  && isStr(x.title) && isStr(x.about) && isHash(x.hash) && (x.legacy_hash === null || isHash(x.legacy_hash))
  && isObj(x.lock) && Array.isArray(x.subloops) && x.subloops.every(isObj) && Array.isArray(x.files) && x.files.every(isEntry);

/** Why a loop file's list of files is not one: no path twice, no path the folder of another. The sentence, or null. */
function filesProblem(files: readonly PackEntry[]): string | null {
  const paths = new Set<string>();
  for (const f of files) {
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

/** Why `x` is not a loop file manifest: the sentence to refuse it with; null when it is one. */
function manifestProblem(x: unknown): string | null {
  return isLoopManifest(x) ? filesProblem(x.files) : NOT_A_MANIFEST;
}

/** A tar problem said in the loop file's words. */
function say(p: TarProblem): string {
  switch (p.kind) {
    case "unreadable": return UNREADABLE;
    case "missing": return "there is no loop file there";
    case "folder": return "it is a folder, not a loop file";
    case "too_large": return `the loop file is larger than the limit of ${p.max} bytes unpacked`;
    case "link": return `${shown(p.name)} is a link; a loop file holds only regular files`;
    case "not_regular": return `${shown(p.name)} is not a regular file; a loop file holds only regular files`;
    case "bad_name": return `${shown(p.name)}: ${nameProblem(p.name) ?? p.problem}`;
    case "twice": return `${shown(p.name)} appears twice in the loop file`;
    case "long_name": return `${shown(p.name)} is too long a path for a loop file`;
    case "member_too_large": return `${shown(p.name)} is too large for a loop file`;
    case "wrong_size": return `${shown(p.name)} changed while the loop file was written`;
    case "exists": return `${basename(p.dest)} already exists`;
    case "write": return `the loop file could not be written: ${p.reason}`;
  }
}

/** The loop file as packfile.ts packs and reads it. */
const LOOP_KIND: PackKind<LoopFileManifest> = {
  manifest: MANIFEST_NAME, manifest_max: MAX_LOOP_FILE_BYTES, prefix: PREFIX, isManifest: isLoopManifest,
  filesProblem: (files) => filesProblem(files), pathProblem: nameProblem, say, error: LoopFileError,
  words: {
    file: "a loop file", manifest: "loop file", whole: "the loop file", packed: "the loop", written: "the loop", folder: "the loop file",
    journal: "the loop file holds a ledger journal", not_manifest: NOT_A_MANIFEST,
  },
};

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
  const json = enc.encode(canonical(manifest as unknown as Json));
  if (sorted.reduce((n, f) => n + f.bytes.length, json.length) > MAX_LOOP_FILE_BYTES) {
    throw new LoopFileError(`the loop file is larger than the limit of ${MAX_LOOP_FILE_BYTES} bytes unpacked`);
  }
  const bytesOf = new Map(sorted.map((f) => [f.path, f.bytes]));
  // a name of its own beside dest, so a stop leaves no half-written file under dest's name
  const tmp = join(dirname(dest), `.${basename(dest)}.${crypto.randomUUID()}.partial`);
  const written = await writePackMembers(LOOP_KIND, tmp, manifest, (f) => [bytesOf.get(f.path)!], "the loop's details do not make a loop file manifest");
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
  return written;
}

// ---------- reading ----------

/** Reads the file once and writes nothing: packfile.ts's reader, in the loop file's words. Throws LoopFileError for everything "A loop file" lists. */
export async function checkLoopFile(file: string): Promise<LoopFileManifest> {
  return readPackFile(LOOP_KIND, file, { max: MAX_LOOP_FILE_BYTES });
}

/** The same reader; hands each member's bytes to `each` once its size and hash are checked. What `each` throws is passed on as it was thrown. */
export async function readLoopFile(file: string, each: (entry: LoopFileEntry, bytes: Uint8Array) => void): Promise<LoopFileManifest> {
  return readPackFile(LOOP_KIND, file, { max: MAX_LOOP_FILE_BYTES, out: intoMemory((_path, bytes, entry) => each(entry as LoopFileEntry, bytes)) });
}
