import { expect, test } from "bun:test";
import { activeOverrules, apply, blockers, fold, initial, latestDraft, notedExceptions, publishable, revisedRulingReason, ruledFindings, runUsage, unheld } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Challenge, Draft, Entry, Product, StageDef } from "../../src/core/types";
import { EntryBuilder } from "../helpers/entries";

const stages: StageDef[] = [
  { id: "assemble", title: "Assemble", phase: "produce", runs: "agent", gate: null, reviews: false, model: null },
  { id: "checks", title: "Checks", phase: "review", runs: "script", gate: null, reviews: true, model: null },
  { id: "evaluate", title: "Evaluate", phase: "review", runs: "agent", gate: null, reviews: true, model: null },
  { id: "challenge", title: "Challenge", phase: "review", runs: "agent", gate: null, reviews: true, model: null },
  { id: "publish", title: "Publish", phase: "publish", runs: "human", gate: "publish", reviews: false, model: null },
];

const product: Product = {
  objective: "o", question: "q", marking: "TLP:AMBER", summary: "s", key_findings: [], gaps_and_limits: "", alternatives: "",
  assessment: "", sources: [], assumptions: [], change: "",
};
const draft = (n: number, hash: string): Draft => ({ n, hash, author: { kind: "system", id: "test" }, product, reason: "r" });
const chal = (id: string, hash: string, severity: Challenge["severity"] = "must_address"): Challenge => ({ id, draft_hash: hash, severity, text: "t", cites: [] });

function run(): EntryBuilder {
  const b = new EntryBuilder();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  return b;
}
const revise = (b: EntryBuilder, n: number, hash: string) => b.add("draft.revised", { draft: draft(n, hash) });
const pass = (b: EntryBuilder, stage: string, hash: string | null, outcome: "pass" | "fail" = "pass") =>
  b.add("stage.finished", { stage, attempt: 1, outcome, draft_hash: hash, output: null, reason: null });
function passAll(b: EntryBuilder, hash: string) {
  for (const id of ["checks", "evaluate", "challenge"]) pass(b, id, hash);
}

test("draft.revised appends a revision and opens its review record", () => {
  const b = run();
  revise(b, 1, "h1");
  const s = fold(b.entries);
  expect(s.drafts.length).toBe(1);
  expect(s.drafts[0]!.hash).toBe("h1");
  expect(s.reviews.h1).toEqual({ checks: [], evaluation: null, challenges: [], passed_stages: [], rejected: null });
});

test("latestDraft is the last revision, or null", () => {
  const b = run();
  expect(latestDraft(fold(b.entries))).toBeNull();
  revise(b, 1, "h1");
  revise(b, 2, "h2");
  expect(latestDraft(fold(b.entries))?.hash).toBe("h2");
});

test("a check result is recorded against its draft, and a re-run replaces it", () => {
  const b = run();
  revise(b, 1, "h1");
  const input = { blob: "b", bytes: 1 };
  b.add("check.run", { check: "c1", script_hash: "x", input, output: input, draft_hash: "h1", pass: false, findings: [{ check: "c1", where: "w", message: "m" }] });
  b.add("check.run", { check: "c2", script_hash: "x", input, output: input, draft_hash: "h1", pass: true, findings: [] });
  expect(fold(b.entries).reviews.h1!.checks.map((c) => [c.check, c.pass])).toEqual([["c1", false], ["c2", true]]);
  b.add("check.run", { check: "c1", script_hash: "x", input, output: input, draft_hash: "h1", pass: true, findings: [] });
  const s = fold(b.entries);
  expect(s.reviews.h1!.checks).toEqual([{ check: "c1", pass: true, findings: [] }, { check: "c2", pass: true, findings: [] }]);
});

test("an evaluation is recorded against its draft", () => {
  const b = run();
  revise(b, 1, "h1");
  b.add("evaluation.made", { draft_hash: "h1", pass: false, findings: [{ check: "e", where: "w", message: "m" }] });
  expect(fold(b.entries).reviews.h1!.evaluation).toEqual({ pass: false, findings: [{ check: "e", where: "w", message: "m" }] });
});

test("a challenge opens against its draft and can be answered", () => {
  const b = run();
  revise(b, 1, "h1");
  b.add("challenge.raised", { challenge: chal("x1", "h1") });
  let s = fold(b.entries);
  expect(s.challenges.x1).toMatchObject({ id: "x1", status: "open", answer: null, action: null });
  expect(s.reviews.h1!.challenges).toEqual(["x1"]);
  expect(s.counters.challenge).toBe(1);
  b.add("challenge.answered", { challenge: "x1", answer: "done", action: "revised" });
  s = fold(b.entries);
  expect(s.challenges.x1).toMatchObject({ status: "answered", answer: "done", action: "revised" });
});

test("a passing review stage is recorded against the draft it examined", () => {
  const b = run();
  revise(b, 1, "h1");
  pass(b, "checks", "h1");
  pass(b, "checks", "h1");
  const s = fold(b.entries);
  expect(s.reviews.h1!.passed_stages).toEqual(["checks"]);
  expect(s.run.stages.find((x) => x.id === "checks")!.status).toBe("passed");
});

