import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSynth } from "pivot/synth/build";
import { TINY_PARAMS } from "pivot/synth/params";
import { readGroundTruth } from "pivot/synth/truth";
import type { GroundTruth } from "pivot/synth/truth";
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
  expect(heads).toEqual(["What this is", "Run the sample", "Point it at your own data", "The person", "Before a run", "Custody", "Cases: load and unload", "Loops", "Build a loop with help", "Memory", "Improve a loop", "A synthetic company", "Known limits"]);
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

const PIVOT = join(REPO, "node_modules", "pivot");
const DOCS = ["README.md", "docs/synthetic-company.md", "docs/security-notes.md", "docs/gui-guide.md", "synth/README.md"];
const read = (rel: string): string => readFileSync(join(REPO, rel), "utf8");
/** The `id:` of each manifest of a folder of the installed pivot. */
const idsIn = (rel: string): string[] =>
  readdirSync(join(PIVOT, rel)).filter((f) => f.endsWith(".yaml")).sort().map((f) => (Bun.YAML.parse(readFileSync(join(PIVOT, rel, f), "utf8")) as { id: string }).id);

// a tiny synthetic build (synthetic data only, in a temporary folder this file removes), for the truths it writes
let synthTmp: string;
let truths: GroundTruth[];
beforeAll(() => {
  synthTmp = mkdtempSync(join(tmpdir(), "readme-synth-"));
  const dir = join(synthTmp, "synth");
  buildSynth(dir, TINY_PARAMS);
  truths = readdirSync(join(dir, "truth")).filter((f) => f.endsWith(".json") && f !== "mess.json").sort()
    .map((f) => readGroundTruth(readFileSync(join(dir, "truth", f)))!);
});
afterAll(() => { if (synthTmp !== undefined) rmSync(synthTmp, { recursive: true, force: true }); });

test("docs/synthetic-company.md names every storyline id and every source id the installed pivot ships, and no ground truth", () => {
  const doc = read("docs/synthetic-company.md");
  const storylines = idsIn("synth/storylines");
  const sources = idsIn("synth/catalogue/sources");
  expect(storylines.length).toBe(9);
  expect(sources.length).toBe(13);
  for (const id of [...storylines, ...sources]) expect(doc, id).toContain(`\`${id}\``);
  // the case type of each storyline is given beside it; its title (which may say whether it is malicious) is not
  for (const f of readdirSync(join(PIVOT, "synth/storylines")).filter((x) => x.endsWith(".yaml"))) {
    const s = Bun.YAML.parse(readFileSync(join(PIVOT, "synth/storylines", f), "utf8")) as { id: string; title: string; case_type: string };
    expect(doc, s.id).toMatch(new RegExp(`\`${s.id}\`[^\n]*\`${s.case_type}\``));
    for (const d of DOCS) expect(read(d), `${d}: the title of ${s.id}`).not.toContain(s.title);
  }
  expect(truths.length).toBe(9);
  for (const d of DOCS) {
    const text = read(d);
    for (const t of truths) {
      expect(text, `${d}: the summary of ${t.storyline}`).not.toContain(t.summary);
      for (const f of t.findings) expect(text, `${d}: a claim of ${t.storyline}`).not.toContain(f.claim);
    }
  }
});

test("every test file docs/security-notes.md names exists", () => {
  const notes = read("docs/security-notes.md");
  // a file is the workbench's, or pivot's where the clause that names it (from its line's start or the last parenthesis) says "pivot's"
  const named = [...notes.matchAll(/`(tests\/[\w./-]+\.test\.ts)`/g)].map((m) => {
    const before = notes.slice(0, m.index);
    const clause = before.slice(Math.max(before.lastIndexOf("\n"), before.lastIndexOf("(")) + 1);
    return { pivot: clause.includes("pivot's") && !existsSync(join(REPO, m[1]!)), path: m[1]! };
  });
  expect(named.length).toBeGreaterThan(10);
  // the synthetic company's section names its own
  const synth = notes.slice(notes.indexOf("## A synthetic company"));
  expect(notes).toContain("## A synthetic company");
  expect(synth).toContain("tests/synth/setup.test.ts");
  for (const n of named) expect(existsSync(join(n.pivot ? PIVOT : REPO, n.path)), `${n.pivot ? "pivot's " : ""}${n.path}`).toBe(true);
});
