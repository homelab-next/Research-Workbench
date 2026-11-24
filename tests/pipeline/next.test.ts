import { expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { fold } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Draft, Plan, Product, StageDef } from "../../src/core/types";
import { firstUnpassedReview, nextStep, SEND_BACK_CAP } from "../../src/pipeline/next";
import type { Pipeline, StageManifest } from "../../src/pipeline/manifests";
import { EntryBuilder } from "../helpers/entries";

const sm = (id: string, order: number, over: Partial<StageManifest> = {}): StageManifest => ({
  id, title: id[0]!.toUpperCase() + id.slice(1), phase: null, runs: "script", gate: null, reviews: false, model: null,
  hash: `h-${id}`, order, role: "checks", tools: [], schema: null, on_pass: null, on_fail: null, ...over,
});
const pipeline: Pipeline = {
  id: "default", hash: "ph",
  stages: [
    sm("frame", 1, { on_pass: "plan" }),
    sm("plan", 2, { gate: "plan", on_pass: "research" }),
    sm("research", 3, { on_pass: "assemble", on_fail: "plan" }),
    sm("assemble", 4, { on_pass: "checks", on_fail: "research" }),
    sm("checks", 5, { reviews: true, on_pass: "evaluate", on_fail: "assemble" }),
    sm("evaluate", 6, { reviews: true, on_pass: "challenge", on_fail: "assemble" }),
    sm("challenge", 7, { reviews: true, on_pass: "publish", on_fail: "assemble" }),
    sm("publish", 8, { gate: "publish", on_pass: "feedback", on_fail: "assemble" }),
    sm("feedback", 9),
  ],
};
const defs: StageDef[] = pipeline.stages.map(({ id, title, phase, runs, gate, reviews, model }) => ({ id, title, phase, runs, gate, reviews, model }));

const product = (n: number): Product => ({
  objective: "o", question: "q", marking: "TLP:GREEN", summary: `s${n}`, key_findings: [], gaps_and_limits: "", alternatives: "", assessment: "", sources: [], assumptions: [], change: "",
});
const draft = (n: number): Draft => {
  const p = product(n);
  return { n, hash: sha256Hex(canonical(p as unknown as Json)), author: { kind: "system", id: "t" }, product: p, reason: "r" };
};
const plan: Plan = { id: "plan-1", goal: "g", window: { from: null, to: null }, subgoals: [], steps: [] };

