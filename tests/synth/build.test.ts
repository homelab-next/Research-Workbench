// A synthetic setup built twice with TINY_PARAMS under a fresh temporary folder: once --scripted, once on a model stand-in. Synthetic only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { TINY_PARAMS } from "pivot/synth/params";
import { readGroundTruth } from "pivot/synth/truth";
import { loadConfig } from "../../src/modules/config";
import { loadCaseTypes } from "../../src/modules/case-types";
import { loadRegistry } from "../../src/modules/registry-record";
import { Workbench } from "../../src/core/workbench";
import { compose } from "../../src/cli/compose";
import { buildSetup } from "../../src/synth/build";
import type { Built } from "../../src/synth/build";
import { SynthRefused } from "../../src/synth/setup";
import { newRoot, pointLoop } from "../../scripts/new-root";
import { startModelStandin } from "../helpers/model-standin";

const REPO = join(import.meta.dir, "..", "..");
const SAMPLE = join(REPO, "sample");
const CASE_TYPES = ["cloud-activity", "large-transfer", "suspicious-process", "suspicious-signin", "unknown-device"];

let tmp: string;
let scripted: Built;
let modelled: Built;
let standin: ReturnType<typeof startModelStandin>;
let sampleBefore: Map<string, string>;

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out.sort();
}
const hashes = (dir: string): Map<string, string> => new Map(walk(dir).map((f) => [f, new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, f))).digest("hex")]));

/** Every model a stage file or a loop's inline stage names, by file. */
function modelsOf(root: string): { file: string; model: unknown }[] {
  const out: { file: string; model: unknown }[] = [];
  for (const f of readdirSync(join(root, "stages")).sort()) {
    const m = (Bun.YAML.parse(readFileSync(join(root, "stages", f), "utf8")) as { model?: unknown }).model;
    if (m !== null && m !== undefined) out.push({ file: `stages/${f}`, model: m });
  }
  for (const f of readdirSync(join(root, "loops")).sort()) {
    const loop = Bun.YAML.parse(readFileSync(join(root, "loops", f), "utf8")) as { stages: unknown[] };
    for (const s of loop.stages) if (s !== null && typeof s === "object" && (s as { model?: unknown }).model) out.push({ file: `loops/${f}`, model: (s as { model: unknown }).model });
  }
  return out;
}

