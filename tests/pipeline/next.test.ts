import { expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { fold } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Draft, Finding, Plan, Product, ReviewConflict, StageDef } from "../../src/core/types";
import { firstUnpassedReview, nextStep, SEND_BACK_CAP } from "../../src/pipeline/next";
import type { Pipeline, StageManifest } from "../../src/pipeline/manifests";
import { uncitableNote } from "../../src/pipeline/conflict";
import { card, EntryBuilder } from "../helpers/entries";

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
  expect(nextStep(state, pipeline)).toEqual({ kind: "pause", reason: "Checks has sent work back to Assemble 3 times. Last reason: no good", hold: { kind: "send_back", edge: "checks>assemble" } });
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
  expect(nextStep(stale(5), pipeline)).toEqual({ kind: "pause", reason: "Evaluate has run 5 times", hold: { kind: "stage_runs", stage: "evaluate" } });
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
  expect(nextStep(stale(5), pipeline)).toEqual({ kind: "pause", reason: "Challenge has run 5 times", hold: { kind: "stage_runs", stage: "challenge" } });
  expect(nextStep(stale(5), pipeline, { allow_capped: true })).toMatchObject({ kind: "start", stage: "challenge", attempt: 6 });
  // attempts that began with a send-back are bounded by the send-back cap, not by this rule
  expect(nextStep(stale(5, 2), pipeline)).toMatchObject({ kind: "start", stage: "challenge", attempt: 6 });
});

// ---- reviewers who disagree (task 17 item 2) ----

const roled: Pipeline = { ...pipeline, stages: pipeline.stages.map((s) => (s.id === "evaluate" ? { ...s, role: "evaluate" as const } : s.id === "challenge" ? { ...s, role: "challenge" as const } : s)) };
const LIKELIHOOD = ["almost no chance", "very unlikely", "unlikely", "roughly even chance", "likely", "very likely", "almost certain"];
const fnd = (id: string, likelihood: string, confidence: Finding["confidence"] = "high"): Finding =>
  ({ id, statement: `We assess it is ${likelihood} that the address was assigned.`, likelihood, confidence, confidence_basis: "b", cites: ["c19"], assumptions: [], reasoning: "r" });
const draftWith = (n: number, findings: Finding[]): Draft => {
  const p = { ...product(n), key_findings: findings };
  return { n, hash: sha256Hex(canonical(p as unknown as Json)), author: { kind: "system", id: "t" }, product: p, reason: "r" };
};
const D15 = draftWith(1, [fnd("f25", "almost certain"), fnd("f26", "likely")]);
const D16 = draftWith(2, [fnd("f25", "likely"), fnd("f26", "likely")]);
const EV_F25 = { check: "support", where: "f25", message: "c19 shows the address directly, so likely understates it" };
const CONFLICT_REASON = "Evaluate and Challenge disagree on f25: Evaluate asks almost certain, Challenge asked lower";
const RULE_HINT = "The person rules on it in the Narrative lens: follow one reviewer, or write a note.";

