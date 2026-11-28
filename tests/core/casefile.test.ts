import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { BlobStore } from "../../src/core/blobs";
import {
  CaseFileError, caseFileName, checkCaseFile, extractCaseFile, isCaseManifest, memberProblem, parseCaseFileName, readManifest, writeCaseFile,
} from "../../src/core/casefile";
import type { CaseManifest, ManifestHeader } from "../../src/core/casefile";
import { Ledger } from "../../src/core/ledger";
import { rawCaseFile } from "../helpers/tar";

const H = (c: string) => c.repeat(64);

/** A manifest written by hand: what a well-formed case.json holds. */
function manifest(): Record<string, unknown> {
  return {
    format: 1, id: "CASE-1", chain: "CASE-1", origin: H("a"),
    title: "Beacon from a lab host", asked: "Is 192.0.2.10 beaconing?", marking: "TLP:AMBER",
    starting: [{ type: "ip", value: "192.0.2.10" }], status: "published", outcome: "published",
    published: [{ n: 1, draft_hash: H("b") }], head: { seq: 3, hash: H("c") }, entries: 3,
    workbench: "0.11.0", unloaded_ts: "2026-11-27T10:00:00.000Z",
    files: [{ path: "blobs/" + H("d"), sha256: H("d"), bytes: 12 }, { path: "ledger.sqlite", sha256: H("e"), bytes: 8192 }],
  };
}

test("caseFileName carries the id and the marking; parseCaseFileName reads them back", () => {
  expect(caseFileName("CASE-12", "TLP:AMBER")).toBe("CASE-12.TLP-AMBER.tar.gz");
  expect(caseFileName("CASE-3", "TLP:AMBER+STRICT")).toBe("CASE-3.TLP-AMBER+STRICT.tar.gz");
  expect(parseCaseFileName("CASE-12.TLP-AMBER.tar.gz")).toEqual({ id: "CASE-12", marking: "TLP-AMBER" });
  for (const bad of ["CASE-0.TLP-RED.tar.gz", "CASE-12.tar.gz", "case-12.TLP-RED.tar.gz", "CASE-12.TLP-RED.tgz", ".tmp-CASE-12.part", "CASE-12.TLP/RED.tar.gz"]) expect(parseCaseFileName(bad)).toBeNull();
});

test("memberProblem refuses an absolute path, a backslash, a NUL, and an empty, dot or dot-dot segment", () => {
  expect(memberProblem("blobs/" + "a".repeat(64))).toBeNull(); expect(memberProblem("published/1/product.md")).toBeNull();
  expect(memberProblem("/etc/passwd")).toBe("an absolute path"); expect(memberProblem("../x")).toBe("a path that leaves the case folder");
  expect(memberProblem("blobs/../../x")).toBe("a path that leaves the case folder"); expect(memberProblem("a//b")).toBe("an empty path segment");
  expect(memberProblem("./a")).toBe("a path that leaves the case folder"); expect(memberProblem("a\\b")).toBe("a backslash in a path"); expect(memberProblem("a\0b")).toBe("a NUL in a path"); expect(memberProblem("")).toBe("an empty name");
});

test("isCaseManifest accepts a written manifest and refuses a wrong format, a missing head, a file entry without a hash, and a file path memberProblem refuses", () => {
  expect(isCaseManifest(manifest())).toBe(true);
  expect(isCaseManifest({ ...manifest(), format: 2 })).toBe(false);
  const { head: _head, ...headless } = manifest();
  expect(isCaseManifest(headless)).toBe(false);
  expect(isCaseManifest({ ...manifest(), files: [{ path: "ledger.sqlite", bytes: 8192 }] })).toBe(false);
  for (const path of ["../ledger.sqlite", "/ledger.sqlite", "a//b", "a\\b"]) expect(isCaseManifest({ ...manifest(), files: [{ path, sha256: H("e"), bytes: 1 }] })).toBe(false);
  // case.json is not one of its own files, a path is not both a file and a folder, and the list is sorted with no name twice.
  expect(isCaseManifest({ ...manifest(), files: [{ path: "case.json", sha256: H("e"), bytes: 1 }] })).toBe(false);
  // nor is a ledger journal (final review I3: the rule is packfile.ts's, a memory file's too)
  for (const path of ["ledger.sqlite-journal", "ledger.sqlite-shm", "ledger.sqlite-wal"]) expect(isCaseManifest({ ...manifest(), files: [{ path, sha256: H("e"), bytes: 1 }] })).toBe(false);
  expect(isCaseManifest({ ...manifest(), files: [{ path: "a", sha256: H("e"), bytes: 1 }, { path: "a/b", sha256: H("e"), bytes: 1 }] })).toBe(false);
  expect(isCaseManifest({ ...manifest(), files: [{ path: "b", sha256: H("e"), bytes: 1 }, { path: "a", sha256: H("e"), bytes: 1 }] })).toBe(false);
  expect(isCaseManifest({ ...manifest(), files: [{ path: "a", sha256: H("e"), bytes: 1 }, { path: "a", sha256: H("e"), bytes: 1 }] })).toBe(false);
  expect(isCaseManifest({ ...manifest(), id: "CASE-0" })).toBe(false);
  expect(isCaseManifest({ ...manifest(), marking: "SECRET" })).toBe(false);
  expect(isCaseManifest({ ...manifest(), files: [{ path: "x", sha256: H("e"), bytes: -1 }] })).toBe(false);
  expect(isCaseManifest(null)).toBe(false);
});