test("a failing stage is not recorded as passed", () => {
  const b = run();
  revise(b, 1, "h1");
  pass(b, "checks", "h1", "fail");
  expect(fold(b.entries).reviews.h1!.passed_stages).toEqual([]);
});

test("a draft is publishable only when every review stage passed that exact hash", () => {
  const b = run();
  revise(b, 1, "h1");
  pass(b, "checks", "h1");
  pass(b, "evaluate", "h1");
  expect(publishable(fold(b.entries), "h1")).toBe(false);
  pass(b, "challenge", "h1");
  expect(publishable(fold(b.entries), "h1")).toBe(true);
});

test("an open must-address challenge blocks publishing; answering it unblocks", () => {
  const b = run();
  revise(b, 1, "h1");
  passAll(b, "h1");
  b.add("challenge.raised", { challenge: chal("x1", "h1") });
  expect(publishable(fold(b.entries), "h1")).toBe(false);
  b.add("challenge.answered", { challenge: "x1", answer: "a", action: "rebutted" });
  expect(publishable(fold(b.entries), "h1")).toBe(true);
});

test("a 'consider' challenge does not block", () => {
  const b = run();
  revise(b, 1, "h1");
  passAll(b, "h1");
  b.add("challenge.raised", { challenge: chal("x1", "h1", "consider") });
  expect(publishable(fold(b.entries), "h1")).toBe(true);
});

test("a new revision is not publishable on the old revision's passes", () => {
  const b = run();
  revise(b, 1, "h1");
  passAll(b, "h1");
  expect(publishable(fold(b.entries), "h1")).toBe(true);
  revise(b, 2, "h2");
  const s = fold(b.entries);
  expect(publishable(s, "h2")).toBe(false);
  expect(publishable(s, "h1")).toBe(false);
});

test("a repeated draft hash is a new revision and keeps that hash's review record", () => {
  const b = run();
  revise(b, 1, "h1");
  passAll(b, "h1");
  revise(b, 2, "h2");
  revise(b, 3, "h1");
  let s = fold(b.entries);
  expect(s.drafts.map((d) => [d.n, d.hash])).toEqual([[1, "h1"], [2, "h2"], [3, "h1"]]);
  expect(latestDraft(s)).toMatchObject({ n: 3, hash: "h1" });
  expect(publishable(s, "h1")).toBe(true);
  expect(publishable(s, "h2")).toBe(false);
  const c = run();
  revise(c, 1, "h1");
  passAll(c, "h1");
  c.add("challenge.raised", { challenge: chal("x1", "h1") });
  revise(c, 2, "h2");
  revise(c, 3, "h1");
  s = fold(c.entries);
  expect(s.reviews.h1!.challenges).toEqual(["x1"]);
  expect(publishable(s, "h1")).toBe(false);
});

test("the latest verdict wins: a later failure on the same hash removes the pass", () => {
  const b = run();
  revise(b, 1, "h1");
  passAll(b, "h1");
  pass(b, "evaluate", "h1", "fail");
  let s = fold(b.entries);
  expect(s.reviews.h1!.passed_stages).toEqual(["checks", "challenge"]);
  expect(publishable(s, "h1")).toBe(false);
  pass(b, "evaluate", "h1");
  expect(publishable(fold(b.entries), "h1")).toBe(true);
  b.add("stage.finished", { stage: "checks", attempt: 2, outcome: "declined", draft_hash: "h1", output: null, reason: null });
  s = fold(b.entries);
  expect(s.reviews.h1!.passed_stages).toEqual(["challenge", "evaluate"]);
});

test("a new run reviews afresh", () => {
  const b = run();
  revise(b, 1, "h1");
  b.add("check.run", { check: "c", script_hash: "x", input: { blob: "b", bytes: 1 }, output: { blob: "b", bytes: 1 }, draft_hash: "h1", pass: true, findings: [] });
  passAll(b, "h1");
  expect(publishable(fold(b.entries), "h1")).toBe(true);
  b.add("run.started", { run: "run-2", pipeline: "p", pipeline_hash: "h", stages });
  const s = fold(b.entries);
  expect(s.reviews.h1!.passed_stages).toEqual([]);
  expect(s.reviews.h1!.checks.length).toBe(1);
  expect(publishable(s, "h1")).toBe(false);
  passAll(b, "h1");
  expect(publishable(fold(b.entries), "h1")).toBe(true);
});

test("a draft with a malformed product is ignored", () => {
  const base = fold(run().entries);
  const bad: unknown[] = [
    {}, { ...product, marking: "secret" }, { ...product, key_findings: [{}] }, { ...product, sources: [1] },
    { ...product, assumptions: [1] }, { ...product, change: undefined },
  ];
  for (const p of bad) {
    const e = raw("draft.revised", { draft: { ...draft(1, "h1"), product: p } });
    const out = apply(base, e);
    expect(out.drafts).toEqual([]);
    expect(out.reviews).toEqual({});
  }
});

