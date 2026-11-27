import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../src/core/blobs";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { Ledger } from "../../src/core/ledger";
import type { LoadedManifest } from "../../src/modules/manifests";
import type { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import type { ResolveContext } from "../../src/pipeline/components";
import { compose } from "../../src/cli/compose";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { IMPLICIT_NOTE, loadLoops, parseLoop, readLock } from "../../src/pipeline/loops";
import { loadPipeline } from "../../src/pipeline/manifests";
import type { LoopCaps, LoopCatalog, LoopManifest } from "../../src/pipeline/loops";
import { copySample } from "../helpers/sample-root";

let dir: string;
let root: string;
let chain: Ledger;
let content: BlobStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loops-"));
  root = join(dir, "sample");
  copySample(root);
  chain = Ledger.open(join(dir, "chain.db"), "workbench");
  content = new BlobStore(join(dir, "blobs"));
});
afterEach(() => {
  chain.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The sample's pipeline hash as the workbench computed it before slice 12 (loadPipeline on the tree before any change). */
const SAMPLE_LEGACY_HASH = "19f7829f3f9c97faf5c149c0eddc4b047471ca3b2119f168abe2cbef93761329";
const CAPS: LoopCaps = { max_depth: 2, max_children: 8 };
type Out = ReturnType<ResolveContext["output"]>;
function ctxOf(registry: Registry, output: (loop: string, out: string) => Out = () => null): ResolveContext {
  return { registry, content, chain, trusted: [root], output };
}
function catalog(caps: LoopCaps = CAPS, output?: (loop: string, out: string) => Out): { registry: Registry; loops: LoopCatalog } {
  const registry = loadRegistry([{ path: root, trusted: true, credentials: [] }], { chain, content });
  return { registry, loops: loadLoops(registry, ctxOf(registry, output), caps) };
}
const writeLoop = (name: string, body: Record<string, unknown>): void => {
  mkdirSync(join(root, "loops"), { recursive: true });
  writeFileSync(join(root, "loops", `${name}.yaml`), JSON.stringify(body));
};
const sampleLoop = (): Record<string, Json> => Bun.YAML.parse(readFileSync(join(root, "loops", "investigation.yaml"), "utf8")) as Record<string, Json>;
const manifestOf = (body: Record<string, unknown>): LoadedManifest => ({
  kind: "loop", id: String(body.id), title: String(body.title ?? body.id), hash: "0".repeat(64), root, path: join(root, "loops", "x.yaml"), dir: join(root, "loops"),
  body: body as Record<string, Json>, text: null,
});
const inline = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, title: id, order: 1, runs: "agent", role: "frame", tools: [], schema: "frame-output", model: { provider: "scripted", model: "sample-run", effort: null }, on_pass: null, on_fail: null, ...over,
});
const mini = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: "loop", id: "mini", title: "Mini", version: 1, profile: "investigation", entry: "frame", stages: [inline("frame")], ...over });
const subloopStage = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "inv", title: "Investigate", order: 2, runs: "loop", role: "subloop", loop: "investigation",
  inputs: { question: "case.question", observables: "case.observables", window: "case.window" }, returns: { findings: { as: "cards" } }, on_pass: null, on_fail: null, ...over,
});
const outer = (over: Record<string, unknown> = {}, stage: Record<string, unknown> = {}): Record<string, unknown> =>
  mini({ id: "outer", title: "Outer", stages: [inline("frame", { on_pass: "inv" }), subloopStage(stage)], ...over });
const problemsOf = (loops: LoopCatalog, id: string): string => loops.problems(id).join(" | ");
const editFile = (rel: string, from: string, to: string): void => {
  const p = join(root, rel);
  const text = readFileSync(p, "utf8");
  if (!text.includes(from)) throw new Error(`${from} not in ${rel}`);
  writeFileSync(p, text.replace(from, to));
};

// ---- Step 1: the manifest and its validation

