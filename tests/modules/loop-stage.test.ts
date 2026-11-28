import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BlobStore } from "../../src/core/blobs";
import { sha256Hex } from "../../src/core/hash";
import type { Actor } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { latestOutput } from "../../src/cli/compose";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { saveManifests, WRITABLE_KINDS } from "../../src/modules/loop-write";
import type { ManifestFile } from "../../src/modules/loop-write";
import { CANDIDATE_KINDS, candidateProblems, checkCandidate, stageCandidate } from "../../src/modules/loop-stage";
import { loadRegistry } from "../../src/modules/registry-record";
import type { Registry } from "../../src/modules/registry";
import { loadLoops } from "../../src/pipeline/loops";
import type { LoopCatalog } from "../../src/pipeline/loops";
import { copySample } from "../helpers/sample-root";

const TARGET = "unknown-device";
const LOOP_FILE = "loops/unknown-device.yaml";
const human: Actor = { kind: "human", id: "analyst" };
let dir: string;
let root: string;
let config: Config;
let wb: Workbench;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loop-stage-"));
  root = join(dir, "sample");
  copySample(root);
  const base = loadConfig({ env: {}, home: dir, repoRoot: dir });
  config = { ...base, data_dir: join(dir, "wb"), roots: [{ path: root, trusted: true, credentials: [] }], loops: { ...base.loops, store: join(dir, "wb", "loops"), imports: join(dir, "wb", "imported") } };
  wb = Workbench.open(config.data_dir, { onError: () => {} });
});
afterEach(() => {
  wb.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The loops of the roots as they are now, as compose loads them. */
function load(): { registry: Registry; loops: LoopCatalog } {
  const registry = loadRegistry(config.roots, { chain: wb.chain, content: wb.chainBlobs });
  const loops = loadLoops(registry, {
    registry, content: wb.chainBlobs, chain: wb.chain, trusted: [root], output: (l, o) => latestOutput(wb.chain, wb.chainBlobs, l, o),
  }, { max_depth: config.loops.max_depth, max_children: config.loops.max_children });
  return { registry, loops };
}
const deps = (secrets: string[] = []) => ({ config, chain: wb.chain, content: wb.chainBlobs, secrets, ...load() });
const read = (path: string): string => readFileSync(join(root, ...path.split("/")), "utf8");
/** The root's file with `from` replaced by `to`; the replacement must take. */
const edit = (path: string, from: string, to: string): ManifestFile => {
  const text = read(path);
  if (!text.includes(from)) throw new Error(`${path} does not hold ${from}`);
  return { path, text: text.replace(from, to) };
};
/** The target's loop file, as the next version, with `from` replaced by `to`. */
const loopEdit = (from: string, to: string): ManifestFile => {
  const f = edit(LOOP_FILE, from, to);
  return { path: f.path, text: f.text.replace("\nversion: 1\n", "\nversion: 2\n") };
};
const rules = (files: ManifestFile[], target = TARGET): string[] => candidateProblems(deps(), root, files, target);
const SKILL = "context/skills/ask-the-person.md";
const STAGE_ONLY = "a candidate changes a stage's tools, turns or effort only";
const SOURCE_ONLY = "a candidate changes a source's field notes only: never its location, connector, credential, marking, tables or cost";

// ---- the candidate rules

test("a changed skill text, a changed procedure text, a playbook's steps, a column's reveals and extract, and a stage's tools and effort are each a candidate", () => {
  expect(CANDIDATE_KINDS).toEqual(["skill", "procedure", "playbook", "source", "stage", "loop"]);
  const skill = edit(SKILL, "Ask one thing at a time, and ask early.", "Ask one thing at a time.");
  const procedure = edit("context/procedures/research.md", "Say what was not found.", "Say what was not found, and why.");
  const playbook = edit("playbooks/address-triage.yaml", "max_values: 5", "max_values: 3");
  const wifi = edit("sources/wifi.yaml", "A disconnection message names neither.", "A disconnection message names neither the host nor the access point.");
  const extract = { path: wifi.path, text: wifi.text.replace("pattern: ' connected to (\\S+?)\\. Connection Info:'", "pattern: ' connected to ([^ .]+)\\. Connection Info:'") };
  expect(extract.text).not.toBe(wifi.text);
  const loop = loopEdit("tools: [find_routes, run_step, run_pivot, run_query, list_cards, read_card, ask_person, note_memory]", "tools: [find_routes, run_step, run_pivot, run_query, list_cards, read_card, note_memory]\n    max_turns: 12");
  const effort = { path: loop.path, text: loop.text.replace("    schema: plan-output\n    model: { provider: scripted, model: sample-device, effort: null }", "    schema: plan-output\n    model: { provider: scripted, model: sample-device, effort: high }") };
  expect(effort.text).not.toBe(loop.text);
  for (const f of [skill, procedure, playbook, wifi, extract, effort]) {
    expect({ path: f.path, problems: rules([f]) }).toEqual({ path: f.path, problems: [] });
  }
  expect(rules([skill, procedure, playbook, extract, effort])).toEqual([]);
  // and the whole check of a candidate passes them
  expect(checkCandidate(deps(), root, [skill, procedure, playbook, extract, effort], TARGET)).toMatchObject({ ok: true, problems: [] });
  // a stage file of the investigation loop, for the investigation loop
  const research = edit("stages/research.yaml", "tools: [find_routes, run_step, run_pivot, run_query, list_cards, read_card, ask_person]", "tools: [find_routes, run_step, run_query, list_cards, read_card, ask_person]\nmax_turns: 9");
  expect(rules([research], "investigation")).toEqual([]);
});

test("a new file is refused: a candidate changes what the loop has; it adds no file", () => {
  const skill = { path: "context/skills/new-skill.md", text: "---\nkind: skill\nid: new-skill\ntitle: New\n---\nBe brief.\n" };
  expect(rules([skill])).toEqual(["context/skills/new-skill.md: a candidate changes what the loop has; it adds no file"]);
  const check = checkCandidate(deps(), root, [skill], TARGET);
  expect(check.ok).toBe(false);
  expect(check.problems).toEqual(["context/skills/new-skill.md: a candidate changes what the loop has; it adds no file"]);
  // a file over another of another kind or id is not the loop's file either
  const moved = { path: SKILL, text: "---\nkind: skill\nid: another-skill\ntitle: Another\n---\nBe brief.\n" };
  expect(rules([moved])).toEqual([`${SKILL}: the file there is skill "ask-the-person"; a candidate keeps a file's kind and id`]);
});

test("a check, a check's script, the rules, the profile, a persona, a schema, the standard and a model are each refused by kind", () => {
  const cases: [string, string][] = [
    ["checks/01-schema.yaml", "check"],
    ["context/rules.md", "rules"],
    ["context/unknown-device-profile.yaml", "profile"],
    ["context/personas/analyst.md", "persona"],
    ["context/schemas/product.yaml", "schema"],
    ["context/standards/icd203.yaml", "standard"],
    ["models/scripted.yaml", "model"],
    ["context/framework.yaml", "framework"],
    ["case-types.yaml", "case-types"],
  ];
  for (const [path, kind] of cases) {
    expect(CANDIDATE_KINDS).not.toContain(kind);
    const text = `${read(path)}\n`;
    expect({ path, problems: rules([{ path, text }]) }).toEqual({ path, problems: [`${path}: an improve candidate may not change a ${kind}`] });
  }
  const script = "checks/01-schema.ts";
  expect(rules([{ path: script, text: `${read(script)}\n// changed\n` }])).toEqual([`${script}: an improve candidate may not change a check's script`]);
  // the save refuses most of these first, with its own sentence
  const check = checkCandidate(deps(), root, [{ path: "checks/01-schema.yaml", text: `${read("checks/01-schema.yaml")}\n` }], TARGET);
  expect(check.problems).toEqual(["checks/01-schema.yaml: a save may not write a check"]);
});

test("a source whose location, connector, credential, marking, where, cost or table names differ is refused", () => {
  const wifi = "sources/wifi.yaml";
  const changes: [string, string][] = [
    ["location: ../data", "location: ../other"],
    ["connector: files", "connector: sql"],
    ["marking: \"TLP:GREEN\"", "marking: \"TLP:CLEAR\""],
    ["where: machine", "where: remote"],
    ["title: WiFi controller log", "title: WiFi controller log\ncost: { weight: 1, unit: lookups }"],
    ["title: WiFi controller log", "title: WiFi controller log\ncredential: wifi-token"],
    ["  - name: wifi\n", "  - name: wifi2\n"],
    ["      - { name: ts, meaning: When the controller logged the message. }", "      - { name: ts, type: time, meaning: When the controller logged the message. }"],
    ["file: wifi.jsonl", "file: wifi2.jsonl"],
  ];
  for (const [from, to] of changes) {
    const f = edit(wifi, from, to);
    expect({ to, problems: rules([f]) }).toEqual({ to, problems: [`${wifi}: ${SOURCE_ONLY}`] });
  }
  // an endpoint's own fields are kept too; only a field's notes may change (the investigation loop's uses lists no source: any loaded one is its)
  const rep = "sources/reputation.yaml";
  expect(rules([edit(rep, "columns: [address, verdict, first_seen]", "columns: [address, { name: verdict, meaning: What the feed says of the address. }, first_seen]")], "investigation")).toEqual([]);
  expect(rules([edit(rep, "path: /v1/reputation/{value}", "path: /v2/reputation/{value}")], "investigation")).toEqual([`${rep}: ${SOURCE_ONLY}`]);
  expect(rules([edit(rep, "location: http://127.0.0.1:4801", "location: http://192.0.2.10:4801")], "investigation")).toEqual([`${rep}: ${SOURCE_ONLY}`]);
  expect(rules([edit(rep, "columns: [address, verdict, first_seen]", "columns: [address, verdict]")], "investigation")).toEqual([`${rep}: ${SOURCE_ONLY}`]);
});

test("a stage whose gate, reviews, role, runs, schema, on_pass, on_fail or model differ is refused", () => {
  // the research stage of the target's loop file, written inline
  const research = "    role: research\n    gate: null\n    reviews: false\n";
  const inline: [string, string][] = [
    [research, "    role: research\n    gate: plan\n    reviews: false\n"],
    [research, "    role: research\n    gate: null\n    reviews: true\n"],
    [research, "    role: assemble\n    gate: null\n    reviews: false\n"],
    ["    schema: research-output\n", "    schema: assemble-output\n"],
    ["    on_pass: assemble\n    on_fail: plan\n", "    on_pass: checks\n    on_fail: plan\n"],
    ["    on_pass: assemble\n    on_fail: plan\n", "    on_pass: assemble\n    on_fail: null\n"],
    ["    schema: research-output\n    model: { provider: scripted, model: sample-device, effort: null }", "    schema: research-output\n    model: { provider: scripted, model: sample-run, effort: null }"],
    ["    schema: research-output\n    model: { provider: scripted, model: sample-device, effort: null }", "    schema: research-output\n    model: { provider: scripted, model: sample-device, effort: null }\n    fast_model: { provider: scripted, model: sample-device, effort: null }"],
  ];
  for (const [from, to] of inline) {
    expect({ to, problems: rules([loopEdit(from, to)]) }).toEqual({ to, problems: [`${LOOP_FILE}: ${STAGE_ONLY}`] });
  }
  // the checks stage runs a script: making it an agent is refused
  expect(rules([loopEdit("    runs: script\n    role: checks\n", "    runs: human\n    role: checks\n")])).toEqual([`${LOOP_FILE}: ${STAGE_ONLY}`]);
  // a stage file of the investigation loop
  const file = "stages/research.yaml";
  for (const [from, to] of [["gate: null", "gate: plan"], ["reviews: false", "reviews: true"], ["runs: agent", "runs: human"], ["on_fail: plan", "on_fail: null"], ["model: sample-run", "model: sample-device"]] as const) {
    expect({ to, problems: rules([edit(file, from, to)], "investigation") }).toEqual({ to, problems: [`${file}: ${STAGE_ONLY}`] });
  }
});

test("a loop file whose profile, entry, stage list, components, uses, inputs, outputs or case_type differ is refused; one that keeps its version is told the version it needs", () => {
  const LOOP_ONLY = "a candidate changes a loop file's inline stages only: never its profile, entry, stage list, components, uses, inputs, outputs or case_type";
  const changes: [string, string][] = [
    ["profile: unknown-device", "profile: investigation"],
    ["entry: frame", "entry: plan"],
    ["  - id: feedback\n", "  - id: feedback2\n"],
    ["    \"reference:case-notes\": { memory: case/notes }\n  assemble:", "  assemble:"],
    ["  sources: [wifi, assets]", "  sources: [wifi, assets, flows]"],
    ["  window: { type: window, required: true }", "  window: { type: window, required: false }"],
    ["  cards: { from: cards.kept }", "  kept: { from: cards.kept }"],
    ["case_type: unknown-device", "case_type: investigation"],
    ["title: Unknown device\n", "title: Unknown device, again\n"],
  ];
  for (const [from, to] of changes) {
    expect({ to, problems: rules([loopEdit(from, to)]) }).toEqual({ to, problems: [`${LOOP_FILE}: ${LOOP_ONLY}`] });
  }
  // a stage taken out of the list, or the list re-ordered
  const text = read(LOOP_FILE);
  const at = text.indexOf("  - id: feedback\n");
  const end = text.indexOf("components:");
  const without = text.slice(0, at) + text.slice(end);
  expect(rules([{ path: LOOP_FILE, text: without.replace("\nversion: 1\n", "\nversion: 2\n").replace("on_pass: feedback", "on_pass: null") }])).toEqual([`${LOOP_FILE}: ${LOOP_ONLY}`]);
  // a change that keeps version 1, or jumps to 3
  const kept = edit(LOOP_FILE, "tools: [list_cards, read_card, verify_card]", "tools: [list_cards, read_card]");
  expect(rules([kept])).toEqual([`${LOOP_FILE}: a changed loop file is version 2`]);
  expect(rules([{ path: LOOP_FILE, text: kept.text.replace("\nversion: 1\n", "\nversion: 3\n") }])).toEqual([`${LOOP_FILE}: a changed loop file is version 2`]);
  expect(rules([{ path: LOOP_FILE, text: kept.text.replace("\nversion: 1\n", "\nversion: 2\n") }])).toEqual([]);
  // another loop's file is not the target's
  const triage = read("loops/triage.yaml");
  expect(rules([{ path: "loops/triage.yaml", text: triage.replace(/\nversion: (\d+)\n/, (_m, n: string) => `\nversion: ${Number(n) + 1}\n`) }])).toEqual(["loops/triage.yaml is not part of loop unknown-device"]);
});

test("a skill of another loop, or of none, is refused as not part of the target", () => {
  // a skill no loop uses, already in the root
  writeFileSync(join(root, "context", "skills", "spare.md"), "---\nkind: skill\nid: spare\ntitle: Spare\n---\nBe brief.\n");
  expect(rules([edit("context/skills/spare.md", "Be brief.", "Be briefer.")])).toEqual(["context/skills/spare.md is not part of loop unknown-device"]);
  // the builder's skill, which no stage of the target reads
  expect(rules([{ path: "context/skills/building-loops.md", text: `${read("context/skills/building-loops.md")}\nMore.\n` }])).toEqual(["context/skills/building-loops.md is not part of loop unknown-device"]);
  // a stage file of the investigation loop is not part of the target, whose stages are inline
  expect(rules([{ path: "stages/research.yaml", text: `${read("stages/research.yaml")}max_turns: 3\n` }])).toEqual(["stages/research.yaml is not part of loop unknown-device"]);
  // a playbook or a source the target's uses does not list
  expect(rules([{ path: "sources/flows.yaml", text: `${read("sources/flows.yaml")}\n` }])).toEqual(["sources/flows.yaml is not part of loop unknown-device"]);
});

test("a file that holds a secret value, or a credential-named key, is refused by the save's own check before the rules are read", () => {
  const secret = "s3cret-value-for-tests";
  // a new file, so the rules would refuse it too: only the save's sentence is given
  const leaked = { path: "context/skills/leaked.md", text: `---\nkind: skill\nid: leaked\ntitle: Leaked\n---\nThe key is ${secret}.\n` };
  let check = checkCandidate(deps([secret]), root, [leaked], TARGET);
  expect(check.ok).toBe(false);
  expect(check.problems).toEqual(["context/skills/leaked.md: it holds the value of a secret the workbench keeps; it is not saved"]);
  expect(JSON.stringify(check)).not.toContain(secret);
  // the target's own skill with the value in its text
  check = checkCandidate(deps([secret]), root, [edit(SKILL, "Ask one thing at a time", `Ask one thing at a time (${secret})`)], TARGET);
  expect(check.problems).toEqual([`${SKILL}: it holds the value of a secret the workbench keeps; it is not saved`]);
  // a credential-named key in a source the target uses: the source's own schema refuses it
  check = checkCandidate(deps(), root, [edit("sources/wifi.yaml", "where: machine", "where: machine\npassword: example-placeholder")], TARGET);
  expect(check.ok).toBe(false);
  expect(check.problems).toContain("sources/wifi.yaml: password: unexpected property");
  expect(check.problems.join(" | ")).not.toContain("candidate");
});

test("the same text re-ordered or re-quoted is no change", () => {
  // the playbook's keys in another order, its strings quoted
  const pb = read("playbooks/address-triage.yaml");
  const reordered = `title: "Triage an address"\nkind: playbook\nid: 'address-triage'\nabout: Is the address a known asset, what names resolved to it, and who looked those names up.\ninputs:\n  - { type: address, name: "address" }\n${pb.slice(pb.indexOf("steps:"))}`;
  expect(rules([{ path: "playbooks/address-triage.yaml", text: reordered }])).toEqual([]);
  // the source with its keys moved and quoted
  const wifi = read("sources/wifi.yaml").replace("kind: source\nid: wifi\ntitle: WiFi controller log\nconnector: files\n", "id: \"wifi\"\nconnector: 'files'\nkind: source\ntitle: WiFi controller log\n");
  expect(rules([{ path: "sources/wifi.yaml", text: wifi }])).toEqual([]);
  // the skill's front matter re-ordered
  const skill = read(SKILL).replace("kind: skill\nid: ask-the-person\ntitle: Ask the person\n", "title: \"Ask the person\"\nid: ask-the-person\nkind: skill\n");
  expect(rules([{ path: SKILL, text: skill }])).toEqual([]);
  // an inline stage written in block style
  const block = loopEdit("    model: { provider: scripted, model: sample-device, effort: null }\n    on_pass: null\n", "    model:\n      effort: null\n      model: \"sample-device\"\n      provider: scripted\n    on_pass: null\n");
  expect(rules([block])).toEqual([]);
  // and a skill whose front matter changes is refused
  expect(rules([{ path: SKILL, text: read(SKILL).replace("title: Ask the person", "title: Ask someone") }])).toEqual([`${SKILL}: a candidate changes a skill's text only`]);
  expect(rules([edit("playbooks/address-triage.yaml", "title: Triage an address", "title: Triage")])).toEqual(["playbooks/address-triage.yaml: a candidate changes a playbook's steps and end only"]);
});

// ---- staging

/** Every file of a folder (none when it is not there) with the hash of its bytes. */
function hashes(at: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(at)) return out;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[relative(at, full)] = sha256Hex(new Uint8Array(readFileSync(full)));
    }
  };
  walk(at);
  return out;
}
const SKILL_TEXT = "Ask one thing at a time, and ask early.";
const skillChange = (): ManifestFile => edit(SKILL, SKILL_TEXT, "Ask one thing at a time, and ask before you assess.");
const stagedInto = (): BlobStore => new BlobStore(join(config.data_dir, "staged", "IMP-1", "blobs"));
/** The staged loop, or the test fails with its problems. */
function stage(files: ManifestFile[], into: BlobStore, d = deps()) {
  const got = stageCandidate(d, root, files, TARGET, into);
  if (!got.ok) throw new Error(got.problems.join("; "));
  return got.loop;
}

