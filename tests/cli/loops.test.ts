import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loops } from "../../src/cli/loops";
import { cleanEnv } from "../helpers/clean-env";
import { copySample } from "../helpers/sample-root";

const OPENER = join(import.meta.dir, "..", "helpers", "workbench-opener.ts");

let dir: string;
let out: string[], err: string[];
const io = { log: (l: string) => void out.push(l), error: (l: string) => void err.push(l) };

/** A configuration file in dir whose only root is `root`; data under dir/<name>. */
function configFor(name: string, root: string): { config: string; data: string } {
  const data = join(dir, name);
  const config = join(dir, `${name}.yaml`);
  writeFileSync(config, [`data_dir: ${data}`, "user: analyst", "roots:", `  - { path: ${root}, trusted: true }`, ""].join("\n"));
  return { config, data };
}
let sampleRoot: string, a: { config: string; data: string };
const run = (cfg: { config: string }, ...argv: string[]): Promise<number> => { out = []; err = []; return loops([...argv, "--config", cfg.config], io); };

/** A second workbench whose only root is empty: where a first import happens, and where compose would fail. */
function emptyWorkbench(name = "b"): { config: string; data: string; root: string } {
  const root = join(dir, `${name}-root`);
  mkdirSync(root, { recursive: true });
  return { ...configFor(name, root), root };
}
/** The sample's investigation loop exported from workbench A; returns the file. */
async function exported(): Promise<string> {
  const to = join(dir, "out");
  expect(await run(a, "export", "investigation", "--to", to)).toBe(0);
  return join(to, readdirSync(to).find((n) => n.endsWith(".loop.tar.gz"))!);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-loops-"));
  sampleRoot = join(dir, "sample");
  copySample(sampleRoot);
  a = configFor("a", sampleRoot);
  out = []; err = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("list prints investigation with its version, its hash and nine stages", async () => {
  expect(await run(a, "list")).toBe(0);
  expect(err).toEqual([]);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatch(/^investigation {2}v1 {2}[0-9a-f]{12} {2}9 stages {2}Investigation$/);
});

test("show prints the stages in order with their gates and send-back edges, and each stage's three groups with source and hash", async () => {
  expect(await run(a, "show", "investigation")).toBe(0);
  const text = out.join("\n");
  expect(out[0]).toBe("Investigation");
  expect(text).toContain("Frame a question, plan and run the research");
  expect(text).toMatch(/version 1/);
  expect(text).toMatch(/hash [0-9a-f]{64}/);
  expect(text).toMatch(/legacy hash [0-9a-f]{64}/);
  const stageLines = out.filter((l) => /^\d+\. /.test(l));
  expect(stageLines).toHaveLength(9);
  expect(stageLines[0]).toMatch(/^1\. Frame \(frame\) runs agent$/);
  expect(stageLines.some((l) => / gate plan/.test(l) || / gate publish/.test(l))).toBe(true);
  expect(stageLines.some((l) => l.includes(" on fail → "))).toBe(true);
  // three groups under a stage, items as `<kind> <id>  <source>  <12 hex>`
  expect(out.filter((l) => l === "   context:").length).toBeGreaterThanOrEqual(9);
  expect(out.filter((l) => l === "   middleware:").length).toBeGreaterThanOrEqual(9);
  expect(out.filter((l) => l === "   orchestration:").length).toBeGreaterThanOrEqual(9);
  expect(out.some((l) => /^ {5}persona [\w-]+ {2}root {2}[0-9a-f]{12}$/.test(l))).toBe(true);
  expect(out.some((l) => /^ {5}check [\w-]+ {2}root {2}[0-9a-f]{12}$/.test(l))).toBe(true);
  expect(out.some((l) => /^ {5}stage frame {2}root {2}[0-9a-f]{12}$/.test(l))).toBe(true);
  expect(err).toEqual([]);
});

test("show of an unknown loop exits 1; a loop that is not usable prints its problems and exits 1", async () => {
  expect(await run(a, "show", "nope")).toBe(1);
  expect(err.join("\n")).toContain('no loop "nope"');
  writeFileSync(join(sampleRoot, "loops", "broken.yaml"), JSON.stringify({ kind: "loop", id: "broken", title: "Broken", version: 1, profile: "investigation", entry: "ghost", stages: ["ghost"] }));
  expect(await run(a, "list")).toBe(0);
  expect(out.some((l) => /^broken {2}not usable: \S/.test(l))).toBe(true);
  expect(await run(a, "show", "broken")).toBe(1);
  expect(err.join("\n")).toContain('loop "broken" is not usable');
  expect(err.join("\n").length).toBeGreaterThan('loop "broken" is not usable'.length + 3);
});

test("export writes into loops.store by default and into --to when given, and prints the path", async () => {
  expect(await run(a, "export", "investigation")).toBe(0);
  const files = readdirSync(join(a.data, "loops"));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^investigation\.v1\.[0-9a-f]{12}\.loop\.tar\.gz$/);
  expect(out[0]).toBe(`exported investigation v1 to ${join(a.data, "loops", files[0]!)}`);
  const to = join(dir, "elsewhere");
  expect(await run(a, "export", "investigation", "--to", to)).toBe(0);
  expect(out[0]).toBe(`exported investigation v1 to ${join(to, files[0]!)}`);
  expect(existsSync(join(to, files[0]!))).toBe(true);
  expect(await run(a, "export", "nope")).toBe(1);
});

