import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import { fold, gateChanges, latestDraft } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Actor, Draft, Entry, Product } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { loadProfile } from "../../src/agents/context";
import { Providers } from "../../src/agents/providers";
import { execTool, parseCall, TOOL_NAMES } from "../../src/agents/tools";
import type { ToolContext } from "../../src/agents/tools";
import { loadConfig } from "../../src/modules/config";
import { DEFAULT_LIMITS } from "../../src/modules/seeker";
import { Engine, RunRefused } from "../../src/pipeline/engine";
import { answerQuestion } from "../../src/pipeline/questions";
import type { EngineDeps, StageEnd, StageRunner } from "../../src/pipeline/engine";
import { loadPipeline } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { fixture, PLAN, WINDOW, START } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";
import { sampleRoot } from "../helpers/sample-root";

const person: Actor = { kind: "human", id: "analyst" };
const planner: Actor = { kind: "agent", id: "planner", stage: "plan", profile: "investigation", model: "m", effort: null, where: "machine" };
const PASS: Extract<StageEnd, { kind: "finished" }> = { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };

let f: Fixture;
let dir: string;
let extra: (() => void)[] = [];
let anchors: string[] | null = null;
beforeEach(() => { anchors = []; f = fixture(false); dir = mkdtempSync(join(tmpdir(), "engine-")); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  for (const x of extra.reverse()) x();
  extra = [];
  f.close();
  rmSync(dir, { recursive: true, force: true });
});

function depsOf(sample: Fixture["sample"]): EngineDeps {
  const registry = sample.registry;
  const { pipeline, problems } = loadPipeline(registry);
  if (pipeline === null) throw new Error(problems.join("; "));
  return {
    config: loadConfig({ env: {}, home: dir, repoRoot: dir }), registry, runner: sample.deps, seeker: sample.seeker,
    providers: new Providers([]), pipeline, profile: loadProfile(registry, "investigation"),
  };
}

const product = (n: number): Product => ({
  objective: "o", question: "q", marking: "TLP:GREEN", summary: `s${n}`, key_findings: [], gaps_and_limits: "", alternatives: "", assessment: "", sources: [], assumptions: [], change: "",
});
const makeDraft = (n: number): Draft => {
  const p = product(n);
  return { n, hash: sha256Hex(canonical(p as unknown as Json)), author: planner, product: p, reason: "r" };
};

interface Rig { engine: Engine; s: CaseSession; log: string[]; runners: Partial<Record<Role, StageRunner>> }

/** Stub runners for every role: each passes, the plan stub proposes a plan, the assemble stub revises the draft, review stubs pass the latest draft. */
function rig(over: Partial<Record<Role, StageRunner>> = {}, s: CaseSession = f.s, deps: EngineDeps = depsOf(f.sample)): Rig {
  if (deps.anchor === undefined && anchors !== null) deps = { ...deps, anchor: (a) => { anchors!.push(a.why); } };
  const log: string[] = [];
  const draftPass = (): StageEnd => ({ ...PASS, draft_hash: latestDraft(s.state)?.hash ?? null });
  const runners: Partial<Record<Role, StageRunner>> = {
    frame: async () => { log.push("frame"); return PASS; },
    plan: async () => {
      log.push("plan");
      s.commit((_st, ids) => [{ type: "plan.proposed", actor: planner, payload: { plan: PLAN(ids.next("plan")) } }]);
      return PASS;
    },
    research: async () => { log.push("research"); return PASS; },
    assemble: async () => {
      log.push("assemble");
      const n = s.state.drafts.length + 1;
      s.commit(() => [{ type: "draft.revised", actor: planner, payload: { draft: makeDraft(n) } }]);
      return PASS;
    },
    checks: async () => { log.push("checks"); return draftPass(); },
    evaluate: async () => { log.push("evaluate"); return draftPass(); },
    challenge: async () => { log.push("challenge"); return draftPass(); },
    publish: async () => { log.push("publish"); return draftPass(); },
    feedback: async () => { log.push("feedback"); return PASS; },
    ...over,
  };
  return { engine: Engine.open(s, deps, { runners }), s, log, runners };
}

const acceptPlan = (s: CaseSession, budgets: Record<string, number> = {}) => {
  s.commit(() => [
    { type: "plan.accepted", actor: person, payload: { plan: s.state.plan.current!.id, steps: ["s1", "s2", "s3", "s4"], budgets } },
    { type: "gate.passed", actor: person, payload: { gate: "plan" } },
  ]);
};
const publish = (s: CaseSession) => {
  const draft = latestDraft(s.state)!;
  s.commit(() => [
    { type: "product.published", actor: person, payload: { n: 1, draft_hash: draft.hash, head_hash: "x", dir: "out", bundle: s.blobs.put("{}") } },
    { type: "gate.passed", actor: person, payload: { gate: "publish" } },
  ]);
};
const types = (s: CaseSession): string[] => s.entries().map((e) => e.type);

test("a run goes stage to stage on its own and stops at the plan gate", async () => {
  const r = rig();
  r.engine.start(person);
  const sum = await r.engine.advance();
  expect(r.log).toEqual(["frame", "plan"]);
  expect(sum).toEqual({ status: "waiting", waiting: "plan", current: "plan", pause_reason: null, outcome: null });
  acceptPlan(f.s);
  const next = await r.engine.advance();
  expect(r.log).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish"]);
  expect(next.waiting).toBe("publish");
  publish(f.s);
  const done = await r.engine.advance();
  expect(r.log.at(-1)).toBe("feedback");
  expect(done).toEqual({ status: "finished", waiting: null, current: "feedback", pause_reason: null, outcome: "published" });
  expect(r.engine.summary()).toEqual(done);
});

test("every transition is an entry", async () => {
  const r = rig();
  r.engine.start(person);
  await r.engine.advance();
  const flow = f.s.entries().flatMap((e): string[] => {
    const pl = e.payload as { stage?: string; phase?: string };
    if (e.type === "stage.started" || e.type === "stage.finished") return [`${e.type}:${pl.stage}`];
    if (e.type === "case.phase_changed") return [`${e.type}:${pl.phase}`];
    return /^(gate|run)\./.test(e.type) ? [e.type] : [];
  });
  expect(flow).toEqual([
    "run.started", "case.phase_changed:direction", "stage.started:frame", "stage.finished:frame", "stage.started:plan", "stage.finished:plan", "gate.waiting",
  ]);
  const first = f.s.entries().find((e) => e.type === "run.started")!;
  expect(first.actor).toEqual(person);
  expect(first.payload).toMatchObject({ pipeline: "default", pipeline_hash: depsOf(f.sample).pipeline.hash });
  const started = f.s.entries().find((e) => e.type === "stage.started")!;
  expect(started.actor).toEqual({ kind: "system", id: "engine" });
  expect(f.s.state.phase).toBe("direction");
  acceptPlan(f.s);
  await r.engine.advance();
  expect(f.s.entries().filter((e) => e.type === "case.phase_changed").map((e) => e.payload)).toEqual([
    { phase: "direction" }, { phase: "collection" }, { phase: "analysis" }, { phase: "processing" }, { phase: "analysis" }, { phase: "dissemination" },
  ]);
});