test("stageCandidate gives the target loop with the changed skill: its hash differs from the current version's, and its skill's text is the candidate's", () => {
  const d = deps();
  const current = d.loops.current(TARGET)!;
  const staged = stage([skillChange()], stagedInto(), d);
  expect(staged.manifest.id).toBe(TARGET);
  expect(staged.pipeline.hash).not.toBe(current.pipeline.hash);
  expect(staged.pipeline.stages.map((s) => s.id)).toEqual(current.pipeline.stages.map((s) => s.id));
  const skill = staged.components.get("research", "skill", "ask-the-person")!;
  expect(skill.text).toContain("ask before you assess");
  expect(skill.text).not.toContain(SKILL_TEXT);
  expect(current.components.get("research", "skill", "ask-the-person")!.text).toContain(SKILL_TEXT);
  // the lock names the new bytes; every other item is the current version's
  const changed = staged.lock.items.filter((i) => !current.lock.items.some((j) => j.kind === i.kind && j.id === i.id && j.stage === i.stage && j.hash === i.hash));
  expect(changed.length).toBeGreaterThan(0);
  expect(changed.every((i) => i.kind === "skill" && i.id === "ask-the-person")).toBe(true);
  expect(changed.every((i) => i.hash === sha256Hex(new TextEncoder().encode(skillChange().text)))).toBe(true);
});