/** CASE-1, drafts 15 and 16: Challenge x1 says almost certain overclaims; the analyst lowers f25 to likely for it; Evaluate then fails draft 16 on f25. */
function disagreement(evFindings = [EV_F25], extra: (b: EntryBuilder) => void = () => {}, second: Draft = D16): CaseState {
  return run((b) => {
    passed(b, "assemble"); b.add("draft.revised", { draft: D15 }, { stage: "assemble" });
    reviewed(b, D15.hash, ["checks", "evaluate"]);
    started(b, "challenge");
    b.add("challenge.raised", { challenge: { id: "x1", draft_hash: D15.hash, severity: "must_address", text: "almost certain on f25 overclaims: one event", cites: ["c19"] } });
    finished(b, "challenge", "fail", "challenge x1 must be addressed", D15.hash);
    b.add("stage.sent_back", { from: "challenge", to: "assemble", reason: "challenge x1 must be addressed", count: 1 });
    started(b, "assemble", 2);
    b.add("draft.revised", { draft: second }, { stage: "assemble" });
    b.add("challenge.answered", { challenge: "x1", answer: "lowered to likely", action: "revised" });
    finished(b, "assemble", "pass", null, second.hash, 2);
    started(b, "checks", 2); finished(b, "checks", "pass", null, second.hash, 2);
    started(b, "evaluate", 2);
    b.add("evaluation.made", { draft_hash: second.hash, pass: false, findings: evFindings });
    finished(b, "evaluate", "fail", evFindings[0]!.message, second.hash, 2);
    extra(b);
  });
}
const conflictOf = (over: Partial<ReviewConflict> = {}): ReviewConflict => ({
  id: "k1", draft_hash: D16.hash, finding: "f25", change: "likelihood", earlier: "almost certain", now: "likely", raised_by: "evaluate", changed_for: "challenge",
  asks: "almost certain", asked: "lower", points: [`f25: ${EV_F25.message}`], reason: CONFLICT_REASON, ...over,
});

test("a send-back that would reverse the analyst's change for the other reviewer pauses, naming both positions", () => {
  const { id: _id, ...found } = conflictOf();
  expect(nextStep(disagreement(), roled, { likelihood: LIKELIHOOD })).toEqual({ kind: "pause", reason: `${CONFLICT_REASON}. ${RULE_HINT}`, conflicts: [found] });
  // without the standard's scale, the position is the value the analyst moved to
  expect(nextStep(disagreement(), roled)).toMatchObject({ kind: "pause", reason: `Evaluate and Challenge disagree on f25: Evaluate asks almost certain, Challenge asked likely. ${RULE_HINT}` });
});

test("no conflict when the point names a finding the analyst did not move, or the draft was made for the same reviewer", () => {
  const other = [{ check: "support", where: "f26", message: "f26 cites too little" }];
  expect(nextStep(disagreement(other), roled, { likelihood: LIKELIHOOD })).toMatchObject({ kind: "start", stage: "assemble", sent_back: { from: "evaluate", reason: "f26 cites too little" } });
  // the same story where Evaluate had sent draft 15 back: the change was its own
  const own = run((b) => {
    passed(b, "assemble"); b.add("draft.revised", { draft: D15 }, { stage: "assemble" });
    started(b, "checks"); finished(b, "checks", "pass", null, D15.hash);
    started(b, "evaluate"); finished(b, "evaluate", "fail", "x", D15.hash);
    b.add("stage.sent_back", { from: "evaluate", to: "assemble", reason: "x", count: 1 });
    started(b, "assemble", 2); b.add("draft.revised", { draft: D16 }, { stage: "assemble" }); finished(b, "assemble", "pass", null, D16.hash, 2);
    started(b, "checks", 2); finished(b, "checks", "pass", null, D16.hash, 2);
    started(b, "evaluate", 2); b.add("evaluation.made", { draft_hash: D16.hash, pass: false, findings: [EV_F25] }); finished(b, "evaluate", "fail", EV_F25.message, D16.hash, 2);
  });
  expect(own.made_for[D16.hash]).toBe("evaluate");
  expect(nextStep(own, roled, { likelihood: LIKELIHOOD })).toMatchObject({ kind: "start", stage: "assemble", sent_back: { from: "evaluate" } });
  // a stage that is not a reviewer (checks) never makes a conflict
  expect(nextStep(disagreement(), pipeline, { likelihood: LIKELIHOOD })).toMatchObject({ kind: "start", stage: "assemble" });
});

