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
import { applyMemory, blockers, builderMarking, builderOpen, fold, initial, initialArchive, initialBuilder, initialLoop, initialMemory, latestDraft, publishable, REDUCERS, runUsage, unloadDue } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import { applyWith } from "../../src/core/state/apply";
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

/** The whole run of the first test, through the session, with the live state captured after every commit. */
function wholeRun(): { s: CaseSession; live: CaseState[]; run: string; q1: string; d1: Draft; d2: Draft } {
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
        bound: { ip: "192.0.2.10" }, window: { from: null, to: null }, why: "periodicity", estimate: { amount: 1, unit: "query" }, step: "s1", verifies: null, purpose: "result",
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
  commit((_st, ids) => [{ type: "proposal.created", payload: { proposal: { id: ids.next("proposal"), kind: "costly_query", title: "Pull a week", by: "planner", step: "s1", subgoal: null, source: "netflow", pivot: null, pivot_hash: null, source_hash: "sh1", text: "7 days", bound: {}, window: { from: null, to: null }, estimate: { amount: 3, unit: "credits" }, why: "confirm" } }, actor: planner }]);
  one({ type: "proposal.accepted", payload: { proposal: "p1", budget: 3 }, actor: human });
  const [rerun] = commit((_st, ids) => [{ type: "query.issued", payload: { query: ids.next("query"), source: "netflow", source_hash: "b".repeat(64), pivot: null, pivot_hash: null, connector: "scripted", text: "again", bound: {}, window: { from: null, to: null }, why: "re-validate", estimate: null, step: null, verifies: "c1", purpose: "verify" }, actor: system }]);
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
  one({ type: "check.run", payload: { check: "citations", script_hash: "e".repeat(64), input: s.blobs.put(canonical(baseProduct as never)), output: s.blobs.put("ok"), draft_hash: d1.hash, pass: true, findings: [] }, actor: system });
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
  return { s, live, run, q1, d1, d2 };
}

test("a whole run, live, equals its replay at every entry", () => {
  const { s, live, run, q1, d1, d2 } = wholeRun();

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
  expect(final.conversation).toEqual([{ turn: "u1", asked: "Why moderate?", answer: "One source.", cites: ["c1"], request: "r9", asked_seq: expect.any(Number), ended: null }]);

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
  // the chain and every blob are intact; the one published entry here names a stand-in blob, not a real bundle, which the published check says
  expect(report).toMatchObject({ entries: all.length, firstBad: null, blobs: { bad: [], lookalikes: 0 } });
  expect(report.published.bundles.map((b) => b.state)).toEqual(["bad_blob"]);
  // pre-run response, plan prompt, plan text, its reasoning, the result rows, the check input, the bundle
  expect(report.blobs.referenced).toBe(8);
  expect(errors).toEqual([]);
});

// ---------- slice 8: the person ----------

test("a ledger with none of slice 8's entries folds with no question, no overrule and no replaced ruling", () => {
  const { s } = wholeRun();
  const state = fold(s.entries());
  expect(state.questions).toEqual({});
  expect(state.overrules).toEqual({});
  expect(state.counters.question).toBe(0);
  expect(Object.values(state.conflicts).some((c) => "earlier_rulings" in c)).toBe(false);
  expect(state.skipped).toEqual([]);
  expect(errors).toEqual([]);
});

