import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPROVE_ROLES, improveProblem, legacyHash, loadPipeline, pipelineProblem, PROPOSE_TOOL_NAMES, ROLES, stageFrom } from "../../src/pipeline/manifests";
import type { Json } from "../../src/core/canonical";
import type { StageManifest } from "../../src/pipeline/manifests";
import { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import { copySample } from "../helpers/sample-root";

let dir: string;
let root: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pipe-manifests-"));
  root = join(dir, "sample");
  copySample(root);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const load = (roots = [{ path: root, trusted: true, credentials: [] as string[] }]) => loadPipeline(loadRegistry(roots));
const file = (id: string) => join(root, "stages", `${id}.yaml`);
const edit = (id: string, from: string, to: string) => {
  const text = readFileSync(file(id), "utf8");
  if (!text.includes(from)) throw new Error(`${from} not in ${id}`);
  writeFileSync(file(id), text.replace(from, to));
};

test("the sample pipeline has nine stages in order with two gates and three review stages", () => {
  const { pipeline, problems } = load();
  expect(problems).toEqual([]);
  expect(pipeline!.id).toBe("default");
  expect(pipeline!.stages.map((s) => s.id)).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"]);
  expect(pipeline!.stages.filter((s) => s.reviews).map((s) => s.id)).toEqual(["checks", "evaluate", "challenge"]);
  expect(pipeline!.stages.filter((s) => s.gate !== null).map((s) => [s.id, s.gate])).toEqual([["plan", "plan"], ["publish", "publish"]]);
  for (const s of pipeline!.stages) expect(s.role as string).toBe(s.id);
  expect(pipeline!.stages.map((s) => s.role).every((r) => (ROLES as readonly string[]).includes(r as string))).toBe(true);
  const checks = pipeline!.stages.find((s) => s.id === "checks")!;
  expect(checks.model).toBeNull();
  expect(checks.runs).toBe("script");
  expect(pipeline!.stages.find((s) => s.id === "research")!.model).toEqual({ provider: "scripted", model: "sample-run", effort: null });
  expect(pipeline!.stages.find((s) => s.id === "research")!.tools).toEqual(["find_routes", "run_step", "run_pivot", "run_query", "list_cards", "read_card", "ask_person"]);
});

test("a stage naming a tool outside the fixed list is left out with a problem", () => {
  edit("frame", "[list_sources, describe_source]", "[list_sources, delete_everything]");
  const { pipeline, problems } = load();
  expect(problems.some((p) => p.includes("frame") && p.includes("delete_everything"))).toBe(true);
  expect(pipeline!.stages.map((s) => s.id)).not.toContain("frame");
});

test("a stage manifest that lists propose_change is refused: \"propose_change\" is the loop builder's, not a stage's", () => {
  edit("frame", "[list_sources, describe_source]", "[list_sources, propose_change]");
  const { pipeline, problems } = load();
  expect(problems.some((p) => p.includes("frame") && p.includes(`"propose_change" is the loop builder's, not a stage's`))).toBe(true);
  expect(pipeline!.stages.map((s) => s.id)).not.toContain("frame");
  // stageFrom says the same of a body, whatever builder tool it names
  const body = { kind: "stage", id: "x", title: "X", order: 1, runs: "agent", role: "frame", tools: ["request_probe"], model: { provider: "scripted", model: "m" } };
  expect(stageFrom(body, "0".repeat(64), "X", true)).toBe(`"request_probe" is the loop builder's, not a stage's`);
});

test("a stage manifest may list note_memory", () => {
  const body = { kind: "stage", id: "x", title: "X", order: 1, runs: "agent", role: "frame", tools: ["list_cards", "note_memory"], model: { provider: "scripted", model: "m" } };
  expect(typeof stageFrom(body, "0".repeat(64), "X", true)).not.toBe("string");
});

test("a stage with an unknown role, a bad shape, or an agent with no model is left out with a problem", () => {
  edit("feedback", "role: feedback", "role: oracle");
  edit("checks", "order: 5", "order: five");
  edit("evaluate", "model: { provider: scripted, model: sample-run, effort: null }", "model: null");
  const { problems } = load();
  expect(problems.some((p) => p.includes("feedback") && p.includes("oracle"))).toBe(true);
  expect(problems.some((p) => p.includes("checks"))).toBe(true);
  expect(problems.some((p) => p.includes("evaluate") && p.includes("model"))).toBe(true);
});

test("a stage manifest from an untrusted root is not used", () => {
  const evil = join(dir, "evil");
  mkdirSync(join(evil, "stages"), { recursive: true });
  writeFileSync(join(evil, "stages", "extra.yaml"), "kind: stage\nid: extra\ntitle: Extra\norder: 6.5\nphase: analysis\nruns: script\nrole: checks\ngate: null\nreviews: false\ntools: []\nschema: null\nmodel: null\non_pass: challenge\non_fail: null\n");
  const registry = loadRegistry([{ path: root, trusted: true, credentials: [] }, { path: evil, trusted: false, credentials: [] }]);
  expect(registry.problems.some((p) => p.root === evil && /only from a trusted root/.test(p.error))).toBe(true);
  const { pipeline } = loadPipeline(registry);
  expect(pipeline!.stages.map((s) => s.id)).not.toContain("extra");
});

test("an untrusted stage with a trusted stage's id leaves the trusted one loaded", () => {
  const evil = join(dir, "evil");
  mkdirSync(evil, { recursive: true });
  writeFileSync(join(evil, "research.yaml"), "kind: stage\nid: research\ntitle: Evil\norder: 3\nphase: collection\nruns: script\nrole: checks\ngate: null\nreviews: false\ntools: []\nschema: null\nmodel: null\non_pass: null\non_fail: null\n");
  const registry = loadRegistry([{ path: root, trusted: true, credentials: [] }, { path: evil, trusted: false, credentials: [] }]);
  expect(registry.get("stage", "research")!.root).toBe(root);
  const { pipeline, problems } = loadPipeline(registry);
  expect(problems).toEqual([]);
  expect(pipeline!.stages.find((s) => s.id === "research")!.title).toBe("Research");
});

test("a pipeline with no review stage, or with publish before review, is refused", () => {
  for (const id of ["checks", "evaluate", "challenge"]) edit(id, "reviews: true", "reviews: false");
  const none = load();
  expect(none.pipeline).toBeNull();
  expect(none.problems.join("\n")).toMatch(/review/);
  for (const id of ["checks", "evaluate", "challenge"]) edit(id, "reviews: false", "reviews: true");
  edit("publish", "order: 8", "order: 5.5");
  edit("evaluate", "order: 6", "order: 8.5");
  edit("challenge", "order: 7", "order: 8.6");
  const early = load();
  expect(early.pipeline).toBeNull();
  expect(early.problems.join("\n")).toMatch(/publish.*before/);
});

test("a dangling on_fail and a duplicate order are refused", () => {
  edit("research", "on_fail: plan", "on_fail: nowhere");
  const dangling = load();
  expect(dangling.pipeline).toBeNull();
  expect(dangling.problems.join("\n")).toMatch(/research.*on_fail.*nowhere/);
  edit("research", "on_fail: nowhere", "on_fail: plan");
  edit("assemble", "order: 4", "order: 3");
  const dup = load();
  expect(dup.pipeline).toBeNull();
  expect(dup.problems.join("\n")).toMatch(/order 3/);
});

test("exactly one stage for each gate, and at least one stage", () => {
  edit("research", "gate: null", "gate: plan");
  const two = load();
  expect(two.pipeline).toBeNull();
  expect(two.problems.join("\n")).toMatch(/gate plan/);
  edit("research", "gate: plan", "gate: null");
  edit("publish", "gate: publish", "gate: null");
  const none = load();
  expect(none.pipeline).toBeNull();
  expect(none.problems.join("\n")).toMatch(/gate publish/);
  rmSync(join(root, "stages"), { recursive: true });
  const empty = load();
  expect(empty.pipeline).toBeNull();
  expect(empty.problems.join("\n")).toMatch(/no stage/);
});

test("adding a stage file adds a stage", () => {
  writeFileSync(join(root, "stages", "extra.yaml"), "kind: stage\nid: extra\ntitle: Extra\norder: 6.5\nphase: analysis\nruns: script\nrole: checks\ngate: null\nreviews: true\ntools: []\nschema: null\nmodel: null\non_pass: challenge\non_fail: assemble\n");
  edit("evaluate", "on_pass: challenge", "on_pass: extra");
  const { pipeline, problems } = load();
  expect(problems).toEqual([]);
  expect(pipeline!.stages.map((s) => s.id)).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "extra", "challenge", "publish", "feedback"]);
});