test("parseLoop reads the sample's investigation loop: nine stages by id, its profile, entry, inputs and outputs", () => {
  const { registry } = catalog();
  const m = registry.get("loop", "investigation")!;
  const loop = parseLoop(m) as LoopManifest;
  expect(typeof loop).toBe("object");
  expect(loop.id).toBe("investigation");
  expect(loop.title).toBe("Investigation");
  expect(loop.version).toBe(1);
  expect(loop.implicit).toBe(false);
  expect(loop.hash).toBe(m.hash);
  expect(loop.path).toBe("loops/investigation.yaml");
  expect(loop.profile).toBe("investigation");
  expect(loop.entry).toBe("frame");
  expect(loop.stages).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"]);
  expect(loop.inputs).toEqual({ question: { type: "question", required: true }, observables: { type: "observables", required: true }, window: { type: "window", required: true } });
  expect(loop.outputs).toEqual({ product: { from: "product" }, findings: { from: "findings" }, cards: { from: "cards.kept" } });
  expect(loop.components).toEqual({});
  expect(loop.uses).toEqual({ playbooks: [], pivots: [], sources: [] });
});

test("a loop needs kind, id, title, version, profile, entry and stages; an unknown key is refused by name", () => {
  expect(typeof parseLoop(manifestOf(mini()))).toBe("object");
  for (const key of ["kind", "id", "title", "version", "profile", "entry", "stages"]) {
    const body = mini();
    delete body[key];
    const got = parseLoop(manifestOf(body));
    expect(typeof got).toBe("string");
    expect(got as string).toContain(key);
  }
  const got = parseLoop(manifestOf(mini({ colour: "red" })));
  expect(typeof got).toBe("string");
  expect(got as string).toContain("colour");
});

test("an inline stage is a stage body without kind; it is validated as a stage manifest is", () => {
  const ok = parseLoop(manifestOf(mini())) as LoopManifest;
  expect(ok.stages).toEqual([inline("frame") as Record<string, Json>]);
  const bad = parseLoop(manifestOf(mini({ stages: [inline("frame", { role: "judge" })] })));
  expect(bad).toContain('role "judge" is not one of');
  expect(parseLoop(manifestOf(mini({ stages: [inline("frame", { tools: ["delete_everything"] })] })))).toContain("delete_everything");
  expect(parseLoop(manifestOf(mini({ stages: [inline("frame", { model: null })] })))).toContain("needs a model");
  expect(parseLoop(manifestOf(mini({ stages: [inline("frame", { kind: "persona" })] })))).toContain("kind");
});

test("a stage id twice, a stage id that is no stage manifest and no inline stage, and an entry that is not a stage are each refused by name", () => {
  expect(parseLoop(manifestOf(mini({ stages: [inline("frame"), "frame"] })))).toContain('stage "frame" is listed twice');
  expect(parseLoop(manifestOf(mini({ entry: "start" })))).toContain('entry "start" is not a stage of this loop');
  writeLoop("mini", mini({ stages: [inline("frame", { on_pass: "nowhere" }), "nowhere"] }));
  const { loops } = catalog();
  expect(loops.current("mini")).toBeNull();
  expect(problemsOf(loops, "mini")).toContain('stage "nowhere" is no stage manifest and no inline stage');
});

test("on_pass and on_fail must name a stage of this loop: a stage of another loop is not one", () => {
  // publish's on_pass is feedback, a stage manifest of the root that this loop does not list
  writeLoop("short", { ...sampleLoop(), id: "short", stages: ["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish"] });
  writeLoop("mini", mini({ stages: [inline("frame", { on_fail: "plan" })] }));
  const { loops } = catalog();
  expect(loops.current("short")).toBeNull();
  expect(problemsOf(loops, "short")).toContain('stage "publish": on_pass names "feedback", which is not a stage of this loop');
  expect(problemsOf(loops, "mini")).toContain('stage "frame": on_fail names "plan", which is not a stage of this loop');
  expect(loops.current("investigation")).not.toBeNull();
});

test("every stage must be reached from the entry along on_pass and on_fail, and an on_pass cycle is refused", () => {
  writeLoop("island", mini({ id: "island", stages: [inline("frame"), inline("plan", { order: 2 })] }));
  writeLoop("cycle", mini({ id: "cycle", stages: [inline("frame", { on_pass: "plan" }), inline("plan", { order: 2, on_pass: "frame" })] }));
  writeLoop("mini", mini({ stages: [inline("frame", { on_pass: "plan" }), inline("plan", { order: 2, on_fail: "frame" })] }));
  const { loops } = catalog();
  expect(problemsOf(loops, "island")).toContain('stage "plan" is not reached from the entry "frame"');
  expect(problemsOf(loops, "cycle")).toContain("on_pass cycle: frame > plan > frame");
  expect(loops.problems("mini")).toEqual([]);
  expect(loops.current("mini")).not.toBeNull();
  // the entry is the stage a run starts at, which is the first one listed
  expect(parseLoop(manifestOf(mini({ entry: "plan", stages: [inline("frame"), inline("plan", { order: 2 })] })))).toContain('the entry "plan" must be the first stage listed');
});

