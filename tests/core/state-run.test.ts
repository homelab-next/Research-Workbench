import { expect, test } from "bun:test";
import { apply, fold, initial, runUsage } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Entry, ModelChoice, Plan, StageDef } from "../../src/core/types";
import { EntryBuilder, card } from "../helpers/entries";

const stages: StageDef[] = [
  { id: "plan", title: "Plan", phase: "direct", runs: "agent", gate: "plan", reviews: false, model: { provider: "scripted", model: "m", effort: null } },
  { id: "checks", title: "Checks", phase: "produce", runs: "script", gate: null, reviews: true, model: null },
];
const X: ModelChoice = { provider: "scripted", model: "x", effort: "high" };

function started(): EntryBuilder {
  const b = new EntryBuilder();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  return b;
}

function plan(id = "plan-1"): Plan {
  const step = (sid: string) => ({
    id: sid, subgoal: "sg1", pivot: "ip", source: "src", from: { type: "ip", value: "192.0.2.10" }, to: "domain",
    window: { from: null, to: null }, needs_window: false, free: true, weight: 1, estimate: null, empty_means: "not-seen" as const, warnings: [],
  });
  return { id, goal: "g", window: { from: null, to: null }, subgoals: [{ id: "sg1", title: "T", question: "Q", steps: ["s1", "s2"] }], steps: [step("s1"), step("s2")] };
}

function issue(b: EntryBuilder, q = "q1") {
  return b.add("query.issued", {
    query: q, source: "src", source_hash: "h", pivot: null, pivot_hash: null, connector: "c", text: "select 1", bound: {},
    window: { from: null, to: null }, why: "w", estimate: null, step: "s1", verifies: null, purpose: "result",
  }, { actor: { kind: "agent", id: "a1", stage: "collect", profile: "p", model: "m", effort: null, where: "machine" } });
}

test("run.started lists the stages as idle", () => {
  const s = fold(started().entries);
  expect(s.run).toMatchObject({ id: "run-1", status: "running", waiting: null, current: null, outcome: null });
  expect(s.run.stages.map((x) => [x.id, x.status, x.attempts, x.last_reason])).toEqual([["plan", "idle", 0, null], ["checks", "idle", 0, null]]);
  expect(s.counters.run).toBe(1);
});

test("a model chosen before the run starts is used when it starts", () => {
  const b = new EntryBuilder();
  b.add("stage.model_set", { stage: "plan", choice: X });
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  const s = fold(b.entries);
  expect(s.run.stages[0]!.model).toEqual(X);
  expect(s.stage_models.plan).toEqual(X);
});

test("a model chosen during the run updates the stage", () => {
  const b = started();
  b.add("stage.model_set", { stage: "checks", choice: X });
  const s = fold(b.entries);
  expect(s.run.stages[1]!.model).toEqual(X);
  expect(s.stage_models.checks).toEqual(X);
});

test("stage.started marks the stage running and current", () => {
  const b = started();
  b.add("stage.started", { stage: "plan", attempt: 2 });
  const s = fold(b.entries);
  expect(s.run.stages[0]).toMatchObject({ status: "running", attempts: 2 });
  expect(s.run.current).toBe("plan");
  expect(s.run.status).toBe("running");
});

test("stage.started leaves a paused run paused", () => {
  const b = started();
  b.add("run.paused", { reason: "r" });
  b.add("stage.started", { stage: "plan", attempt: 1 });
  expect(fold(b.entries).run.status).toBe("paused");
});

test("stage.finished maps pass, fail and declined to passed, failed and declined", () => {
  const b = started();
  const out = (outcome: "pass" | "fail" | "declined", reason: string | null) =>
    b.add("stage.finished", { stage: "plan", attempt: 1, outcome, draft_hash: null, output: null, reason });
  out("pass", null);
  expect(fold(b.entries).run.stages[0]).toMatchObject({ status: "passed", last_reason: null });
  out("fail", "bad");
  expect(fold(b.entries).run.stages[0]).toMatchObject({ status: "failed", last_reason: "bad" });
  out("declined", "no");
  expect(fold(b.entries).run.stages[0]).toMatchObject({ status: "declined", last_reason: "no" });
});

test("stage.sent_back records the count and resets the target stage to idle", () => {
  const b = started();
  b.add("stage.finished", { stage: "plan", attempt: 1, outcome: "pass", draft_hash: null, output: null, reason: null });
  b.add("stage.sent_back", { from: "checks", to: "plan", reason: "r", count: 2 });
  const s = fold(b.entries);
  expect(s.run.sendbacks["checks>plan"]).toBe(2);
  expect(s.run.stages[0]!.status).toBe("idle");
});

test("gate.waiting puts the run and the gated stage in waiting; gate.passed clears it", () => {
  const b = started();
  b.add("gate.waiting", { gate: "plan" });
  let s = fold(b.entries);
  expect(s.run).toMatchObject({ status: "waiting", waiting: "plan" });
  expect(s.run.stages[0]!.status).toBe("waiting");
  b.add("gate.passed", { gate: "plan" });
  s = fold(b.entries);
  expect(s.run).toMatchObject({ status: "running", waiting: null });
  expect(s.run.stages[0]!.status).toBe("passed");
});