test("a run with no review stages publishes nothing", () => {
  const b = new EntryBuilder();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages: [stages[0]!, stages[4]!] });
  revise(b, 1, "h1");
  const s = fold(b.entries);
  expect(publishable(s, "h1")).toBe(false);
  expect(blockers(s, "h1").length).toBeGreaterThan(0);
  expect(publishable(initial(), "h1")).toBe(false);
});

test("blockers names what is missing", () => {
  const b = run();
  revise(b, 1, "h1");
  pass(b, "checks", "h1");
  expect(blockers(fold(b.entries), "h1")).toEqual(["Evaluate has not passed this revision", "Challenge has not passed this revision"]);
  b.add("challenge.raised", { challenge: chal("x1", "h1") });
  expect(blockers(fold(b.entries), "h1")).toContain("Challenge x1 must be addressed");
  revise(b, 2, "h2");
  const s = fold(b.entries);
  expect(blockers(s, "h1")).toEqual(["This is not the latest revision"]);
  expect(blockers(s, "nope")).toEqual(["This is not the latest revision"]);
  const c = run();
  revise(c, 1, "h1");
  passAll(c, "h1");
  expect(blockers(fold(c.entries), "h1")).toEqual([]);
});

test("product.published records the bundle", () => {
  const b = run();
  revise(b, 1, "h1");
  const e = b.add("product.published", { n: 1, draft_hash: "h1", head_hash: "hh", dir: "out/1", bundle: { blob: "b", bytes: 2 } });
  expect(fold(b.entries).published).toEqual([{ n: 1, draft_hash: "h1", head_hash: "hh", dir: "out/1", seq: e.seq, ts: e.ts }]);
});

test("feedback is appended in order", () => {
  const b = run();
  b.add("feedback.recorded", { measure: "m1", kind: "mop", value: 3, note: "a" });
  b.add("feedback.recorded", { measure: "m2", kind: "moe", value: "good", note: "b" });
  expect(fold(b.entries).feedback.map((f) => f.measure)).toEqual(["m1", "m2"]);
});

test("agent.asked opens a turn and agent.answered fills it", () => {
  const b = run();
  b.add("agent.asked", { turn: "u1", text: "why?", left_out: [], added: [] });
  let s = fold(b.entries);
  expect(s.conversation).toEqual([{ turn: "u1", asked: "why?", answer: null, cites: [], request: null, asked_seq: 2, ended: null }]);
  expect(s.counters.turn).toBe(1);
  b.add("agent.answered", { turn: "u1", request: "r1", text: "because", cites: ["c1"] });
  s = fold(b.entries);
  expect(s.conversation).toEqual([{ turn: "u1", asked: "why?", answer: "because", cites: ["c1"], request: "r1", asked_seq: 2, ended: null }]);
});

test("agent.ended closes an unanswered turn by the seq of its question, once, and never an answered one", () => {
  const b = run();
  b.add("agent.asked", { turn: "u1", text: "a", left_out: [], added: [] });
  b.add("agent.asked", { turn: "u2", text: "b", left_out: [], added: [] });
  b.add("agent.ended", { asked: 2, reason: "interrupted" });
  b.add("agent.ended", { asked: 2, reason: "second" });
  b.add("agent.answered", { turn: "u2", request: "r1", text: "t", cites: [] });
  b.add("agent.ended", { asked: 3, reason: "late" });
  b.add("agent.ended", { asked: 99, reason: "nothing" });
  const s = fold(b.entries);
  expect(s.conversation.map((t) => [t.turn, t.ended, t.answer])).toEqual([["u1", "interrupted", null], ["u2", null, "t"]]);
  expect(s.skipped).toEqual([]);
  expect(fold([...b.entries, { ...b.entries[0]!, seq: 8, type: "agent.ended", payload: { asked: "x" } } as unknown as Entry]).skipped.length).toBe(1);
});

test("the conversation's model responses are counted apart and do not spend the run's usage", () => {
  const b = run();
  const usage = { input: 10, output: 5, reasoning: 1 };
  const agent = { kind: "agent", id: "assistant", stage: "agent", profile: "p", model: "m", effort: null, where: "machine" } as const;
  const other = { ...agent, id: "analyst", stage: "assemble" };
  b.add("model.response", { request: "r1", response: { blob: "b", bytes: 1 }, stop: "end", usage, served_by: "m", reasoning: null }, { actor: other });
  b.add("model.response", { request: "r2", response: { blob: "b", bytes: 1 }, stop: "end", usage, served_by: "m", reasoning: null }, { actor: agent });
  const s = fold(b.entries);
  expect(runUsage(s)).toEqual({ usage, model_calls: 1 });
  expect(s.agent_usage).toEqual({ usage, calls: 1 });
});