test("a send-back and the restart of its target are one commit", async () => {
  let fails = 1;
  const r = rig({ checks: async () => { r.log.push("checks"); return fails-- > 0 ? { kind: "finished", outcome: "fail", draft_hash: latestDraft(f.s.state)!.hash, output: null, reason: "bad confidence" } : { ...PASS, draft_hash: latestDraft(f.s.state)!.hash }; } });
  const batches: string[][] = [];
  const commit = f.s.commit.bind(f.s);
  f.s.commit = (build) => { const e = commit(build); batches.push(e.map((x) => x.type)); return e; };
  r.engine.start(person);
  await r.engine.advance();
  acceptPlan(f.s);
  await r.engine.advance();
  expect(batches.filter((b) => b.includes("stage.sent_back"))).toEqual([["stage.sent_back", "case.phase_changed", "stage.started"]]);
  const back = f.s.entries().find((e) => e.type === "stage.sent_back")!;
  expect(back.payload).toEqual({ from: "checks", to: "assemble", reason: "bad confidence", count: 1 });
  expect(f.s.state.run.sendbacks).toEqual({ "checks>assemble": 1 });
  expect(r.log.filter((l) => l === "assemble").length).toBe(2);
});

const failingChecks = (r: () => Rig): StageRunner => async () => {
  r().log.push("checks");
  return { kind: "finished", outcome: "fail", draft_hash: latestDraft(f.s.state)!.hash, output: null, reason: "confidence-and-likelihood failed" };
};

test("three send-backs along one edge, then the run pauses and says why", async () => {
  const r: Rig = rig({ checks: failingChecks(() => r) });
  r.engine.start(person);
  await r.engine.advance();
  acceptPlan(f.s);
  const sum = await r.engine.advance();
  expect(sum.status).toBe("paused");
  expect(sum.pause_reason).toStartWith("Checks has sent work back to Assemble 3 times.");
  expect(sum.pause_reason).toContain("confidence-and-likelihood failed");
  expect(f.s.state.run.sendbacks).toEqual({ "checks>assemble": 3 });
  expect(r.log.filter((l) => l === "checks").length).toBe(4);
});

test("resuming after the cap grants a fresh allowance of three send-backs along that edge", async () => {
  const r: Rig = rig({ checks: failingChecks(() => r) });
  r.engine.start(person);
  await r.engine.advance();
  acceptPlan(f.s);
  await r.engine.advance();
  expect(f.s.state.run.hold).toEqual({ kind: "send_back", edge: "checks>assemble" });
  const sum = await r.engine.resume(person);
  expect(f.s.state.run.sendbacks).toEqual({ "checks>assemble": 6 });
  expect(sum.status).toBe("paused");
  expect(sum.pause_reason).toStartWith("Checks has sent work back to Assemble 3 times.");
  expect(r.log.filter((l) => l === "checks").length).toBe(7);
});

test("pause stops the next stage from starting, and resume continues", async () => {
  const r = rig();
  r.engine.start(person);
  await r.engine.advance();
  const off = f.s.subscribe((e) => { if (e.type === "stage.started" && e.payload.stage === "research") { off(); r.engine.pause(person); } });
  acceptPlan(f.s);
  const sum = await r.engine.advance();
  expect(sum.status).toBe("paused");
  expect(sum.pause_reason).toBe("paused by analyst");
  expect(r.log).toEqual(["frame", "plan"]);
  expect(f.s.state.run.stages.find((s) => s.id === "research")!.status).toBe("running");
  expect((await r.engine.advance()).status).toBe("paused");
  const after = await r.engine.resume(person);
  expect(r.log).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish"]);
  expect(after.waiting).toBe("publish");
});

test("a stalled stage pauses the run and runs again on resume", async () => {
  let calls = 0;
  const r = rig({ frame: async () => { r.log.push("frame"); return calls++ === 0 ? { kind: "stalled", reason: "Frame could not reach the model." } : PASS; } });
  r.engine.start(person);
  const sum = await r.engine.advance();
  expect(sum).toMatchObject({ status: "paused", pause_reason: "Frame could not reach the model.", current: "frame" });
  expect(f.s.state.run.stages[0]!.status).toBe("running");
  const again = await r.engine.resume(person);
  expect(r.log).toEqual(["frame", "frame", "plan"]);
  expect(again.waiting).toBe("plan");
  expect(f.s.state.run.stages[0]!.attempts).toBe(1);
});

test("a declined model pauses the run; a new model and resume run the stage again", async () => {
  let calls = 0;
  const r = rig({ frame: async () => { r.log.push("frame"); return calls++ === 0 ? { kind: "declined", reason: "policy" } : PASS; } });
  r.engine.start(person);
  const sum = await r.engine.advance();
  expect(sum.pause_reason).toBe("The model declined at Frame: policy. Choose another model and resume.");
  expect(f.s.state.run.stages[0]).toMatchObject({ status: "declined" });
  r.engine.setModel("frame", { provider: "scripted", model: "other", effort: null }, person);
  expect(f.s.state.run.stages[0]!.model).toEqual({ provider: "scripted", model: "other", effort: null });
  await r.engine.resume(person);
  expect(r.log).toEqual(["frame", "frame", "plan"]);
  expect(f.s.state.run.stages[0]!.attempts).toBe(2);
});

test("a blocked stage pauses the run with both ways on", async () => {
  let calls = 0;
  const r = rig({
    frame: async () => {
      r.log.push("frame");
      if (calls++ > 0) return PASS;
      f.s.commit(() => [{ type: "model.blocked", actor: planner, payload: { stage: "frame", marking: "TLP:RED", model: "m", where: "hosted" } }]);
      return { kind: "blocked", marking: "TLP:RED" };
    },
  });
  r.engine.start(person);
  const sum = await r.engine.advance();
  expect(sum.pause_reason).toBe("Frame: the chosen model may not receive data marked TLP:RED. Choose an allowed model, or leave the stricter items out, and resume.");
  r.engine.setPackLimit("frame", "TLP:GREEN", person);
  expect(f.s.state.pack_limits).toEqual({ frame: "TLP:GREEN" });
  await r.engine.resume(person);
  expect(r.log).toEqual(["frame", "frame", "plan"]);
});