test("gate.waiting for a gate no stage has changes nothing", () => {
  const b = started();
  b.add("gate.waiting", { gate: "publish" });
  expect(fold(b.entries).run.status).toBe("running");
});

test("pause, resume, interrupted and finished set the run status", () => {
  const b = started();
  b.add("run.paused", { reason: "budget" });
  let s = fold(b.entries);
  expect(s.run).toMatchObject({ status: "paused", pause_reason: "budget" });
  b.add("run.resumed", {});
  s = fold(b.entries);
  expect(s.run).toMatchObject({ status: "running", pause_reason: null });
  b.add("run.interrupted", {});
  expect(fold(b.entries).run.status).toBe("interrupted");
  b.add("run.finished", { outcome: "published" });
  s = fold(b.entries);
  expect(s.run).toMatchObject({ status: "finished", outcome: "published" });
});

test("a second run.started replaces the run", () => {
  const b = started();
  b.add("stage.started", { stage: "plan", attempt: 1 });
  b.add("run.finished", { outcome: "stopped" });
  b.add("run.started", { run: "run-2", pipeline: "p", pipeline_hash: "h", stages });
  const s = fold(b.entries);
  expect(s.run).toMatchObject({ id: "run-2", status: "running", outcome: null, current: null });
  expect(s.run.stages[0]!.status).toBe("idle");
  expect(s.counters.run).toBe(2);
});

test("model.response adds usage and counts the call", () => {
  const b = started();
  for (const usage of [{ input: 10, output: 5, reasoning: 1 }, { input: 3, output: 2, reasoning: 4 }]) {
    b.add("model.response", { request: "r1", response: { blob: "b", bytes: 1 }, stop: "end", usage, served_by: "m", reasoning: null });
  }
  const s = fold(b.entries);
  expect(s.run.usage).toEqual({ input: 13, output: 7, reasoning: 5 });
  expect(s.run.model_calls).toBe(2);
});

test("model.blocked marks that stage blocked", () => {
  const b = started();
  b.add("model.blocked", { stage: "checks", marking: "TLP:RED", model: "m", where: "hosted" });
  expect(fold(b.entries).run.stages[1]!.status).toBe("blocked");
});

test("budget.set sets the token budget", () => {
  const b = started();
  b.add("budget.set", { tokens: 5000 });
  expect(fold(b.entries).run.budget_tokens).toBe(5000);
  b.add("budget.set", { tokens: null });
  expect(fold(b.entries).run.budget_tokens).toBeNull();
});

test("jobs start running and finish done or failed with an end time", () => {
  const b = new EntryBuilder();
  b.add("job.started", { job: "j1", title: "T", kind: "query", source: "src" });
  b.add("job.started", { job: "j2", title: "U", kind: "check", source: null });
  let s = fold(b.entries);
  expect(s.jobs.j1).toMatchObject({ id: "j1", title: "T", kind: "query", source: "src", status: "running", started_ts: b.entries[0]!.ts, ended_ts: null });
  expect(s.counters.job).toBe(2);
  b.add("job.finished", { job: "j1", outcome: "done" });
  b.add("job.finished", { job: "j2", outcome: "failed" });
  s = fold(b.entries);
  expect(s.jobs.j1).toMatchObject({ status: "done", ended_ts: b.entries[2]!.ts });
  expect(s.jobs.j2).toMatchObject({ status: "failed", ended_ts: b.entries[3]!.ts });
});

test("plan.proposed sets the plan with every step pending", () => {
  const b = new EntryBuilder();
  b.add("plan.proposed", { plan: plan() });
  const s = fold(b.entries);
  expect(s.plan.status).toBe("proposed");
  expect(s.plan.current).toEqual(plan());
  expect(s.plan.steps).toEqual({ s1: { status: "pending", cards: [], note: "" }, s2: { status: "pending", cards: [], note: "" } });
  expect(s.counters.plan).toBe(1);
});

test("plan.accepted records the accepted steps and budgets", () => {
  const b = new EntryBuilder();
  b.add("plan.proposed", { plan: plan() });
  b.add("plan.accepted", { plan: "plan-1", steps: ["s1"], budgets: { src: 3 } });
  const s = fold(b.entries);
  expect(s.plan).toMatchObject({ status: "accepted", accepted_steps: ["s1"], budgets: { src: 3 } });
});

test("plan.denied and plan.replan_requested set the status", () => {
  const b = new EntryBuilder();
  b.add("plan.proposed", { plan: plan() });
  b.add("plan.denied", { plan: "plan-1", reason: "no" });
  expect(fold(b.entries).plan.status).toBe("denied");
  b.add("plan.replan_requested", { plan: "plan-1", note: "again" });
  expect(fold(b.entries).plan.status).toBe("replanning");
});