test("the staged loop names no temporary folder: every manifest's root and dir are as fromLock makes them", () => {
  const d = deps();
  const into = stagedInto();
  const staged = stage([skillChange()], into, d);
  expect(staged.manifest.root).toBeNull();
  expect(staged.manifest.path).toBe(LOOP_FILE);
  for (const item of staged.lock.items) {
    if (item.source === "memory") continue;
    const m = staged.components.get(item.stage, item.kind, item.id);
    if (m === null) continue; // a stage is in the pipeline, not the components
    expect({ item: item.id, root: m.root }).toEqual({ item: item.id, root: "" });
    expect({ item: item.id, dir: m.dir }).toEqual({ item: item.id, dir: item.path === null ? m.dir : item.path.split("/").slice(0, -1).join("/") || "." });
  }
  const shown = JSON.stringify({ manifest: staged.manifest, lock: staged.lock, pipeline: staged.pipeline, items: staged.components.items() });
  expect(shown).not.toContain(join(config.data_dir, "tmp"));
  expect(shown).not.toMatch(/[\\/]check-/);
  expect(shown).not.toContain(root);
  // what fromLock rebuilds from the lock is the staged loop
  const again = d.loops.fromLock(staged.lock, into);
  if (typeof again === "string") throw new Error(again);
  expect(again.pipeline).toEqual(staged.pipeline);
  expect(again.components.items()).toEqual(staged.components.items());
});

