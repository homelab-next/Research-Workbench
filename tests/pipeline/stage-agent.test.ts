import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../../src/core/types";
import { loadProfile } from "../../src/agents/context";
import type { PackPart } from "../../src/agents/context";
import { Providers } from "../../src/agents/providers";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import type { Script, ScriptReply } from "../../src/agents/providers/scripted";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnv } from "../../src/pipeline/engine";
import { loadPipeline } from "../../src/pipeline/manifests";
import { frameOf, lastOutput, stageAgent } from "../../src/pipeline/stages/agent";
import { fixture, person, WINDOW } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
let dir: string;
beforeEach(() => { f = fixture(false); dir = mkdtempSync(join(tmpdir(), "stage-agent-")); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
  rmSync(dir, { recursive: true, force: true });
});

const FRAME = {
  goals: [{ title: "Explain the traffic", question: "What is the address?", want: "account" }],
  window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" },
  limits: { allow_unconfirmed: false, max_weight: null }, notes: "n",
};
const say = (x: unknown): ScriptReply => ({ content: JSON.stringify(x) });

function rig(scripts: Script[], over: Partial<Config> = {}) {
  const registry = f.sample.registry;
  const { pipeline, problems } = loadPipeline(registry);
  if (pipeline === null) throw new Error(problems.join("; "));
  const deps: EngineDeps = {
    config: { ...loadConfig({ env: {}, home: dir, repoRoot: dir }), ...over }, registry, runner: f.sample.deps, seeker: f.sample.seeker,
    providers: new Providers([new ScriptedProvider({ id: "scripted", scripts })]), pipeline, profile: loadProfile(registry, "investigation"),
  };
  const engine = new Engine(f.s, deps);
  const env = (stage = "frame"): StageEnv => ({ session: f.s, deps, stage: pipeline.stages.find((s) => s.id === stage)!, attempt: 1, onNeedsBudget: async () => null });
  return { engine, deps, env };
}
const script = (...replies: ScriptReply[]): Script[] => [{ id: "sample-run", turns: replies.map((reply) => ({ actor: "orchestrator", reply })) }];
const ofType = (t: string): Entry[] => f.s.entries().filter((e) => e.type === t);

test("the stage's agent runs on the stage's chosen model with the stage's pack and tools", async () => {
  const r = rig(script(say(FRAME)));
  r.engine.start(person);
  const end = await stageAgent(r.env(), { actor_id: "orchestrator", task: "frame it", extras: [] });
  expect(end).toMatchObject({ kind: "output", output: FRAME, calls: [] });
  const req = ofType("model.request")[0]! as Extract<Entry, { type: "model.request" }>;
  expect(req.actor).toEqual({ kind: "agent", id: "orchestrator", stage: "frame", profile: "investigation", model: "sample-run", effort: null, where: "machine" });
  expect(req.payload).toMatchObject({ provider: "scripted", model: "sample-run", tools: ["list_sources", "describe_source"], where: "machine" });
  expect(req.payload.pack.map((i) => `${i.kind}:${i.id}`)).toEqual(expect.arrayContaining(["rules:base-rules", "persona:orchestrator", "schema:frame-output", "case:" + f.s.state.meta!.id]));
  expect(req.run).toBe(f.s.state.run.id);
  expect(req.stage).toBe("frame");
  expect(req.job).toBeNull();
});

test("a model set for the stage by a person is the one used", async () => {
  const r = rig([...script(say(FRAME)), { id: "other", turns: [{ actor: "orchestrator", reply: say(FRAME) }] }]);
  r.engine.setModel("frame", { provider: "scripted", model: "other", effort: null }, person);
  r.engine.start(person);
  const end = await stageAgent(r.env(), { actor_id: "orchestrator", task: "t", extras: [] });
  expect(end.kind).toBe("output");
  expect((ofType("model.request")[0]! as Extract<Entry, { type: "model.request" }>).payload.model).toBe("other");
});