test("a newer proposed plan replaces the old one", () => {
  const b = new EntryBuilder();
  b.add("plan.proposed", { plan: plan() });
  b.add("plan.accepted", { plan: "plan-1", steps: ["s1"], budgets: { src: 3 } });
  b.add("step.started", { step: "s1" });
  b.add("plan.proposed", { plan: { ...plan("plan-2"), steps: [plan().steps[0]!] } });
  const s = fold(b.entries);
  expect(s.plan).toMatchObject({ status: "proposed", accepted_steps: [], budgets: {} });
  expect(s.plan.current!.id).toBe("plan-2");
  expect(Object.keys(s.plan.steps)).toEqual(["s1"]);
  expect(s.plan.steps.s1!.status).toBe("pending");
  expect(s.counters.plan).toBe(2);
});

test("a plan decision for another plan id changes nothing", () => {
  const b = new EntryBuilder();
  b.add("plan.proposed", { plan: plan() });
  b.add("plan.denied", { plan: "plan-9", reason: "no" });
  b.add("plan.accepted", { plan: "plan-9", steps: [], budgets: {} });
  expect(fold(b.entries).plan.status).toBe("proposed");
});

test("step.started and step.finished track each step", () => {
  const b = new EntryBuilder();
  b.add("plan.proposed", { plan: plan() });
  b.add("step.started", { step: "s1" });
  expect(fold(b.entries).plan.steps.s1).toEqual({ status: "running", cards: [], note: "" });
  b.add("step.finished", { step: "s1", outcome: "partial", cards: ["c1", "c2"], note: "half" });
  let s = fold(b.entries);
  expect(s.plan.steps.s1).toEqual({ status: "partial", cards: ["c1", "c2"], note: "half" });
  b.add("step.started", { step: "s1" });
  s = fold(b.entries);
  expect(s.plan.steps.s1).toEqual({ status: "running", cards: ["c1", "c2"], note: "half" });
  b.add("step.started", { step: "nope" });
  expect(Object.keys(fold(b.entries).plan.steps)).toEqual(["s1", "s2"]);
});

test("query.issued then query.result fills the query", () => {
  const b = new EntryBuilder();
  const issued = issue(b);
  let s = fold(b.entries);
  expect(s.queries.q1).toMatchObject({
    id: "q1", source: "src", text: "select 1", why: "w", step: "s1", verifies: null, purpose: "result", status: "running",
    rows: null, rows_hash: null, coverage: null, result: null, error: null, card: null, issued_seq: 1, issued_ts: issued.ts, by: issued.actor,
  });
  expect(s.counters.query).toBe(1);
  b.add("query.result", { query: "q1", result: { blob: "b", bytes: 9 }, rows: 4, rows_hash: "rh", coverage: { kind: "full" }, duration_ms: 5, cost: null });
  s = fold(b.entries);
  expect(s.queries.q1).toMatchObject({ status: "done", rows: 4, rows_hash: "rh", coverage: { kind: "full" }, result: { blob: "b", bytes: 9 }, by: issued.actor, issued_seq: 1 });
});

test("query.failed records the error", () => {
  const b = new EntryBuilder();
  issue(b);
  b.add("query.failed", { query: "q1", error: "timeout" });
  expect(fold(b.entries).queries.q1).toMatchObject({ status: "failed", error: "timeout" });
});

test("a result for an unknown query changes nothing", () => {
  const b = new EntryBuilder();
  b.add("query.failed", { query: "q1", error: "x" });
  b.add("query.failed", { query: "constructor", error: "x" });
  expect(fold(b.entries).queries).toEqual({});
});

test("a result card links back to its query", () => {
  const b = new EntryBuilder();
  issue(b);
  b.add("card.created", { card: card("c1", { query: "q1" }) });
  b.add("card.created", { card: card("c2", { query: "q-missing" }) });
  const s = fold(b.entries);
  expect(s.queries.q1!.card).toBe("c1");
  expect(Object.keys(s.queries)).toEqual(["q1"]);
});

test("verify.run stamps the card as validated", () => {
  const b = new EntryBuilder();
  b.add("card.created", { card: card("c1") });
  const e = b.add("verify.run", { original: "q1", rerun: "q2", card: "c1", outcome: "differs", detail: "3 rows vs 4" });
  expect(fold(b.entries).cards.c1!.validated).toEqual({ outcome: "differs", detail: "3 rows vs 4", seq: e.seq, ts: e.ts });
});

test("verify.run with no re-run (null) still stamps the card", () => {
  const b = new EntryBuilder();
  b.add("card.created", { card: card("c1") });
  const e = b.add("verify.run", { original: "q1", rerun: null, card: "c1", outcome: "could_not_run", detail: "no budget" });
  const s = fold(b.entries);
  expect(s.skipped).toEqual([]);
  expect(s.cards.c1!.validated).toEqual({ outcome: "could_not_run", detail: "no budget", seq: e.seq, ts: e.ts });
});