test("a runner that throws pauses the run instead of crashing it", async () => {
  const r = rig({ frame: async () => { throw new Error("boom\nsecond line"); } });
  r.engine.start(person);
  const sum = await r.engine.advance();
  expect(sum).toMatchObject({ status: "paused", pause_reason: "Frame failed unexpectedly: boom" });
});

test("a stopped stage writes nothing and leaves the stage running", async () => {
  const r = rig({ frame: async () => ({ kind: "stopped" }) });
  r.engine.start(person);
  await r.engine.advance();
  const before = f.s.state.seq;
  await r.engine.advance();
  expect(types(f.s).slice(before)).toEqual([]);
  expect(types(f.s).slice(-2)).toEqual(["case.phase_changed", "stage.started"]);
  expect(f.s.state.run.stages[0]!.status).toBe("running");
});

test("budget, model and pack limit changes are entries", () => {
  const r = rig();
  r.engine.start(person);
  r.engine.setBudget(5000, person);
  expect(f.s.state.run.budget_tokens).toBe(5000);
  r.engine.setBudget(null, person);
  expect(f.s.state.run.budget_tokens).toBeNull();
  r.engine.setPackLimit("plan", "TLP:AMBER", person);
  r.engine.setPackLimit("plan", null, person);
  expect(f.s.state.pack_limits).toEqual({});
  expect(types(f.s).filter((t) => t === "budget.set" || t === "stage.pack_limit_set")).toHaveLength(4);
});

test("an interrupted run resumes at the stage it was in, and the case is recovered once on open", async () => {
  const wbDir = join(dir, "wb2");
  const sample = sampleRoot(join(dir, "s2"));
  const wb1 = Workbench.open(wbDir, { onError: () => {} });
  extra.push(() => sample.close());
  let calls = 0;
  const s1 = wb1.createCase({ title: "t", asked: "a", why: "w", starting: [{ type: "address", value: START }], window: WINDOW, objective: null, marking: "TLP:GREEN" }, person);
  const deps = depsOf(sample);
  const r1 = rig({ frame: async () => { r1.log.push("frame"); return calls++ === 0 ? { kind: "stopped" } : PASS; } }, s1, deps);
  r1.engine.start(person);
  await r1.engine.advance();
  expect(s1.state.run.status).toBe("running");
  s1.commit((_st, ids) => [{
    type: "query.issued", actor: planner,
    payload: { query: ids.next("query"), source: "x", source_hash: "h", pivot: null, pivot_hash: null, connector: "c", text: "t", bound: {}, window: WINDOW, why: "w", estimate: null, step: null, verifies: null, purpose: "result" },
  }]);
  wb1.close();

  const wb2 = Workbench.open(wbDir, { onError: () => {} });
  extra.push(() => wb2.close());
  const s2 = wb2.session(s1.id);
  expect(s2.state.run.status).toBe("running");
  const r2 = rig({ frame: async () => { r2.log.push("frame"); return PASS; } }, s2, deps);
  expect(s2.state.run.status).toBe("interrupted");
  expect(s2.state.queries.q1!.status).toBe("failed");
  expect(s2.entries().filter((e) => e.type === "run.interrupted")).toHaveLength(1);
  expect(r2.engine.summary()).toMatchObject({ status: "interrupted", current: "frame" });
  expect((await r2.engine.advance()).status).toBe("interrupted");
  expect(r2.log).toEqual([]);

  // a second engine on the same open session does not recover again: work begun since is not touched
  s2.commit((_st, ids) => [{
    type: "query.issued", actor: planner,
    payload: { query: ids.next("query"), source: "x", source_hash: "h", pivot: null, pivot_hash: null, connector: "c", text: "t", bound: {}, window: WINDOW, why: "w", estimate: null, step: null, verifies: null, purpose: "result" },
  }]);
  rig({}, s2, deps);
  expect(s2.state.queries.q2!.status).toBe("running");

  const sum = await r2.engine.resume(person);
  expect(r2.log).toEqual(["frame", "plan"]);
  expect(sum.waiting).toBe("plan");
  expect(s2.state.skipped).toEqual([]);
});

test("two advance calls at once do the work once", async () => {
  const r = rig();
  r.engine.start(person);
  const a = r.engine.advance();
  const b = r.engine.advance();
  expect(a).toBe(b);
  await Promise.all([a, b]);
  expect(r.log).toEqual(["frame", "plan"]);
  expect(types(f.s).filter((t) => t === "stage.started")).toHaveLength(2);
});

test("starting a second run while one is active is refused", async () => {
  const r = rig();
  r.engine.start(person);
  expect(() => r.engine.start(person)).toThrow(RunRefused);
  await r.engine.advance();
  expect(() => r.engine.start(person)).toThrow(RunRefused);
});

test("a finished run may be followed by a new one", async () => {
  const r = rig();
  r.engine.start(person);
  await r.engine.advance();
  acceptPlan(f.s);
  await r.engine.advance();
  publish(f.s);
  await r.engine.advance();
  expect(f.s.state.run.status).toBe("finished");
  r.engine.start(person);
  expect(f.s.state.run.id).toBe("run-2");
  expect(f.s.state.run.status).toBe("running");
});

test("the state at every entry of the run equals the fold to that entry", async () => {
  const seen: [Entry, Readonly<CaseState>][] = [];
  f.s.subscribe((e, state) => { seen.push([e, state]); });
  const r = rig({ checks: failingChecks(() => r) });
  r.engine.start(person);
  await r.engine.advance();
  acceptPlan(f.s);
  await r.engine.advance();
  await r.engine.resume(person);
  expect(seen.length).toBe(f.s.entries().length - 1); // all but case.created, which came before the subscription
  const all = f.s.entries();
  for (const [e, state] of seen) {
    expect(state).toEqual(fold(all.slice(0, e.seq)));
    expect(f.s.stateAt(e.seq)).toEqual(state);
  }
});

