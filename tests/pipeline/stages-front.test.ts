import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import type { Entry } from "../../src/core/types";
import { loadProfile } from "../../src/agents/context";
import { Providers } from "../../src/agents/providers";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import type { ScriptReply } from "../../src/agents/providers/scripted";
import { loadConfig } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnd, StageRunner } from "../../src/pipeline/engine";
import { loadPipeline } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { frameRunner } from "../../src/pipeline/stages/frame";
import { planRunner } from "../../src/pipeline/stages/plan";
import { researchRunner } from "../../src/pipeline/stages/research";
import { lastOutput } from "../../src/pipeline/stages/agent";
import { fixture, person } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
let dir: string;
beforeEach(() => { f = fixture(false); dir = mkdtempSync(join(tmpdir(), "front-")); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
  rmSync(dir, { recursive: true, force: true });
});

const ASSET = "ws-17.example.net";
const FRAME = {
  goals: [{ title: "Explain the traffic", question: "What is the address?", want: "account" }],
  window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" },
  limits: { allow_unconfirmed: false, max_weight: null }, notes: "n",
};
/** g1 is free (address, asset, account); g2 is the costly reputation lookup. `from` is what g1 starts from. */
const planOut = (from = "192.0.2.17", route1 = ["address_to_asset", "asset_to_accounts"]) => ({
  goal: "who is behind the address",
  subgoals: [
    { title: "Who uses it", question: "Which accounts?", have: [{ type: "address", value: from }], want: "account", route: route1 },
    { title: "Reputation", question: "What is known?", have: [{ type: "address", value: "198.51.100.77" }], want: "verdict", route: ["address_to_verdict"] },
  ],
});
const say = (x: unknown): ScriptReply => ({ content: JSON.stringify(x) });
const call = (tool: string, args: Record<string, Json>): { tool: string; args: Record<string, Json> } => ({ tool, args: { why: "w", ...args } });
const calls = (...c: { tool: string; args: Record<string, Json> }[]): ScriptReply => ({ tool_calls: c });
const answered = (note = "done"): ScriptReply => say({ outcome: "answered", found: [], note });
const G1: ScriptReply[] = [calls(call("run_step", { step: "s1" }), call("run_step", { step: "s2", value: ASSET })), answered("accounts found")];
const G2: ScriptReply[] = [calls(call("run_step", { step: "s3" })), answered("verdict asked for")];

interface Rig { engine: Engine; deps: EngineDeps }
function rig(replies: Record<string, ScriptReply[]>, opts: { parallel?: number; runners?: Partial<Record<Role, StageRunner>> } = {}): Rig {
  const registry = f.sample.registry;
  const { pipeline, problems } = loadPipeline(registry);
  if (pipeline === null) throw new Error(problems.join("; "));
  const turns = Object.entries(replies).flatMap(([actor, rs]) => rs.map((reply) => ({ actor, reply })));
  const base = loadConfig({ env: {}, home: dir, repoRoot: dir });
  const deps: EngineDeps = {
    config: { ...base, research: { parallel: opts.parallel ?? base.research.parallel } }, registry, runner: f.sample.deps, seeker: f.sample.seeker,
    providers: new Providers([new ScriptedProvider({ id: "scripted", scripts: [{ id: "sample-run", turns }] })]), pipeline, profile: loadProfile(registry, "investigation"),
  };
  return { engine: new Engine(f.s, deps, opts.runners === undefined ? {} : { runners: opts.runners }), deps };
}
const ofType = <T extends Entry["type"]>(t: T): Extract<Entry, { type: T }>[] => f.s.entries().filter((e): e is Extract<Entry, { type: T }> => e.type === t);
const finished = (stage: string) => ofType("stage.finished").filter((e) => e.payload.stage === stage);
const output = (stage: string): Record<string, Json> => lastOutput(f.s, stage) as Record<string, Json>;
/** Runs Frame and Plan; the run waits at the plan gate. */
async function toGate(r: Rig): Promise<void> {
  r.engine.start(person);
  const sum = await r.engine.advance();
  expect(sum).toMatchObject({ status: "waiting", waiting: "plan" });
}