test("the pipeline hash changes when a stage manifest changes", () => {
  const a = load().pipeline!;
  expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(load().pipeline!.hash).toBe(a.hash);
  edit("research", "title: Research", "title: Researching");
  expect(load().pipeline!.hash).not.toBe(a.hash);
});

test("an on_pass cycle is refused", () => {
  edit("evaluate", "on_pass: challenge", "on_pass: checks");
  const { pipeline, problems } = load();
  expect(pipeline).toBeNull();
  expect(problems.join("\n")).toMatch(/on_pass cycle.*checks.*evaluate.*checks/);
});

test("a stage may give sampling and max_output_tokens, validated; a stage without them has none", () => {
  expect(load().pipeline!.stages.find((s) => s.id === "plan")!.sampling).toBeNull();
  expect(load().pipeline!.stages.find((s) => s.id === "plan")!.max_output_tokens).toBeNull();
  const text = readFileSync(file("plan"), "utf8");
  writeFileSync(file("plan"), text + "sampling: { temperature: 0.8, top_k: 30 }\nmax_output_tokens: 90000\n");
  const stage = load().pipeline!.stages.find((s) => s.id === "plan")!;
  expect(stage.sampling).toEqual({ temperature: 0.8, top_k: 30 });
  expect(stage.max_output_tokens).toBe(90000);
  for (const bad of ["sampling: { temperature: 9 }\n", "sampling: { warmth: 1 }\n", "max_output_tokens: 0\n", "max_output_tokens: many\n"]) {
    writeFileSync(file("plan"), text + bad);
    const { pipeline, problems } = load();
    expect(problems.some((p) => p.includes("plan"))).toBe(true);
    expect(pipeline === null || !pipeline.stages.some((s) => s.id === "plan")).toBe(true);
  }
});

