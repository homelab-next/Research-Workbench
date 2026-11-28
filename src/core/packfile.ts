// The one packer and the one reader of a folder (or of members given as bytes) packed as a ustar archive inside gzip, its manifest first: a case
// file (casefile.ts), a memory file (memfile.ts) and a loop file (loopfile.ts) are each only a manifest and the words to say it in. Security code
// must not fork: every refusal here is made for every kind. A file is untrusted input: the reader writes nothing it has not checked against the
// manifest, and a member's name, size and hash are checked before it is kept. Server-side core: never imported by src/web or src/core/state.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { canonical } from "./canonical";
import type { Json } from "./canonical";
import type { Refused } from "./refused";
import { isNum, isObj, isStr } from "./state/guards";
import { CHUNK, memberProblem, readTarGz, shown, TarError, writeAll, writeTarGz } from "./tar";
import type { TarMember, TarProblem, TarSink } from "./tar";

/** A member of a packed folder as its manifest lists it. */
export interface PackEntry { path: string; sha256: string; bytes: number }

/** What a SQLite ledger leaves beside itself while a write is unfinished: never packed, and a file that lists one is refused. */
export const JOURNALS = ["ledger.sqlite-journal", "ledger.sqlite-wal", "ledger.sqlite-shm"];

/** One kind of packed folder: its manifest, the rule its paths keep, and the words its refusals are said in. */
export interface PackKind<M extends { files: PackEntry[] }> {
  /** The first member, e.g. "case.json". */
  manifest: string;
  /** The largest manifest read into memory to be parsed. */
  manifest_max: number;
  /** Whether a parsed manifest is one of this kind; it must hold `files` well formed (packFilesWellFormed). */
  isManifest(x: unknown): x is M;
  /** Why a path of the folder is not one this kind holds (a full sentence), or null. The manifest's name, a journal and memberProblem are refused for every kind. */
  pathProblem(path: string): string | null;
  /** The folder every member but the manifest is under inside the archive ("manifests/" for a loop file); absent: none. */
  prefix?: string;
  /** The kind's own rule for its list of files, in place of packFilesWellFormed: the refusal, or null. */
  filesProblem?(files: readonly PackEntry[]): string | null;
  /** The kind's own sentence for a tar problem; null (or absent): the shared sentence. */
  say?(problem: TarProblem): string | null;
  /** The kind's refusal. */
  error: new (message: string) => Refused;
  words: {
    /** "a case file", "a memory file". */
    file: string;
    /** "case", "memory": "case.json is not a case manifest". */
    manifest: string;
    /** What is larger than the limit: "the case", "the memory file". */
    whole: string;
    /** What was packed: "the case", "the store". */
    packed: string;
    /** What an extraction writes: "the case", "the memory store". */
    written: string;
    /** The folder a path must stay in: "the case folder", "the store's folder". */
    folder: string;
    /** The refusal of a folder with a journal beside its ledger. */
    journal: string;
    /** The refusal of a first member that is not a manifest of the kind; absent: "case.json is not a case manifest". */
    not_manifest?: string;
  };
}

const HASH = /^[0-9a-f]{64}$/;
const strict = new TextDecoder("utf-8", { fatal: true });
const enc = new TextEncoder();
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
const codeOf = (err: unknown): unknown => (isObj(err) ? err.code : undefined);
const sha256 = (): Bun.CryptoHasher => new Bun.CryptoHasher("sha256");
const isCount = (x: unknown, min: number): x is number => isNum(x) && Number.isSafeInteger(x) && x >= min;

/** A listed member of a kind: a path the tar reader takes, not the manifest, not a journal, that the kind holds; a hash; a size. */
export const isPackEntry = (x: unknown, kind: Pick<PackKind<never>, "manifest" | "pathProblem">): x is PackEntry =>
  isObj(x) && isStr(x.path) && memberProblem(x.path) === null && x.path !== kind.manifest && !JOURNALS.includes(x.path) && kind.pathProblem(x.path) === null
  && isStr(x.sha256) && HASH.test(x.sha256) && isCount(x.bytes, 0);

/** Sorted with `<`, no path twice, and no path is the folder of another. */
export function packFilesWellFormed(files: readonly PackEntry[]): boolean {
  const paths = new Set(files.map((f) => f.path));
  for (let i = 0; i < files.length; i++) {
    const p = files[i]!.path;
    if (i > 0 && !(files[i - 1]!.path < p)) return false;
    for (let cut = p.indexOf("/"); cut !== -1; cut = p.indexOf("/", cut + 1)) if (paths.has(p.slice(0, cut))) return false;
  }
  return true;
}