test("proposals open, then are accepted with a budget or rejected with a reason", () => {
  const b = new EntryBuilder();
  const mk = (id: string) => ({
    id, kind: "costly_query" as const, title: "T", by: "a1", step: null, subgoal: null, source: "src", pivot: null, pivot_hash: null, source_hash: "sh1", text: "t",
    bound: {}, window: { from: null, to: null }, estimate: { amount: 5, unit: "usd" }, why: "w",
  });
  const e1 = b.add("proposal.created", { proposal: mk("p1") });
  b.add("proposal.created", { proposal: mk("p2") });
  let s = fold(b.entries);
  expect(s.proposals.p1).toMatchObject({ id: "p1", status: "open", seq: e1.seq, budget: null, reason: null });
  expect(s.counters.proposal).toBe(2);
  b.add("proposal.accepted", { proposal: "p1", budget: 7 });
  b.add("proposal.rejected", { proposal: "p2", reason: "too dear" });
  s = fold(b.entries);
  expect(s.proposals.p1).toMatchObject({ status: "accepted", budget: 7 });
  expect(s.proposals.p2).toMatchObject({ status: "rejected", reason: "too dear" });
});

test("case.phase_changed sets the phase", () => {
  const b = new EntryBuilder();
  b.add("case.phase_changed", { phase: "produce" });
  expect(fold(b.entries).phase).toBe("produce");
});

test("run entries before any run.started change only seq", () => {
  const b = new EntryBuilder();
  b.add("stage.started", { stage: "plan", attempt: 1 });
  b.add("stage.finished", { stage: "plan", attempt: 1, outcome: "pass", draft_hash: null, output: null, reason: null });
  b.add("stage.sent_back", { from: "checks", to: "plan", reason: "r", count: 1 });
  b.add("gate.waiting", { gate: "plan" });
  b.add("gate.passed", { gate: "plan" });
  b.add("run.paused", { reason: "r" });
  b.add("run.resumed", {});
  b.add("run.interrupted", {});
  b.add("run.finished", { outcome: "stopped" });
  b.add("model.blocked", { stage: "plan", marking: "TLP:RED", model: "m", where: "hosted" });
  const s = fold(b.entries);
  expect({ ...s, seq: 0, head_ts: null } as unknown).toEqual(initial());
  expect(s.seq).toBe(b.entries.length);
});

test("budget.set and stage.model_set apply with no run", () => {
  const b = new EntryBuilder();
  b.add("budget.set", { tokens: 10 });
  b.add("stage.model_set", { stage: "plan", choice: X });
  const s = fold(b.entries);
  expect(s.run.budget_tokens).toBe(10);
  expect(s.stage_models.plan).toEqual(X);
});

test("a budget set before the run survives run.started", () => {
  const b = new EntryBuilder();
  b.add("budget.set", { tokens: 10 });
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  expect(fold(b.entries).run.budget_tokens).toBe(10);
});

test("stage entries for an unknown stage change nothing", () => {
  const base = fold(started().entries);
  const b = started();
  b.add("stage.started", { stage: "nope", attempt: 1 });
  b.add("stage.started", { stage: "constructor", attempt: 1 });
  b.add("stage.finished", { stage: "toString", attempt: 1, outcome: "pass", draft_hash: null, output: null, reason: null });
  b.add("stage.sent_back", { from: "checks", to: "nope", reason: "r", count: 1 });
  b.add("model.blocked", { stage: "nope", marking: "TLP:RED", model: "m", where: "hosted" });
  const s = fold(b.entries);
  expect({ ...s, seq: base.seq, head_ts: base.head_ts }).toEqual(base);
});

test("ids like 'constructor' and '__proto__' behave as ordinary ids", () => {
  const b = new EntryBuilder();
  b.add("job.started", { job: "constructor", title: "T", kind: "query", source: null });
  b.add("job.started", { job: "__proto__", title: "T", kind: "query", source: null });
  b.add("job.finished", { job: "constructor", outcome: "done" });
  issue(b, "__proto__");
  b.add("query.failed", { query: "__proto__", error: "e" });
  b.add("job.finished", { job: "toString", outcome: "done" });
  const s = fold(b.entries);
  expect(Object.hasOwn(s.jobs, "constructor") && Object.hasOwn(s.jobs, "__proto__")).toBe(true);
  expect((s.jobs as Record<string, { status: string }>)["constructor"]!.status).toBe("done");
  expect(Object.hasOwn(s.jobs, "toString")).toBe(false);
  expect(s.queries.__proto__!.status).toBe("failed");
});

