import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { BlobStore } from "../../src/core/blobs";
import { sha256Hex } from "../../src/core/hash";
import { Ledger } from "../../src/core/ledger";
import { checkLoopFile, LoopFileError, loopFileName } from "../../src/core/loopfile";
import type { LoopFileManifest } from "../../src/core/loopfile";
import { Refused } from "../../src/core/refused";
import { loadConfig, rootsOf } from "../../src/modules/config";
import type { Config, RootConfig } from "../../src/modules/config";
import { exportFiles, exportLoop, importLoop, planImport, sourceShape } from "../../src/modules/loop-import";
import type { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import { Secrets } from "../../src/modules/secrets";
import { loadLoops } from "../../src/pipeline/loops";
import type { LoopCatalog } from "../../src/pipeline/loops";
import { copySample } from "../helpers/sample-root";

const SECRET = "s3cr3t-value-0001";
const HOST = "warehouse.example.net";
const USER = "svc-reader-placeholder";

let dir: string;
let root: string;
let data: string;
let secrets: string[];
const open: Ledger[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rw-loop-import-"));
  root = join(dir, "sample");
  data = join(dir, "data");
  copySample(root);
  // a source that names a host, a user and a credential granted to the root, with a secret value in its location
  writeFileSync(join(root, "sources", "warehouse.yaml"), [
    "kind: source", "id: warehouse", "title: Event warehouse", "connector: trino", `location: "https://${USER}:${SECRET}@${HOST}:8443"`,
    "credential: lake", `user: ${USER}`, "tls_verify: false", 'marking: "TLP:GREEN"', "where: network", "cost: { weight: 1, unit: rows }", "",
  ].join("\n"));
  const loop = join(root, "loops", "investigation.yaml");
  writeFileSync(loop, readFileSync(loop, "utf8") + "uses:\n  playbooks: [address-triage]\n  pivots: [address_to_domains, address_to_verdict]\n  sources: [reputation, warehouse]\n");
  // what is in the root and must never be exported: data, a case, a configuration (the sample's models/ and scripts/ are there already)
  mkdirSync(join(root, "data", "cases", "CASE-1"), { recursive: true });
  writeFileSync(join(root, "data", "cases", "CASE-1", "ledger.sqlite"), "case data");
  writeFileSync(join(root, "data", "note.yaml"), "kind: persona\nid: from-data\n");
  mkdirSync(data, { recursive: true });
  const secretsFile = join(data, "secrets.yaml");
  writeFileSync(secretsFile, `lake: "${SECRET}"\n`);
  chmodSync(secretsFile, 0o600);
  secrets = [new Secrets({}, secretsFile).get("lake")!];
});
afterEach(() => {
  for (const l of open.splice(0)) l.close();
  rmSync(dir, { recursive: true, force: true });
});

const trusted = (path: string): RootConfig => ({ path, trusted: true, credentials: ["lake"] });
/** A registry and a loop catalogue over `roots`, with a chain and a content store of their own. */
function workbench(roots: RootConfig[], name = "wb"): { registry: Registry; loops: LoopCatalog } {
  const chain = Ledger.open(join(dir, `${name}-${open.length}.db`), "workbench");
  open.push(chain);
  const content = new BlobStore(join(dir, `${name}-${open.length}-blobs`));
  const registry = loadRegistry(roots, { chain, content });
  const ctx = { registry, content, chain, trusted: roots.filter((r) => r.trusted).map((r) => r.path), output: () => null };
  return { registry, loops: loadLoops(registry, ctx, { max_depth: 2, max_children: 8 }) };
}
const sampleWb = (): { registry: Registry; loops: LoopCatalog } => workbench([trusted(root)]);
/** A configuration whose own roots are `roots`, its data folder `at`. */
function configOf(at: string, roots: { path: string; trusted: boolean; credentials?: string[] }[]): Config {
  mkdirSync(at, { recursive: true });
  const p = join(at, "config.yaml");
  writeFileSync(p, `data_dir: ${JSON.stringify(at)}\nroots:\n${roots.map((r) => `  - { path: ${JSON.stringify(r.path)}, trusted: ${r.trusted}, credentials: [${(r.credentials ?? []).join(", ")}] }`).join("\n")}\n`);
  return loadConfig({ path: p, env: {}, home: at, repoRoot: at });
}
/** The sample's investigation loop exported into dir/out. */
async function exported(): Promise<{ file: string; path: string; manifest: LoopFileManifest }> {
  const { registry, loops } = sampleWb();
  return exportLoop({ loops, registry, secrets }, "investigation", join(dir, "out"));
}
const tarText = (file: string): string => new TextDecoder().decode(gunzipSync(readFileSync(file)));
async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(Refused);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}
/** An empty trusted root and its configuration: a workbench that has none of the loop. */
function emptyWorkbench(): { config: Config; own: string } {
  const own = join(dir, "other", "own");
  mkdirSync(own, { recursive: true });
  return { config: configOf(join(dir, "other", "data"), [{ path: own, trusted: true }]), own };
}