test("import prints what was written and what was already here, and that the root is not trusted", async () => {
  const file = await exported();
  const b = emptyWorkbench();
  expect(await run(b, "import", file)).toBe(0);
  expect(err).toEqual([]);
  const folders = readdirSync(join(b.data, "imported"));
  expect(folders).toHaveLength(1);
  expect(out[0]).toMatch(new RegExp(`^imported investigation into ${join(b.data, "imported", folders[0]!).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(not trusted\\): \\d+ written, 0 already here$`));
  expect(out[1]).toBe(`to use it: bun run loops trust ${join(b.data, "imported", folders[0]!)}`);
  // importing the person's own export into the workbench that made it leaves every file out
  expect(await run(a, "import", file)).toBe(0);
  expect(out[0]).toMatch(/\(not trusted\): 0 written, \d+ already here$/);
});

test("import of a file with a conflict exits 1, names the manifest and writes nothing", async () => {
  const file = await exported();
  const other = join(dir, "other-root");
  copySample(other);
  const frame = join(other, "stages", "frame.yaml");
  writeFileSync(frame, readFileSync(frame, "utf8").replace("title: Frame", "title: Framing"));
  const c = { ...configFor("c", other) };
  expect(await run(c, "import", file)).toBe(1);
  expect(err.join("\n")).toContain('stage "frame"');
  expect(err.join("\n")).toContain("nothing was imported");
  expect(out).toEqual([]);
  expect(existsSync(join(c.data, "imported")) ? readdirSync(join(c.data, "imported")) : []).toEqual([]);
});

test("trust prints what the root will supply, adds it to the configuration, and list then shows the loop as usable", async () => {
  const file = await exported();
  const b = emptyWorkbench();
  expect(await run(b, "import", file)).toBe(0);
  const folder = join(b.data, "imported", readdirSync(join(b.data, "imported"))[0]!);
  expect(await run(b, "list")).toBe(0);
  expect(out.join("\n")).toMatch(/investigation {2}not usable/);
  expect(await run(b, "trust", folder)).toBe(0);
  expect(err).toEqual([]);
  expect(out[0]).toMatch(/^this root will supply: .*1 loop\b/);
  expect(out[0]).toMatch(/9 stages/);
  expect(out[0]).toMatch(/\d+ checks with scripts/);
  expect(readFileSync(b.config, "utf8")).toContain(folder);
  expect(await run(b, "list")).toBe(0);
  expect(out.join("\n")).toMatch(/investigation {2}v1 {2}[0-9a-f]{12} {2}9 stages {2}Investigation/);
  // a folder that is not an imported one is refused
  expect(await run(b, "trust", join(dir, "nowhere"))).toBe(1);
});

test("no command, an unknown command, a missing argument and an unknown flag exit 2 with the usage", async () => {
  for (const argv of [[], ["frobnicate"], ["--help"], ["show"], ["export"], ["import"], ["trust"], ["list", "x"], ["show", "a", "b"], ["list", "--bogus", "x"], ["export", "a", "--to"], ["list", "--to", "x"], ["import", "f", "--to", "x"]]) {
    out = []; err = [];
    expect(await loops(argv, io), argv.join(" ")).toBe(2);
    expect(err.join("\n"), argv.join(" ")).toContain("usage:");
  }
});

test("import and trust work in a workbench whose only root is empty, where compose would fail", async () => {
  const file = await exported();
  const b = emptyWorkbench();
  const { compose } = await import("../../src/cli/compose");
  const { Workbench } = await import("../../src/core/workbench");
  const { loadConfig } = await import("../../src/modules/config");
  const wb = Workbench.open(b.data, { onError: () => {} });
  // an unusable default loop no longer stops compose (controller ruling): it is a problem, and no case can run on it
  try {
    const composed = compose(loadConfig({ path: b.config }), wb);
    try { expect(composed.problems.join(" | ")).toContain('the default loop "investigation" is not usable'); } finally { composed.close(); }
  } finally { wb.close(); }
  expect(await run(b, "import", file)).toBe(0);
  const folder = join(b.data, "imported", readdirSync(join(b.data, "imported"))[0]!);
  expect(await run(b, "trust", folder)).toBe(0);
});

test("every form says the workbench is held when another process holds it, and exits 1", async () => {
  const file = await exported();
  const b = emptyWorkbench();
  const holder = Bun.spawn(["bun", OPENER, b.data, "-", "-"], { stdout: "pipe", stderr: "pipe", env: cleanEnv(dir) });
  try {
    const reader = holder.stdout.getReader();
    let seen = "";
    while (!seen.includes("held")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    for (const argv of [["list"], ["show", "investigation"], ["export", "investigation"], ["import", file], ["trust", join(b.data, "imported", "x")]]) {
      expect(await run(b, ...argv), argv.join(" ")).toBe(1);
      expect(err.join("\n"), argv.join(" ")).toContain(`data directory ${b.data} is in use by`);
    }
  } finally {
    holder.kill();
    await holder.exited;
  }
});
