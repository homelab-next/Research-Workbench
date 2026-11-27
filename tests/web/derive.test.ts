import { expect, test } from "bun:test";
import { fold } from "../../src/core/state";
import type { CaseState, CardState } from "../../src/core/state";
import type { Card, Draft, Plan, PlanStep, Product, StageDef } from "../../src/core/types";
import { briefButtons, cardStatus, goals, knownValues, nextThing, orderIncoming, runButton, sentBack, stageMark } from "../../src/web/derive";
import { EntryBuilder, card } from "../helpers/entries";

const stages: StageDef[] = [
  { id: "plan", title: "Plan", phase: "direction", runs: "agent", gate: "plan", reviews: false, model: null },
  { id: "checks", title: "Checks", phase: "analysis", runs: "script", gate: null, reviews: true, model: null },
  { id: "publish", title: "Publish", phase: "dissemination", runs: "human", gate: "publish", reviews: false, model: null },
];
const product: Product = {
  objective: "o", question: "q", marking: "TLP:AMBER", summary: "s", key_findings: [], gaps_and_limits: "", alternatives: "",
  assessment: "", sources: [], assumptions: [], change: "",
};
const draft = (n: number, hash: string): Draft => ({ n, hash, author: { kind: "system", id: "t" }, product, reason: "r" });
const step = (id: string, subgoal: string, free = true): PlanStep => ({
  id, subgoal, pivot: "ip", source: "src", from: { type: "ip", value: "192.0.2.10" }, to: "domain", window: { from: null, to: null },
  needs_window: false, free, weight: 1, estimate: null, empty_means: "not-seen", warnings: [],
});
const plan = (steps: PlanStep[]): Plan => ({
  id: "plan-1", goal: "g", window: { from: null, to: null },
  subgoals: [{ id: "g1", title: "A", question: "QA", steps: steps.filter((s) => s.subgoal === "g1").map((s) => s.id) }, { id: "g2", title: "B", question: "QB", steps: steps.filter((s) => s.subgoal === "g2").map((s) => s.id) }],
  steps,
});
const base = (): EntryBuilder => {
  const b = new EntryBuilder();
  b.add("case.created", { id: "CASE-1", title: "T", asked: "A", why: "w", starting: [{ type: "ip", value: "192.0.2.1" }], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN" });
  return b;
};
const withCards = (cards: Card[]): CaseState => {
  const b = base();
  for (const c of cards) b.add("card.created", { card: c });
  return fold(b.entries);
};
const cs = (over: Partial<Card>): CardState => withCards([card("c1", over)]).cards.c1!;

test("partial coverage is never a proven negative", () => {
  expect(cardStatus(cs({ row_count: 0, empty: "proven-negative", coverage: { kind: "partial", reason: "timeout" } }))).toBe("partial");
  expect(cardStatus(cs({ row_count: 0, empty: "proven-negative", coverage: { kind: "full" } }))).toBe("proven negative");
  expect(cardStatus(cs({ row_count: 0, empty: "not-seen", coverage: { kind: "full" } }))).toBe("nothing found");
  expect(cardStatus(cs({ row_count: 3, empty: null, coverage: { kind: "full" } }))).toBe("answered");
});

test("pinned cards stay on top, and reverse flips the rest", () => {
  const b = base();
  for (const id of ["c1", "c2", "c3", "c4"]) b.add("card.created", { card: card(id) });
  b.add("card.pinned", { card: "c3", pinned: true });
  const s = fold(b.entries);
  const flat = (v: Parameters<typeof orderIncoming>[1]): string[] => orderIncoming(s, v).flatMap((g) => g.cards);
  expect(flat({ sort: "arrived", reverse: false, group: "none" })).toEqual(["c3", "c1", "c2", "c4"]);
  expect(flat({ sort: "arrived", reverse: true, group: "none" })).toEqual(["c3", "c4", "c2", "c1"]);
});

test("sorting by event time puts cards with none last", () => {
  const s = withCards([card("c1", { event_time: null }), card("c2", { event_time: "2026-01-02T00:00:00.000Z" }), card("c3", { event_time: "2026-01-01T00:00:00.000Z" })]);
  expect(orderIncoming(s, { sort: "event_time", reverse: false, group: "none" })[0]!.cards).toEqual(["c3", "c2", "c1"]);
});

test("grouping by source keeps groups in order of their first card", () => {
  const s = withCards([card("c1", { source: "b" }), card("c2", { source: "a" }), card("c3", { source: "b" })]);
  expect(orderIncoming(s, { sort: "arrived", reverse: false, group: "source" })).toEqual([{ group: "b", cards: ["c1", "c3"] }, { group: "a", cards: ["c2"] }]);
});

test("started by is the query's actor, else the maker", () => {
  const b = base();
  b.add("query.issued", { query: "q1", source: "s", source_hash: "h", pivot: null, pivot_hash: null, connector: "c", text: "t", bound: {}, window: { from: null, to: null }, why: "w", estimate: null, step: null, verifies: null, purpose: "result" }, { actor: { kind: "human", id: "ana" } });
  b.add("card.created", { card: card("c1", { query: "q1", made_by: "agent" }) });
  b.add("card.created", { card: card("c2", { query: null, made_by: "system" }) });
  expect(orderIncoming(fold(b.entries), { sort: "arrived", reverse: false, group: "started_by" }).map((g) => g.group)).toEqual(["ana", "system"]);
});

test("known values are the starting values and the typed cells of kept cards", () => {
  const b = base();
  b.add("lane.created", { lane: "l1", title: "K", subgoal: null });
  b.add("card.created", { card: card("c1", { columns: ["ip", "n"], column_types: ["ip", null], rows: [["192.0.2.5", "x"]] }) });
  b.add("card.created", { card: card("c2", { columns: ["ip"], column_types: ["ip"], rows: [["192.0.2.6"]] }) });
  b.add("card.kept", { card: "c1", lane: "l1", index: null });
  const known = knownValues(fold(b.entries));
  expect([...known].sort()).toEqual(["ip|192.0.2.1", "ip|192.0.2.5"]);
});

test("goals counts a proven negative as answered and a blocked sub-goal as not", () => {
  const b = base();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  b.add("plan.proposed", { plan: plan([step("s1", "g1"), step("s2", "g2")]) });
  b.add("plan.accepted", { plan: "plan-1", steps: ["s1", "s2"], budgets: {} });
  b.add("card.created", { card: card("c1", { row_count: 0, rows: [], empty: "proven-negative", coverage: { kind: "full" } }) });
  b.add("step.finished", { step: "s1", outcome: "empty", cards: ["c1"], note: "" });
  b.add("step.finished", { step: "s2", outcome: "blocked", cards: [], note: "" });
  expect(goals(fold(b.entries))).toEqual({ done: 1, of: 2 });
});

test("a review stage that passed an older draft reads passed earlier draft", () => {
  const b = base();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  b.add("draft.revised", { draft: draft(1, "h1") });
  b.add("stage.finished", { stage: "checks", attempt: 1, outcome: "pass", draft_hash: "h1", output: null, reason: null });
  let s = fold(b.entries);
  expect(stageMark(s, s.run.stages[1]!)).toBe("passed");
  b.add("draft.revised", { draft: draft(2, "h2") });
  s = fold(b.entries);
  expect(stageMark(s, s.run.stages[1]!)).toBe("passed earlier draft");
  expect(stageMark(s, s.run.stages[0]!)).toBe("idle");
});

function gate(which: "plan" | "publish" | "paused" | "interrupted" | "running" | "none", opts: { costly?: boolean; blocked?: boolean } = {}): CaseState {
  const b = base();
  if (which === "none") return fold(b.entries);
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  const steps = [step("s1", "g1"), step("s2", "g1"), step("s3", "g2", opts.costly !== true)];
  b.add("plan.proposed", { plan: plan(steps) });
  if (which === "plan") b.add("gate.waiting", { gate: "plan" });
  if (which === "publish") {
    b.add("draft.revised", { draft: draft(2, "h2") });
    if (opts.blocked !== true) b.add("stage.finished", { stage: "checks", attempt: 1, outcome: "pass", draft_hash: "h2", output: null, reason: null });
    b.add("gate.waiting", { gate: "publish" });
  }
  if (which === "paused") b.add("run.paused", { reason: "because" });
  if (which === "interrupted") b.add("run.interrupted", {});
  return fold(b.entries);
}

test.each([
  ["no run", () => gate("none"), null],
  ["plan gate, free steps only", () => gate("plan"), { label: "Review the plan", command: "accept_plan" }],
  ["plan gate, one costly step", () => gate("plan", { costly: true }), { label: "Review plan: 1 steps need a budget", lens: "steps" }],
  ["publish gate, publishable", () => gate("publish"), { label: "Review the draft", command: "approve" }],
  ["publish gate, one blocker", () => gate("publish", { blocked: true }), { label: "Review draft: 1 blockers", lens: "narrative" }],
  ["paused", () => gate("paused"), { label: "Resume the run", command: "resume" }],
  ["interrupted", () => gate("interrupted"), { label: "Resume the run", command: "resume" }],
  ["running", () => gate("running"), null],
])("the next thing: %s", (_name, make, want) => {
  expect(nextThing(make())).toEqual(want as never);
});

test("the run button follows the run", () => {
  expect(runButton(gate("none"))).toEqual({ label: "Run", command: "start_run", lens: null, disabled: false });
  expect(runButton(gate("running"))).toEqual({ label: "Running", command: null, lens: null, disabled: true });
  expect(runButton(gate("paused"))).toEqual({ label: "Resume", command: "resume", lens: null, disabled: false });
  expect(runButton(gate("interrupted")).command).toBe("resume");
  expect(runButton(gate("plan"))).toEqual({ label: "Review plan", command: null, lens: "steps", disabled: false });
  expect(runButton(gate("publish"))).toEqual({ label: "Review draft", command: null, lens: "narrative", disabled: false });
  const b = base();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  b.add("run.finished", { outcome: "stopped" });
  expect(runButton(fold(b.entries))).toEqual({ label: "Run again", command: "start_run", lens: null, disabled: false });
});

test("while reviewers disagree, the run button opens the Narrative to settle it instead of resuming", () => {
  const s = gate("paused");
  const withConflict = { ...s, conflicts: { k1: { id: "k1", run: s.run.id, seq: 1, finding: "f1", ruling: null } } } as never;
  expect(runButton(withConflict)).toEqual({ label: "Settle the disagreement", command: null, lens: "narrative", disabled: false });
  expect(nextThing(withConflict)).toEqual({ label: "Settle the disagreement", lens: "narrative" });
  const ruled = { ...s, conflicts: { k1: { id: "k1", run: s.run.id, seq: 1, finding: "f1", ruling: { follow: "evaluate" } } } } as never;
  expect(runButton(ruled).command).toBe("resume");
});

const authored = (n: number, hash: string, author: Draft["author"]): Draft => ({ ...draft(n, hash), author });
const analyst = { kind: "agent", id: "analyst", stage: "assemble", profile: "investigation", model: "m", effort: null, where: "machine" } as const;
const reviewed: StageDef[] = [
  { id: "assemble", title: "Assemble", phase: "analysis", runs: "agent", gate: null, reviews: false, model: null },
  { id: "checks", title: "Checks", phase: "analysis", runs: "script", gate: null, reviews: true, model: null },
  { id: "publish", title: "Publish", phase: "dissemination", runs: "human", gate: "publish", reviews: false, model: null },
];
/** A run whose stage Assemble wrote draft 3, with Checks's outcome on it; `by` is who wrote the draft. */
function afterReview(outcome: "pass" | "fail", by: Draft["author"] = analyst): EntryBuilder {
  const b = base();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages: reviewed });
  b.add("stage.started", { stage: "assemble", attempt: 1 });
  b.add("draft.revised", { draft: authored(3, "h3", by) });
  b.add("stage.finished", { stage: "assemble", attempt: 1, outcome: "pass", draft_hash: "h3", output: null, reason: null });
  b.add("stage.started", { stage: "checks", attempt: 1 });
  b.add("stage.finished", { stage: "checks", attempt: 1, outcome, draft_hash: "h3", output: null, reason: outcome === "fail" ? "a check failed" : null });
  return b;
}
const stageOf = (s: CaseState, id: string): CaseState["run"]["stages"][number] => s.run.stages.find((x) => x.id === id)!;

