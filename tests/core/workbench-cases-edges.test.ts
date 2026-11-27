// The edges of unload and load the final review of slice 11 found: what an unload may replace, where it may write, how large an id may be,
// and what an untrusted ledger.sqlite or case.json can still say after the checks.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { CaseFileError, extractCaseFile, readManifest, writeCaseFile } from "../../src/core/casefile";
import type { CaseManifest, ManifestHeader } from "../../src/core/casefile";
import { rawCaseFile } from "../helpers/tar";
import type { CaseSession } from "../../src/core/session";
import type { Actor } from "../../src/core/types";
import { CaseRefused, Workbench } from "../../src/core/workbench";
import type { NewCase } from "../../src/core/workbench";

const person: Actor = { kind: "human", id: "analyst" };
const colleague: Actor = { kind: "human", id: "colleague" };
const code: Actor = { kind: "system", id: "workbench" };
const sample: NewCase = {
  title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [{ type: "ip", value: "198.51.100.77" }],
  window: { from: null, to: null }, objective: null, marking: "TLP:AMBER",
};
const FILE = "CASE-1.TLP-AMBER.tar.gz";

let dir: string;
let wb: Workbench;
let tick = 0;
const errors: unknown[] = [];
const onError = (e: unknown) => void errors.push(e);
const now = () => new Date(Date.parse("2026-11-27T09:00:00.000Z") + tick++ * 1000).toISOString();
const openWb = (over: Parameters<typeof Workbench.open>[1] = {}): Workbench => Workbench.open(join(dir, "wb"), { store: join(dir, "store"), now, onError, ...over });
const cases = (): string => join(dir, "wb", "cases");
const ls = (d: string): string[] => (existsSync(d) ? readdirSync(d).sort() : []);
const note = (s: CaseSession, text: string): void => void s.commit(() => [{ type: "feedback.recorded", payload: { measure: "m", kind: "mop", value: 1, note: text }, actor: person }]);
const refusalOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-edges-"));
  tick = 0;
  errors.length = 0;
  wb = openWb();
});
afterEach(() => {
  try { wb.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

/** Another workbench, its own data folder, whose CASE-1 is another case, unloaded to `to` (or its own store). */
async function theirCase(to: string | undefined, title = "B's case"): Promise<void> {
  const other = Workbench.open(join(dir, "other"), { store: join(dir, "other-store"), now, onError });
  try {
    other.createCase({ ...sample, title }, colleague);
    const r = await other.unloadCase("CASE-1", { actor: colleague, ...(to === undefined ? {} : { to }) });
    if (!r.ok) throw new Error(r.reason);
  } finally {
    other.close();
  }
}

// ---------- C1: what an unload may replace ----------

test("an unload does not replace another case's file of the same id: it is refused, nothing is written, and the other file is kept", async () => {
  const shared = join(dir, "shared");
  await theirCase(shared, "A's case");
  const theirs = readFileSync(join(shared, FILE));
  const s = wb.createCase({ ...sample, title: "B's case" }, person);
  const head = s.head();
  const err = await refusalOf(wb.unloadCase("CASE-1", { actor: person, to: shared }));
  expect(err).toBeInstanceOf(CaseRefused);
  expect((err as CaseRefused).message).toBe(`the folder shared already holds ${FILE}, which is another case with the id CASE-1; it is not replaced`);
  expect(readFileSync(join(shared, FILE))).toEqual(theirs);
  expect((await readManifest(join(shared, FILE))).title).toBe("A's case");
  expect(ls(shared)).toEqual([FILE]);
  expect(wb.session("CASE-1").head()).toEqual(head);
  expect(ls(cases())).toEqual([".high-water", "CASE-1"]);
});

test("the same with no to: two workbenches sharing one store both made CASE-1 while it was empty", async () => {
  wb.createCase(sample, person);
  await theirCase(join(dir, "store"));
  const err = await refusalOf(wb.unloadCase("CASE-1", { actor: person }));
  expect(err).toBeInstanceOf(CaseRefused);
  expect((await readManifest(join(dir, "store", FILE))).title).toBe("B's case");
  expect(wb.session("CASE-1").entries().map((e) => e.type)).toEqual(["case.created"]);
});

test("a file of the same case whose record is not an earlier part of this one is not replaced either", async () => {
  const s = wb.createCase(sample, person);
  note(s, "one");
  const kept = join(dir, "kept");
  cpSync(s.dir, kept, { recursive: true });
  note(s, "two");
  const r = await wb.unloadCase("CASE-1", { actor: person });
  if (!r.ok) throw new Error(r.reason);
  const stored = readFileSync(r.path);
  // an older copy of the folder comes back and goes another way
  wb.close();
  cpSync(kept, join(cases(), "CASE-1"), { recursive: true });
  wb = openWb();
  note(wb.session("CASE-1"), "another two");
  const err = await refusalOf(wb.unloadCase("CASE-1", { actor: person }));
  expect(err).toBeInstanceOf(CaseRefused);
  expect((err as CaseRefused).message).toBe(`the folder store already holds ${FILE}, whose record of CASE-1 is not an earlier part of this one; it is not replaced`);
  expect(readFileSync(r.path)).toEqual(stored);
  expect(wb.session("CASE-1").entries().at(-1)!.type).toBe("feedback.recorded");
});

test("a file in the way that cannot be read as a case file is not replaced", async () => {
  wb.createCase(sample, person);
  mkdirSync(join(dir, "store"));
  writeFileSync(join(dir, "store", FILE), "not a case file");
  const err = await refusalOf(wb.unloadCase("CASE-1", { actor: person }));
  expect(err).toBeInstanceOf(CaseRefused);
  expect((err as CaseRefused).message).toBe(`the folder store already holds ${FILE}, which cannot be read as a case file (the file is not a readable case file); it is not replaced`);
  expect(readFileSync(join(dir, "store", FILE), "utf8")).toBe("not a case file");
});

test("another case's file put there while the unload is packing is not replaced: the unload fails and is recorded", async () => {
  const other = join(dir, "theirs");
  await theirCase(other);
  const theirs = readFileSync(join(other, FILE));
  wb.close();
  wb = openWb({ beforeUnloadStep: (step) => { if (step === "store") writeFileSync(join(dir, "store", FILE), theirs); } });
  wb.createCase(sample, person);
  const r = await wb.unloadCase("CASE-1", { actor: person });
  if (r.ok) throw new Error("unloaded over another case's file");
  expect(r.reason).toBe(`the case file could not be put in the store: the folder store already holds ${FILE}, which is another case with the id CASE-1; it is not replaced`);
  expect(readFileSync(join(dir, "store", FILE))).toEqual(theirs);
  expect(ls(join(dir, "store"))).toEqual([FILE]);
  const s = wb.session("CASE-1");
  expect(s.entries().map((e) => e.type)).toEqual(["case.created", "case.unloaded", "case.unload_failed"]);
  expect(s.state.skipped).toEqual([]);
});

test("the file of an unload that stopped after the store, one entry behind, is still replaced by the next unload", async () => {
  wb.close();
  wb = openWb({ beforeUnloadStep: (step) => { if (step === "leave") throw new Error("the stop"); } });
  wb.createCase(sample, person);
  expect((await wb.unloadCase("CASE-1", { actor: person })).ok).toBe(false);
  wb.close();
  wb = openWb();
  const r = await wb.unloadCase("CASE-1", { actor: person });
  if (!r.ok) throw new Error(r.reason);
  // created, unloaded, unload_failed, unloaded
  expect((await readManifest(r.path)).entries).toBe(4);
});

// ---------- I1: where an unload may write ----------

test("an unload to a folder inside the case's own folder, or anywhere in cases/, is refused and writes nothing", async () => {
  const s = wb.createCase(sample, person);
  const head = s.head();
  for (const to of [join(cases(), "CASE-1"), join(cases(), "CASE-1", "published"), join(cases(), "CASE-1", "blobs", "new"), cases(), join(cases(), "elsewhere")]) {
    const err = await refusalOf(wb.unloadCase("CASE-1", { actor: person, to }));
    expect(err).toBeInstanceOf(CaseRefused);
    expect((err as CaseRefused).message).toBe("a case file may not be written inside the data folder's cases folder; choose a folder outside it");
  }
  expect(wb.session("CASE-1").head()).toEqual(head);
  expect(ls(join(cases(), "CASE-1"))).toEqual(["blobs", "ledger.sqlite", "published"]);
  expect(ls(join(cases(), "CASE-1", "published"))).toEqual([]);
  expect(ls(cases())).toEqual([".high-water", "CASE-1"]);
});

test("a case store configured inside cases/, or reached there through a link, is refused the same way", async () => {
  wb.close();
  wb = openWb({ store: join(cases(), "CASE-1", "published") });
  wb.createCase(sample, person);
  expect(await refusalOf(wb.unloadCase("CASE-1", { actor: person }))).toBeInstanceOf(CaseRefused);
  symlinkSync(join(cases(), "CASE-1"), join(dir, "through"));
  const err = await refusalOf(wb.unloadCase("CASE-1", { actor: person, to: join(dir, "through", "x") }));
  expect(err).toBeInstanceOf(CaseRefused);
  expect(wb.session("CASE-1").entries().map((e) => e.type)).toEqual(["case.created"]);
  // a folder beside cases/ in the data folder is not inside it
  const r = await wb.unloadCase("CASE-1", { actor: person, to: join(dir, "wb", "cases-out") });
  expect(r.ok).toBe(true);
});

// ---------- I2: an id is CASE- and one to nine digits, everywhere ----------

const mark = (): string => readFileSync(join(cases(), ".high-water"), "utf8").trim();

test("a store name with the largest number leaves no id to give: a new case is refused and nothing is made", () => {
  wb.createCase(sample, person);
  mkdirSync(join(dir, "store"));
  writeFileSync(join(dir, "store", "CASE-999999999.TLP-CLEAR.tar.gz"), "junk");
  const err = (() => { try { wb.createCase(sample, person); return null; } catch (e) { return e; } })();
  expect(err).toBeInstanceOf(CaseRefused);
  expect((err as CaseRefused).message).toBe("every case id up to CASE-999999999 has been given out here; no new case can be made");
  expect(ls(cases())).toEqual([".high-water", "CASE-1"]);
  expect(mark()).toBe("1");
  expect(wb.listCases().map((c) => c.id)).toEqual(["CASE-1"]);
});

test("a store name or a deleted.log id of ten or more digits is not an id: the counter ignores it, the listing shows it as unreadable, and it is reported", async () => {
  mkdirSync(join(dir, "store"));
  for (const n of ["CASE-1000000000.TLP-CLEAR.tar.gz", "CASE-99999999999999999999999.TLP-CLEAR.tar.gz", "CASE-0012.TLP-CLEAR.tar.gz"]) writeFileSync(join(dir, "store", n), "junk");
  writeFileSync(join(dir, "store", "deleted.log"), `${JSON.stringify({ id: "CASE-5000000000" })}\n${JSON.stringify({ id: "CASE-1e+23" })}\n${JSON.stringify({ id: "CASE-3" })}\n`);
  const s = wb.createCase(sample, person);
  expect(s.id).toBe("CASE-4");
  expect(wb.session("CASE-4").state.meta?.title).toBe("Sample");
  expect(wb.listCases().map((c) => c.id)).toEqual(["CASE-4"]);
  expect(wb.createCase(sample, person).id).toBe("CASE-5");
  expect(mark()).toBe("5");
  expect(ls(cases())).toEqual([".high-water", "CASE-4", "CASE-5"]);
  expect(errors.map(String).sort()).toEqual([
    "CaseFileError: the case store holds CASE-0012.TLP-CLEAR.tar.gz, which is not a case file's name (CASE-<1 to 9 digits>.<marking>.tar.gz); its number is not counted",
    "CaseFileError: the case store holds CASE-1000000000.TLP-CLEAR.tar.gz, which is not a case file's name (CASE-<1 to 9 digits>.<marking>.tar.gz); its number is not counted",
    "CaseFileError: the case store holds CASE-99999999999999999999999.TLP-CLEAR.tar.gz, which is not a case file's name (CASE-<1 to 9 digits>.<marking>.tar.gz); its number is not counted",
    "CaseFileError: the case store's deleted.log names CASE-1e+23, which is not a case id; it is not counted",
    "CaseFileError: the case store's deleted.log names CASE-5000000000, which is not a case id; it is not counted",
  ].flatMap((e) => [e, e]).sort());
  const listing = await wb.store.list();
  expect(listing.unreadable.map((u) => u.file).sort()).toEqual(["CASE-0012.TLP-CLEAR.tar.gz", "CASE-1000000000.TLP-CLEAR.tar.gz", "CASE-99999999999999999999999.TLP-CLEAR.tar.gz"]);
  expect(listing.unreadable[0]!.reason).toBe("its name is not a case file's name (CASE-<1 to 9 digits>.<marking>.tar.gz)");
});

test("a case file whose case.json names a ten-digit id is refused as not a case manifest", async () => {
  const s = wb.createCase(sample, person);
  void s;
  const r = await wb.unloadCase("CASE-1", { actor: person });
  if (!r.ok) throw new Error(r.reason);
  const m = await readManifest(r.path);
  const ten = join(dir, "ten.tar.gz");
  rawCaseFile(ten, [{ name: "case.json", body: JSON.stringify({ ...m, id: "CASE-1000000000", chain: "CASE-1000000000" }) }]);
  const err = await refusalOf(wb.loadCase(ten, { actor: person }));
  expect((err as Error).message).toBe("case.json is not a case manifest");
  expect(ls(cases())).toEqual([".high-water"]);
});

// ---------- I3: the ledger a load takes in is exactly the one the workbench writes ----------

/** Rewrites a case file from a changed copy of its folder, every hash made again, with the header given (default: the file's own). */
async function repack(file: string, change: (folder: string) => void, header: (m: CaseManifest) => ManifestHeader = (m) => m): Promise<string> {
  const folder = join(dir, `repack-${tick++}`);
  const m = await extractCaseFile(file, folder);
  change(folder);
  const out = join(dir, `repacked-${tick++}.tar.gz`);
  const { format: _f, workbench: _w, files: _files, ...rest } = header(m) as CaseManifest;
  await writeCaseFile(folder, out, rest);
  rmSync(folder, { recursive: true });
  return out;
}
const sql = (folder: string, text: string): void => {
  const db = new Database(join(folder, "ledger.sqlite"));
  try { db.exec(text); } finally { db.close(); }
};
async function unloadedFileOf(id: string): Promise<string> {
  const r = await wb.unloadCase(id, { actor: person });
  if (!r.ok) throw new Error(r.reason);
  return r.path;
}
async function unloadedFile(): Promise<string> {
  note(wb.createCase(sample, person), "one");
  return unloadedFileOf("CASE-1");
}
async function expectRefusedLoad(file: string, text: string): Promise<void> {
  const before = ls(cases());
  const err = await refusalOf(wb.loadCase(file, { actor: person }));
  expect(err).toBeInstanceOf(CaseFileError);
  expect((err as Error).message).toBe(text);
  expect(ls(cases())).toEqual(before);
}

test("a ledger with a trigger that would change the case as its load is recorded is refused, and nothing is loaded", async () => {
  const file = await unloadedFile();
  const poisoned = await repack(file, (folder) => sql(folder,
    "CREATE TRIGGER t AFTER INSERT ON entries BEGIN UPDATE entries SET payload = replace(payload, 'Sample', 'TAMPERED') WHERE seq = 1; END;"));
  rmSync(file);
  await expectRefusedLoad(poisoned, "the case's ledger is not one this workbench writes: it holds a trigger");
  expect(ls(cases())).toEqual([".high-water"]);
});

test("a ledger with a view, a table or an index the workbench does not make is refused", async () => {
  const file = await unloadedFile();
  for (const [change, what] of [
    ["CREATE VIEW v AS SELECT * FROM entries;", "it holds a view"],
    ["CREATE TABLE extra (x);", "its tables are not the ledger's"],
    ["CREATE INDEX i ON entries (type);", "its tables are not the ledger's"],
    ["DROP TABLE meta; CREATE TABLE meta (key TEXT, value TEXT);", "its tables are not the ledger's"],
  ] as const) {
    await expectRefusedLoad(await repack(file, (folder) => sql(folder, change)), `the case's ledger is not one this workbench writes: ${what}`);
  }
});

// ---------- I4: case.json says what its ledger says ----------

test("a case.json whose title, question, marking, starting values, status, outcome or products are not its ledger's is refused on load", async () => {
  const file = await unloadedFile();
  const d = "d".repeat(64);
  const lies: [(m: CaseManifest) => ManifestHeader, string][] = [
    [(m) => ({ ...m, title: "Benign", marking: "TLP:CLEAR", starting: [], published: [{ n: 1, draft_hash: d }] }), "title, marking, starting, published"],
    [(m) => ({ ...m, asked: "Nothing to see" }), "asked"],
    [(m) => ({ ...m, status: "finished" }), "status"],
    [(m) => ({ ...m, outcome: "published" }), "outcome"],
  ];
  for (const [lie, fields] of lies) {
    await expectRefusedLoad(await repack(file, () => {}, lie), `case.json does not say what its ledger says (${fields}); this file cannot be loaded`);
  }
  // the file as it was still loads
  expect((await wb.loadCase(file, { actor: person })).session.state.meta?.marking).toBe("TLP:AMBER");
});

test("the checked store listing shows such a file as unreadable, with the reason, and lists the honest one", async () => {
  const file = await unloadedFile();
  const lying = await repack(file, () => {}, (m) => ({ ...m, id: "CASE-1", title: "Benign", marking: "TLP:CLEAR" }));
  cpSync(lying, join(dir, "store", "CASE-1.TLP-CLEAR.tar.gz"));
  const before = ls(join(dir, "store"));
  const plain = await wb.store.list();
  expect(plain.cases.map((c) => c.file).sort()).toEqual(["CASE-1.TLP-AMBER.tar.gz", "CASE-1.TLP-CLEAR.tar.gz"]);
  const checked = await wb.checkedStore();
  expect(checked.cases.map((c) => c.file)).toEqual(["CASE-1.TLP-AMBER.tar.gz"]);
  expect(checked.unreadable).toEqual([{ file: "CASE-1.TLP-CLEAR.tar.gz", reason: "case.json does not say what its ledger says (title, marking)" }]);
  // asked again, the same answer (from what was learned the first time) and nothing written
  expect(await wb.checkedStore()).toEqual(checked);
  expect(ls(join(dir, "store"))).toEqual(before);
  expect(ls(cases())).toEqual([".high-water"]);
  // a search applies to what is listed
  expect((await wb.checkedStore("benign")).cases).toEqual([]);
});

// ---------- I5: the tests the surviving mutants showed were missing ----------

test("a data folder from before slice 11 (cases, no mark, no store) gives the next id, and its cases are untouched", () => {
  const one = wb.createCase(sample, person);
  note(one, "kept");
  const two = wb.createCase(sample, person);
  const heads = [one.head(), two.head()];
  wb.close();
  rmSync(join(cases(), ".high-water"));
  wb = openWb();
  expect(wb.createCase(sample, person).id).toBe("CASE-3");
  expect([wb.session("CASE-1").head(), wb.session("CASE-2").head()]).toEqual(heads);
  expect(wb.session("CASE-1").state.skipped).toEqual([]);
});

test("while a case is packed, session(id) is refused: nothing can write to the ledger being packed", async () => {
  let during: unknown = null;
  wb.close();
  wb = openWb({ beforeUnloadStep: (step) => { if (step === "write") { try { wb.session("CASE-1"); } catch (e) { during = e; } } } });
  wb.createCase(sample, person);
  const r = await wb.unloadCase("CASE-1", { actor: person });
  expect(r.ok).toBe(true);
  expect(during).toBeInstanceOf(CaseRefused);
  expect((during as CaseRefused).message).toBe("CASE-1 is being unloaded");
  expect((await readManifest(join(dir, "store", FILE))).entries).toBe(2);
});

test("a special file (a FIFO) in the case folder fails the unload, named, and the case stays loaded", async () => {
  const s = wb.createCase(sample, person);
  const made = Bun.spawnSync(["mkfifo", join(s.dir, "blobs", "pipe")]);
  expect(made.exitCode).toBe(0);
  const r = await wb.unloadCase("CASE-1", { actor: person });
  if (r.ok) throw new Error("unloaded without the FIFO");
  expect(r.reason).toBe("the case file could not be written: blobs/pipe is not a regular file; a case file holds only regular files");
  expect(ls(join(dir, "store"))).toEqual([]);
  expect(wb.session("CASE-1").entries().map((e) => e.type)).toEqual(["case.created", "case.unloaded", "case.unload_failed"]);
});

test("a load whose case.loaded cannot be written leaves no cases/CASE-N and no .loading folder", async () => {
  let broken = false;
  wb.close();
  wb = openWb({ now: () => { if (broken) throw new Error("the clock failed"); return now(); } });
  const file = await unloadedFile();
  broken = true;
  const err = await refusalOf(wb.loadCase(file, { actor: person }));
  expect((err as Error).message).toBe("the clock failed");
  expect(ls(cases())).toEqual([".high-water"]);
  broken = false;
  expect((await wb.loadCase(file, { actor: person })).id).toBe("CASE-1");
});

// ---------- the minor findings ----------

test("M3: the temporary file an unload writes names the case's marking", async () => {
  const parts: string[] = [];
  wb.close();
  wb = openWb({ beforeUnloadStep: (step, part) => { if (step === "check") parts.push(basename(part)); } });
  wb.createCase(sample, person);
  expect((await wb.unloadCase("CASE-1", { actor: person })).ok).toBe(true);
  expect(parts.length).toBe(1);
  expect(parts[0]).toMatch(/^\.tmp-CASE-1\.TLP-AMBER-\d+-[0-9a-f-]{36}\.part$/);
});

test("M4: an unload after publishing that a stop left undone is recorded as failed when the case is next opened, so it is not lost silently", () => {
  const s = wb.createCase(sample, person);
  s.commit((_, ids) => [{ type: "run.started", payload: { run: ids.next("run"), pipeline: "investigate", pipeline_hash: "a".repeat(64), stages: [
    { id: "publish", title: "Publish", phase: "publish", runs: "human", gate: "publish", reviews: false, model: null }] }, actor: code }]);
  s.commit(() => [{ type: "gate.waiting", payload: { gate: "publish" }, actor: code }]);
  s.commit(() => [{ type: "gate.passed", payload: { gate: "publish", unload_after: true }, actor: person }]);
  s.commit(() => [{ type: "run.finished", payload: { outcome: "published" }, actor: code }]);
  expect(s.state.archive.unload_after).toBe(true);
  wb.close(); // the stop, before the host unloaded it
  wb = openWb();
  const back = wb.session("CASE-1");
  expect(back.entries().at(-1)).toMatchObject({ type: "case.unload_failed", actor: { kind: "system", id: "recovery" }, payload: { reason: "the workbench stopped before the case was unloaded after publishing" } });
  expect(back.state.archive.unload_after).toBe(false);
  expect(back.state.skipped).toEqual([]);
  expect(wb.listCases()[0]!.unload_failed).toBe("the workbench stopped before the case was unloaded after publishing");
  wb.close();
  wb = openWb();
  expect(wb.session("CASE-1").entries().filter((e) => e.type === "case.unload_failed").length).toBe(1);
});

/** A case file made by hand from a case folder's files and a case.json from `m`, with `extra` members listed in it too. */
function handMade(out: string, folder: string, m: CaseManifest, extra: { name: string; body: string }[]): void {
  const sha = (b: Uint8Array): string => new Bun.CryptoHasher("sha256").update(b).digest("hex");
  const members = [...m.files.map((f) => ({ name: f.path, body: new Uint8Array(readFileSync(join(folder, f.path))) })), ...extra.map((e) => ({ name: e.name, body: new TextEncoder().encode(e.body) }))]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files = members.map((x) => ({ path: x.name, sha256: sha(x.body), bytes: x.body.length }));
  rawCaseFile(out, [{ name: "case.json", body: JSON.stringify({ ...m, files }) }, ...members]);
}

test("M6: a case file holding a ledger journal (ledger.sqlite-wal or -journal) is refused by name", async () => {
  const file = await unloadedFile();
  const folder = join(dir, "x");
  const m = await extractCaseFile(file, folder);
  for (const journal of ["ledger.sqlite-wal", "ledger.sqlite-journal"]) {
    const out = join(dir, `${journal}.tar.gz`);
    handMade(out, folder, m, [{ name: journal, body: "junk" }]);
    await expectRefusedLoad(out, `the case file holds ${journal}, a ledger journal; a case file holds none`);
  }
});

test("M7: a deleted.log that is a link or not a plain file is not read or written through", async () => {
  wb.createCase(sample, person);
  const r = await wb.unloadCase("CASE-1", { actor: person });
  if (!r.ok) throw new Error(r.reason);
  writeFileSync(join(dir, "elsewhere.log"), `${JSON.stringify({ id: "CASE-50" })}\n`);
  symlinkSync(join(dir, "elsewhere.log"), join(dir, "store", "deleted.log"));
  errors.length = 0;
  expect(wb.createCase(sample, person).id).toBe("CASE-2");
  expect(errors.map(String)).toEqual(["CaseFileError: the case store's deleted.log is not a plain file; its ids are not counted"]);
  const err = await refusalOf(wb.store.delete(FILE, "CASE-1", "analyst", now()));
  expect((err as Error).message).toBe("the deletion could not be recorded in deleted.log: deleted.log is not a plain file");
  expect(existsSync(r.path)).toBe(true);
  expect(readFileSync(join(dir, "elsewhere.log"), "utf8")).toBe(`${JSON.stringify({ id: "CASE-50" })}\n`);
  // a FIFO is refused the same way, at once, rather than waited on
  rmSync(join(dir, "store", "deleted.log"));
  expect(Bun.spawnSync(["mkfifo", join(dir, "store", "deleted.log")]).exitCode).toBe(0);
  expect((await refusalOf(wb.store.delete(FILE, "CASE-1", "analyst", now())) as Error).message).toContain("deleted.log");
  expect(existsSync(r.path)).toBe(true);
});

test("M9: a failed unload's reason says its cause once, and names no temporary file, pid or folder", async () => {
  wb.createCase(sample, person);
  // a store folder this process may not write in: the temporary file cannot be made
  mkdirSync(join(dir, "store"), { mode: 0o555 });
  const r = await wb.unloadCase("CASE-1", { actor: person });
  chmodSync(join(dir, "store"), 0o755);
  if (r.ok) throw new Error("unloaded");
  expect(r.reason).toStartWith("the case file could not be written: ");
  expect(r.reason.split("the case file could not be written").length).toBe(2);
  expect(r.reason).not.toContain(".tmp-");
  expect(r.reason).not.toContain(String(process.pid));
  expect(r.reason).not.toContain(dir);
});

test("M9: loading a file that is not there says so", async () => {
  const err = await refusalOf(wb.loadCase(join(dir, "nothing.tar.gz"), { actor: person }));
  expect(err).toBeInstanceOf(CaseFileError);
  expect((err as Error).message).toBe("there is no file there");
  const folder = await refusalOf(wb.loadCase(dir, { actor: person }));
  expect((folder as Error).message).toBe("it is a folder, not a case file");
});

test("M11: the workbench closed in the middle of an unload leaves the case loaded, and its next open records the failed unload", async () => {
  wb.close();
  wb = openWb({ beforeUnloadStep: (step) => { if (step === "leave") wb.close(); } });
  wb.createCase(sample, person);
  const r = await wb.unloadCase("CASE-1", { actor: person });
  if (r.ok) throw new Error("unloaded though the workbench was closed");
  expect(r.reason).toBe("the case could not be taken out of the working set: the workbench is closed");
  wb = openWb();
  const s = wb.session("CASE-1");
  expect(s.entries().map((e) => e.type)).toEqual(["case.created", "case.unloaded", "case.unload_failed"]);
  expect(s.entries().at(-1)!.actor).toEqual({ kind: "system", id: "recovery" });
});

test("M11: a file named case.json in the case folder fails the unload; a case.json of link kind, or a header that is not ustar, is refused on load", async () => {
  const s = wb.createCase(sample, person);
  writeFileSync(join(s.dir, "case.json"), "{}");
  const r = await wb.unloadCase("CASE-1", { actor: person });
  if (r.ok) throw new Error("unloaded");
  expect(r.reason).toBe("the case file could not be written: the case folder holds a file named case.json; a case file writes its own");
  rmSync(join(s.dir, "case.json"));
  const file = await unloadedFileOf("CASE-1");
  const link = join(dir, "link.tar.gz");
  rawCaseFile(link, [{ name: "case.json", type: "2", link: "elsewhere" }]);
  await expectRefusedLoad(link, "case.json is a link; a case file holds only regular files");
  // a header whose magic is not ustar, its checksum made right
  const tar = gunzipSync(readFileSync(file));
  tar.set(new TextEncoder().encode("gnu  \0"), 257);
  tar.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += tar[i]!;
  tar.set(new TextEncoder().encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  const gnu = join(dir, "gnu.tar.gz");
  writeFileSync(gnu, gzipSync(tar));
  await expectRefusedLoad(gnu, "the file is not a readable case file");
});