test("a finding dropped for one reviewer that the other asks to restore is a conflict too, and so is a confidence moved back", () => {
  const dropped = draftWith(2, [fnd("f26", "likely")]);
  expect(nextStep(disagreement([{ check: "support", where: "key_findings", message: "f25 was dropped though c19 shows it" }], () => {}, dropped), roled, { likelihood: LIKELIHOOD }))
    .toMatchObject({ kind: "pause", reason: `Evaluate and Challenge disagree on f25: Evaluate asks to restore f25, Challenge asked to drop it. ${RULE_HINT}`, conflicts: [{ change: "dropped", earlier: "almost certain", now: null }] });
  const lower = draftWith(2, [fnd("f25", "almost certain", "moderate"), fnd("f26", "likely")]);
  expect(nextStep(disagreement([EV_F25], () => {}, lower), roled, { likelihood: LIKELIHOOD }))
    .toMatchObject({ kind: "pause", reason: `Evaluate and Challenge disagree on f25: Evaluate asks high confidence, Challenge asked lower confidence. ${RULE_HINT}` });
});

test("a recorded conflict still open pauses again without recording another; once ruled, the work goes back with the ruling", () => {
  const recorded = (b: EntryBuilder) => { b.add("review.conflict", { conflict: conflictOf() }); b.add("run.paused", { reason: "x" }); b.add("run.resumed", {}); };
  expect(nextStep(disagreement([EV_F25], recorded), roled, { likelihood: LIKELIHOOD })).toEqual({ kind: "pause", reason: `${CONFLICT_REASON}. ${RULE_HINT}`, conflicts: [] });
  const ruled = disagreement([EV_F25], (b) => { recorded(b); b.add("review.ruled", { conflict: "k1", follow: "challenge", note: "one event is not enough" }, { actor: { kind: "human", id: "analyst" } }); });
  expect(ruled.conflicts.k1!.ruling).toMatchObject({ follow: "challenge", note: "one event is not enough", by: "analyst" });
  expect(nextStep(ruled, roled, { likelihood: LIKELIHOOD })).toEqual({ kind: "start", stage: "assemble", attempt: 3, sent_back: {
    from: "evaluate", to: "assemble", count: 1,
    reason: `the person ruled on f25 (${CONFLICT_REASON}): follow Challenge: keep likely. Note: one event is not enough`,
  } });
});

test("a ruled point is not raised again: no new conflict on it, and a review that objects only to it pauses until the person resumes", () => {
  const D17 = draftWith(3, [fnd("f25", "likely"), fnd("f26", "very likely")]);
  const later = (evFindings: { check: string; where: string; message: string }[], after: (b: EntryBuilder) => void = () => {}) => disagreement([EV_F25], (b) => {
    b.add("review.conflict", { conflict: conflictOf() });
    b.add("review.ruled", { conflict: "k1", follow: "challenge", note: "" }, { actor: { kind: "human", id: "analyst" } });
    b.add("stage.sent_back", { from: "evaluate", to: "assemble", reason: "ruled", count: 1 });
    started(b, "assemble", 3); b.add("draft.revised", { draft: D17 }, { stage: "assemble" }); finished(b, "assemble", "pass", null, D17.hash, 3);
    started(b, "checks", 3); finished(b, "checks", "pass", null, D17.hash, 3);
    started(b, "evaluate", 3); b.add("evaluation.made", { draft_hash: D17.hash, pass: false, findings: evFindings }); finished(b, "evaluate", "fail", evFindings[0]!.message, D17.hash, 3);
    after(b);
  });
  const only = later([EV_F25]);
  const reason = "Evaluate objects only to f25, which the person has ruled on; a ruled point is not sent back. Edit the draft, or resume for Evaluate to review it again.";
  expect(nextStep(only, roled, { likelihood: LIKELIHOOD })).toEqual({ kind: "pause", reason, hold: { kind: "ruled", stage: "evaluate" } });
  expect(Object.keys(only.conflicts)).toEqual(["k1"]);
  // the person's resume after that pause runs the reviewer again
  const resumed = later([EV_F25], (b) => { b.add("run.paused", { reason, hold: { kind: "ruled", stage: "evaluate" } }); b.add("run.resumed", {}, { actor: { kind: "human", id: "analyst" } }); });
  expect(resumed.run.hold).toBeNull();
  expect(nextStep(resumed, roled, { likelihood: LIKELIHOOD })).toEqual({ kind: "start", stage: "evaluate", attempt: 4, sent_back: null });
  // with another point beside it, that point is sent back as usual
  const mixed = later([EV_F25, { check: "support", where: "f26", message: "f26 cites too little" }]);
  expect(nextStep(mixed, roled, { likelihood: LIKELIHOOD })).toMatchObject({ kind: "start", stage: "assemble", sent_back: { from: "evaluate" } });
});