test("a stage may give request_extra, a map that names no key the workbench sends itself; a stage without it has none", () => {
  expect(load().pipeline!.stages.find((s) => s.id === "plan")!.request_extra).toBeNull();
  const text = readFileSync(file("plan"), "utf8");
  writeFileSync(file("plan"), text + "request_extra:\n  chat_template_kwargs: { enable_thinking: false }\n  reasoning_effort: low\n");
  expect(load().pipeline!.stages.find((s) => s.id === "plan")!.request_extra).toEqual({ chat_template_kwargs: { enable_thinking: false }, reasoning_effort: "low" });
  for (const bad of ["request_extra: [1]\n", "request_extra: on\n", "request_extra: { model: x }\n", "request_extra: { max_tokens: 5 }\n", "request_extra: { top_p: 0.5 }\n", "request_extra: { response_format: {} }\n"]) {
    writeFileSync(file("plan"), text + bad);
    const { pipeline, problems } = load();
    expect(problems.some((p) => p.includes("plan") && p.includes("request_extra"))).toBe(true);
    expect(pipeline === null || !pipeline.stages.some((s) => s.id === "plan")).toBe(true);
  }
});

test("a stage may set max_turns, a positive integer; a stage without it has none", () => {
  expect(load().pipeline!.stages.find((s) => s.id === "plan")!.max_turns).toBeNull();
  const text = readFileSync(file("plan"), "utf8");
  writeFileSync(file("plan"), text + "max_turns: 30\n");
  expect(load().pipeline!.stages.find((s) => s.id === "plan")!.max_turns).toBe(30);
  for (const bad of ["max_turns: 0\n", "max_turns: -2\n", "max_turns: 2.5\n", "max_turns: many\n"]) {
    writeFileSync(file("plan"), text + bad);
    const { pipeline, problems } = load();
    expect(problems.some((p) => p.includes("plan") && p.includes("max_turns"))).toBe(true);
    expect(pipeline === null || !pipeline.stages.some((s) => s.id === "plan")).toBe(true);
  }
});

