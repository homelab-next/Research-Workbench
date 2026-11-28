// packfile.ts as a kind with a prefix uses it (slice 14 Task 0: the loop file joins the case file and the memory file on the one packer and reader).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { sha256Hex } from "../../src/core/hash";
import { intoMemory, readPackFile, writePackMembers } from "../../src/core/packfile";
import type { PackEntry, PackKind } from "../../src/core/packfile";
import { Refused } from "../../src/core/refused";
import { isObj } from "../../src/core/state/guards";
import { rawCaseFile } from "../helpers/tar";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rw-packfile-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

class ThingFileError extends Refused {}
interface ThingManifest { format: 1; files: PackEntry[] }
const THING: PackKind<ThingManifest> = {
  manifest: "thing.json", manifest_max: 1 << 20, prefix: "manifests/",
  isManifest: (x): x is ThingManifest => isObj(x) && x.format === 1 && Array.isArray(x.files),
  filesProblem: (files) => (new Set(files.map((f) => f.path)).size === files.length ? null : "a path is listed twice in thing.json"),
  pathProblem: () => null,
  error: ThingFileError,
  words: { file: "a thing file", manifest: "thing", whole: "the thing file", packed: "the thing", written: "the thing", folder: "the thing's folder", journal: "the thing has a journal" },
};

const enc = new TextEncoder();
const bodies: Record<string, Uint8Array> = { "a.md": enc.encode("alpha\n"), "b/c.md": enc.encode("gamma\n") };
const entry = (path: string, bytes = bodies[path]!): PackEntry => ({ path, sha256: sha256Hex(bytes), bytes: bytes.length });
const manifest = (): ThingManifest => ({ format: 1, files: [entry("a.md"), entry("b/c.md")] });

/** The member names of a gzipped ustar, read by hand. */
function names(file: string): string[] {
  const tar = gunzipSync(readFileSync(file));
  const out: string[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((x) => x === 0)) break;
    out.push(new TextDecoder().decode(h.subarray(0, 100)).replace(/\0.*$/s, ""));
    at += 512 + Math.ceil(parseInt(new TextDecoder().decode(h.subarray(124, 136)).replace(/\0.*$/s, ""), 8) / 512) * 512;
  }
  return out;
}

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ThingFileError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

test("writePackMembers writes the manifest first and each member under the kind's prefix", async () => {
  const dest = join(dir, "t.tar.gz");
  const written = await writePackMembers(THING, dest, manifest(), (f) => [bodies[f.path]!], "not a thing");
  expect(written).toEqual(manifest());
  expect(names(dest)).toEqual(["thing.json", "manifests/a.md", "manifests/b/c.md"]);
  const got: [string, string][] = [];
  expect(await readPackFile(THING, dest, { max: 1 << 20, out: intoMemory((path, bytes) => void got.push([path, new TextDecoder().decode(bytes)])) })).toEqual(manifest());
  expect(got).toEqual([["a.md", "alpha\n"], ["b/c.md", "gamma\n"]]);
  // a manifest the kind does not take, and one its own rule for files refuses, are not written
  expect(await refused(writePackMembers(THING, join(dir, "u.tar.gz"), { format: 2 } as unknown as ThingManifest, () => [], "not a thing"))).toBe("not a thing");
  expect(await refused(writePackMembers(THING, join(dir, "v.tar.gz"), { format: 1, files: [entry("a.md"), entry("a.md")] }, (f) => [bodies[f.path]!], "not a thing"))).toBe("a path is listed twice in thing.json");
  expect(readdirSync(dir)).toEqual(["t.tar.gz"]);
});

test("readPackFile refuses a member outside the kind's prefix in the kind's words", async () => {
  const f = join(dir, "out.tar.gz");
  rawCaseFile(f, [{ name: "thing.json", body: JSON.stringify(manifest()) }, { name: "x", body: "alpha\n" }]);
  expect(await refused(readPackFile(THING, f, { max: 1 << 20 }))).toBe("x is outside manifests/");
  // the kind's rule for its files is said in its own words
  const twice = join(dir, "twice.tar.gz");
  rawCaseFile(twice, [{ name: "thing.json", body: JSON.stringify({ format: 1, files: [entry("a.md"), entry("a.md")] }) }]);
  expect(await refused(readPackFile(THING, twice, { max: 1 << 20 }))).toBe("a path is listed twice in thing.json");
  // a member under the prefix is matched with the path the manifest lists, which has no prefix
  const absent = join(dir, "absent.tar.gz");
  rawCaseFile(absent, [{ name: "thing.json", body: JSON.stringify(manifest()) }, { name: "manifests/a.md", body: "alpha\n" }]);
  expect(await refused(readPackFile(THING, absent, { max: 1 << 20 }))).toBe("b/c.md is listed in thing.json and is not in the file");
});

test("intoMemory hands a member over only after its size and hash are checked: a member with a wrong hash is never handed over", async () => {
  const f = join(dir, "hash.tar.gz");
  rawCaseFile(f, [{ name: "thing.json", body: JSON.stringify(manifest()) }, { name: "manifests/a.md", body: "alpha\n" }, { name: "manifests/b/c.md", body: "gammx\n" }]);
  const got: string[] = [];
  expect(await refused(readPackFile(THING, f, { max: 1 << 20, out: intoMemory((path) => void got.push(path)) }))).toBe("manifests/b/c.md is not what thing.json lists");
  expect(got).toEqual(["a.md"]);
  // a wrong size is refused on the header, before any body is handed over
  const size = join(dir, "size.tar.gz");
  rawCaseFile(size, [{ name: "thing.json", body: JSON.stringify(manifest()) }, { name: "manifests/a.md", body: "alpha!\n" }]);
  const none: string[] = [];
  expect(await refused(readPackFile(THING, size, { max: 1 << 20, out: intoMemory((path) => void none.push(path)) }))).toBe("manifests/a.md is not the size thing.json lists");
  expect(none).toEqual([]);
  // what the receiver throws is passed on as it was thrown
  const good = join(dir, "good.tar.gz");
  await writePackMembers(THING, good, manifest(), (e) => [bodies[e.path]!], "not a thing");
  const mine = new Error("the receiver's own");
  let caught: unknown;
  try { await readPackFile(THING, good, { max: 1 << 20, out: intoMemory(() => { throw mine; }) }); } catch (err) { caught = err; }
  expect(caught).toBe(mine);
});