test("a ruling settles only what it was about: another point on the same finding goes back, and so does a draft that does not hold the ruling", () => {
  // the person ruled on f25's likelihood (follow Challenge: keep likely); later drafts are reviewed again by Evaluate
  const after = (next: ReturnType<typeof draftWith>, evFindings: { check: string; where: string; message: string }[]) => disagreement([EV_F25], (b) => {
    b.add("review.conflict", { conflict: conflictOf() });
    b.add("review.ruled", { conflict: "k1", follow: "challenge", note: "" }, { actor: { kind: "human", id: "analyst" } });
    b.add("stage.sent_back", { from: "evaluate", to: "assemble", reason: "ruled", count: 1 });
    started(b, "assemble", 3); b.add("draft.revised", { draft: next }, { stage: "assemble" }); finished(b, "assemble", "pass", null, next.hash, 3);
    started(b, "checks", 3); finished(b, "checks", "pass", null, next.hash, 3);
    started(b, "evaluate", 3); b.add("evaluation.made", { draft_hash: next.hash, pass: false, findings: evFindings }); finished(b, "evaluate", "fail", evFindings[0]!.message, next.hash, 3);
  });
  const holds = draftWith(3, [fnd("f25", "likely"), fnd("f26", "very likely")]);
  // CASE-3: a point about f25's citations is not the ruled point; it goes back to the analyst like any other
  const cites = { check: "citation support", where: "f25", message: "f25 cites only c20, which holds no address" };
  expect(nextStep(after(holds, [cites]), roled, { likelihood: LIKELIHOOD })).toMatchObject({ kind: "start", stage: "assemble", sent_back: { from: "evaluate", reason: cites.message } });
  // a point on f25's confidence is not the likelihood the person ruled on either
  const conf = { check: "support", where: "f25", message: "f25's confidence should be high: three cards agree" };
  expect(nextStep(after(holds, [conf]), roled, { likelihood: LIKELIHOOD })).toMatchObject({ kind: "start", stage: "assemble", sent_back: { from: "evaluate" } });
  // CASE-3: the draft moved f25 off the ruled value; the work goes back with the ruling, whatever the reviewer asked
  const off = draftWith(3, [fnd("f25", "almost certain"), fnd("f26", "very likely")]);
  const step = nextStep(after(off, [EV_F25]), roled, { likelihood: LIKELIHOOD });
  expect(step).toMatchObject({ kind: "start", stage: "assemble", sent_back: { from: "evaluate" } });
  expect((step as { sent_back: { reason: string } }).sent_back.reason).toStartWith(`the draft does not hold the person's ruling on f25 (${CONFLICT_REASON}): follow Challenge: keep likely`);
});

// ---- the person's overrules and the reviewers (slice 8) ----

const TV = "It is the TV I installed.";
const overruled = (b: EntryBuilder, finding: string, over: Record<string, unknown> = {}) =>
  b.add("finding.overruled", { finding, draft_hash: "h", likelihood: null, confidence: null, stays: null, note: TV, ...over }, { actor: { kind: "human", id: "analyst" } });
