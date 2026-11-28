// `bun run synth`, spawned in the foreground with a time limit, a HOME of its own and cleanEnv. Every setup is synthetic, TINY_PARAMS, temporary.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../src/core/workbench";
import { cleanEnv } from "../helpers/clean-env";

const REPO = join(import.meta.dir, "..", "..");
const CLI = join(REPO, "src", "cli", "synth.ts");
const TINY = ["--seed", "15", "--start", "2026-10-01", "--days", "4", "--users", "12", "--hosts", "16", "--sites", "2", "--volume", "0.05", "--scale", "50000"];
let tmp: string;
let home: string;
let setup: string;
let built: { code: number | null; out: string; err: string };

function run(args: string[]): { code: number | null; out: string; err: string } {
  const r = Bun.spawnSync(["bun", "run", CLI, ...args], { cwd: REPO, timeout: 120_000, env: cleanEnv(home), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "cli-synth-"));
  home = join(tmp, "home");
  mkdirSync(home);
  setup = join(tmp, "setup");
  built = run(["build", setup, "--scripted", ...TINY]);
});
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

test("--help prints the usage and exits 2; an unknown form and a missing --config exit 2", () => {
  const help = run(["--help"]);
  expect(help.code).toBe(2);
  expect(help.out).toBe("");
  expect(help.err).toContain("usage:\n  bun run synth build <dir> (--scripted | --base-url URL --model ID");
  expect(help.err).toContain("build writes only inside <dir>.");
  expect(run(["build", "--help"]).code).toBe(2);
  expect(run(["frobnicate"]).code).toBe(2);
  expect(run([]).code).toBe(2);
  for (const form of [["show"], ["tasks"], ["answer", "CASE-1"], ["seed-tasks"]]) {
    const r = run(form);
    expect({ form, code: r.code }).toEqual({ form, code: 2 });
    expect(r.err).toContain("--config");
  }
  expect(run(["build", join(tmp, "never")]).code).toBe(2);
  expect(run(["build", join(tmp, "never"), "--scripted", "--model", "m"]).code).toBe(2);
  expect(run(["build", join(tmp, "never"), "--scripted", "--days", "four"]).code).toBe(2);
  expect(existsSync(join(tmp, "never"))).toBe(false);
});

test("build --scripted with tiny parameters exits 0 and prints the digest and the next commands", () => {
  expect(built.err).toBe("");
  expect(built.code).toBe(0);
  const s = JSON.parse(readFileSync(join(setup, "synth.json"), "utf8")) as { digest: string; params: unknown };
  expect(s.params).toEqual({ seed: 15, start: "2026-10-01", days: 4, users: 12, hosts: 16, sites: 2, volume: 0.05, scale: 50000 });
  expect(built.out).toContain(s.digest);
  expect(built.out).toContain(setup);
  expect(built.out).toContain(`bun run synth show --config ${setup}/config.yaml`);
  expect(built.out).toContain(`bun run synth tasks --config ${setup}/config.yaml`);
  expect(built.out).toContain(`bun run serve --config ${setup}/config.yaml`);
  expect(built.out).toContain("scripts/synth-run.yaml");
});

test("build on a folder that is not empty exits 1 with the sentence and writes nothing", () => {
  const full = join(tmp, "full");
  mkdirSync(full);
  writeFileSync(join(full, "keep"), "x");
  const r = run(["build", full, "--scripted", ...TINY]);
  expect(r.code).toBe(1);
  expect(r.err).toContain(`${full} already exists and is not empty`);
  expect(readdirSync(full)).toEqual(["keep"]);
  const refused = run(["build", join(tmp, "bad-params"), "--scripted", "--days", "1"]);
  expect(refused.code).toBe(1);
  expect(existsSync(join(tmp, "bad-params"))).toBe(false);
});

test("tasks, answer and seed-tasks with a configuration that is not a synthetic setup's exit 1 before the workbench is opened: no data folder is made", () => {
  const other = join(tmp, "not-a-setup");
  mkdirSync(other);
  writeFileSync(join(other, "config.yaml"), "data_dir: ./data\nroots: []\n");
  const cfg = join(other, "config.yaml");
  for (const form of [["tasks", "--config", cfg], ["answer", "CASE-1", "--config", cfg], ["seed-tasks", "--config", cfg], ["show", "--config", cfg]]) {
    const r = run(form);
    expect({ form, code: r.code }).toEqual({ form, code: 1 });
    expect(r.err).toContain("this configuration is not a synthetic setup's (no synth.json beside it); give --config <synth>/config.yaml");
    expect(existsSync(join(other, "data"))).toBe(false);
  }
  expect(existsSync(join(home, ".local", "share", "research-workbench"))).toBe(false);
});

test("show prints the tables' rows and sizes and the storylines, and opens no workbench: it runs while another process holds the lock", () => {
  expect(built.code).toBe(0);
  const s = JSON.parse(readFileSync(join(setup, "synth.json"), "utf8")) as { digest: string; storylines: { id: string }[] };
  const wb = Workbench.open(join(setup, "data"));
  try {
    const r = run(["show", "--config", join(setup, "config.yaml")]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(s.digest);
    for (const t of ["signins", "group_members", "process_start", "dns", "proxy", "flows", "dhcp_leases", "wifi_events", "email", "cloud_audit", "vuln_findings", "assets", "reputation"]) {
      expect(r.out).toMatch(new RegExp(`^  ${t} +[1-9][0-9]* rows +[0-9.]+ [kMGT]?B$`, "m"));
    }
    for (const st of s.storylines) expect(r.out).toContain(st.id);
    expect(r.out).toContain("left out: none");
    expect(r.out).toContain("model: scripted (synth-run)");
    expect(r.out).toContain("port: 4757");
    expect(r.out).toContain("cases: 0 task, 0 seeded");
  } finally {
    wb.close();
  }
});