test("analysis entries for an unknown draft hash change only seq", () => {
  const b = run();
  revise(b, 1, "h1");
  const base = fold(b.entries);
  const input = { blob: "b", bytes: 1 };
  const more = new EntryBuilder();
  more.entries.push(...b.entries);
  pass(more, "checks", "zz");
  more.add("check.run", { check: "c", script_hash: "x", input, output: input, draft_hash: "zz", pass: true, findings: [] });
  more.add("evaluation.made", { draft_hash: "zz", pass: true, findings: [] });
  more.add("challenge.raised", { challenge: chal("x1", "zz") });
  more.add("challenge.answered", { challenge: "x9", answer: "a", action: "revised" });
  more.add("agent.answered", { turn: "u9", request: "r", text: "t", cites: [] });
  const s = fold(more.entries);
  const strip = (x: CaseState) => ({ ...x, seq: 0, head_ts: null, counters: base.counters, run: base.run });
  expect(strip(s)).toEqual(strip(base));
  expect(s.seq).toBe(more.entries.length);
});

test("ids that are prototype keys are handled with own-property lookups", () => {
  const b = run();
  revise(b, 1, "toString");
  revise(b, 2, "__proto__");
  pass(b, "checks", "constructor");
  b.add("challenge.answered", { challenge: "hasOwnProperty", answer: "a", action: "revised" });
  b.add("challenge.raised", { challenge: chal("constructor", "toString") });
  const s = fold(b.entries);
  expect(Object.hasOwn(s.reviews, "constructor")).toBe(false);
  expect(Object.hasOwn(s.reviews, "__proto__")).toBe(true);
  expect(Object.hasOwn(s.challenges, "constructor")).toBe(true);
  expect(s.challenges.constructor).toMatchObject({ status: "open" });
  expect(publishable(s, "toString")).toBe(false);
});

test("apply never mutates the state it is given", () => {
  const b = run();
  revise(b, 1, "h1");
  b.add("challenge.raised", { challenge: chal("x1", "h1") });
  b.add("agent.asked", { turn: "u1", text: "q", left_out: [], added: [] });
  const base = fold(b.entries);
  const frozen = structuredClone(base);
  const input = { blob: "b", bytes: 1 };
  const next = new EntryBuilder();
  next.entries.push(...b.entries);
  revise(next, 2, "h2");
  pass(next, "checks", "h1");
  next.add("check.run", { check: "c", script_hash: "x", input, output: input, draft_hash: "h1", pass: true, findings: [] });
  next.add("evaluation.made", { draft_hash: "h1", pass: true, findings: [] });
  next.add("challenge.answered", { challenge: "x1", answer: "a", action: "revised" });
  next.add("agent.answered", { turn: "u1", request: "r", text: "t", cites: [] });
  next.add("agent.asked", { turn: "u2", text: "q2", left_out: [], added: [] });
  next.add("feedback.recorded", { measure: "m", kind: "mop", value: 1, note: "" });
  next.add("product.published", { n: 1, draft_hash: "h1", head_hash: "hh", dir: "d", bundle: input });
  for (const e of next.entries.slice(b.entries.length)) {
    apply(base, e);
    expect(base).toEqual(frozen);
  }
});

// ---------- robustness ----------
const HANDLED = [
  "draft.revised", "check.run", "evaluation.made", "challenge.raised", "challenge.answered", "stage.finished",
  "product.published", "feedback.recorded", "agent.asked", "agent.answered",
] as const;

function raw(type: string, payload: unknown): Entry {
  return { ...new EntryBuilder().add("run.resumed", {}), type, payload } as unknown as Entry;
}

function populated(): CaseState {
  const b = run();
  revise(b, 1, "h1");
  b.add("challenge.raised", { challenge: chal("x1", "h1") });
  b.add("agent.asked", { turn: "u1", text: "q", left_out: [], added: [] });
  return fold(b.entries);
}

test("malformed payloads never throw and change nothing", () => {
  const base = populated();
  const wrong = {
    draft: 5, check: 5, script_hash: 1, input: 1, draft_hash: 5, pass: "yes", findings: "f", challenge: 7, answer: 1, action: "x",
    stage: 5, outcome: "maybe", n: "1", head_hash: 1, dir: 1, bundle: 1, measure: 1, kind: "k", value: {}, note: 1, turn: 5,
    text: 1, left_out: "l", added: "a", request: 5, cites: "c",
  };
  const wrongNested = {
    draft: { n: "1", hash: 5, author: 1, product: 1, reason: 2 }, challenge: { id: 1, draft_hash: 2, severity: "x" },
    findings: [1, { check: 1 }], cites: [1],
  };
  const payloads: [string, unknown][] = [["null", null], ["undefined", undefined], ["empty", {}], ["wrong types", wrong], ["wrong nested", wrongNested], ["array", []]];
  for (const type of HANDLED) {
    for (const [label, payload] of payloads) {
      const e = raw(type, payload);
      let out: CaseState | undefined;
      expect(() => { out = apply(base, e); }).not.toThrow();
      expect({ ...out!, seq: base.seq, head_ts: base.head_ts, counters: base.counters, skipped: base.skipped }, `${type} ${label}`).toEqual(base);
      const reason = payload === null || payload === undefined || Array.isArray(payload) ? "malformed payload" : `malformed ${type}`;
      expect(out!.skipped, `${type} ${label}`).toEqual([...base.skipped, { seq: e.seq, type, reason }]);
    }
  }
});

