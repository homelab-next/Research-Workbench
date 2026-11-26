import { expect, test } from "bun:test";
import { apply, fold, initial } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Payloads, PlanStep } from "../../src/core/types";
import { EntryBuilder } from "../helpers/entries";

const person = { kind: "human" as const, id: "analyst" };
const WINDOW = { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" };

const startedPayload = (job = "j1"): Payloads["playbook.started"] => ({
  job, playbook: "address-triage", playbook_hash: "ph", title: "Triage an address", inputs: [{ type: "address", value: "198.51.100.77" }],
  window: WINDOW, why: "w", plan_step: null,
  steps: [{ id: "asset", pivot: "address_to_asset", pivot_hash: "h1" }, { id: "lease", pivot: "address_to_asset_by_lease", pivot_hash: "h2" }],
});
const assetStep = (job = "j1"): Payloads["playbook.step"] => ({
  job, step: "asset", pivot: "address_to_asset", status: "ran", reason: "",
  lookups: [{ value: "198.51.100.77", outcome: "empty", rows: 0, query: "q1", card: "c1", reused: false, detail: "proven negative" }], found: [], left: 0,
});
const leaseStep = (job = "j1"): Payloads["playbook.step"] => ({
  job, step: "lease", pivot: "address_to_asset_by_lease", status: "skipped", reason: "asset returned rows", lookups: [], found: [], left: 0,
});
const finishedPayload = (job = "j1"): Payloads["playbook.finished"] => ({
  job, outcome: "empty", end_step: "asset", cards: ["c1"], end_cards: ["c1"], caveats: [], lookups: 1, reused: 0,
});

function run(): EntryBuilder {
  const b = new EntryBuilder();
  b.add("job.started", { job: "j1", title: "Playbook: Triage an address on 198.51.100.77", kind: "playbook", source: null }, { actor: person, job: "j1" });
  b.add("playbook.started", startedPayload(), { actor: person, job: "j1" });
  b.add("playbook.step", assetStep(), { actor: person, job: "j1" });
  b.add("playbook.step", leaseStep(), { actor: person, job: "j1" });
  b.add("playbook.finished", finishedPayload(), { actor: person, job: "j1" });
  b.add("job.finished", { job: "j1", outcome: "done" }, { actor: person, job: "j1" });
  return b;
}

test("the three entries fold into one playbook run", () => {
  const s = fold(run().entries);
  expect(s.skipped).toEqual([]);
  expect(s.jobs.j1).toMatchObject({ kind: "playbook", status: "done" });
  const p = s.playbooks.j1!;
  expect(p).toMatchObject({ job: "j1", playbook: "address-triage", title: "Triage an address", plan_step: null, started_seq: 2, status: "empty", end_step: "asset", cards: ["c1"], end_cards: ["c1"], caveats: [] });
  expect(p.inputs).toEqual([{ type: "address", value: "198.51.100.77" }]);
  expect(p.window).toEqual(WINDOW);
  expect(p.order).toEqual(["asset", "lease"]);
  expect(p.steps.asset).toEqual(assetStep());
  expect(p.steps.lease).toEqual(leaseStep());
});

test("the state at entry N during a run is the fold of the first N entries", () => {
  const b = run();
  let s: CaseState = initial();
  for (const e of b.entries) {
    s = apply(s, e);
    expect(s).toEqual(fold(b.entries, e.seq));
  }
  expect(fold(b.entries, 2).playbooks.j1).toMatchObject({ status: "running", order: [], steps: {} });
  expect(fold(b.entries, 3).playbooks.j1!.order).toEqual(["asset"]);
});

test("a step or an end for an unknown or finished job is skipped as malformed", () => {
  const b = run();
  b.add("playbook.step", assetStep("j9"), { actor: person });
  b.add("playbook.finished", finishedPayload("j9"), { actor: person });
  b.add("playbook.step", assetStep("j1"), { actor: person });
  b.add("playbook.finished", finishedPayload("j1"), { actor: person });
  const s = fold(b.entries);
  expect(s.skipped.map((x) => [x.seq, x.reason])).toEqual([
    [7, "malformed playbook.step"], [8, "malformed playbook.finished"], [9, "malformed playbook.step"], [10, "malformed playbook.finished"],
  ]);
  expect(s.playbooks.j9).toBeUndefined();
});

test("a payload of the wrong shape is recorded in skipped", () => {
  const b = new EntryBuilder();
  b.add("playbook.started", { ...startedPayload(), steps: [{ id: "asset" }] } as never);
  b.add("playbook.started", startedPayload("j2"));
  b.add("playbook.step", { ...assetStep("j2"), lookups: [{ value: "x", outcome: "nothing" }] } as never);
  b.add("playbook.step", { ...assetStep("j2"), status: "maybe" } as never);
  b.add("playbook.finished", { ...finishedPayload("j2"), outcome: "fine" } as never);
  const s = fold(b.entries);
  expect(s.skipped.map((x) => x.reason)).toEqual(["malformed playbook.started", "malformed playbook.step", "malformed playbook.step", "malformed playbook.finished"]);
  expect(Object.keys(s.playbooks)).toEqual(["j2"]);
  expect(s.playbooks.j2!.status).toBe("running");
});

test("a failed job turns its running playbook to interrupted, and leaves a finished one alone", () => {
  const b = new EntryBuilder();
  b.add("job.started", { job: "j1", title: "t", kind: "playbook", source: null });
  b.add("playbook.started", startedPayload("j1"));
  b.add("job.started", { job: "j2", title: "t", kind: "playbook", source: null });
  b.add("playbook.started", startedPayload("j2"));
  b.add("playbook.finished", finishedPayload("j2"));
  b.add("job.finished", { job: "j1", outcome: "failed" });
  b.add("job.finished", { job: "j2", outcome: "failed" });
  const s = fold(b.entries);
  expect(s.playbooks.j1!.status).toBe("interrupted");
  expect(s.playbooks.j2!.status).toBe("empty");
  expect(s.skipped).toEqual([]);
});

test("the input state is not mutated", () => {
  const b = run();
  b.add("job.started", { job: "j2", title: "t", kind: "playbook", source: null });
  b.add("playbook.started", startedPayload("j2"));
  b.add("job.finished", { job: "j2", outcome: "failed" });
  let s = deepFreeze(initial());
  for (const e of b.entries) s = deepFreeze(apply(s, e));
  expect(s.skipped).toEqual([]);
  expect(s.playbooks.j2!.status).toBe("interrupted");
});

test("the new purpose, job kind, plan step and inventory fields fold, and an entry without them folds as before", () => {
  const b = new EntryBuilder();
  const issued: Payloads["query.issued"] = {
    query: "q1", source: "assets", source_hash: "h", pivot: "address_to_asset", pivot_hash: "ph", connector: "files", text: "t", bound: { value: "x" },
    window: WINDOW, why: "w", estimate: null, step: null, verifies: null, purpose: "playbook",
  };
  b.add("query.issued", issued);
  b.add("query.issued", { ...issued, query: "q2", purpose: "result", inventory: { id: "assets", hash: "ih", complete: true } });
  b.add("query.issued", { ...issued, query: "q3", inventory: { id: "assets", complete: "yes" } } as never);
  const step: PlanStep = {
    id: "s1", subgoal: "g1", pivot: "address_to_asset", source: "assets", from: { type: "address", value: "x" }, to: "asset", window: WINDOW,
    needs_window: false, free: true, weight: 0, estimate: null, empty_means: "proven-negative", warnings: [],
  };
  const plan = (id: string, steps: PlanStep[]) => ({ id, goal: "g", window: WINDOW, subgoals: [{ id: "g1", title: "t", question: "q", steps: ["s1"] }], steps });
  b.add("plan.proposed", { plan: plan("plan-1", [step]) });
  b.add("plan.proposed", { plan: plan("plan-2", [{ ...step, playbook: { id: "address-triage", hash: "ph", inputs: [{ type: "address", value: "x" }] } }]) });
  b.add("plan.proposed", { plan: plan("plan-3", [{ ...step, playbook: { id: "address-triage" } } as never]) });
  const s = fold(b.entries);
  expect(s.queries.q1!.purpose).toBe("playbook");
  expect(s.queries.q2!.purpose).toBe("result");
  expect(s.queries.q3).toBeUndefined();
  expect(s.plan.current!.id).toBe("plan-2");
  expect(s.skipped.map((x) => [x.seq, x.reason])).toEqual([[3, "malformed query.issued"], [6, "malformed plan.proposed"]]);
});

function deepFreeze<T>(x: T): T {
  if (typeof x === "object" && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}