test("a loop may have no gate; two stages for one gate are refused; a publish gate needs a review stage before it", () => {
  writeLoop("mini", mini());
  writeLoop("twice", mini({ id: "twice", stages: [inline("frame", { gate: "plan", on_pass: "plan" }), inline("plan", { order: 2, gate: "plan" })] }));
  writeLoop("noreview", mini({ id: "noreview", stages: [inline("frame", { on_pass: "out" }), inline("out", { order: 2, role: "publish", gate: "publish", schema: "publish-output" })] }));
  writeLoop("late", mini({
    id: "late",
    stages: [inline("frame", { on_pass: "out" }), inline("out", { order: 2, role: "publish", gate: "publish", schema: "publish-output", on_pass: "rev" }), inline("rev", { order: 3, role: "evaluate", reviews: true, schema: "evaluate-output" })],
  }));
  const { loops } = catalog();
  expect(loops.problems("mini")).toEqual([]);
  expect(loops.current("mini")!.pipeline.stages.map((s) => s.id)).toEqual(["frame"]);
  expect(problemsOf(loops, "twice")).toContain("there may be at most one stage for gate plan; there are 2");
  expect(problemsOf(loops, "noreview")).toContain("a publish gate needs a review stage before it");
  expect(problemsOf(loops, "late")).toContain('the publish stage "out" comes before the review stage "rev"');
});

test("a stage with runs loop needs loop, inputs and returns, and may have no model, tools or schema; one without runs loop may have none of the three", () => {
  expect(typeof parseLoop(manifestOf(outer()))).toBe("object");
  for (const key of ["loop", "inputs", "returns"]) {
    const s = subloopStage();
    delete s[key];
    expect(parseLoop(manifestOf(mini({ stages: [inline("frame", { on_pass: "inv" }), s] })))).toContain("a stage that runs a loop needs loop, inputs and returns");
  }
  expect(parseLoop(manifestOf(outer({}, { model: { provider: "scripted", model: "sample-run", effort: null } })))).toContain("a stage that runs a loop has no model, tools or schema");
  expect(parseLoop(manifestOf(outer({}, { tools: ["list_cards"] })))).toContain("a stage that runs a loop has no model, tools or schema");
  expect(parseLoop(manifestOf(outer({}, { schema: "frame-output" })))).toContain("a stage that runs a loop has no model, tools or schema");
  expect(parseLoop(manifestOf(outer({}, { role: "research" })))).toContain("a stage that runs a loop has role subloop");
  expect(parseLoop(manifestOf(mini({ stages: [inline("frame", { loop: "investigation" })] })))).toContain("only a stage that runs a loop has loop, inputs or returns");
  expect(parseLoop(manifestOf(mini({ stages: [inline("frame", { role: "subloop" })] })))).toContain("a stage of role subloop runs a loop");
  expect(parseLoop(manifestOf(outer({}, { inputs: { question: "case.title" } })))).toContain('inputs.question: "case.title" is not one of');
  expect(parseLoop(manifestOf(outer({}, { returns: { findings: { as: "notes" } } })))).toContain("returns.findings");
  expect(parseLoop(manifestOf(outer({}, { returns: { findings: { as: "draft_section", section: "preface" } } })))).toContain('section "preface" is not one of');
  const parsed = parseLoop(manifestOf(outer())) as LoopManifest;
  writeLoop("outer", outer());
  const { loops } = catalog();
  expect(loops.problems("outer")).toEqual([]);
  const inv = loops.current("outer")!.pipeline.stages.find((s) => s.id === "inv")!;
  expect(inv.runs).toBe("loop");
  expect(inv.inline).toBe(true);
  expect(inv.subloop).toEqual({ loop: "investigation", inputs: { question: "case.question", observables: "case.observables", window: "case.window" }, returns: { findings: { as: "cards" } } });
  expect(loops.current("outer")!.pipeline.stages.find((s) => s.id === "frame")!.subloop).toBeUndefined();
  expect(parsed.stages.length).toBe(2);
});