// ---------- immutability ----------
function deepFreeze<T>(x: T): T {
  if (typeof x === "object" && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

test("apply never mutates the state it is given", () => {
  const b = new EntryBuilder();
  b.add("budget.set", { tokens: 100 });
  b.add("stage.model_set", { stage: "plan", choice: X });
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  b.add("stage.started", { stage: "plan", attempt: 1 });
  b.add("stage.finished", { stage: "plan", attempt: 1, outcome: "pass", draft_hash: null, output: null, reason: "ok" });
  b.add("gate.waiting", { gate: "plan" });
  b.add("gate.passed", { gate: "plan" });
  b.add("stage.sent_back", { from: "checks", to: "plan", reason: "r", count: 1 });
  b.add("model.blocked", { stage: "checks", marking: "TLP:RED", model: "m", where: "hosted" });
  b.add("model.response", { request: "r1", response: { blob: "b", bytes: 1 }, stop: "end", usage: { input: 1, output: 1, reasoning: 1 }, served_by: "m", reasoning: null });
  b.add("run.paused", { reason: "r" });
  b.add("run.resumed", {});
  b.add("run.interrupted", {});
  b.add("run.finished", { outcome: "published" });
  b.add("job.started", { job: "j1", title: "T", kind: "query", source: null });
  b.add("job.finished", { job: "j1", outcome: "done" });
  b.add("plan.proposed", { plan: plan() });
  b.add("plan.accepted", { plan: "plan-1", steps: ["s1"], budgets: { src: 1 } });
  b.add("step.started", { step: "s1" });
  b.add("step.finished", { step: "s1", outcome: "answered", cards: ["c1"], note: "n" });
  b.add("plan.replan_requested", { plan: "plan-1", note: "n" });
  b.add("plan.denied", { plan: "plan-1", reason: "r" });
  issue(b);
  b.add("query.result", { query: "q1", result: { blob: "b", bytes: 1 }, rows: 1, rows_hash: "h", coverage: { kind: "full" }, duration_ms: 1, cost: null });
  issue(b, "q2");
  b.add("query.failed", { query: "q2", error: "e" });
  b.add("card.created", { card: card("c1", { query: "q1" }) });
  b.add("verify.run", { original: "q1", rerun: "q2", card: "c1", outcome: "matches", detail: "d" });
  b.add("proposal.created", { proposal: { id: "p1", kind: "narrative", title: "T", by: "a", section: "summary", text: "t", cites: [] } });
  b.add("proposal.accepted", { proposal: "p1", budget: null });
  b.add("proposal.rejected", { proposal: "p1", reason: "r" });
  b.add("case.phase_changed", { phase: "x" });
  let s = deepFreeze(initial());
  for (const e of b.entries) s = deepFreeze(apply(s, e));
  expect(s.skipped).toEqual([]);
  expect(s.seq).toBe(b.entries.length);
});

// ---------- robustness ----------
const HANDLED = [
  "run.started", "run.paused", "run.resumed", "run.interrupted", "run.finished", "stage.model_set", "stage.started", "stage.finished",
  "stage.sent_back", "gate.waiting", "gate.passed", "budget.set", "job.started", "job.finished", "plan.proposed", "plan.accepted",
  "plan.denied", "plan.replan_requested", "step.started", "step.finished", "query.issued", "query.result", "query.failed", "verify.run",
  "model.response", "model.blocked", "card.created", "proposal.created", "proposal.accepted", "proposal.rejected",
] as const;

function raw(type: string, payload: unknown): Entry {
  return { ...new EntryBuilder().add("run.resumed", {}), type, payload } as unknown as Entry;
}

/** A state with a run, plan, job, query, card and proposal, so reducers have something to damage. */
function populated(): CaseState {
  const b = started();
  b.add("plan.proposed", { plan: plan() });
  b.add("job.started", { job: "j1", title: "T", kind: "query", source: null });
  issue(b);
  b.add("card.created", { card: card("c1") });
  b.add("proposal.created", { proposal: { id: "p1", kind: "narrative", title: "T", by: "a", section: "summary", text: "t", cites: [] } });
  return fold(b.entries);
}

test("malformed payloads never throw and change nothing", () => {
  const base = populated();
  const wrong = {
    run: 5, stage: 5, choice: 3, attempt: "x", outcome: "maybe", reason: 4, from: 1, to: 2, count: "n", gate: "nope", tokens: "t",
    job: {}, title: 1, kind: "k", source: 5, plan: 7, steps: "s", budgets: [], note: 1, step: 3, cards: "c", query: [], text: 1, why: 2,
    window: 1, result: 1, rows: "r", rows_hash: 1, coverage: 1, error: 1, original: 1, card: 5, detail: 1, usage: 1, stages: 1,
    proposal: 5, budget: "b", id: [], marking: 1, response: 1,
  };
  const wrongNested = { plan: { id: 1, steps: 1 }, card: { id: 5, query: 4 }, proposal: { id: 1, kind: 2 }, stages: [{ id: 1 }], usage: { input: "a" } };
  const payloads: [string, unknown][] = [["null", null], ["undefined", undefined], ["empty", {}], ["wrong types", wrong], ["wrong nested", wrongNested], ["array", []]];
  // run.resumed and run.interrupted carry no fields, so no payload can be malformed for them
  for (const type of HANDLED.filter((x) => x !== "run.resumed" && x !== "run.interrupted")) {
    for (const [label, payload] of payloads) {
      const e = raw(type, payload);
      let out: CaseState | undefined;
      expect(() => { out = apply(base, e); }).not.toThrow();
      const { skipped, ...rest } = out!;
      const { skipped: _s, ...was } = base;
      // seq, head_ts and counters are advanced by the pipeline, not by this reducer
      expect({ ...rest, seq: was.seq, head_ts: was.head_ts, counters: was.counters }, `${type} ${label}`).toEqual(was);
      const reason = payload === null || payload === undefined || Array.isArray(payload) ? "malformed payload" : `malformed ${type}`;
      expect(skipped, `${type} ${label}`).toEqual([...base.skipped, { seq: e.seq, type, reason }]);
    }
  }
});

test("a state with no run also survives malformed payloads", () => {
  const base = initial();
  for (const type of HANDLED) {
    for (const payload of [{}, { stage: 5, run: 5, stages: [] }]) {
      const out = apply(base, raw(type, payload));
      const { skipped: _s, ...rest } = out;
      const { skipped: _t, ...was } = base;
      expect({ ...rest, seq: 0, head_ts: null, counters: was.counters } as unknown, type).toEqual(was);
    }
  }
});

// ---------- review fixes ----------
test("a plan step with id '__proto__' is tracked like any other", () => {
  const p = plan();
  p.steps = [{ ...p.steps[0]!, id: "__proto__" }, p.steps[1]!];
  const b = new EntryBuilder();
  b.add("plan.proposed", { plan: p });
  b.add("step.started", { step: "__proto__" });
  expect(Object.hasOwn(fold(b.entries).plan.steps, "__proto__")).toBe(true);
  expect(fold(b.entries).plan.steps["__proto__"]!.status).toBe("running");
  b.add("step.finished", { step: "__proto__", outcome: "answered", cards: ["c1"], note: "n" });
  expect(fold(b.entries).plan.steps["__proto__"]).toEqual({ status: "answered", cards: ["c1"], note: "n" });
});

test("a costly proposal carries what it takes to run it; estimate may be null; one missing a part is malformed", () => {
  const full = {
    id: "p1", kind: "costly_query" as const, title: "T", by: "a1", step: null, subgoal: "g1", source: "lake", pivot: "pv", pivot_hash: "h", source_hash: "sh1",
    text: "select {value}", bound: { value: "x" }, window: { from: "2026-01-01T00:00:00.000Z", to: null }, estimate: null, why: "w",
  };
  const b = new EntryBuilder();
  b.add("proposal.created", { proposal: full });
  for (const drop of ["pivot", "pivot_hash", "bound", "window", "subgoal"] as const) {
    const { [drop]: _gone, ...rest } = full;
    b.add("proposal.created", { proposal: { ...rest, id: `p-${drop}` } } as never);
  }
  b.add("proposal.created", { proposal: { ...full, id: "p-badbound", bound: [1] } } as never);
  const s = fold(b.entries);
  expect(Object.keys(s.proposals)).toEqual(["p1"]);
  expect(s.proposals.p1).toMatchObject({ ...full, status: "open" });
  expect(s.skipped).toHaveLength(6);
});

test("a proposal missing a required field is ignored", () => {
  const good = { id: "p1", kind: "narrative" as const, title: "T", by: "a", section: "summary" as const, text: "t", cites: [] };
  const { title: _t, ...noTitle } = good;
  const costly = { id: "p2", kind: "costly_query" as const, title: "T", by: "a", step: null, source: "s", text: "t", why: "w" };
  const b = new EntryBuilder();
  b.add("proposal.created", { proposal: noTitle } as never);
  b.add("proposal.created", { proposal: costly } as never);
  b.add("proposal.created", { proposal: { ...good, section: "bogus" } } as never);
  expect(fold(b.entries).proposals).toEqual({});
});

test("a costly_query proposal without source_hash is malformed", () => {
  const costly = { id: "p1", kind: "costly_query" as const, title: "T", by: "a", step: null, subgoal: null, source: "s", pivot: null, pivot_hash: null, text: "t", bound: {}, window: { from: null, to: null }, estimate: null, why: "w" };
  const b = new EntryBuilder();
  b.add("proposal.created", { proposal: costly } as never);
  const s = fold(b.entries);
  expect(s.proposals).toEqual({});
  expect(s.skipped).toHaveLength(1);
});

test("a plan with a step missing source, or a bad subgoal, is ignored", () => {
  const { source: _s, ...noSource } = plan().steps[0]!;
  const b = new EntryBuilder();
  b.add("plan.proposed", { plan: { ...plan(), steps: [noSource] } } as never);
  b.add("plan.proposed", { plan: { ...plan(), subgoals: [{ id: "sg1", title: "T" }] } } as never);
  const s = fold(b.entries);
  expect(s.plan).toEqual(initial().plan);
});

test("a finished run ignores later pause, resume, gate and stage entries until run.started", () => {
  const b = started();
  b.add("run.finished", { outcome: "published" });
  const done = fold(b.entries);
  b.add("run.paused", { reason: "r" });
  b.add("run.resumed", {});
  b.add("run.interrupted", {});
  b.add("gate.waiting", { gate: "plan" });
  b.add("gate.passed", { gate: "plan" });
  b.add("stage.started", { stage: "plan", attempt: 1 });
  b.add("stage.finished", { stage: "plan", attempt: 1, outcome: "fail", draft_hash: null, output: null, reason: "x" });
  b.add("stage.sent_back", { from: "checks", to: "plan", reason: "r", count: 1 });
  b.add("model.blocked", { stage: "plan", marking: "TLP:RED", model: "m", where: "hosted" });
  const s = fold(b.entries);
  expect({ ...s, seq: done.seq, head_ts: done.head_ts }).toEqual(done);
  b.add("run.started", { run: "run-2", pipeline: "p", pipeline_hash: "h", stages });
  expect(fold(b.entries).run).toMatchObject({ id: "run-2", status: "running" });
});

test("an interrupted run can be resumed", () => {
  const b = started();
  b.add("run.interrupted", {});
  b.add("run.resumed", {});
  expect(fold(b.entries).run.status).toBe("running");
});

test("usage and model_calls are case totals that survive run.started", () => {
  const resp = (n: number) => ({ request: "r", response: { blob: "b", bytes: 1 }, stop: "end" as const, usage: { input: n, output: n, reasoning: n }, served_by: "m", reasoning: null });
  const b = new EntryBuilder();
  b.add("model.response", resp(1));
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  b.add("model.response", resp(2));
  b.add("run.started", { run: "run-2", pipeline: "p", pipeline_hash: "h", stages });
  const s = fold(b.entries);
  expect(s.run.usage).toEqual({ input: 3, output: 3, reasoning: 3 });
  expect(s.run.model_calls).toBe(2);
});

test("run.started is rejected for duplicate or malformed stages", () => {
  const dup = [stages[0]!, { ...stages[1]!, id: "plan" }];
  const bad = [stages[0]!, { ...stages[1]!, runs: "robot" }];
  for (const list of [dup, bad, [{ id: "x" }]]) {
    const b = new EntryBuilder();
    b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages: list } as never);
    expect(fold(b.entries).run.status, JSON.stringify(list)).toBe("none");
  }
});

