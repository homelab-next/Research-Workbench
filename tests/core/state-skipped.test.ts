import { expect, test } from "bun:test";
import { apply, fold } from "../../src/core/state";
import type { Coverage, Draft, Entry, Plan, Product, StageDef } from "../../src/core/types";
import { card, EntryBuilder } from "../helpers/entries";

const stages: StageDef[] = [
  { id: "plan", title: "Plan", phase: "plan", runs: "agent", gate: "plan", reviews: false, model: null },
  { id: "checks", title: "Checks", phase: "review", runs: "script", gate: null, reviews: true, model: null },
];
const product: Product = {
  objective: "o", question: "q", marking: "TLP:AMBER", summary: "s", key_findings: [], gaps_and_limits: "", alternatives: "",
  assessment: "", sources: [], assumptions: [], change: "",
};
const draft = (hash: string, over: Partial<Product> = {}): Draft => ({ n: 1, hash, author: { kind: "system", id: "test" }, product: { ...product, ...over }, reason: "r" });

function started(): EntryBuilder {
  const b = new EntryBuilder();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  return b;
}
const last = (b: EntryBuilder): Entry => b.entries[b.entries.length - 1]!;

test("a draft with a malformed product is recorded as skipped, not silently dropped", () => {
  const b = started();
  b.add("draft.revised", { draft: draft("h1", { marking: "secret" as never }) });
  const s = fold(b.entries);
  expect(s.drafts).toEqual([]);
  expect(s.skipped).toEqual([{ seq: last(b).seq, type: "draft.revised", reason: "malformed draft.revised" }]);
});

test("a plan.proposed with a malformed plan is recorded as skipped", () => {
  const b = started();
  b.add("plan.proposed", { plan: { id: "plan-1", goal: "g", window: { from: null, to: null }, subgoals: [], steps: [{ id: "s1" }] } as unknown as Plan });
  const s = fold(b.entries);
  expect(s.plan.current).toBeNull();
  expect(s.skipped).toEqual([{ seq: last(b).seq, type: "plan.proposed", reason: "malformed plan.proposed" }]);
});

test("query.result coverage is checked as strictly as a plan", () => {
  const bad: unknown[] = [{ kind: "partial" }, { kind: "nothing" }, { kind: "partial", reason: "bored" }, { kind: "partial", reason: "timeout", detail: 5 }, {}, null];
  for (const coverage of bad) {
    const b = started();
    b.add("query.issued", {
      query: "q1", source: "dns", source_hash: "h", pivot: null, pivot_hash: null, connector: "c", text: "t", bound: {},
      window: { from: null, to: null }, why: "w", estimate: null, step: null, verifies: null, purpose: "result",
    });
    b.add("query.result", { query: "q1", result: { blob: "b", bytes: 1 }, rows: 1, rows_hash: "h", coverage: coverage as Coverage, duration_ms: 1, cost: null });
    const s = fold(b.entries);
    expect(s.queries.q1!.status, JSON.stringify(coverage)).toBe("running");
    expect(s.skipped, JSON.stringify(coverage)).toEqual([{ seq: last(b).seq, type: "query.result", reason: "malformed query.result" }]);
  }
  const ok = started();
  ok.add("query.issued", {
    query: "q1", source: "dns", source_hash: "h", pivot: null, pivot_hash: null, connector: "c", text: "t", bound: {},
    window: { from: null, to: null }, why: "w", estimate: null, step: null, verifies: null, purpose: "result",
  });
  ok.add("query.result", { query: "q1", result: { blob: "b", bytes: 1 }, rows: 1, rows_hash: "h", coverage: { kind: "partial", reason: "row_limit" }, duration_ms: 1, cost: null });
  expect(fold(ok.entries).queries.q1!.status).toBe("done");
});

test("a well-formed entry that names something missing changes nothing and is not recorded", () => {
  const b = started();
  b.add("card.kept", { card: "c9", lane: "l9", index: null });
  b.add("check.run", { check: "c", script_hash: "x", input: { blob: "b", bytes: 1 }, output: { blob: "b", bytes: 1 }, draft_hash: "zz", pass: true, findings: [] });
  b.add("step.started", { step: "s9" });
  b.add("proposal.accepted", { proposal: "p9", budget: null });
  b.add("challenge.answered", { challenge: "x9", answer: "a", action: "revised" });
  expect(fold(b.entries).skipped).toEqual([]);
});

test("an entry two reducers refuse is recorded once", () => {
  const b = started();
  b.add("stage.finished", { stage: "checks", attempt: 1, outcome: "pass", draft_hash: "h1", output: null } as never);
  b.add("card.created", { card: { ...card("c1"), marking: undefined } as never });
  const s = fold(b.entries);
  expect(s.skipped).toEqual([
    { seq: 2, type: "stage.finished", reason: "malformed stage.finished" },
    { seq: 3, type: "card.created", reason: "malformed card.created" },
  ]);
});

test("apply records a shape rejection without touching anything else", () => {
  const base = fold(started().entries);
  const e = { ...last(started()), seq: 2, type: "lane.created", payload: { lane: 5, title: "t", subgoal: null } } as unknown as Entry;
  const out = apply(base, e);
  // counters count creating entries by kind, so the lane counter still moves (the allocator depends on it)
  expect(out).toEqual({
    ...base, seq: 2, head_ts: e.ts, counters: { ...base.counters, lane: 1 },
    skipped: [{ seq: 2, type: "lane.created", reason: "malformed lane.created" }],
  });
});

test("a malformed memory.noted is recorded and still moves the memory counter, as a malformed lane does", () => {
  const base = fold(started().entries);
  const e = { ...last(started()), seq: 2, type: "memory.noted", payload: { item: "m1", kind: "rule", text: "t", cards: [] } } as unknown as Entry;
  expect(apply(base, e)).toEqual({
    ...base, seq: 2, head_ts: e.ts, counters: { ...base.counters, memory: 1 },
    skipped: [{ seq: 2, type: "memory.noted", reason: "malformed memory.noted" }],
  });
});

test("a malformed entry of the improve loop is recorded and changes nothing else, as a malformed note does", () => {
  const base = fold(started().entries);
  for (const [type, payload] of [
    ["answer.known", { product: 1, draft_hash: "d", text: "", findings: [], marking: "TLP:AMBER" }],
    ["improve.selected", { target: "investigation" }],
    ["probe.finished", { probe: "base/T1", outcome: "drafted", draft_hash: null }],
    ["judge.scored", { answers: null, scores: null, matcher: "model", summary: [] }],
  ] as const) {
    const e = { ...last(started()), seq: 2, type, payload } as unknown as Entry;
    expect(apply(base, e)).toEqual({ ...base, seq: 2, head_ts: e.ts, skipped: [{ seq: 2, type, reason: `malformed ${type}` }] });
  }
});