/** Draft 1 holds f1 (likely) and f2; the person overrules f1 as `over` says; Evaluate fails draft 1 with `evFindings`. */
function overruledReview(evFindings: { check: string; where: string; message: string }[], over: Record<string, unknown> = { likelihood: "likely" }, findings = [fnd("f1", "likely"), fnd("f2", "likely")]): CaseState {
  const d = draftWith(1, findings);
  return run((b) => {
    passed(b, "assemble"); b.add("draft.revised", { draft: d }, { stage: "assemble" });
    overruled(b, "f1", over);
    started(b, "checks"); finished(b, "checks", "pass", null, d.hash);
    started(b, "evaluate");
    b.add("evaluation.made", { draft_hash: d.hash, pass: false, findings: evFindings });
    finished(b, "evaluate", "fail", evFindings[0]!.message, d.hash);
  });
}
const UNDERSTATES_F1 = { check: "support", where: "f1", message: "c19 shows the address directly, so likely understates it" };

test("a failed review whose only point would move an overruled finding back pauses instead of sending back", () => {
  const step = nextStep(overruledReview([UNDERSTATES_F1]), roled, { likelihood: LIKELIHOOD });
  expect(step).toMatchObject({ kind: "pause", hold: { kind: "ruled", stage: "evaluate" } });
  expect((step as { reason: string }).reason).toBe("Evaluate objects only to f1, which the person has ruled on or overruled; a settled point is not sent back. Edit the draft, or resume for Evaluate to review it again.");
});

test("another point on an overruled finding goes back to the analyst as usual", () => {
  const empty = { check: "citation support", where: "f1", message: "f1 cites c2, which is empty" };
  expect(nextStep(overruledReview([empty]), roled, { likelihood: LIKELIHOOD })).toMatchObject({ kind: "start", stage: "assemble", sent_back: { from: "evaluate", reason: empty.message } });
});

test("an overruled finding is not made a conflict between the reviewers again", () => {
  // CASE-1's disagreement on f25, where the person has overruled f25 to the likely the analyst moved it to
  const state = disagreement([EV_F25], (b) => overruled(b, "f25", { likelihood: "likely" }));
  const step = nextStep(state, roled, { likelihood: LIKELIHOOD });
  expect(step).toEqual({ kind: "pause", reason: "Evaluate objects only to f25, which the person has ruled on or overruled; a settled point is not sent back. Edit the draft, or resume for Evaluate to review it again.", hold: { kind: "ruled", stage: "evaluate" } });
});

test("a draft that does not hold an overrule goes back with the overrule, beside the reviewer's other points", () => {
  const other = { check: "support", where: "f2", message: "f2 cites too little" };
  const step = nextStep(overruledReview([UNDERSTATES_F1, other], { likelihood: "almost certain" }), roled, { likelihood: LIKELIHOOD });
  expect(step).toMatchObject({ kind: "start", stage: "assemble", sent_back: { from: "evaluate" } });
  const reason = (step as { sent_back: { reason: string } }).sent_back!.reason;
  expect(reason).toStartWith(`the draft does not hold the person's overrule of f1: likelihood almost certain. Note: ${TV}`);
  // the point that would move f1 back is not sent; the other one is
  expect(reason).toEndWith(". Also: f2: f2 cites too little");
});

test("with rulings only, the pause says what it said before", () => {
  const D17 = draftWith(3, [fnd("f25", "likely"), fnd("f26", "very likely")]);
  const state = disagreement([EV_F25], (b) => {
    b.add("review.conflict", { conflict: conflictOf() });
    b.add("review.ruled", { conflict: "k1", follow: "challenge", note: "" }, { actor: { kind: "human", id: "analyst" } });
    b.add("stage.sent_back", { from: "evaluate", to: "assemble", reason: "ruled", count: 1 });
    started(b, "assemble", 3); b.add("draft.revised", { draft: D17 }, { stage: "assemble" }); finished(b, "assemble", "pass", null, D17.hash, 3);
    started(b, "checks", 3); finished(b, "checks", "pass", null, D17.hash, 3);
    started(b, "evaluate", 3); b.add("evaluation.made", { draft_hash: D17.hash, pass: false, findings: [EV_F25] }); finished(b, "evaluate", "fail", EV_F25.message, D17.hash, 3);
  });
  expect(nextStep(state, roled, { likelihood: LIKELIHOOD })).toEqual({
    kind: "pause", hold: { kind: "ruled", stage: "evaluate" },
    reason: "Evaluate objects only to f25, which the person has ruled on; a ruled point is not sent back. Edit the draft, or resume for Evaluate to review it again.",
  });
});

