import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cases } from "../../src/cli/cases";
import { cleanEnv } from "../helpers/clean-env";
import { Workbench } from "../../src/core/workbench";
import type { NewCase } from "../../src/core/workbench";
import type { Actor, StageDef } from "../../src/core/types";

const person: Actor = { kind: "human", id: "analyst" };
const sample: NewCase = {
  title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [{ type: "ip", value: "198.51.100.77" }],
  window: { from: null, to: null }, objective: null, marking: "TLP:GREEN",
};
const stages: StageDef[] = [{ id: "collect", title: "Collect", phase: "collect", runs: "script", gate: null, reviews: false, model: null }];
const OPENER = join(import.meta.dir, "..", "helpers", "workbench-opener.ts");

let dir: string, data: string, store: string, config: string;
let out: string[], err: string[], typed: string[], prompts: string[];
const io = {
  log: (l: string) => void out.push(l),
  error: (l: string) => void err.push(l),
  readLine: async (p: string) => { prompts.push(p); return typed.shift() ?? ""; },
};
const run = (...argv: string[]): Promise<number> => cases([...argv, "--config", config], io);
const make = (title = "Sample"): string => {
  const wb = Workbench.open(data, { store, onError: () => {} });
  try { return wb.createCase({ ...sample, title }, person).id; } finally { wb.close(); }
};
const loaded = (): string[] => readdirSync(join(data, "cases")).filter((n) => /^CASE-/.test(n)).sort();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-cases-"));
  data = join(dir, "data");
  store = join(dir, "store");
  config = join(dir, "config.yaml");
  writeFileSync(config, [`data_dir: ${data}`, "user: analyst", "cases:", `  store: ${store}`, ""].join("\n"));
  out = []; err = []; typed = []; prompts = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("unload packs the case into the configured store and says where; the workbench no longer lists it", async () => {
  make();
  expect(await run("unload", "CASE-1")).toBe(0);
  expect(err).toEqual([]);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatch(new RegExp(`^unloaded CASE-1 to ${join(store, "CASE-1.TLP-GREEN.tar.gz").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · head [0-9a-f]{64}$`));
  expect(existsSync(join(store, "CASE-1.TLP-GREEN.tar.gz"))).toBe(true);
  expect(loaded()).toEqual([]);
});

test("unload --to writes to that folder", async () => {
  make();
  const to = join(dir, "elsewhere");
  expect(await run("unload", "CASE-1", "--to", to)).toBe(0);
  expect(out[0]).toContain(join(to, "CASE-1.TLP-GREEN.tar.gz"));
  expect(existsSync(join(to, "CASE-1.TLP-GREEN.tar.gz"))).toBe(true);
  expect(existsSync(store) ? readdirSync(store).filter((n) => n.endsWith(".tar.gz")) : []).toEqual([]);
});

test("load <case-id> takes the store's file; load <path> takes that file; each prints the id it has here", async () => {
  make();
  await run("unload", "CASE-1");
  out = [];
  expect(await run("load", "CASE-1")).toBe(0);
  const file = join(store, "CASE-1.TLP-GREEN.tar.gz");
  expect(out).toEqual([`loaded CASE-1 from ${file}`]);
  expect(loaded()).toEqual(["CASE-1"]);
  // the same case again, by path to a copy: now refused as already loaded
  out = [];
  const to = join(dir, "away");
  await run("unload", "CASE-1", "--to", to);
  rmSync(file);
  out = [];
  expect(await run("load", join(to, "CASE-1.TLP-GREEN.tar.gz"))).toBe(0);
  expect(out).toEqual([`loaded CASE-1 from ${join(to, "CASE-1.TLP-GREEN.tar.gz")}`]);
  expect(err).toEqual([]);
});

test("a foreign file whose id is taken is refused, with the reason on stderr, and nothing is loaded", async () => {
  make("Mine");
  const other = Workbench.open(join(dir, "other-data"), { store: join(dir, "other-store"), onError: () => {} });
  let theirs: string;
  try {
    other.createCase({ ...sample, title: "Theirs" }, person);
    const r = await other.unloadCase("CASE-1", { actor: person });
    if (!r.ok) throw new Error(r.reason);
    theirs = r.path;
  } finally { other.close(); }
  expect(await run("load", theirs)).toBe(1);
  expect(out).toEqual([]);
  expect(err.join("\n")).toContain("CASE-1 is taken here by another case");
  expect(loaded()).toEqual(["CASE-1"]);
});

test("a file that fails its check exits 1 with the reason on stderr and loads nothing", async () => {
  const bad = join(dir, "CASE-7.TLP-GREEN.tar.gz");
  writeFileSync(bad, "this is not a case file");
  expect(await run("load", bad)).toBe(1);
  expect(out).toEqual([]);
  expect(err.join("\n")).not.toBe("");
  expect(loaded()).toEqual([]);
});