test("a state with no drafts also survives malformed payloads", () => {
  const base = initial();
  for (const type of HANDLED) expect(() => apply(base, raw(type, {}))).not.toThrow();
});

// ---------- final review, finding 5: the person's rejection is a verdict ----------
test("publish.rejected clears the passes on that hash and records the reason", () => {
  const b = run();
  revise(b, 1, "h1");
  passAll(b, "h1");
  b.add("gate.waiting", { gate: "publish" });
  expect(publishable(fold(b.entries), "h1")).toBe(true);
  const rejected = b.add("publish.rejected", { draft_hash: "h1", reason: "the summary overstates the evidence", stop: false });
  b.add("stage.sent_back", { from: "publish", to: "assemble", reason: "rejected", count: 1 });
  const s = fold(b.entries);
  expect(publishable(s, "h1")).toBe(false);
  expect(blockers(s, "h1")).toEqual(["Checks has not passed this revision", "Evaluate has not passed this revision", "Challenge has not passed this revision"]);
  expect(s.reviews.h1!.passed_stages).toEqual([]);
  expect(s.reviews.h1!.rejected).toEqual({ reason: "the summary overstates the evidence", stop: false, seq: rejected.seq, ts: rejected.ts });
});

test("the same bytes sent back by Assemble must pass review again, and the rejection stays on record", () => {
  const b = run();
  revise(b, 1, "h1");
  passAll(b, "h1");
  b.add("publish.rejected", { draft_hash: "h1", reason: "no", stop: false });
  revise(b, 2, "h1");
  expect(publishable(fold(b.entries), "h1")).toBe(false);
  passAll(b, "h1");
  const s = fold(b.entries);
  expect(publishable(s, "h1")).toBe(true);
  expect(s.reviews.h1!.rejected).toMatchObject({ reason: "no", stop: false });
});

test("publish.rejected for an unknown hash changes nothing; a malformed one is recorded", () => {
  const b = run();
  revise(b, 1, "h1");
  const base = fold(b.entries);
  b.add("publish.rejected", { draft_hash: "zz", reason: "no", stop: true });
  const s = fold(b.entries);
  expect(s.reviews).toEqual(base.reviews);
  expect(s.skipped).toEqual([]);
  b.add("publish.rejected", { draft_hash: "h1", reason: "no", stop: "yes" } as never);
  expect(fold(b.entries).skipped).toEqual([{ seq: b.entries.length, type: "publish.rejected", reason: "malformed publish.rejected" }]);
});

test("a new review record has no rejection", () => {
  const b = run();
  revise(b, 1, "h1");
  expect(fold(b.entries).reviews.h1!.rejected).toBeNull();
});

// ---------- final review, finding 20: failing results on record block publishing ----------
const checkRun = (b: EntryBuilder, check: string, hash: string, pass: boolean) =>
  b.add("check.run", { check, script_hash: "x", input: { blob: "b", bytes: 1 }, output: { blob: "b", bytes: 1 }, draft_hash: hash, pass, findings: [] });

test("a failing check or evaluation on record for the hash blocks publishing even with every stage passed", () => {
  const b = run();
  revise(b, 1, "h1");
  passAll(b, "h1");
  checkRun(b, "citations", "h1", false);
  b.add("evaluation.made", { draft_hash: "h1", pass: false, findings: [] });
  const s = fold(b.entries);
  expect(publishable(s, "h1")).toBe(false);
  expect(blockers(s, "h1")).toEqual(["citations failed on this revision", "Evaluation failed on this revision"]);
});

test("the latest result of each check counts: a later pass clears the blocker", () => {
  const b = run();
  revise(b, 1, "h1");
  passAll(b, "h1");
  checkRun(b, "citations", "h1", false);
  checkRun(b, "markings", "h1", true);
  b.add("evaluation.made", { draft_hash: "h1", pass: false, findings: [] });
  checkRun(b, "citations", "h1", true);
  b.add("evaluation.made", { draft_hash: "h1", pass: true, findings: [] });
  expect(blockers(fold(b.entries), "h1")).toEqual([]);
});

test("a failing check on another hash does not block this one", () => {
  const b = run();
  revise(b, 1, "h0");
  checkRun(b, "citations", "h0", false);
  revise(b, 2, "h1");
  passAll(b, "h1");
  expect(publishable(fold(b.entries), "h1")).toBe(true);
});