test("settled queries, jobs and proposals ignore a second outcome", () => {
  const b = new EntryBuilder();
  issue(b);
  b.add("query.result", { query: "q1", result: { blob: "b", bytes: 9 }, rows: 4, rows_hash: "rh", coverage: { kind: "full" }, duration_ms: 5, cost: null });
  b.add("job.started", { job: "j1", title: "T", kind: "query", source: null });
  b.add("job.finished", { job: "j1", outcome: "done" });
  b.add("proposal.created", { proposal: { id: "p1", kind: "narrative", title: "T", by: "a", section: "summary", text: "t", cites: [] } });
  b.add("proposal.accepted", { proposal: "p1", budget: 1 });
  const before = fold(b.entries);
  b.add("query.result", { query: "q1", result: { blob: "z", bytes: 1 }, rows: 99, rows_hash: "zz", coverage: { kind: "full" }, duration_ms: 5, cost: null });
  b.add("query.failed", { query: "q1", error: "late" });
  b.add("job.finished", { job: "j1", outcome: "failed" });
  b.add("proposal.accepted", { proposal: "p1", budget: 50 });
  b.add("proposal.rejected", { proposal: "p1", reason: "late" });
  const s = fold(b.entries);
  expect({ ...s, seq: before.seq, head_ts: before.head_ts }).toEqual(before);
});