test("export holds the loop manifest, the nine stages, the profile, every persona, rules, skill, procedure, schema, framework and standard of the lock, the eleven checks and their scripts, and what uses names", async () => {
  const { registry, loops } = sampleWb();
  const loop = loops.current("investigation")!;
  const { file, path, manifest } = await exportLoop({ loops, registry, secrets }, "investigation", join(dir, "out"));
  expect(file).toBe(loopFileName("investigation", 1, loop.pipeline.hash));
  expect(path).toBe(join(dir, "out", file));
  expect(manifest).toMatchObject({ loop: "investigation", version: 1, title: "Investigation", hash: loop.pipeline.hash, legacy_hash: loop.pipeline.legacy_hash, subloops: [] });
  expect(manifest.lock).toEqual(JSON.parse(JSON.stringify(loop.lock)));
  const byKind = (kind: string): string[] => manifest.files.filter((f) => f.kind === kind).map((f) => f.id).sort();
  expect(byKind("loop")).toEqual(["investigation"]);
  expect(byKind("stage")).toEqual(["assemble", "challenge", "checks", "evaluate", "feedback", "frame", "plan", "publish", "research"]);
  expect(byKind("profile")).toEqual(["investigation"]);
  const ofLock = (kind: string): string[] => [...new Set(loop.lock.items.filter((i) => i.kind === kind).map((i) => i.id))].sort();
  expect(byKind("persona")).toEqual(ofLock("persona"));
  expect(byKind("persona")).toEqual(expect.arrayContaining(["adversary", "analyst", "evaluator", "orchestrator", "planner", "publisher", "researcher"]));
  expect(byKind("rules")).toEqual(["base-rules"]);
  expect(byKind("skill")).toEqual(["ask-the-person"]);
  expect(byKind("procedure")).toEqual(["assemble-sop", "research-sop"]);
  expect(byKind("schema")).toHaveLength(8);
  expect(byKind("framework")).toEqual(["intel-cycle"]);
  expect(byKind("standard")).toEqual(["icd203"]);
  expect(byKind("check")).toHaveLength(11);
  expect(byKind("check-script")).toEqual(byKind("check"));
  expect(manifest.files.find((f) => f.kind === "check-script" && f.id === "citations")!.path).toBe("checks/04-citations.ts");
  expect(byKind("playbook")).toEqual(["address-triage"]);
  expect(manifest.files.filter((f) => f.kind === "pivots").map((f) => f.path)).toEqual(["pivots.yaml"]);
  // the named sources, and the one each named pivot uses (address_to_domains reads dns-logs)
  expect(byKind("source")).toEqual(["dns-logs", "reputation", "warehouse"]);
  // every item of the lock that has a file is there, at its root-relative path, with its hash
  for (const item of loop.lock.items.filter((i) => i.path !== null)) {
    expect(manifest.files.find((f) => f.path === item.path)?.sha256).toBe(item.hash);
  }
  // nothing else
  expect(manifest.files).toHaveLength(new Set(loop.lock.items.filter((i) => i.path !== null).map((i) => i.path)).size + 1 + 1 + 1 + 3);
  expect(await checkLoopFile(path)).toEqual(manifest);
});