const costly = (s: CaseSession, budgets: Record<string, number>, results: unknown[]): { research: StageRunner; accepted: Entry } => {
  s.commit((_st, ids) => [{ type: "plan.proposed", actor: planner, payload: { plan: PLAN(ids.next("plan")) } }]);
  const accepted = s.commit(() => [{ type: "plan.accepted", actor: person, payload: { plan: "plan-1", steps: ["s1", "s2", "s3", "s4"], budgets } }])[0]!;
  const research: StageRunner = async (env) => {
    const agent: Extract<Actor, { kind: "agent" }> = { kind: "agent", id: "researcher-g3", stage: "research", profile: "investigation", model: "s", effort: null, where: "machine" };
    const ctx: ToolContext = {
      session: s, deps: f.sample.deps, seeker: f.sample.seeker, actor: agent, link: { run: s.state.run.id, stage: "research", job: null },
      draft: null, draft_hash: null, subgoal: null, window: WINDOW, limits: DEFAULT_LIMITS, ...(env.onNeedsBudget ? { onNeedsBudget: env.onNeedsBudget } : {}),
    };
    results.push((await execTool(ctx, parseCall(TOOL_NAMES, "run_step", JSON.stringify({ step: "s3", why: "known bad?" })))).summary);
    // the same proposal is not run a second time
    results.push(env.onNeedsBudget ? await env.onNeedsBudget("p1", "s3") : "no hook");
    return PASS;
  };
  return { research, accepted };
};
const noPlan: StageRunner = async () => PASS;

test("an accepted costly step runs once, in the accepting person's name with their budget, caused by plan.accepted", async () => {
  const results: unknown[] = [];
  const { research, accepted } = costly(f.s, { s3: 100 }, results);
  const r = rig({ research, plan: noPlan });
  r.engine.start(person);
  await r.engine.advance();
  const entry = f.s.entries().filter((e) => e.type === "proposal.accepted");
  expect(entry).toHaveLength(1);
  expect(entry[0]).toMatchObject({ actor: person, cause: accepted.seq, payload: { proposal: "p1", budget: 100 } });
  expect(f.s.state.proposals.p1).toMatchObject({ status: "accepted", budget: 100 });
  expect(f.s.state.plan.steps.s3!.status).toBe("answered");
  expect(results[0]).not.toMatch(/waiting for a person/);
  expect(results[1]).toBeNull();
  expect(f.s.entries().filter((e) => e.type === "query.result" && e.actor.kind === "human")).toEqual([]);
});

test("a costly step with no budget stays an open proposal", async () => {
  const results: unknown[] = [];
  const { research } = costly(f.s, {}, results);
  const r = rig({ research, plan: noPlan });
  r.engine.start(person);
  await r.engine.advance();
  expect(results).toEqual(["waiting for a person's budget (proposal p1)", null]);
  expect(f.s.state.proposals.p1!.status).toBe("open");
  expect(f.s.entries().filter((e) => e.type === "proposal.accepted")).toEqual([]);
});

const waitFor = () => { let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); return { gate, release }; };

test("a changed pipeline pauses the run on resume instead of spinning", async () => {
  const stall = rig({ frame: async () => ({ kind: "stalled", reason: "wait" }) });
  stall.engine.start(person);
  await stall.engine.advance();
  const changed = { ...depsOf(f.sample), pipeline: { ...depsOf(f.sample).pipeline, hash: "somethingelse" } };
  const r2 = rig({}, f.s, changed);
  const before = types(f.s).length;
  const sum = await r2.engine.resume(person);
  expect(sum).toMatchObject({ status: "paused", pause_reason: "the pipeline has changed since this run started" });
  expect(r2.log).toEqual([]);
  expect(types(f.s).slice(before)).toEqual(["run.resumed", "run.paused"]);
});

test("a review runner that does not name the latest draft fails its stage, with a reason, and the run stays bounded", async () => {
  const r = rig({ evaluate: async () => { return { ...PASS }; } });
  r.engine.start(person);
  await r.engine.advance();
  acceptPlan(f.s);
  const sum = await r.engine.advance();
  expect(sum.status).toBe("paused");
  const fin = f.s.entries().filter((e) => e.type === "stage.finished" && e.payload.stage === "evaluate");
  expect(fin.length).toBeLessThan(10);
  expect(fin[0]!.payload).toMatchObject({ outcome: "fail", reason: "Evaluate did not review the latest draft" });
  expect(sum.pause_reason).toStartWith("Evaluate has sent work back to Assemble 3 times.");
});

test("pausing a paused run writes nothing, and only a person may resume", async () => {
  const r = rig({ frame: async () => ({ kind: "stalled", reason: "wait" }) });
  r.engine.start(person);
  await r.engine.advance();
  const before = types(f.s).length;
  r.engine.pause(person);
  expect(types(f.s).length).toBe(before);
  await expect(r.engine.resume(planner)).rejects.toThrow(RunRefused);
  expect(types(f.s).length).toBe(before);
});

test("a resume during an in-flight advance drives the run afterwards", async () => {
  const w = waitFor();
  let calls = 0;
  const r = rig({ frame: async () => { r.log.push("frame"); if (calls++ === 0) { await w.gate; return { kind: "stopped" }; } return PASS; } });
  r.engine.start(person);
  const first = r.engine.advance();
  await Promise.resolve();
  r.engine.pause(person);
  const resumed = r.engine.resume(person);
  w.release();
  await first;
  const sum = await resumed;
  expect(r.log).toEqual(["frame", "frame", "plan"]);
  expect(sum.waiting).toBe("plan");
});

test("denying the plan anchors the case as closed", async () => {
  const r = rig();
  r.engine.start(person);
  await r.engine.advance();
  r.engine.denyPlan({ reason: "no", actor: person });
  expect(f.s.state.run.status).toBe("finished");
  expect(anchors).toEqual(["closed"]);
});

test("a person stops a run a changed pipeline has stranded; the case is anchored closed and a new run may start", async () => {
  const stall = rig({ frame: async () => ({ kind: "stalled", reason: "wait" }) });
  stall.engine.start(person);
  await stall.engine.advance();
  const changed = { ...depsOf(f.sample), pipeline: { ...depsOf(f.sample).pipeline, hash: "somethingelse" } };
  const r2 = rig({}, f.s, changed);
  expect(await r2.engine.resume(person)).toMatchObject({ status: "paused", pause_reason: "the pipeline has changed since this run started" });
  expect(() => r2.engine.start(person)).toThrow(RunRefused);
  anchors = [];
  r2.engine.stop(person, "the stage manifests were edited");
  expect(f.s.entries().at(-1)).toMatchObject({ type: "run.finished", actor: person, payload: { outcome: "stopped", reason: "the stage manifests were edited" } });
  expect(r2.engine.summary()).toMatchObject({ status: "finished", outcome: "stopped" });
  expect(anchors).toEqual(["closed"]);
  // the new pipeline can now run on the case
  r2.engine.start(person);
  expect(await r2.engine.advance()).toMatchObject({ status: "waiting", waiting: "plan" });
});