test("a stage's fast_model loads with effort null; a malformed one is a problem naming fast_model; absent is null", () => {
  edit("research", "on_pass: assemble", "fast_model: { provider: scripted, model: x }\non_pass: assemble");
  const ok = load();
  expect(ok.pipeline!.stages.find((s) => s.id === "research")!.fast_model).toEqual({ provider: "scripted", model: "x", effort: null });
  expect(ok.pipeline!.stages.find((s) => s.id === "frame")!.fast_model).toBeNull();
  edit("research", "fast_model: { provider: scripted, model: x }", "fast_model: { provider: scripted }");
  const bad = load();
  expect(bad.problems.some((p) => p.includes("research") && p.includes("fast_model"))).toBe(true);
  expect(bad.pipeline?.stages.map((s) => s.id) ?? []).not.toContain("research");
});

test("loadPipeline keeps its own stricter rules and messages: exactly one stage per gate, a review stage, and the old hash", () => {
  edit("plan", "gate: plan", "gate: null");
  const { pipeline, problems } = load();
  expect(pipeline).toBeNull();
  expect(problems).toContain("there must be exactly one stage for gate plan; there are 0");
});

test("stageFrom reads a stage body without the registry: the same stage loadPipeline builds, refused when its bytes are not trusted", () => {
  const registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
  const m = registry.get("stage", "research")!;
  const made = stageFrom(m.body, m.hash, m.title, true);
  expect(made).toEqual(loadPipeline(registry).pipeline!.stages.find((s) => s.id === "research")!);
  expect(stageFrom(m.body, m.hash, m.title, false)).toBe("a stage manifest is accepted only from a trusted root");
  expect(legacyHash(loadPipeline(registry).pipeline!.stages)).toBe(loadPipeline(registry).pipeline!.hash);
});

test("pipelineProblem is today's rules loosened: no gate is allowed, two for one gate are not, and a review stage is needed only before a publish gate", () => {
  const registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
  const all = loadPipeline(registry).pipeline!.stages;
  expect(pipelineProblem(all)).toBeNull();
  const frame = { ...all[0]!, on_pass: null };
  expect(pipelineProblem([frame])).toBeNull();
  expect(pipelineProblem([])).toBe("a loop has no stage");
  const twice: StageManifest[] = [{ ...frame, gate: "plan", on_pass: "plan" }, { ...all[1]!, on_pass: null }];
  expect(pipelineProblem(twice)).toBe("there may be at most one stage for gate plan; there are 2");
});

// ---- slice 14: the improve loop's seven roles, its adopt gate and its shape

const H64 = "0".repeat(64);
const MODEL = { provider: "scripted", model: "sample-run", effort: null };
const NEXT: Record<string, string | null> = { select: "propose", propose: "probe", probe: "compose", compose: "judge", judge: "reflect", reflect: "adopt", adopt: null };
/** A stage body of an improve role, as the sample would write it. */
const improveBody = (role: string, over: Record<string, Json> = {}): Record<string, Json> => {
  const order = (IMPROVE_ROLES as readonly string[]).indexOf(role) + 1;
  const base: Record<string, Json> = { kind: "stage", id: role, title: role, order, role, on_pass: NEXT[role] ?? null, on_fail: null };
  const how: Record<string, Record<string, Json>> = {
    select: { runs: "script" },
    propose: { runs: "agent", model: MODEL, tools: [...PROPOSE_TOOL_NAMES] },
    probe: { runs: "script", probe: { plan_gate: "accept" } },
    compose: { runs: "agent", model: MODEL },
    judge: { runs: "script" },
    reflect: { runs: "agent", model: MODEL },
    adopt: { runs: "human", gate: "adopt" },
  };
  return { ...base, ...how[role], ...over };
};
const made = (body: Record<string, Json>): StageManifest => {
  const s = stageFrom(body, H64, String(body.id), true);
  if (typeof s === "string") throw new Error(s);
  return s;
};
const seven = (): StageManifest[] => IMPROVE_ROLES.map((r) => made(improveBody(r)));

