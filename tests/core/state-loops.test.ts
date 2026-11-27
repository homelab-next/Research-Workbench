import { expect, test } from "bun:test";
import { apply, depthOf, fold, initial, initialLoop, loopOf, subloopKey } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Actor, BlobRef, Entry, Payloads, StageDef } from "../../src/core/types";
import { EntryBuilder } from "../helpers/entries";

const person: Actor = { kind: "human", id: "analyst" };
const code: Actor = { kind: "system", id: "engine" };
const researcher: Actor = { kind: "agent", id: "researcher", stage: "investigate", profile: "investigation", model: "scripted-m", effort: null, where: "machine" };
const lock: BlobRef = { blob: "a".repeat(64), bytes: 10 };
const H = "b".repeat(64);
const IH = "c".repeat(64);
const HH = "d".repeat(64);
const OH = "e".repeat(64);

const CASE: Payloads["case.created"] = {
  id: "CASE-2", title: "Beaconing", asked: "Is 192.0.2.10 beaconing?", why: "alert", starting: [{ type: "ip", value: "192.0.2.10" }],
  window: { from: null, to: null }, objective: null, marking: "TLP:AMBER",
};
const stages: StageDef[] = [
  { id: "plan", title: "Plan", phase: "direct", runs: "agent", gate: "plan", reviews: false, model: null },
  { id: "investigate", title: "Investigate", phase: "collect", runs: "loop", gate: null, reviews: false, model: null },
];
const runStarted = (run: string, pipeline_hash = H): Payloads["run.started"] => ({ run, pipeline: "triage", pipeline_hash, stages });
const bound = (over: Partial<Payloads["loop.bound"]> = {}): Payloads["loop.bound"] => ({ loop: "triage", version: 3, hash: H, lock, ...over });
const child = (over: Partial<Payloads["subloop.child"]> = {}): Payloads["subloop.child"] => ({
  parent: "CASE-1", run: "run-1", stage: "investigate", attempt: 1, loop: "investigation", input_hash: IH, depth: 1, floor: "TLP:AMBER", ...over,
});
const started = (over: Partial<Payloads["subloop.started"]> = {}): Payloads["subloop.started"] => ({
  stage: "investigate", attempt: 1, child: "CASE-2", loop: "investigation", loop_hash: H, input_hash: IH, inputs: lock, depth: 1, ...over,
});
const finished = (over: Partial<Payloads["subloop.finished"]> = {}): Payloads["subloop.finished"] => ({
  stage: "investigate", attempt: 1, child: "CASE-2", child_run: "run-1", head: { seq: 88, hash: HH }, outcome: "published", output_hash: OH, output: lock, cards: ["c7", "c8"], ...over,
});

/** A case with a run in progress. */
function running(): EntryBuilder {
  const b = new EntryBuilder();
  b.add("case.created", CASE, { actor: person });
  b.add("run.started", runStarted("run-1"), { actor: code });
  return b;
}

// ---------- the loop of a case and the bound version ----------

test("a ledger with no case.loop_set has loop id null, and loopOf gives the fallback", () => {
  const s = fold(running().entries);
  expect(s.loop).toEqual({ id: null, pending: null, bound: null, parent: null, children: {}, child_count: 0 });
  expect(loopOf(s, "investigation")).toBe("investigation");
  expect(initial().loop).toEqual(initialLoop());
  expect(s.skipped).toEqual([]);
});

test("case.loop_set by a person or by code sets the loop; after a run.started it is skipped: a case's loop is set before its first run", () => {
  const b = new EntryBuilder();
  b.add("case.created", CASE, { actor: person });
  b.add("case.loop_set", { loop: "triage" }, { actor: person });
  expect(fold(b.entries).loop.id).toBe("triage");
  expect(loopOf(fold(b.entries), "investigation")).toBe("triage");
  b.add("case.loop_set", { loop: "hunt" }, { actor: code });
  expect(fold(b.entries).loop.id).toBe("hunt");
  b.add("run.started", runStarted("run-1"), { actor: code });
  const late = b.add("case.loop_set", { loop: "triage" }, { actor: person });
  const s = fold(b.entries);
  expect(s.loop.id).toBe("hunt");
  expect(s.skipped).toEqual([{ seq: late.seq, type: "case.loop_set", reason: "a case's loop is set before its first run" }]);
});

test("loop.bound followed by a run.started naming its hash is the bound version of that run", () => {
  const b = new EntryBuilder();
  b.add("case.created", CASE, { actor: person });
  const at = b.add("loop.bound", bound(), { actor: person });
  const pending = fold(b.entries).loop.pending;
  expect(pending).toEqual({ loop: "triage", version: 3, hash: H, lock, seq: at.seq });
  b.add("run.started", runStarted("run-1"), { actor: person });
  const s = fold(b.entries);
  expect(s.loop.bound).toEqual({ loop: "triage", version: 3, hash: H, lock, seq: at.seq });
  expect(s.loop.pending).toBeNull();
  expect(s.skipped).toEqual([]);
});

