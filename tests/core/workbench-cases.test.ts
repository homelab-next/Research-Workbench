import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaseFileError, checkCaseFile, extractCaseFile, readManifest, writeCaseFile } from "../../src/core/casefile";
import type { CaseManifest, ManifestHeader } from "../../src/core/casefile";
import { Ledger, LedgerCaseMismatchError } from "../../src/core/ledger";
import type { CaseSession } from "../../src/core/session";
import { fold, initial } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Actor, StageDef } from "../../src/core/types";
import { verifyCase } from "../../src/core/verify";
import { CaseNotFoundError, CaseRefused, unloadProblem, Workbench } from "../../src/core/workbench";
import type { NewCase, UnloadStep } from "../../src/core/workbench";
import { served } from "../helpers/served";
import { rawCaseFile } from "../helpers/tar";

const person: Actor = { kind: "human", id: "analyst" };
const code: Actor = { kind: "system", id: "workbench" };
const sample: NewCase = {
  title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [{ type: "ip", value: "198.51.100.77" }],
  window: { from: null, to: null }, objective: null, marking: "TLP:GREEN",
};
const stages: StageDef[] = [
  { id: "collect", title: "Collect", phase: "collect", runs: "script", gate: null, reviews: false, model: null },
  { id: "publish", title: "Publish", phase: "publish", runs: "human", gate: "publish", reviews: false, model: null },
];