test("a manifest's outcome may be completed, the outcome of a loop with no publish gate; another word is refused", () => {
  for (const outcome of ["published", "stopped", "completed", null]) expect({ outcome, ok: isCaseManifest({ ...manifest(), outcome }) }).toEqual({ outcome, ok: true });
  for (const outcome of ["finished", "", 1]) expect({ outcome, ok: isCaseManifest({ ...manifest(), outcome }) }).toEqual({ outcome, ok: false });
});

// ---------- write, read and check ----------

let root: string;
let caseDir: string;
let header: ManifestHeader;
let blobHashes: string[];

/** A synthetic case folder: a real ledger with three entries, two blobs, and published/1/ with two files. */
function makeCase(dir: string): { header: ManifestHeader; blobs: string[] } {
  const blobs = new BlobStore(join(dir, "blobs"));
  const a = blobs.put("rows go here", "application/json");
  const b = blobs.put("x".repeat(4096), "text/plain");
  let tick = 0;
  const ledger = Ledger.open(join(dir, "ledger.sqlite"), "CASE-1", { now: () => new Date(Date.UTC(2026, 10, 27, 9, 0, tick++)).toISOString() });
  const human = { kind: "human", id: "analyst" } as const;
  const first = ledger.append({ type: "case.phase_changed", payload: { phase: "collect" }, actor: human });
  ledger.append({ type: "case.phase_changed", payload: { phase: "analyse" }, actor: human });
  const last = ledger.append({ type: "case.phase_changed", payload: { phase: "review" }, actor: human });
  ledger.close();
  mkdirSync(join(dir, "published", "1"), { recursive: true });
  writeFileSync(join(dir, "published", "1", "manifest.json"), '{"files":[]}\n');
  writeFileSync(join(dir, "published", "1", "product.md"), "# Beacon from a lab host\n");
  return {
    blobs: [a.blob, b.blob],
    header: {
      id: "CASE-1", chain: "CASE-1", origin: first.hash, title: "Beacon from a lab host", asked: "Is 192.0.2.10 beaconing to example.com?",
      marking: "TLP:AMBER", starting: [{ type: "ip", value: "192.0.2.10" }], status: "published", outcome: "published",
      published: [{ n: 1, draft_hash: H("b") }], head: { seq: last.seq, hash: last.hash }, entries: 3, unloaded_ts: "2026-11-27T10:00:00.000Z",
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "casefile-"));
  caseDir = join(root, "CASE-1");
  mkdirSync(caseDir);
  ({ header, blobs: blobHashes } = makeCase(caseDir));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The reason a promise was refused with; fails the test when it was not refused with a CaseFileError. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof CaseFileError) return err.reasons[0]!;
    throw err;
  }
  throw new Error("expected a refusal");
}

/** Every path under `dir` with its size and mtime, so a test can see that nothing was written. */
function snapshot(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).sort().map((p) => { const st = statSync(join(dir, p)); return `${p} ${st.size} ${st.mtimeMs}`; });
}

async function packed(): Promise<{ file: string; m: CaseManifest }> {
  const file = join(root, "CASE-1.TLP-AMBER.tar.gz");
  return { file, m: await writeCaseFile(caseDir, file, header) };
}