test("a ledger holding a statement, a question, its answer, an overrule and a revised ruling folds the same at every entry as the live session saw it", () => {
  const { s, live, d2 } = wholeRun();
  const one = (input: EntryInput) => s.commit(() => [input]);
  const researcher: Actor = { ...planner, id: "researcher-g1", stage: "collect" };
  const assembler: Actor = { ...planner, id: "assembler-g1", stage: "assemble" };
  const stage = (id: string, outcome: "pass" | "fail", draft_hash: string | null) =>
    one({ type: "stage.finished", payload: { stage: id, attempt: 1, outcome, draft_hash, output: null, reason: null }, actor: system, stage: id });
  const statement = (id: string, answers: string | null) => card(id, {
    kind: "note", made_by: "human", columns: [], column_types: [], rows: [], row_count: 0, coverage: null, title: "The TV",
    body: "It is the TV I installed in the lobby.", person: { basis: "did", detail: "installed it in March", about: [{ type: "ip", value: "192.0.2.10" }], answers },
  });

  s.commit((_st, ids) => [{ type: "run.started", payload: { run: ids.next("run"), pipeline: "investigate", pipeline_hash: "a".repeat(64), stages }, actor: system }]);
  // a statement the person volunteers
  s.commit((_st, ids) => [{ type: "card.created", payload: { card: statement(ids.next("card"), null) }, actor: human }]);
  // Collect asks, blocking; passes; the engine holds the run before the next stage; the person goes on without the answer
  one({ type: "stage.started", payload: { stage: "collect", attempt: 1 }, actor: system, stage: "collect" });
  s.commit((_st, ids) => [{ type: "question.asked", payload: { question: { id: ids.next("question"), text: "Is a TV expected on that access point?", why: "it would explain the name", cards: ["c1"], about: [{ type: "ip", value: "192.0.2.10" }], blocking: true } }, actor: researcher, stage: "collect" }]);
  stage("collect", "pass", null);
  one({ type: "run.paused", payload: { reason: "waiting for the person's answer to ask-1. Answer it in the Narrative lens, or resume to go on without it.", hold: { kind: "question", stage: "collect" } }, actor: system });
  one({ type: "run.resumed", payload: {}, actor: human });
  expect(s.state.questions["ask-1"]!.waived).toMatchObject({ by: "analyst" });
  // Assemble asks a second, not blocking; the person answers it with a statement
  one({ type: "stage.started", payload: { stage: "assemble", attempt: 1 }, actor: system, stage: "assemble" });
  s.commit((_st, ids) => [{ type: "question.asked", payload: { question: { id: ids.next("question"), text: "Who installed it?", why: "w", cards: [], about: [], blocking: false } }, actor: assembler, stage: "assemble" }]);
  s.commit((_st, ids) => {
    const c = ids.next("card");
    return [
      { type: "card.created", payload: { card: statement(c, "ask-2") }, actor: human },
      { type: "question.answered", payload: { question: "ask-2", card: c }, actor: human },
    ];
  });
  // a draft that moved f1, a conflict on it, a ruling, a revised ruling, and an overrule that takes its place
  const d3 = draftOf(3, { ...baseProduct, key_findings: [{ ...baseProduct.key_findings[0]!, likelihood: "almost certain" }] }, "for challenge");
  one({ type: "draft.revised", payload: { draft: d3 }, actor: assembler, stage: "assemble" });
  s.commit((_st, ids) => [{ type: "review.conflict", payload: { conflict: {
    id: ids.next("conflict"), draft_hash: d3.hash, finding: "f1", change: "likelihood", earlier: "likely", now: "almost certain", raised_by: "evaluate", changed_for: "challenge",
    asks: "likely", asked: "higher", points: ["f1: overstates it"], reason: "Evaluate and Challenge disagree on f1",
  } }, actor: system }]);
  one({ type: "review.ruled", payload: { conflict: "k1", follow: "evaluate", note: "" }, actor: human });
  one({ type: "review.ruled", payload: { conflict: "k1", follow: "challenge", note: "the TV is mine" }, actor: human });
  one({ type: "finding.overruled", payload: { finding: "f1", draft_hash: d3.hash, likelihood: "almost certain", confidence: "high", stays: null, note: "It is the TV I installed." }, actor: human });
  one({ type: "finding.overruled", payload: { finding: "f1", draft_hash: d3.hash, likelihood: "almost certain", confidence: null, stays: null, note: "It is the TV I installed." }, actor: human });

  const final = s.state;
  expect(final.skipped).toEqual([]);
  expect(final.counters.question).toBe(2);
  expect(final.questions["ask-2"]!.answer).toMatchObject({ card: "c4" });
  expect(final.cards.c3!.person).toMatchObject({ basis: "did", answers: null });
  expect(final.conflicts.k1!.earlier_rulings).toHaveLength(1);
  expect(final.overrules.f1).toMatchObject({ confidence: null, earlier: [{ confidence: "high" }] });
  expect(blockers(final, d3.hash)).not.toContain("The draft does not hold your overrule of f1 (likelihood almost certain)");
  expect(d2.hash).not.toBe(d3.hash);

  const all = s.entries();
  for (let n = 1; n <= all.length; n++) {
    expect(live[n], `live state at ${n}`).toBeDefined();
    expect(fold(all, n), `entry ${n} (${all[n - 1]!.type})`).toEqual(live[n]!);
  }
  wb.close();
  wb = Workbench.open(dir, { onError });
  expect(wb.session(s.id).state).toEqual(final);
  expect(verifyCase(s.dir)).toMatchObject({ entries: all.length, firstBad: null });
  expect(errors).toEqual([]);
});

