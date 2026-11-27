// The case store: a folder of case files, read from each file's case.json alone. Server-side core (like workbench.ts): never imported by
// src/web or src/core/state. Only a person or code deletes from it; no agent tool reaches this module.
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readSync, rmSync, writeSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, join, resolve } from "node:path";
import { canonical } from "./canonical";
import { CASE_FILE_NAME_FORM, CASE_ID, CaseFileError, caseFileName, parseCaseFileName, readManifest } from "./casefile";
import type { CaseManifest } from "./casefile";
import { isObj, isStr } from "./state/guards";

export interface StoredCase { file: string; bytes: number; manifest: CaseManifest }
export interface StoreListing {
  cases: StoredCase[];
  /** Files named like a case file whose case.json could not be read. */
  unreadable: { file: string; reason: string }[];
  /** Temporary files a stopped unload left. */
  leftovers: string[];
}

/** A case file's plain name: no separator, no leading dot. */
export const STORE_FILE = /^[A-Za-z0-9][A-Za-z0-9+._-]*\.tar\.gz$/;
/** A name that is meant as a case file's (CASE-…tar.gz) but is not one: listed as unreadable, and its number never counted. */
const CASE_LIKE = /^CASE-.*\.tar\.gz$/;
const BAD_NAME = `its name is not a case file's name (${CASE_FILE_NAME_FORM})`;
const LEFTOVER = /^\.tmp-.*\.part$/;
const DELETED_LOG = "deleted.log";

/** A name as it may appear in a sentence: control characters are shown as U+FFFD. */
const shown = (name: string): string => name.replace(/[\u0000-\u001f\u007f]/g, "�");
const reasonOf = (err: unknown): string => (err instanceof CaseFileError ? err.reasons[0]! : err instanceof Error ? err.message : String(err)).split("\n")[0]!;
const codeOf = (err: unknown): unknown => (isObj(err) ? err.code : undefined);

/** True when the text is in the id, the title, the question or a starting value, ignoring case. An empty text matches all. */
export function matchesSearch(m: CaseManifest, text: string): boolean {
  const t = text.toLowerCase();
  if (t === "") return true;
  return [m.id, m.title, m.asked, ...m.starting.map((o) => o.value)].some((s) => s.toLowerCase().includes(t));
}

/** Newest unload first, then by file name with `<`. */
const newestFirst = (a: StoredCase, b: StoredCase): number =>
  a.manifest.unloaded_ts > b.manifest.unloaded_ts ? -1 : a.manifest.unloaded_ts < b.manifest.unloaded_ts ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0;

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

/**
 * Opens deleted.log in a folder another party may share: never through a link (O_NOFOLLOW), never waiting on a FIFO (O_NONBLOCK), and only
 * when it is a plain file. Throws a CaseFileError otherwise; an ENOENT is thrown as it is.
 */
function openLog(path: string, flags: number): number {
  let fd: number;
  try {
    fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o644);
  } catch (err) {
    if (codeOf(err) === "ELOOP" || codeOf(err) === "ENXIO") throw new CaseFileError(`${DELETED_LOG} is not a plain file`);
    throw err;
  }
  if (!fstatSync(fd).isFile()) {
    closeSync(fd);
    throw new CaseFileError(`${DELETED_LOG} is not a plain file`);
  }
  return fd;
}

function readLog(path: string): string {
  const fd = openLog(path, constants.O_RDONLY);
  try {
    const parts: Uint8Array[] = [];
    for (;;) {
      const buf = new Uint8Array(65536);
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      parts.push(buf.subarray(0, n));
    }
    return new TextDecoder().decode(Buffer.concat(parts));
  } finally {
    closeSync(fd);
  }
}

export class CaseStoreFolder {
  readonly dir: string;
  /** The folder's last path segment: what a ledger records. */
  readonly name: string;

  constructor(dir: string) {
    this.dir = resolve(dir);
    this.name = basename(this.dir);
  }

  /** The path of a file in the store. Throws CaseFileError when `file` is not a plain case-file name. */
  path(file: string): string {
    if (!STORE_FILE.test(file)) throw new CaseFileError(`${shown(file)} is not the name of a file in the store`);
    return join(this.dir, file);
  }

  /** The folder's entries; null when it is not there. Any other failure is thrown. */
  private entries(): Dirent[] | null {
    try {
      return readdirSync(this.dir, { withFileTypes: true });
    } catch (err) {
      if (codeOf(err) === "ENOENT") return null;
      throw err;
    }
  }

  /** One file's listing entry, or why it cannot be listed. */
  private async read(file: string): Promise<StoredCase | { file: string; reason: string }> {
    const path = this.path(file);
    let bytes: number;
    try {
      const st = lstatSync(path);
      if (!st.isFile()) return { file, reason: st.isSymbolicLink() ? "it is a link, not a case file" : "it is not a file" };
      bytes = st.size;
    } catch (err) {
      if (codeOf(err) === "ENOENT") throw new CaseFileError(`the store holds no file ${file}`);
      return { file, reason: reasonOf(err) };
    }
    let manifest: CaseManifest;
    try {
      manifest = await readManifest(path);
    } catch (err) {
      return { file, reason: reasonOf(err) };
    }
    if (caseFileName(manifest.id, manifest.marking) !== file) return { file, reason: `its name does not match its case.json (${manifest.id}, ${manifest.marking})` };
    return { file, bytes, manifest };
  }

