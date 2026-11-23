// Final review, finding 24 (recommendation C): one realistic run through cards, run and analysis,
// written through a real workbench, with the live state compared against replay at every entry.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { IdAllocator } from "../../src/core/ids";
import type { CaseSession } from "../../src/core/session";
import { blockers, fold, latestDraft, publishable, runUsage } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Actor, Draft, EntryInput, Plan, Product, StageDef } from "../../src/core/types";
import { verifyCase } from "../../src/core/verify";
import { Workbench } from "../../src/core/workbench";
import { card } from "../helpers/entries";

const human: Actor = { kind: "human", id: "analyst" };
const system: Actor = { kind: "system", id: "engine" };
const planner: Actor = { kind: "agent", id: "planner", stage: "plan", profile: "default", model: "scripted-m", effort: null, where: "machine" };

const stages: StageDef[] = [
  { id: "plan", title: "Plan", phase: "direct", runs: "agent", gate: "plan", reviews: false, model: null },
  { id: "collect", title: "Collect", phase: "collect", runs: "script", gate: null, reviews: false, model: null },
  { id: "assemble", title: "Assemble", phase: "produce", runs: "agent", gate: null, reviews: false, model: null },
  { id: "checks", title: "Checks", phase: "review", runs: "script", gate: null, reviews: true, model: null },
  { id: "evaluate", title: "Evaluate", phase: "review", runs: "agent", gate: null, reviews: true, model: null },
  { id: "challenge", title: "Challenge", phase: "review", runs: "agent", gate: null, reviews: true, model: null },
  { id: "publish", title: "Publish", phase: "publish", runs: "human", gate: "publish", reviews: false, model: null },
];

const baseProduct: Product = {
  objective: "Decide whether 192.0.2.10 is beaconing", question: "Is 192.0.2.10 beaconing to 198.51.100.7?", marking: "TLP:AMBER",
  summary: "Regular connections every 60 s.", key_findings: [{
    id: "f1", statement: "192.0.2.10 connects to 198.51.100.7 every 60 s", likelihood: "likely", confidence: "moderate",
    confidence_basis: "one source", cites: ["c1"], assumptions: [], reasoning: "periodic",
  }],
  gaps_and_limits: "One day of data.", alternatives: "A health check.", assessment: "Likely beaconing.",
  sources: [{ source: "netflow", quality: "good" }], assumptions: [], change: "",
};
const draftOf = (n: number, product: Product, reason: string): Draft => ({ n, hash: sha256Hex(canonical(product as never)), author: planner, product, reason });