// ---------- slice 11: unloads and loads ----------

test("a ledger with none of slice 11's entries folds with an empty archive", () => {
  const { s } = wholeRun();
  const state = fold(s.entries());
  expect(state.archive).toEqual(initialArchive());
  expect(state.skipped).toEqual([]);
  expect(errors).toEqual([]);
});

test("a ledger holding an unload, a failed unload, a second unload, a load and a pass with unload_after folds the same at every entry as the live session saw it", () => {
  const { s, live } = wholeRun();
  const one = (input: EntryInput) => s.commit(() => [input]);
  const code: Actor = { kind: "system", id: "workbench" };

  // a second run, passed at the publish gate with the box ticked
  s.commit((_st, ids) => [{ type: "run.started", payload: { run: ids.next("run"), pipeline: "investigate", pipeline_hash: "a".repeat(64), stages }, actor: system }]);
  one({ type: "stage.started", payload: { stage: "publish", attempt: 1 }, actor: system, stage: "publish" });
  one({ type: "gate.waiting", payload: { gate: "publish" }, actor: system });
  one({ type: "gate.passed", payload: { gate: "publish", unload_after: true }, actor: human });
  expect(s.state.archive.unload_after).toBe(true);
  one({ type: "run.finished", payload: { outcome: "published" }, actor: system });
  expect(unloadDue(s.state)).toBe(true);
  // the workbench unloads it, fails, the person unloads it again, and loads it back
  one({ type: "case.unloaded", payload: { store: "store", head: s.head() }, actor: code });
  one({ type: "case.unload_failed", payload: { reason: "the store folder is not there" }, actor: code });
  expect(unloadDue(s.state)).toBe(false);
  one({ type: "case.unloaded", payload: { store: "store", head: s.head() }, actor: human });
  const before = s.head();
  one({ type: "case.loaded", payload: { file: `${s.id}.TLP-AMBER.tar.gz`, head: before, id: s.id }, actor: human });

  const final = s.state;
  expect(final.skipped).toEqual([]);
  expect(final.archive).toMatchObject({ pending: null, failed: null, unload_after: false, unloads: 2, loads: 1, loaded: { head: before, id: s.id, by: "analyst" } });

  const all = s.entries();
  for (let n = 1; n <= all.length; n++) {
    expect(live[n], `live state at ${n}`).toBeDefined();
    expect(fold(all, n), `entry ${n} (${all[n - 1]!.type})`).toEqual(live[n]!);
  }
  wb.close();
  wb = Workbench.open(dir, { onError });
  expect(wb.session(s.id).state).toEqual(final);
  expect(verifyCase(s.dir)).toMatchObject({ entries: all.length, firstBad: null });
  expect(errors).toEqual([]);
});

// ---------- slice 12: loops, bound versions and sub-loop children ----------

test("a ledger with none of slice 12's entries folds with an empty loop state and every other field as it was", () => {
  // the file's whole run: state.loop toEqual initialLoop(), skipped []
  const { s, live } = wholeRun();
  const state = fold(s.entries());
  expect(state.loop).toEqual(initialLoop());
  expect(state.skipped).toEqual([]);
  expect(state.run.outcome).toBe("published");
  expect(Object.values(state.cards).some((c) => "from" in c)).toBe(false);
  // every other field is the live session's, which knew nothing of loops
  expect(state).toEqual(live[state.seq]!);
  expect(errors).toEqual([]);
});

