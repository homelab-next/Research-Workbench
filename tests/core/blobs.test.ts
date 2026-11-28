import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { BlobCorruptError, BlobMissingError, BlobStore, collectBlobRefs, OverlayBlobs, readingOver } from "../../src/core/blobs";

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

// ---------- final review, finding 7: bytes always match their name ----------
test("get and text throw BlobCorruptError when the file does not match its hash", () => {
  const ref = store.put("the raw bytes");
  writeFileSync(join(dir, "blobs", ref.blob), "tampered");
  expect(() => store.get(ref.blob)).toThrow(BlobCorruptError);
  expect(() => store.text(ref.blob)).toThrow(BlobCorruptError);
  rmSync(join(dir, "blobs", ref.blob));
  mkdirSync(join(dir, "blobs", ref.blob));
  expect(() => store.get(ref.blob)).toThrow(BlobCorruptError);
});

test("put repairs a file under the right name with the wrong bytes", () => {
  const ref = store.put("rows go here");
  for (const damage of ["", "truncat", "something else entirely"]) {
    writeFileSync(join(dir, "blobs", ref.blob), damage);
    expect(store.check(ref.blob)).toBe("corrupt");
    expect(store.put("rows go here")).toEqual(ref);
    expect(store.check(ref.blob)).toBe("ok");
    expect(store.text(ref.blob)).toBe("rows go here");
  }
  rmSync(join(dir, "blobs", ref.blob));
  mkdirSync(join(dir, "blobs", ref.blob));
  store.put("rows go here");
  expect(store.text(ref.blob)).toBe("rows go here");
  expect(readdirSync(join(dir, "blobs"))).toEqual([ref.blob]);
});

test("put flushes the new file before renaming it, and the directory after", () => {
  const order: string[] = [];
  const fsync = spyOn(fs, "fsyncSync").mockImplementation(() => void order.push("fsync"));
  const rename = spyOn(fs, "renameSync");
  rename.mockImplementation((from, to) => {
    order.push("rename");
    rename.mockRestore();
    fs.renameSync(from, to);
  });
  try {
    const ref = store.put("durable");
    expect(order).toEqual(["fsync", "rename", "fsync"]);
    expect(readFileSync(join(dir, "blobs", ref.blob), "utf8")).toBe("durable");
    order.length = 0;
    store.put("durable"); // already there and sound: nothing written
    expect(order).toEqual([]);
  } finally {
    fsync.mockRestore();
    rename.mockRestore();
  }
});

// ---------- slice 14: a store over another, for a check and for a staged candidate ----------
test("OverlayBlobs and readingOver read their own store first and then the base, and put nothing in the base", () => {
  const inBase = store.put("only in the base");
  const both = store.put("in both");
  const before = readdirSync(join(dir, "blobs")).sort();
  const missing = "e".repeat(64);

  const overlay = new OverlayBlobs(join(dir, "overlay"), store);
  expect(overlay).toBeInstanceOf(BlobStore);
  const mine = overlay.put("only in the overlay");
  // what the base holds already is not copied
  expect(overlay.put("in both")).toEqual(both);
  expect(readdirSync(join(dir, "overlay"))).toEqual([mine.blob]);
  expect(overlay.text(inBase.blob)).toBe("only in the base");
  expect(overlay.text(mine.blob)).toBe("only in the overlay");
  expect(overlay.has(inBase.blob) && overlay.has(mine.blob)).toBe(true);
  expect([overlay.check(inBase.blob), overlay.check(mine.blob), overlay.check(missing)]).toEqual(["ok", "ok", "missing"]);
  expect(() => overlay.get(missing)).toThrow(BlobMissingError);
  // its own copy is read first
  writeFileSync(join(dir, "overlay", both.blob), "in both");
  writeFileSync(join(dir, "blobs", both.blob), "the base's copy, damaged");
  expect(overlay.text(both.blob)).toBe("in both");
  writeFileSync(join(dir, "blobs", both.blob), "in both");

  const own = new BlobStore(join(dir, "own"));
  const ownOnly = own.put("only in over");
  const reading = readingOver(own, store);
  expect(reading).toBeInstanceOf(BlobStore);
  const put = reading.put("put through reading");
  expect(own.text(put.blob)).toBe("put through reading");
  expect(reading.text(ownOnly.blob)).toBe("only in over");
  expect(reading.text(inBase.blob)).toBe("only in the base");
  expect(reading.has(ownOnly.blob) && reading.has(inBase.blob) && !reading.has(missing)).toBe(true);
  expect([reading.check(ownOnly.blob), reading.check(inBase.blob), reading.check(missing)]).toEqual(["ok", "ok", "missing"]);
  expect(() => reading.get(missing)).toThrow(BlobMissingError);
  writeFileSync(join(dir, "own", both.blob), "in both");
  writeFileSync(join(dir, "blobs", both.blob), "damaged");
  expect(reading.text(both.blob)).toBe("in both");
  writeFileSync(join(dir, "blobs", both.blob), "in both");
  // no folder of its own: the parent holds only the stores made here
  expect(readdirSync(dir).sort()).toEqual(["blobs", "overlay", "own"]);

  // the base holds what it held
  expect(readdirSync(join(dir, "blobs")).sort()).toEqual(before);
});
