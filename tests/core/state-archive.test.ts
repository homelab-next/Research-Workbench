import { expect, test } from "bun:test";
import { fold, initialArchive, unloadDue } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Actor, Entry, EntryType, Payloads, StageDef } from "../../src/core/types";
import { EntryBuilder } from "../helpers/entries";

const person: Actor = { kind: "human", id: "analyst" };
const code: Actor = { kind: "system", id: "workbench" };
const researcher: Actor = { kind: "agent", id: "researcher-g1", stage: "collect", profile: "default", model: "scripted-m", effort: null, where: "machine" };

const stages: StageDef[] = [
  { id: "collect", title: "Collect", phase: "collect", runs: "script", gate: null, reviews: false, model: null },
  { id: "publish", title: "Publish", phase: "publish", runs: "human", gate: "publish", reviews: false, model: null },
];

const hashOf = (seq: number): string => seq.toString(16).padStart(64, "0");

/** An EntryBuilder whose entries carry a hash of their own and the previous one's as prev_hash, so a head can be checked. */
class Chain {
  readonly b = new EntryBuilder("CASE-1");
  add<T extends EntryType>(type: T, payload: Payloads[T], actor: Actor = code): Entry {
    const seq = this.b.entries.length + 1;
    return this.b.add(type, payload, { actor, prev_hash: seq === 1 ? "0".repeat(64) : hashOf(seq - 1), hash: hashOf(seq) } as never);
  }
  /** The head before the next entry. */
  head(): { seq: number; hash: string } {
    const prev = this.b.entries.at(-1)!;
    return { seq: prev.seq, hash: prev.hash };
  }
  get entries(): Entry[] { return this.b.entries; }
  state(): CaseState { return fold(this.b.entries); }
}

function created(): { c: Chain; created: Entry } {
  const c = new Chain();
  const e = c.add("case.created", {
    id: "CASE-1", title: "Beaconing from 192.0.2.10", asked: "Is it beaconing?", why: "IDS alert", starting: [{ type: "ip", value: "192.0.2.10" }],
    window: { from: null, to: null }, objective: null, marking: "TLP:GREEN",
  }, person);
  return { c, created: e };
}

// ---------- the three entries ----------

test("case.unloaded by a person is the pending unload: the store's name, the head before it, who and when", () => {
  const { c, created: made } = created();
  const unloaded = c.add("case.unloaded", { store: "store", head: c.head() }, person);
  const s = c.state();
  expect(s.archive).toEqual({ pending: { store: "store", head: { seq: made.seq, hash: made.hash }, by: "analyst", seq: unloaded.seq, ts: unloaded.ts }, failed: null, loaded: null, unload_after: false, unloads: 1, loads: 0 });
  expect(s.skipped).toEqual([]);
});

test("case.unloaded by code folds the same; by an agent it is skipped: an unload is a person's or the workbench's", () => {
  const { c } = created();
  const unloaded = c.add("case.unloaded", { store: "store", head: c.head() }, code);
  expect(c.state().archive.pending).toMatchObject({ by: "workbench", seq: unloaded.seq });
  expect(c.state().skipped).toEqual([]);

  const { c: a } = created();
  const bad = a.add("case.unloaded", { store: "store", head: a.head() }, researcher);
  const s = a.state();
  expect(s.archive).toEqual(initialArchive());
  expect(s.skipped).toEqual([{ seq: bad.seq, type: "case.unloaded", reason: "an unload is a person's or the workbench's" }]);
});

test("case.unloaded that does not name the head before it is skipped: an unload names the head before it", () => {
  const { c } = created();
  const head = c.head();
  const early = c.add("case.unloaded", { store: "store", head: { seq: head.seq - 1, hash: head.hash } }, person);
  let s = c.state();
  expect(s.archive).toEqual(initialArchive());
  expect(s.skipped).toEqual([{ seq: early.seq, type: "case.unloaded", reason: "an unload names the head before it" }]);

  const { c: d } = created();
  const other = d.add("case.unloaded", { store: "store", head: { seq: d.head().seq, hash: "f".repeat(64) } }, person);
  s = d.state();
  expect(s.archive).toEqual(initialArchive());
  expect(s.skipped).toEqual([{ seq: other.seq, type: "case.unloaded", reason: "an unload names the head before it" }]);
});

test("a malformed case.unloaded, case.unload_failed or case.loaded is recorded as malformed", () => {
  const { c } = created();
  const e1 = c.add("case.unloaded", { store: 1, head: c.head() } as never, person);
  const e2 = c.add("case.unload_failed", { reason: null } as never, person);
  const e3 = c.add("case.loaded", { head: c.head(), id: "CASE-1" } as never, person);
  const e4 = c.add("case.loaded", { file: "CASE-1.TLP-GREEN.tar.gz", head: c.head(), id: "" } as never, person);
  const s = c.state();
  expect(s.archive).toEqual(initialArchive());
  expect(s.skipped).toEqual([
    { seq: e1.seq, type: "case.unloaded", reason: "malformed case.unloaded" },
    { seq: e2.seq, type: "case.unload_failed", reason: "malformed case.unload_failed" },
    { seq: e3.seq, type: "case.loaded", reason: "malformed case.loaded" },
    { seq: e4.seq, type: "case.loaded", reason: "malformed case.loaded" },
  ]);
});