test("store list prints one line per case and filters with --search; it runs while another process holds the workbench", async () => {
  make("Alpha traffic");
  make("Beta traffic");
  await run("unload", "CASE-1");
  await run("unload", "CASE-2");
  writeFileSync(join(store, "CASE-9.TLP-RED.tar.gz"), "junk");
  out = [];
  const holder = Bun.spawn(["bun", OPENER, data, "-", "-"], { stdout: "pipe", stderr: "pipe", env: cleanEnv(data) });
  try {
    const reader = holder.stdout.getReader();
    let seen = "";
    while (!seen.includes("held")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(seen).toContain("held");
    expect(await run("store", "list")).toBe(0);
    expect(out[0]).toBe(store);
    const rows = out.filter((l) => /^CASE-\d+ {2}/.test(l));
    expect(rows).toHaveLength(2);
    expect(rows.find((l) => l.startsWith("CASE-1  "))).toMatch(/^CASE-1 {2}TLP:GREEN {2}\S+ {2}\d+ entries {2}\d{4}-\d\d-\d\dT\S+ {2}Alpha traffic$/);
    expect(out.some((l) => l.includes("CASE-9.TLP-RED.tar.gz"))).toBe(true);
    out = [];
    expect(await run("store", "list", "--search", "beta")).toBe(0);
    expect(out.filter((l) => /^CASE-\d+ {2}/.test(l))).toHaveLength(1);
    expect(out.join("\n")).toContain("Beta traffic");
    out = [];
    // unload and load need the lock
    expect(await run("load", "CASE-1")).toBe(1);
    expect(err.join("\n")).toContain("is in use by");
  } finally {
    holder.kill();
    await holder.exited;
  }
});

test("store delete asks for the id, deletes on a match and logs it; anything else typed deletes nothing and exits 1", async () => {
  make("Alpha traffic");
  await run("unload", "CASE-1");
  out = []; err = [];
  const file = join(store, "CASE-1.TLP-GREEN.tar.gz");
  typed = ["CASE-2"];
  expect(await run("store", "delete", "CASE-1")).toBe(1);
  expect(prompts).toEqual(["Type CASE-1 to delete its file: "]);
  expect(existsSync(file)).toBe(true);
  expect(out.join("\n")).toContain("Alpha traffic");
  expect(out.join("\n")).toMatch(/head [0-9a-f]{64}/);
  typed = ["CASE-1"];
  out = [];
  expect(await run("store", "delete", "CASE-1")).toBe(0);
  expect(existsSync(file)).toBe(false);
  const log = readFileSync(join(store, "deleted.log"), "utf8").trim().split("\n");
  expect(log).toHaveLength(1);
  expect(JSON.parse(log[0]!)).toMatchObject({ id: "CASE-1", title: "Alpha traffic", who: "analyst" });
});

test("unload and load while the workbench is held exit 1 with the lock's message", async () => {
  make();
  const holder = Bun.spawn(["bun", OPENER, data, "-", "-"], { stdout: "pipe", stderr: "pipe", env: cleanEnv(data) });
  try {
    const reader = holder.stdout.getReader();
    let seen = "";
    while (!seen.includes("held")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(await run("unload", "CASE-1")).toBe(1);
    expect(err.join("\n")).toContain(`data directory ${data} is in use by`);
    expect(err.join("\n")).toContain("stop the server");
  } finally {
    holder.kill();
    await holder.exited;
  }
  expect(loaded()).toEqual(["CASE-1"]);
});

test("no command, an unknown command, a missing argument and an unknown flag exit 2 with the usage", async () => {
  for (const argv of [[], ["frobnicate"], ["unload"], ["load"], ["store"], ["store", "frob"], ["store", "delete"], ["unload", "CASE-1", "--bogus", "x"], ["unload", "CASE-1", "--to"], ["unload", "nope"], ["store", "list", "--to", "x"]]) {
    out = []; err = [];
    expect(await cases(argv, io), argv.join(" ")).toBe(2);
    expect(err.join("\n"), argv.join(" ")).toContain("usage:");
  }
});

test("the unload refusals exit 1 with their sentence: a running run", async () => {
  const wb = Workbench.open(data, { store, onError: () => {} });
  try {
    const s = wb.createCase(sample, person);
    s.commit((_, ids) => [{ type: "run.started", payload: { run: ids.next("run"), pipeline: "investigate", pipeline_hash: "a".repeat(64), stages }, actor: person }]);
  } finally { wb.close(); }
  expect(await run("unload", "CASE-1")).toBe(1);
  expect(err.join("\n")).toMatch(/run/);
  expect(loaded()).toEqual(["CASE-1"]);
  expect(existsSync(store) ? readdirSync(store).filter((n) => n.endsWith(".tar.gz")) : []).toEqual([]);
});