test("staging writes nothing live: the chain's entries, every file of every root and the content store's file list are what they were", () => {
  // list the content store's folder and hash every root file before and after; compare chain.read().length
  const d = deps();
  const into = stagedInto();
  const files = [skillChange(), loopEdit("tools: [list_cards, read_card, verify_card]\n", "tools: [list_cards, read_card]\n")];
  const head = wb.chain.read().length;
  const types = wb.chain.read().map((e) => e.type);
  const rootFiles = hashes(root);
  const content = readdirSync(join(config.data_dir, "blobs")).sort();
  const tmp = hashes(join(config.data_dir, "tmp"));
  stage(files, into, d);
  expect(wb.chain.read().length).toBe(head);
  expect(wb.chain.read().map((e) => e.type)).toEqual(types);
  expect(types.filter((t) => t === "loop.recorded" || t === "module.loaded" || t === "manifest.written").length).toBe(wb.chain.read().filter((e) => ["loop.recorded", "module.loaded", "manifest.written"].includes(e.type)).length);
  expect(hashes(root)).toEqual(rootFiles);
  expect(readdirSync(join(config.data_dir, "blobs")).sort()).toEqual(content);
  // the check's temporary folder is gone
  expect(hashes(join(config.data_dir, "tmp"))).toEqual(tmp);
  // the next load of the roots is the loop as it was
  expect(load().loops.current(TARGET)!.pipeline.hash).toBe(d.loops.current(TARGET)!.pipeline.hash);
});

