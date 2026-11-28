// The case file: one case folder packed as a ustar archive inside gzip, case.json first. Server-side core (like workbench.ts): never imported by
// src/web or src/core/state. A case file is untrusted input; the reader writes nothing it has not checked against case.json. The packer and the
// reader are packfile.ts's, shared with the memory file: this file holds only the manifest and its words.
import { extractPackFile, isPackEntry, listPackFolder, packFilesWellFormed, readPackFile, writePackFile } from "./packfile";
import type { Destination, PackKind } from "./packfile";
import { Refused } from "./refused";
import { isNum, isObj, isStr } from "./state/guards";
import { memberProblem } from "./tar";
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
const isFileEntry = (x: unknown): x is CaseFileEntry => isPackEntry(x, { manifest: MANIFEST_NAME, pathProblem: () => null });

export const isCaseManifest = (x: unknown): x is CaseManifest =>
  isObj(x) && x.format === CASE_FILE_FORMAT && isStr(x.id) && CASE_ID.test(x.id) && isStr(x.chain) && CASE_ID.test(x.chain) && isHash(x.origin)
  && isStr(x.title) && isStr(x.asked) && isMarking(x.marking) && Array.isArray(x.starting) && x.starting.every(isObservable)
  && isStr(x.status) && (x.outcome === null || x.outcome === "published" || x.outcome === "completed" || x.outcome === "stopped")
  && Array.isArray(x.published) && x.published.every((p) => isObj(p) && isCount(p.n, 1) && isHash(p.draft_hash))
  && isObj(x.head) && isCount(x.head.seq, 1) && isHash(x.head.hash) && isCount(x.entries, 1)
  && isStr(x.workbench) && isStr(x.unloaded_ts)
  && Array.isArray(x.files) && x.files.every(isFileEntry) && packFilesWellFormed(x.files);

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

/** case.json is read into memory to be parsed; one larger than this is not a manifest this workbench wrote. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/** The case file as packfile.ts packs and reads it. */
const CASE_KIND: PackKind<CaseManifest> = {
  manifest: MANIFEST_NAME, manifest_max: MAX_MANIFEST_BYTES, isManifest: isCaseManifest, pathProblem: () => null, error: CaseFileError,
  words: {
    file: "a case file", manifest: "case", whole: "the case", packed: "the case", written: "the case", folder: "the case folder",
    journal: "the ledger has an unfinished journal",
  },
};

/** Every regular file under `dir`, hashed. Throws CaseFileError for a link or a special file, naming it. */
export function listCaseFolder(dir: string): CaseFileEntry[] {
  return listPackFolder(CASE_KIND, dir);
}

// ---------- writing ----------

/** Packs `caseDir` into `dest` (created with "wx", flushed with fsync before it resolves). case.json is the first member. */
export async function writeCaseFile(caseDir: string, dest: string, header: ManifestHeader): Promise<CaseManifest> {
  return writePackFile(CASE_KIND, caseDir, dest, (files) => ({
    format: CASE_FILE_FORMAT, id: header.id, chain: header.chain, origin: header.origin, title: header.title, asked: header.asked,
    marking: header.marking, starting: header.starting, status: header.status, outcome: header.outcome, published: header.published,
    head: header.head, entries: header.entries, workbench: WORKBENCH_VERSION, unloaded_ts: header.unloaded_ts, files,
  }), "the case's details do not make a case manifest");
}

// ---------- reading ----------

const limitOf = (opts?: { max_bytes?: number }): number => {
  const max = opts?.max_bytes ?? DEFAULT_MAX_CASE_BYTES;
  if (!Number.isSafeInteger(max) || max < 1) throw new TypeError("max_bytes must be a positive whole number");
  return max;
};

/** The manifest alone: reads no further than the first member. */
export async function readManifest(file: string): Promise<CaseManifest> {
  return readPackFile(CASE_KIND, file, { max: DEFAULT_MAX_CASE_BYTES, manifestOnly: true });
}

/** Reads the whole file and checks every member against case.json. Writes nothing. Throws CaseFileError. */
export async function checkCaseFile(file: string, opts?: { max_bytes?: number }): Promise<CaseManifest> {
  return readPackFile(CASE_KIND, file, { max: limitOf(opts) });
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
  const manifest = await readPackFile(CASE_KIND, file, { max: limitOf(opts), out });
  if (!found) return { manifest, bytes: null };
  const bytes = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) { bytes.set(p, at); at += p.length; }
  return { manifest, bytes };
}

/** checkCaseFile, writing each member under `destDir` (which must not exist). On any failure `destDir` is removed. */
export async function extractCaseFile(file: string, destDir: string, opts?: { max_bytes?: number }): Promise<CaseManifest> {
  return extractPackFile(CASE_KIND, file, destDir, limitOf(opts));
}