test("only a person stops a run, with a reason, and only one in progress; waiting at a gate counts", async () => {
  const r = rig();
  expect(() => r.engine.stop(person, "nothing to stop")).toThrow(RunRefused);
  r.engine.start(person);
  await r.engine.advance();
  expect(r.engine.summary().waiting).toBe("plan");
  const before = types(f.s).length;
  expect(() => r.engine.stop(planner, "an agent")).toThrow(RunRefused);
  expect(() => r.engine.stop(person, "  ")).toThrow(RunRefused);
  expect(types(f.s).length).toBe(before);
  r.engine.stop(person, "wrong question");
  expect(f.s.state.run).toMatchObject({ status: "finished", outcome: "stopped" });
  expect(() => r.engine.stop(person, "again")).toThrow(RunRefused);
});

test("a run stopped while a stage works goes no further", async () => {
  const hold = waitFor();
  const r = rig({ research: async () => { r.log.push("research"); await hold.gate; return PASS; } });
  r.engine.start(person);
  await r.engine.advance();
  acceptPlan(f.s);
  const driving = r.engine.advance();
  await Bun.sleep(5);
  r.engine.stop(person, "enough");
  hold.release();
  const sum = await driving;
  expect(sum).toMatchObject({ status: "finished", outcome: "stopped" });
  expect(r.log).not.toContain("assemble");
});

test("an engine built on a case writes nothing to it; Engine.open recovers it, once", () => {
  const leftover = (): void => {
    f.s.commit((_st, ids) => [{
      type: "query.issued", actor: planner,
      payload: { query: ids.next("query"), source: "x", source_hash: "h", pivot: null, pivot_hash: null, connector: "c", text: "t", bound: {}, window: WINDOW, why: "w", estimate: null, step: null, verifies: null, purpose: "result" },
    }]);
  };
  leftover();
  const before = f.s.head();
  const reader = new Engine(f.s, depsOf(f.sample));
  expect(reader.summary().status).toBe("none");
  expect(f.s.head()).toEqual(before);
  expect(f.s.state.queries.q1!.status).toBe("running");
  Engine.open(f.s, depsOf(f.sample));
  expect(f.s.state.queries.q1!.status).toBe("failed");
  leftover();
  Engine.open(f.s, depsOf(f.sample)).recover();
  expect(f.s.state.queries.q2!.status).toBe("running");
});

test("a very long reason is clipped, so the run pauses saying why instead of failing to record it", async () => {
  const long = "x".repeat(300 * 1024);
  const r = rig({ frame: async () => ({ kind: "finished", outcome: "fail", draft_hash: null, output: null, reason: long }) });
  r.engine.start(person);
  const sum = await r.engine.advance();
  expect(sum.status).toBe("paused");
  const fin = f.s.entries().filter((e) => e.type === "stage.finished");
  expect(fin.length).toBeGreaterThan(0);
  for (const e of fin) if (e.type === "stage.finished") expect(e.payload.reason!.length).toBeLessThanOrEqual(4000);
  expect(sum.pause_reason!.length).toBeLessThanOrEqual(4000);
  const stalled = rig({ frame: async () => ({ kind: "stalled", reason: long }) });
  stalled.engine.stop(person, "again");
  stalled.engine.start(person);
  const again = await stalled.engine.advance();
  expect(again).toMatchObject({ status: "paused" });
  expect(again.pause_reason!.length).toBe(4000);
});

test("a resume that resumed nothing grants no allowance of its own: the resume that did grants the only one", async () => {
  const r: Rig = rig({ checks: failingChecks(() => r) });
  r.engine.start(person);
  await r.engine.advance();
  acceptPlan(f.s);
  expect((await r.engine.advance()).status).toBe("paused");
  // the run is set going again by another hand, so a person's resume finds nothing to resume
  f.s.commit((st) => [{ type: "run.resumed", actor: person, payload: {}, run: st.run.id }]);
  const before = f.s.entries().filter((e) => e.type === "run.resumed").length;
  const sum = await r.engine.resume(person);
  expect(f.s.entries().filter((e) => e.type === "run.resumed").length).toBe(before);
  // the other hand's resume granted three more; this one, which resumed nothing, granted none on top
  expect(f.s.state.run.sendbacks).toEqual({ "checks>assemble": 6 });
  expect(sum.status).toBe("paused");
});

test("a stage that ends after the person stopped the run writes nothing", async () => {
  let r!: Rig;
  let stopSeq = 0;
  r = rig({
    frame: async () => {
      r.engine.stop(person, "enough");
      stopSeq = f.s.head().seq;
      return PASS;
    },
  });
  r.engine.start(person);
  await r.engine.advance();
  expect(stopSeq).toBeGreaterThan(0);
  const after = f.s.entries().filter((e) => e.seq > stopSeq).map((e) => e.type);
  expect(after).toEqual([]);
  expect(f.s.state.run).toMatchObject({ status: "finished", outcome: "stopped" });
});

test("a declined, blocked or stalled stage that ends after the person stopped the run writes nothing either", async () => {
  for (const end of [{ kind: "declined", reason: "policy" }, { kind: "blocked", marking: "TLP:RED" }, { kind: "stalled", reason: "x" }] as const) {
    const g = fixture(false);
    try {
      const deps = depsOf(g.sample);
      let stopSeq = 0;
      const r = rig({ frame: async () => { r.engine.stop(person, "enough"); stopSeq = g.s.head().seq; return end; } }, g.s, deps);
      r.engine.start(person);
      await r.engine.advance();
      expect(g.s.entries().filter((e) => e.seq > stopSeq).map((e) => e.type)).toEqual([]);
      expect(g.s.state.skipped).toEqual([]);
    } finally { g.close(); }
  }
});

test("a case too strict for the stage's model says the case is the problem", async () => {
  const wb = Workbench.open(join(dir, "wb-red"), { onError: () => {} });
  extra.push(() => wb.close());
  const s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [{ type: "address", value: START }], window: WINDOW, objective: null, marking: "TLP:RED" }, person);
  const r = rig({
    frame: async () => {
      s.commit(() => [{ type: "model.blocked", actor: planner, payload: { stage: "frame", marking: "TLP:RED", model: "m", where: "network" } }]);
      return { kind: "blocked", marking: "TLP:RED" };
    },
  }, s);
  r.engine.start(person);
  await r.engine.advance();
  expect(s.state.run.pause_reason).toBe("Frame: this case is marked TLP:RED, which this stage's model may not receive. Choose a model that may receive TLP:RED and resume.");
  expect(s.state.skipped).toEqual([]);
});