test("gate.passed for a gate that is not waiting changes nothing", () => {
  const b = started();
  b.add("gate.waiting", { gate: "plan" });
  b.add("gate.passed", { gate: "publish" });
  expect(fold(b.entries).run).toMatchObject({ status: "waiting", waiting: "plan" });
  const c = started();
  c.add("gate.passed", { gate: "plan" });
  expect(fold(c.entries).run.stages[0]!.status).toBe("idle");
});

test("resuming a paused run with a gate pending returns to waiting", () => {
  const b = started();
  b.add("gate.waiting", { gate: "plan" });
  b.add("run.paused", { reason: "r" });
  b.add("run.resumed", {});
  expect(fold(b.entries).run).toMatchObject({ status: "waiting", waiting: "plan", pause_reason: null });
});

test("a second attempt after a send-back counts attempts 2", () => {
  const b = started();
  b.add("stage.started", { stage: "plan", attempt: 1 });
  b.add("stage.sent_back", { from: "checks", to: "plan", reason: "r", count: 1 });
  expect(fold(b.entries).run.stages[0]).toMatchObject({ status: "idle", attempts: 1 });
  b.add("stage.started", { stage: "plan", attempt: 2 });
  expect(fold(b.entries).run.stages[0]).toMatchObject({ status: "running", attempts: 2 });
  expect(fold(b.entries).run.sendbacks["checks>plan"]).toBe(1);
});