// ---- caps per draft, and a fresh allowance on a person's resume (task 17 item 3) ----

const person = { actor: { kind: "human", id: "analyst" } as const };

test("a stage's run cap counts the runs on the same draft: each new draft starts the count again", () => {
  // Checks run once on each of six drafts: never five times on one
  const rounds = run((b) => {
    for (let n = 1; n <= 6; n++) { revised(b, n); b.add("stage.started", { stage: "checks", attempt: n }); b.add("stage.finished", { stage: "checks", attempt: n, outcome: "pass", draft_hash: draft(n).hash, output: null, reason: null }); }
    started(b, "evaluate"); finished(b, "evaluate", "pass", null, draft(6).hash);
    revised(b, 7);
  });
  expect(rounds.run.stages.find((s) => s.id === "checks")!.attempts).toBe(6);
  expect(nextStep(rounds, pipeline)).toMatchObject({ kind: "start", stage: "checks", attempt: 7, sent_back: null });
  // five runs on the one draft still pause, and say what a resume does
  const same = run((b) => {
    revised(b, 1);
    for (let n = 1; n <= 5; n++) { b.add("stage.started", { stage: "checks", attempt: n }); b.add("stage.finished", { stage: "checks", attempt: n, outcome: "pass", draft_hash: null, output: null, reason: null }); }
  });
  expect(nextStep(same, pipeline)).toEqual({ kind: "pause", reason: "Checks has run 5 times", hold: { kind: "stage_runs", stage: "checks" } });
});

test("a person's resume past the stage cap grants a fresh allowance of the cap for that stage", () => {
  const runs = (n: number, from = 1) => (b: EntryBuilder) => {
    for (let i = from; i < from + n; i++) { b.add("stage.started", { stage: "evaluate", attempt: i }); b.add("stage.finished", { stage: "evaluate", attempt: i, outcome: "pass", draft_hash: null, output: null, reason: null }); }
  };
  const capped = (b: EntryBuilder) => {
    passed(b, "assemble"); revised(b, 1); started(b, "checks"); finished(b, "checks", "pass", null, draft(1).hash);
    runs(5)(b);
    b.add("run.paused", { reason: "Evaluate has run 5 times", hold: { kind: "stage_runs", stage: "evaluate" } });
    b.add("run.resumed", {}, person);
  };
  expect(nextStep(run(capped), pipeline)).toMatchObject({ kind: "start", stage: "evaluate", attempt: 6 });
  expect(nextStep(run((b) => { capped(b); runs(4, 6)(b); }), pipeline)).toMatchObject({ kind: "start", stage: "evaluate", attempt: 10 });
  expect(nextStep(run((b) => { capped(b); runs(5, 6)(b); }), pipeline)).toEqual({ kind: "pause", reason: "Evaluate has run 5 times", hold: { kind: "stage_runs", stage: "evaluate" } });
  // the allowance is that stage's: another stage's count is untouched
  expect(run(capped).run.repeats.checks).toMatchObject({ starts: 1, base: 0 });
});