test("the bytes the content store lacks are in `into`: fromLock(lock, into) rebuilds the loop, fromLock(lock) does not", () => {
  const d = deps();
  const into = stagedInto();
  const folder = join(config.data_dir, "staged", "IMP-1", "blobs");
  const staged = stage([skillChange()], into, d);
  const skillHash = sha256Hex(new TextEncoder().encode(skillChange().text));
  // `into` holds the new skill and nothing the content store holds
  const held = readdirSync(folder).sort();
  expect(held).toContain(skillHash);
  for (const h of held) expect({ h, live: wb.chainBlobs.has(h) }).toEqual({ h, live: false });
  expect(wb.chainBlobs.has(skillHash)).toBe(false);
  const back = d.loops.fromLock(staged.lock, into);
  expect(typeof back).toBe("object");
  expect(d.loops.fromLock(staged.lock)).toBe(`the content store does not hold skill "ask-the-person" (${skillHash})`);
  // a loop file changed inline: its bytes are in `into` too
  const loop = loopEdit("tools: [list_cards, read_card, verify_card]\n", "tools: [list_cards, read_card]\n");
  const into2 = new BlobStore(join(config.data_dir, "staged", "IMP-2", "blobs"));
  const staged2 = stage([loop], into2, d);
  expect(staged2.manifest.version).toBe(2);
  expect(staged2.pipeline.stages.find((s) => s.id === "evaluate")!.tools).toEqual(["list_cards", "read_card"]);
  expect(into2.has(sha256Hex(new TextEncoder().encode(loop.text)))).toBe(true);
  expect(typeof d.loops.fromLock(staged2.lock)).toBe("string");
});