test("the pause reason reads the blocked stage's own model.blocked, not a later one by your agent", async () => {
  const wb = Workbench.open(join(dir, "wb-red-agent"), { onError: () => {} });
  extra.push(() => wb.close());
  const s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [{ type: "address", value: START }], window: WINDOW, objective: null, marking: "TLP:RED" }, person);
  const assistant = { kind: "agent", id: "assistant", stage: "agent", profile: "investigation", model: "m", effort: null, where: "machine" } as const;
  const r = rig({
    frame: async () => {
      s.commit(() => [{ type: "model.blocked", actor: planner, payload: { stage: "frame", marking: "TLP:RED", model: "m", where: "network" } }]);
      // a question to your agent is blocked while the stage's block is being reported
      s.commit(() => [{ type: "model.blocked", actor: assistant, payload: { stage: "agent", marking: "TLP:RED", model: "m", where: "machine" } }]);
      return { kind: "blocked", marking: "TLP:RED" };
    },
  }, s);
  r.engine.start(person);
  await r.engine.advance();
  expect(s.state.run.pause_reason).toBe("Frame: this case is marked TLP:RED, which this stage's model may not receive. Choose a model that may receive TLP:RED and resume.");
  expect(s.state.skipped).toEqual([]);
});

test("a case above the stage's pack limit says the case is the problem too", async () => {
  f.s.commit(() => [{ type: "stage.pack_limit_set", actor: person, payload: { stage: "frame", max_marking: "TLP:CLEAR" } }]);
  const r = rig({
    frame: async () => {
      f.s.commit(() => [{ type: "model.blocked", actor: planner, payload: { stage: "frame", marking: "TLP:GREEN", model: "m", where: "machine" } }]);
      return { kind: "blocked", marking: "TLP:GREEN" };
    },
  });
  r.engine.start(person);
  await r.engine.advance();
  expect(f.s.state.run.pause_reason).toBe("Frame: this case is marked TLP:GREEN, which this stage's model may not receive. Choose a model that may receive TLP:GREEN and resume.");
});

// ---- a ruling can be revised while its run is in progress (slice 8) ----

const engineActor = { kind: "system", id: "engine" } as const;
const f1At = (likelihood: string): Product => ({
  ...product(0), summary: `f1 ${likelihood}`,
  key_findings: [{ id: "f1", statement: `We assess it is ${likelihood} that the device is idle.`, likelihood, confidence: "moderate", confidence_basis: "b", cites: [], assumptions: [], reasoning: "r" }],
});
/** An assemble stub that writes f1 at each likelihood in turn (the last one again once they are used up). */
const assembling = (s: CaseSession, likelihoods: string[]): StageRunner => async () => {
  const p = f1At(likelihoods.length > 1 ? likelihoods.shift()! : likelihoods[0]!);
  const hash = sha256Hex(canonical(p as unknown as Json));
  s.commit((st) => [{ type: "draft.revised", actor: planner, payload: { draft: { n: st.drafts.length + 1, hash, author: planner, product: p, reason: "r" } } }]);
  return { ...PASS, draft_hash: hash };
};
const K1_REASON = "Evaluate and Challenge disagree on f1: Evaluate asks almost certain, Challenge asked lower";
/** The disagreement on f1 the person rules on, recorded against the latest draft. */
const conflictOnF1 = (s: CaseSession, on?: string) => s.commit((st, ids) => [{ type: "review.conflict", actor: engineActor, run: st.run.id, payload: { conflict: {
  id: ids.next("conflict"), draft_hash: on ?? latestDraft(st)?.hash ?? "h", finding: "f1", change: "likelihood", earlier: "almost certain", now: "likely", raised_by: "evaluate", changed_for: "challenge",
  asks: "almost certain", asked: "lower", points: ["f1: understates it"], reason: K1_REASON,
} } }]);

test("a conflict may be ruled again while its run is in progress; the same ruling again is refused", async () => {
  const r = rig();
  r.engine.start(person);
  await r.engine.advance();
  conflictOnF1(r.s);
  r.engine.rule(person, "k1", "challenge", "");
  expect(() => r.engine.rule(person, "k1", "challenge", " ")).toThrow("that is already the ruling on k1");
  r.engine.rule(person, "k1", "evaluate", "the card shows it");
  const ruled = r.s.entries().filter((e) => e.type === "review.ruled");
  expect(ruled.map((e) => e.payload)).toEqual([{ conflict: "k1", follow: "challenge", note: "" }, { conflict: "k1", follow: "evaluate", note: "the card shows it" }]);
  expect(r.s.state.conflicts.k1!.ruling).toMatchObject({ follow: "evaluate", note: "the card shows it" });
  expect(r.s.state.conflicts.k1!.earlier_rulings).toHaveLength(1);
  // a revision away from the publish gate writes the ruling alone
  expect(r.s.entries().filter((e) => e.type === "stage.sent_back")).toEqual([]);
  r.engine.stop(person, "enough");
  expect(() => r.engine.rule(person, "k1", "challenge", "")).toThrow(RunRefused);
  expect(() => r.engine.rule(person, "k1", "challenge", "")).toThrow("conflict k1 is from a run that is over");
});