test("an exported source is a shape: location unset, no credential, user or tls_verify, confirmed false; its entry's origin is the hash of the source as the root has it", async () => {
  const { path, manifest } = await exported();
  const got = new Map<string, Uint8Array>();
  const { readLoopFile } = await import("../../src/core/loopfile");
  await readLoopFile(path, (e, b) => void got.set(e.path, b));
  const text = new TextDecoder().decode(got.get("sources/warehouse.yaml")!);
  const body = Bun.YAML.parse(text) as Record<string, unknown>;
  expect(body).toEqual({ kind: "source", id: "warehouse", title: "Event warehouse", connector: "trino", location: "unset", marking: "TLP:GREEN", where: "network", cost: { weight: 1, unit: "rows" }, confirmed: false });
  // everything else as written: the lines that stay are the root's own lines
  expect(text).toContain('marking: "TLP:GREEN"\nwhere: network\ncost: { weight: 1, unit: rows }\n');
  const entry = manifest.files.find((f) => f.path === "sources/warehouse.yaml")!;
  expect(entry.origin).toBe(sha256Hex(readFileSync(join(root, "sources", "warehouse.yaml"))));
  const rep = Bun.YAML.parse(new TextDecoder().decode(got.get("sources/reputation.yaml")!)) as Record<string, unknown>;
  expect(rep.location).toBe("unset");
  expect(rep.confirmed).toBe(false);
  expect(rep.endpoints).toEqual((Bun.YAML.parse(readFileSync(join(root, "sources", "reputation.yaml"), "utf8")) as Record<string, unknown>).endpoints);
  // a manifest that is not a source keeps its bytes and has no origin
  expect(manifest.files.find((f) => f.path === "playbooks/address-triage.yaml")).toMatchObject({ origin: null, sha256: sha256Hex(readFileSync(join(root, "playbooks", "address-triage.yaml"))) });
  // sourceShape on its own: a source with a block under location and a confirmed of its own; an odd layout still comes out a shape
  expect(Bun.YAML.parse(sourceShape("kind: source\nid: s\nlocation: >\n  http://192.0.2.1\nconfirmed: true\nuser:\n  - a\ntitle: S\n"))).toEqual({ kind: "source", id: "s", location: "unset", confirmed: false, title: "S" });
  expect(Bun.YAML.parse(sourceShape('{"kind":"source","id":"s","location":"http://192.0.2.1","credential":"c","title":"S"}'))).toEqual({ kind: "source", id: "s", location: "unset", title: "S", confirmed: false });
});

test("the file holds no model manifest, no script manifest, no configuration, nothing from a data folder and no case", async () => {
  const { path, manifest } = await exported();
  expect(manifest.files.filter((f) => ["model", "script"].includes(f.kind))).toEqual([]);
  for (const f of manifest.files) {
    expect(f.path.startsWith("models/") || f.path.startsWith("scripts/") || f.path.split("/").includes("data") || f.path.includes("config")).toBe(false);
  }
  const text = tarText(path);
  expect(text).not.toContain("kind: model");
  expect(text).not.toContain("kind: script");
  expect(text).not.toContain("case data");
  expect(text).not.toContain("from-data");
  expect(text).not.toContain("data_dir");
  expect(text).not.toContain("CASE-1");
});

test("no byte of the file holds the planted secret, the source's host or its credential name", async () => {
  const { path } = await exported();
  const text = tarText(path);
  for (const word of [SECRET, HOST, "lake", USER, "127.0.0.1", "tls_verify", dir, root]) expect(text).not.toContain(word);
  expect(readFileSync(path).includes(Buffer.from(SECRET))).toBe(false);
});

test("a secret value written into a persona refuses the export and leaves no file", async () => {
  const persona = join(root, "context", "personas", "analyst.md");
  writeFileSync(persona, readFileSync(persona, "utf8") + `\nThe password is ${SECRET}.\n`);
  const { registry, loops } = sampleWb();
  const loop = loops.current("investigation")!;
  let said = "";
  try { exportFiles(loop, loops, registry, secrets); } catch (err) { expect(err).toBeInstanceOf(Refused); said = (err as Error).message; }
  expect(said).toContain("context/personas/analyst.md");
  expect(said).not.toContain(SECRET);
  const out = join(dir, "out");
  const message = await refused(exportLoop({ loops, registry, secrets }, "investigation", out));
  expect(message).toBe(said);
  expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
  // a value shorter than 8 characters is not a secret value here
  expect(exportFiles(loop, loops, registry, ["The"]).length).toBeGreaterThan(0);
});

