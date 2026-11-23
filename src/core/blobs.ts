import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

const HASH = /^[0-9a-f]{64}$/;

/** Content-addressed files: `<dir>/<sha256 hex>`. */
export class BlobStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  put(data: Uint8Array | string, media?: string): BlobRef {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const hash = sha256Hex(bytes);
    const path = join(this.dir, hash);
    if (!existsSync(path)) {
      // Write under a temporary name, then rename, so a crash never leaves a partial blob under its final name.
      const tmp = join(this.dir, `.tmp-${hash}-${process.pid}-${crypto.randomUUID()}`);
      writeFileSync(tmp, bytes);
      renameSync(tmp, path);
    }
    return media === undefined ? { blob: hash, bytes: bytes.byteLength } : { blob: hash, bytes: bytes.byteLength, media };
  }

  get(hash: string): Uint8Array {
    if (!this.has(hash)) throw new BlobMissingError(hash);
    return new Uint8Array(readFileSync(join(this.dir, hash)));
  }

  text(hash: string): string {
    return new TextDecoder().decode(this.get(hash));
  }

  has(hash: string): boolean {
    return HASH.test(hash) && existsSync(join(this.dir, hash));
  }

  check(hash: string): "ok" | "missing" | "corrupt" {
    if (!this.has(hash)) return "missing";
    return sha256Hex(this.get(hash)) === hash ? "ok" : "corrupt";
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