test("a run.started with another pipeline_hash, or with no loop.bound before it, has bound null", () => {
  const b = new EntryBuilder();
  b.add("case.created", CASE, { actor: person });
  b.add("loop.bound", bound(), { actor: code });
  b.add("run.started", runStarted("run-1", "f".repeat(64)), { actor: code });
  let s = fold(b.entries);
  expect(s.loop.bound).toBeNull();
  expect(s.loop.pending).toBeNull();
  // a second run started with no loop.bound after a bound one: bound is null again
  b.add("run.finished", { outcome: "completed" }, { actor: code });
  b.add("loop.bound", bound({ version: 4 }), { actor: code });
  b.add("run.started", runStarted("run-2"), { actor: code });
  expect(fold(b.entries).loop.bound).toMatchObject({ version: 4 });
  b.add("run.finished", { outcome: "completed" }, { actor: code });
  b.add("run.started", runStarted("run-3"), { actor: code });
  s = fold(b.entries);
  expect(s.loop.bound).toBeNull();
  expect(s.loop.pending).toBeNull();
  expect(s.skipped).toEqual([]);
});

test("loop.bound by an agent is skipped: a run's loop version is recorded by a person or the workbench", () => {
  const b = new EntryBuilder();
  b.add("case.created", CASE, { actor: person });
  const e = b.add("loop.bound", bound(), { actor: researcher });
  b.add("run.started", runStarted("run-1"), { actor: code });
  const s = fold(b.entries);
  expect(s.loop.bound).toBeNull();
  expect(s.skipped).toEqual([{ seq: e.seq, type: "loop.bound", reason: "a run's loop version is recorded by a person or the workbench" }]);
});

test("a malformed case.loop_set, loop.bound, subloop.child, subloop.started or subloop.finished is recorded as malformed", () => {
  // loop: 1 · version: "3" · lock: {} · depth: -1 · head: { seq: "4" } · outcome: "done" · cards: [1]
  const cases: [Entry["type"], unknown][] = [
    ["case.loop_set", { loop: 1 }],
    ["loop.bound", { ...bound(), version: "3" }],
    ["loop.bound", { ...bound(), lock: {} }],
    ["subloop.child", { ...child(), depth: -1 }],
    ["subloop.started", { ...started(), depth: -1 }],
    ["subloop.finished", { ...finished(), head: { seq: "4", hash: HH } }],
    ["subloop.finished", { ...finished(), outcome: "done" }],
    ["subloop.finished", { ...finished(), cards: [1] }],
  ];
  for (const [type, payload] of cases) {
    const b = new EntryBuilder();
    b.add("case.created", CASE, { actor: person });
    const e = b.add(type, payload as never, { actor: code });
    const s = fold(b.entries);
    expect(s.skipped, `${type} ${JSON.stringify(payload)}`).toEqual([{ seq: e.seq, type, reason: `malformed ${type}` }]);
    expect(s.loop).toEqual(initialLoop());
  }
});

// ---------- the parent link and the children ----------

test("subloop.child by code, right after case.created, is the case's parent, and depthOf is its depth", () => {
  const b = new EntryBuilder();
  b.add("case.created", CASE, { actor: code });
  b.add("case.loop_set", { loop: "investigation" }, { actor: code });
  b.add("subloop.child", child(), { actor: code });
  const s = fold(b.entries);
  expect(s.loop.parent).toEqual({ case: "CASE-1", run: "run-1", stage: "investigate", attempt: 1, loop: "investigation", input_hash: IH, depth: 1, floor: "TLP:AMBER" });
  expect(depthOf(s)).toBe(1);
  expect(depthOf(fold(running().entries))).toBe(0);
  expect(s.skipped).toEqual([]);
});