/** The problems compose finds over a workbench opened on the setup's data folder, closed again. */
function composeProblems(b: Built): string[] {
  const config = loadConfig({ path: b.config, env: {}, home: join(tmp, "home") });
  const wb = Workbench.open(config.data_dir, { store: config.cases.store, memory: config.memory.store });
  try {
    const c = compose(config, wb);
    c.close();
    return c.problems;
  } finally {
    wb.close();
  }
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "synth-build-"));
  mkdirSync(join(tmp, "home"));
  sampleBefore = hashes(SAMPLE);
  scripted = buildSetup(join(tmp, "scripted"), { params: TINY_PARAMS, model: "scripted" }, null);
  standin = startModelStandin({ models: [{ id: "example/model-a", loaded_context_length: 65536 }], replies: [] });
  modelled = buildSetup(join(tmp, "modelled"), { params: TINY_PARAMS, model: { base_url: standin.url, model: "example/model-a" } }, null);
});
afterAll(() => {
  standin?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

test("the folder holds lake.sqlite, root, truth, data, config.yaml and synth.json, and nothing else", () => {
  for (const b of [scripted, modelled]) {
    expect(readdirSync(b.dir).sort()).toEqual(["config.yaml", "data", "lake.sqlite", "root", "synth.json", "truth"]);
    expect(b.config).toBe(join(b.dir, "config.yaml"));
    expect(b.files).toBeGreaterThan(0);
    const setup = JSON.parse(readFileSync(join(b.dir, "synth.json"), "utf8"));
    expect(readFileSync(join(b.dir, "synth.json"), "utf8").endsWith("}\n")).toBe(true);
    expect(setup).toEqual(b.setup);
    expect(setup.format).toBe(1);
    expect(setup.params).toEqual(TINY_PARAMS);
    expect(setup.pivot).toBe("0.3.2");
    expect(setup.workbench).toBe("0.15.0");
    expect(setup.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(setup.storylines.length).toBe(9);
    expect(setup.left_out).toEqual([]);
    for (const s of setup.storylines) expect(CASE_TYPES).toContain(s.case_type);
    expect(b.tables.length).toBe(13);
  }
  expect(scripted.setup.digest).toBe(modelled.setup.digest);
  expect(scripted.setup.model).toBe("scripted");
  expect(modelled.setup.model).toEqual({ provider: "local", model: "example/model-a" });
});

test("the configuration loads: its data folder and its one trusted root are inside the folder, and its port is 4757", () => {
  const config = loadConfig({ path: scripted.config, env: {}, home: join(tmp, "home") });
  expect(config.data_dir).toBe(join(scripted.dir, "data"));
  expect(config.roots).toEqual([{ path: join(scripted.dir, "root"), trusted: true, credentials: [] }]);
  expect(config.server.port).toBe(4757);
  expect(config.research.parallel).toBe(1);
});

test("the root loads with no problem: thirteen fakeathena sources, the pivots, the ten types, the five case types, the loops investigation and improve", () => {
  const registry = loadRegistry([{ path: join(scripted.dir, "root"), trusted: true, credentials: [] }]);
  expect(registry.problems).toEqual([]);
  expect(registry.sources().length).toBe(13);
  expect(registry.sources().every((s) => s.connector === "fakeathena")).toBe(true);
  expect(registry.pivots().length).toBeGreaterThan(0);
  expect(registry.types().length).toBe(10);
  expect(loadCaseTypes(registry)).toEqual({ types: expect.any(Array), problems: [] });
  expect(loadCaseTypes(registry).types.map((t) => t.id)).toEqual(CASE_TYPES);
  expect(registry.all("loop").map((m) => m.id).sort()).toEqual(["improve", "investigation", "synth-seed"]);
});

test("with --scripted every stage names the scripted model synth-run, and the only problems say that script is missing", () => {
  const root = join(scripted.dir, "root");
  const models = modelsOf(root);
  expect(models.length).toBeGreaterThan(5);
  // the seed loop is on its own scripted model, whatever the setup's other loops use; its script is the only one in the root
  for (const m of models) expect({ file: m.file, model: m.model }).toEqual({ file: m.file, model: { provider: "scripted", model: m.file === "loops/synth-seed.yaml" ? "synth-seed" : "synth-run", effort: null } });
  expect(readdirSync(join(root, "models"))).toEqual(["scripted.yaml"]);
  expect(readdirSync(join(root, "scripts"))).toEqual(["synth-seed.yaml"]);
  for (const p of composeProblems(scripted)) expect(p).toMatch(/synth-run/);
});

test("with a model every stage and every inline stage of the improve loop names it, and compose has no problem", () => {
  const root = join(modelled.dir, "root");
  const models = modelsOf(root);
  expect(models.filter((m) => m.file === "loops/improve.yaml").length).toBe(3);
  for (const m of models) expect({ file: m.file, model: m.model }).toEqual({ file: m.file, model: m.file === "loops/synth-seed.yaml" ? { provider: "scripted", model: "synth-seed", effort: null } : { provider: "local", model: "example/model-a", effort: null } });
  expect(readdirSync(join(root, "models")).sort()).toEqual(["local.yaml", "scripted.yaml"]);
  expect(composeProblems(modelled)).toEqual([]);
});

test("nothing in the root or the data folder holds a truth's summary or a claim", () => {
  for (const b of [scripted, modelled]) {
    const truths = readdirSync(join(b.dir, "truth")).filter((f) => f !== "mess.json");
    expect(truths.length).toBe(9);
    const secrets: string[] = [];
    for (const f of truths) {
      const t = readGroundTruth(readFileSync(join(b.dir, "truth", f)));
      expect(t).not.toBeNull();
      secrets.push(t!.summary, ...t!.findings.map((x) => x.claim));
    }
    for (const where of ["root", "data"]) {
      for (const f of walk(join(b.dir, where))) {
        const text = readFileSync(join(b.dir, where, f), "latin1");
        for (const s of secrets) expect(text.includes(s)).toBe(false);
      }
    }
    expect(readFileSync(join(b.dir, "synth.json"), "utf8")).not.toMatch(/"summary"|"claim"/);
  }
});

test("the sample's own files are untouched and none of its sources, scripts or data is in the root", () => {
  expect(hashes(SAMPLE)).toEqual(sampleBefore);
  const own = new Set<string>();
  for (const d of ["sources", "scripts", "inventories", "playbooks", "memory", "fixture", "data"]) {
    if (!existsSync(join(SAMPLE, d))) continue;
    for (const f of walk(join(SAMPLE, d))) own.add(new Bun.CryptoHasher("sha256").update(readFileSync(join(SAMPLE, d, f))).digest("hex"));
  }
  for (const f of ["types.yaml", "pivots.yaml", "case-types.yaml", "case-types-device-check.yaml"]) own.add(new Bun.CryptoHasher("sha256").update(readFileSync(join(SAMPLE, f))).digest("hex"));
  for (const b of [scripted, modelled]) {
    const root = join(b.dir, "root");
    for (const [f, h] of hashes(root)) expect({ f, sample: own.has(h) }).toEqual({ f, sample: false });
    for (const d of ["data", "fixture", "memory"]) expect(existsSync(join(root, d))).toBe(false);
    expect(readdirSync(join(root, "scripts"))).toEqual(["synth-seed.yaml"]);
    expect(readdirSync(join(root, "loops")).sort()).toEqual(["improve.yaml", "investigation.yaml", "synth-seed.yaml"]);
  }
});

test("a refusal part-way leaves no folder: an overlay with a broken manifest", () => {
  const overlay = join(tmp, "broken-overlay");
  mkdirSync(overlay);
  writeFileSync(join(overlay, "case-types.yaml"), "kind: case-types\nid: synth-case-types\ntitle: Broken\ntypes: 3\n");
  const dir = join(tmp, "refused");
  expect(() => buildSetup(dir, { params: TINY_PARAMS, model: "scripted", overlay }, null)).toThrow(SynthRefused);
  expect(existsSync(dir)).toBe(false);
  const empty = join(tmp, "refused-empty");
  mkdirSync(empty);
  expect(() => buildSetup(empty, { params: TINY_PARAMS, model: "scripted", overlay }, null)).toThrow(SynthRefused);
  expect(readdirSync(empty)).toEqual([]);
  // the parameters, refused by pivot in its own words, before anything is made
  expect(() => buildSetup(join(tmp, "refused-params"), { params: { days: 1 }, model: "scripted" }, null)).toThrow(SynthRefused);
  expect(existsSync(join(tmp, "refused-params"))).toBe(false);
});

test("pointLoop rewrites every inline model line of the improve loop and nothing else; newRoot makes the files it made before", () => {
  const text = readFileSync(join(SAMPLE, "loops", "improve.yaml"), "utf8");
  const out = pointLoop("improve.yaml", text, { provider: "local", model: "example/model-a" });
  const before = text.split("\n"), after = out.split("\n");
  expect(after.length).toBe(before.length);
  const changed = before.map((l, i) => [l, after[i]!] as const).filter(([a, b]) => a !== b);
  expect(changed.length).toBe(3);
  for (const [a, b] of changed) {
    expect(a.trim()).toBe("model: { provider: scripted, model: sample-improve, effort: null }");
    expect(b.trim()).toBe('model: { provider: local, model: "example/model-a", effort: null }');
  }
  expect(pointLoop("investigation.yaml", readFileSync(join(SAMPLE, "loops", "investigation.yaml"), "utf8"), { provider: "local", model: "m" }))
    .toBe(readFileSync(join(SAMPLE, "loops", "investigation.yaml"), "utf8"));
  expect(() => pointLoop("x.yaml", "stages:\n  - id: a\n    model:\n      provider: scripted\n      model: x\n", { provider: "local", model: "m" })).toThrow("cannot be rewritten in place");

  const root = join(tmp, "new-root");
  const files = newRoot(root, { base_url: "http://127.0.0.1:1234/v1", model: "example/model-a" });
  const expected = [
    ...walk(join(SAMPLE, "context")).map((f) => `context/${f}`), ...walk(join(SAMPLE, "checks")).map((f) => `checks/${f}`),
    ...walk(join(SAMPLE, "stages")).map((f) => `stages/${f}`), "models/local.yaml", "pivots.yaml", "types.yaml",
  ].sort();
  expect(files).toEqual(expected);
});