test("a ledger holding a loop set, a bound run, a child started and finished with two returned cards, and a child-hold pause folds the same at every entry as the live session saw it", () => {
  // append them through a session, capturing session.state after each commit; fold(entries, seq) toEqual the captured state for every seq
  const s: CaseSession = wb.createCase({
    title: "Beaconing from 192.0.2.10", asked: "Is it beaconing?", why: "IDS alert", starting: [{ type: "ip", value: "192.0.2.10" }],
    window: { from: null, to: null }, objective: null, marking: "TLP:AMBER",
  }, human);
  const live: CaseState[] = [];
  live[1] = structuredClone(s.state);
  s.subscribe((_e, st) => { live[st.seq] = structuredClone(st); });
  const one = (input: EntryInput) => s.commit(() => [input]);
  const looped: StageDef[] = [
    { id: "plan", title: "Plan", phase: "direct", runs: "agent", gate: "plan", reviews: false, model: null },
    { id: "investigate", title: "Investigate", phase: "collect", runs: "loop", gate: null, reviews: false, model: null },
    { id: "assemble", title: "Assemble", phase: "produce", runs: "agent", gate: null, reviews: false, model: null },
  ];
  const hash = "b".repeat(64);
  const childHead = { seq: 42, hash: "d".repeat(64) };

  one({ type: "case.loop_set", payload: { loop: "triage" }, actor: human });
  const lock = s.blobs.put(JSON.stringify({ loop: "triage", items: [] }), "application/json");
  s.commit((_st, ids) => [
    { type: "loop.bound", payload: { loop: "triage", version: 2, hash, lock }, actor: system },
    { type: "run.started", payload: { run: ids.next("run"), pipeline: "triage", pipeline_hash: hash, stages: looped }, actor: system },
  ]);
  one({ type: "stage.started", payload: { stage: "investigate", attempt: 1 }, actor: system, stage: "investigate" });
  const inputs = s.blobs.put(JSON.stringify({ question: "Is it beaconing?" }), "application/json");
  one({ type: "subloop.started", payload: { stage: "investigate", attempt: 1, child: "CASE-2", loop: "investigation", loop_hash: "e".repeat(64), input_hash: "c".repeat(64), inputs, depth: 1 }, actor: system, stage: "investigate" });
  one({ type: "run.paused", payload: { reason: "waiting on child CASE-2: it waits at its plan gate", hold: { kind: "child", stage: "investigate", child: "CASE-2" } }, actor: system });
  expect(s.state.run).toMatchObject({ status: "paused", hold: { kind: "child", stage: "investigate", child: "CASE-2" } });
  one({ type: "run.resumed", payload: {}, actor: system });
  const output = s.blobs.put(JSON.stringify({ findings: [] }), "application/json");
  s.commit((_st, ids) => {
    const a = ids.next("card"), b = ids.next("card");
    const from = (c: string | null) => ({ case: "CASE-2", loop: "investigation", run: "run-1", card: c, head: childHead.hash });
    const note = (id: string, c: string | null) => card(id, {
      kind: "note", made_by: "system", columns: [], column_types: [], rows: [], row_count: 0, coverage: null, title: "From CASE-2", body: "Seen (CASE-2 c3).", from: from(c),
    });
    return [
      { type: "subloop.finished", payload: { stage: "investigate", attempt: 1, child: "CASE-2", child_run: "run-1", head: childHead, outcome: "published", output_hash: "f".repeat(64), output, cards: [a, b] }, actor: system, stage: "investigate" },
      { type: "card.created", payload: { card: note(a, "c3") }, actor: system },
      { type: "card.created", payload: { card: note(b, null) }, actor: system },
    ];
  });
  one({ type: "stage.finished", payload: { stage: "investigate", attempt: 1, outcome: "pass", draft_hash: null, output: null, reason: null }, actor: system, stage: "investigate" });
  one({ type: "run.finished", payload: { outcome: "completed" }, actor: system });

  const final = s.state;
  expect(final.skipped).toEqual([]);
  expect(final.loop).toMatchObject({ id: "triage", pending: null, bound: { loop: "triage", version: 2, hash, lock }, parent: null, child_count: 1 });
  expect(final.loop.children["run-1/investigate/1"]!.finished).toMatchObject({ child_run: "run-1", head: childHead, outcome: "published", cards: ["c1", "c2"] });
  expect(final.cards.c1!.from).toEqual({ case: "CASE-2", loop: "investigation", run: "run-1", card: "c3", head: childHead.hash });
  expect(final.run).toMatchObject({ status: "finished", outcome: "completed", hold: null });

  const all = s.entries();
  for (let n = 1; n <= all.length; n++) {
    expect(live[n], `live state at ${n}`).toBeDefined();
    expect(fold(all, n), `entry ${n} (${all[n - 1]!.type})`).toEqual(live[n]!);
  }
  wb.close();
  wb = Workbench.open(dir, { onError });
  expect(wb.session(s.id).state).toEqual(final);
  expect(verifyCase(s.dir)).toMatchObject({ entries: all.length, firstBad: null, blobs: { bad: [] } });
  expect(errors).toEqual([]);
});

// ---------- slice 12, part B: builder sessions ----------

test("a case ledger with none of the four entries folds with an empty builder state and its other fields as they were", () => {
  const { s, live } = wholeRun();
  const state = fold(s.entries());
  expect(state.builder).toEqual(initialBuilder());
  expect(state.counters.change).toBe(0);
  expect(state.counters.probe).toBe(0);
  expect(state.skipped).toEqual([]);
  expect(state).toEqual(live[state.seq]!);
  expect(errors).toEqual([]);
});