let dir: string;
let wb: Workbench;
let tick = 0;
const errors: unknown[] = [];
const onError = (e: unknown) => void errors.push(e);
const now = () => new Date(Date.parse("2026-11-27T09:00:00.000Z") + tick++ * 1000).toISOString();
const openWb = (over: Parameters<typeof Workbench.open>[1] = {}): Workbench => Workbench.open(join(dir, "wb"), { store: join(dir, "store"), now, onError, ...over });
const newCase = (): CaseSession => wb.createCase(sample, person);
const cases = (): string => join(dir, "wb", "cases");
const mark = (): string => join(cases(), ".high-water");
const ls = (d: string): string[] => (existsSync(d) ? readdirSync(d).sort() : []);
const note = (s: CaseSession, text: string): void => void s.commit(() => [{ type: "feedback.recorded", payload: { measure: "m", kind: "mop", value: 1, note: text }, actor: person }]);
const startRun = (s: CaseSession): void => void s.commit((_, ids) => [{ type: "run.started", payload: { run: ids.next("run"), pipeline: "investigate", pipeline_hash: "a".repeat(64), stages }, actor: code }]);
const unloadOk = async (id: string, opts: { to?: string } = {}) => {
  const r = await wb.unloadCase(id, { actor: person, ...opts });
  if (!r.ok) throw new Error(`unload failed: ${r.reason}`);
  return r;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-cases-"));
  tick = 0;
  errors.length = 0;
  wb = openWb();
});
afterEach(() => {
  try { wb.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

// ---------- the id counter ----------

test("a new case never takes an id of a file in the store, though no folder has it", async () => {
  newCase(); newCase();
  await unloadOk("CASE-2");
  rmSync(mark()); // the store's file names alone keep the id
  expect(newCase().id).toBe("CASE-3");
  expect(errors).toEqual([]);
});

test("a new case never takes an id unloaded to another folder with to", async () => {
  newCase(); newCase();
  await unloadOk("CASE-2", { to: join(dir, "elsewhere") });
  expect(ls(join(dir, "store"))).toEqual([]);
  expect(Number(readFileSync(mark(), "utf8"))).toBeGreaterThanOrEqual(2);
  expect(newCase().id).toBe("CASE-3");
});

test("a new case never takes an id deleted from the store", async () => {
  newCase(); newCase();
  await unloadOk("CASE-2");
  await wb.store.delete("CASE-2.TLP-GREEN.tar.gz", "CASE-2", "analyst", now());
  rmSync(mark());
  expect(newCase().id).toBe("CASE-3");
});

test("a store file with a higher number, put there by hand, moves the counter past it", () => {
  mkdirSync(join(dir, "store"));
  writeFileSync(join(dir, "store", "CASE-40.TLP-RED.tar.gz"), "");
  expect(newCase().id).toBe("CASE-41");
});

test("a store that cannot be read is reported and does not stop a new case, which still does not reuse an id this workbench had", async () => {
  newCase(); newCase(); newCase();
  await unloadOk("CASE-3");
  await unloadOk("CASE-2");
  wb.close();
  // the store is unplugged and something else is in its place: its names cannot be read
  rmSync(join(dir, "store"), { recursive: true });
  writeFileSync(join(dir, "store"), "not a folder");
  wb = openWb();
  expect(newCase().id).toBe("CASE-4");
  expect(errors.length).toBe(1);
  expect(String(errors[0])).toContain("the case store");
  // and a store that is simply missing reports nothing, and still reuses nothing
  errors.length = 0;
  wb.close();
  rmSync(join(dir, "store"));
  wb = openWb();
  expect(newCase().id).toBe("CASE-5");
  expect(errors).toEqual([]);
});

test("the mark never goes down, and a mark that is not a number is ignored", async () => {
  writeFileSync(mark(), "abc");
  expect(newCase().id).toBe("CASE-1");
  expect(readFileSync(mark(), "utf8").trim()).toBe("1");
  writeFileSync(mark(), "7\n");
  expect(newCase().id).toBe("CASE-8");
  expect(readFileSync(mark(), "utf8").trim()).toBe("8");
  await unloadOk("CASE-1"); // raises the mark to 1 at most: it stays 8
  expect(readFileSync(mark(), "utf8").trim()).toBe("8");
  expect(ls(cases())).toEqual([".high-water", "CASE-8"]);
});

// ---------- unload ----------

test("unloadCase writes case.unloaded, packs the folder into <store>/CASE-1.TLP-GREEN.tar.gz and removes the case from the working set", async () => {
  newCase();
  const r = await wb.unloadCase("CASE-1", { actor: person });
  expect(r).toMatchObject({ ok: true, file: "CASE-1.TLP-GREEN.tar.gz" });
  if (!r.ok) throw new Error(r.reason);
  expect(r.path).toBe(join(dir, "store", "CASE-1.TLP-GREEN.tar.gz"));
  expect(existsSync(join(dir, "wb", "cases", "CASE-1"))).toBe(false);
  expect(wb.listCases()).toEqual([]);
  expect(() => wb.session("CASE-1")).toThrow(CaseNotFoundError);
  const m = await checkCaseFile(r.path);
  expect(m.head).toEqual(r.head);
  expect(m.entries).toBe(r.head.seq);
  expect(m).toMatchObject({ id: "CASE-1", chain: "CASE-1", title: "Sample", status: "none", workbench: "0.14.0" });
  expect(ls(cases())).toEqual([".high-water"]);
  expect(errors).toEqual([]);
});

test("the file's ledger ends with case.unloaded, which names the store's folder name only and the head before it", async () => {
  const s = newCase();
  note(s, "one");
  const before = s.head();
  const origin = s.entries(0, 1)[0]!.hash;
  const r = await unloadOk("CASE-1");
  const out = join(dir, "out");
  await extractCaseFile(r.path, out);
  const ledger = Ledger.open(join(out, "ledger.sqlite"), "CASE-1");
  try {
    const last = ledger.read().at(-1)!;
    expect(last).toMatchObject({ type: "case.unloaded", payload: { store: "store", head: before }, actor: person });
    expect(JSON.stringify(last.payload)).not.toContain(dir);
    expect(fold(ledger.read()).skipped).toEqual([]);
  } finally {
    ledger.close();
  }
  const m = await readManifest(r.path);
  expect(m.origin).toBe(origin);
});

test("the session that was open is closed, and a subscriber hears case.unloaded before it is", async () => {
  const s = newCase();
  const heard: [string, boolean][] = [];
  s.subscribe((e) => void heard.push([e.type, s.open]));
  expect(s.open).toBe(true);
  await unloadOk("CASE-1");
  expect(heard).toEqual([["case.unloaded", true]]);
  expect(s.open).toBe(false);
});

test("a running run, a running job, a running query and an unanswered question to your agent each refuse the unload, and nothing is written", async () => {
  const tries: [string, (s: CaseSession) => void][] = [
    ["a run is running; pause or stop it first", startRun],
    ["1 job(s) still running", (s) => void s.commit((_, ids) => [{ type: "job.started", payload: { job: ids.next("job"), title: "Look up", kind: "research", source: null }, actor: code }])],
    ["a query is still running", (s) => void s.commit((_, ids) => [{ type: "query.issued", payload: {
      query: ids.next("query"), source: "flows", source_hash: "b".repeat(64), pivot: null, pivot_hash: null, connector: "sqlite", text: "select 1", bound: {},
      window: { from: null, to: null }, why: "test", estimate: null, step: null, verifies: null, purpose: "result" }, actor: code }])],
    ["your agent is still answering", (s) => void s.commit((_, ids) => [{ type: "agent.asked", payload: { turn: ids.next("turn"), text: "what next?", left_out: [], added: [] }, actor: person }])],
  ];
  for (const [i, [reason, make]] of tries.entries()) {
    const s = newCase();
    make(s);
    const head = s.head();
    expect(unloadProblem(s.state)).toBe(reason);
    const err = await wb.unloadCase(s.id, { actor: person }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CaseRefused);
    expect((err as CaseRefused).reasons).toEqual([reason]);
    expect(wb.session(s.id).head()).toEqual(head);
    expect(wb.session(s.id).state.skipped).toEqual([]);
    expect(s.id).toBe(`CASE-${i + 1}`);
  }
  expect(ls(join(dir, "store"))).toEqual([]);
  expect(unloadProblem(initial())).toBe("the case has no case.created entry");
});

test("a paused run and a run waiting at a gate may be unloaded", async () => {
  const paused = newCase();
  startRun(paused);
  paused.commit(() => [{ type: "run.paused", payload: { reason: "for the night" }, actor: person }]);
  const waiting = newCase();
  startRun(waiting);
  waiting.commit(() => [{ type: "gate.waiting", payload: { gate: "publish" }, actor: code }]);
  expect(unloadProblem(paused.state)).toBeNull();
  expect(unloadProblem(waiting.state)).toBeNull();
  expect((await unloadOk("CASE-1")).file).toBe("CASE-1.TLP-GREEN.tar.gz");
  const m = await readManifest((await unloadOk("CASE-2")).path);
  expect(m.status).toBe("waiting");
});

test("an unknown case is CaseNotFoundError", async () => {
  await expect(wb.unloadCase("CASE-9", { actor: person })).rejects.toThrow(CaseNotFoundError);
  await expect(wb.unloadCase("../CASE-1", { actor: person })).rejects.toThrow(CaseNotFoundError);
});

/** The case folder is whole, the session is back, and its ledger ends with case.unloaded then case.unload_failed by the same actor. */
function expectStillLoaded(reason: string): void {
  expect(existsSync(join(cases(), "CASE-1", "ledger.sqlite"))).toBe(true);
  const s = wb.session("CASE-1");
  expect(s.open).toBe(true);
  expect(s.entries().slice(-2).map((e) => e.type)).toEqual(["case.unloaded", "case.unload_failed"]);
  expect(s.entries().at(-1)).toMatchObject({ actor: person, payload: { reason } });
  expect(s.state.archive).toMatchObject({ pending: null, failed: { reason } });
  expect(s.state.skipped).toEqual([]);
  expect(wb.listCases()[0]!.unload_failed).toBe(reason);
  expect(verifyCase(s.dir).ok).toBe(true);
  expect(ls(cases()).filter((n) => n.startsWith(".unloading") || n.startsWith(".loading"))).toEqual([]);
}

test("a store that cannot be written fails the unload: the case stays loaded, case.unload_failed is recorded with the reason, and no temporary file is left", async () => {
  newCase();
  writeFileSync(join(dir, "store"), "a file where the store should be");
  const r = await wb.unloadCase("CASE-1", { actor: person });
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("unloaded");
  expect(r.reason).toContain("the case file could not be written");
  expect(r.reason).not.toContain(dir);
  expectStillLoaded(r.reason);
  expect(ls(dir).filter((n) => n.endsWith(".part"))).toEqual([]);
  // the case still takes commands
  note(wb.session("CASE-1"), "still here");
});

test("a link inside the case folder fails the unload the same way", async () => {
  const s = newCase();
  symlinkSync("/etc/hostname", join(s.dir, "link"));
  const r = await wb.unloadCase("CASE-1", { actor: person });
  if (r.ok) throw new Error("unloaded");
  expect(r.reason).toContain("is a link; a case file holds only regular files");
  expectStillLoaded(r.reason);
  expect(ls(join(dir, "store"))).toEqual([]);
});

test("a second unload replaces the store's file", async () => {
  newCase();
  await unloadOk("CASE-1");
  const back = await wb.loadCase(join(dir, "store", "CASE-1.TLP-GREEN.tar.gz"), { actor: person });
  note(back.session, "later");
  const r = await unloadOk("CASE-1");
  expect(ls(join(dir, "store"))).toEqual(["CASE-1.TLP-GREEN.tar.gz"]);
  const m = await readManifest(r.path);
  expect(m.head).toEqual(r.head);
  expect(m.entries).toBe(5); // created, unloaded, loaded, the note, unloaded
});

test("to writes the file to that folder and records that folder's name", async () => {
  newCase();
  const r = await unloadOk("CASE-1", { to: join(dir, "usb", "export") });
  expect(r.path).toBe(join(dir, "usb", "export", "CASE-1.TLP-GREEN.tar.gz"));
  const out = join(dir, "out");
  await extractCaseFile(r.path, out);
  const ledger = Ledger.open(join(out, "ledger.sqlite"), "CASE-1");
  try {
    expect(ledger.read().at(-1)!.payload).toMatchObject({ store: "export" });
  } finally {
    ledger.close();
  }
  expect(existsSync(join(dir, "store"))).toBe(false);
});

// ---------- a failure at each step of an unload ----------

test("a failure injected at each step before the case leaves the working set leaves it loaded and records case.unload_failed", async () => {
  const steps: UnloadStep[] = ["close", "write", "check", "store", "mark", "leave"];
  for (const failAt of steps) {
    wb.close();
    rmSync(join(dir, "wb"), { recursive: true, force: true });
    rmSync(join(dir, "store"), { recursive: true, force: true });
    wb = openWb({ beforeUnloadStep: (step) => { if (step === failAt) throw new Error(`stopped at ${step}`); } });
    newCase();
    const r = await wb.unloadCase("CASE-1", { actor: person });
    if (r.ok) throw new Error(`unloaded though ${failAt} failed`);
    expect(r.reason).toContain(`stopped at ${failAt}`);
    expectStillLoaded(r.reason);
    // the store has the file only when the failure came after it was put there
    expect(ls(join(dir, "store"))).toEqual(failAt === "mark" || failAt === "leave" ? ["CASE-1.TLP-GREEN.tar.gz"] : []);
    expect(errors).toEqual([]);
  }
});

test("a file changed between writing and reading it back fails the read-back and is not put in the store", async () => {
  wb.close();
  wb = openWb({ beforeUnloadStep: (step, part) => { if (step === "check") writeFileSync(part, "garbage"); } });
  newCase();
  const r = await wb.unloadCase("CASE-1", { actor: person });
  if (r.ok) throw new Error("unloaded");
  expect(r.reason).toContain("the case file did not read back as written");
  expectStillLoaded(r.reason);
  expect(ls(join(dir, "store"))).toEqual([]);
});

test("a failure removing the folder after it left the working set is reported; the case is unloaded and the leftover goes at the next open", async () => {
  wb.close();
  wb = openWb({ beforeUnloadStep: (step) => { if (step === "remove") throw new Error("stopped at remove"); } });
  newCase();
  const r = await wb.unloadCase("CASE-1", { actor: person });
  expect(r.ok).toBe(true);
  expect(errors.length).toBe(1);
  expect(ls(cases()).filter((n) => n.startsWith(".unloading-CASE-1-")).length).toBe(1);
  expect(wb.listCases()).toEqual([]);
  wb.close();
  errors.length = 0;
  wb = openWb();
  expect(ls(cases())).toEqual([".high-water"]);
  expect(errors.length).toBe(1);
  expect((await wb.loadCase(join(dir, "store", "CASE-1.TLP-GREEN.tar.gz"), { actor: person })).id).toBe("CASE-1");
});

// ---------- load ----------

test("a case unloaded and loaded again keeps its id, and its ledger is the unloaded one plus case.loaded", async () => {
  const s = newCase();
  note(s, "one");
  const hashes = s.entries().map((e) => e.hash);
  await unloadOk("CASE-1");
  const back = await wb.loadCase(join(dir, "store", "CASE-1.TLP-GREEN.tar.gz"), { actor: person });
  expect(back.id).toBe("CASE-1");
  expect(Object.keys(back).sort()).toEqual(["id", "session"]);
  const es = back.session.entries();
  expect(es.slice(0, hashes.length).map((e) => e.hash)).toEqual(hashes);
  expect(es.slice(hashes.length).map((e) => e.type)).toEqual(["case.unloaded", "case.loaded"]);
  expect(es.at(-1)!.payload).toEqual({ file: "CASE-1.TLP-GREEN.tar.gz", head: { seq: es.at(-2)!.seq, hash: es.at(-2)!.hash }, id: "CASE-1" });
  expect(es.at(-1)!.actor).toEqual(person);
  expect(wb.session("CASE-1")).toBe(back.session);
  expect(wb.listCases().map((c) => [c.id, c.unload_failed])).toEqual([["CASE-1", null]]);
  expect(back.session.state.archive).toMatchObject({ pending: null, failed: null, loaded: { id: "CASE-1", file: "CASE-1.TLP-GREEN.tar.gz" }, unloads: 1, loads: 1 });
});

test("replay is exact after a round trip: the fold of every prefix is the state the live session had", async () => {
  const s = newCase();
  const states = new Map<number, CaseState>([[1, s.state as CaseState]]);
  s.subscribe((e, st) => void states.set(e.seq, st as CaseState));
  note(s, "one");
  startRun(s);
  s.commit(() => [{ type: "run.paused", payload: { reason: "overnight" }, actor: person }]);
  await unloadOk("CASE-1");
  const back = await wb.loadCase(join(dir, "store", "CASE-1.TLP-GREEN.tar.gz"), { actor: person });
  const es = back.session.entries();
  expect(states.size).toBe(5);
  for (const [seq, state] of states) {
    expect(fold(es, seq)).toEqual(state);
    expect(back.session.stateAt(seq)).toEqual(state);
  }
  expect(back.session.state).toEqual(fold(es));
  expect(back.session.state.skipped).toEqual([]);
});

test("a paused run comes back paused, with its hold and its pause reason", async () => {
  const s = newCase();
  startRun(s);
  s.commit(() => [{ type: "run.paused", payload: { reason: "the stage ran too often", hold: { kind: "stage_runs", stage: "collect" } }, actor: code }]);
  const run = s.state.run;
  await unloadOk("CASE-1");
  const back = await wb.loadCase(join(dir, "store", "CASE-1.TLP-GREEN.tar.gz"), { actor: person });
  expect(back.session.state.run).toEqual(run);
  expect(back.session.state.run).toMatchObject({ status: "paused", pause_reason: "the stage ran too often", hold: { kind: "stage_runs", stage: "collect" } });
});

test("loading does not remove the store's file", async () => {
  newCase();
  const r = await unloadOk("CASE-1");
  const bytes = readFileSync(r.path);
  await wb.loadCase(r.path, { actor: person });
  expect(readFileSync(r.path)).toEqual(bytes);
});

test("loading a file whose case is already loaded is refused: CASE-1 is already loaded", async () => {
  newCase();
  const r = await unloadOk("CASE-1");
  cpSync(r.path, join(dir, "copy.tar.gz"));
  await wb.loadCase(r.path, { actor: person });
  const head = wb.session("CASE-1").head();
  const before = ls(cases());
  const err = await wb.loadCase(join(dir, "copy.tar.gz"), { actor: person }).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CaseRefused);
  expect((err as Error).message).toBe("CASE-1 is already loaded");
  expect(ls(cases())).toEqual(before);
  expect(wb.session("CASE-1").head()).toEqual(head);
});

/** A second workbench, with its own data folder and store, that makes its own cases and unloads them; the path of its file for `id`. */
async function foreignFile(n: number, unload = n): Promise<string> {
  const other = Workbench.open(join(dir, "other"), { store: join(dir, "other-store"), now, onError });
  try {
    for (let i = 0; i < n; i++) {
      const s = other.createCase({ ...sample, title: `Other ${i + 1}` }, { kind: "human", id: "colleague" });
      note(s, "theirs");
    }
    const r = await other.unloadCase(`CASE-${unload}`, { actor: { kind: "human", id: "colleague" } });
    if (!r.ok) throw new Error(r.reason);
    return r.path;
  } finally {
    other.close();
  }
}

test("a case from another workbench whose id is taken here is refused, and nothing is written", async () => {
  newCase();
  const theirs = await foreignFile(1);
  const head = wb.session("CASE-1").head();
  const before = ls(cases());
  const err = await wb.loadCase(theirs, { actor: person }).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CaseRefused);
  expect((err as Error).message).toBe("CASE-1 is taken here by another case; this file cannot be loaded");
  expect(ls(cases())).toEqual(before);
  expect(wb.session("CASE-1").head()).toEqual(head);
  expect(wb.listCases().map((c) => c.id)).toEqual(["CASE-1"]);
});

test("a case from another workbench whose id is held by another file in the store is refused", async () => {
  newCase();
  await unloadOk("CASE-1");
  const theirs = await foreignFile(1);
  const err = await wb.loadCase(theirs, { actor: person }).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(CaseRefused);
  expect((err as Error).message).toBe("CASE-1 is taken here by another case, in the store's CASE-1.TLP-GREEN.tar.gz; this file cannot be loaded");
  expect(ls(cases())).toEqual([".high-water"]);
});

test("a case from another workbench whose id is free here loads under that id, verifies, and moves the counter past it", async () => {
  newCase();
  const theirs = await foreignFile(3);
  const got = await wb.loadCase(theirs, { actor: person });
  expect(got.id).toBe("CASE-3");
  expect(got.session.entries().every((e) => e.case === "CASE-3")).toBe(true);
  expect(got.session.state.meta?.title).toBe("Other 3");
  expect(verifyCase(got.session.dir).ok).toBe(true);
  expect(wb.listCases().map((c) => c.id)).toEqual(["CASE-3", "CASE-1"]);
  expect(newCase().id).toBe("CASE-4");
});

test("the next new case after a load does not take the id the load had, though the loaded case was unloaded elsewhere", async () => {
  const theirs = await foreignFile(5);
  await wb.loadCase(theirs, { actor: person });
  await unloadOk("CASE-5", { to: join(dir, "elsewhere") });
  expect(newCase().id).toBe("CASE-6");
});

test("a folder whose ledger is another case's, with no case.loaded that gave it this id, is still refused", () => {
  const s = newCase();
  mkdirSync(join(cases(), "CASE-5"));
  cpSync(join(s.dir, "ledger.sqlite"), join(cases(), "CASE-5", "ledger.sqlite"));
  expect(() => wb.session("CASE-5")).toThrow(LedgerCaseMismatchError);
});

/** Rewrites a case file from a changed copy of its folder, with the header given (default: the file's own). */
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

async function expectRefused(file: string, cls: typeof CaseFileError | typeof CaseRefused, text: string): Promise<void> {
  const before = ls(cases());
  const err = await wb.loadCase(file, { actor: person }).then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(cls);
  expect((err as Error).message).toContain(text);
  expect(ls(cases())).toEqual(before);
}

test("a file that fails its check is refused and the working set is unchanged", async () => {
  const s = newCase();
  writeFileSync(join(s.dir, "blobs", "x"), "a blob");
  const r = await unloadOk("CASE-1");
  const m = await readManifest(r.path);
  const json = JSON.stringify(m);
  const link = join(dir, "link.tar.gz");
  rawCaseFile(link, [{ name: "case.json", body: json }, { name: "ledger.sqlite", type: "2", link: "/etc/passwd" }]);
  await expectRefused(link, CaseFileError, "link");
  const up = join(dir, "up.tar.gz");
  rawCaseFile(up, [{ name: "case.json", body: json }, { name: "../x", body: "x" }]);
  await expectRefused(up, CaseFileError, "../x");
  const edited = join(dir, "edited.tar.gz");
  const members = m.files.map((f) => ({ name: f.path, body: f.path === "blobs/x" ? "a blob, changed" : new Uint8Array(0) }));
  rawCaseFile(edited, [{ name: "case.json", body: json }, ...members]);
  await expectRefused(edited, CaseFileError, "blobs/x");
  wb.close();
  wb = openWb({ max_case_bytes: 1024 });
  await expectRefused(r.path, CaseFileError, "");
  expect(ls(cases())).toEqual([".high-water"]);
});

test("a file whose every hash matches but whose ledger does not verify is refused", async () => {
  const s = newCase();
  note(s, "the original note");
  const r = await unloadOk("CASE-1");
  const bad = await repack(r.path, (folder) => {
    const db = new Database(join(folder, "ledger.sqlite"));
    try { db.query("UPDATE entries SET payload = replace(payload, 'the original note', 'a changed note') WHERE seq = 2").run(); } finally { db.close(); }
  });
  await expectRefused(bad, CaseFileError, "the case does not verify: case CASE-1: BROKEN at entry 2 (hash_mismatch)");
});

test("a file whose ledger was cut short, with case.json re-hashed but naming the old head, is refused: the head is not the one case.json names", async () => {
  const s = newCase();
  note(s, "one");
  note(s, "two");
  const r = await unloadOk("CASE-1");
  const cut = await repack(r.path, (folder) => {
    const db = new Database(join(folder, "ledger.sqlite"));
    try { db.query("DELETE FROM entries WHERE seq > 2").run(); } finally { db.close(); }
  });
  await expectRefused(cut, CaseFileError, "the case does not verify: its head is not the one case.json names");
});

test("a file whose case.json names another chain or another origin than its ledger is refused", async () => {
  const s = newCase();
  note(s, "one");
  const r = await unloadOk("CASE-1");
  const chain = await repack(r.path, () => {}, (m) => ({ ...m, id: "CASE-9", chain: "CASE-9" }));
  await expectRefused(chain, CaseFileError, "the case does not verify: its ledger is case CASE-1, not CASE-9");
  const split = await repack(r.path, () => {}, (m) => ({ ...m, chain: "CASE-9" }));
  await expectRefused(split, CaseFileError, "case.json names the case CASE-1 and the chain CASE-9; a case keeps one id");
  const origin = await repack(r.path, () => {}, (m) => ({ ...m, origin: "c".repeat(64) }));
  rmSync(r.path); // else the store's own file, with the true origin, holds the id
  await expectRefused(origin, CaseFileError, "the case does not verify: its first entry is not the one case.json names");
});

test("a loaded case verifies like any other: verifyCase is ok, its head is the session's, and its published bundles are as recorded", async () => {
  const sv = await served();
  try {
    const id = await sv.newCase();
    await sv.toPublishGate(id);
    expect((await sv.command(id, "approve")).status).toBe(200);
    await sv.app.hub.idle();
    expect(sv.wb.session(id).state.published.length).toBe(1);
    const r = await sv.wb.unloadCase(id, { actor: person });
    if (!r.ok) throw new Error(r.reason);
    expect((await readManifest(r.path)).published.length).toBe(1);
    const back = await sv.wb.loadCase(r.path, { actor: person });
    const report = verifyCase(back.session.dir);
    expect(report.ok).toBe(true);
    expect(report.head).toBe(back.session.head().hash);
    expect(report.published.bundles.map((b) => b.state)).toEqual(["ok"]);
    expect(back.session.state.skipped).toEqual([]);
  } finally {
    await sv.close();
  }
});

// ---------- recovery and the sweep ----------

const unloadedEntry = (s: CaseSession) => {
  const head = s.head();
  s.commit(() => [{ type: "case.unloaded", payload: { store: "store", head }, actor: person }]);
};

test("a case whose last entry is case.unloaded, still in the working set, is loaded, and opening it records the failed unload", () => {
  unloadedEntry(newCase());
  wb.close(); // the stop
  wb = openWb();
  expect(wb.listCases()[0]!.unload_failed).toBe("an unload did not finish");
  const s = wb.session("CASE-1");
  expect(s.entries().at(-1)).toMatchObject({ type: "case.unload_failed", actor: { kind: "system", id: "recovery" }, payload: { reason: "the workbench stopped before the case was unloaded" } });
  expect(wb.listCases()[0]!.unload_failed).toBe("the workbench stopped before the case was unloaded");
  expect(s.state.skipped).toEqual([]);
  wb.close();
  wb = openWb();
  expect(wb.session("CASE-1").entries().filter((e) => e.type === "case.unload_failed").length).toBe(1);
});

test("the same stop with the file already in the store: the case is loaded, the store's file is refused as already loaded, and the next unload replaces it", async () => {
  // the folder as it was when the file had been put in the store: its ledger ends with case.unloaded, and nothing after it
  const kept = join(dir, "kept");
  wb.close();
  wb = openWb({ beforeUnloadStep: (step) => { if (step === "mark") { cpSync(join(cases(), "CASE-1"), kept, { recursive: true }); throw new Error("the stop"); } } });
  newCase();
  expect((await wb.unloadCase("CASE-1", { actor: person })).ok).toBe(false);
  wb.close();
  rmSync(join(cases(), "CASE-1"), { recursive: true });
  cpSync(kept, join(cases(), "CASE-1"), { recursive: true });
  const file = join(dir, "store", "CASE-1.TLP-GREEN.tar.gz");
  const stale = await readManifest(file);
  wb = openWb();
  expect(wb.listCases()[0]!.unload_failed).toBe("an unload did not finish");
  await expect(wb.loadCase(file, { actor: person })).rejects.toThrow("CASE-1 is already loaded");
  expect(wb.session("CASE-1").entries().at(-1)).toMatchObject({ type: "case.unload_failed", actor: { kind: "system", id: "recovery" } });
  const done = await unloadOk("CASE-1");
  const fresh = await readManifest(file);
  expect(fresh.head).toEqual(done.head);
  expect(fresh.entries).toBe(stale.entries + 2);
});

test("a stop after the folder left the working set leaves the case unloaded: the leftover .unloading folder is removed at the next open and the store's file loads", async () => {
  newCase();
  const r = await unloadOk("CASE-1");
  wb.close();
  mkdirSync(join(cases(), ".unloading-CASE-1-x"));
  writeFileSync(join(cases(), ".unloading-CASE-1-x", "ledger.sqlite"), "half");
  wb = openWb();
  expect(ls(cases())).toEqual([".high-water"]);
  expect(errors.length).toBe(1);
  expect(String(errors[0])).toContain(".unloading-CASE-1-x");
  expect(wb.listCases()).toEqual([]);
  expect((await wb.loadCase(r.path, { actor: person })).id).toBe("CASE-1");
});

test("a .loading folder a stopped load left is removed at the next open, and is never listed as a case", () => {
  const s = newCase();
  mkdirSync(join(cases(), ".loading-x"));
  cpSync(join(s.dir, "ledger.sqlite"), join(cases(), ".loading-x", "ledger.sqlite"));
  expect(wb.listCases().map((c) => c.id)).toEqual(["CASE-1"]);
  wb.close();
  wb = openWb();
  expect(ls(cases())).toEqual([".high-water", "CASE-1"]);
  expect(String(errors[0])).toContain(".loading-x");
});

test("every step of an unload that throws leaves the case loaded", async () => {
  // the store's parent is removed after case.unloaded is written (a subscriber removes it), so the store cannot be made
  wb.close();
  wb = openWb({ store: join(dir, "gone", "store") });
  mkdirSync(join(dir, "gone"));
  const s = newCase();
  s.subscribe((e) => { if (e.type === "case.unloaded") { rmSync(join(dir, "gone"), { recursive: true }); writeFileSync(join(dir, "gone"), "x"); } });
  const r = await wb.unloadCase("CASE-1", { actor: person });
  if (r.ok) throw new Error("unloaded");
  expectStillLoaded(r.reason);
});

// ---------- a case's type (slice 13) ----------

test("createCase with a type records case.type_set by the person in the commit of case.created", () => {
  const session = wb.createCase(sample, person, { type: "unknown-device" });
  expect(session.entries().map((e) => e.type)).toEqual(["case.created", "case.type_set"]);
  expect(session.entries()[1]).toMatchObject({ actor: person, payload: { type: "unknown-device" } });
  expect(session.state.memory.type).toBe("unknown-device");
  expect(session.state.memory.type_by).toEqual({ actor: "analyst", seq: 2 });
  expect(session.state.skipped).toEqual([]);
});

test("a child case's type is recorded by the engine, after subloop.child, and subloop.child is still read", () => {
  const engine: Actor = { kind: "system", id: "engine" };
  wb.createCase(sample, person, { loop: "triage" });
  const link = { parent: "CASE-1", run: "run-1", stage: "investigate", attempt: 1, loop: "investigation", input_hash: "c".repeat(64), depth: 1, floor: "TLP:GREEN" as const };
  const child = wb.createCase(sample, engine, { loop: "investigation", link, type: "unknown-device" });
  expect(child.entries().map((e) => e.type)).toEqual(["case.created", "case.loop_set", "subloop.child", "case.type_set"]);
  expect(child.entries()[2]!.seq).toBeLessThanOrEqual(3);
  expect(child.entries()[3]).toMatchObject({ actor: engine, payload: { type: "unknown-device" } });
  expect(child.state.loop.parent).not.toBeNull();
  expect(child.state.memory.type).toBe("unknown-device");
  expect(wb.findChild(link)).toBe(child.id);
  expect(child.state.skipped).toEqual([]);
});

test("case.type_set is by the person only for a type the person chose; a loop's default and an inherited type are by a system actor", () => {
  const byDefault: Actor = { kind: "system", id: "loop-default" };
  const byParent: Actor = { kind: "system", id: "parent" };
  const actorOf = (c: ReturnType<typeof wb.createCase>) => c.entries().filter((e) => e.type === "case.type_set").map((e) => e.actor);
  expect(actorOf(wb.createCase(sample, person, { type: "unknown-device" }))).toEqual([person]);
  expect(actorOf(wb.createCase(sample, person, { type: "unknown-device", type_by: byDefault }))).toEqual([byDefault]);
  expect(actorOf(wb.createCase(sample, person, { type: "unknown-device", type_by: byParent }))).toEqual([byParent]);
  const link = { parent: "CASE-1", run: "run-1", stage: "investigate", attempt: 1, loop: "investigation", input_hash: "c".repeat(64), depth: 1, floor: "TLP:GREEN" as const };
  const engine: Actor = { kind: "system", id: "engine" };
  expect(actorOf(wb.createCase(sample, engine, { loop: "investigation", link, type: "unknown-device", type_by: byParent }))).toEqual([byParent]);
  // only a system actor may stand for a default or an inherited type
  expect(() => wb.createCase(sample, person, { type: "unknown-device", type_by: person })).toThrow(TypeError);
  expect(() => wb.createCase(sample, person, { type_by: byParent })).toThrow(TypeError);
});

test("createCase with a type that is not an id, or by an agent, throws and leaves no folder", () => {
  const agent: Actor = { kind: "agent", id: "frame", stage: "frame", profile: "p", model: "scripted-m", effort: null, where: "machine" };
  for (const type of ["Unknown Device", "", "-lead", "a".repeat(65), 7 as unknown as string]) {
    expect(() => wb.createCase(sample, person, { type })).toThrow(TypeError);
  }
  expect(() => wb.createCase(sample, person, { type: "bad id" })).toThrow("a case's type is a case type's id");
  expect(() => wb.createCase(sample, agent, { type: "unknown-device" })).toThrow(TypeError);
  expect(ls(cases()).filter((n) => n.startsWith("CASE-"))).toEqual([]);
  expect(wb.listCases()).toEqual([]);
});

test("listCases says each case's type, null for a case with none", () => {
  wb.createCase(sample, person, { type: "unknown-device" });
  newCase();
  expect(wb.listCases().map((c) => [c.id, c.type])).toEqual([["CASE-2", null], ["CASE-1", "unknown-device"]]);
});