test("writeCaseFile packs every file of the folder with case.json first, and its manifest lists each with its sha256 and size", async () => {
  const { file, m } = await packed();
  expect(m.files.map((f) => f.path)).toEqual(["blobs/" + blobHashes[0], "blobs/" + blobHashes[1], "ledger.sqlite", "published/1/manifest.json", "published/1/product.md"].sort((a, b) => (a < b ? -1 : 1)));
  expect(m).toMatchObject({ format: 1, workbench: "0.13.0", id: "CASE-1", chain: "CASE-1" });
  for (const f of m.files) expect(f.bytes).toBe(statSync(join(caseDir, f.path)).size);
  expect(m.files.find((f) => f.path === "blobs/" + blobHashes[1])!.sha256).toBe(blobHashes[1]!);
  const tar = gunzipSync(readFileSync(file));
  expect(new TextDecoder().decode(tar.subarray(0, 9))).toBe("case.json");
  expect(await readManifest(file)).toEqual(m); expect(await checkCaseFile(file)).toEqual(m);
});

test("the same folder packs to the same bytes twice", async () => {
  const { file } = await packed();
  const again = join(root, "again.tar.gz");
  await writeCaseFile(caseDir, again, header);
  expect(Buffer.compare(gunzipSync(readFileSync(file)), gunzipSync(readFileSync(again)))).toBe(0);
});

test("extractCaseFile writes exactly the listed files, byte for byte, and the ledger it writes opens", async () => {
  const { file, m } = await packed();
  const dest = join(root, "out");
  expect(await extractCaseFile(file, dest)).toEqual(m);
  const written = (readdirSync(dest, { recursive: true }) as string[]).filter((p) => statSync(join(dest, p)).isFile()).sort((a, b) => (a < b ? -1 : 1));
  expect(written).toEqual(m.files.map((f) => f.path));
  for (const f of m.files) expect(Buffer.compare(readFileSync(join(dest, f.path)), readFileSync(join(caseDir, f.path)))).toBe(0);
  const ledger = Ledger.open(join(dest, "ledger.sqlite"), "CASE-1");
  try {
    expect(ledger.head()).toEqual(m.head);
    expect(ledger.read().length).toBe(3);
  } finally {
    ledger.close();
  }
});

test("a folder holding a symbolic link, or a ledger with a journal beside it, is not packed and nothing is left at dest", async () => {
  const dest = join(root, "out.tar.gz");
  symlinkSync(join(caseDir, "ledger.sqlite"), join(caseDir, "blobs", "x"));
  expect(await refusal(writeCaseFile(caseDir, dest, header))).toBe("blobs/x is a link; a case file holds only regular files");
  expect(existsSync(dest)).toBe(false);
  rmSync(join(caseDir, "blobs", "x"));
  writeFileSync(join(caseDir, "ledger.sqlite-journal"), "half a transaction");
  expect(await refusal(writeCaseFile(caseDir, dest, header))).toBe("the ledger has an unfinished journal");
  expect(existsSync(dest)).toBe(false);
});

test("writeCaseFile refuses a dest that exists", async () => {
  const dest = join(root, "taken.tar.gz");
  writeFileSync(dest, "someone else's file");
  await refusal(writeCaseFile(caseDir, dest, header));
  expect(readFileSync(dest, "utf8")).toBe("someone else's file");
});