test("loops.current(target) and loops.atHash(target, staged hash) do not return the staged version", () => {
  const d = deps();
  const current = d.loops.current(TARGET)!;
  const staged = stage([skillChange()], stagedInto(), d);
  const loops = load().loops;
  expect(loops.current("unknown-device")!.pipeline.hash).toBe(current.pipeline.hash);
  expect(loops.atHash("unknown-device", staged.pipeline.hash)).toContain("is not in this workbench");
  expect(d.loops.atHash("unknown-device", staged.pipeline.hash)).toContain("is not in this workbench");
  expect(loops.list().find((x) => x.id === TARGET)!.loop!.pipeline.hash).toBe(current.pipeline.hash);
  // the live registry, which the route finder reads, holds the skill as it was, in its root
  for (const r of [d.registry, load().registry]) {
    const skill = r.get("skill", "ask-the-person")!;
    expect(skill.hash).toBe(sha256Hex(new TextEncoder().encode(read(SKILL))));
    expect(skill.text).toContain(SKILL_TEXT);
    expect(r.manifests().every((m) => m.root === root)).toBe(true);
  }
});

test("a candidate that changes a playbook's steps and a source's field notes is staged whole: its lock names both files, and its hash covers them", () => {
  const d = deps();
  const current = d.loops.current(TARGET)!;
  const into = stagedInto();
  // a playbook's steps and a source's field notes are read by no component of the lock: they are its staged items
  const files = [edit("playbooks/address-triage.yaml", "max_values: 5", "max_values: 3"), edit("sources/wifi.yaml", "A disconnection message names neither.", "A disconnection message names neither the host nor the access point.")];
  const staged = stage(files, into, d);
  expect(staged.pipeline.hash).not.toBe(current.pipeline.hash);
  expect(staged.lock.hash).toBe(staged.pipeline.hash);
  // what the loop's components are is the current version's; the two files are named beside them
  expect(staged.lock.items.filter((i) => i.source !== "staged")).toEqual(current.lock.items);
  const named = staged.lock.items.filter((i) => i.source === "staged").map((i) => [i.stage, i.kind, i.id, i.path, i.hash]);
  const hashOf = (t: string) => sha256Hex(new TextEncoder().encode(t));
  expect(named).toEqual([["*", "playbook", "address-triage", files[0]!.path, hashOf(files[0]!.text)], ["*", "source", "wifi", files[1]!.path, hashOf(files[1]!.text)]]);
  // their bytes are in the staging store and nowhere else; the lock is rebuilt only over it
  expect(Object.keys(hashes(join(config.data_dir, "staged", "IMP-1", "blobs"))).sort()).toEqual([hashOf(files[0]!.text), hashOf(files[1]!.text)].sort());
  expect(d.loops.fromLock(staged.lock)).toContain("only a probe child binds it");
  // the same files staged again give the same version; one of them alone, another
  expect(stage(files, into, d).pipeline.hash).toBe(staged.pipeline.hash);
  expect(stage(files.slice(1), into, d).pipeline.hash).not.toBe(staged.pipeline.hash);
});

