import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Entry } from "../../src/core/types";
import { loadProfile } from "../../src/agents/context";
import type { PackPart } from "../../src/agents/context";
import { Providers } from "../../src/agents/providers";
import type { Provider } from "../../src/agents/providers";
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

test("a model call that fails twice for the same reason pauses with a plain reason and a suggestion", async () => {
  const r = rig(script(say(FRAME), say(FRAME)));
  const inner = r.deps.providers.get("scripted")!;
  const timedOut: Provider = {
    id: inner.id, kind: inner.kind, where: inner.where, max_output_tokens: 8192, models: () => inner.models(), body: (q) => inner.body(q),
    turn: async (q) => { await inner.turn(q); return { kind: "error", message: "no answer within 300000 ms", raw: null, transient: { kind: "timeout", ms: 300000 } }; },
  };
  r.deps.providers = new Providers([timedOut]);
  r.engine.start(person);
  const end = await stageAgent(r.env(), { actor_id: "orchestrator", task: "t", extras: [] });
  expect(end).toEqual({ kind: "stalled", reason: "Frame: the model did not answer within 300 s twice. Try a lower effort or another model, and resume." });
  expect(ofType("model.request")).toHaveLength(2);
});

test("a model list that cannot be read is told apart from one that does not list the model", async () => {
  const r = rig(script(say(FRAME)));
  const inner = r.deps.providers.get("scripted")!;
  const down: Provider = { id: inner.id, kind: inner.kind, where: inner.where, models: () => Promise.reject(new Error("no answer within 300000 ms")), body: (q) => inner.body(q), turn: (q) => inner.turn(q) };
  r.deps.providers = new Providers([down]);
  r.engine.start(person);
  const end = await stageAgent(r.env(), { actor_id: "orchestrator", task: "t", extras: [] });
  expect(end).toEqual({ kind: "stalled", reason: 'Frame: the model list of the provider "scripted" could not be read (no answer within 300000 ms). Check that the endpoint answers and resume.' });
  expect(ofType("model.request")).toEqual([]);
});

test("a failed model-list read does not stop the call when this process saw the model listed earlier", async () => {
  const r = rig(script(say(FRAME), say(FRAME)));
  const inner = r.deps.providers.get("scripted")!;
  let reads = 0;
  const flaky: Provider = {
    id: inner.id, kind: inner.kind, where: inner.where, body: (q) => inner.body(q), turn: (q) => inner.turn(q),
    models: () => (reads++ === 0 ? inner.models() : Promise.reject(new Error("busy"))),
  };
  r.deps.providers = new Providers([flaky]);
  r.engine.start(person);
  expect(await stageAgent(r.env(), { actor_id: "orchestrator", task: "t", extras: [] })).toMatchObject({ kind: "output", output: FRAME });
  expect(await stageAgent(r.env(), { actor_id: "orchestrator", task: "t", extras: [] })).toMatchObject({ kind: "output", output: FRAME });
  expect(reads).toBe(2);
  expect(ofType("model.request")).toHaveLength(2);
  // a model it never listed is not attempted on a failed read
  r.engine.setModel("frame", { provider: "scripted", model: "ghost-model", effort: null }, person);
  const ghost = await stageAgent(r.env(), { actor_id: "orchestrator", task: "t", extras: [] });
  expect((ghost as { reason: string }).reason).toContain("could not be read (busy)");
  expect(ofType("model.request")).toHaveLength(2);
});

test("a schema failure's pause says in a word what the model returned", async () => {
  const manifest = { kind: "schema", id: "frame-output", title: "Frame output", schema: { type: "object" } };
  // the scripted provider's ordinal continues across the calls
  const r = rig(script({ content: "", reasoning: "the answer" }, say(manifest), { content: "" }, { content: " " }, { content: "none" }, { content: '{"goals":1}' }));
  r.engine.start(person);
  const go = async () => ((await stageAgent(r.env(), { actor_id: "orchestrator", task: "t", extras: [] })) as { reason: string }).reason;
  expect(await go()).toBe("Frame's output failed its schema twice: the model returned the schema itself (output missing required property: goals; "
    + "output missing required property: window; output missing required property: limits; output missing required property: notes; "
    + "kind unexpected property; id unexpected property; title unexpected property; schema unexpected property)");
  expect(await go()).toBe("Frame's output failed its schema twice: the model returned nothing (the reply is empty)");
  expect(await go()).toStartWith("Frame's output failed its schema twice: the model returned an object that does not match its schema (output missing required property: window;");
});

test("a stage's sampling and max_output_tokens reach the model request; a stage without them sends none of its own", async () => {
  const r = rig(script(say(FRAME), say(FRAME)));
  const inner = r.deps.providers.get("scripted")!;
  const seen: Parameters<Provider["turn"]>[0][] = [];
  r.deps.providers = new Providers([{
    id: inner.id, kind: inner.kind, where: inner.where, models: () => inner.models(), body: (q) => inner.body(q),
    turn: (q) => { seen.push(q); return inner.turn(q); },
  }]);
  r.engine.start(person);
  const plain = r.env();
  await stageAgent(plain, { actor_id: "orchestrator", task: "t", extras: [] });
  await stageAgent({ ...plain, stage: { ...plain.stage, sampling: { temperature: 0.2, presence_penalty: 1 }, max_output_tokens: 70000 } }, { actor_id: "orchestrator", task: "t", extras: [] });
  expect(seen[0]).not.toHaveProperty("sampling");
  expect(seen[0]).not.toHaveProperty("max_output_tokens");
  expect(seen[1]).toMatchObject({ sampling: { temperature: 0.2, presence_penalty: 1 }, max_output_tokens: 70000 });
});

test("a stage's max_turns overrides the loop's 16: the task counts to it and the agent stops there", async () => {
  const call = { tool_calls: [{ tool: "list_sources", args: { why: "w" } }] };
  const r = rig(script(call, call, call, call));
  const inner = r.deps.providers.get("scripted")!;
  const seen: Parameters<Provider["turn"]>[0][] = [];
  r.deps.providers = new Providers([{
    id: inner.id, kind: inner.kind, where: inner.where, models: () => inner.models(), body: (q) => inner.body(q),
    turn: (q) => { seen.push(q); return inner.turn(q); },
  }]);
  r.engine.start(person);
  const env = r.env();
  const end = await stageAgent({ ...env, stage: { ...env.stage, tools: ["list_sources"], max_turns: 3 } }, { actor_id: "orchestrator", task: "t", extras: [] });
  expect(end).toEqual({ kind: "stalled", reason: "Frame: the agent used all its turns without an answer" });
  expect(seen).toHaveLength(3);
  expect(seen[0]!.messages[1]!.content).toBe("t\n\nTurn 1 of 3.");
  expect(seen[2]!.tool_choice).toBe("none");
});
