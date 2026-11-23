import { expect, test } from "bun:test";
import { apply, blockers, fold, initial, latestDraft, publishable } from "../../src/core/state";
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
  b.add("check.run", { check: "c1", script_hash: "x", input, draft_hash: "h1", pass: false, findings: [{ check: "c1", where: "w", message: "m" }] });
  b.add("check.run", { check: "c2", script_hash: "x", input, draft_hash: "h1", pass: true, findings: [] });
  expect(fold(b.entries).reviews.h1!.checks.map((c) => [c.check, c.pass])).toEqual([["c1", false], ["c2", true]]);
  b.add("check.run", { check: "c1", script_hash: "x", input, draft_hash: "h1", pass: true, findings: [] });
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
  b.add("check.run", { check: "c", script_hash: "x", input: { blob: "b", bytes: 1 }, draft_hash: "h1", pass: true, findings: [] });
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
  expect(s.conversation).toEqual([{ turn: "u1", asked: "why?", answer: null, cites: [], request: null }]);
  expect(s.counters.turn).toBe(1);
  b.add("agent.answered", { turn: "u1", request: "r1", text: "because", cites: ["c1"] });
  s = fold(b.entries);
  expect(s.conversation).toEqual([{ turn: "u1", asked: "why?", answer: "because", cites: ["c1"], request: "r1" }]);
});

test("analysis entries for an unknown draft hash change only seq", () => {
  const b = run();
  revise(b, 1, "h1");
  const base = fold(b.entries);
  const input = { blob: "b", bytes: 1 };
  const more = new EntryBuilder();
  more.entries.push(...b.entries);
  pass(more, "checks", "zz");
  more.add("check.run", { check: "c", script_hash: "x", input, draft_hash: "zz", pass: true, findings: [] });
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
  next.add("check.run", { check: "c", script_hash: "x", input, draft_hash: "h1", pass: true, findings: [] });
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
  b.add("check.run", { check, script_hash: "x", input: { blob: "b", bytes: 1 }, draft_hash: hash, pass, findings: [] });

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
