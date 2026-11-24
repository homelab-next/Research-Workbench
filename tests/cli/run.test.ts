import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copySample } from "../helpers/sample-root";

const REPO = join(import.meta.dir, "..", "..");
const RUN = join(REPO, "src", "cli", "run.ts");
const VERIFY = join(REPO, "src", "cli", "verify.ts");
const OPENER = join(REPO, "tests", "helpers", "open-workbench.ts");

interface Env { dir: string; config: string; data: string; port: number }
let env: Env;
const dirs: string[] = [];

function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = s.port!;
  void s.stop(true);
  return port;
}

/** A configuration whose only root is a copy of the sample, its reputation source pointed at a free loopback port. */
function setup(): Env {
  const dir = mkdtempSync(join(tmpdir(), "cli-run-"));
  dirs.push(dir);
  const root = join(dir, "sample");
  copySample(root);
  const port = freePort();
  const rep = join(root, "sources", "reputation.yaml");
  writeFileSync(rep, readFileSync(rep, "utf8").replace("http://127.0.0.1:4801", `http://127.0.0.1:${port}`));
  const data = join(dir, "data");
  const config = join(dir, "config.yaml");
  writeFileSync(config, [`data_dir: ${data}`, "user: analyst", "roots:", `  - { path: ${root}, trusted: true }`, ""].join("\n"));
  return { dir, config, data, port };
}