test("a candidate that breaks the loop is { ok: false } with the loop's problem, and `into` is left as it was", () => {
  const d = deps();
  const into = stagedInto();
  const folder = join(config.data_dir, "staged", "IMP-1", "blobs");
  stage([skillChange()], into, d);
  const before = hashes(folder);
  // a tool no stage may have: the rules allow a stage's tools to change, the loop does not resolve
  const broken = loopEdit("tools: [list_cards, read_card, verify_card]\n", "tools: [list_cards, read_card, no_such_tool]\n");
  const got = stageCandidate(d, root, [broken, edit(SKILL, SKILL_TEXT, "Ask early.")], TARGET, into);
  expect(got.ok).toBe(false);
  if (got.ok) return;
  expect(got.problems.length).toBeGreaterThan(0);
  expect(got.problems.every((p) => p.startsWith(`loop "${TARGET}": `))).toBe(true);
  expect(got.problems.join(" | ")).toContain("no_such_tool");
  expect(hashes(folder)).toEqual(before);
  // a file the rules refuse is refused before anything is staged
  const refused = stageCandidate(d, root, [{ path: "context/skills/new-skill.md", text: "---\nkind: skill\nid: new-skill\ntitle: New\n---\nBe brief.\n" }], TARGET, into);
  expect(refused).toEqual({ ok: false, problems: ["context/skills/new-skill.md: a candidate changes what the loop has; it adds no file"] });
  expect(hashes(folder)).toEqual(before);
});

