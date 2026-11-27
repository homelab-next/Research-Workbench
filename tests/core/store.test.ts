import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaseFileError, writeCaseFile } from "../../src/core/casefile";
import type { CaseManifest, ManifestHeader } from "../../src/core/casefile";
import { Ledger } from "../../src/core/ledger";
import { CaseStoreFolder, STORE_FILE, matchesSearch } from "../../src/core/store";

let root: string;
let store: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "store-"));
  store = join(root, "store");
  mkdirSync(store);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Spec { id: string; title: string; asked: string; marking?: "TLP:AMBER" | "TLP:GREEN" | "TLP:RED"; value: string; ts: string }

/** A synthetic case folder with a real ledger of two entries, packed into the store with writeCaseFile. */
async function pack(s: Spec, dir = store): Promise<{ file: string; path: string; m: CaseManifest }> {
  const caseDir = join(root, "work", s.id);
  rmSync(caseDir, { recursive: true, force: true });
  mkdirSync(caseDir, { recursive: true });
  let tick = 0;
  const ledger = Ledger.open(join(caseDir, "ledger.sqlite"), s.id, { now: () => new Date(Date.UTC(2026, 10, 27, 9, 0, tick++)).toISOString() });
  const human = { kind: "human", id: "analyst" } as const;
  const first = ledger.append({ type: "case.phase_changed", payload: { phase: "collect" }, actor: human });
  const last = ledger.append({ type: "case.phase_changed", payload: { phase: "analyse" }, actor: human });
  ledger.close();
  const marking = s.marking ?? "TLP:AMBER";
  const header: ManifestHeader = {
    id: s.id, chain: s.id, origin: first.hash, title: s.title, asked: s.asked, marking, starting: [{ type: "ip", value: s.value }],
    status: "published", outcome: "published", published: [], head: { seq: last.seq, hash: last.hash }, entries: 2, unloaded_ts: s.ts,
  };
  const file = `${s.id}.${marking.replace(/[^A-Za-z0-9+_-]/g, "-")}.tar.gz`;
  const path = join(dir, file);
  return { file, path, m: await writeCaseFile(caseDir, path, header) };
}

const ONE: Spec = { id: "CASE-1", title: "Beacon from a lab host", asked: "Is 192.0.2.10 beaconing to example.com?", value: "192.0.2.10", ts: "2026-11-27T10:00:00.000Z" };
const TWO: Spec = { id: "CASE-2", title: "Odd traffic from the printer", asked: "Who is behind the scans of 203.0.113.5?", marking: "TLP:GREEN", value: "198.51.100.77", ts: "2026-11-26T10:00:00.000Z" };
const THREE: Spec = { id: "CASE-3", title: "Logins at night", asked: "Are the logins on host-a.example.net expected?", value: "host-a.example.net", ts: "2026-11-27T11:00:00.000Z" };

async function refusal(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    if (err instanceof CaseFileError) return err.reasons[0]!;
    throw err;
  }
  throw new Error("expected a refusal");
}

test("list reads each file's case.json without unpacking it, newest unload first", async () => {
  await pack(ONE);
  const two = await pack(TWO);
  const three = await pack(THREE);
  // CASE-2's tail is cut off after the first member: its case.json is whole, so it still lists.
  const tar = gunzipSync(readFileSync(two.path));
  const size = parseInt(new TextDecoder().decode(tar.subarray(124, 135)), 8);
  writeFileSync(two.path, gzipSync(tar.subarray(0, 512 + Math.ceil(size / 512) * 512)));
  const before = readdirSync(store).sort();
  const listing = await new CaseStoreFolder(store).list();
  expect(listing.cases.map((c) => c.manifest.id)).toEqual(["CASE-3", "CASE-1", "CASE-2"]);
  expect(listing.cases[0]!.bytes).toBe(statSync(three.path).size);
  expect(listing.cases[0]!.file).toBe("CASE-3.TLP-AMBER.tar.gz");
  expect(listing.cases[0]!.manifest).toEqual(three.m);
  expect(listing.unreadable).toEqual([]);
  expect(listing.leftovers).toEqual([]);
  // nothing was unpacked or written
  expect(readdirSync(store).sort()).toEqual(before);
});