test("a model the provider does not list stalls the stage and names it", async () => {
  const r = rig(script(say(FRAME)));
  r.engine.setModel("frame", { provider: "scripted", model: "ghost-model", effort: null }, person);
  r.engine.start(person);
  const end = await stageAgent(r.env(), { actor_id: "orchestrator", task: "t", extras: [] });
  expect(end).toMatchObject({ kind: "stalled" });
  expect((end as { reason: string }).reason).toContain("ghost-model");
  r.engine.setModel("frame", { provider: "nowhere", model: "m", effort: null }, person);
  const end2 = await stageAgent(r.env(), { actor_id: "orchestrator", task: "t", extras: [] });
  expect((end2 as { reason: string }).reason).toContain("nowhere");
  expect(ofType("model.request")).toEqual([]);
});

test("a pack limit set for the stage leaves stricter cards out", async () => {
  const r = rig(script(say(FRAME)));
  r.engine.setPackLimit("frame", "TLP:GREEN", person);
  r.engine.start(person);
  const card = (id: string, marking: PackPart["marking"]): PackPart => ({ kind: "card", id, title: `Card ${id}`, text: "rows", marking, fixed: false });
  await stageAgent(r.env(), { actor_id: "orchestrator", task: "t", extras: [card("c1", "TLP:AMBER"), card("c2", "TLP:GREEN")] });
  const req = ofType("model.request")[0]! as Extract<Entry, { type: "model.request" }>;
  expect(req.payload.left_out.map((i) => i.id)).toEqual(["c1"]);
  expect(req.payload.pack.map((i) => i.id)).toContain("c2");
});

test("each outcome of the loop maps to its stage end", async () => {
  // one run; the scripted provider's ordinal continues across the calls: two bad replies, a decline, an error
  const r = rig(script({ content: "nothing" }, { content: "{}" }, { declined: "no" }, { error: "boom" }));
  r.engine.start(person);
  const go = () => stageAgent(r.env(), { actor_id: "orchestrator", task: "t", extras: [] });
  const invalid = await go();
  expect(invalid).toMatchObject({ kind: "stalled" });
  expect((invalid as { reason: string }).reason).toStartWith("Frame's output failed its schema twice: ");
  expect(await go()).toEqual({ kind: "declined", reason: "no" });
  expect(await go()).toEqual({ kind: "stalled", reason: "Frame: the model call failed: boom" });

  const policy = r.deps.config.marking_policy;
  r.deps.config.marking_policy = { ...policy, "TLP:GREEN": [] };
  expect(await go()).toEqual({ kind: "blocked", marking: "TLP:GREEN" });
  r.deps.config.marking_policy = policy;

  r.engine.setBudget(1, person);
  const budget = await go();
  expect(budget.kind).toBe("stalled");
  expect((budget as { reason: string }).reason).toMatch(/^The model budget for this run is used up \(\d+ of 1 tokens\)\. Raise it and resume\.$/);
  r.engine.setBudget(null, person);

  r.engine.pause(person);
  expect(await go()).toEqual({ kind: "stopped" });
});

test("lastOutput and frameOf read Frame's passed output, and fall back to the case window and the default limits", () => {
  const r = rig(script());
  r.engine.start(person);
  expect(lastOutput(f.s, "frame")).toBeNull();
  expect(frameOf(r.env("plan"))).toEqual({ window: WINDOW, limits: { allow_unconfirmed: false, max_weight: null, max_hops: 4 } });
  const finish = (outcome: "pass" | "fail", output: unknown) => f.s.commit((st) => [{
    type: "stage.finished", actor: { kind: "system", id: "engine" }, run: st.run.id, stage: "frame",
    payload: { stage: "frame", attempt: 1, outcome, draft_hash: null, output: f.s.blobs.put(JSON.stringify(output)), reason: null },
  }]);
  const narrow = { ...FRAME, window: { from: "2026-11-18T00:00:00.000Z", to: "2026-11-19T00:00:00.000Z" }, limits: { allow_unconfirmed: true, max_weight: 3 } };
  finish("pass", narrow);
  finish("fail", { other: 1 });
  expect(lastOutput(f.s, "frame")).toEqual(narrow);
  expect(frameOf(r.env("plan"))).toEqual({ window: { from: "2026-11-18T00:00:00.000Z", to: "2026-11-19T00:00:00.000Z" }, limits: { allow_unconfirmed: true, max_weight: 3, max_hops: 4 } });
});