test("a sub-loop's inputs must cover the child loop's required inputs with a selector of the right type, and name none it does not have", () => {
  // case.question → question · case.observables → observables · case.window → window · cards.kept → cards · findings.latest → findings · product.latest → product
  writeLoop("missing", outer({ id: "missing" }, { inputs: { question: "case.question", observables: "case.observables" } }));
  writeLoop("wrongtype", outer({ id: "wrongtype" }, { inputs: { question: "case.window", observables: "case.observables", window: "case.window" } }));
  writeLoop("extra", outer({ id: "extra" }, { inputs: { question: "case.question", observables: "case.observables", window: "case.window", notes: "cards.kept" } }));
  writeLoop("child", mini({
    id: "child", stages: [inline("frame")],
    inputs: { cards: { type: "cards", required: true }, findings: { type: "findings", required: false }, product: { type: "product", required: false } },
    outputs: { findings: { from: "findings" } },
  }));
  writeLoop("typed", outer({ id: "typed" }, { loop: "child", inputs: { cards: "cards.kept", findings: "findings.latest", product: "product.latest" } }));
  writeLoop("typedbad", outer({ id: "typedbad" }, { loop: "child", inputs: { cards: "findings.latest" } }));
  const { loops } = catalog();
  expect(problemsOf(loops, "missing")).toContain('stage "inv": loop "investigation" needs input "window"');
  expect(problemsOf(loops, "wrongtype")).toContain('stage "inv": input "question" is a question, and case.window gives a window');
  expect(problemsOf(loops, "extra")).toContain('stage "inv": loop "investigation" has no input "notes"');
  expect(loops.problems("typed")).toEqual([]);
  expect(problemsOf(loops, "typedbad")).toContain('stage "inv": input "cards" is a cards, and findings.latest gives a findings');
});

test("a sub-loop's returns must name outputs the child loop has; draft_section takes a product or findings output and one of the five sections", () => {
  writeLoop("noout", outer({ id: "noout" }, { returns: { verdict: { as: "cards" } } }));
  writeLoop("cardsec", outer({ id: "cardsec" }, { returns: { cards: { as: "draft_section", section: "summary" } } }));
  writeLoop("goodsec", outer({ id: "goodsec" }, { returns: { findings: { as: "draft_section", section: "key_findings" }, product: { as: "draft_section", section: "summary" }, cards: { as: "cards" } } }));
  const { loops } = catalog();
  expect(problemsOf(loops, "noout")).toContain('stage "inv": loop "investigation" has no output "verdict"');
  expect(problemsOf(loops, "cardsec")).toContain('stage "inv": returns.cards: a draft section takes a product or findings output, and "cards" is cards.kept');
  expect(loops.problems("goodsec")).toEqual([]);
});

test("a component key is kind:id of a component the stage has; a source is root, pinned with 64 hex, loop-output as loop.output, or memory", () => {
  const withComponents = (components: Record<string, unknown>): string | LoopManifest => parseLoop(manifestOf(mini({ components })));
  expect(typeof withComponents({ frame: { "persona:orchestrator": "root" }, "*": { "rules:base-rules": { pinned: "a".repeat(64) } } })).toBe("object");
  expect(typeof withComponents({ frame: { "reference:brief": { "loop-output": "investigation.product" } } })).toBe("object");
  expect(typeof withComponents({ frame: { "skill:ask-the-person": { memory: "notes/latest" } } })).toBe("object");
  expect(withComponents({ frame: { persona: "root" } })).toContain('"persona" is not kind:id');
  expect(withComponents({ frame: { "persona:orchestrator": { pinned: "abc" } } })).toContain("frame.persona:orchestrator");
  expect(withComponents({ frame: { "persona:orchestrator": { "loop-output": "investigation" } } })).toContain("frame.persona:orchestrator");
  expect(withComponents({ frame: { "persona:orchestrator": "branch" } })).toContain("frame.persona:orchestrator");
  expect(withComponents({ nowhere: { "persona:orchestrator": "root" } })).toContain('components: "nowhere" is not a stage of this loop');
  writeLoop("mini", mini({ components: { frame: { "persona:researcher": "root", "persona:orchestrator": "root" } } }));
  const { loops } = catalog();
  expect(problemsOf(loops, "mini")).toContain('components.frame: "persona:researcher" is not a component of stage frame');
  expect(problemsOf(loops, "mini")).not.toContain("persona:orchestrator");
});

// ---- Step 5: resolution and the hashes