test("the stage that wrote the latest draft reads 'sent back' once a review stage has failed it", () => {
  const b = afterReview("fail");
  b.add("run.paused", { reason: "the send-back cap" });
  const s = fold(b.entries);
  expect(stageMark(s, stageOf(s, "assemble"))).toBe("sent back");
  expect(sentBack(s, stageOf(s, "assemble"))).toEqual({ draft: 3, by: "Checks" });
  expect(sentBack(s, stageOf(s, "checks"))).toBeNull();
  // sent back to it: the stage that did it is named from the send-back
  b.add("stage.sent_back", { from: "checks", to: "assemble", reason: "a check failed", count: 1 });
  const back = fold(b.entries);
  expect(stageOf(back, "assemble").status).toBe("idle");
  expect(sentBack(back, stageOf(back, "assemble"))).toEqual({ draft: 3, by: "Checks" });
  expect(stageMark(back, stageOf(back, "assemble"))).toBe("sent back");
});

test("it reads running again as soon as it starts again, and passed when no review stage has failed the draft", () => {
  const b = afterReview("fail");
  b.add("stage.started", { stage: "assemble", attempt: 2 });
  const running = fold(b.entries);
  expect(stageMark(running, stageOf(running, "assemble"))).toBe("running");
  expect(sentBack(running, stageOf(running, "assemble"))).toBeNull();
  const ok = fold(afterReview("pass").entries);
  expect(stageMark(ok, stageOf(ok, "assemble"))).toBe("passed");
  expect(sentBack(ok, stageOf(ok, "assemble"))).toBeNull();
});