test("a builder session's ledger folds the same at every entry as the live session saw it", () => {
  const s = wb.createBuilder({ loop: "investigation", marking: "TLP:GREEN" }, human);
  const live: CaseState[] = [];
  // the first commit holds case.created and case.loop_set
  live[1] = fold(s.entries(), 1);
  live[s.state.seq] = structuredClone(s.state);
  s.subscribe((_e, st) => { live[st.seq] = structuredClone(st); });
  const one = (input: EntryInput) => s.commit(() => [input]);
  const builder: Actor = { kind: "agent", id: "builder", stage: "builder", profile: "loop-builder", model: "scripted-m", effort: null, where: "machine" };
  const after = "b".repeat(64);

  s.commit((_st, ids) => [{ type: "agent.asked", payload: { turn: ids.next("turn"), text: "Add a triage loop", left_out: [], added: [] }, actor: human }]);
  const bundle = s.blobs.put(canonical({ files: [{ path: "loops/triage.yaml", text: "id: triage\n" }] }), "application/json");
  s.commit((_st, ids) => [{
    type: "builder.proposed",
    payload: { change: ids.next("change"), title: "A triage loop", why: "asked for", root: "sample", files: [{ path: "loops/triage.yaml", kind: "loop", id: "triage", before: null, after }], bundle },
    actor: builder,
  }]);
  s.commit((_st, ids) => [{
    type: "builder.probe_asked",
    payload: { probe: ids.next("probe"), kind: "pivot", source: "netflow", pivot: "flows-by-ip", value: { type: "ip", value: "192.0.2.10" }, text: null, window: { from: null, to: null }, why: "fields" },
    actor: builder,
  }]);
  expect(builderOpen(s.state)).toMatchObject({ changes: [{ id: "chg-1" }], probes: [{ id: "probe-1" }] });
  one({ type: "builder.decided", payload: { change: "chg-1", file: 0, accepted: true, written: after }, actor: human });
  s.commit((_st, ids) => [
    { type: "card.created", payload: { card: card(ids.next("card"), { marking: "TLP:AMBER", made_by: "system", kind: "note", columns: [], column_types: [], rows: [], row_count: 0, coverage: null }) }, actor: system },
    { type: "builder.probe_decided", payload: { probe: "probe-1", approved: true, query: null, outcome: "refused", detail: "the guard refused it" }, actor: human },
  ]);

  const final = s.state;
  expect(final.skipped).toEqual([]);
  expect(builderOpen(final)).toEqual({ changes: [], probes: [] });
  expect(builderMarking(final)).toBe("TLP:AMBER");
  expect(final.builder.changes["chg-1"]!.files[0]!.decided).toMatchObject({ accepted: true, written: after, by: "analyst" });

  const all = s.entries();
  for (let n = 1; n <= all.length; n++) {
    expect(live[n], `live state at ${n}`).toBeDefined();
    expect(fold(all, n), `entry ${n} (${all[n - 1]!.type})`).toEqual(live[n]!);
  }
  wb.close();
  wb = Workbench.open(dir, { onError });
  expect(wb.builder(s.id).state).toEqual(final);
  expect(verifyCase(s.dir)).toMatchObject({ entries: all.length, firstBad: null, blobs: { bad: [] } });
  expect(errors).toEqual([]);
});

// ---------- slice 13: memory ----------

test("the whole run's ledger folds to the state it folded to, with an empty memory beside it", () => {
  // the existing fixture: every field but memory and counters.memory equals the literal the test already holds; skipped is []
  const { s, live } = wholeRun();
  const entries = s.entries();
  const state = fold(entries);
  expect(state.memory).toEqual(initialMemory());
  expect(state.counters.memory).toBe(0);
  expect(state.skipped).toEqual([]);
  expect(state).toEqual(live[state.seq]!);
  // folded without the memory reducer, as before this slice, every entry gives the same state but for the new field and counter
  const without = REDUCERS.filter((r) => r !== applyMemory);
  let old = initial();
  for (const e of entries) {
    old = applyWith(old, e, without);
    const now = fold(entries, e.seq);
    const { memory: _m, counters: { memory: _c, ...counters }, ...rest } = now;
    const { memory: _om, counters: { memory: _oc, ...oldCounters }, ...oldRest } = old;
    expect(rest, `entry ${e.seq} (${e.type})`).toEqual(oldRest);
    expect(counters).toEqual(oldCounters);
  }
  expect(errors).toEqual([]);
});