test("the send-back cap per edge stays three; a person's resume past it grants three more along that edge", () => {
  const capped = run((b) => { failedChecks(b); });
  expect(nextStep(capped, pipeline)).toEqual({ kind: "pause", reason: "Checks has sent work back to Assemble 3 times. Last reason: no good", hold: { kind: "send_back", edge: "checks>assemble" } });
  const resumed = (more: number) => run((b) => {
    failedChecks(b);
    b.add("run.paused", { reason: "capped", hold: { kind: "send_back", edge: "checks>assemble" } });
    b.add("run.resumed", {}, person);
    for (let i = 1; i <= more; i++) b.add("stage.sent_back", { from: "checks", to: "assemble", reason: "r", count: SEND_BACK_CAP + i });
    // the latest send-back's target ran and Checks failed again
    if (more > 0) { started(b, "assemble", 2); finished(b, "assemble", "pass"); started(b, "checks", 2); finished(b, "checks", "fail", "no good"); }
  });
  expect(nextStep(resumed(0), pipeline)).toMatchObject({ kind: "start", stage: "assemble", sent_back: { count: 4 } });
  expect(nextStep(resumed(2), pipeline)).toMatchObject({ kind: "start", stage: "assemble", sent_back: { count: 6 } });
  expect(nextStep(resumed(3), pipeline)).toEqual({ kind: "pause", reason: "Checks has sent work back to Assemble 3 times. Last reason: no good", hold: { kind: "send_back", edge: "checks>assemble" } });
});

test("a reviewer that names an empty card proving nothing sends back a note that it cannot be cited and its absence is a gap", () => {
  // dev CASE-3: Evaluate asked f10 to cite c2 (flows) and c4 (DNS), both empty and not proven negatives; the tools refuse to cite them
  const cards = (b: EntryBuilder) => {
    b.add("card.created", { card: card("c2", { rows: [], row_count: 0, empty: "not-seen" }) });
    b.add("card.created", { card: card("c4", { rows: [], row_count: 0, coverage: { kind: "partial", reason: "timeout" }, empty: "proven-negative" }) });
    b.add("card.created", { card: card("c5", { rows: [], row_count: 0, empty: "proven-negative" }) });
  };
  const cites = { check: "citation support", where: "f26", message: "f26 rests on c2 and c4 and c5 but cites only c1" };
  const step = nextStep(disagreement([cites], cards), roled, { likelihood: LIKELIHOOD });
  expect(step).toMatchObject({ kind: "start", stage: "assemble", sent_back: { from: "evaluate" } });
  const reason = (step as { sent_back: { reason: string } }).sent_back.reason;
  expect(reason).toStartWith(cites.message);
  expect(reason).toContain("Note: c2, c4 returned no rows and prove nothing (not a proven negative over full coverage), so they cannot be cited. A claim that rests on their absence is not supported: weaken or drop it, and name c2, c4 under gaps_and_limits.");
  // a proven negative over full coverage is citable: c5 is not in the note; and no note when no point names such a card
  expect(reason).not.toContain("c5 returned");
  const plain = nextStep(disagreement([{ check: "support", where: "f26", message: "f26 cites too little" }], cards), roled, { likelihood: LIKELIHOOD });
  expect((plain as { sent_back: { reason: string } }).sent_back.reason).toBe("f26 cites too little");
});

test("a send-back that names a statement card gets no cannot-be-cited note", () => {
  const b = new EntryBuilder();
  b.add("case.created", { id: "case-1", title: "t", asked: "a", why: "w", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN" });
  const statement = card("c5", {
    kind: "note", made_by: "human", columns: [], column_types: [], rows: [], row_count: 0, coverage: null, empty: null, source: null,
    person: { basis: "did", detail: "", about: [], answers: null },
  });
  b.add("card.created", { card: statement }, person);
  b.add("card.created", { card: card("c6", { rows: [], row_count: 0, empty: "not-seen" }) });
  const s = fold(b.entries);
  expect(s.skipped).toEqual([]);
  expect(uncitableNote(s, ["f1 should cite c5"])).toBeNull();
  // an empty card that is not the person's still gets the note
  expect(uncitableNote(s, ["f1 should cite c5 and c6"])).toStartWith("Note: c6 returned no rows");
});
