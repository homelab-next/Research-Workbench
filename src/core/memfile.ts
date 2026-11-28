// The memory file (slice 13): the shared lessons store's folder packed as a case is packed: a ustar inside gzip, memory.json first, every other
// member hashed in it. Server-side core: never imported by src/web or src/core/state. A memory file is untrusted input. The packer and the
// reader are packfile.ts's, the same as a case file's, so every refusal of a case file is a memory file's too: this file holds only the manifest,
// the rule that a store folder holds its ledger and its blobs, and the words.
import { WORKBENCH_VERSION } from "./casefile";
import { extractPackFile, isPackEntry, packFilesWellFormed, readPackFile, writePackFile } from "./packfile";
import type { PackKind } from "./packfile";
import { Refused } from "./refused";
import { isNum, isObj, isStr } from "./state/guards";
import { shown } from "./tar";
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
/** memory.json is read into memory to be parsed; one larger than this is not a manifest this workbench wrote. */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const FILE_NAME = /^memory\.([A-Za-z0-9+_-]+)\.([0-9a-f]{12})\.memory\.tar\.gz$/;
const STATUSES = ["proposed", "accepted", "rejected", "retired", "superseded"] as const;

const isCount = (x: unknown, min: number): x is number => isNum(x) && Number.isSafeInteger(x) && x >= min;
const isHash = (x: unknown): x is string => isStr(x) && HASH.test(x);
/** A store folder holds its ledger and its blobs, nothing else. */
const storePathProblem = (p: string): string | null =>
  p === LEDGER || p.startsWith("blobs/") ? null : `${shown(p)} is not a file of a memory store; a memory file holds its ledger and its blobs`;
const isFileEntry = (x: unknown): x is FileEntry => isPackEntry(x, { manifest: MANIFEST_NAME, pathProblem: storePathProblem });

export const isMemoryManifest = (x: unknown): x is MemoryFileManifest =>
  isObj(x) && x.format === MEMORY_FILE_FORMAT && isStr(x.workbench) && isHash(x.origin)
  && isObj(x.head) && isCount(x.head.seq, 1) && isHash(x.head.hash) && isCount(x.entries, 1) && x.entries === x.head.seq
  && isObj(x.lessons) && STATUSES.every((k) => isCount((x.lessons as Record<string, unknown>)[k], 0)) && Object.keys(x.lessons).length === STATUSES.length
  && isMarking(x.marking) && isStr(x.exported_ts)
  && Array.isArray(x.files) && x.files.every(isFileEntry) && packFilesWellFormed(x.files as FileEntry[]) && (x.files as FileEntry[]).some((f) => f.path === LEDGER);

/** memory.<marking, written as a case file's name writes it>.<first 12 hex of the head hash>.memory.tar.gz */
export function memoryFileName(marking: string, head: string): string {
  return `memory.${marking.replace(/[^A-Za-z0-9+_-]/g, "-")}.${head.slice(0, 12)}.memory.tar.gz`;
}

/** The marking part and the 12 hex of a memory file's name; null when it is not one. */
export function parseMemoryFileName(name: string): { marking: string; hash12: string } | null {
  const m = FILE_NAME.exec(name);
  return m === null ? null : { marking: m[1]!, hash12: m[2]! };
}

/** The memory file as packfile.ts packs and reads it. */
const MEMORY_KIND: PackKind<MemoryFileManifest> = {
  manifest: MANIFEST_NAME, manifest_max: MAX_MANIFEST_BYTES, isManifest: isMemoryManifest, pathProblem: storePathProblem, error: MemoryFileError,
  words: {
    file: "a memory file", manifest: "memory", whole: "the memory file", packed: "the store", written: "the memory store", folder: "the store's folder",
    journal: "the memory store's ledger has an unfinished journal",
  },
};

/** Packs the store folder into `dest` (created with "wx", flushed with fsync before it resolves). memory.json is the first member. */
export async function writeMemoryFile(storeDir: string, dest: string, header: Omit<MemoryFileManifest, "format" | "workbench" | "files">): Promise<MemoryFileManifest> {
  return writePackFile(MEMORY_KIND, storeDir, dest, (files) => ({
    format: MEMORY_FILE_FORMAT, workbench: WORKBENCH_VERSION, origin: header.origin, head: { seq: header.head.seq, hash: header.head.hash }, entries: header.entries,
    lessons: {
      proposed: header.lessons.proposed, accepted: header.lessons.accepted, rejected: header.lessons.rejected,
      retired: header.lessons.retired, superseded: header.lessons.superseded,
    },
    marking: header.marking, exported_ts: header.exported_ts, files,
  }), "the store's details do not make a memory manifest");
}

/** Reads the whole file and checks every member against memory.json. Writes nothing. */
export async function checkMemoryFile(file: string): Promise<MemoryFileManifest> {
  return readPackFile(MEMORY_KIND, file, { max: MAX_MEMORY_FILE_BYTES });
}

/** checkMemoryFile, writing each member under `destDir` (which must not exist); on any failure `destDir` is removed. */
export async function extractMemoryFile(file: string, destDir: string): Promise<MemoryFileManifest> {
  return extractPackFile(MEMORY_KIND, file, destDir, MAX_MEMORY_FILE_BYTES);
}