test("a loop that runs another exports both loops and both locks", async () => {
  const inline = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    id, title: id, order: 1, runs: "agent", role: "frame", tools: [], schema: "frame-output", model: { provider: "scripted", model: "sample-run", effort: null }, on_pass: null, on_fail: null, ...over,
  });
  const sub = { id: "inv", title: "Investigate", order: 2, runs: "loop", role: "subloop", loop: "investigation", inputs: { question: "case.question", observables: "case.observables", window: "case.window" }, returns: { findings: { as: "cards" } }, on_pass: null, on_fail: null };
  writeFileSync(join(root, "loops", "outer.yaml"), JSON.stringify({ kind: "loop", id: "outer", title: "Outer", version: 2, profile: "investigation", entry: "frame", stages: [inline("frame", { on_pass: "inv" }), sub] }));
  const { registry, loops } = sampleWb();
  const outer = loops.current("outer");
  expect(loops.problems("outer")).toEqual([]);
  const inner = loops.current("investigation")!;
  const { manifest } = await exportLoop({ loops, registry, secrets }, "outer", join(dir, "out"));
  expect(manifest.loop).toBe("outer");
  expect(manifest.hash).toBe(outer!.pipeline.hash);
  expect(manifest.lock).toEqual(JSON.parse(JSON.stringify(outer!.lock)));
  expect(manifest.subloops).toEqual([JSON.parse(JSON.stringify(inner.lock))]);
  expect(manifest.files.filter((f) => f.kind === "loop").map((f) => f.path).sort()).toEqual(["loops/investigation.yaml", "loops/outer.yaml"]);
  expect(manifest.files.filter((f) => f.kind === "stage")).toHaveLength(9);
  expect(manifest.files.filter((f) => f.kind === "check")).toHaveLength(11);
});

test("import into a workbench that has none of it writes every file under <imports>/<loop>-<hash12> and the registry, loaded with rootsOf, refuses each trusted-only kind there by name", async () => {
  const { path, manifest } = await exported();
  const { config, own } = emptyWorkbench();
  const before = loadRegistry(rootsOf(config));
  const plan = await planImport(path, before, config.loops.imports);
  const folder = join(config.loops.imports, `investigation-${manifest.hash.slice(0, 12)}`);
  expect(plan.root).toBe(folder);
  expect(plan.conflicts).toEqual([]);
  expect(plan.same).toEqual([]);
  expect(plan.write).toEqual(manifest.files);
  expect(existsSync(config.loops.imports)).toBe(false); // the plan wrote nothing
  const done = await importLoop(path, before, config.loops.imports);
  expect(done).toEqual({ root: folder, written: manifest.files, same: [] });
  for (const f of manifest.files) expect(sha256Hex(readFileSync(join(folder, f.path)))).toBe(f.sha256);
  expect(readdirSync(join(dir, "other", "own"))).toEqual([]);
  expect(own).toBe(join(dir, "other", "own"));
  // the imported folder is a root that is not trusted
  const roots = rootsOf(config);
  expect(roots).toEqual([{ path: own, trusted: true, credentials: [] }, { path: folder, trusted: false, credentials: [] }]);
  const after = loadRegistry(roots);
  const problem = (rel: string): string | undefined => after.problems.find((p) => p.path === join(folder, rel))?.error;
  expect(problem("loops/investigation.yaml")).toBe("a loop manifest is accepted only from a trusted root");
  expect(problem("stages/frame.yaml")).toBe("a stage manifest is accepted only from a trusted root");
  expect(problem("context/personas/analyst.md")).toBe("a persona manifest is accepted only from a trusted root");
  expect(problem("checks/04-citations.yaml")).toBe("a check manifest is accepted only from a trusted root");
  expect(after.get("loop", "investigation")).toBeNull();
  expect(after.get("stage", "frame")).toBeNull();
});