// ---------- final review, finding 4: a repeated hash must carry the same product ----------
test("a revision that reuses a reviewed hash with a different product is refused and recorded", () => {
  const b = run();
  revise(b, 1, "h1");
  passAll(b, "h1");
  const forged = b.add("draft.revised", { draft: { ...draft(2, "h1"), product: { ...product, summary: "text nobody reviewed" } } });
  const s = fold(b.entries);
  expect(s.drafts.map((d) => d.n)).toEqual([1]);
  expect(latestDraft(s)!.product.summary).toBe(product.summary);
  expect(s.skipped).toEqual([{ seq: forged.seq, type: "draft.revised", reason: "draft hash h1 already names a different product" }]);
  // the same bytes under the same hash are still a new revision
  revise(b, 3, "h1");
  expect(fold(b.entries).drafts.map((d) => d.n)).toEqual([1, 3]);
});

test("check.run without an output reference is malformed", () => {
  const b = run();
  revise(b, 1, "h1");
  const before = fold(b.entries);
  const e = b.add("check.run", { check: "c", script_hash: "x", input: { blob: "b", bytes: 1 }, draft_hash: "h1", pass: true, findings: [] } as never);
  const s = fold(b.entries);
  expect(s.skipped.at(-1)).toEqual({ seq: e.seq, type: "check.run", reason: "malformed check.run" });
  expect(s.reviews).toEqual(before.reviews);
});

// ---- check strictness (task 11 item 3) ----

test("a failed non-blocking check is not a blocker: it is a noted exception, and only blocking failures block", () => {
  const b = run();
  revise(b, 1, "h1");
  passAll(b, "h1");
  const input = { blob: "b", bytes: 1 };
  b.add("check.run", { check: "change", script_hash: "x", input, output: input, draft_hash: "h1", pass: false, blocking: false, findings: [{ check: "change", where: "change", message: "the change is empty" }, { check: "change", where: "x", message: "second" }] });
  b.add("check.run", { check: "marking", script_hash: "x", input, output: input, draft_hash: "h1", pass: true, findings: [] });
  let s = fold(b.entries);
  expect(s.skipped).toEqual([]);
  expect(s.reviews.h1!.checks[0]).toEqual({ check: "change", pass: false, blocking: false, findings: [{ check: "change", where: "change", message: "the change is empty" }, { check: "change", where: "x", message: "second" }] });
  expect(s.reviews.h1!.checks[1]).toEqual({ check: "marking", pass: true, findings: [] });
  expect(blockers(s, "h1")).toEqual([]);
  expect(publishable(s, "h1")).toBe(true);
  expect(notedExceptions(s, "h1")).toEqual(["change failed on this revision (noted, not blocking): the change is empty; second"]);
  // a blocking failure still blocks, and is not a noted exception
  b.add("check.run", { check: "marking", script_hash: "x", input, output: input, draft_hash: "h1", pass: false, findings: [{ check: "marking", where: "m", message: "too low" }] });
  s = fold(b.entries);
  expect(blockers(s, "h1")).toEqual(["marking failed on this revision"]);
  expect(notedExceptions(s, "h1")).toHaveLength(1);
  expect(notedExceptions(s, "nope")).toEqual([]);
});

test("a check.run whose blocking is not a boolean is malformed", () => {
  const b = run();
  revise(b, 1, "h1");
  const input = { blob: "b", bytes: 1 };
  b.add("check.run", { check: "c", script_hash: "x", input, output: input, draft_hash: "h1", pass: false, blocking: "no", findings: [] } as never);
  const s = fold(b.entries);
  expect(s.skipped).toHaveLength(1);
  expect(s.reviews.h1!.checks).toEqual([]);
});

// ---- reviewers who disagree (task 17) ----

const person = { kind: "human", id: "analyst" } as const;
const conflict = (over: Record<string, unknown> = {}) => ({
  id: "k1", draft_hash: "h2", finding: "f25", change: "likelihood", earlier: "almost certain", now: "likely", raised_by: "evaluate", changed_for: "challenge",
  asks: "almost certain", asked: "lower", points: ["f25: understates it"], reason: "Evaluate and Challenge disagree on f25", ...over,
});

test("a revision made after a reviewer's send-back records which reviewer it answered; one made otherwise records none", () => {
  const b = run();
  b.add("draft.revised", { draft: draft(1, "h1") }, { stage: "assemble" });
  b.add("stage.sent_back", { from: "challenge", to: "assemble", reason: "x1", count: 1 });
  b.add("draft.revised", { draft: draft(2, "h2") }, { stage: "assemble" });
  pass(b, "assemble", "h2");
  b.add("draft.revised", { draft: draft(3, "h3") }, { stage: "assemble" });
  b.add("draft.revised", { draft: draft(4, "h4") }, { actor: person });
  const s = fold(b.entries);
  expect(s.made_for).toEqual({ h2: "challenge" });
  expect(s.skipped).toEqual([]);
});