test("a new draft that no reviewer has failed does not read sent back by the reviewer that failed the draft before it", () => {
  // final review I4: Evaluate failed draft 3 and sent it back; Assemble wrote draft 4, and Checks is reviewing it
  const three: StageDef[] = [...reviewed.slice(0, 2), { id: "evaluate", title: "Evaluate", phase: "analysis", runs: "agent", gate: null, reviews: true, model: null }, reviewed[2]!];
  const b = base();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages: three });
  b.add("stage.started", { stage: "assemble", attempt: 1 });
  b.add("draft.revised", { draft: authored(3, "h3", analyst) });
  b.add("stage.finished", { stage: "assemble", attempt: 1, outcome: "pass", draft_hash: "h3", output: null, reason: null });
  b.add("stage.started", { stage: "checks", attempt: 1 });
  b.add("stage.finished", { stage: "checks", attempt: 1, outcome: "pass", draft_hash: "h3", output: null, reason: null });
  b.add("stage.started", { stage: "evaluate", attempt: 1 });
  b.add("stage.finished", { stage: "evaluate", attempt: 1, outcome: "fail", draft_hash: "h3", output: null, reason: "weak" });
  // before the send-back is written, draft 3 reads sent back by Evaluate
  const failed = fold(b.entries);
  expect(sentBack(failed, stageOf(failed, "assemble"))).toEqual({ draft: 3, by: "Evaluate" });
  b.add("stage.sent_back", { from: "evaluate", to: "assemble", reason: "weak", count: 1 });
  b.add("stage.started", { stage: "assemble", attempt: 2 });
  b.add("draft.revised", { draft: authored(4, "h4", analyst) });
  b.add("stage.finished", { stage: "assemble", attempt: 2, outcome: "pass", draft_hash: "h4", output: null, reason: null });
  b.add("stage.started", { stage: "checks", attempt: 2 });
  const s = fold(b.entries);
  expect(s.skipped).toEqual([]);
  expect(stageOf(s, "evaluate").status).toBe("failed");
  expect(sentBack(s, stageOf(s, "assemble"))).toBeNull();
  expect(stageMark(s, stageOf(s, "assemble"))).toBe("passed");
  // once Evaluate fails draft 4 as well, it reads sent back again
  b.add("stage.finished", { stage: "checks", attempt: 2, outcome: "pass", draft_hash: "h4", output: null, reason: null });
  b.add("stage.started", { stage: "evaluate", attempt: 2 });
  b.add("stage.finished", { stage: "evaluate", attempt: 2, outcome: "fail", draft_hash: "h4", output: null, reason: "still weak" });
  const again = fold(b.entries);
  expect(sentBack(again, stageOf(again, "assemble"))).toEqual({ draft: 4, by: "Evaluate" });
});