test("a file whose kind and id the registry holds with the same hash is left out, and the manifest the person had is still loaded afterwards", async () => {
  const { path, manifest } = await exported();
  // import the sample's own export into the sample
  const config = configOf(join(dir, "home"), [{ path: root, trusted: true, credentials: ["lake"] }]);
  const registry = loadRegistry(rootsOf(config));
  const plan = await planImport(path, registry, config.loops.imports);
  expect(plan.conflicts).toEqual([]);
  expect(plan.write).toEqual([]);
  expect(plan.same.map((f) => f.path)).toEqual(manifest.files.map((f) => f.path));
  const done = await importLoop(path, registry, config.loops.imports);
  expect(done.written).toEqual([]);
  expect(readdirSync(done.root)).toEqual([]);
  const reloaded = loadRegistry(rootsOf(config));
  expect(reloaded.source("reputation")).not.toBeNull();
  expect(reloaded.source("warehouse")).not.toBeNull();
  expect(reloaded.pivot("address_to_domains")).not.toBeNull();
  expect(reloaded.playbook("address-triage")).not.toBeNull();
  expect(reloaded.problems.filter((p) => p.error.includes("two module roots"))).toEqual([]);
});

test("a file whose kind and id the registry holds with another hash refuses the whole import by name, and nothing is written", async () => {
  const { path } = await exported();
  const mine = join(dir, "mine");
  fs.cpSync(root, mine, { recursive: true });
  const pb = join(mine, "playbooks", "address-triage.yaml");
  writeFileSync(pb, readFileSync(pb, "utf8").replace("title: Triage an address", "title: Triage an address, my way"));
  const config = configOf(join(dir, "home"), [{ path: mine, trusted: true, credentials: ["lake"] }]);
  const registry = loadRegistry(rootsOf(config));
  const plan = await planImport(path, registry, config.loops.imports);
  expect(plan.conflicts).toEqual([{ kind: "playbook", id: "address-triage", have: registry.get("playbook", "address-triage")!.hash, file: "playbooks/address-triage.yaml" }]);
  const said = await refused(importLoop(path, registry, config.loops.imports));
  expect(said).toContain('playbook "address-triage"');
  expect(said).toContain("nothing was imported");
  expect(existsSync(config.loops.imports) ? readdirSync(config.loops.imports) : []).toEqual([]);
  expect(loadRegistry(rootsOf(config)).playbook("address-triage")).not.toBeNull();
});

test("a pivot file that holds one pivot id the registry has with other bytes refuses the import", async () => {
  const { path } = await exported();
  // the person's own root holds just one pivot of the sample's file, in a file of its own
  const mine = join(dir, "mine");
  fs.cpSync(root, mine, { recursive: true });
  const all = Bun.YAML.parse(readFileSync(join(mine, "pivots.yaml"), "utf8")) as { pivots: { id: string }[] };
  writeFileSync(join(mine, "pivots.yaml"), JSON.stringify({ kind: "pivots", pivots: all.pivots.filter((p) => p.id === "address_to_verdict") }));
  const config = configOf(join(dir, "home"), [{ path: mine, trusted: true, credentials: ["lake"] }]);
  const registry = loadRegistry(rootsOf(config));
  expect(registry.pivot("address_to_verdict")).not.toBeNull();
  expect(registry.pivot("address_to_domains")).toBeNull();
  const plan = await planImport(path, registry, config.loops.imports);
  expect(plan.conflicts).toEqual([{ kind: "pivot", id: "address_to_verdict", have: registry.get("pivot", "address_to_verdict")!.hash, file: "pivots.yaml" }]);
  const said = await refused(importLoop(path, registry, config.loops.imports));
  expect(said).toContain('pivot "address_to_verdict"');
  expect(existsSync(config.loops.imports) ? readdirSync(config.loops.imports) : []).toEqual([]);
});

test("the same loop file imported twice is refused the second time", async () => {
  const { path, manifest } = await exported();
  const { config } = emptyWorkbench();
  const registry = loadRegistry(rootsOf(config));
  const first = await importLoop(path, registry, config.loops.imports);
  const name = `investigation-${manifest.hash.slice(0, 12)}`;
  const said = `this loop file is already imported as ${name}`;
  expect(await refused(planImport(path, registry, config.loops.imports))).toBe(said);
  expect(await refused(importLoop(path, loadRegistry(rootsOf(config)), config.loops.imports))).toBe(said);
  // the first import is left as it was
  for (const f of first.written) expect(sha256Hex(readFileSync(join(first.root, f.path)))).toBe(f.sha256);
});