test("an archive is refused, and extract leaves no directory, when ...", async () => {
  const { m } = await packed();
  const body = (p: string): Uint8Array => new Uint8Array(readFileSync(join(caseDir, p)));
  const json = JSON.stringify(m);
  const good = (): { name: string; body?: string | Uint8Array; type?: string; link?: string; size?: number }[] =>
    [{ name: "case.json", body: json }, ...m.files.map((f) => ({ name: f.path, body: body(f.path) }))];
  const listing = (extra: { path: string; body: string }[]): string => {
    const files = [...m.files, ...extra.map((e) => ({ path: e.path, sha256: new Bun.CryptoHasher("sha256").update(e.body).digest("hex"), bytes: e.body.length }))];
    return JSON.stringify({ ...m, files: files.sort((a, b) => (a.path < b.path ? -1 : 1)) });
  };
  const blob0 = "blobs/" + blobHashes[0];
  const cases: [string, { name: string; body?: string | Uint8Array; type?: string; link?: string; size?: number }[], string][] = [
    ["the first member is not case.json", [...good().slice(1), good()[0]!], "case.json is not the first member"],
    ["case.json is not JSON", [{ name: "case.json", body: "{not json" }, ...good().slice(1)], "case.json is not a case manifest"],
    ["case.json is not a manifest", [{ name: "case.json", body: JSON.stringify({ ...m, format: 2 }) }, ...good().slice(1)], "case.json is not a case manifest"],
    ["a symlink member", [...good(), { name: "blobs/evil", type: "2", link: "/etc/passwd" }], "blobs/evil is a link; a case file holds only regular files"],
    ["a hard link member", [...good(), { name: "blobs/evil", type: "1", link: "ledger.sqlite" }], "blobs/evil is a link; a case file holds only regular files"],
    ["a directory member", [...good(), { name: "blobs", type: "5" }], "blobs is not a regular file"],
    ["a pax header", [...good(), { name: "PaxHeaders/x", type: "x", body: "30 path=../../etc/passwd\n" }], "PaxHeaders/x is not a regular file"],
    ["a global pax header", [...good(), { name: "pax_global_header", type: "g", body: "" }], "pax_global_header is not a regular file"],
    ["a GNU long name", [...good(), { name: "././@LongLink", type: "L", body: "x".repeat(200) }], "././@LongLink is not a regular file"],
    ["a device", [...good(), { name: "blobs/dev", type: "3" }], "blobs/dev is not a regular file"],
    ["an absolute name", [...good(), { name: "/abs", body: "x" }], "/abs: an absolute path"],
    ["a dot-dot name", [...good(), { name: "../x", body: "x" }], "../x: a path that leaves the case folder"],
    ["a dot-dot inside a name", [...good(), { name: "blobs/../../x", body: "x" }], "blobs/../../x: a path that leaves the case folder"],
    ["a NUL inside a name field", [...good(), { name: "blobs/a\0b", body: "x" }], "blobs/a\uFFFDb: a NUL in a path"],
    ["a member case.json does not list", [...good(), { name: "blobs/extra", body: "x" }], "blobs/extra is not listed in case.json"],
    ["a listed file that is not in the archive", good().filter((g) => g.name !== "ledger.sqlite"), "ledger.sqlite is listed in case.json and is not in the file"],
    ["the same name twice", [...good(), { name: blob0, body: body(blob0) }], `${blob0} appears twice`],
    ["case.json twice", [...good(), { name: "case.json", body: json }], "case.json appears twice"],
    ["a body that differs by one byte", good().map((g) => (g.name === blob0 ? { ...g, body: "rows go herE" } : g)), `${blob0} is not what case.json lists`],
    ["a header size that differs from the manifest's bytes", good().map((g) => (g.name === blob0 ? { ...g, body: "rows go here!" } : g)), `${blob0} is not the size case.json lists`],
    ["a listed file that is also a folder", [{ name: "case.json", body: listing([{ path: "x", body: "1" }, { path: "x/y", body: "2" }]) }, ...good().slice(1), { name: "x", body: "1" }, { name: "x/y", body: "2" }], "case.json is not a case manifest"],
  ];
  for (const [what, members, reason] of cases) {
    const file = join(root, "bad.tar.gz");
    rawCaseFile(file, members);
    const dest = join(root, "out");
    expect({ what, reason: await refusal(checkCaseFile(file)) }).toEqual({ what, reason });
    expect({ what, reason: await refusal(extractCaseFile(file, dest)) }).toEqual({ what, reason });
    expect({ what, left: existsSync(dest) }).toEqual({ what, left: false });
    rmSync(file);
  }
});

test("an archive whose bytes are damaged is not a readable case file, and extract leaves no directory", async () => {
  const { file } = await packed();
  const gz = new Uint8Array(readFileSync(file));
  const tar = gunzipSync(gz);
  const bad = join(root, "bad.tar.gz");
  const dest = join(root, "out");
  const { gzipSync } = await import("node:zlib");
  const damaged: [string, Uint8Array][] = [
    ["a bad header checksum", gzipSync((() => { const t = new Uint8Array(tar); t[0] = "C".charCodeAt(0); return t; })())],
    ["a tar cut short", gzipSync(tar.subarray(0, tar.length - 1024 - 700))],
    ["a gzip stream cut short", gz.subarray(0, Math.floor(gz.length / 2))],
    ["bytes that are not gzip", new TextEncoder().encode("this is not a case file at all")],
    ["no end-of-archive blocks", gzipSync(tar.subarray(0, tar.length - 1024))],
    ["data after the end of the archive", gzipSync(new Uint8Array([...tar, ...new TextEncoder().encode("trailing")]))],
    ["an empty file", new Uint8Array(0)],
  ];
  for (const [what, bytes] of damaged) {
    writeFileSync(bad, bytes);
    expect({ what, reason: await refusal(checkCaseFile(bad)) }).toEqual({ what, reason: "the file is not a readable case file" });
    expect({ what, reason: await refusal(extractCaseFile(bad, dest)) }).toEqual({ what, reason: "the file is not a readable case file" });
    expect({ what, left: existsSync(dest) }).toEqual({ what, left: false });
  }
  // a file that is not there is not called unreadable: it is not there
  expect(await refusal(checkCaseFile(join(root, "missing.tar.gz")))).toBe("there is no file there");
});

