import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRoot } from "../../scripts/new-root";
import { preflight } from "../../src/cli/preflight";
import { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import { cleanEnv } from "../helpers/clean-env";
import { startModelStandin } from "../helpers/model-standin";

const REPO = join(import.meta.dir, "..", "..");
const README = readFileSync(join(REPO, "README.md"), "utf8");
const SCRIPTS = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length > 0) stops.pop()!();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "readme-")); dirs.push(d); return d; };

/** Every fenced block: its language and its text. */
function fences(): { lang: string; text: string }[] {
  return [...README.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map((m) => ({ lang: m[1]!, text: m[2]! }));
}

/** The commands in fenced blocks: continuation lines joined, then split into words. */
function commands(): string[][] {
  const out: string[][] = [];
  for (const f of fences()) {
    if (f.lang !== "" && f.lang !== "bash" && f.lang !== "sh") continue;
    for (const line of f.text.replace(/\\\n\s*/g, " ").split("\n")) {
      const t = line.trim();
      if (!t.startsWith("bun run ")) continue;
      out.push(t.match(/"[^"]*"|\S+/g)!.slice(2));
    }
  }
  return out;
}

test("every command the README names exists", () => {
  const named = new Set<string>();
  for (const m of README.matchAll(/`bun run ([a-z][\w:-]*)/g)) named.add(m[1]!);
  for (const c of commands()) named.add(c[0]!);
  expect(named.size).toBeGreaterThan(4);
  for (const name of named) expect(Object.keys(SCRIPTS), `bun run ${name}`).toContain(name);
});

test("each documented command runs with --help as documented, and every flag and word the README gives it is in its usage", () => {
  const home = tmp();
  const usages = new Map<string, string>();
  const usageOf = (name: string): string => {
    let u = usages.get(name);
    if (u === undefined) {
      const r = Bun.spawnSync(["bun", "run", name, "--help"], { cwd: REPO, env: cleanEnv(home), stdout: "pipe", stderr: "pipe", timeout: 60_000 });
      // a documented command refuses --help with its usage and the exit code for a wrong command line
      expect(r.exitCode, `bun run ${name} --help`).toBe(2);
      u = r.stderr.toString();
      expect(u, `bun run ${name} --help`).toContain("usage:");
      usages.set(name, u);
    }
    return u;
  };
  const cmds = commands();
  expect(cmds.length).toBeGreaterThanOrEqual(6);
  for (const [name, ...rest] of cmds) {
    const usage = usageOf(name!);
    for (const w of rest) if (/^--[a-z][\w-]*$/.test(w)) expect(usage, `bun run ${name} ${w}`).toContain(w);
    // the sub-command of `investigate`
    if (name === "investigate") expect(usage, `investigate ${rest[0]}`).toContain(`run.ts ${rest[0]}`);
  }
});

test("the README's sections come in order", () => {
  const heads = [...README.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
  expect(heads).toEqual(["What this is", "Run the sample", "Point it at your own data", "Before a run", "Custody", "Known limits"]);
});

/** A root made from the README's own types, sources and pivots (with `edit` applied to the pivots), and preflight's checks on it. */
async function preflightReadme(edit: (pivots: string) => string = (p) => p): Promise<{ checks: { name: string; level: string; detail: string }[]; problems: string[] }> {
  const blocks = fences().filter((f) => f.lang === "yaml");
  const of = (kind: string) => blocks.filter((b) => b.text.startsWith(`kind: ${kind}`));
  expect(of("source").length).toBeGreaterThanOrEqual(1);
  expect(of("pivots").length).toBe(1);
  expect(of("types").length).toBe(1);

  const base = tmp();
  const root = join(base, "root");
  // a stand-in model server, so preflight has an endpoint to list and nothing real is contacted
  const model = startModelStandin({ models: [{ id: "example/model-a", loaded_context_length: 65536 }], replies: [] });
  stops.push(model.stop);
  newRoot(root, { base_url: model.url, model: "example/model-a" });
  of("source").forEach((b, i) => writeFileSync(join(root, "sources", `readme-${i}.yaml`), b.text));
  writeFileSync(join(root, "pivots.yaml"), edit(of("pivots")[0]!.text));
  writeFileSync(join(root, "types.yaml"), of("types")[0]!.text);
  const config = join(base, "config.yaml");
  writeFileSync(config, [`data_dir: ${join(base, "data")}`, "roots:", `  - { path: ${JSON.stringify(root)}, trusted: true, credentials: [] }`, ""].join("\n"));
  mkdirSync(join(base, "data"), { recursive: true });

  const registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
  const problems = registry.problems.map((p) => `${p.path}: ${p.error}`);
  const r = await preflight(["--config", config, "--no-question"], { home: base, env: {}, repoRoot: REPO });
  return { checks: r.checks, problems };
}

test("the README's example manifests load and pass the guard", async () => {
  const { checks, problems } = await preflightReadme();
  expect(problems).toEqual([]);
  for (const name of ["manifests", "lake sources", "pivots"]) {
    const rows = checks.filter((c) => c.name === name);
    expect(rows.length, name).toBeGreaterThan(0);
    expect(rows.filter((c) => c.level === "fail"), name).toEqual([]);
  }
});

test("the three refusals the README names are the ones the guard gives", async () => {
  const named = [...README.matchAll(/^- `([^`]+)`\./gm)].map((m) => m[1]!).filter((m) => /where clause|select \*|join, union/.test(m));
  expect(named.length).toBe(3);
  const bad = [
    (p: string) => p.replace("where event_time >= {window.from} and event_time < {window.to} and dst_addr = {value}", "where dst_addr = {value}"),
    (p: string) => p.replace("select host_name,", "select *,"),
    (p: string) => p.replace("and dst_addr = {value}", "and (dst_addr = {value} or dst_addr = {value})"),
  ];
  const seen: string[] = [];
  for (const edit of bad) {
    const { checks } = await preflightReadme(edit);
    seen.push(...checks.filter((c) => c.name === "pivots" && c.level === "fail").map((c) => c.detail));
  }
  for (const m of named) expect(seen.some((d) => d.includes(m)), m).toBe(true);
});