test("a file named like a case file that is not one is listed as unreadable with its reason; other files, dot-files and folders are ignored; a .part file is a leftover", async () => {
  await pack(ONE);
  writeFileSync(join(store, "CASE-4.TLP-RED.tar.gz"), "not a gzip stream");
  writeFileSync(join(store, "notes.txt"), "hello");
  writeFileSync(join(store, ".hidden.tar.gz"), "x");
  writeFileSync(join(store, "deleted.log"), "");
  mkdirSync(join(store, "CASE-5.TLP-RED.tar.gz"));
  mkdirSync(join(store, "old"));
  writeFileSync(join(store, ".tmp-CASE-6-123-abc.part"), "half");
  const listing = await new CaseStoreFolder(store).list();
  expect(listing.cases.map((c) => c.file)).toEqual(["CASE-1.TLP-AMBER.tar.gz"]);
  expect(listing.unreadable).toEqual([{ file: "CASE-4.TLP-RED.tar.gz", reason: "the file is not a readable case file" }]);
  expect(listing.leftovers).toEqual([".tmp-CASE-6-123-abc.part"]);
});

test("a file whose name does not match its case.json is unreadable", async () => {
  const one = await pack(ONE);
  const renamed = join(store, "CASE-8.TLP-AMBER.tar.gz");
  writeFileSync(renamed, readFileSync(one.path));
  rmSync(one.path);
  const listing = await new CaseStoreFolder(store).list();
  expect(listing.cases).toEqual([]);
  expect(listing.unreadable).toEqual([{ file: "CASE-8.TLP-AMBER.tar.gz", reason: "its name does not match its case.json (CASE-1, TLP:AMBER)" }]);
});

test("search matches the id, the title, the question and a starting observable's value, ignoring case", async () => {
  await pack(ONE); await pack(TWO); await pack(THREE);
  const folder = new CaseStoreFolder(store);
  const ids = async (text: string) => (await folder.list(text)).cases.map((c) => c.manifest.id);
  expect(await ids("case-2")).toEqual(["CASE-2"]);
  expect(await ids("printer")).toEqual(["CASE-2"]);
  expect(await ids("who is behind")).toEqual(["CASE-2"]);
  expect(await ids("198.51.100.77")).toEqual(["CASE-2"]);
  expect(await ids("HOST-A")).toEqual(["CASE-3"]);
  expect(await ids("zzz")).toEqual([]);
  expect(await ids("")).toEqual(["CASE-3", "CASE-1", "CASE-2"]);
  const m = (await folder.list()).cases[0]!.manifest;
  expect(matchesSearch(m, "")).toBe(true);
  expect(matchesSearch(m, "NIGHT")).toBe(true);
  expect(matchesSearch(m, "TLP")).toBe(false);
});

test("a store folder that does not exist lists nothing and has seen no number", async () => {
  const missing = join(root, "nowhere", "store");
  const folder = new CaseStoreFolder(missing);
  const errors: unknown[] = [];
  expect(await folder.list()).toEqual({ cases: [], unreadable: [], leftovers: [] });
  expect(folder.seenNumbers((e) => errors.push(e))).toEqual([]);
  expect(errors).toEqual([]);
  expect(folder.name).toBe("store");
  expect(existsSync(missing)).toBe(false);
  expect(existsSync(join(root, "nowhere"))).toBe(false);
});

test("find takes a case id or a file name; none and two are refused with their reason", async () => {
  const one = await pack(ONE);
  const folder = new CaseStoreFolder(store);
  expect((await folder.find("CASE-1")).manifest).toEqual(one.m);
  expect((await folder.find("CASE-1.TLP-AMBER.tar.gz")).manifest).toEqual(one.m);
  expect(await refusal(folder.find("CASE-9"))).toBe("the store holds no file for CASE-9");
  expect(await refusal(folder.find("CASE-9.TLP-RED.tar.gz"))).toBe("the store holds no file CASE-9.TLP-RED.tar.gz");
  // the same case under a second marking: two files for one id
  await pack({ ...ONE, marking: "TLP:RED" });
  expect(await refusal(folder.find("CASE-1"))).toBe("the store holds more than one file for CASE-1: CASE-1.TLP-AMBER.tar.gz, CASE-1.TLP-RED.tar.gz");
  writeFileSync(join(store, "CASE-4.TLP-RED.tar.gz"), "junk");
  expect(await refusal(folder.find("CASE-4.TLP-RED.tar.gz"))).toBe("CASE-4.TLP-RED.tar.gz: the file is not a readable case file");
  expect(await refusal(folder.find("../CASE-1.TLP-AMBER.tar.gz"))).toBe("../CASE-1.TLP-AMBER.tar.gz is not a case id or the name of a file in the store");
});

test("path refuses a name with a separator, a leading dot, or another extension", async () => {
  const folder = new CaseStoreFolder(store);
  expect(folder.path("CASE-1.TLP-AMBER.tar.gz")).toBe(join(store, "CASE-1.TLP-AMBER.tar.gz"));
  for (const bad of ["../x.tar.gz", "a/b.tar.gz", "a\\b.tar.gz", ".x.tar.gz", "x.zip", "", "..", "x.tar.gz\n"]) {
    expect(await refusal(() => folder.path(bad))).toBe(`${bad.replace(/\n/g, "�")} is not the name of a file in the store`);
  }
  expect(STORE_FILE.test("CASE-12.TLP-AMBER+STRICT.tar.gz")).toBe(true);
});

