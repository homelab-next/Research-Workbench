import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "./canonical";
import { sha256Hex } from "./hash";
import type { BlobRef } from "./types";

export class BlobMissingError extends Error {
  constructor(hash: string) {
    super(`blob ${hash} is not in the store`);
    this.name = "BlobMissingError";
  }
}

/** A blob whose file does not hold the bytes its name says (wrong content, unreadable, or not a file). */
export class BlobCorruptError extends Error {
  constructor(hash: string) {
    super(`blob ${hash} is corrupt: its bytes do not match its name`);
    this.name = "BlobCorruptError";
  }
}

const HASH = /^[0-9a-f]{64}$/;

/** Content-addressed files: `<dir>/<sha256 hex>`. */
export class BlobStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  /** Stores the bytes under their hash. A file already under that name is kept only if it holds exactly these bytes; otherwise it is rewritten. */
  put(data: Uint8Array | string, media?: string): BlobRef {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const hash = sha256Hex(bytes);
    if (this.check(hash) !== "ok") this.write(hash, bytes);
    return media === undefined ? { blob: hash, bytes: bytes.byteLength } : { blob: hash, bytes: bytes.byteLength, media };
  }

  /** The bytes of a blob, checked against its hash. Throws BlobMissingError or BlobCorruptError. */
  get(hash: string): Uint8Array {
    if (!this.has(hash)) throw new BlobMissingError(hash);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(join(this.dir, hash)));
    } catch {
      throw new BlobCorruptError(hash); // present but unreadable, or not a file
    }
    if (sha256Hex(bytes) !== hash) throw new BlobCorruptError(hash);
    return bytes;
  }

  /**
   * Writes under a temporary name, flushes it, then renames it into place and flushes the directory,
   * so a crash never leaves a partial blob under its final name and a committed entry never outlives
   * its blob (the ledger uses synchronous = FULL).
   */
  private write(hash: string, bytes: Uint8Array): void {
    const path = join(this.dir, hash);
    const tmp = join(this.dir, `.tmp-${hash}-${process.pid}-${crypto.randomUUID()}`);
    try {
      const fd = openSync(tmp, "wx");
      try {
        for (let at = 0; at < bytes.byteLength; ) at += writeSync(fd, bytes, at);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (existsSync(path) && !statSync(path).isFile()) rmSync(path, { recursive: true, force: true });
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    syncDir(this.dir);
  }

  text(hash: string): string {
    return new TextDecoder().decode(this.get(hash));
  }

  has(hash: string): boolean {
    return HASH.test(hash) && existsSync(join(this.dir, hash));
  }

  check(hash: string): "ok" | "missing" | "corrupt" {
    if (!HASH.test(hash)) return "missing";
    const path = join(this.dir, hash);
    if (!existsSync(path)) return "missing";
    try {
      if (!statSync(path).isFile()) return "corrupt";
      return sha256Hex(readFileSync(path)) === hash ? "ok" : "corrupt";
    } catch {
      return "corrupt"; // present but unreadable
    }
  }
}

/** Flushes a directory entry (a rename into it). Not every platform can open a directory for this; there it is skipped. */
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

export function isBlobRef(v: unknown): v is BlobRef {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return typeof o.blob === "string" && HASH.test(o.blob) && typeof o.bytes === "number";
}

/** Every blob reference anywhere inside a JSON value, in document order. */
export function collectBlobRefs(v: Json): BlobRef[] {
  const found: BlobRef[] = [];
  const walk = (x: unknown): void => {
    if (isBlobRef(x)) found.push(x);
    if (Array.isArray(x)) x.forEach(walk);
    else if (typeof x === "object" && x !== null) Object.values(x).forEach(walk);
  };
  walk(v);
  return found;
}