test("Frame's validated output is the stage's output blob", async () => {
  const r = rig({ orchestrator: [say(FRAME)], planner: [say(planOut())] });
  await toGate(r);
  expect(output("frame")).toEqual(FRAME);
  expect(finished("frame").map((e) => e.payload.outcome)).toEqual(["pass"]);
  const req = ofType("model.request")[0]!;
  expect(req.actor).toMatchObject({ id: "orchestrator", stage: "frame" });
  expect(f.s.blobs.text(req.payload.messages.blob)).toContain("198.51.100.77");
});

test("Plan proposes a plan and the run waits at the plan gate; nothing has run", async () => {
  const r = rig({ orchestrator: [say(FRAME)], planner: [say(planOut())] });
  await toGate(r);
  const plan = f.s.state.plan;
  expect(plan.status).toBe("proposed");
  expect(plan.current!.steps.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  expect(ofType("plan.proposed")[0]!.actor).toMatchObject({ kind: "agent", id: "planner", stage: "plan" });
  expect(ofType("query.issued")).toEqual([]);
  expect(ofType("step.started")).toEqual([]);
  expect(output("plan")).toEqual(planOut());
  expect(ofType("gate.waiting").map((e) => e.payload.gate)).toEqual(["plan"]);
});

test("Plan's route errors go back to the planner once, then the run pauses", async () => {
  const bad = planOut("192.0.2.17", ["address_to_verdict"]);
  const r = rig({ orchestrator: [say(FRAME)], planner: [say(bad), say(bad)] });
  r.engine.start(person);
  const sum = await r.engine.advance();
  expect(sum.status).toBe("paused");
  expect(sum.pause_reason).toContain("is not one the route finder offers");
  const asks = ofType("model.request").filter((e) => e.actor.id === "planner");
  expect(asks).toHaveLength(2);
  expect(f.s.blobs.text(asks[1]!.payload.messages.blob)).toContain("the route address_to_verdict is not one the route finder offers from address to account");
  expect(ofType("plan.proposed")).toEqual([]);
  expect(finished("plan")).toEqual([]);
});

test("Plan accepts a route that is right the second time", async () => {
  const r = rig({ orchestrator: [say(FRAME)], planner: [say(planOut("192.0.2.17", ["address_to_verdict"])), say(planOut())] });
  await toGate(r);
  expect(ofType("model.request").filter((e) => e.actor.id === "planner")).toHaveLength(2);
  expect(f.s.state.plan.status).toBe("proposed");
});

test("a re-plan request runs the planner again with the note", async () => {
  const r = rig({ orchestrator: [say(FRAME)], planner: [say(planOut()), say(planOut("192.0.2.17", ["address_to_asset", "asset_to_accounts"]))] });
  await toGate(r);
  r.engine.replan({ note: "also check the lease records", actor: person });
  const sum = await r.engine.advance();
  expect(sum).toMatchObject({ status: "waiting", waiting: "plan" });
  const asks = ofType("model.request").filter((e) => e.actor.id === "planner");
  expect(asks).toHaveLength(2);
  expect(f.s.blobs.text(asks[0]!.payload.messages.blob)).not.toContain("also check the lease records");
  expect(f.s.blobs.text(asks[1]!.payload.messages.blob)).toContain("also check the lease records");
  expect(f.s.state.plan.current!.id).toBe("plan-2");
  expect(f.s.state.plan.status).toBe("proposed");
});

test("the plan commands are the engine's and none advances", async () => {
  const r = rig({ orchestrator: [say(FRAME)], planner: [say(planOut())] });
  await toGate(r);
  r.engine.denyPlan({ reason: "wrong question", actor: person });
  expect(r.engine.summary()).toMatchObject({ status: "finished", outcome: "stopped" });
  expect(ofType("model.request")).toHaveLength(2);
});

/** Frame, Plan, the person's acceptance, then Research (the run stops at Assemble, which has no runner here). */
async function researched(replies: Record<string, ScriptReply[]>, accept: { steps?: string[]; budgets?: Record<string, number> } = {}, opts: Parameters<typeof rig>[1] = {}): Promise<Rig> {
  const r = rig({ orchestrator: [say(FRAME)], planner: [say(planOut())], ...replies }, opts);
  await toGate(r);
  r.engine.acceptPlan({ actor: person, ...accept });
  await r.engine.advance();
  return r;
}
const jobs = () => ofType("job.started").map((e) => e.payload.title);

test("Research runs one researcher per sub-goal, each as its own job", async () => {
  await researched({ "researcher-g1": G1, "researcher-g2": G2 }, { budgets: { s3: 1 } });
  expect(jobs()).toEqual(["Research: Who uses it", "Research: Reputation"]);
  expect(ofType("job.started").map((e) => [e.payload.kind, e.payload.source])).toEqual([["research", null], ["research", null]]);
  expect(ofType("job.finished").map((e) => e.payload.outcome)).toEqual(["done", "done"]);
  const g1 = ofType("model.request").filter((e) => e.actor.id === "researcher-g1");
  const job1 = ofType("job.started")[0]!.payload.job;
  expect(g1.length).toBe(2);
  expect(g1.every((e) => e.job === job1 && e.stage === "research")).toBe(true);
  expect(finished("research")[0]!.payload.outcome).toBe("pass");
});

test("no more researchers run at once than the configured number", async () => {
  await researched({ "researcher-g1": G1, "researcher-g2": G2 }, { budgets: { s3: 1 } }, { parallel: 1 });
  expect(f.s.entries().filter((e) => e.type === "job.started" || e.type === "job.finished").map((e) => e.type)).toEqual(["job.started", "job.finished", "job.started", "job.finished"]);
});

test("a dead end is followed by a re-route, and the sub-goal is answered", async () => {
  // 198.51.100.77 is no asset (s1 is empty); a free pivot finds who talked to it; s2 then runs on an asset
  const dead: ScriptReply[] = [
    calls(call("run_step", { step: "s1" })),
    calls(call("run_pivot", { pivot: "address_to_internal_peers", value: "198.51.100.77" })),
    calls(call("run_step", { step: "s2", value: ASSET })),
    answered("re-routed"),
  ];
  const r = rig({ orchestrator: [say(FRAME)], planner: [say(planOut("198.51.100.77"))], "researcher-g1": dead, "researcher-g2": G2 });
  await toGate(r);
  r.engine.acceptPlan({ actor: person, steps: ["s1", "s2"] });
  await r.engine.advance();
  expect(f.s.state.plan.steps.s1!.status).toBe("empty");
  expect(f.s.state.plan.steps.s2!.status).toBe("answered");
  expect(Object.values(f.s.state.queries).map((q) => q.step)).toEqual(["s1", null, "s2"]);
  const sg = (output("research").subgoals as { id: string; outcome: string }[]);
  expect(sg.map((g) => [g.id, g.outcome])).toEqual([["g1", "answered"]]);
});

test("a costly step with a plan budget runs; without one it stays a proposal and its sub-goal is blocked", async () => {
  await researched({ "researcher-g1": G1, "researcher-g2": G2 }, { budgets: { s3: 1 } });
  expect(f.s.state.plan.steps.s3!.status).toBe("answered");
  const accepted = ofType("proposal.accepted");
  expect(accepted).toHaveLength(1);
  expect(accepted[0]!.actor).toEqual(person);
  expect(accepted[0]!.payload).toEqual({ proposal: "p1", budget: 1 });
});

test("a costly step without a budget stays an open proposal and its sub-goal is blocked", async () => {
  await researched({ "researcher-g1": G1, "researcher-g2": G2 });
  expect(f.s.state.plan.steps.s3!.status).toBe("blocked");
  expect(f.s.state.proposals.p1!.status).toBe("open");
  expect(ofType("proposal.accepted")).toEqual([]);
  const sg = output("research").subgoals as { id: string; outcome: string }[];
  expect(sg.find((g) => g.id === "g2")!.outcome).toBe("blocked");
});

test("Research passes with one sub-goal answered and one blocked", async () => {
  await researched({ "researcher-g1": G1, "researcher-g2": G2 });
  const out = output("research") as { subgoals: { id: string; title: string; outcome: string; cards: string[]; note: string }[]; requested: unknown[] };
  expect(finished("research")[0]!.payload.outcome).toBe("pass");
  expect(out.subgoals.map((g) => [g.id, g.title, g.outcome, g.note])).toEqual([
    ["g1", "Who uses it", "answered", "accounts found"], ["g2", "Reputation", "blocked", "verdict asked for"],
  ]);
  expect(out.subgoals[0]!.cards.length).toBe(2);
  expect(out.subgoals[1]!.cards).toEqual([]);
  expect(out.requested).toEqual([]);
});

test("a researcher's claim of success does not make a blocked sub-goal answered", async () => {
  await researched({ "researcher-g1": G1, "researcher-g2": [calls(call("run_step", { step: "s3" })), say({ outcome: "answered", found: [{ type: "verdict", value: "benign" }], note: "it is benign" })] });
  const sg = output("research").subgoals as { id: string; outcome: string; note: string }[];
  expect(sg.find((g) => g.id === "g2")).toMatchObject({ outcome: "blocked", note: "it is benign" });
});

test("Research fails back to Plan when nothing was answered", async () => {
  const r = rig({ orchestrator: [say(FRAME)], planner: [say(planOut()), say(planOut())], "researcher-g2": G2 });
  await toGate(r);
  r.engine.acceptPlan({ actor: person, steps: ["s3"] });
  const sum = await r.engine.advance();
  const fin = finished("research")[0]!.payload;
  expect(fin.outcome).toBe("fail");
  expect(fin.reason).toStartWith("no sub-goal could be answered: ");
  expect(ofType("stage.sent_back").map((e) => [e.payload.from, e.payload.to])).toEqual([["research", "plan"]]);
  expect(sum).toMatchObject({ status: "waiting", waiting: "plan" });
  expect(ofType("plan.proposed")).toHaveLength(2);
  expect(ofType("job.started")).toHaveLength(1);
});

test("a declined researcher ends the stage declined after the others finish, and a restart redoes only that sub-goal", async () => {
  const r = await researched({ "researcher-g1": G1, "researcher-g2": [{ declined: "not this" }, ...G2] });
  expect(f.s.state.run.status).toBe("paused");
  expect(f.s.state.run.pause_reason).toContain("declined");
  expect(finished("research")[0]!.payload.outcome).toBe("declined");
  expect(ofType("job.finished").map((e) => e.payload.outcome).sort()).toEqual(["done", "failed"]);
  await r.engine.resume(person);
  expect(ofType("model.request").filter((e) => e.actor.id === "researcher-g1")).toHaveLength(2);
  expect(ofType("model.request").filter((e) => e.actor.id === "researcher-g2")).toHaveLength(3);
  expect(finished("research").map((e) => e.payload.outcome)).toEqual(["declined", "pass"]);
});

test("research asked for by the analyst runs one researcher per question", async () => {
  let assembled = 0;
  const assemble: StageRunner = async (env): Promise<StageEnd> => {
    if (assembled++ > 0) return { kind: "stopped" };
    const actor = { kind: "agent", id: "analyst", stage: "assemble", profile: "investigation", model: "m", effort: null, where: "machine" } as const;
    env.session.commit(() => [
      { type: "research.requested", actor, payload: { question: "Who owns the asset?", why: "gap" } },
      { type: "research.requested", actor, payload: { question: "Was the address seen before?", why: "gap" } },
    ]);
    return { kind: "finished", outcome: "fail", draft_hash: null, output: null, reason: "needs more research" };
  };
  await researched({
    "researcher-g1": G1, "researcher-g2": G2,
    "researcher-r1": [say({ outcome: "answered", found: [], note: "owner found" })],
    "researcher-r2": [say({ outcome: "blocked", found: [], note: "nothing" })],
  }, { steps: ["s1", "s2"] }, { runners: { assemble } });
  expect(ofType("stage.sent_back").map((e) => [e.payload.from, e.payload.to])).toEqual([["assemble", "research"]]);
  const toolsOf = (actor: string) => ofType("model.request").find((e) => e.actor.id === actor)!.payload.tools;
  expect(toolsOf("researcher-g1")).toContain("run_step");
  expect(toolsOf("researcher-r1")).not.toContain("run_step");
  expect(toolsOf("researcher-r1")).toContain("run_pivot");
  expect(jobs()).toEqual(["Research: Who uses it", "Research: Who owns the asset?", "Research: Was the address seen before?"]);
  expect(ofType("model.request").filter((e) => e.actor.id === "researcher-g1")).toHaveLength(2);
  const out = lastOutput(f.s, "research") as { subgoals: { id: string }[]; requested: { question: string; note: string }[] };
  expect(out.requested).toEqual([{ question: "Who owns the asset?", note: "owner found" }, { question: "Was the address seen before?", note: "nothing" }]);
  expect(finished("research").map((e) => e.payload.outcome)).toEqual(["pass", "pass"]);
});

test("a stage with no output schema stalls instead of passing unvalidated output", async () => {
  const r = rig({});
  r.engine.start(person);
  for (const [id, run] of [["frame", frameRunner], ["plan", planRunner], ["research", researchRunner]] as const) {
    const stage = { ...r.deps.pipeline.stages.find((s) => s.id === id)!, schema: null };
    const end = await run({ session: f.s, deps: r.deps, stage, attempt: 1, onNeedsBudget: async () => null });
    expect(end).toEqual({ kind: "stalled", reason: `stage ${id} has no output schema` });
  }
  expect(ofType("model.request")).toEqual([]);
});

test("a frame window that is backwards or outside the case window fails the stage with a reason", async () => {
  for (const window of [{ from: "2026-11-20T00:00:00.000Z", to: "2026-11-19T00:00:00.000Z" }, { from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z" }]) {
    const r = rig({ orchestrator: [say({ ...FRAME, window })] });
    r.engine.start(person);
    const sum = await r.engine.advance();
    expect(sum.status).toBe("paused");
    expect(finished("frame").at(-1)!.payload).toMatchObject({ outcome: "fail" });
    expect(finished("frame").at(-1)!.payload.reason).toContain("window");
    expect(lastOutput(f.s, "frame")).toBeNull();
    f.s.commit((st) => [{ type: "run.finished", actor: { kind: "system", id: "engine" }, run: st.run.id, payload: { outcome: "stopped" } }]);
  }
});

test("a sent-back rerun does not redo a requested question whose researcher finished", async () => {
  let assembled = 0;
  const assemble: StageRunner = async (env): Promise<StageEnd> => {
    if (assembled++ > 0) return { kind: "stopped" };
    const actor = { kind: "agent", id: "analyst", stage: "assemble", profile: "investigation", model: "m", effort: null, where: "machine" } as const;
    env.session.commit(() => [
      { type: "research.requested", actor, payload: { question: "Q one?", why: "gap" } },
      { type: "research.requested", actor, payload: { question: "Q two?", why: "gap" } },
    ]);
    return { kind: "finished", outcome: "fail", draft_hash: null, output: null, reason: "more" };
  };
  const r = await researched({
    "researcher-g1": G1, "researcher-g2": G2,
    "researcher-r1": [answered("one")], "researcher-r2": [{ declined: "not now" }, answered("two")],
  }, { steps: ["s1", "s2"] }, { runners: { assemble } });
  expect(f.s.state.run.status).toBe("paused");
  await r.engine.resume(person);
  expect(ofType("model.request").filter((e) => e.actor.id === "researcher-r1")).toHaveLength(1);
  expect(ofType("model.request").filter((e) => e.actor.id === "researcher-r2")).toHaveLength(2);
  const out = lastOutput(f.s, "research") as { requested: { question: string }[] };
  expect(out.requested.map((x) => x.question)).toEqual(["Q one?", "Q two?"]);
});