/** The kind's refusal of a list of files, or null. */
const filesProblemOf = <M extends { files: PackEntry[] }>(kind: PackKind<M>, files: readonly PackEntry[], notManifest: string): string | null =>
  kind.filesProblem !== undefined ? kind.filesProblem(files) : packFilesWellFormed(files) ? null : notManifest;

/** A TarError said in the kind's words. */
function tarError<M extends { files: PackEntry[] }>(kind: PackKind<M>, err: TarError): Refused {
  const p = err.problem;
  const said = kind.say?.(p) ?? null;
  if (said !== null) return new kind.error(said);
  const { file } = kind.words;
  switch (p.kind) {
    case "link": return new kind.error(`${shown(p.name)} is a link; ${file} holds only regular files`);
    case "too_large": return new kind.error(`${kind.words.whole} is larger than the limit of ${p.max} bytes`);
    case "folder": return new kind.error(`it is a folder, not ${file}`);
    case "long_name": return new kind.error(`${shown(p.name)} is too long a path for ${file}`);
    case "member_too_large": return new kind.error(`${shown(p.name)} is too large for ${file}`);
    case "write": return new kind.error(`${kind.words.file.replace(/^a /, "the ")} could not be written: ${p.reason}`);
    default: return new kind.error(err.message);
  }
}

// ---------- the folder ----------

