import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadProfile } from "../../src/agents/context";
import { loadProviders } from "../../src/agents/providers";
import { loadConfig } from "../../src/modules/config";
import { Registry } from "../../src/modules/registry";
import { Secrets } from "../../src/modules/secrets";
import { loadChecks, loadPipeline } from "../../src/pipeline/manifests";
import { configFor, newRoot } from "../../scripts/new-root";
import { cleanEnv } from "../helpers/clean-env";

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, "scripts", "new-root.ts");
let tmp: string;
let n = 0;
const fresh = (): string => join(tmp, `root-${++n}`);

beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "new-root-")); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });


test("the new root loads whole, with every agent stage on the local model and nothing scripted", () => {
  const root = fresh();
  const files = newRoot(root, { base_url: "http://127.0.0.1:1234/v1", model: "example/model-a" });
  expect(files).toEqual([...files].sort());
  const registry = Registry.load([{ path: root, trusted: true, credentials: [] }]);
  expect(registry.problems).toEqual([]);
  const { pipeline, problems } = loadPipeline(registry);
  expect(problems).toEqual([]);
  expect(pipeline!.stages.filter((s) => s.runs === "agent").every((s) => s.model!.provider === "local" && s.model!.model === "example/model-a")).toBe(true);
  expect(loadChecks(registry)).toMatchObject({ problems: [], broken: [] });
  expect(loadChecks(registry).checks.length).toBe(11);
  expect(() => loadProfile(registry, "investigation")).not.toThrow();
  const loaded = loadProviders(registry, new Secrets({}, null));
  expect(loaded.problems).toEqual([]);
  expect(loaded.providers.all().map((p) => [p.id, p.kind, p.where])).toEqual([["local", "local", "machine"]]);
  expect(registry.sources()).toEqual([]);
  expect(registry.types().map((t) => t.id).sort()).toEqual(["address", "domain"]);
  for (const f of files) expect(readFileSync(join(root, f), "utf8")).not.toMatch(/scripted|sample-run/);
});

test("an existing non-empty directory is refused and left as it was; an empty one is not", () => {
  const root = fresh();
  mkdirSync(root);
  writeFileSync(join(root, "keep"), "x");
  expect(() => newRoot(root, { base_url: "http://127.0.0.1:1234/v1", model: "m" })).toThrow();
  expect(readdirSync(root)).toEqual(["keep"]);
});

test("a target inside the repository is refused before anything is written", () => {
  const inside = join(REPO, "tests", "cli", "never-made-by-new-root");
  expect(() => newRoot(inside, { base_url: "http://127.0.0.1:1234/v1", model: "m" })).toThrow("repository");
  expect(existsSync(inside)).toBe(false);
});

test("a machine model on a name is refused before anything is written", () => {
  const root = fresh();
  expect(() => newRoot(root, { base_url: "http://localhost:1234/v1", model: "m" })).toThrow("numeric address");
  expect(existsSync(root)).toBe(false);
});

test("the command prints the files and a configuration that loads", () => {
  const home = join(tmp, "home");
  mkdirSync(home);
  const root = join(tmp, "cmd-root");
  const r = Bun.spawnSync(["bun", "run", SCRIPT, root, "--base-url", "http://127.0.0.1:1234/v1", "--model", "example/model-a"], { cwd: REPO, timeout: 60_000, env: cleanEnv(home), stdout: "pipe", stderr: "pipe" });
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
  const out = r.stdout.toString();
  expect(out).toContain("models/local.yaml");
  const at = out.indexOf("data_dir:");
  expect(at).toBeGreaterThan(-1);
  const path = join(tmp, "config.yaml");
  writeFileSync(path, out.slice(at));
  const cfg = loadConfig({ path, env: {}, home });
  expect(cfg.roots).toEqual([{ path: root, trusted: true, credentials: [] }]);
  expect(basename(cfg.roots[0]!.path)).toBe("cmd-root");
  expect(cfg.research.parallel).toBe(1);
});

test("a bad command line exits 2 with usage, and a refusal exits 1", () => {
  const home = join(tmp, "home");
  const run = (args: string[]) => Bun.spawnSync(["bun", "run", SCRIPT, ...args], { cwd: REPO, timeout: 60_000, env: cleanEnv(home), stdout: "pipe", stderr: "pipe" });
  const bad = run([join(tmp, "x")]);
  expect(bad.exitCode).toBe(2);
  expect(bad.stderr.toString()).toContain("usage");
  const refused = run([join(tmp, "y"), "--base-url", "http://127.0.0.1:1/v1", "--model", "m", "--where", "bogus"]);
  expect(refused.exitCode).toBe(2);
  const inRepo = run([join(REPO, "tests", "never-made"), "--base-url", "http://127.0.0.1:1/v1", "--model", "m"]);
  expect(inRepo.exitCode).toBe(1);
  expect(existsSync(join(REPO, "tests", "never-made"))).toBe(false);
});

test("the printed configuration points at the root whatever the folder is called", () => {
  for (const name of ["a, b", "a: b", "{x}", "x #y", "it's", "[z]"]) {
    const dir = join(tmp, "names", name);
    const path = join(tmp, "names", "config.yaml");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, configFor(dir));
    const cfg = loadConfig({ path, env: {}, home: tmp });
    expect(cfg.roots).toEqual([{ path: dir, trusted: true, credentials: [] }]);
    expect(cfg.research.parallel).toBe(1);
  }
});

const sampleCopy = (): string => {
  const s = fresh();
  cpSync(join(REPO, "sample"), s, { recursive: true, filter: (p) => !/[\\/]sample[\\/](?:data|fixture)(?:[\\/]|$)/.test(p) });
  return s;
};
const OPTS = { base_url: "http://127.0.0.1:1234/v1", model: "m" };

test("a stage whose model line cannot be rewritten in place is refused, naming the file, before anything is written", () => {
  const sample = sampleCopy();
  const f = join(sample, "stages", "plan.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^model:.*$/m, "model:\n  provider: scripted\n  model: sample-run\n  effort: null"));
  const root = fresh();
  expect(() => newRoot(root, { ...OPTS, sample })).toThrow("plan.yaml");
  expect(existsSync(root)).toBe(false);
});

test("a sample holding a symbolic link or lacking a folder is refused before anything is written", () => {
  const linked = sampleCopy();
  symlinkSync(join(linked, "context", "rules.md"), join(linked, "context", "alias.md"));
  const root = fresh();
  expect(() => newRoot(root, { ...OPTS, sample: linked })).toThrow("alias.md");
  expect(existsSync(root)).toBe(false);
  const gutted = sampleCopy();
  rmSync(join(gutted, "checks"), { recursive: true });
  expect(() => newRoot(root, { ...OPTS, sample: gutted })).toThrow("checks");
  expect(existsSync(root)).toBe(false);
});