test("review.conflict records the conflict in the run; a later review.ruled replaces the ruling and keeps the earlier one", () => {
  const b = run();
  revise(b, 1, "h1"); revise(b, 2, "h2");
  b.add("review.conflict", { conflict: conflict() as never });
  let s = fold(b.entries);
  expect(s.counters.conflict).toBe(1);
  expect(s.conflicts.k1).toMatchObject({ finding: "f25", run: "run-1", ruling: null });
  const first = b.add("review.ruled", { conflict: "k1", follow: "challenge", note: "one event" }, { actor: person });
  const second = b.add("review.ruled", { conflict: "k1", follow: "evaluate", note: "" }, { actor: person });
  s = fold(b.entries);
  expect(s.conflicts.k1!.ruling).toEqual({ follow: "evaluate", note: "", by: "analyst", seq: second.seq, ts: second.ts });
  expect(s.conflicts.k1!.earlier_rulings).toEqual([{ follow: "challenge", note: "one event", by: "analyst", seq: first.seq, ts: first.ts }]);
  const third = b.add("review.ruled", { conflict: "k1", follow: null, note: "neither: it is the TV" }, { actor: person });
  s = fold(b.entries);
  expect(s.conflicts.k1!.ruling).toMatchObject({ follow: null, seq: third.seq });
  expect(s.conflicts.k1!.earlier_rulings!.map((r) => r.seq)).toEqual([first.seq, second.seq]);
  expect(s.skipped).toEqual([]);
});

test("a conflict ruled once has no earlier_rulings", () => {
  const b = run();
  revise(b, 1, "h1"); revise(b, 2, "h2");
  b.add("review.conflict", { conflict: conflict() as never });
  b.add("review.ruled", { conflict: "k1", follow: "challenge", note: "one event" }, { actor: person });
  // a refused second ruling replaces nothing
  b.add("review.ruled", { conflict: "k1", follow: "checks", note: "" }, { actor: person });
  const s = fold(b.entries);
  expect("earlier_rulings" in s.conflicts.k1!).toBe(false);
  expect(s.conflicts.k1!.ruling).toMatchObject({ follow: "challenge" });
});

const withFinding = (likelihood: string, confidence: "low" | "moderate" | "high" = "moderate"): Product => ({
  ...product, key_findings: [{ id: "f1", statement: "s", likelihood, confidence, confidence_basis: "b", cites: [], assumptions: [], reasoning: "r" }],
});
const draftOf = (n: number, hash: string, p: Product): Draft => ({ n, hash, author: { kind: "system", id: "test" }, product: p, reason: "r" });
/** A run whose draft h2 moved f1 from almost certain to likely for Challenge, with Evaluate's conflict k1 on it. */
function ruledRun(): EntryBuilder {
  const b = run();
  b.add("draft.revised", { draft: draftOf(1, "h1", withFinding("almost certain")) });
  b.add("draft.revised", { draft: draftOf(2, "h2", withFinding("likely")) });
  b.add("review.conflict", { conflict: conflict({ finding: "f1", points: ["f1: understates it"], reason: "Evaluate and Challenge disagree on f1" }) as never });
  return b;
}

test("an overrule of a ruled finding, made after the ruling, takes its place: ruledFindings leaves the ruling out", () => {
  const b = ruledRun();
  b.add("finding.overruled", { finding: "f1", draft_hash: "h2", likelihood: "almost certain", confidence: null, stays: null, note: "It is the TV I installed." }, { actor: person });
  b.add("review.ruled", { conflict: "k1", follow: "challenge", note: "" }, { actor: person });
  // the ruling came after the overrule: it stands
  expect([...ruledFindings(fold(b.entries)).keys()]).toEqual(["f1"]);
  b.add("finding.overruled", { finding: "f1", draft_hash: "h2", likelihood: "almost certain", confidence: null, stays: null, note: "It is the TV I installed, really." }, { actor: person });
  let s = fold(b.entries);
  expect([...ruledFindings(s).keys()]).toEqual([]);
  // a withdrawn overrule replaces nothing: the ruling is back
  b.add("finding.overruled", { finding: "f1", draft_hash: "h2", likelihood: null, confidence: null, stays: null, note: "I was wrong." }, { actor: person });
  s = fold(b.entries);
  expect([...ruledFindings(s).keys()]).toEqual(["f1"]);
  expect(s.skipped).toEqual([]);
});

