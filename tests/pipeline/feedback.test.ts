import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import { fold, latestDraft } from "../../src/core/state";
import type { Actor, Entry, Product } from "../../src/core/types";
import { loadProfile } from "../../src/agents/context";
import { Providers } from "../../src/agents/providers";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import { Workbench } from "../../src/core/workbench";
import { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import { loadConfig } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, MemoryHost, StageEnd, StageRunner } from "../../src/pipeline/engine";
import { computeMops, FeedbackRefused, MOP_IDS, recordFeedback, recordMops } from "../../src/pipeline/feedback";
import { loadPipeline } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { feedbackRunner } from "../../src/pipeline/stages/feedback";
import { publishRunner } from "../../src/pipeline/stages/publish";
import { EntryBuilder } from "../helpers/entries";
import { fixture, person, PLAN } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

const planner: Actor = { kind: "agent", id: "planner", stage: "plan", profile: "investigation", model: "m", effort: null, where: "machine" };
const PASS: Extract<StageEnd, { kind: "finished" }> = { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
const at = (s: number): { ts: string } => ({ ts: new Date(Date.parse("2026-11-23T20:00:00.000Z") + s * 1000).toISOString() });
const CASE = { id: "case-1", title: "t", asked: "a", why: "w", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN" as const };
const STAGES = [{ id: "publish", title: "Publish", phase: null, runs: "agent" as const, gate: "publish" as const, reviews: false, model: null }];
const START = { run: "run-1", pipeline: "default", pipeline_hash: "h", stages: STAGES };
const issued = (query: string) => ({ query, source: "assets", source_hash: "h", pivot: null, pivot_hash: null, connector: "csv", text: "t", bound: {}, window: { from: null, to: null }, why: "w", estimate: null, step: null, verifies: null, purpose: "result" as const });
const result = (query: string, cost: { amount: number; unit: string } | null) => ({ query, result: { blob: "0".repeat(64), bytes: 0 }, rows: 1, rows_hash: "h", coverage: { kind: "full" as const }, duration_ms: 1, cost });
const usage = (input: number, output: number) => ({ request: "r1", response: { blob: "0".repeat(64), bytes: 0 }, stop: "end" as const, usage: { input, output, reasoning: 0 }, served_by: "m", reasoning: null });

/** An earlier run's noise, then a run with 5 queries (one costing 1 lookups), 1234 tokens, a blocked step, a send-back and a failed check. */
function ledger(): Entry[] {
  const b = new EntryBuilder();
  b.add("case.created", CASE);
  b.add("run.started", { ...START, run: "run-0" }, at(0));
  b.add("query.issued", issued("q0"));
  b.add("check.run", { check: "x", script_hash: "h", input: { blob: "0".repeat(64), bytes: 0 }, output: { blob: "0".repeat(64), bytes: 0 }, draft_hash: "d", pass: false, findings: [] });
  b.add("run.finished", { outcome: "stopped" });
  b.add("run.started", START, at(100));
  for (let i = 1; i <= 5; i++) b.add("query.issued", issued(`q${i}`));
  b.add("query.result", result("q1", { amount: 1, unit: "lookups" }));
  b.add("query.result", result("q2", null));
  b.add("model.response", usage(1000, 234));
  b.add("step.finished", { step: "s1", outcome: "blocked", cards: [], note: "" });
  b.add("step.finished", { step: "s2", outcome: "answered", cards: [], note: "" });
  b.add("stage.sent_back", { from: "checks", to: "assemble", reason: "r", count: 1 });
  b.add("check.run", { check: "x", script_hash: "h", input: { blob: "0".repeat(64), bytes: 0 }, output: { blob: "0".repeat(64), bytes: 0 }, draft_hash: "d", pass: false, findings: [] });
  b.add("check.run", { check: "y", script_hash: "h", input: { blob: "0".repeat(64), bytes: 0 }, output: { blob: "0".repeat(64), bytes: 0 }, draft_hash: "d", pass: true, findings: [] });
  b.add("product.published", { n: 1, draft_hash: "d", head_hash: "h", dir: "published/1", bundle: { blob: "0".repeat(64), bytes: 0 } }, at(142));
  return b.entries;
}

test("measures of performance are computed from the ledger", () => {
  const entries = ledger();
  const mops = computeMops(entries, fold(entries));
  expect(Object.fromEntries(mops.map((m) => [m.measure, m.value]))).toEqual({
    elapsed_seconds: 42, queries_run: 5, query_cost: "1 lookups", model_tokens: 1234, steps_blocked: 1, send_backs: 1, checks_failed: 1,
  });
  expect(mops.map((m) => m.measure)).toEqual([...MOP_IDS]);
  expect(mops.every((m) => m.note.length > 0)).toBe(true);
});

test("only the current run is counted", () => {
  const entries = ledger();
  const mops = computeMops(entries.filter((e) => e.seq <= 5), fold(entries.filter((e) => e.seq <= 5)));
  expect(Object.fromEntries(mops.map((m) => [m.measure, m.value]))).toMatchObject({ queries_run: 1, checks_failed: 1, send_backs: 0, query_cost: "0" });
  const all = Object.fromEntries(computeMops(entries, fold(entries)).map((m) => [m.measure, m.value]));
  expect(all.queries_run).toBe(5);
  expect(all.checks_failed).toBe(1);
});

let f: Fixture;
let dir: string;
beforeEach(() => { f = fixture(false); dir = mkdtempSync(join(tmpdir(), "feedback-")); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
  rmSync(dir, { recursive: true, force: true });
});

const product: Product = { objective: "o", question: "q", marking: "TLP:GREEN", summary: "s", key_findings: [], gaps_and_limits: "", alternatives: "", assessment: "", sources: [], assumptions: [], change: "c" };

function rig(s: CaseSession = f.s, memory?: MemoryHost): Engine {
  const registry = f.sample.registry;
  const { pipeline } = loadPipeline(registry);
  const deps: EngineDeps = {
    config: loadConfig({ env: {}, home: dir, repoRoot: dir }), registry, runner: f.sample.deps, seeker: f.sample.seeker,
    providers: new Providers([new ScriptedProvider({ id: "scripted", scripts: [{ id: "sample-run", turns: [{ actor: "publisher", reply: { content: JSON.stringify({ title: "T", note: "" }) } }] }] })]),
    pipeline: pipeline!, profile: loadProfile(registry, "investigation"), ...(memory === undefined ? {} : { memory }),
  };
  const pass = (): StageEnd => ({ ...PASS, draft_hash: latestDraft(s.state)?.hash ?? null });
  const runners: Partial<Record<Role, StageRunner>> = {
    frame: async () => PASS,
    plan: async () => { s.commit((_st, ids) => [{ type: "plan.proposed", actor: planner, payload: { plan: PLAN(ids.next("plan")) } }]); return PASS; },
    research: async () => PASS,
    assemble: async () => {
      const hash = sha256Hex(canonical(product as unknown as Json));
      s.commit((st) => [{ type: "draft.revised", actor: planner, payload: { draft: { n: st.drafts.length + 1, hash, author: planner, product, reason: "r" } } }]);
      return { ...PASS, draft_hash: hash };
    },
    checks: async () => pass(), evaluate: async () => pass(), challenge: async () => pass(),
    publish: publishRunner, feedback: feedbackRunner,
  };
  return new Engine(s, deps, { runners });
}
async function published(engine: Engine): Promise<void> {
  engine.start(person);
  await engine.advance();
  f.s.commit(() => [
    { type: "plan.accepted", actor: person, payload: { plan: f.s.state.plan.current!.id, steps: ["s1"], budgets: {} } },
    { type: "gate.passed", actor: person, payload: { gate: "plan" } },
  ]);
  await engine.advance();
  engine.approve({ actor: person });
}
const recorded = () => f.s.entries().filter((e) => e.type === "feedback.recorded");

test("after approval the measures are recorded and the run finishes as published", async () => {
  const engine = rig();
  await published(engine);
  expect(recorded()).toEqual([]);
  const done = await engine.advance();
  expect(done).toMatchObject({ status: "finished", outcome: "published" });
  const entries = recorded();
  expect(entries.map((e) => e.payload)).toMatchObject(MOP_IDS.map((measure) => ({ measure, kind: "mop" })));
  expect(entries.every((e) => e.actor.kind === "system" && e.actor.id === "feedback")).toBe(true);
  expect(entries.map((e) => e.seq)).toEqual([...entries.map((e) => e.seq)].sort((a, b) => a - b));
  expect(f.s.state.feedback).toHaveLength(7);
  const batch = f.s.entries().filter((e) => e.seq >= entries[0]!.seq && e.seq <= entries.at(-1)!.seq);
  expect(batch).toHaveLength(7);
  expect(f.s.state.feedback.find((x) => x.measure === "queries_run")!.value).toBe(0);
});

test("the sample's Feedback stage runs no agent: with a memory host and a typed case it asks nothing and files nothing", async () => {
  f.s.commit(() => [{ type: "case.type_set", actor: person, payload: { type: "unknown-device" } }]);
  const proposed: unknown[] = [];
  const engine = rig(f.s, {
    read: () => { throw new Error("not read"); },
    propose: (d) => { proposed.push(d); return { lesson: "LESSON-1", fresh: true }; },
  });
  await published(engine);
  expect(await engine.advance()).toMatchObject({ status: "finished", outcome: "published" });
  const ends = f.s.entries().filter((e) => e.type === "stage.finished" && e.payload.stage === "feedback");
  expect(ends.map((e) => (e.type === "stage.finished" ? [e.payload.outcome, e.payload.output, e.payload.reason] : null))).toEqual([["pass", null, null]]);
  expect(f.s.entries().some((e) => e.type === "model.request" && e.stage === "feedback")).toBe(false);
  expect(proposed).toEqual([]);
});

/** A case that names the sample objective, in its own workbench, and a registry whose objective lists only `ids`' kinds as given. */
function objectiveCase(measures: string): { s: CaseSession; registry: Registry; close(): void } {
  const root = f.sample.root;
  const file = join(root, "context", "objective.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace(/measures:[\s\S]*$/, `measures:\n${measures}\n`));
  const registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
  const wb = Workbench.open(join(dir, "wb2"), { onError: () => {} });
  const s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [], window: { from: null, to: null }, objective: "sample-objective", marking: "TLP:GREEN" }, person);
  return { s, registry, close: () => wb.close() };
}
const LISTED = [
  "  - { id: queries_run, kind: mop, title: Queries run, target: 20 }",
  "  - { id: send_backs, kind: mop, title: Send-backs, target: 2 }",
  "  - { id: answered_the_question, kind: moe, title: Answered, target: true }",
].join("\n");

test("only the measures of performance the objective lists are recorded", () => {
  const c = objectiveCase(LISTED);
  try {
    c.s.commit((_st, ids) => [{ type: "run.started", actor: person, payload: { ...START, run: ids.next("run") } }]);
    recordMops(c.s, c.registry, () => {});
    expect(c.s.state.feedback.map((x) => [x.measure, x.kind])).toEqual([["queries_run", "mop"], ["send_backs", "mop"]]);
    recordMops(c.s, c.registry, () => {});
    expect(c.s.state.feedback).toHaveLength(2);
    expect(c.s.state.skipped).toEqual([]);
  } finally { c.close(); }
});

test("a person records a measure of effectiveness, after the run too", async () => {
  const c = objectiveCase(LISTED);
  try {
    recordFeedback(c.s, c.registry, { measure: "answered_the_question", value: "yes", note: "it did", actor: person });
    c.s.commit((_st, ids) => [{ type: "run.started", actor: person, payload: { ...START, run: ids.next("run") } }]);
    c.s.commit((st) => [{ type: "run.finished", actor: person, run: st.run.id, payload: { outcome: "stopped" } }]);
    expect(c.s.state.run.status).toBe("finished");
    recordFeedback(c.s, c.registry, { measure: "answered_the_question", value: 1, note: "", actor: person });
    expect(c.s.state.feedback).toEqual([
      { measure: "answered_the_question", kind: "moe", value: "yes", note: "it did" },
      { measure: "answered_the_question", kind: "moe", value: 1, note: "" },
    ]);
    expect(c.s.entries().filter((e) => e.type === "feedback.recorded").every((e) => e.actor.kind === "human")).toBe(true);
    expect(c.s.state.skipped).toEqual([]);
  } finally { c.close(); }
});

test("an unknown measure, a performance measure by hand, or an agent is refused", () => {
  const c = objectiveCase(LISTED);
  try {
    const give = (measure: string, actor: Actor = person) => () => recordFeedback(c.s, c.registry, { measure, value: 1, note: "", actor });
    expect(give("time_saved")).toThrow(FeedbackRefused);
    expect(give("nonsense")).toThrow(FeedbackRefused);
    expect(give("queries_run")).toThrow(FeedbackRefused);
    expect(give("answered_the_question", planner)).toThrow(FeedbackRefused);
    expect(give("answered_the_question", { kind: "system", id: "feedback" })).toThrow(FeedbackRefused);
    expect(c.s.state.feedback).toEqual([]);
    // a case with no objective has no measure of effectiveness to record
    expect(() => recordFeedback(f.s, f.sample.registry, { measure: "time_saved", value: 1, note: "", actor: person })).toThrow(FeedbackRefused);
    expect(f.s.state.feedback).toEqual([]);
  } finally { c.close(); }
});
