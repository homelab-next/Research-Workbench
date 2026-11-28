import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { WORKBENCH_VERSION } from "../../src/core/casefile";
import { sha256Hex } from "../../src/core/hash";
import { checkLoopFile, LOOP_FILE_FORMAT, LoopFileError, loopFileName, MAX_LOOP_FILE_BYTES, parseLoopFileName, readLoopFile, writeLoopFile } from "../../src/core/loopfile";
import type { LoopFileEntry, LoopFileManifest } from "../../src/core/loopfile";
import { Refused } from "../../src/core/refused";
import { rawCaseFile } from "../helpers/tar";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rw-loopfile-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const enc = new TextEncoder();
const HASH = "ab".repeat(32);
const header = (): Omit<LoopFileManifest, "format" | "workbench" | "files"> => ({
  loop: "triage", version: 3, title: "Triage", about: "Look at an address.", hash: HASH, legacy_hash: null,
  lock: { format: 1, loop: "triage", items: [] }, subloops: [],
});
const files = (): { path: string; kind: string; id: string; bytes: Uint8Array; origin: string | null }[] => [
  { path: "loops/triage.yaml", kind: "loop", id: "triage", bytes: enc.encode("kind: loop\nid: triage\n"), origin: null },
  { path: "context/personas/analyst.md", kind: "persona", id: "analyst", bytes: enc.encode("---\nkind: persona\nid: analyst\n---\nBe careful.\n"), origin: null },
  { path: "sources/reputation.yaml", kind: "source", id: "reputation", bytes: enc.encode("kind: source\nid: reputation\nlocation: \"unset\"\n"), origin: "cd".repeat(32) },
];

