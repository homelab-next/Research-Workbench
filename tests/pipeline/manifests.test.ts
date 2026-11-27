import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPipeline, ROLES } from "../../src/pipeline/manifests";
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