test("subloop.child by a person or an agent, after a run started, or a second one, is skipped with its reason", () => {
  // "a child's parent is recorded by the workbench when the case is made"
  const reason = "a child's parent is recorded by the workbench when the case is made";
  for (const actor of [person, researcher]) {
    const b = new EntryBuilder();
    b.add("case.created", CASE, { actor: code });
    const e = b.add("subloop.child", child(), { actor });
    const s = fold(b.entries);
    expect(s.loop.parent).toBeNull();
    expect(s.skipped).toEqual([{ seq: e.seq, type: "subloop.child", reason }]);
  }
  const late = running();
  const e = late.add("subloop.child", child(), { actor: code });
  expect(fold(late.entries).loop.parent).toBeNull();
  expect(fold(late.entries).skipped).toEqual([{ seq: e.seq, type: "subloop.child", reason }]);

  const twice = new EntryBuilder();
  twice.add("case.created", CASE, { actor: code });
  twice.add("subloop.child", child(), { actor: code });
  const second = twice.add("subloop.child", child({ parent: "CASE-9" }), { actor: code });
  const s = fold(twice.entries);
  expect(s.loop.parent).toMatchObject({ case: "CASE-1" });
  expect(s.skipped).toEqual([{ seq: second.seq, type: "subloop.child", reason }]);

  // one written later than the case's first commit could hold it
  const far = new EntryBuilder();
  far.add("case.created", CASE, { actor: code });
  far.add("case.phase_changed", { phase: "direct" }, { actor: code });
  far.add("case.phase_changed", { phase: "collect" }, { actor: code });
  const fourth = far.add("subloop.child", child(), { actor: code });
  expect(fold(far.entries).skipped).toEqual([{ seq: fourth.seq, type: "subloop.child", reason }]);
});

test("subloop.started opens a child under run/stage/attempt and counts it", () => {
  const b = running();
  const e = b.add("subloop.started", started(), { actor: code });
  const s = fold(b.entries);
  expect(Object.keys(s.loop.children)).toEqual(["run-1/investigate/1"]);
  expect(s.loop.child_count).toBe(1);
  expect(s.loop.children["run-1/investigate/1"]).toMatchObject({ child: "CASE-2", loop: "investigation", input_hash: IH, depth: 1, finished: null });
  expect(s.loop.children[subloopKey("run-1", "investigate", 1)]).toEqual({
    key: "run-1/investigate/1", run: "run-1", stage: "investigate", attempt: 1, child: "CASE-2", loop: "investigation", loop_hash: H, input_hash: IH,
    inputs: lock, depth: 1, started_seq: e.seq, finished: null,
  });
  expect(s.skipped).toEqual([]);
});

test("subloop.started with no run in progress, for a stage that is not the run's, or for a key already open is skipped", () => {
  const none = new EntryBuilder();
  none.add("case.created", CASE, { actor: person });
  const e1 = none.add("subloop.started", started(), { actor: code });
  let s = fold(none.entries);
  expect(s.loop.child_count).toBe(0);
  expect(s.skipped).toEqual([{ seq: e1.seq, type: "subloop.started", reason: "a sub-loop starts at a stage of the run in progress" }]);

  const done = running();
  done.add("run.finished", { outcome: "completed" }, { actor: code });
  const e2 = done.add("subloop.started", started(), { actor: code });
  expect(fold(done.entries).skipped).toEqual([{ seq: e2.seq, type: "subloop.started", reason: "a sub-loop starts at a stage of the run in progress" }]);

  const other = running();
  const e3 = other.add("subloop.started", started({ stage: "collect" }), { actor: code });
  expect(fold(other.entries).skipped).toEqual([{ seq: e3.seq, type: "subloop.started", reason: "a sub-loop starts at a stage of the run in progress" }]);

  const again = running();
  again.add("subloop.started", started(), { actor: code });
  const e4 = again.add("subloop.started", started({ child: "CASE-3" }), { actor: code });
  s = fold(again.entries);
  expect(s.loop.child_count).toBe(1);
  expect(s.loop.children["run-1/investigate/1"]!.child).toBe("CASE-2");
  expect(s.skipped).toEqual([{ seq: e4.seq, type: "subloop.started", reason: "a sub-loop starts once for a stage's attempt" }]);

  const agent = running();
  const e5 = agent.add("subloop.started", started(), { actor: researcher });
  expect(fold(agent.entries).loop.child_count).toBe(0);
  expect(fold(agent.entries).skipped).toEqual([{ seq: e5.seq, type: "subloop.started", reason: "a sub-loop is recorded by the workbench" }]);
});

test("subloop.finished closes the child it names with the head, the outcome, the output hash and the cards", () => {
  const b = running();
  b.add("subloop.started", started(), { actor: code });
  const fin = b.add("subloop.finished", finished(), { actor: code });
  const s = fold(b.entries);
  const k = subloopKey("run-1", "investigate", 1);
  expect(s.loop.children[k]!.finished).toEqual({ child_run: "run-1", head: { seq: 88, hash: HH }, outcome: "published", output_hash: OH, output: lock, cards: ["c7", "c8"], seq: fin.seq });
  expect(s.loop.child_count).toBe(1);
  expect(s.skipped).toEqual([]);
});