/** The members of a gzipped ustar, read by hand: name and body. */
function members(file: string): { name: string; body: Uint8Array }[] {
  const tar = gunzipSync(readFileSync(file));
  const out: { name: string; body: Uint8Array }[] = [];
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((x) => x === 0)) break;
    const field = (o: number, n: number): string => new TextDecoder().decode(h.subarray(o, o + n)).replace(/\0.*$/s, "");
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12), 8);
    out.push({ name: prefix === "" ? name : `${prefix}/${name}`, body: tar.subarray(at + 512, at + 512 + size) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(LoopFileError);
    expect(err).toBeInstanceOf(Refused);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

/** A loop.json for hand-made files: `listed` as given, everything else well formed. */
const manifestFor = (listed: LoopFileEntry[], over: Record<string, unknown> = {}): string =>
  JSON.stringify({ format: 1, workbench: WORKBENCH_VERSION, ...header(), files: listed, ...over });
const entryOf = (path: string, body: string, kind = "persona", id = "analyst"): LoopFileEntry =>
  ({ path, kind, id, sha256: sha256Hex(enc.encode(body)), bytes: enc.encode(body).length, origin: null });

// ---- Step 1: the file

test("writeLoopFile puts loop.json first and each file under manifests/, and checkLoopFile reads the same manifest back", async () => {
  const dest = join(dir, loopFileName("triage", 3, HASH));
  const written = await writeLoopFile(dest, header(), files());
  expect(written.format).toBe(LOOP_FILE_FORMAT);
  expect(written.workbench).toBe(WORKBENCH_VERSION);
  expect(written.files.map((f) => f.path)).toEqual(["context/personas/analyst.md", "loops/triage.yaml", "sources/reputation.yaml"]);
  const rep = written.files.find((f) => f.id === "reputation")!;
  expect(rep).toEqual({ path: "sources/reputation.yaml", kind: "source", id: "reputation", sha256: sha256Hex(files()[2]!.bytes), bytes: files()[2]!.bytes.length, origin: "cd".repeat(32) });
  const m = members(dest);
  expect(m.map((x) => x.name)).toEqual(["loop.json", "manifests/context/personas/analyst.md", "manifests/loops/triage.yaml", "manifests/sources/reputation.yaml"]);
  expect(new TextDecoder().decode(m[0]!.body)).toBe(canonical(written as unknown as Json));
  expect(m[2]!.body).toEqual(files()[0]!.bytes);
  expect(await checkLoopFile(dest)).toEqual(written);
  const got: [string, string][] = [];
  expect(await readLoopFile(dest, (e, b) => void got.push([e.path, new TextDecoder().decode(b)]))).toEqual(written);
  expect(got).toEqual([["context/personas/analyst.md", "---\nkind: persona\nid: analyst\n---\nBe careful.\n"], ["loops/triage.yaml", "kind: loop\nid: triage\n"], ["sources/reputation.yaml", "kind: source\nid: reputation\nlocation: \"unset\"\n"]]);
  // only the file itself is left beside it: the temporary name is gone
  expect(readdirSync(dir)).toEqual([loopFileName("triage", 3, HASH)]);
  // it is not written over
  expect(await refused(writeLoopFile(dest, header(), files()))).toContain("already exists");
});

test("the file name is <loop>.v<version>.<12 hex>.loop.tar.gz, and a name that is not that parses to null", () => {
  expect(loopFileName("triage", 3, HASH)).toBe("triage.v3.abababababab.loop.tar.gz");
  expect(parseLoopFileName("triage.v3.abababababab.loop.tar.gz")).toEqual({ loop: "triage", version: 3, hash12: "abababababab" });
  expect(parseLoopFileName("my.loop.v12.0123456789ab.loop.tar.gz")).toEqual({ loop: "my.loop", version: 12, hash12: "0123456789ab" });
  for (const bad of ["triage.v3.abababababab.tar.gz", "triage.v0.abababababab.loop.tar.gz", "triage.v3.ABABABABABAB.loop.tar.gz", "triage.v3.ababab.loop.tar.gz",
    ".v3.abababababab.loop.tar.gz", "../x.v3.abababababab.loop.tar.gz", "a/b.v3.abababababab.loop.tar.gz", "triage.vx.abababababab.loop.tar.gz", "CASE-1.TLP-RED.tar.gz"]) {
    expect(parseLoopFileName(bad)).toBeNull();
  }
});

test("the same header and files write the same tar bytes inside the gzip", async () => {
  const a = join(dir, "a.loop.tar.gz");
  const b = join(dir, "b.loop.tar.gz");
  await writeLoopFile(a, header(), files());
  await writeLoopFile(b, header(), [...files()].reverse());
  expect(gunzipSync(readFileSync(a))).toEqual(gunzipSync(readFileSync(b)));
});

// ---- slice 14 Task 0: the loop file is read and written by packfile.ts; these held before the change and hold after it

test("a loop file written for a fixed loop has the bytes it had: its sha256 is the one this test holds", async () => {
  const a = join(dir, "a.loop.tar.gz");
  const b = join(dir, "b.loop.tar.gz");
  await writeLoopFile(a, header(), files());
  await writeLoopFile(b, header(), [...files()].reverse());
  // the tar inside the gzip (gzip's own bytes are zlib's), with the workbench version masked so the hash outlives a version bump of the same length
  const masked = (f: string): string => sha256Hex(Buffer.from(Buffer.from(gunzipSync(readFileSync(f))).toString("latin1")
    .replace(`"workbench":"${WORKBENCH_VERSION}"`, `"workbench":"${"#".repeat(WORKBENCH_VERSION.length)}"`), "latin1"));
  expect(WORKBENCH_VERSION).toHaveLength(6);
  expect(masked(a)).toBe(masked(b));
  expect(masked(a)).toBe(LOOP_FILE_SHA256);
});
const LOOP_FILE_SHA256 = "61d99eea1224d2ab87d34bdcde449c2eea4482cb4b501caaa89579eabb09d8c8";

test("every refusal of tests/core/loopfile.test.ts is said in the same words", async () => {
  const body = "kind: persona\n";
  const e = entryOf("p.md", body);
  const big = 17 * 1024 * 1024;
  const cases: [string, Parameters<typeof rawCaseFile>[1], string][] = [
    ["link", [{ name: "loop.json", body: manifestFor([e]) }, { name: "manifests/p.md", type: "2", link: "/etc/passwd" }], "manifests/p.md is a link; a loop file holds only regular files"],
    ["folder", [{ name: "loop.json", body: manifestFor([e]) }, { name: "manifests/p.md", type: "5" }], "manifests/p.md is not a regular file; a loop file holds only regular files"],
    ["up", [{ name: "loop.json", body: manifestFor([e]) }, { name: "manifests/../x", body }], "manifests/../x: a path that leaves the loop file"],
    ["nul", [{ name: "loop.json", body: manifestFor([e]) }, { name: "manifests/p\0.md", body }], "manifests/p�.md: a NUL in a path"],
    ["backslash", [{ name: "loop.json", body: manifestFor([e]) }, { name: "manifests\\p.md", body }], "manifests\\p.md: a backslash in a path"],
    ["outside", [{ name: "loop.json", body: manifestFor([e]) }, { name: "p.md", body }], "p.md is outside manifests/"],
    ["unlisted", [{ name: "loop.json", body: manifestFor([e]) }, { name: "manifests/q.md", body }], "manifests/q.md is not listed in loop.json"],
    ["absent", [{ name: "loop.json", body: manifestFor([e]) }], "p.md is listed in loop.json and is not in the file"],
    ["size", [{ name: "loop.json", body: manifestFor([e]) }, { name: "manifests/p.md", body: body + "x" }], "manifests/p.md is not the size loop.json lists"],
    ["hash", [{ name: "loop.json", body: manifestFor([e]) }, { name: "manifests/p.md", body: body.replace("p", "q") }], "manifests/p.md is not what loop.json lists"],
    ["twice", [{ name: "loop.json", body: manifestFor([e]) }, { name: "manifests/p.md", body }, { name: "manifests/p.md", body }], "manifests/p.md appears twice in the loop file"],
    ["listed-twice", [{ name: "loop.json", body: manifestFor([e, e]) }], "p.md is listed twice in loop.json"],
    ["too-large", [{ name: "loop.json", body: manifestFor([{ ...e, bytes: big }]) }, { name: "manifests/p.md", size: big }], "the loop file is larger than the limit of 16777216 bytes unpacked"],
    ["not-first", [{ name: "manifests/p.md", body }, { name: "loop.json", body: manifestFor([e]) }], "loop.json is not the first member"],
    ["format", [{ name: "loop.json", body: manifestFor([e], { format: 2 }) }, { name: "manifests/p.md", body }], "loop.json is not a loop file manifest of format 1"],
  ];
  for (const [name, ms, said] of cases) {
    const f = join(dir, `${name}.loop.tar.gz`);
    rawCaseFile(f, ms);
    expect([name, await refused(checkLoopFile(f))]).toEqual([name, said]);
    expect([name, await refused(readLoopFile(f, () => {}))]).toEqual([name, said]);
  }
});

test("what readLoopFile's caller throws is passed on as it was thrown", async () => {
  const f = join(dir, "good.loop.tar.gz");
  await writeLoopFile(f, header(), files());
  const mine = new Error("the caller's own");
  let caught: unknown;
  try { await readLoopFile(f, () => { throw mine; }); } catch (err) { caught = err; }
  expect(caught).toBe(mine);
});

// ---- Step 5: a hostile file

test("a first member that is not loop.json, and a loop.json that is not a manifest of format 1, are refused", async () => {
  const body = "kind: persona\n";
  const listed = [entryOf("p.md", body)];
  const f1 = join(dir, "1.loop.tar.gz");
  rawCaseFile(f1, [{ name: "manifests/p.md", body }, { name: "loop.json", body: manifestFor(listed) }]);
  expect(await refused(checkLoopFile(f1))).toBe("loop.json is not the first member");
  const f2 = join(dir, "2.loop.tar.gz");
  rawCaseFile(f2, [{ name: "loop.json", body: manifestFor(listed, { format: 2 }) }, { name: "manifests/p.md", body }]);
  expect(await refused(checkLoopFile(f2))).toBe("loop.json is not a loop file manifest of format 1");
  const f3 = join(dir, "3.loop.tar.gz");
  rawCaseFile(f3, [{ name: "loop.json", body: "{not json" }]);
  expect(await refused(checkLoopFile(f3))).toBe("loop.json is not a loop file manifest of format 1");
  const f4 = join(dir, "4.loop.tar.gz");
  rawCaseFile(f4, [{ name: "loop.json", body: manifestFor(listed, { loop: "../up" }) }, { name: "manifests/p.md", body }]);
  expect(await refused(checkLoopFile(f4))).toBe("loop.json is not a loop file manifest of format 1");
  const f5 = join(dir, "5.loop.tar.gz");
  rawCaseFile(f5, []);
  expect(await refused(checkLoopFile(f5))).toBe("loop.json is not the first member");
});

test("a symlink member, a hard link and a directory are refused by kind", async () => {
  const listed = [entryOf("p.md", "x")];
  for (const [type, said] of [["2", "is a link; a loop file holds only regular files"], ["1", "is a link; a loop file holds only regular files"], ["5", "is not a regular file; a loop file holds only regular files"]] as const) {
    const f = join(dir, `k${type}.loop.tar.gz`);
    rawCaseFile(f, [{ name: "loop.json", body: manifestFor(listed) }, { name: "manifests/p.md", type, link: "/etc/passwd" }]);
    expect(await refused(checkLoopFile(f))).toBe(`manifests/p.md ${said}`);
  }
});

test("manifests/../../x, an absolute name, a name outside manifests/ and a name with a backslash are refused", async () => {
  const cases: [string, string][] = [
    ["manifests/../../x", "manifests/../../x: a path that leaves the loop file"],
    ["/etc/x", "/etc/x: an absolute path"],
    ["other/x.yaml", "other/x.yaml is outside manifests/"],
    ["manifests\\x.yaml", "manifests\\x.yaml: a backslash in a path"],
    ["manifests//x.yaml", "manifests//x.yaml: an empty path segment"],
  ];
  for (const [i, [name, said]] of cases.entries()) {
    const f = join(dir, `n${i}.loop.tar.gz`);
    rawCaseFile(f, [{ name: "loop.json", body: manifestFor([entryOf("x.yaml", "x")]) }, { name, body: "x" }]);
    expect(await refused(checkLoopFile(f))).toBe(said);
  }
  // a path in the list that could not be a member is a manifest this workbench does not read
  const f = join(dir, "listed.loop.tar.gz");
  rawCaseFile(f, [{ name: "loop.json", body: manifestFor([entryOf("../x.yaml", "x")]) }]);
  expect(await refused(checkLoopFile(f))).toBe("loop.json is not a loop file manifest of format 1");
});

test("a member the list does not have, a listed file that is missing, a file listed twice, a size that differs and a hash that differs are each refused with their reason", async () => {
  const body = "kind: persona\nid: analyst\n";
  const e = entryOf("p.md", body);
  const make = (name: string, listed: LoopFileEntry[], ms: { name: string; body?: string; size?: number }[]): string => {
    const f = join(dir, `${name}.loop.tar.gz`);
    rawCaseFile(f, [{ name: "loop.json", body: manifestFor(listed) }, ...ms]);
    return f;
  };
  expect(await refused(checkLoopFile(make("unlisted", [e], [{ name: "manifests/p.md", body }, { name: "manifests/q.md", body }])))).toBe("manifests/q.md is not listed in loop.json");
  expect(await refused(checkLoopFile(make("missing", [e, entryOf("q.md", body)], [{ name: "manifests/p.md", body }])))).toBe("q.md is listed in loop.json and is not in the file");
  expect(await refused(checkLoopFile(make("twice", [e, e], [{ name: "manifests/p.md", body }])))).toBe("p.md is listed twice in loop.json");
  expect(await refused(checkLoopFile(make("folder", [entryOf("a", body), entryOf("a/b.md", body)], [])))).toBe("a is listed in loop.json as a file and as a folder");
  expect(await refused(checkLoopFile(make("size", [e], [{ name: "manifests/p.md", body: body + "more" }])))).toBe("manifests/p.md is not the size loop.json lists");
  const edited = body.replace("analyst", "analysx");
  expect(await refused(checkLoopFile(make("hash", [e], [{ name: "manifests/p.md", body: edited }])))).toBe("manifests/p.md is not what loop.json lists");
  // twice in the archive itself
  expect(await refused(checkLoopFile(make("member-twice", [e], [{ name: "manifests/p.md", body }, { name: "manifests/p.md", body }])))).toBe("manifests/p.md appears twice in the loop file");
});

test("more than 16 MiB unpacked is refused before the body is read", async () => {
  expect(MAX_LOOP_FILE_BYTES).toBe(16777216);
  const said = "the loop file is larger than the limit of 16777216 bytes unpacked";
  // a header that says 17 MiB and no body at all: refused on the header, so the missing body is never reached
  const big = 17 * 1024 * 1024;
  const declared = join(dir, "declared.loop.tar.gz");
  rawCaseFile(declared, [{ name: "loop.json", body: manifestFor([{ path: "pad", kind: "persona", id: "x", sha256: HASH, bytes: big, origin: null }]) }, { name: "manifests/pad", size: big }]);
  expect(await refused(checkLoopFile(declared))).toBe(said);
  // 17 MiB of zero padding that gzip shrinks to almost nothing, behind a member that claims (and holds) 10 bytes
  const bomb = join(dir, "bomb.loop.tar.gz");
  const padded = new Uint8Array(big);
  padded.set(enc.encode("0123456789"));
  rawCaseFile(bomb, [{ name: "loop.json", body: manifestFor([entryOf("pad", "0123456789")]) }, { name: "manifests/pad", size: 10, body: padded }]);
  expect(await refused(checkLoopFile(bomb))).toBe(said);
});

test("a truncated file and a file that is not gzip are refused as not a readable loop file", async () => {
  const good = join(dir, "good.loop.tar.gz");
  await writeLoopFile(good, header(), files());
  const bytes = readFileSync(good);
  const cut = join(dir, "cut.loop.tar.gz");
  writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
  expect(await refused(checkLoopFile(cut))).toBe("the file is not a readable loop file");
  const plain = join(dir, "plain.loop.tar.gz");
  writeFileSync(plain, "kind: loop\nid: triage\n");
  expect(await refused(checkLoopFile(plain))).toBe("the file is not a readable loop file");
  expect(await refused(checkLoopFile(join(dir, "none.loop.tar.gz")))).toBe("there is no loop file there");
  expect(await refused(checkLoopFile(dir))).toBe("it is a folder, not a loop file");
});

test("checkLoopFile writes nothing anywhere", async () => {
  const good = join(dir, loopFileName("triage", 3, HASH));
  await writeLoopFile(good, header(), files());
  const hostile = join(dir, "hostile.loop.tar.gz");
  rawCaseFile(hostile, [{ name: "loop.json", body: manifestFor([entryOf("p.md", "x")]) }, { name: "manifests/../../escaped", body: "x" }]);
  const before = readdirSync(dir, { recursive: true }).sort();
  const tmpBefore = readdirSync(tmpdir()).sort();
  await checkLoopFile(good);
  await refused(checkLoopFile(hostile));
  expect(readdirSync(dir, { recursive: true }).sort()).toEqual(before);
  expect(readdirSync(tmpdir()).filter((n) => n === "escaped")).toEqual(tmpBefore.filter((n) => n === "escaped"));
});
