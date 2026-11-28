// synth build's place check fails closed, and a setup's configuration keeps every folder inside the setup. Every folder here is under a fresh
// temporary one; the build is spawned with a clean environment and a HOME of its own. Synthetic only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/modules/config";
import { ambientConfig } from "../../src/synth/build";
import { placeProblem, setupOf, SETUP_FILE, SynthRefused } from "../../src/synth/setup";
import { cleanEnv } from "../helpers/clean-env";

const REPO = join(import.meta.dir, "..", "..");
let tmp: string;

beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "synth-closed-")); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

function brokenHome(name: string): string {
  const home = join(tmp, name);
  mkdirSync(join(home, ".config", "research-workbench"), { recursive: true });
  writeFileSync(join(home, ".config", "research-workbench", "config.yaml"), "data_dir: [unclosed\n");
  return home;
}

test("ambientConfig refuses, naming it, a home configuration that does not load and an environment's that names no file", () => {
  const home = brokenHome("home-broken");
  const file = join(home, ".config", "research-workbench", "config.yaml");
  expect(() => ambientConfig({ env: {}, home })).toThrow(SynthRefused);
  expect(() => ambientConfig({ env: {}, home })).toThrow(file);
  expect(() => ambientConfig({ env: {}, home })).toThrow("the configuration in use does not load");
  const missing = join(tmp, "nowhere", "config.yaml");
  expect(() => ambientConfig({ env: { RESEARCH_WORKBENCH_CONFIG: missing }, home: join(tmp, "home-broken") })).toThrow(missing);
  // nothing configured: the defaults load, and they are what the build checks against
  mkdirSync(join(tmp, "home-empty"));
  expect(ambientConfig({ env: {}, home: join(tmp, "home-empty") }).path).toBeNull();
});

test("synth build with a home configuration that does not load exits 1, names it, and makes nothing", () => {
  const home = brokenHome("home-cli");
  const dir = join(tmp, "never-built");
  const p = Bun.spawnSync([process.execPath, "run", "synth", "build", dir, "--scripted", "--days", "4", "--users", "12", "--hosts", "16", "--sites", "2", "--volume", "0.05"], { cwd: REPO, env: cleanEnv(home), stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  expect(p.exitCode).toBe(1);
  expect(p.stderr.toString()).toContain(join(home, ".config", "research-workbench", "config.yaml"));
  expect(existsSync(dir)).toBe(false);
});

test("placeProblem refuses the ambient configuration's staged folder", () => {
  const home = join(tmp, "home-staged");
  mkdirSync(home);
  const a = join(tmp, "ambient-staged");
  mkdirSync(a);
  writeFileSync(join(a, "config.yaml"), "data_dir: ./data\nroots: []\nimprove: { staged: ./elsewhere/staged }\n");
  const ambient = loadConfig({ path: join(a, "config.yaml"), env: {}, home });
  const at = join(a, "elsewhere", "staged", "setup");
  expect(placeProblem(at, REPO, ambient)).toBe(`${at} shares a folder with the configuration in use (the staged folder): a synthetic setup has its own`);
});

test("setupOf refuses a setup whose configuration puts its data folder, a store or a root outside the setup's folder", () => {
  const home = join(tmp, "home-setup");
  mkdirSync(home);
  const dir = join(tmp, "a-setup");
  mkdirSync(dir);
  const setup = {
    format: 1, params: { seed: 15, start: "2026-10-01", days: 4, users: 12, hosts: 16, sites: 2, volume: 0.05, scale: 50000 }, pivot: "0.3.0", workbench: "0.15.0",
    digest: "d", storylines: [], left_out: [], model: "scripted",
  };
  writeFileSync(join(dir, SETUP_FILE), `${JSON.stringify(setup)}\n`);
  const cfgOf = (body: string) => {
    writeFileSync(join(dir, "config.yaml"), body);
    return loadConfig({ path: join(dir, "config.yaml"), env: {}, home });
  };
  expect(setupOf(cfgOf("data_dir: ./data\nroots: [{ path: ./root, trusted: true }]\n")).dir).toBe(dir);
  const cases: [string, string, string][] = [
    ["data_dir: ../outside-data\nroots: []\n", "the data folder", join(tmp, "outside-data")],
    ["data_dir: ./data\nroots: [{ path: ../outside-root }]\n", "a root", join(tmp, "outside-root")],
    ["data_dir: ./data\nroots: []\ncases: { store: ../outside-store }\n", "the case store", join(tmp, "outside-store")],
    ["data_dir: ./data\nroots: []\nloops: { store: ../outside-loops }\n", "the loop store", join(tmp, "outside-loops")],
    ["data_dir: ./data\nroots: []\nmemory: { files: ../outside-mem }\n", "a memory folder", join(tmp, "outside-mem")],
    ["data_dir: ./data\nroots: []\nimprove: { staged: ../outside-staged }\n", "the staged folder", join(tmp, "outside-staged")],
  ];
  for (const [body, what, where] of cases) {
    const cfg = cfgOf(body);
    expect(() => setupOf(cfg)).toThrow(SynthRefused);
    expect(() => setupOf(cfg)).toThrow(`this synthetic setup's configuration puts ${what} (${where}) outside the setup's folder ${dir}; a synthetic setup keeps everything in its own`);
  }
});