let dir: string;
let wb: Workbench;
let tick = 0;
const errors: unknown[] = [];
const onError = (e: unknown) => void errors.push(e);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "whole-run-"));
  tick = 0;
  errors.length = 0;
  wb = Workbench.open(dir, { now: () => new Date(Date.UTC(2026, 10, 23, 20, 0, 0, tick++ * 37)).toISOString(), onError });
});
afterEach(() => {
  wb.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a whole run, live, equals its replay at every entry", () => {
  const s: CaseSession = wb.createCase({
    title: "Beaconing from 192.0.2.10", asked: "Is it beaconing?", why: "IDS alert", starting: [{ type: "ip", value: "192.0.2.10" }],
    window: { from: "2026-11-22T00:00:00.000Z", to: "2026-11-23T00:00:00.000Z" }, objective: "Decide", marking: "TLP:AMBER",
  }, human);
  const live: CaseState[] = [];
  live[1] = structuredClone(s.state);
  s.subscribe((_e, st) => { live[st.seq] = structuredClone(st); });
  const commit = (build: (st: Readonly<CaseState>, ids: IdAllocator) => EntryInput[]) => s.commit(build);
  const one = (input: EntryInput) => commit(() => [input]);
  const stage = (id: string, outcome: "pass" | "fail", draft_hash: string | null, output = null) =>
    one({ type: "stage.finished", payload: { stage: id, attempt: 1, outcome, draft_hash, output, reason: null }, actor: system, stage: id });
  const start = (id: string, attempt = 1) => one({ type: "stage.started", payload: { stage: id, attempt }, actor: system, stage: id });

  // ---- before the run
  one({ type: "stage.model_set", payload: { stage: "plan", choice: { provider: "scripted", model: "scripted-m", effort: null } }, actor: human });
  one({ type: "budget.set", payload: { tokens: 5000 }, actor: human });
  one({ type: "model.response", payload: { request: "r0", response: s.blobs.put("pre-run"), stop: "end", usage: { input: 5, output: 5, reasoning: 0 }, served_by: "m", reasoning: null }, actor: system });
  const [started] = commit((_st, ids) => [{ type: "run.started", payload: { run: ids.next("run"), pipeline: "investigate", pipeline_hash: "a".repeat(64), stages }, actor: system }]);
  const run = (started!.payload as { run: string }).run;

  // ---- plan, with a pause across the plan gate
  start("plan");
  commit((_st, ids) => {
    const job = ids.next("job"), request = ids.next("request");
    return [
      { type: "job.started", payload: { job, title: "Plan", kind: "model", source: null }, actor: system, job },
      { type: "model.request", payload: { request, provider: "scripted", model: "scripted-m", effort: null, where: "machine", marking: "TLP:AMBER", pack: [], left_out: [], messages: s.blobs.put("plan prompt"), tools: [] }, actor: planner, job },
    ];
  });
  one({ type: "model.response", payload: { request: "r1", response: s.blobs.put("plan text"), stop: "end", usage: { input: 100, output: 40, reasoning: 10 }, served_by: "scripted-m", reasoning: s.blobs.put("why") }, actor: planner });
  const [proposed] = commit((_st, ids) => {
    const id = ids.next("plan");
    const plan: Plan = {
      id, goal: "Establish periodicity", window: { from: null, to: null },
      subgoals: [{ id: "g1", title: "Flows", question: "Are there periodic flows?", steps: ["s1"] }],
      steps: [{
        id: "s1", subgoal: "g1", pivot: "ip", source: "netflow", from: { type: "ip", value: "192.0.2.10" }, to: "flows", window: { from: null, to: null },
        needs_window: true, free: true, weight: 1, estimate: null, empty_means: "not-seen", warnings: [],
      }],
    };
    return [{ type: "plan.proposed", payload: { plan }, actor: planner }];
  });
  const planId = (proposed!.payload as { plan: Plan }).plan.id;
  stage("plan", "pass", null);
  one({ type: "job.finished", payload: { job: "j1", outcome: "done" }, actor: system });
  one({ type: "run.paused", payload: { reason: "coffee" }, actor: human });
  one({ type: "gate.waiting", payload: { gate: "plan" }, actor: system });
  one({ type: "plan.accepted", payload: { plan: planId, steps: ["s1"], budgets: { netflow: 10 } }, actor: human });
  one({ type: "gate.passed", payload: { gate: "plan" }, actor: human });
  expect(s.state.run).toMatchObject({ status: "paused", waiting: null });
  one({ type: "run.resumed", payload: {}, actor: human });
  expect(s.state.run.status).toBe("running");

  // ---- collect: a query, a result card, a lane, a costly proposal, re-validation, undo
  start("collect");
  one({ type: "step.started", payload: { step: "s1" }, actor: system });
  const [issued] = commit((_st, ids) => {
    const query = ids.next("query");
    return [{
      type: "query.issued",
      payload: {
        query, source: "netflow", source_hash: "b".repeat(64), pivot: "ip", pivot_hash: "c".repeat(64), connector: "scripted", text: "flows from 192.0.2.10",
        bound: { ip: "192.0.2.10" }, window: { from: null, to: null }, why: "periodicity", estimate: { amount: 1, unit: "query" }, step: "s1", verifies: null,
      },
      actor: system,
    }];
  });
  const q1 = (issued!.payload as { query: string }).query;
  const rows = s.blobs.put(JSON.stringify([["198.51.100.7", 60]]), "application/json");
  commit((_st, ids) => [
    { type: "query.result", payload: { query: q1, result: rows, rows: 1440, rows_hash: "d".repeat(64), coverage: { kind: "partial", reason: "row_limit", detail: "first 50 rows" }, duration_ms: 12, cost: null }, actor: system },
    { type: "card.created", payload: { card: card(ids.next("card"), { query: q1, rows: [["198.51.100.7", 60]], columns: ["dst", "interval"], column_types: ["ip", "int"], coverage: { kind: "partial", reason: "row_limit" }, row_count: 1440, step: "s1", subgoal: "g1" }) }, actor: system },
    { type: "lane.created", payload: { lane: ids.next("lane"), title: "Periodic flows", subgoal: "g1" }, actor: human },
  ]);
  one({ type: "card.kept", payload: { card: "c1", lane: "l1", index: null }, actor: human });
  commit((_st, ids) => [{ type: "card.created", payload: { card: card(ids.next("card"), { kind: "note", made_by: "human", why: "aside" }) }, actor: human }]);
  one({ type: "card.discarded", payload: { card: "c2" }, actor: human });
  const undo = s.state.undoable.at(-1)!;
  one({ type: "undo", payload: { target: undo.seq, card: undo.card, place: undo.place, lane: undo.lane, index: undo.index }, actor: human });
  one({ type: "card.pinned", payload: { card: "c1", pinned: true }, actor: human });
  commit((_st, ids) => [{ type: "proposal.created", payload: { proposal: { id: ids.next("proposal"), kind: "costly_query", title: "Pull a week", by: "planner", step: "s1", source: "netflow", text: "7 days", estimate: { amount: 3, unit: "credits" }, why: "confirm" } }, actor: planner }]);
  one({ type: "proposal.accepted", payload: { proposal: "p1", budget: 3 }, actor: human });
  const [rerun] = commit((_st, ids) => [{ type: "query.issued", payload: { query: ids.next("query"), source: "netflow", source_hash: "b".repeat(64), pivot: null, pivot_hash: null, connector: "scripted", text: "again", bound: {}, window: { from: null, to: null }, why: "re-validate", estimate: null, step: null, verifies: "c1" }, actor: system }]);
  const q2 = (rerun!.payload as { query: string }).query;
  one({ type: "query.failed", payload: { query: q2, error: "timeout" }, actor: system });
  one({ type: "verify.run", payload: { original: q1, rerun: q2, card: "c1", outcome: "could_not_run", detail: "timeout" }, actor: system });
  one({ type: "step.finished", payload: { step: "s1", outcome: "partial", cards: ["c1"], note: "row limit" }, actor: system });
  stage("collect", "pass", null);
  one({ type: "case.phase_changed", payload: { phase: "produce" }, actor: system });

  // ---- assemble and review draft 1
  start("assemble");
  const d1 = draftOf(1, baseProduct, "first");
  one({ type: "draft.revised", payload: { draft: d1 }, actor: planner });
  stage("assemble", "pass", d1.hash);
  start("checks");
  one({ type: "check.run", payload: { check: "citations", script_hash: "e".repeat(64), input: s.blobs.put(canonical(baseProduct as never)), draft_hash: d1.hash, pass: true, findings: [] }, actor: system });
  stage("checks", "pass", d1.hash);
  start("evaluate");
  one({ type: "evaluation.made", payload: { draft_hash: d1.hash, pass: true, findings: [] }, actor: planner });
  stage("evaluate", "pass", d1.hash);
  start("challenge");
  commit((_st, ids) => [{ type: "challenge.raised", payload: { challenge: { id: ids.next("challenge"), draft_hash: d1.hash, severity: "must_address", text: "Could be NTP", cites: ["c1"] } }, actor: planner }]);
  stage("challenge", "pass", d1.hash);
  expect(blockers(s.state, d1.hash)).toEqual(["Challenge x1 must be addressed"]);
  one({ type: "challenge.answered", payload: { challenge: "x1", answer: "Port is 443, not 123", action: "rebutted" }, actor: planner });
  expect(publishable(s.state, d1.hash)).toBe(true);

  // ---- the person rejects; Assemble revises; review again
  one({ type: "gate.waiting", payload: { gate: "publish" }, actor: system });
  one({ type: "publish.rejected", payload: { draft_hash: d1.hash, reason: "Say what the interval is", stop: false }, actor: human });
  expect(publishable(s.state, d1.hash)).toBe(false);
  one({ type: "stage.sent_back", payload: { from: "publish", to: "assemble", reason: "rejected", count: 1 }, actor: system });
  start("assemble", 2);
  const d2 = draftOf(2, { ...baseProduct, summary: "Connections every 60 s (±1 s).", change: "interval stated" }, "rejected");
  one({ type: "draft.revised", payload: { draft: d2 }, actor: planner });
  expect(publishable(s.state, d1.hash)).toBe(false);
  for (const id of ["checks", "evaluate", "challenge"]) stage(id, "pass", d2.hash);
  expect(publishable(s.state, d2.hash)).toBe(true);
  one({ type: "gate.passed", payload: { gate: "publish" }, actor: human });
  const head = s.head().hash;
  one({ type: "product.published", payload: { n: 1, draft_hash: d2.hash, head_hash: head, dir: "published/1", bundle: s.blobs.put("bundle bytes") }, actor: human });
  one({ type: "run.finished", payload: { outcome: "published" }, actor: system });
  stage("challenge", "fail", d2.hash); // after the run: counts for nothing
  one({ type: "feedback.recorded", payload: { measure: "useful", kind: "moe", value: 4, note: "" }, actor: human });
  commit((_st, ids) => [{ type: "agent.asked", payload: { turn: ids.next("turn"), text: "Why moderate?", left_out: [], added: ["c1"] }, actor: human }]);
  one({ type: "agent.answered", payload: { turn: "u1", request: "r9", text: "One source.", cites: ["c1"] }, actor: planner });

  // ---- what the run left behind
  const final = s.state;
  expect(final.skipped).toEqual([]);
  expect(final.run).toMatchObject({ id: run, status: "finished", outcome: "published" });
  expect(final.run.stages.find((x) => x.id === "challenge")!.status).toBe("passed");
  expect(runUsage(final)).toEqual({ usage: { input: 100, output: 40, reasoning: 10 }, model_calls: 1 });
  expect(final.run.usage).toEqual({ input: 105, output: 45, reasoning: 10 });
  expect(latestDraft(final)!.hash).toBe(d2.hash);
  expect(final.reviews[d1.hash]!.rejected).toMatchObject({ reason: "Say what the interval is" });
  expect(final.published).toHaveLength(1);
  expect(final.queries[q1]).toMatchObject({ status: "done", card: "c1", coverage: { kind: "partial", reason: "row_limit" } });
  expect(final.cards.c1).toMatchObject({ pinned: true, place: "lane", validated: { outcome: "could_not_run" } });
  expect(final.incoming).toEqual(["c2"]);
  expect(final.conversation).toEqual([{ turn: "u1", asked: "Why moderate?", answer: "One source.", cites: ["c1"], request: "r9" }]);

  // ---- live equals replay at every entry
  const all = s.entries();
  expect(all.length).toBe(final.seq);
  for (let n = 1; n <= all.length; n++) {
    expect(live[n], `live state at ${n}`).toBeDefined();
    expect(fold(all, n), `entry ${n} (${all[n - 1]!.type})`).toEqual(live[n]!);
    expect(s.stateAt(n), `stateAt ${n}`).toEqual(live[n]!);
  }
  expect(fold(all)).toEqual(final);

  // ---- and after a restart, and under the verifier
  wb.close();
  wb = Workbench.open(dir, { onError });
  expect(wb.session(s.id).state).toEqual(final);
  const report = verifyCase(s.dir);
  expect(report).toMatchObject({ ok: true, entries: all.length, firstBad: null, blobs: { bad: [], lookalikes: 0 } });
  // pre-run response, plan prompt, plan text, its reasoning, the result rows, the check input, the bundle
  expect(report.blobs.referenced).toBe(7);
  expect(errors).toEqual([]);
});