test("seenNumbers reads the names and deleted.log and unpacks nothing", () => {
  writeFileSync(join(store, "CASE-2.TLP-GREEN.tar.gz"), "");
  writeFileSync(join(store, "CASE-7.TLP-RED.tar.gz"), "");
  writeFileSync(join(store, "notes.txt"), "CASE-40");
  writeFileSync(join(store, "deleted.log"), '{"file":"CASE-9.TLP-AMBER.tar.gz","head":"x","id":"CASE-9","title":"t","when":"w","who":"analyst"}\nnot json\n{"id":"case-11"}\n');
  const errors: unknown[] = [];
  expect(new CaseStoreFolder(store).seenNumbers((e) => errors.push(e)).sort((a, b) => a - b)).toEqual([2, 7, 9]);
  // a line that is not JSON is passed over; an id that is not CASE- and one to nine digits is reported and not counted
  expect(errors.map(String)).toEqual(["CaseFileError: the case store's deleted.log names case-11, which is not a case id; it is not counted"]);
});

test("seenNumbers reports a store that cannot be read and returns []", () => {
  const notADir = join(root, "file");
  writeFileSync(notADir, "x");
  const errors: unknown[] = [];
  expect(new CaseStoreFolder(notADir).seenNumbers((e) => errors.push(e))).toEqual([]);
  expect(errors.length).toBe(1);
  expect(new CaseStoreFolder(notADir).seenNumbers()).toEqual([]);
});

test("delete refuses a typed id that is not the file's, an empty one, and a file that is not there; the file stays and nothing is logged", async () => {
  const two = await pack(TWO);
  const folder = new CaseStoreFolder(store);
  const bytes = readFileSync(two.path);
  for (const typed of ["CASE-3", "", "case-2", " CASE-2"]) {
    expect(await refusal(folder.delete(two.file, typed, "analyst", "2026-11-27T12:00:00.000Z"))).toBe("type CASE-2 to delete its file");
  }
  expect(await refusal(folder.delete("CASE-9.TLP-RED.tar.gz", "CASE-9", "analyst", "2026-11-27T12:00:00.000Z"))).toBe("the store holds no file CASE-9.TLP-RED.tar.gz");
  expect(await refusal(folder.delete("../CASE-2.TLP-GREEN.tar.gz", "CASE-2", "analyst", "2026-11-27T12:00:00.000Z"))).toBe("../CASE-2.TLP-GREEN.tar.gz is not the name of a file in the store");
  expect(readFileSync(two.path)).toEqual(bytes);
  expect(existsSync(join(store, "deleted.log"))).toBe(false);
});

test("delete appends one line to deleted.log (id, title, head, when, who, file) and removes the file; a title with a newline is still one line", async () => {
  const one = await pack(ONE);
  const two = await pack({ ...TWO, title: "Odd traffic\nfrom the printer" });
  const folder = new CaseStoreFolder(store);
  await folder.delete(two.file, "CASE-2", "analyst", "2026-11-27T12:00:00.000Z");
  await folder.delete(one.file, "CASE-1", "analyst", "2026-11-27T12:01:00.000Z");
  expect(existsSync(two.path)).toBe(false);
  expect(existsSync(one.path)).toBe(false);
  const lines = readFileSync(join(store, "deleted.log"), "utf8").split("\n");
  expect(lines.length).toBe(3);
  expect(lines[2]).toBe("");
  expect(JSON.parse(lines[0]!)).toEqual({ id: "CASE-2", title: "Odd traffic\nfrom the printer", head: two.m.head.hash, when: "2026-11-27T12:00:00.000Z", who: "analyst", file: two.file });
  expect(lines[0]).toBe(`{"file":"${two.file}","head":"${two.m.head.hash}","id":"CASE-2","title":"Odd traffic\\nfrom the printer","when":"2026-11-27T12:00:00.000Z","who":"analyst"}`);
  expect(JSON.parse(lines[1]!).id).toBe("CASE-1");
  expect((await folder.list()).cases).toEqual([]);
});

test("an id deleted from the store is still seen", async () => {
  const two = await pack(TWO);
  const folder = new CaseStoreFolder(store);
  expect(folder.seenNumbers()).toEqual([2]);
  await folder.delete(two.file, "CASE-2", "analyst", "2026-11-27T12:00:00.000Z");
  expect(readdirSync(store)).toEqual(["deleted.log"]);
  expect(folder.seenNumbers()).toContain(2);
});