test("a ruling made after an overrule of the same finding takes its place: the person's later act wins, so a draft can hold it (final review I2)", () => {
  const b = ruledRun();
  b.add("review.ruled", { conflict: "k1", follow: "evaluate", note: "" }, { actor: person });
  b.add("finding.overruled", { finding: "f1", draft_hash: "h2", likelihood: "very likely", confidence: null, stays: null, note: "It is the TV I installed." }, { actor: person });
  // the overrule came after the first ruling: it holds, and the ruling is left out
  let s = fold(b.entries);
  expect(activeOverrules(s).map((o) => o.finding)).toEqual(["f1"]);
  expect([...ruledFindings(s).keys()]).toEqual([]);
  // the person revises the ruling to keep likely: now the ruling holds, and the overrule is left out
  b.add("review.ruled", { conflict: "k1", follow: "challenge", note: "" }, { actor: person });
  s = fold(b.entries);
  expect(activeOverrules(s)).toEqual([]);
  expect([...ruledFindings(s).keys()]).toEqual(["f1"]);
  expect(unheld(s, withFinding("likely"))).toEqual([]);
  expect(unheld(s, withFinding("very likely"))).toEqual(["The draft does not hold your ruling on f1 (follow Challenge: keep likely)"]);
  // a ruling that keeps no value (a note only) does not take an overrule's place
  b.add("finding.overruled", { finding: "f1", draft_hash: "h2", likelihood: "almost certain", confidence: null, stays: null, note: "No: it is the TV." }, { actor: person });
  b.add("review.ruled", { conflict: "k1", follow: null, note: "both have a point" }, { actor: person });
  s = fold(b.entries);
  expect(activeOverrules(s).map((o) => o.likelihood)).toEqual(["almost certain"]);
  expect(unheld(s, withFinding("almost certain"))).toEqual([]);
  expect(s.skipped).toEqual([]);
});

test("a draft that does not hold a ruling of this run, or an overrule, cannot be published, and says which", () => {
  const b = ruledRun();
  b.add("review.ruled", { conflict: "k1", follow: "challenge", note: "" }, { actor: person });
  b.add("draft.revised", { draft: draftOf(3, "h3", withFinding("almost certain")) });
  passAll(b, "h3");
  const s = fold(b.entries);
  expect(blockers(s, "h3")).toEqual(["The draft does not hold your ruling on f1 (follow Challenge: keep likely)"]);

  const c = run();
  c.add("draft.revised", { draft: draftOf(1, "h1", withFinding("likely")) });
  c.add("finding.overruled", { finding: "f1", draft_hash: "h1", likelihood: "almost certain", confidence: null, stays: null, note: "It is the TV I installed." }, { actor: person });
  passAll(c, "h1");
  const s2 = fold(c.entries);
  expect(blockers(s2, "h1")).toContain("The draft does not hold your overrule of f1 (likelihood almost certain)");
  expect(publishable(s2, "h1")).toBe(false);

  // a draft that holds them: neither line
  b.add("draft.revised", { draft: draftOf(4, "h4", withFinding("likely")) });
  passAll(b, "h4");
  expect(blockers(fold(b.entries), "h4")).toEqual([]);
  c.add("draft.revised", { draft: draftOf(2, "h2", withFinding("almost certain")) });
  passAll(c, "h2");
  expect(blockers(fold(c.entries), "h2")).toEqual([]);
  // a withdrawn overrule: no line
  c.add("finding.overruled", { finding: "f1", draft_hash: "h2", likelihood: null, confidence: null, stays: null, note: "I was wrong." }, { actor: person });
  c.add("draft.revised", { draft: draftOf(3, "h3", withFinding("likely")) });
  passAll(c, "h3");
  expect(blockers(fold(c.entries), "h3")).toEqual([]);
});

test("a malformed conflict or ruling is recorded as skipped; a ruling not by a person, or for a stage not party to it, or with neither side nor note, is too", () => {
  const b = run();
  revise(b, 1, "h1"); revise(b, 2, "h2");
  const bad1 = b.add("review.conflict", { conflict: conflict({ change: "sideways" }) as never });
  b.add("review.conflict", { conflict: conflict() as never });
  const bad2 = b.add("review.ruled", { conflict: "k1", follow: 5 as never, note: "" }, { actor: person });
  const bad3 = b.add("review.ruled", { conflict: "k1", follow: "challenge", note: "" }, { actor: { kind: "system", id: "engine" } });
  const bad4 = b.add("review.ruled", { conflict: "k1", follow: "checks", note: "" }, { actor: person });
  const bad5 = b.add("review.ruled", { conflict: "k1", follow: null, note: "  " }, { actor: person });
  const s = fold(b.entries);
  expect(s.conflicts.k1!.ruling).toBeNull();
  expect(s.skipped.map((x) => [x.seq, x.reason])).toEqual([
    [bad1.seq, "malformed review.conflict"], [bad2.seq, "malformed review.ruled"], [bad3.seq, "a ruling is a person's"],
    [bad4.seq, "a ruling follows one of the two reviewers in the conflict"], [bad5.seq, "a ruling follows one of the two reviewers, or gives a note"],
  ]);
});

test("revisedRulingReason says the person revised the ruling, and the ruling that holds now; null for a conflict ruled once", () => {
  const b = ruledRun();
  b.add("review.ruled", { conflict: "k1", follow: "challenge", note: "" }, { actor: person });
  expect(revisedRulingReason(fold(b.entries), fold(b.entries).conflicts.k1!)).toBeNull();
  b.add("review.ruled", { conflict: "k1", follow: "evaluate", note: "It is the TV." }, { actor: person });
  const s = fold(b.entries);
  expect(revisedRulingReason(s, s.conflicts.k1!)).toBe("the person revised the ruling on f1 (Evaluate and Challenge disagree on f1): follow Evaluate: almost certain. Note: It is the TV.");
});