test("a draft a person wrote marks no stage as sent back", () => {
  const s = fold(afterReview("fail", { kind: "human", id: "pat" }).entries);
  for (const st of s.run.stages) expect(sentBack(s, st)).toBeNull();
});

test("the brief never offers two buttons with one label or one command, in any run state", () => {
  const conflict = (s: CaseState): CaseState => ({ ...s, conflicts: { k1: { id: "k1", run: s.run.id, seq: 1, finding: "f1", ruling: null } } } as never);
  const done = (() => { const b = base(); b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages }); b.add("run.finished", { outcome: "stopped" }); return fold(b.entries); })();
  const EVERY_RUN_STATE: CaseState[] = [
    gate("none"), gate("running"), gate("paused"), conflict(gate("paused")), conflict(gate("interrupted")), gate("interrupted"),
    gate("plan"), gate("plan", { costly: true }), gate("publish"), gate("publish", { blocked: true }), done,
  ];
  for (const state of EVERY_RUN_STATE) {
    const { run, next } = briefButtons(state);
    if (run === null || next === null) continue;
    expect(next.label).not.toBe(run.label);
    expect("command" in next ? next.command : null).not.toBe(run.command ?? undefined);
  }
  // at a gate the next-thing button stands for the run button; a resume is the run button's alone
  expect(briefButtons(gate("plan"))).toEqual({ run: null, next: nextThing(gate("plan")) });
  expect(briefButtons(gate("paused"))).toEqual({ run: runButton(gate("paused")), next: null });
  expect(briefButtons(conflict(gate("paused")))).toEqual({ run: runButton(conflict(gate("paused"))), next: null });
});

test("a statement by the person is a statement, never 'nothing found'", () => {
  // the fold takes a statement only from a human actor, so the state is made from a plain card and the person field is put on it
  const statementCard: CardState = { ...cs({ kind: "note", made_by: "human", columns: [], column_types: [], rows: [], row_count: 0, coverage: null, empty: null }), person: { basis: "did", detail: "", about: [], answers: null } };
  expect(cardStatus(statementCard)).toBe("statement");
  // a person's card is a statement before any other test, even one with partial coverage
  expect(cardStatus({ ...statementCard, coverage: { kind: "partial", reason: "timeout" } })).toBe("statement");
});