test("a ruling revised after the draft was made to the earlier one sends the work back at the next review with the new ruling", async () => {
  // draft 1 says likely, as the first ruling (follow Challenge) keeps it; the person revises the ruling while Checks works on it
  let first = true;
  const r = rig({
    assemble: assembling(f.s, ["likely", "almost certain"]),
    checks: async () => {
      if (first) {
        first = false;
        // the disagreement was on an earlier draft of this run
        conflictOnF1(f.s, "0".repeat(64));
        r.engine.rule(person, "k1", "challenge", "");
        r.engine.rule(person, "k1", "evaluate", "the card shows it");
      }
      return { ...PASS, draft_hash: latestDraft(f.s.state)!.hash };
    },
    evaluate: async () => {
      const d = latestDraft(f.s.state)!;
      if (d.product.key_findings[0]!.likelihood === "almost certain") return { ...PASS, draft_hash: d.hash };
      f.s.commit(() => [{ type: "evaluation.made", actor: engineActor, payload: { draft_hash: d.hash, pass: false, findings: [{ check: "support", where: "f2", message: "f2 is missing" }] } }]);
      return { kind: "finished", outcome: "fail", draft_hash: d.hash, output: null, reason: "f2 is missing" };
    },
  });
  r.engine.start(person);
  await r.engine.advance();
  acceptPlan(r.s);
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  const back = r.s.entries().filter((e): e is Extract<Entry, { type: "stage.sent_back" }> => e.type === "stage.sent_back");
  expect(back.map((e) => e.payload.from)).toEqual(["evaluate"]);
  expect(back[0]!.payload.reason).toStartWith(`the draft does not hold the person's ruling on f1 (${K1_REASON}): follow Evaluate: almost certain. Note: the card shows it`);
  expect(back[0]!.payload.reason).toEndWith("Also: f2: f2 is missing");
  expect(latestDraft(r.s.state)!.product.key_findings[0]!.likelihood).toBe("almost certain");
});

test("a ruling revised at the publish gate sends nothing back by itself; Send back with my changes takes it, and an answer given there, to Assemble", async () => {
  // slice 10 (reverses controller ruling 6): the person's changes at the gate wait for their one send-back; the gate is not passed
  const r = rig({ assemble: assembling(f.s, ["likely", "almost certain"]) });
  r.engine.start(person);
  await r.engine.advance();
  acceptPlan(r.s);
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  conflictOnF1(r.s);
  r.engine.rule(person, "k1", "challenge", "");
  const head = r.s.head().seq;
  r.engine.rule(person, "k1", "evaluate", "the card shows it");
  expect(r.s.entries().filter((e) => e.seq > head).map((e) => e.type)).toEqual(["review.ruled"]);
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  ask(r.s, "research", false);
  answerIt(r.s, "ask-1");
  const card = r.s.state.questions["ask-1"]!.answer!.card;
  const d = latestDraft(r.s.state)!;
  expect(gateChanges(r.s.state, r.s.entries()).map((c) => [c.kind, c.id, c.finding])).toEqual([["ruling", "k1", "f1"], ["answer", "ask-1", null]]);
  const mid = r.s.head().seq;
  r.engine.sendBackChanges(person, d.hash);
  expect(r.s.entries().filter((e) => e.seq > mid).map((e) => e.type)).toEqual(["stage.sent_back", "case.phase_changed", "stage.started"]);
  const back = r.s.entries().find((e): e is Extract<Entry, { type: "stage.sent_back" }> => e.type === "stage.sent_back")!;
  expect(back.payload).toEqual({ from: "publish", to: "assemble", count: 1, reason:
    `the person revised the ruling on f1 (${K1_REASON}): follow Evaluate: almost certain. Note: the card shows it ` +
    `the person answered ask-1: their answer is card ${card}, a statement of theirs; read it and say whether it changes any finding.` });
  expect(r.s.entries().some((e) => e.type === "gate.passed" && e.payload.gate === "publish")).toBe(false);
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(latestDraft(r.s.state)!.product.key_findings[0]!.likelihood).toBe("almost certain");
  // the new draft was made after the changes: none is listed for it
  expect(gateChanges(r.s.state, r.s.entries())).toEqual([]);
});

// ---------- slice 8: a blocking question holds the run after its stage's pass (controller ruling 4) ----------

const agentOf = (stage: string): Actor => ({ kind: "agent", id: stage === "plan" ? "planner" : `${stage}er`, stage, profile: "investigation", model: "m", effort: null, where: "machine" });
/** A stage's agent asks the person, as ask_person would. */
const ask = (s: CaseSession, stage: string, blocking = true, text = "Who owns the laptop?"): void => {
  s.commit((st, ids) => [{
    type: "question.asked", actor: agentOf(stage), run: st.run.id, stage,
    payload: { question: { id: ids.next("question"), text, why: "it decides the finding", cards: [], about: [], blocking } },
  }]);
};
const answerIt = (s: CaseSession, question: string): void => {
  answerQuestion(s, f.sample.deps, { actor: person, question, answer: "Pat in the gym.", basis: "saw", detail: "", about: null, marking: null });
};
const stageOf = (s: CaseSession, id: string) => s.state.run.stages.find((x) => x.id === id)!;
const WAITING_ASK1 = "waiting for the person's answer to ask-1. Answer it in the Narrative lens, or resume to go on without it.";

/** A rig whose Research stage asks the person (blocking unless told otherwise) the first time it runs. */
function asking(over: { blocking?: boolean; stage?: string; outcome?: "pass" | "fail" } = {}, s: CaseSession = f.s, deps?: EngineDeps): Rig & { runs: Record<string, number> } {
  const runs: Record<string, number> = {};
  const stage = over.stage ?? "research";
  const r = rig({
    research: async () => {
      runs.research = (runs.research ?? 0) + 1;
      r.log.push("research");
      if (runs.research === 1) ask(s, stage, over.blocking ?? true);
      return { ...PASS, outcome: over.outcome ?? "pass", reason: over.outcome === "fail" ? "research failed" : null };
    },
  }, s, deps);
  return { ...r, runs };
}
async function toResearch(r: Rig): Promise<void> {
  r.engine.start(person);
  await r.engine.advance();
  acceptPlan(r.s);
}

test("a stage that passes with a blocking question unanswered records its pass, and the run pauses before the next stage, waiting for the answer", async () => {
  const r = asking();
  await toResearch(r);
  const sum = await r.engine.advance();
  const finished = r.s.entries().filter((e) => e.type === "stage.finished" && e.payload.stage === "research");
  expect(finished).toHaveLength(1);
  expect(finished[0]!.type === "stage.finished" && finished[0]!.payload.outcome).toBe("pass");
  expect(sum).toMatchObject({ status: "paused", pause_reason: WAITING_ASK1, current: "research" });
  expect(r.s.state.run.hold).toEqual({ kind: "question", stage: "research" });
  expect(stageOf(r.s, "research").status).toBe("passed");
  expect(r.log).toEqual(["frame", "plan", "research"]);
  expect(types(r.s).slice(-2)).toEqual(["stage.finished", "run.paused"]);
});

test("resumed without an answer, the run goes on to the next stage without running the stage again; the question is waived and still open", async () => {
  const r = asking();
  await toResearch(r);
  await r.engine.advance();
  const sum = await r.engine.resume(person);
  expect(r.runs.research).toBe(1);
  expect(r.s.state.questions["ask-1"]).toMatchObject({ answer: null, waived: { by: "analyst" } });
  expect(r.log).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish"]);
  expect(sum.waiting).toBe("publish");
  expect(r.s.entries().filter((e) => e.type === "run.paused")).toHaveLength(1);
});