function cli(e: Env, args: string[], fixture = true): { code: number; out: string; err: string } {
  const full = [...args, "--config", e.config, ...(fixture ? ["--sample-fixture", String(e.port)] : [])];
  const r = Bun.spawnSync(["bun", "run", RUN, ...full], { cwd: REPO, timeout: 60_000, env: { ...process.env, RESEARCH_WORKBENCH_CONFIG: "" }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

const START = [
  "start", "--title", "Sample", "--asked", "Who is behind the traffic to 198.51.100.77?", "--why", "demo", "--start", "address=198.51.100.77",
  "--from", "2026-11-17T00:00:00.000Z", "--to", "2026-11-24T00:00:00.000Z", "--objective", "sample-objective", "--marking", "TLP:GREEN",
];
const head = (e: Env, id = "CASE-1"): number => {
  const db = new Database(join(e.data, "cases", id, "ledger.sqlite"), { readonly: true });
  try { return (db.query("select max(seq) as n from entries").get() as { n: number }).n; } finally { db.close(); }
};
const lines = (s: string): string[] => s.split("\n").filter((l) => l !== "");

beforeAll(() => { env = setup(); });
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

test("start runs to the plan gate and prints the steps", () => {
  const r = cli(env, START);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  const out = lines(r.out);
  expect(out[0]).toBe("CASE-1 waiting waiting=plan");
  expect(out.filter((l) => /^s\d+ /.test(l)).length).toBe(3);
  expect(out.find((l) => l.startsWith("s3 "))).toBe("s3 costly reputation address_to_verdict 198.51.100.77");
  expect(out.find((l) => l.startsWith("s1 "))).toBe("s1 free assets address_to_asset 198.51.100.77");
  expect(out.find((l) => l.startsWith("s2 "))).toBe("s2 free signins asset_to_accounts (from an earlier step)");
  expect(existsSync(join(env.data, "cases", "CASE-1", "ledger.sqlite"))).toBe(true);
});

test("status changes nothing in the case", () => {
  const before = head(env);
  const r = cli(env, ["status", "CASE-1"], false);
  expect(r.code).toBe(0);
  expect(lines(r.out)[0]).toBe("CASE-1 waiting waiting=plan");
  expect(head(env)).toBe(before);
});

test("a refused command exits 1 with the reason and writes nothing", () => {
  const before = head(env);
  const r = cli(env, ["approve", "CASE-1"], false);
  expect(r.code).toBe(1);
  expect(r.err).toContain("not waiting at the publish gate");
  expect(r.out).toBe("");
  expect(head(env)).toBe(before);
  const bad = cli(env, ["accept-plan", "CASE-1", "--budget", "s1=5"], false);
  expect(bad.code).toBe(1);
  expect(bad.err).toContain("free");
  expect(head(env)).toBe(before);
  const none = cli(env, ["status", "CASE-9"], false);
  expect(none.code).toBe(1);
  expect(none.err).toContain("CASE-9");
});

test("accept-plan with a budget runs to the publish gate", () => {
  const r = cli(env, ["accept-plan", "CASE-1", "--budget", "s3=1"]);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(lines(r.out)[0]).toBe("CASE-1 waiting waiting=publish stage=publish draft=2");
});

test("approve publishes and finishes", () => {
  const r = cli(env, ["approve", "CASE-1"]);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(lines(r.out)[0]).toBe("CASE-1 finished published=published/1");
  expect(existsSync(join(env.data, "cases", "CASE-1", "published", "1", "product.json"))).toBe(true);
});

test("the verify command passes on the finished case", () => {
  const r = Bun.spawnSync(["bun", "run", VERIFY, join(env.data, "cases", "CASE-1")], { cwd: REPO, timeout: 60_000, stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain("chain intact");
});

test("the lock is released after every command", () => {
  expect(cli(env, ["status", "CASE-1"], false).code).toBe(0);
  expect(cli(env, ["status", "CASE-1"], false).code).toBe(0);
  const r = Bun.spawnSync(["bun", OPENER, env.data], { cwd: REPO, timeout: 60_000 });
  expect(r.exitCode).toBe(0);
});

test("feedback records a measure of effectiveness on a finished case, and a refused one exits 1", () => {
  const before = head(env);
  const bad = cli(env, ["feedback", "CASE-1", "--measure", "not-a-measure", "--value", "3"], false);
  expect(bad.code).toBe(1);
  expect(head(env)).toBe(before);
  const id = "answered_the_question";
  const ok = cli(env, ["feedback", "CASE-1", "--measure", id, "--value", "4", "--note", "useful"], false);
  expect(ok.err).toBe("");
  expect(ok.code).toBe(0);
  expect(head(env)).toBeGreaterThan(before);
});

test("a replan the script cannot answer pauses the run: exit 1, where it stopped and why; resume is accepted and says the same", () => {
  const e = setup();
  expect(cli(e, START).code).toBe(0);
  const re = cli(e, ["replan", "CASE-1", "--note", "look at the leases too"]);
  expect(re.code).toBe(1);
  expect(lines(re.out)[0]).toMatch(/^CASE-1 paused stage=plan reason="Plan: the model call failed: script sample-run has no turn \d+ for planner"$/);
  const again = cli(e, ["resume", "CASE-1"]);
  expect(again.code).toBe(1);
  expect(lines(again.out)[0]).toMatch(/^CASE-1 paused stage=plan reason="Plan: /);
  expect(cli(e, ["status", "CASE-1"], false).code).toBe(0);
});

test("accept-plan without a budget still gets to the publish gate, and reject sends the draft back", () => {
  const e = setup();
  expect(cli(e, START).code).toBe(0);
  const r = cli(e, ["accept-plan", "CASE-1"]);
  expect(r.code).toBe(0);
  expect(lines(r.out)[0]).toBe("CASE-1 waiting waiting=publish stage=publish draft=2");
  const stop = cli(e, ["reject", "CASE-1", "--reason", "not now", "--stop"]);
  expect(stop.err).toBe("");
  expect(stop.code).toBe(0);
  expect(lines(stop.out)[0]).toBe("CASE-1 finished");
});

test("a usage error exits 2", () => {
  expect(cli(env, [], false).code).toBe(2);
  expect(cli(env, ["frobnicate"], false).code).toBe(2);
  expect(cli(env, ["status"], false).code).toBe(2);
  expect(cli(env, ["status", "not-a-case"], false).code).toBe(2);
  expect(cli(env, ["start", "--title", "T"], false).code).toBe(2);
  expect(cli(env, [...START, "--bogus", "x"], false).code).toBe(2);
  expect(cli(env, ["accept-plan", "CASE-1", "--budget", "s3"], false).code).toBe(2);
  expect(cli(env, ["accept-plan", "CASE-1", "--budget", "s3=lots"], false).code).toBe(2);
  expect(cli(env, ["reject", "CASE-1"], false).code).toBe(2);
  expect(cli(env, [...START.slice(0, -2), "--marking", "TLP:PURPLE"], false).code).toBe(2);
  expect(cli(env, ["status", "CASE-1", "--config", join(env.dir, "missing.yaml")], false).code).toBe(2);
});

test("a run a changed pipeline strands can be stopped, and stays stopped", () => {
  const e = setup();
  expect(cli(e, START).code).toBe(0);
  expect(cli(e, ["replan", "CASE-1", "--note", "look at the leases too"]).code).toBe(1);
  // the owner edits a stage manifest: the paused run can no longer go on
  const stage = join(e.dir, "sample", "stages", "assemble.yaml");
  writeFileSync(stage, readFileSync(stage, "utf8").replace("title: Assemble", "title: Assemble the draft"));
  const stuck = cli(e, ["resume", "CASE-1"]);
  expect(stuck.code).toBe(1);
  expect(lines(stuck.out)[0]).toBe(`CASE-1 paused stage=plan reason="the pipeline has changed since this run started"`);
  expect(cli(e, ["stop", "CASE-1"], false).code).toBe(2);
  const stop = cli(e, ["stop", "CASE-1", "--reason", "the pipeline was changed"], false);
  expect(stop.err).toBe("");
  expect(stop.code).toBe(0);
  expect(lines(stop.out)[0]).toBe("CASE-1 finished");
  const again = cli(e, ["stop", "CASE-1", "--reason", "twice"], false);
  expect(again.code).toBe(1);
  expect(again.err).toContain("no run in progress");
  expect(lines(cli(e, ["resume", "CASE-1"]).out)[0]).toBe("CASE-1 finished");
});

const anchored = (e: Env): { seq: number; why: string }[] => {
  const db = new Database(join(e.data, "workbench.sqlite"), { readonly: true });
  try {
    return (db.query("select payload from entries where type = 'case.anchored' order by seq").all() as { payload: string }[]).map((r) => JSON.parse(r.payload));
  } finally { db.close(); }
};
const chainHead = (e: Env): number => {
  const db = new Database(join(e.data, "workbench.sqlite"), { readonly: true });
  try { return (db.query("select max(seq) as n from entries").get() as { n: number }).n; } finally { db.close(); }
};

test("status writes to neither ledger, even after a manifest changed; only a command that ends the run anchors the case", () => {
  const e = setup();
  expect(cli(e, START).code).toBe(0);
  expect(anchored(e)).toEqual([]);
  // a changed manifest would be recorded on the workbench chain by anything that loads the registry
  const stage = join(e.dir, "sample", "stages", "assemble.yaml");
  writeFileSync(stage, readFileSync(stage, "utf8").replace("title: Assemble", "title: Assemble the draft"));
  const caseBefore = head(e), chainBefore = chainHead(e);
  for (let i = 0; i < 2; i++) {
    const r = cli(e, ["status", "CASE-1"], false);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(lines(r.out)[0]).toBe("CASE-1 waiting waiting=plan");
  }
  expect(head(e)).toBe(caseBefore);
  expect(chainHead(e)).toBe(chainBefore);
  // a command that leaves the run unfinished anchors nothing; one that ends it anchors once, at its last entry
  expect(cli(e, ["replan", "CASE-1", "--note", "look at the leases too"]).code).toBe(1);
  expect(anchored(e)).toEqual([]);
  expect(cli(e, ["stop", "CASE-1", "--reason", "enough"], false).code).toBe(0);
  const marks = anchored(e);
  expect(marks.map((m) => m.why)).toEqual(["closed"]);
  expect(marks[0]!.seq).toBe(head(e));
});
