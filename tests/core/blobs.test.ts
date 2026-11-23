import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { BlobMissingError, BlobStore, collectBlobRefs } from "../../src/core/blobs";

let dir: string;
let store: BlobStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "blobs-"));
  store = new BlobStore(join(dir, "blobs"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("put names a blob by its sha256 and records its size", () => {
  const ref = store.put("abc", "text/plain");
  expect(ref).toEqual({ blob: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", bytes: 3, media: "text/plain" });
  expect(store.text(ref.blob)).toBe("abc");
});

test("putting the same bytes twice is harmless", () => {
  const a = store.put("same");
  const b = store.put(new TextEncoder().encode("same"));
  expect(b).toEqual(a);
  expect(readdirSync(join(dir, "blobs"))).toEqual([a.blob]);
});

test("get of an unknown hash throws BlobMissingError", () => {
  const unknown = "f".repeat(64);
  expect(() => store.get(unknown)).toThrow(BlobMissingError);
  expect(() => store.get("../escape")).toThrow(BlobMissingError);
  expect(store.has(unknown)).toBe(false);
});

test("check reports ok, missing and corrupt", () => {
  const ref = store.put("payload");
  expect(store.check(ref.blob)).toBe("ok");
  expect(store.check("e".repeat(64))).toBe("missing");
  writeFileSync(join(dir, "blobs", ref.blob), "tampered");
  expect(store.check(ref.blob)).toBe("corrupt");
});

test("collectBlobRefs finds refs at any depth and ignores look-alikes", () => {
  const ref = store.put("x");
  expect(collectBlobRefs({ a: [{ b: ref }], c: { blob: "nope", bytes: 1 } } as unknown as Json)).toEqual([ref]);
});