test("a file over the size cap is refused from its headers, before the body is read, and by the bytes that come out", async () => {
  const { file, m } = await packed();
  const limit = "the case is larger than the limit of 1000 bytes";
  expect(await refusal(checkCaseFile(file, { max_bytes: 1000 }))).toBe(limit);
  expect(await refusal(extractCaseFile(file, join(root, "out"), { max_bytes: 1000 }))).toBe(limit);
  expect(existsSync(join(root, "out"))).toBe(false);
  expect(await checkCaseFile(file, { max_bytes: 1_000_000 })).toEqual(m);
  // A header that says 3 GB with no body behind it: refused by the header alone, not as a file cut short.
  const json = JSON.stringify(m);
  const huge = join(root, "huge.tar.gz");
  rawCaseFile(huge, [{ name: "case.json", body: json }, { name: "blobs/" + blobHashes[0], size: 3_000_000_000 }]);
  expect(await refusal(checkCaseFile(huge))).toBe("the case is larger than the limit of 2147483648 bytes");
  // A header that says size 10 over a longer body that gzip makes from almost nothing: refused by the bytes that come out of gzip.
  const tiny = { ...m, files: [{ path: "blobs/small", sha256: new Bun.CryptoHasher("sha256").update(new Uint8Array(10)).digest("hex"), bytes: 10 }] };
  const bomb = join(root, "bomb.tar.gz");
  rawCaseFile(bomb, [{ name: "case.json", body: JSON.stringify(tiny) }, { name: "blobs/small", size: 10, body: new Uint8Array(1 << 20) }]);
  expect(readFileSync(bomb).length).toBeLessThan(4096);
  expect(await refusal(checkCaseFile(bomb, { max_bytes: 100_000 }))).toBe("the case is larger than the limit of 100000 bytes");
  expect(await refusal(extractCaseFile(bomb, join(root, "out"), { max_bytes: 100_000 }))).toBe("the case is larger than the limit of 100000 bytes");
  expect(existsSync(join(root, "out"))).toBe(false);
});

test("checkCaseFile writes nothing: the directory beside the file is unchanged after a pass and after a refusal", async () => {
  const { file } = await packed();
  const before = snapshot(root);
  await checkCaseFile(file);
  await readManifest(file);
  expect(snapshot(root)).toEqual(before);
  await refusal(checkCaseFile(file, { max_bytes: 1000 }));
  expect(snapshot(root)).toEqual(before);
});

test("extractCaseFile refuses a destination that exists and leaves it as it was", async () => {
  const { file } = await packed();
  const dest = join(root, "out");
  mkdirSync(dest);
  writeFileSync(join(dest, "mine"), "keep");
  await refusal(extractCaseFile(file, dest));
  expect(readdirSync(dest)).toEqual(["mine"]);
});

test("readManifest reads the first member alone and refuses a file whose first member is not case.json", async () => {
  const { m } = await packed();
  // Only case.json and garbage after it: readManifest does not read that far.
  const file = join(root, "head-only.tar.gz");
  rawCaseFile(file, [{ name: "case.json", body: JSON.stringify(m) }, { name: "../x", type: "2" }]);
  expect(await readManifest(file)).toEqual(m);
  rawCaseFile(file, [{ name: "ledger.sqlite", body: "x" }]);
  expect(await refusal(readManifest(file))).toBe("case.json is not the first member");
});

test("a path longer than the name field goes in the prefix field, and one that fits neither is not packed", async () => {
  const deep = join("published", "1", "d".repeat(60), "e".repeat(60));
  mkdirSync(join(caseDir, deep), { recursive: true });
  writeFileSync(join(caseDir, deep, "notes.md"), "kept");
  const { file, m } = await packed();
  expect(m.files.some((f) => f.path === `${deep}/notes.md`)).toBe(true);
  const dest = join(root, "out");
  await extractCaseFile(file, dest);
  expect(readFileSync(join(dest, deep, "notes.md"), "utf8")).toBe("kept");
  writeFileSync(join(caseDir, "published", "1", "f".repeat(101)), "too long a name");
  const again = join(root, "again.tar.gz");
  expect(await refusal(writeCaseFile(caseDir, again, header))).toBe(`published/1/${"f".repeat(101)} is too long a path for a case file`);
  expect(existsSync(again)).toBe(false);
});