test("case.unload_failed clears the pending unload and keeps the reason; with nothing pending it still records the failure", () => {
  const { c } = created();
  c.add("case.unloaded", { store: "store", head: c.head() }, person);
  const failed = c.add("case.unload_failed", { reason: "the store folder is not there" }, code);
  let s = c.state();
  expect(s.archive).toMatchObject({ pending: null, failed: { reason: "the store folder is not there", seq: failed.seq, ts: failed.ts }, unloads: 1 });
  expect(s.skipped).toEqual([]);

  const { c: d } = created();
  const alone = d.add("case.unload_failed", { reason: "the workbench stopped before the case was unloaded" }, { kind: "system", id: "recovery" });
  s = d.state();
  expect(s.archive).toEqual({ ...initialArchive(), failed: { reason: "the workbench stopped before the case was unloaded", seq: alone.seq, ts: alone.ts } });
  expect(s.skipped).toEqual([]);
});

test("case.loaded after case.unloaded clears pending and failed and records the file, the head it arrived with and the id", () => {
  const { c } = created();
  c.add("case.unloaded", { store: "store", head: c.head() }, person);
  c.add("case.unload_failed", { reason: "the store folder is not there" }, code);
  const unloaded = c.add("case.unloaded", { store: "store", head: c.head() }, person);
  const loaded = c.add("case.loaded", { file: "CASE-1.TLP-GREEN.tar.gz", head: c.head(), id: "CASE-1" }, person);
  const s = c.state();
  expect(s.archive.loaded).toEqual({ file: "CASE-1.TLP-GREEN.tar.gz", head: { seq: unloaded.seq, hash: unloaded.hash }, id: "CASE-1", by: "analyst", seq: loaded.seq, ts: loaded.ts });
  expect(s.archive).toMatchObject({ pending: null, failed: null, unloads: 2, loads: 1 });
  expect(s.skipped).toEqual([]);
});

test("case.loaded by an agent, or naming another head, is skipped with its reason", () => {
  const { c } = created();
  c.add("case.unloaded", { store: "store", head: c.head() }, person);
  const before = c.state().archive;
  const byAgent = c.add("case.loaded", { file: "CASE-1.TLP-GREEN.tar.gz", head: c.head(), id: "CASE-1" }, researcher);
  const elsewhere = c.add("case.loaded", { file: "CASE-1.TLP-GREEN.tar.gz", head: { seq: 1, hash: hashOf(1) }, id: "CASE-1" }, person);
  const s = c.state();
  expect(s.archive).toEqual(before);
  expect(s.skipped).toEqual([
    { seq: byAgent.seq, type: "case.loaded", reason: "a load is a person's or the workbench's" },
    { seq: elsewhere.seq, type: "case.loaded", reason: "a load names the head it arrived with" },
  ]);
});

test("case.unload_failed by an agent is skipped: an unload is a person's or the workbench's", () => {
  const { c } = created();
  c.add("case.unloaded", { store: "store", head: c.head() }, person);
  const before = c.state().archive;
  const bad = c.add("case.unload_failed", { reason: "no" }, researcher);
  const s = c.state();
  expect(s.archive).toEqual(before);
  expect(s.skipped).toEqual([{ seq: bad.seq, type: "case.unload_failed", reason: "an unload is a person's or the workbench's" }]);
});

test("none of the three entries changes the run, the cards, the counters or the meta", () => {
  const { c } = created();
  c.add("run.started", { run: "run-1", pipeline: "investigate", pipeline_hash: "a".repeat(64), stages });
  c.add("stage.started", { stage: "collect", attempt: 1 });
  c.add("run.paused", { reason: "the stage ran too often", hold: { kind: "stage_runs", stage: "collect" } });
  const before = c.state();
  expect(before.run).toMatchObject({ status: "paused", hold: { kind: "stage_runs", stage: "collect" } });
  c.add("case.unloaded", { store: "store", head: c.head() }, person);
  c.add("case.loaded", { file: "CASE-1.TLP-GREEN.tar.gz", head: c.head(), id: "CASE-1" }, person);
  const after = c.state();
  expect(after.skipped).toEqual([]);
  expect(after).toEqual({ ...before, seq: after.seq, head_ts: after.head_ts, archive: after.archive });
  expect(after.archive).toMatchObject({ unloads: 1, loads: 1, pending: null });
});

test("the fold does not change the entries it reads", () => {
  const { c } = created();
  c.add("case.unloaded", { store: "store", head: c.head() }, person);
  c.add("case.unload_failed", { reason: "r" }, code);
  c.add("case.loaded", { file: "f", head: c.head(), id: "CASE-1" }, person);
  const copy = structuredClone(c.entries);
  c.state();
  expect(c.entries).toEqual(copy);
});