test("subloop.finished for a key that is not open, already finished, or naming another child is skipped: a sub-loop finishes once, as the child it started", () => {
  const reason = "a sub-loop finishes once, as the child it started";
  const closed = running();
  const e1 = closed.add("subloop.finished", finished(), { actor: code });
  expect(fold(closed.entries).skipped).toEqual([{ seq: e1.seq, type: "subloop.finished", reason }]);

  const twice = running();
  twice.add("subloop.started", started(), { actor: code });
  const first = twice.add("subloop.finished", finished(), { actor: code });
  const e2 = twice.add("subloop.finished", finished({ outcome: "stopped" }), { actor: code });
  let s = fold(twice.entries);
  expect(s.loop.children["run-1/investigate/1"]!.finished).toMatchObject({ outcome: "published", seq: first.seq });
  expect(s.skipped).toEqual([{ seq: e2.seq, type: "subloop.finished", reason }]);

  const other = running();
  other.add("subloop.started", started(), { actor: code });
  const e3 = other.add("subloop.finished", finished({ child: "CASE-3" }), { actor: code });
  s = fold(other.entries);
  expect(s.loop.children["run-1/investigate/1"]!.finished).toBeNull();
  expect(s.skipped).toEqual([{ seq: e3.seq, type: "subloop.finished", reason }]);

  const agent = running();
  agent.add("subloop.started", started(), { actor: code });
  const e4 = agent.add("subloop.finished", finished(), { actor: researcher });
  expect(fold(agent.entries).loop.children["run-1/investigate/1"]!.finished).toBeNull();
  expect(fold(agent.entries).skipped).toEqual([{ seq: e4.seq, type: "subloop.finished", reason: "a sub-loop is recorded by the workbench" }]);
});

test("the count of children runs over the whole case, not one run", () => {
  /* two runs, one child each: child_count 2 */
  const b = running();
  b.add("subloop.started", started(), { actor: code });
  b.add("subloop.finished", finished(), { actor: code });
  b.add("run.finished", { outcome: "completed" }, { actor: code });
  b.add("run.started", runStarted("run-2"), { actor: code });
  b.add("subloop.started", started({ child: "CASE-3" }), { actor: code });
  const s = fold(b.entries);
  expect(Object.keys(s.loop.children)).toEqual(["run-1/investigate/1", "run-2/investigate/1"]);
  expect(s.loop.child_count).toBe(2);
  expect(s.loop.children["run-1/investigate/1"]!.finished).not.toBeNull();
  expect(s.skipped).toEqual([]);
});

test("none of the five entries changes the run, the cards, the plan, the counters or the meta", () => {
  // a paused run with a hold, then each entry: toEqual the state before it in every field but seq, head_ts and loop
  const without = ({ seq: _a, head_ts: _b, loop: _c, ...rest }: CaseState) => rest;
  const b = new EntryBuilder();
  b.add("case.created", CASE, { actor: code });
  const steps: [Entry["type"], unknown][] = [["case.loop_set", { loop: "investigation" }], ["subloop.child", child()]];
  let s = fold(b.entries);
  const step = (type: Entry["type"], payload: unknown) => {
    const before = s;
    const e = b.add(type, payload as never, { actor: code });
    s = apply(before, e);
    expect(without(s), type).toEqual(without(before));
    expect(s.loop, type).not.toEqual(before.loop);
  };
  for (const [type, payload] of steps) step(type, payload);
  s = apply(s, b.add("run.started", runStarted("run-1"), { actor: code }));
  s = apply(s, b.add("stage.started", { stage: "investigate", attempt: 1 }, { actor: code }));
  s = apply(s, b.add("run.paused", { reason: "waiting on child CASE-3: plan gate", hold: { kind: "child", stage: "investigate", child: "CASE-3" } }, { actor: code }));
  expect(s.run).toMatchObject({ status: "paused", hold: { kind: "child", stage: "investigate", child: "CASE-3" } });
  step("loop.bound", bound({ version: 5 }));
  step("subloop.started", started({ child: "CASE-3" }));
  step("subloop.finished", finished({ child: "CASE-3" }));
  expect(s.skipped).toEqual([]);
  expect(fold(b.entries)).toEqual(s);
});

test("the fold does not change the payloads it reads", () => {
  const b = running();
  b.add("loop.bound", bound(), { actor: code });
  b.add("subloop.started", started(), { actor: code });
  b.add("subloop.finished", finished(), { actor: code });
  const copy = structuredClone(b.entries);
  const s = fold(b.entries);
  expect(b.entries).toEqual(copy);
  // the state shares nothing with them
  s.loop.children["run-1/investigate/1"]!.finished!.cards.push("c99");
  (s.loop.pending as { lock: BlobRef }).lock.bytes = 99;
  expect(b.entries).toEqual(copy);
});