test("the sample's investigation loop has the legacy hash the workbench recorded before slice 12", () => {
  const { registry, loops: cat } = catalog();
  expect(cat.problems("investigation")).toEqual([]);
  expect(cat.current("investigation")!.pipeline.legacy_hash).toBe(SAMPLE_LEGACY_HASH);
  expect(loadPipeline(registry).pipeline!.hash).toBe(SAMPLE_LEGACY_HASH);
  expect(cat.current("investigation")!.pipeline.hash).not.toBe(SAMPLE_LEGACY_HASH);
  expect(cat.current("investigation")!.pipeline.id).toBe("investigation");
});

test("the legacy hash is the old formula over the loop's stages in order, whatever else the root holds", () => {
  // add a tenth stage manifest that the loop does not name: legacy_hash is unchanged; loadPipeline's is not
  writeFileSync(join(root, "stages", "extra.yaml"), "kind: stage\nid: extra\norder: 10\nruns: human\nrole: feedback\ngate: null\nreviews: false\ntools: []\nschema: null\nmodel: null\non_pass: null\non_fail: null\n");
  const { registry, loops } = catalog();
  expect(loops.current("investigation")!.pipeline.legacy_hash).toBe(SAMPLE_LEGACY_HASH);
  const old = loadPipeline(registry);
  expect(old.pipeline!.stages.map((s) => s.id)).toContain("extra");
  expect(old.pipeline!.hash).not.toBe(SAMPLE_LEGACY_HASH);
});

test("a root with stage manifests and no loop manifest has the implicit loop investigation, with every stage and the old hash", () => {
  // remove loops/: list() has one entry, implicit true, problems hold "no loop manifest: every stage manifest is the investigation loop"
  rmSync(join(root, "loops"), { recursive: true });
  const { loops } = catalog();
  const list = loops.list();
  expect(list.map((x) => x.id)).toEqual(["investigation"]);
  expect(list[0]!.manifest!.implicit).toBe(true);
  expect(list[0]!.problems).toEqual([IMPLICIT_NOTE]);
  expect(IMPLICIT_NOTE).toBe("no loop manifest: every stage manifest is the investigation loop");
  const loop = loops.current("investigation")!;
  expect(loop.pipeline.stages.map((s) => s.id)).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"]);
  expect(loop.pipeline.legacy_hash).toBe(SAMPLE_LEGACY_HASH);
  expect(loop.manifest.entry).toBe("frame");
  expect(loop.lock.manifest.path).toBeNull();
  expect(loop.profile.id).toBe("investigation");
});

test("the implicit loop is gone as soon as the root holds any loop manifest", () => {
  rmSync(join(root, "loops"), { recursive: true });
  writeLoop("mini", mini());
  const { loops } = catalog();
  expect(loops.list().map((x) => x.id)).toEqual(["mini"]);
  expect(loops.current("investigation")).toBeNull();
  expect(loops.problems("investigation")).toEqual(['there is no loop "investigation"']);
});

test("the version-2 hash changes when a persona, a skill, the rules, a schema, a check manifest or a check's script changes, and the legacy hash does not", () => {
  // edit each in turn in a copy of the sample; reload; compare
  const first = catalog().loops.current("investigation")!.pipeline;
  const seen = new Set([first.hash]);
  const edits: [string, string, string][] = [
    ["context/personas/researcher.md", "You are the researcher.", "You are the researcher, edited."],
    ["context/skills/ask-the-person.md", "title: Ask the person\n---\n", "title: Ask the person\n---\nEdited.\n"],
    ["context/rules.md", "title: Rules for every agent\n---\n", "title: Rules for every agent\n---\nEdited.\n"],
    ["context/schemas/research-output.yaml", "kind: schema", "# edited\nkind: schema"],
    ["checks/01-schema.yaml", "kind: check", "# edited\nkind: check"],
    ["checks/01-schema.ts", "", "// edited\n"],
  ];
  for (const [rel, from, to] of edits) {
    editFile(rel, from, to);
    const now = catalog().loops.current("investigation")!.pipeline;
    expect(now.legacy_hash).toBe(SAMPLE_LEGACY_HASH);
    expect(seen.has(now.hash)).toBe(false);
    seen.add(now.hash);
  }
});

test("the version-2 hash changes when a stage manifest changes, and so does the legacy hash", () => {
  const first = catalog().loops.current("investigation")!.pipeline;
  editFile("stages/research.yaml", "title: Research", "title: Research, edited");
  const now = catalog().loops.current("investigation")!.pipeline;
  expect(now.hash).not.toBe(first.hash);
  expect(now.legacy_hash).not.toBe(SAMPLE_LEGACY_HASH);
});