test("once the configuration trusts the imported root, the loop resolves and its pipeline hash is the one loop.json names", async () => {
  const { path, manifest } = await exported();
  const { config, own } = emptyWorkbench();
  const { root: folder } = await importLoop(path, loadRegistry(rootsOf(config)), config.loops.imports);
  const trustedNow = configOf(join(dir, "other", "data"), [{ path: own, trusted: true }, { path: folder, trusted: true }]);
  const roots = rootsOf(trustedNow);
  expect(roots).toEqual([{ path: own, trusted: true, credentials: [] }, { path: folder, trusted: true, credentials: [] }]);
  const { loops } = workbench(roots, "trusted");
  expect(loops.problems("investigation")).toEqual([]);
  const loop = loops.current("investigation")!;
  expect(loop.pipeline.hash).toBe(manifest.hash);
  expect(loop.pipeline.legacy_hash).toBe(manifest.legacy_hash);
  expect(JSON.parse(JSON.stringify(loop.lock))).toEqual(manifest.lock);
});

test("a failure while writing removes the new folder", async () => {
  const { path } = await exported();
  const { config } = emptyWorkbench();
  const registry = loadRegistry(rootsOf(config));
  let calls = 0;
  const spy = spyOn(fs, "fsyncSync").mockImplementation(() => {
    calls++;
    if (calls === 3) throw new Error("no space left on device");
  });
  let said: string;
  try {
    said = await refused(importLoop(path, registry, config.loops.imports));
  } finally {
    spy.mockRestore();
  }
  expect(calls).toBe(3);
  expect(said).toContain("no space left on device");
  expect(readdirSync(config.loops.imports)).toEqual([]);
  // and the import can be made afresh
  const done = await importLoop(path, registry, config.loops.imports);
  expect(done.written.length).toBeGreaterThan(0);
});

test("a loop file whose members are not what loop.json says they are is refused before anything is written", async () => {
  // a source labelled as a persona would slip past the id rule and take the person's source away
  const { writeLoopFile } = await import("../../src/core/loopfile");
  const { manifest } = await exported();
  const disguised = join(dir, "disguised.loop.tar.gz");
  const src = readFileSync(join(root, "sources", "flows.yaml"));
  await writeLoopFile(disguised, { loop: "x", version: 1, title: "X", about: "", hash: manifest.hash, legacy_hash: null, lock: {}, subloops: [] },
    [{ path: "context/personas/friendly.yaml", kind: "persona", id: "friendly", bytes: new Uint8Array(src), origin: null }]);
  const config = configOf(join(dir, "home"), [{ path: root, trusted: true }]);
  const registry = loadRegistry(rootsOf(config));
  expect(await refused(planImport(disguised, registry, config.loops.imports))).toBe("context/personas/friendly.yaml is a source manifest, and loop.json lists it as a persona");
  const script = join(dir, "script.loop.tar.gz");
  await writeLoopFile(script, { loop: "y", version: 1, title: "Y", about: "", hash: manifest.hash, legacy_hash: null, lock: {}, subloops: [] },
    [{ path: "checks/x.yaml", kind: "check-script", id: "x", bytes: new Uint8Array(src), origin: null }]);
  expect(await refused(planImport(script, registry, config.loops.imports))).toBe("checks/x.yaml: a check's script is not a manifest file");
  const model = join(dir, "model.loop.tar.gz");
  await writeLoopFile(model, { loop: "z", version: 1, title: "Z", about: "", hash: manifest.hash, legacy_hash: null, lock: {}, subloops: [] },
    [{ path: "models/m.yaml", kind: "model", id: "m", bytes: new TextEncoder().encode("kind: model\nid: m\n"), origin: null }]);
  expect(await refused(planImport(model, registry, config.loops.imports))).toBe("models/m.yaml: a loop file holds no model manifest");
  expect(existsSync(config.loops.imports)).toBe(false);
  expect(LoopFileError).toBeDefined();
});