/** A builder with a started run; `go` appends more. */
function run(go: (b: EntryBuilder) => void = () => {}): CaseState {
  const b = new EntryBuilder();
  b.add("case.created", { id: "case-1", title: "t", asked: "a", why: "w", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN" });
  b.add("run.started", { run: "run-1", pipeline: "default", pipeline_hash: "ph", stages: defs });
  go(b);
  return fold(b.entries);
}
const started = (b: EntryBuilder, stage: string, attempt = 1) => b.add("stage.started", { stage, attempt });
const finished = (b: EntryBuilder, stage: string, outcome: "pass" | "fail" | "declined", reason: string | null = null, draftHash: string | null = null, attempt = 1) =>
  b.add("stage.finished", { stage, attempt, outcome, draft_hash: draftHash, output: null, reason });
const passed = (b: EntryBuilder, stage: string) => { started(b, stage); finished(b, stage, "pass"); };
const revised = (b: EntryBuilder, n: number) => b.add("draft.revised", { draft: draft(n) });
const reviewed = (b: EntryBuilder, h: string, stages = ["checks", "evaluate", "challenge"]) => { for (const s of stages) { started(b, s); finished(b, s, "pass", null, h); } };

test("a new run starts at the first stage", () => {
  expect(nextStep(run(), pipeline)).toEqual({ kind: "start", stage: "frame", attempt: 1, sent_back: null });
});

test("a passed stage hands off to its on_pass stage", () => {
  expect(nextStep(run((b) => passed(b, "frame")), pipeline)).toEqual({ kind: "start", stage: "plan", attempt: 1, sent_back: null });
});

test("a failed stage sends back along on_fail with the count", () => {
  const state = run((b) => {
    passed(b, "frame"); passed(b, "plan");
    b.add("plan.proposed", { plan }); b.add("plan.accepted", { plan: "plan-1", steps: [], budgets: {} }); b.add("gate.waiting", { gate: "plan" }); b.add("gate.passed", { gate: "plan" });
    passed(b, "research"); passed(b, "assemble"); revised(b, 1);
    started(b, "checks"); finished(b, "checks", "fail", "confidence-and-likelihood failed", draft(1).hash);
  });
  expect(nextStep(state, pipeline)).toEqual({ kind: "start", stage: "assemble", attempt: 2,
    sent_back: { from: "checks", to: "assemble", reason: "confidence-and-likelihood failed", count: 1 } });
});

const failedChecks = (b: EntryBuilder, sendbacks: Record<string, number> = { "checks>assemble": SEND_BACK_CAP }) => {
  passed(b, "assemble");
  started(b, "checks"); finished(b, "checks", "fail", "no good");
  for (const [k, n] of Object.entries(sendbacks)) { const [from, to] = k.split(">"); b.add("stage.sent_back", { from: from!, to: to!, reason: "r", count: n }); }
};

test("the fourth send-back along one edge pauses instead", () => {
  const state = run((b) => { failedChecks(b); });
  expect(state.run.sendbacks).toEqual({ "checks>assemble": 3 });
  expect(nextStep(state, pipeline)).toEqual({ kind: "pause", reason: "Checks has sent work back to Assemble 3 times. Last reason: no good" });
});

test("allow_capped lets one more through", () => {
  const state = run((b) => { failedChecks(b); });
  expect(nextStep(state, pipeline, { allow_capped: true })).toEqual({ kind: "start", stage: "assemble", attempt: 2, sent_back: { from: "checks", to: "assemble", reason: "no good", count: 4 } });
});

test("the cap is per edge", () => {
  const state = run((b) => { failedChecks(b, { "evaluate>assemble": 3 }); });
  expect(nextStep(state, pipeline)).toMatchObject({ kind: "start", stage: "assemble", sent_back: { count: 1 } });
});

test("a stage that failed with no on_fail pauses and says why", () => {
  const state = run((b) => { started(b, "frame"); finished(b, "frame", "fail", "no way"); });
  expect(nextStep(state, pipeline)).toEqual({ kind: "pause", reason: "Frame failed: no way" });
});

const planned = (b: EntryBuilder) => { passed(b, "frame"); passed(b, "plan"); b.add("plan.proposed", { plan }); };

test("a passed plan stage waits at the plan gate until the plan is accepted", () => {
  expect(nextStep(run(planned), pipeline)).toEqual({ kind: "gate", gate: "plan" });
  const accepted = run((b) => { planned(b); b.add("gate.waiting", { gate: "plan" }); b.add("plan.accepted", { plan: "plan-1", steps: [], budgets: {} }); b.add("gate.passed", { gate: "plan" }); });
  expect(nextStep(accepted, pipeline)).toEqual({ kind: "start", stage: "research", attempt: 1, sent_back: null });
  const denied = run((b) => { planned(b); b.add("plan.denied", { plan: "plan-1", reason: "no" }); });
  expect(nextStep(denied, pipeline)).toEqual({ kind: "idle" });
});

test("a re-plan request runs the plan stage again", () => {
  const state = run((b) => { planned(b); b.add("plan.replan_requested", { plan: "plan-1", note: "again" }); });
  expect(nextStep(state, pipeline)).toEqual({ kind: "start", stage: "plan", attempt: 2, sent_back: null });
});

test("nothing reaches publish until every review stage passed the latest draft", () => {
  const d1 = draft(1).hash;
  const upToChallenge = (b: EntryBuilder) => { passed(b, "assemble"); revised(b, 1); started(b, "checks"); finished(b, "checks", "pass", null, d1); started(b, "evaluate"); finished(b, "evaluate", "pass", null, d1); };
  const afterEvaluate = run(upToChallenge);
  expect(nextStep(afterEvaluate, pipeline)).toEqual({ kind: "start", stage: "challenge", attempt: 1, sent_back: null });
  const newer = run((b) => { upToChallenge(b); revised(b, 2); });
  expect(firstUnpassedReview(newer, pipeline)).toBe("checks");
  expect(nextStep(newer, pipeline)).toMatchObject({ kind: "start", stage: "checks", attempt: 2 });
  const all = run((b) => { passed(b, "assemble"); revised(b, 1); reviewed(b, d1); });
  expect(firstUnpassedReview(all, pipeline)).toBeNull();
  expect(nextStep(all, pipeline)).toEqual({ kind: "start", stage: "publish", attempt: 1, sent_back: null });
  // a stage between reviews and publish that was edited after: a newer draft after challenge passes sends it back to checks
  const edited = run((b) => { passed(b, "assemble"); revised(b, 1); reviewed(b, d1); revised(b, 2); });
  expect(nextStep(edited, pipeline)).toMatchObject({ kind: "start", stage: "checks" });
  const noDraft = run((b) => { passed(b, "assemble"); });
  expect(firstUnpassedReview(noDraft, pipeline)).toBeNull();
  expect(nextStep(noDraft, pipeline)).toEqual({ kind: "pause", reason: "there is no draft to review" });
});

test("the publish stage waits at the publish gate only when every review passed the latest draft", () => {
  const d1 = draft(1).hash;
  const atPublish = (extra: (b: EntryBuilder) => void = () => {}) => run((b) => { passed(b, "assemble"); revised(b, 1); reviewed(b, d1); passed(b, "publish"); extra(b); });
  expect(nextStep(atPublish(), pipeline)).toEqual({ kind: "gate", gate: "publish" });
  expect(nextStep(atPublish((b) => revised(b, 2)), pipeline)).toMatchObject({ kind: "start", stage: "checks", attempt: 2 });
  const published = atPublish((b) => {
    b.add("gate.waiting", { gate: "publish" });
    b.add("product.published", { n: 1, draft_hash: d1, head_hash: "x", dir: "d", bundle: { blob: "b", bytes: 1 } });
    b.add("gate.passed", { gate: "publish" });
  });
  expect(nextStep(published, pipeline)).toEqual({ kind: "start", stage: "feedback", attempt: 1, sent_back: null });
});

test("a stage left running is executed again, not restarted", () => {
  expect(nextStep(run((b) => { started(b, "frame"); }), pipeline)).toEqual({ kind: "exec", stage: "frame" });
});

test("a declined or blocked stage starts again with a new attempt", () => {
  expect(nextStep(run((b) => { started(b, "frame"); finished(b, "frame", "declined", "no"); }), pipeline)).toEqual({ kind: "start", stage: "frame", attempt: 2, sent_back: null });
  const blocked = run((b) => { started(b, "frame"); b.add("model.blocked", { stage: "frame", marking: "TLP:RED", model: "m", where: "hosted" }); });
  expect(blocked.run.stages[0]!.status).toBe("blocked");
  expect(nextStep(blocked, pipeline)).toEqual({ kind: "start", stage: "frame", attempt: 2, sent_back: null });
});

test("the last stage passing finishes the run as published, or stopped when nothing was published", () => {
  const d1 = draft(1).hash;
  const done = run((b) => {
    passed(b, "assemble"); revised(b, 1); reviewed(b, d1); passed(b, "publish");
    b.add("gate.waiting", { gate: "publish" });
    b.add("product.published", { n: 1, draft_hash: d1, head_hash: "x", dir: "d", bundle: { blob: "b", bytes: 1 } });
    b.add("gate.passed", { gate: "publish" });
    passed(b, "feedback");
  });
  expect(nextStep(done, pipeline)).toEqual({ kind: "finish", outcome: "published" });
  expect(nextStep(run((b) => { passed(b, "feedback"); }), pipeline)).toEqual({ kind: "finish", outcome: "stopped" });
});

test("a paused, waiting, interrupted or finished run is idle", () => {
  expect(nextStep(run((b) => { started(b, "frame"); b.add("run.paused", { reason: "x" }); }), pipeline)).toEqual({ kind: "idle" });
  expect(nextStep(run((b) => { planned(b); b.add("gate.waiting", { gate: "plan" }); }), pipeline)).toEqual({ kind: "idle" });
  expect(nextStep(run((b) => { started(b, "frame"); b.add("run.interrupted", {}); }), pipeline)).toEqual({ kind: "idle" });
  expect(nextStep(run((b) => { b.add("run.finished", { outcome: "stopped" }); }), pipeline)).toEqual({ kind: "idle" });
  expect(nextStep(fold([]), pipeline)).toEqual({ kind: "idle" });
});

test("nextStep reads only the state: the same state gives the same step", () => {
  const state = run((b) => { started(b, "frame"); });
  const frozen = JSON.stringify(state);
  expect(nextStep(state, pipeline)).toEqual(nextStep(fold(new EntryBuilder().also((b) => { b.add("case.created", { id: "case-1", title: "t", asked: "a", why: "w", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN" }); b.add("run.started", { run: "run-1", pipeline: "default", pipeline_hash: "ph", stages: defs }); started(b, "frame"); }).entries), pipeline));
  expect(JSON.stringify(state)).toBe(frozen);
});

const atGate = (extra: (b: EntryBuilder) => void = () => {}) => {
  const d1 = draft(1).hash;
  return run((b) => { passed(b, "assemble"); revised(b, 1); reviewed(b, d1); passed(b, "publish"); extra(b); });
};

test("an open must-address challenge on the latest draft pauses instead of raising the publish gate", () => {
  const d1 = draft(1).hash;
  const state = atGate((b) => b.add("challenge.raised", { challenge: { id: "x1", draft_hash: d1, severity: "must_address", text: "t", cites: [] } }));
  expect(nextStep(state, pipeline)).toEqual({ kind: "pause", reason: "Challenge x1 must be addressed." });
  expect(nextStep(atGate((b) => b.add("check.run", { check: "c", script_hash: "h", input: { blob: "i", bytes: 1 }, output: { blob: "o", bytes: 1 }, draft_hash: d1, pass: false, findings: [] })), pipeline))
    .toEqual({ kind: "pause", reason: "c failed on this revision." });
});

test("a target that is not one of the run's stages pauses, naming it", () => {
  const ghost: Pipeline = { ...pipeline, stages: pipeline.stages.map((s) => (s.id === "frame" ? { ...s, on_pass: "ghost" } : s)).concat(sm("ghost", 10)) };
  const state = run((b) => { passed(b, "frame"); });
  expect(nextStep(state, ghost)).toEqual({ kind: "pause", reason: "the stage ghost is not part of this run" });
});

test("a review stage restarted without a send-back pauses after five runs", () => {
  const d1 = draft(1).hash;
  const stale = (n: number) => run((b) => {
    passed(b, "assemble"); revised(b, 1); started(b, "checks"); finished(b, "checks", "pass", null, d1);
    for (let i = 1; i <= n; i++) { b.add("stage.started", { stage: "evaluate", attempt: i }); b.add("stage.finished", { stage: "evaluate", attempt: i, outcome: "pass", draft_hash: null, output: null, reason: null }); }
  });
  expect(nextStep(stale(4), pipeline)).toMatchObject({ kind: "start", stage: "evaluate", attempt: 5 });
  expect(nextStep(stale(5), pipeline)).toEqual({ kind: "pause", reason: "Evaluate has run 5 times" });
  expect(nextStep(stale(5), pipeline, { allow_capped: true })).toMatchObject({ kind: "start", stage: "evaluate", attempt: 6 });
});

test("a stage's attempts are counted across the run, not only its restarts of the current stage", () => {
  const d1 = draft(1).hash;
  // Challenge keeps being run (and failing) while Assemble, the current stage, passes the draft on to it again
  const stale = (n: number, sb = 0) => run((b) => {
    passed(b, "assemble"); revised(b, 1); started(b, "checks"); finished(b, "checks", "pass", null, d1); started(b, "evaluate"); finished(b, "evaluate", "pass", null, d1);
    for (let i = 1; i <= sb; i++) b.add("stage.sent_back", { from: "evaluate", to: "challenge", reason: "r", count: i });
    for (let i = 1; i <= n; i++) { b.add("stage.started", { stage: "challenge", attempt: i }); b.add("stage.finished", { stage: "challenge", attempt: i, outcome: "fail", draft_hash: d1, output: null, reason: "x" }); }
    b.add("stage.started", { stage: "assemble", attempt: 2 }); b.add("stage.finished", { stage: "assemble", attempt: 2, outcome: "pass", draft_hash: d1, output: null, reason: null });
  });
  expect(nextStep(stale(4), pipeline)).toMatchObject({ kind: "start", stage: "challenge", attempt: 5 });
  expect(nextStep(stale(5), pipeline)).toEqual({ kind: "pause", reason: "Challenge has run 5 times" });
  expect(nextStep(stale(5), pipeline, { allow_capped: true })).toMatchObject({ kind: "start", stage: "challenge", attempt: 6 });
  // attempts that began with a send-back are bounded by the send-back cap, not by this rule
  expect(nextStep(stale(5, 2), pipeline)).toMatchObject({ kind: "start", stage: "challenge", attempt: 6 });
});