test("the lock lists the loop manifest, the profile, and every component of every stage with its source and hash, sorted by stage, kind, id", () => {
  // research: persona:researcher, procedure:research-sop, skill:ask-the-person, schema:research-output; "*": profile:investigation, rules:base-rules, framework:intel-cycle, standard:icd203; checks: eleven checks and their scripts
  const { registry, loops } = catalog();
  const lock = loops.current("investigation")!.lock;
  expect(lock.format).toBe(1);
  expect(lock.loop).toBe("investigation");
  expect(lock.manifest).toEqual({ path: "loops/investigation.yaml", hash: registry.get("loop", "investigation")!.hash });
  const keys = (stage: string): string[] => lock.items.filter((i) => i.stage === stage).map((i) => `${i.kind}:${i.id}`);
  expect(keys("*")).toEqual(["framework:intel-cycle", "profile:investigation", "rules:base-rules", "standard:icd203"]);
  expect(keys("research")).toEqual(["persona:researcher", "procedure:research-sop", "schema:research-output", "skill:ask-the-person", "stage:research"]);
  const checks = lock.items.filter((i) => i.stage === "checks");
  expect(checks.filter((i) => i.kind === "check").length).toBe(11);
  expect(checks.filter((i) => i.kind === "check-script").length).toBe(11);
  const script = checks.find((i) => i.kind === "check-script" && i.id === "schema")!;
  expect(script.path).toBe("checks/01-schema.ts");
  expect(script.hash).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(join(root, "checks", "01-schema.ts"))).digest("hex"));
  const persona = lock.items.find((i) => i.kind === "persona" && i.id === "researcher")!;
  expect(persona).toEqual({ stage: "research", kind: "persona", id: "researcher", title: "Researcher", source: "root", hash: registry.get("persona", "researcher")!.hash, path: "context/personas/researcher.md" });
  const order = lock.items.map((i) => [i.stage, i.kind, i.id].join("\u0000"));
  expect(order).toEqual([...order].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  // every hash the lock names is in the content store, and so is the lock
  for (const i of lock.items) expect(content.check(i.hash)).toBe("ok");
  expect(content.has(lock.manifest.hash)).toBe(true);
  expect(loops.current("investigation")!.components.get("research", "persona", "researcher")!.text).toContain("You are the researcher.");
  expect(loops.current("investigation")!.components.get("research", "rules", "base-rules")).not.toBeNull();
});

test("a loop whose profile has no entry for one of its agent stages is not usable, with the reason", () => {
  writeLoop("mini", mini({ stages: [inline("frame", { on_pass: "sort" }), inline("sort", { order: 2 })] }));
  const { loops } = catalog();
  expect(loops.current("mini")).toBeNull();
  expect(problemsOf(loops, "mini")).toContain('stage "sort" runs an agent, and profile "investigation" has no entry for it');
});

test("a loop with an inline stage or a sub-loop stage has legacy_hash null", () => {
  writeLoop("mini", mini());
  writeLoop("outer", { ...outer(), stages: ["frame", subloopStage()], components: {} });
  const { loops } = catalog();
  expect(loops.current("mini")!.pipeline.legacy_hash).toBeNull();
  expect(loops.problems("outer")).toContain('stage "frame": on_pass names "plan", which is not a stage of this loop');
  writeLoop("outer", outer());
  const again = catalog().loops;
  expect(again.current("outer")!.pipeline.legacy_hash).toBeNull();
  expect(again.current("outer")!.lock.subloops).toEqual([{ stage: "inv", loop: "investigation", hash: again.current("investigation")!.pipeline.hash }]);
});

// ---- Step 9: the caps, fromLock and compose

test("a loop that runs itself is refused, and so is one that reaches itself through another: a loop may not run itself", () => {
  writeLoop("selfie", outer({ id: "selfie" }, { loop: "selfie", inputs: {}, returns: {} }));
  writeLoop("ping", outer({ id: "ping" }, { loop: "pong", inputs: {}, returns: {} }));
  writeLoop("pong", outer({ id: "pong" }, { loop: "ping", inputs: {}, returns: {} }));
  writeLoop("above", outer({ id: "above" }, { loop: "ping", inputs: {}, returns: {} }));
  const { loops } = catalog({ max_depth: 99, max_children: 8 });
  expect(loops.problems("selfie")).toEqual(["a loop may not run itself: selfie > selfie"]);
  expect(loops.problems("ping")).toEqual(["a loop may not run itself: ping > pong > ping"]);
  expect(loops.problems("pong")).toEqual(["a loop may not run itself: pong > ping > pong"]);
  expect(problemsOf(loops, "above")).toContain('stage "inv": sub-loop "ping" is not usable: a loop may not run itself: ping > pong > ping');
  expect(loops.current("investigation")).not.toBeNull();
});