test("the seven improve roles are roles, and a stage of each parses", () => {
  expect([...IMPROVE_ROLES]).toEqual(["select", "propose", "probe", "compose", "judge", "reflect", "adopt"]);
  for (const r of IMPROVE_ROLES) expect((ROLES as readonly string[]).includes(r)).toBe(true);
  const stages = seven();
  expect(stages.map((s) => s.role)).toEqual([...IMPROVE_ROLES]);
  expect(stages.find((s) => s.role === "probe")!.probe).toEqual({ plan_gate: "accept" });
  for (const s of stages.filter((x) => x.role !== "probe")) expect(s.probe ?? null).toBeNull();
  expect(stages.find((s) => s.role === "adopt")!.gate).toBe("adopt");
  // a judge may run an agent; select, probe and adopt may be a person's
  expect(typeof stageFrom(improveBody("judge", { runs: "agent", model: MODEL }), H64, "j", true)).toBe("object");
  for (const r of ["select", "probe"]) expect(typeof stageFrom(improveBody(r, { runs: "human" }), H64, r, true)).toBe("object");
  // and the rules of how each runs
  for (const r of ["select", "probe", "adopt"]) {
    expect(stageFrom(improveBody(r, { runs: "agent", model: MODEL }), H64, r, true)).toBe(`a stage of role ${r} runs a script or a person, with no model`);
    expect(stageFrom(improveBody(r, { model: MODEL }), H64, r, true)).toBe(`a stage of role ${r} runs a script or a person, with no model`);
  }
  for (const r of ["propose", "compose", "reflect"]) expect(stageFrom(improveBody(r, { runs: "script", model: null }), H64, r, true)).toBe(`a stage of role ${r} runs an agent`);
  expect(stageFrom(improveBody("judge", { runs: "human" }), H64, "judge", true)).toBe("a stage of role judge runs a script or an agent");
});

test("a probe stage without probe.plan_gate, with another value, and probe on another role are refused with their sentences", () => {
  const without = improveBody("probe");
  delete without.probe;
  expect(stageFrom(without, H64, "probe", true)).toBe("a probe stage says how its children's plan gate is passed: probe: { plan_gate: accept }");
  expect(stageFrom(improveBody("probe", { probe: {} }), H64, "probe", true)).toBe("a probe stage says how its children's plan gate is passed: probe: { plan_gate: accept }");
  expect(stageFrom(improveBody("probe", { probe: null }), H64, "probe", true)).toBe("a probe stage says how its children's plan gate is passed: probe: { plan_gate: accept }");
  expect(stageFrom(improveBody("probe", { probe: { plan_gate: "person" } }), H64, "probe", true)).toBe("a probe's plan gate is accept in this version");
  expect(typeof stageFrom(improveBody("probe", { probe: { plan_gate: "accept", more: 1 } }), H64, "probe", true)).toBe("string");
  expect(stageFrom(improveBody("select", { probe: { plan_gate: "accept" } }), H64, "select", true)).toBe("only a probe stage has probe");
  const frame = { kind: "stage", id: "x", title: "X", order: 1, runs: "agent", role: "frame", model: MODEL, probe: { plan_gate: "accept" } };
  expect(stageFrom(frame, H64, "X", true)).toBe("only a probe stage has probe");
});

test("gate adopt parses on an adopt stage and is refused on any other; an adopt stage without it is refused", () => {
  expect(made(improveBody("adopt")).gate).toBe("adopt");
  expect(stageFrom(improveBody("judge", { gate: "adopt" }), H64, "judge", true)).toBe("only an adopt stage has gate adopt");
  const frame = { kind: "stage", id: "x", title: "X", order: 1, runs: "human", role: "publish", gate: "adopt" };
  expect(stageFrom(frame, H64, "X", true)).toBe("only an adopt stage has gate adopt");
  expect(stageFrom(improveBody("adopt", { gate: null }), H64, "adopt", true)).toBe("an adopt stage has gate: adopt");
  expect(stageFrom(improveBody("adopt", { gate: "publish" }), H64, "adopt", true)).toBe("an adopt stage has gate: adopt");
});