test("answered and resumed, the run goes on, with nothing waived and the stage run once", async () => {
  const r = asking();
  await toResearch(r);
  await r.engine.advance();
  answerIt(r.s, "ask-1");
  const sum = await r.engine.resume(person);
  expect(r.runs.research).toBe(1);
  expect(r.s.state.questions["ask-1"]!.waived).toBeNull();
  expect(r.s.state.questions["ask-1"]!.answer).not.toBeNull();
  expect(sum.waiting).toBe("publish");
});

test("a question that is not blocking, one another stage asked, one of an earlier run, and a waived one do not hold a pass", async () => {
  // not blocking
  const a = asking({ blocking: false });
  await toResearch(a);
  expect((await a.engine.advance()).waiting).toBe("publish");
  // asked as another stage
  const wb = Workbench.open(join(dir, "wb-other"), { onError: () => {} });
  extra.push(() => wb.close());
  const mk = () => wb.createCase({ title: "t", asked: "a", why: "w", starting: [{ type: "address", value: START }], window: WINDOW, objective: null, marking: "TLP:GREEN" }, person);
  const s2 = mk();
  const b = asking({ stage: "frame" }, s2);
  await toResearch(b);
  expect((await b.engine.advance()).waiting).toBe("publish");
  expect(s2.state.skipped).toEqual([]);
  // of an earlier run: the first run asks at Research and is stopped; the second run's Research pass is not held
  const s3 = mk();
  const c = rig({}, s3);
  c.engine.start(person);
  await c.engine.advance();
  ask(s3, "research");
  c.engine.stop(person, "start over");
  c.engine.start(person);
  await c.engine.advance();
  acceptPlan(s3);
  expect((await c.engine.advance()).waiting).toBe("publish");
  expect(s3.state.skipped).toEqual([]);
  // waived: Research's question was held and the person went on without it before Research's pass
  const s4 = mk();
  const d = rig({}, s4);
  d.engine.start(person);
  await d.engine.advance();
  ask(s4, "research");
  s4.commit((st) => [{ type: "run.paused", actor: { kind: "system", id: "engine" }, run: st.run.id, payload: { reason: "held", hold: { kind: "question", stage: "research" } } }]);
  await d.engine.resume(person);
  expect(s4.state.questions["ask-1"]!.waived).not.toBeNull();
  acceptPlan(s4);
  expect((await d.engine.advance()).waiting).toBe("publish");
  expect(s4.entries().filter((e) => e.type === "run.paused")).toHaveLength(1);
  expect(s4.state.skipped).toEqual([]);
});

test("a stage that fails is not held: it goes where a failure goes", async () => {
  const r = asking({ outcome: "fail" });
  await toResearch(r);
  const sum = await r.engine.advance();
  expect(r.s.entries().filter((e) => e.type === "run.paused" && e.payload.hold?.kind === "question")).toEqual([]);
  expect(stageOf(r.s, "research").status).toBe("failed");
  expect(sum.pause_reason).not.toBe(WAITING_ASK1);
});

test("a blocking question answered while its stage was still working holds nothing: the stage runs once and the run goes on", async () => {
  const runs = { assemble: 0 };
  const r = rig({
    assemble: async () => {
      runs.assemble++;
      if (runs.assemble === 1) { ask(f.s, "assemble"); answerIt(f.s, "ask-1"); }
      f.s.commit(() => [{ type: "draft.revised", actor: planner, payload: { draft: makeDraft(f.s.state.drafts.length + 1) } }]);
      return PASS;
    },
  });
  await toResearch(r);
  const sum = await r.engine.advance();
  expect(runs.assemble).toBe(1);
  expect(types(f.s)).not.toContain("run.paused");
  expect(sum.waiting).toBe("publish");
});

test("a held Plan does not run again on resume, and the plan gate waits on the plan it proposed", async () => {
  let plans = 0;
  const r = rig({
    plan: async () => {
      plans++;
      f.s.commit((_st, ids) => [{ type: "plan.proposed", actor: planner, payload: { plan: PLAN(ids.next("plan")) } }]);
      if (plans === 1) ask(f.s, "plan");
      return PASS;
    },
  });
  r.engine.start(person);
  const held = await r.engine.advance();
  expect(held).toMatchObject({ status: "paused", pause_reason: WAITING_ASK1, current: "plan" });
  expect(types(f.s)).not.toContain("gate.waiting");
  const sum = await r.engine.resume(person);
  expect(plans).toBe(1);
  expect(sum).toMatchObject({ status: "waiting", waiting: "plan" });
  expect(f.s.state.plan.current!.id).toBe("plan-1");
  expect(f.s.entries().filter((e) => e.type === "plan.proposed")).toHaveLength(1);
});

test("stopping a run that waits for an answer finishes it", async () => {
  const r = asking();
  await toResearch(r);
  await r.engine.advance();
  r.engine.stop(person, "no answer coming");
  expect(r.s.state.run.status).toBe("finished");
  expect(r.s.state.run.outcome).toBe("stopped");
});

test("a restart finds the held run paused, and a resume goes on to the next stage", async () => {
  const wbDir = join(dir, "wb-held");
  const sample = sampleRoot(join(dir, "s-held"));
  extra.push(() => sample.close());
  const deps = depsOf(sample);
  const wb1 = Workbench.open(wbDir, { onError: () => {} });
  const s1 = wb1.createCase({ title: "t", asked: "a", why: "w", starting: [{ type: "address", value: START }], window: WINDOW, objective: null, marking: "TLP:GREEN" }, person);
  const r1 = asking({}, s1, deps);
  await toResearch(r1);
  await r1.engine.advance();
  expect(s1.state.run.status).toBe("paused");
  wb1.close();
  const wb2 = Workbench.open(wbDir, { onError: () => {} });
  extra.push(() => wb2.close());
  const s2 = wb2.session(s1.id);
  const r2 = asking({}, s2, deps);
  expect(r2.engine.summary()).toMatchObject({ status: "paused", pause_reason: WAITING_ASK1 });
  expect(s2.state.run.hold).toEqual({ kind: "question", stage: "research" });
  const sum = await r2.engine.resume(person);
  expect(r2.runs.research).toBeUndefined();
  expect(sum.waiting).toBe("publish");
  expect(s2.state.skipped).toEqual([]);
});