test("a chain of sub-loops longer than max_depth is refused by name of the chain; max_depth 0 refuses every sub-loop stage", () => {
  writeLoop("l2", outer({ id: "l2" }));
  writeLoop("l1", outer({ id: "l1" }, { loop: "l2", inputs: {}, returns: {} }));
  writeLoop("l0", outer({ id: "l0" }, { loop: "l1", inputs: {}, returns: {} }));
  const { loops } = catalog();
  expect(loops.problems("l2")).toEqual([]);
  expect(loops.problems("l1")).toEqual([]);
  expect(loops.problems("l0")).toEqual(["the chain of sub-loops l0 > l1 > l2 > investigation is 3 deep; loops.max_depth is 2"]);
  const none = catalog({ max_depth: 0, max_children: 8 }).loops;
  expect(none.problems("l2")).toEqual(["the chain of sub-loops l2 > investigation is 1 deep; loops.max_depth is 0"]);
  expect(none.current("investigation")).not.toBeNull();
  // a loop with more sub-loop stages than one case may start sub-loops can never finish
  expect(catalog({ max_depth: 2, max_children: 0 }).loops.problems("l2")).toEqual(['loop "l2" has 1 sub-loop stages; loops.max_children is 0']);
});

test("a loop whose sub-loop is not usable is not usable, and says which", () => {
  writeLoop("broken", mini({ id: "broken", stages: [inline("frame", { schema: "no-such-schema" })], outputs: { findings: { from: "findings" } } }));
  writeLoop("outer", outer({}, { loop: "broken", inputs: {} }));
  writeLoop("lost", outer({ id: "lost" }, { loop: "nowhere" }));
  const { loops } = catalog();
  expect(problemsOf(loops, "broken")).toContain('stage "frame": schema "no-such-schema" is not loaded');
  expect(problemsOf(loops, "outer")).toContain('stage "inv": sub-loop "broken" is not usable: stage "frame": schema "no-such-schema" is not loaded');
  expect(problemsOf(loops, "lost")).toContain('stage "inv" runs loop "nowhere", which is not a loop here');
});

test("fromLock rebuilds the same pipeline hash, stages and profile after the root's persona and a stage manifest were edited", () => {
  // resolve; keep the lock; edit sample/context/personas/researcher.md and sample/stages/research.yaml; reload: current() differs, fromLock(lock) equals the first
  const first = catalog().loops.current("investigation")!;
  editFile("context/personas/researcher.md", "You are the researcher.", "You are someone else.");
  editFile("stages/research.yaml", "title: Research", "title: Research, edited");
  const { loops } = catalog();
  const now = loops.current("investigation")!;
  expect(now.pipeline.hash).not.toBe(first.pipeline.hash);
  const back = loops.fromLock(first.lock);
  if (typeof back === "string") throw new Error(back);
  expect(back.pipeline).toEqual(first.pipeline);
  expect(back.profile).toEqual(first.profile);
  expect(back.lock).toEqual(first.lock);
  expect(back.manifest.stages).toEqual(first.manifest.stages);
  expect(back.components.get("research", "persona", "researcher")!.text).toContain("You are the researcher.");
  expect(back.components.get("checks", "check-script", "schema")!.hash).toBe(first.components.get("checks", "check-script", "schema")!.hash);
  expect(back.components.items()).toEqual(first.components.items());
  // and the same of a loop with inline and sub-loop stages, and of the implicit loop
  writeLoop("outer", outer());
  const outerFirst = catalog().loops.current("outer")!;
  const outerBack = catalog().loops.fromLock(outerFirst.lock);
  if (typeof outerBack === "string") throw new Error(outerBack);
  expect(outerBack.pipeline).toEqual(outerFirst.pipeline);
  rmSync(join(root, "loops"), { recursive: true });
  const implicit = catalog().loops.current("investigation")!;
  const implicitBack = catalog().loops.fromLock(implicit.lock);
  if (typeof implicitBack === "string") throw new Error(implicitBack);
  expect(implicitBack.pipeline).toEqual(implicit.pipeline);
});