  /** Every case file, from its case.json alone, newest unload first (then by file name with `<`). A store that is not there lists nothing. */
  async list(search?: string): Promise<StoreListing> {
    const listing: StoreListing = { cases: [], unreadable: [], leftovers: [] };
    let entries: Dirent[] | null;
    try {
      entries = this.entries();
    } catch (err) {
      throw new CaseFileError(`the store ${this.dir} cannot be read: ${reasonOf(err)}`);
    }
    if (entries === null) return listing;
    const names = entries.filter((e) => !e.isDirectory()).map((e) => e.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      if (LEFTOVER.test(name)) { listing.leftovers.push(name); continue; }
      if (!STORE_FILE.test(name)) continue;
      if (parseCaseFileName(name) === null) {
        if (CASE_LIKE.test(name)) listing.unreadable.push({ file: name, reason: BAD_NAME });
        continue;
      }
      let got: StoredCase | { file: string; reason: string };
      try {
        got = await this.read(name);
      } catch (err) {
        if (err instanceof CaseFileError) continue; // gone between readdir and read
        throw err;
      }
      if ("manifest" in got) {
        if (search === undefined || matchesSearch(got.manifest, search)) listing.cases.push(got);
      } else listing.unreadable.push(got);
    }
    listing.cases.sort(newestFirst);
    return listing;
  }

  /** The one file for a case id or a file name. Throws CaseFileError when there is none ("the store holds no file for CASE-9") or more than one. */
  async find(idOrFile: string): Promise<StoredCase> {
    if (CASE_ID.test(idOrFile)) {
      const found = (await this.list()).cases.filter((c) => c.manifest.id === idOrFile);
      if (found.length === 0) throw new CaseFileError(`the store holds no file for ${idOrFile}`);
      if (found.length > 1) {
        const files = found.map((c) => c.file).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        throw new CaseFileError(`the store holds more than one file for ${idOrFile}: ${files.join(", ")}`);
      }
      return found[0]!;
    }
    if (!STORE_FILE.test(idOrFile)) throw new CaseFileError(`${shown(idOrFile)} is not a case id or the name of a file in the store`);
    const got = await this.read(idOrFile);
    if (!("manifest" in got)) throw new CaseFileError(`${got.file}: ${got.reason}`);
    return got;
  }

  /**
   * The numbers in the names of the store's case files and in deleted.log. Reads names only; [] when the store cannot be read (the error goes
   * to `onError`). A name or an id that is not CASE- and one to nine digits is not counted, and is reported to `onError` as a CaseFileError.
   */
  seenNumbers(onError?: (error: unknown) => void): number[] {
    let entries: Dirent[] | null;
    try {
      entries = this.entries();
    } catch (err) {
      onError?.(err);
      return [];
    }
    if (entries === null) return [];
    const seen = new Set<number>();
    for (const e of entries) {
      const parsed = parseCaseFileName(e.name);
      if (parsed !== null) seen.add(Number(parsed.id.slice(5)));
      else if (CASE_LIKE.test(e.name)) onError?.(new CaseFileError(`the case store holds ${shown(e.name)}, which is not a case file's name (${CASE_FILE_NAME_FORM}); its number is not counted`));
    }
    let log: string | null = null;
    try {
      log = readLog(join(this.dir, DELETED_LOG));
    } catch (err) {
      if (err instanceof CaseFileError) onError?.(new CaseFileError(`the case store's ${reasonOf(err)}; its ids are not counted`));
      else if (codeOf(err) !== "ENOENT") onError?.(err);
    }
    for (const line of log === null ? [] : log.split("\n")) {
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObj(rec) || !isStr(rec.id)) continue;
      if (CASE_ID.test(rec.id)) seen.add(Number(rec.id.slice(5)));
      else onError?.(new CaseFileError(`the case store's ${DELETED_LOG} names ${shown(rec.id.slice(0, 40))}, which is not a case id; it is not counted`));
    }
    return [...seen];
  }

  /** Removes a file after appending its line to deleted.log. `typed` must be the id in its case.json. Throws CaseFileError and changes nothing otherwise. */
  async delete(file: string, typed: string, who: string, when: string): Promise<void> {
    const got = await this.read(file);
    if (!("manifest" in got)) throw new CaseFileError(`${got.file}: ${got.reason}`);
    const m = got.manifest;
    if (typed !== m.id) throw new CaseFileError(`type ${m.id} to delete its file`);
    const line = canonical({ id: m.id, title: m.title, head: m.head.hash, when, who, file }) + "\n";
    try {
      const fd = openLog(join(this.dir, DELETED_LOG), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
      try {
        const bytes = new TextEncoder().encode(line);
        for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      throw new CaseFileError(`the deletion could not be recorded in ${DELETED_LOG}: ${reasonOf(err)}`);
    }
    syncDir(this.dir);
    try {
      rmSync(this.path(file));
    } catch (err) {
      throw new CaseFileError(`${file} could not be removed: ${reasonOf(err)}`);
    }
    syncDir(this.dir);
  }
}