test("staging the same files twice gives the same hash", () => {
  const d = deps();
  const files = [skillChange(), loopEdit("tools: [list_cards, read_card, verify_card]\n", "tools: [list_cards, read_card]\n")];
  const a = stage(files, stagedInto(), d);
  const b = stage(files, new BlobStore(join(config.data_dir, "staged", "IMP-2", "blobs")), deps());
  expect(b.pipeline.hash).toBe(a.pipeline.hash);
  expect(b.lock).toEqual(a.lock);
  expect(hashes(join(config.data_dir, "staged", "IMP-2", "blobs"))).toEqual(hashes(join(config.data_dir, "staged", "IMP-1", "blobs")));
});

test("a procedure is saved by saveManifests for a person, and by no one else", () => {
  expect(WRITABLE_KINDS).toContain("procedure");
  const path = "context/procedures/research.md";
  const f = edit(path, "Say what was not found.", "Say what was not found, and why.");
  const before = read(path);
  for (const actor of [{ kind: "system", id: "improve-probe" }, { kind: "agent", id: "loop-builder" }] as Actor[]) {
    expect(() => saveManifests(deps(), root, [f], { actor, why: "builder", session: null })).toThrow("only a person may write a manifest into a root");
    expect(read(path)).toBe(before);
  }
  const head = wb.chain.read().length;
  expect(saveManifests(deps(), root, [f], { actor: human, why: "builder", session: null }).ok).toBe(true);
  expect(read(path)).toBe(f.text);
  const written = wb.chain.read().slice(head);
  expect(written.map((e) => e.type)).toEqual(["manifest.written"]);
  expect(written[0]!.payload).toMatchObject({ path, kind: "procedure", id: "research-sop", before: sha256Hex(new TextEncoder().encode(before)) });
  // and the next load reads it: the target's lock names the new text
  expect(load().loops.current(TARGET)!.components.get("research", "procedure", "research-sop")!.text).toContain("and why.");
});