test("a propose stage may list the four builder tools; any other stage listing one is refused as before", () => {
  expect([...PROPOSE_TOOL_NAMES]).toEqual(["loop_catalogue", "adapter_catalogue", "validate_manifest", "propose_change"]);
  expect(made(improveBody("propose")).tools).toEqual([...PROPOSE_TOOL_NAMES]);
  expect(made(improveBody("propose", { tools: ["propose_change"] })).tools).toEqual(["propose_change"]);
  // a propose stage lists no other tool: not request_probe, not a stage tool
  expect(stageFrom(improveBody("propose", { tools: ["propose_change", "request_probe"] }), H64, "p", true)).toBe('"request_probe" is not one of a propose stage\'s tools: loop_catalogue, adapter_catalogue, validate_manifest, propose_change');
  expect(stageFrom(improveBody("propose", { tools: ["list_cards"] }), H64, "p", true)).toBe('"list_cards" is not one of a propose stage\'s tools: loop_catalogue, adapter_catalogue, validate_manifest, propose_change');
  for (const t of PROPOSE_TOOL_NAMES) {
    expect(stageFrom(improveBody("compose", { tools: [t] }), H64, "c", true)).toBe(`"${t}" is the loop builder's, not a stage's`);
    const frame = { kind: "stage", id: "x", title: "X", order: 1, runs: "agent", role: "frame", tools: [t], model: MODEL };
    expect(stageFrom(frame, H64, "X", true)).toBe(`"${t}" is the loop builder's, not a stage's`);
  }
});

test("improveProblem is null for the seven in order and for a loop with no improve role", () => {
  expect(improveProblem(seven())).toBeNull();
  const registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
  expect(improveProblem(loadPipeline(registry).pipeline!.stages)).toBeNull();
  expect(improveProblem([])).toBeNull();
  // the seven pass the loop rules too: at most one stage per gate, with three gates
  expect(pipelineProblem(seven())).toBeNull();
});

test("improveProblem names a missing role, a role twice, a wrong order, an on_fail, a publish gate and a stage of another role", () => {
  const all = seven();
  const by = (role: string): StageManifest => all.find((s) => s.role === role)!;
  const ROLE_LIST = "an improve loop has one stage of each of select, propose, probe, compose, judge, reflect and adopt";
  // missing
  expect(improveProblem(all.filter((s) => s.role !== "judge").map((s) => (s.role === "compose" ? { ...s, on_pass: "reflect" } : s)))).toBe(`${ROLE_LIST}; it has no judge`);
  // twice
  expect(improveProblem([...all, { ...by("compose"), id: "compose2", on_pass: null }])).toBe(`${ROLE_LIST}; it has two compose`);
  // order: two stages swapped in the on_pass chain, Adopt with an on_pass, and an entry that is not Select
  const ORDER = "an improve loop runs select, propose, probe, compose, judge, reflect, adopt in that order";
  const swapped = all.map((s) => (s.role === "propose" ? { ...s, on_pass: "compose" } : s.role === "compose" ? { ...s, on_pass: "probe" } : s.role === "probe" ? { ...s, on_pass: "judge" } : s));
  expect(improveProblem(swapped)).toBe(ORDER);
  expect(improveProblem(all.map((s) => (s.role === "adopt" ? { ...s, on_pass: "select" } : s)))).toBe(ORDER);
  expect(improveProblem([...all.slice(1), all[0]!])).toBe(ORDER);
  // on_fail and reviews
  expect(improveProblem(all.map((s) => (s.role === "judge" ? { ...s, on_fail: "propose" } : s)))).toBe('an improve loop has no on_fail; stage "judge" has one');
  expect(improveProblem(all.map((s) => (s.role === "compose" ? { ...s, reviews: true } : s)))).toBe('an improve loop has no review stage; stage "compose" has reviews: true');
  // a plan or a publish gate
  expect(improveProblem(all.map((s) => (s.role === "select" ? { ...s, gate: "publish" as const } : s)))).toBe('an improve loop has no plan or publish gate; stage "select" has gate publish');
  expect(improveProblem(all.map((s) => (s.role === "probe" ? { ...s, gate: "plan" as const } : s)))).toBe('an improve loop has no plan or publish gate; stage "probe" has gate plan');
  // a stage of another role
  const registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
  const frame = { ...loadPipeline(registry).pipeline!.stages[0]!, on_pass: null };
  expect(improveProblem([...all, frame])).toBe('an improve loop has only the seven improve roles; stage "frame" has role frame');
});
