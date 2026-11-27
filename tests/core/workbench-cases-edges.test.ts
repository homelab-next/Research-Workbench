// The edges of unload and load the final review of slice 11 found: what an unload may replace, where it may write, how large an id may be,
// and what an untrusted ledger.sqlite or case.json can still say after the checks.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest } from "../../src/core/casefile";
import type { CaseSession } from "../../src/core/session";
import type { Actor } from "../../src/core/types";
import { CaseRefused, Workbench } from "../../src/core/workbench";
import type { NewCase } from "../../src/core/workbench";

const person: Actor = { kind: "human", id: "analyst" };
const colleague: Actor = { kind: "human", id: "colleague" };
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

