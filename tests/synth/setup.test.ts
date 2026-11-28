// The place a synthetic setup may be built in, and the setup a configuration belongs to. Every folder here is under a fresh temporary one.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { placeProblem, setupOf, SETUP_FILE, SynthRefused } from "../../src/synth/setup";
import { Refused } from "../../src/core/refused";

const REPO = join(import.meta.dir, "..", "..");
let tmp: string;
let ambient: Config;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "synth-setup-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  const cfg = join(tmp, "ambient", "config.yaml");
  mkdirSync(join(tmp, "ambient"));
  writeFileSync(cfg, [
    "data_dir: ./data",
    "roots: [{ path: ./root-a, trusted: true, credentials: [] }, { path: ./root-b }]",
    "cases: { store: ./case-store }",
    "loops: { store: ./loop-store, imports: ./loop-imports }",
    "memory: { store: ./mem/store, files: ./mem/files }",
    "",
  ].join("\n"));
  ambient = loadConfig({ path: cfg, env: {}, home });
});
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

const SHARES = "shares a folder with the configuration in use";

test("placeProblem refuses a folder that holds a file, a folder inside the repository, and a folder that is, holds or sits inside each folder of the ambient configuration", () => {
  const full = join(tmp, "full");
  mkdirSync(full);
  writeFileSync(join(full, "x"), "x");
  expect(placeProblem(full, REPO, null)).toBe(`${full} already exists and is not empty`);

  const inRepo = join(REPO, "never-made-by-synth");
  expect(placeProblem(inRepo, REPO, null)).toBe(`${inRepo} is inside the repository: build the setup outside it`);

  const a = join(tmp, "ambient");
  const folders = [
    ambient.data_dir, ambient.roots[0]!.path, ambient.roots[1]!.path, ambient.cases.store, ambient.loops.store, ambient.loops.imports,
    ambient.memory.store, ambient.memory.files,
  ];
  for (const f of folders) {
    // is it, sits inside it
    expect(placeProblem(f, REPO, ambient)).toContain(SHARES);
    expect(placeProblem(join(f, "deeper", "setup"), REPO, ambient)).toContain(SHARES);
  }
  // holds it: a folder (not made yet) above the two memory folders, and one above them all that holds a file is not empty first
  expect(placeProblem(join(a, "mem"), REPO, ambient)).toBe(`${join(a, "mem")} ${SHARES} (a memory folder): a synthetic setup has its own`);
  expect(placeProblem(a, REPO, ambient)).toBe(`${a} already exists and is not empty`);
  expect(placeProblem(join(a, "data"), REPO, ambient)).toBe(`${join(a, "data")} ${SHARES} (the data folder): a synthetic setup has its own`);
  expect(placeProblem(join(a, "root-b", "x"), REPO, ambient)).toBe(`${join(a, "root-b", "x")} ${SHARES} (a root): a synthetic setup has its own`);
});

test("placeProblem takes a new folder, an empty folder, and any folder when no configuration loads", () => {
  expect(placeProblem(join(tmp, "new-one", "deep"), REPO, ambient)).toBeNull();
  const empty = join(tmp, "empty");
  mkdirSync(empty);
  expect(placeProblem(empty, REPO, ambient)).toBeNull();
  expect(placeProblem(join(tmp, "ambient", "data", "x"), REPO, null)).toBeNull();
  expect(placeProblem(join(tmp, "ambient", "mem"), REPO, null)).toBeNull();
});

test("setupOf refuses the defaults, a configuration with no synth.json beside it, and a synth.json of another format, in its sentence", () => {
  const sentence = "this configuration is not a synthetic setup's (no synth.json beside it); give --config <synth>/config.yaml";
  const home = join(tmp, "home");
  const defaults = loadConfig({ env: {}, home });
  expect(defaults.path).toBeNull();
  expect(() => setupOf(defaults)).toThrow(sentence);
  expect(() => setupOf(ambient)).toThrow(sentence);
  try { setupOf(ambient); } catch (e) { expect(e).toBeInstanceOf(SynthRefused); expect(e).toBeInstanceOf(Refused); }

  const other = join(tmp, "other");
  mkdirSync(other);
  writeFileSync(join(other, "config.yaml"), "data_dir: ./data\nroots: []\n");
  const cfg = loadConfig({ path: join(other, "config.yaml"), env: {}, home });
  writeFileSync(join(other, SETUP_FILE), JSON.stringify({ format: 2 }) + "\n");
  expect(() => setupOf(cfg)).toThrow(sentence);
  writeFileSync(join(other, SETUP_FILE), "not json");
  expect(() => setupOf(cfg)).toThrow(sentence);

  const setup = {
    format: 1, params: { seed: 15, start: "2026-10-01", days: 4, users: 12, hosts: 16, sites: 2, volume: 0.05, scale: 50000 }, pivot: "0.3.0", workbench: "0.15.0",
    digest: "d", storylines: [], left_out: [], model: "scripted",
  };
  writeFileSync(join(other, SETUP_FILE), JSON.stringify(setup) + "\n");
  expect(setupOf(cfg)).toEqual({ dir: other, setup: setup as never });
});