// ---------- the person's choice at the gate ----------

/** A case whose run waits at the publish gate. */
function atPublish(): Chain {
  const { c } = created();
  c.add("run.started", { run: "run-1", pipeline: "investigate", pipeline_hash: "a".repeat(64), stages });
  c.add("stage.started", { stage: "publish", attempt: 1 });
  c.add("gate.waiting", { gate: "publish" });
  return c;
}

test("a person's gate.passed of the publish gate with unload_after true sets it; without the field, or with false, it stays false", () => {
  const t = atPublish();
  t.add("gate.passed", { gate: "publish", unload_after: true }, person);
  expect(t.state().archive.unload_after).toBe(true);
  expect(t.state().run.waiting).toBeNull();
  for (const payload of [{ gate: "publish" }, { gate: "publish", unload_after: false }] as const) {
    const c = atPublish();
    c.add("gate.passed", payload, person);
    expect(c.state().archive.unload_after).toBe(false);
    expect(c.state().skipped).toEqual([]);
  }
  expect(t.state().skipped).toEqual([]);
});

test("unload_after on the plan gate, on a pass by code, or on a pass the run is not waiting for, is not read", () => {
  const plan: StageDef[] = [{ id: "plan", title: "Plan", phase: "direct", runs: "agent", gate: "plan", reviews: false, model: null }, ...stages];
  const { c: p } = created();
  p.add("run.started", { run: "run-1", pipeline: "investigate", pipeline_hash: "a".repeat(64), stages: plan });
  p.add("stage.started", { stage: "plan", attempt: 1 });
  p.add("gate.waiting", { gate: "plan" });
  p.add("gate.passed", { gate: "plan", unload_after: true } as never, person);
  expect(p.state().archive.unload_after).toBe(false);
  expect(p.state().run.waiting).toBeNull();
  expect(p.state().skipped).toEqual([]);

  const byCode = atPublish();
  byCode.add("gate.passed", { gate: "publish", unload_after: true }, code);
  expect(byCode.state().archive.unload_after).toBe(false);
  expect(byCode.state().skipped).toEqual([]);

  const { c: idle } = created();
  idle.add("run.started", { run: "run-1", pipeline: "investigate", pipeline_hash: "a".repeat(64), stages });
  idle.add("gate.passed", { gate: "publish", unload_after: true }, person);
  expect(idle.state().run.waiting).toBeNull();
  expect(idle.state().archive.unload_after).toBe(false);
  expect(idle.state().skipped).toEqual([]);
});

test("unload_after that is not a boolean is recorded as skipped and read as absent; the gate still passes", () => {
  const c = atPublish();
  const pass = c.add("gate.passed", { gate: "publish", unload_after: "yes" } as never, person);
  const s = c.state();
  expect(s.skipped.at(-1)).toMatchObject({ seq: pass.seq, type: "gate.passed", reason: "unload_after is true or false" });
  expect(s.run.waiting).toBeNull();
  expect(s.run.status).toBe("running");
  expect(s.archive.unload_after).toBe(false);
});

test("run.started, case.unloaded and case.unload_failed each clear unload_after", () => {
  const ticked = () => { const c = atPublish(); c.add("gate.passed", { gate: "publish", unload_after: true }, person); return c; };
  const a = ticked();
  a.add("run.started", { run: "run-2", pipeline: "investigate", pipeline_hash: "a".repeat(64), stages });
  expect(a.state().archive.unload_after).toBe(false);
  const b = ticked();
  b.add("case.unloaded", { store: "store", head: b.head() }, code);
  expect(b.state().archive.unload_after).toBe(false);
  const f = ticked();
  f.add("case.unload_failed", { reason: "the store folder is not there" }, code);
  expect(f.state().archive.unload_after).toBe(false);
  for (const c of [a, b, f]) expect(c.state().skipped).toEqual([]);
});

test("unloadDue is true only for a run finished as published with unload_after set", () => {
  const c = atPublish();
  expect(unloadDue(c.state())).toBe(false);
  c.add("gate.passed", { gate: "publish", unload_after: true }, person);
  expect(unloadDue(c.state())).toBe(false);
  c.add("run.finished", { outcome: "published" });
  expect(unloadDue(c.state())).toBe(true);
  c.add("case.unload_failed", { reason: "the store folder is not there" }, code);
  expect(unloadDue(c.state())).toBe(false);

  const stopped = atPublish();
  stopped.add("gate.passed", { gate: "publish", unload_after: true }, person);
  stopped.add("run.finished", { outcome: "stopped", reason: "not now" }, person);
  expect(unloadDue(stopped.state())).toBe(false);

  const unticked = atPublish();
  unticked.add("gate.passed", { gate: "publish" }, person);
  unticked.add("run.finished", { outcome: "published" });
  expect(unloadDue(unticked.state())).toBe(false);
  for (const x of [c, stopped, unticked]) expect(x.state().skipped).toEqual([]);
});