// ---------- final review, finding 21: a per-run figure can be derived ----------
test("run.started records the case totals at its start, and runUsage gives this run's own usage", () => {
  const resp = (n: number) => ({ request: "r", response: { blob: "b", bytes: 1 }, stop: "end" as const, usage: { input: n, output: 2 * n, reasoning: 3 * n }, served_by: "m", reasoning: null });
  const b = new EntryBuilder();
  b.add("model.response", resp(1));
  expect(runUsage(fold(b.entries))).toEqual({ usage: { input: 1, output: 2, reasoning: 3 }, model_calls: 1 });
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  let s = fold(b.entries);
  expect(s.run.usage_at_start).toEqual({ input: 1, output: 2, reasoning: 3 });
  expect(s.run.calls_at_start).toBe(1);
  expect(runUsage(s)).toEqual({ usage: { input: 0, output: 0, reasoning: 0 }, model_calls: 0 });
  b.add("model.response", resp(2));
  b.add("model.response", resp(5));
  expect(runUsage(fold(b.entries))).toEqual({ usage: { input: 7, output: 14, reasoning: 21 }, model_calls: 2 });
  b.add("run.started", { run: "run-2", pipeline: "p", pipeline_hash: "h", stages });
  b.add("model.response", resp(10));
  s = fold(b.entries);
  expect(s.run.usage).toEqual({ input: 18, output: 36, reasoning: 54 });
  expect(s.run.model_calls).toBe(4);
  expect(runUsage(s)).toEqual({ usage: { input: 10, output: 20, reasoning: 30 }, model_calls: 1 });
});

test("before any run the baseline is zero", () => {
  expect(initial().run.usage_at_start).toEqual({ input: 0, output: 0, reasoning: 0 });
  expect(initial().run.calls_at_start).toBe(0);
});

test("stage.pack_limit_set records the limit and null removes it", () => {
  const b = new EntryBuilder();
  b.add("stage.pack_limit_set", { stage: "assemble", max_marking: "TLP:GREEN" });
  expect(fold(b.entries).pack_limits).toEqual({ assemble: "TLP:GREEN" });
  b.add("stage.pack_limit_set", { stage: "assemble", max_marking: null });
  expect(fold(b.entries).pack_limits).toEqual({});
  expect(fold(b.entries).skipped).toEqual([]);
});

test("stage.pack_limit_set applies during a run too, and does not change the stage list", () => {
  const b = started();
  b.add("stage.pack_limit_set", { stage: "plan", max_marking: "TLP:AMBER" });
  const s = fold(b.entries);
  expect(s.pack_limits).toEqual({ plan: "TLP:AMBER" });
  expect(s.run.stages.map((x) => x.id)).toEqual(["plan", "checks"]);
});

test("an unknown marking in stage.pack_limit_set is malformed", () => {
  const b = new EntryBuilder();
  const e = b.add("stage.pack_limit_set", { stage: "assemble", max_marking: "TLP:PURPLE" } as never);
  const s = fold(b.entries);
  expect(s.pack_limits).toEqual({});
  expect(s.skipped).toEqual([{ seq: e.seq, type: "stage.pack_limit_set", reason: "malformed stage.pack_limit_set" }]);
  const f = new EntryBuilder();
  f.add("stage.pack_limit_set", { stage: 5, max_marking: null } as never);
  expect(fold(f.entries).skipped).toHaveLength(1);
});

test("case.anchored changes nothing but seq in a case fold", () => {
  const b = started();
  const before = fold(b.entries);
  b.add("case.anchored", { case: "case-1", seq: 3, hash: "a".repeat(64), why: "published" });
  const after = fold(b.entries);
  expect(after).toEqual({ ...before, seq: after.seq, head_ts: after.head_ts });
  expect(after.seq).toBe(before.seq + 1);
});

test("a run finished at a gate waits for nothing; a stop's reason is kept in the entry and a bad one is skipped", () => {
  const b = started();
  b.add("stage.started", { stage: "plan", attempt: 1 });
  b.add("gate.waiting", { gate: "plan" });
  expect(fold(b.entries).run).toMatchObject({ status: "waiting", waiting: "plan" });
  b.add("run.finished", { outcome: "stopped", reason: "not now" });
  const s = fold(b.entries);
  expect(s.run).toMatchObject({ status: "finished", outcome: "stopped", waiting: null });
  expect(s.skipped).toEqual([]);
  const bad = started();
  const e = bad.add("run.finished", { outcome: "stopped", reason: 7 } as never);
  expect(fold(bad.entries).skipped).toEqual([{ seq: e.seq, type: "run.finished", reason: "malformed run.finished" }]);
  expect(fold(bad.entries).run.status).toBe("running");
});