test("fromLock says which hash is missing when the content store does not hold it", () => {
  const { loops, registry } = catalog();
  const lock = loops.current("investigation")!.lock;
  const hash = registry.get("persona", "researcher")!.hash;
  rmSync(join(dir, "blobs", hash));
  expect(loops.fromLock(lock)).toBe(`the content store does not hold persona "researcher" (${hash})`);
});

test("readLock refuses bytes that are not a lock of format 1", () => {
  const { loops } = catalog();
  const lock = loops.current("investigation")!.lock;
  const bytes = (x: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(x));
  expect(loops.readLock(bytes(lock))).toEqual(lock);
  expect(readLock(content.get(sha256Hex(canonical(lock as unknown as Json))))).toEqual(lock);
  expect(loops.readLock(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
  expect(loops.readLock(bytes({ ...lock, format: 2 }))).toBeNull();
  expect(loops.readLock(bytes({ ...lock, items: [{ ...lock.items[0]!, hash: "short" }] }))).toBeNull();
  expect(loops.readLock(bytes({ ...lock, manifest: null }))).toBeNull();
  expect(loops.readLock(bytes([lock]))).toBeNull();
});

const configFor = (over: Partial<Config["loops"]> = {}): Config => {
  const base = loadConfig({ env: {}, home: dir, repoRoot: dir });
  return { ...base, data_dir: join(dir, "wb"), roots: [{ path: root, trusted: true, credentials: [] }], loops: { ...base.loops, imports: join(dir, "wb", "imported"), store: join(dir, "wb", "loops"), ...over } };
};

test("compose gives the default loop's pipeline and profile, sets loops, components and content, and records loop.recorded once per version", () => {
  const config = configFor();
  const wb = Workbench.open(config.data_dir, { onError: () => {} });
  try {
    const recorded = (): { loop: string; hash: string; version: number; legacy_hash: string | null; lock: { blob: string } }[] =>
      wb.chain.read().flatMap((e) => (e.type === "loop.recorded" ? [e.payload] : []));
    const a = compose(config, wb);
    try {
      const loop = a.deps.loops!.current("investigation")!;
      expect(a.deps.pipeline).toEqual(loop.pipeline);
      expect(a.deps.pipeline.id).toBe("investigation");
      expect(a.deps.pipeline.legacy_hash).toBe(SAMPLE_LEGACY_HASH);
      expect(a.deps.profile).toEqual(loop.profile);
      expect(a.deps.components!.items()).toEqual(loop.components.items());
      expect(a.deps.content).toBe(wb.chainBlobs);
      expect(recorded().map((r) => [r.loop, r.version, r.hash, r.legacy_hash])).toEqual([["investigation", 1, loop.pipeline.hash, SAMPLE_LEGACY_HASH]]);
      expect(readLock(wb.chainBlobs.get(recorded()[0]!.lock.blob))).toEqual(loop.lock);
    } finally { a.close(); }
    compose(config, wb).close();
    expect(recorded().length).toBe(1);
    editFile("context/personas/researcher.md", "You are the researcher.", "You are someone else.");
    const b = compose(config, wb);
    try {
      expect(recorded().map((r) => r.hash)).toEqual([recorded()[0]!.hash, b.deps.pipeline.hash]);
      expect(recorded()[1]!.version).toBe(1);
    } finally { b.close(); }
  } finally { wb.close(); }
});

test("compose does not fail when the default loop is not usable: the problem names it, the deps run no stage, and a run on it is refused (controller ruling)", () => {
  writeLoop("mini", mini({ stages: [inline("frame", { schema: "no-such-schema" })] }));
  for (const [over, why] of [[{ default: "nope" }, 'the default loop "nope" is not usable: there is no loop "nope"'], [{ default: "mini" }, 'the default loop "mini" is not usable: stage "frame": schema "no-such-schema" is not loaded']] as const) {
    const config = configFor(over);
    const wb = Workbench.open(config.data_dir, { onError: () => {} });
    try {
      const made = compose(config, wb);
      try {
        expect(made.problems).toContain(why);
        expect(made.deps.pipeline.stages).toEqual([]);
        expect(made.deps.loops!.current(over.default)).toBeNull();
      } finally { made.close(); }
    } finally { wb.close(); }
  }
});