/** Opens a regular file without following a link in its last segment. */
function openRegular<M extends { files: PackEntry[] }>(kind: PackKind<M>, path: string, rel: string): { fd: number; size: number } {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (codeOf(err) === "ELOOP") throw new kind.error(`${shown(rel)} is a link; ${kind.words.file} holds only regular files`);
    throw new kind.error(`${shown(rel)} could not be read: ${reasonOf(err)}`);
  }
  const st = fstatSync(fd);
  if (!st.isFile()) {
    closeSync(fd);
    throw new kind.error(`${shown(rel)} is not a regular file; ${kind.words.file} holds only regular files`);
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

/** Every regular file under `dir`, hashed and sorted. A journal beside the ledger, a link, a special file, or a path the kind does not hold is refused. */
export function listPackFolder<M extends { files: PackEntry[] }>(kind: PackKind<M>, dir: string): PackEntry[] {
  for (const journal of JOURNALS) {
    let found = false;
    try { lstatSync(join(dir, journal)); found = true; } catch { /* absent, as it should be */ }
    if (found) throw new kind.error(kind.words.journal);
  }
  const out: PackEntry[] = [];
  const walk = (rel: string): void => {
    for (const n of readdirSync(rel === "" ? dir : join(dir, rel)).sort(lt)) {
      const r = rel === "" ? n : `${rel}/${n}`;
      const st = lstatSync(join(dir, r));
      if (st.isSymbolicLink()) throw new kind.error(`${shown(r)} is a link; ${kind.words.file} holds only regular files`);
      if (st.isDirectory()) { walk(r); continue; }
      if (!st.isFile()) throw new kind.error(`${shown(r)} is not a regular file; ${kind.words.file} holds only regular files`);
      if (r === kind.manifest) throw new kind.error(`${kind.words.folder} holds a file named ${kind.manifest}; ${kind.words.file} writes its own`);
      const problem = memberProblem(r);
      if (problem !== null) throw new kind.error(`${shown(r)}: ${problem}`);
      const held = kind.pathProblem(r);
      if (held !== null) throw new kind.error(held);
      const { fd, size } = openRegular(kind, join(dir, r), r);
      try {
        const h = sha256();
        const bytes = readPieces(fd, null, (p) => h.update(p));
        if (bytes !== size) throw new kind.error(`${shown(r)} changed while ${kind.words.packed} was packed`);
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
function* filePieces<M extends { files: PackEntry[] }>(kind: PackKind<M>, dir: string, f: PackEntry): Generator<Uint8Array> {
  const { fd, size } = openRegular(kind, join(dir, f.path), f.path);
  const changed = (): Refused => new kind.error(`${shown(f.path)} changed while ${kind.words.packed} was packed`);
  try {
    if (size !== f.bytes) throw changed();
    const h = sha256();
    const pieces: Uint8Array[] = [];
    let read = 0;
    // read a piece at a time and hand it on before the next is read
    for (;;) {
      pieces.length = 0;
      const n = readPieces(fd, Math.min(CHUNK, f.bytes - read), (p) => { h.update(p); pieces.push(p); });
      if (n === 0) break;
      read += n;
      yield* pieces;
    }
    const extra = readPieces(fd, 1, () => {});
    if (read !== f.bytes || extra !== 0 || h.digest("hex") !== f.sha256) throw changed();
  } finally {
    closeSync(fd);
  }
}

/**
 * Packs `dir` into `dest` (created with "wx", flushed with fsync before it resolves), the manifest first. `manifestOf` is given the folder's
 * files, listed and hashed, and returns the manifest; one the kind does not take is refused with `notManifest`. Returns the manifest as read back
 * from its canonical text.
 */
export async function writePackFile<M extends { files: PackEntry[] }>(kind: PackKind<M>, dir: string, dest: string, manifestOf: (files: PackEntry[]) => M, notManifest: string): Promise<M> {
  const manifest = manifestOf(listPackFolder(kind, dir));
  return writePackMembers(kind, dest, manifest, (f) => filePieces(kind, dir, f), notManifest);
}

/**
 * Packs members given as bytes or pieces (not a folder) into `dest` (created with "wx", flushed with fsync before it resolves): the manifest
 * first, then each listed file under the kind's prefix, its pieces from `open`. A manifest the kind does not take is refused with `notManifest`,
 * a list of files it does not take with the kind's sentence. writePackFile is this over a folder. Returns the manifest as read back from its
 * canonical text.
 */
export async function writePackMembers<M extends { files: PackEntry[] }>(kind: PackKind<M>, dest: string, manifest: M, open: (f: PackEntry) => Iterable<Uint8Array>, notManifest: string): Promise<M> {
  if (!kind.isManifest(manifest)) throw new kind.error(notManifest);
  const problem = filesProblemOf(kind, manifest.files, notManifest);
  if (problem !== null) throw new kind.error(problem);
  const text = canonical(manifest as unknown as Json);
  const json = enc.encode(text);
  const prefix = kind.prefix ?? "";
  const members: TarMember[] = [
    { name: kind.manifest, size: json.length, open: () => [json] },
    ...manifest.files.map((f): TarMember => ({ name: prefix + f.path, size: f.bytes, open: () => open(f) })),
  ];
  try {
    await writeTarGz(dest, members);
  } catch (err) {
    if (err instanceof TarError) throw tarError(kind, err);
    if (err instanceof kind.error) throw err;
    throw new kind.error(`${kind.words.file.replace(/^a /, "the ")} could not be written: ${reasonOf(err)}`);
  }
  return JSON.parse(text) as M;
}

// ---------- reading ----------

export interface MemberWriter { write(piece: Uint8Array): void; end(): void }
/**
 * Where a member's bytes go as the reader reads them. `open` is given the member's name in the archive and the entry of the manifest it was
 * checked against. A writer's `end` is called only after the member's size and hash are checked, so it is never called for a member that is not
 * what the manifest lists.
 */
export interface Destination { open(name: string, entry: PackEntry): MemberWriter }

/** Thrown by the reader's sink once the manifest is read, when nothing more is wanted. */
class ManifestRead {
  constructor(readonly manifest: unknown) {}
}

/** What an intoMemory receiver threw, carried out of the reader untouched. */
class FromReceiver {
  constructor(readonly err: unknown) {}
}

/**
 * A Destination that keeps each member in memory and hands it over, whole, when it has ended (the reader has by then checked its size; its hash
 * is checked at the same end, before this one's, so `each` is called only for a member that is what the manifest lists). `path` is the path the
 * manifest lists (no prefix) and `entry` that listed entry. What `each` throws is passed on by the reader as it was thrown.
 */
export function intoMemory(each: (path: string, bytes: Uint8Array, entry: PackEntry) => void): Destination {
  return {
    open(_name, entry) {
      const pieces: Uint8Array[] = [];
      return {
        write: (p) => void pieces.push(p.slice()),
        end: () => {
          const bytes = new Uint8Array(entry.bytes);
          let at = 0;
          for (const p of pieces) { bytes.set(p, at); at += p.length; }
          try { each(entry.path, bytes, entry); } catch (err) { throw new FromReceiver(err); }
        },
      };
    },
  };
}

/**
 * The one reader of a packed file, through readTarGz. Every header is checked (checksum, kind, name, a name twice, the running total against
 * `max`) by the tar reader, then (listed in the manifest, the size it lists) here, before its body is read; every body is hashed as it passes and
 * compared with the manifest; every listed member must be present. The manifest is the first member, the kind's, and lists no journal. The bytes
 * that come out of gzip are counted too, so a small file that inflates past the limit is refused as it inflates.
 */
export async function readPackFile<M extends { files: PackEntry[] }>(kind: PackKind<M>, file: string, opts: { max: number; manifestOnly?: boolean; out?: Destination }): Promise<M> {
  const { out } = opts;
  const name0 = kind.manifest;
  const notManifest = kind.words.not_manifest ?? `${name0} is not a ${kind.words.manifest} manifest`;
  const unreadable = `the file is not a readable ${kind.words.file.replace(/^an? /, "")}`;
  let manifest: M | null = null;
  let listed = new Map<string, PackEntry>();
  const seen = new Set<string>();
  const sink: TarSink = {
    open(name, size) {
      if (manifest === null) {
        if (name !== name0) throw new kind.error(`${name0} is not the first member`);
        if (size > kind.manifest_max) throw new kind.error(notManifest);
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
              throw new kind.error(notManifest);
            }
            // the writer never packs a journal (it refuses a folder that has one); one in a file would be applied to the ledger when it is opened
            const journal = isObj(parsed) && Array.isArray(parsed.files) ? parsed.files.find((f) => isObj(f) && isStr(f.path) && JOURNALS.includes(f.path)) : undefined;
            if (journal !== undefined) throw new kind.error(`${kind.words.file.replace(/^a /, "the ")} holds ${(journal as PackEntry).path}, a ledger journal; ${kind.words.file} holds none`);
            if (!kind.isManifest(parsed)) throw new kind.error(notManifest);
            const problem = filesProblemOf(kind, parsed.files, notManifest);
            if (problem !== null) throw new kind.error(problem);
            manifest = parsed;
            listed = new Map(parsed.files.map((f) => [f.path, f]));
            if (opts.manifestOnly === true) throw new ManifestRead(parsed);
          },
        };
      }
      const prefix = kind.prefix ?? "";
      if (!name.startsWith(prefix)) throw new kind.error(`${shown(name)} is outside ${prefix}`);
      const path = name.slice(prefix.length);
      seen.add(path);
      const entry = listed.get(path);
      if (entry === undefined) throw new kind.error(`${shown(name)} is not listed in ${name0}`);
      if (size !== entry.bytes) throw new kind.error(`${shown(name)} is not the size ${name0} lists`);
      const hasher = sha256();
      const w = out?.open(name, entry);
      return {
        write: (p) => { hasher.update(p); w?.write(p); },
        end: () => {
          // the hash first: a destination's end (an extraction's flush, a receiver's bytes) is reached only by a member that is what is listed
          if (hasher.digest("hex") !== entry.sha256) throw new kind.error(`${shown(name)} is not what ${name0} lists`);
          w?.end();
        },
      };
    },
  };
  try {
    await readTarGz(file, { max: opts.max, sink, unreadable });
  } catch (err) {
    if (err instanceof ManifestRead) return err.manifest as M;
    if (err instanceof FromReceiver) throw err.err;
    if (err instanceof kind.error) throw err;
    if (err instanceof TarError) throw tarError(kind, err);
    throw new kind.error(unreadable);
  }
  const found = manifest as M | null;
  if (found === null) throw new kind.error(`${name0} is not the first member`);
  for (const f of found.files) if (!seen.has(f.path)) throw new kind.error(`${shown(f.path)} is listed in ${name0} and is not in the file`);
  return found;
}

/** Writes members under `root`, a folder this call made: each opened "wx" at a path checked to be inside `root`, flushed before it is closed. */
class Extraction<M extends { files: PackEntry[] }> implements Destination {
  private fd: number | null = null;
  constructor(private readonly kind: PackKind<M>, private readonly root: string) {}

  private failed(err: unknown): Refused {
    return new this.kind.error(`${this.kind.words.written} could not be written: ${reasonOf(err)}`);
  }

  open(name: string): MemberWriter {
    const target = resolve(this.root, name);
    if (!target.startsWith(this.root + sep)) throw new this.kind.error(`${shown(name)}: a path that leaves ${this.kind.words.folder}`);
    try {
      mkdirSync(dirname(target), { recursive: true });
      this.fd = openSync(target, "wx");
    } catch (err) {
      throw this.failed(err);
    }
    const fd = this.fd;
    return {
      write: (piece) => {
        try { writeAll(fd, piece); } catch (err) { throw this.failed(err); }
      },
      end: () => {
        try { fsyncSync(fd); } catch (err) { throw this.failed(err); }
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

/** readPackFile, writing each member under `destDir` (which must not exist). On any failure `destDir` is removed. */
export async function extractPackFile<M extends { files: PackEntry[] }>(kind: PackKind<M>, file: string, destDir: string, max: number): Promise<M> {
  const root = resolve(destDir);
  try {
    mkdirSync(root);
  } catch (err) {
    throw new kind.error(codeOf(err) === "EEXIST" ? `${destDir} already exists` : `${kind.words.written} could not be written: ${reasonOf(err)}`);
  }
  const out = new Extraction(kind, root);
  try {
    return await readPackFile(kind, file, { max, out });
  } catch (err) {
    out.abort();
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
}
