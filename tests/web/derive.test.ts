import { expect, test } from "bun:test";
import { fold } from "../../src/core/state";
import type { CaseState, CardState } from "../../src/core/state";
import type { Card, Draft, Plan, PlanStep, Product, StageDef } from "../../src/core/types";
import { cardStatus, goals, knownValues, nextThing, orderIncoming, runButton, stageMark } from "../../src/web/derive";
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
