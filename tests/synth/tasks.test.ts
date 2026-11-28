// `synth tasks`: a case for each storyline's public task, made by the person, its ground truth beside the cases folder. A --scripted setup
// built once with TINY_PARAMS under a fresh temporary folder; the function is called directly with an io that collects lines. Synthetic only.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TINY_PARAMS } from "pivot/synth/params";
import { readGroundTruth } from "pivot/synth/truth";
import type { GroundTruth } from "pivot/synth/truth";
import type { Actor, Entry } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { buildSetup } from "../../src/synth/build";
import type { Built } from "../../src/synth/build";
import { setupOf } from "../../src/synth/setup";
import type { SynthContext } from "../../src/synth/setup";
import { caseInput, readIndex, synthTasks, truthPath } from "../../src/synth/tasks";
import type { TruthFile } from "../../src/synth/tasks";

let tmp: string;
let built: Built;
let config: Config;
let truths: GroundTruth[];
let out: string[];
let err: string[];

const ctx = (): SynthContext => {
  const { dir, setup } = setupOf(config);
  return { config, dir, setup, human: { kind: "human", id: config.user }, io: { log: (l) => out.push(l), error: (l) => err.push(l) } };
};

function walk(dir: string): string[] {
  const res: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) res.push(...walk(p));
    else res.push(p);
  }
  return res;
}

/** Every case of the data folder, with its entries, read in a workbench that is closed again. */
function cases(): { id: string; entries: Entry[]; skipped: unknown[] }[] {
  const wb = Workbench.open(config.data_dir, { store: config.cases.store, memory: config.memory.store });
  try {
    return wb.listCases().map((c) => {
      const s = wb.session(c.id);
      return { id: c.id, entries: s.entries(), skipped: s.state.skipped };
    });
  } finally {
    wb.close();
  }
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "synth-tasks-"));
  mkdirSync(join(tmp, "home"));
  built = buildSetup(join(tmp, "setup"), { params: TINY_PARAMS, model: "scripted" }, null);
  config = loadConfig({ path: built.config, env: {}, home: join(tmp, "home") });
  truths = built.setup.storylines.map((s) => readGroundTruth(readFileSync(join(built.dir, "truth", `${s.id}.json`)))!);
});
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });
beforeEach(() => {
  // a fresh data folder for each test: the setup itself is built once
  rmSync(join(built.dir, "data"), { recursive: true, force: true });
  mkdirSync(join(built.dir, "data"));
  out = [];
  err = [];
});

const human = (): Actor => ({ kind: "human", id: config.user });

test("tasks makes one case a storyline, by the person of the configuration, titled [synthetic], of the storyline's case type, with its question, starting values and window", async () => {
  expect(await synthTasks(ctx(), { only: null, marking: "TLP:GREEN" })).toBe(0);
  expect(err).toEqual([]);
  const made = cases();
  expect(made.length).toBe(truths.length);
  const index = readIndex(config);
  for (const t of truths) {
    const row = index.cases.find((c) => c.storyline === t.storyline)!;
    const c = made.find((m) => m.id === row.case)!;
    const created = c.entries[0]!;
    expect(created.type).toBe("case.created");
    expect(created.actor).toEqual(human());
    const p = created.payload as Record<string, unknown>;
    expect(p.title).toBe(`[synthetic] ${t.task.title}`);
    expect(p.asked).toBe(t.task.question);
    expect(p.why).toBe(`synthetic task: storyline ${t.storyline}, seed ${t.seed}`);
    expect(p.starting).toEqual(t.task.starting);
    expect(p.window).toEqual(t.task.window);
    expect(p.marking).toBe("TLP:GREEN");
    expect(p.loop).toBe(config.loops.default);
    const typed = c.entries.find((e) => e.type === "case.type_set")!;
    expect(typed.payload).toEqual({ type: t.task.case_type });
    expect(typed.actor).toEqual(human());
    expect(c.skipped).toEqual([]);
    expect(out).toContain(`${c.id} ${t.storyline} (${t.task.case_type}): ${t.task.question}`);
  }
  expect(caseInput(truths[0]!, "TLP:AMBER").marking).toBe("TLP:AMBER");
  // the two commands that follow, last; no run is started
  const cfg = config.path!;
  expect(out.slice(-3)).toEqual(["next:", `  bun run serve --config ${cfg}`, `  bun run synth answer <case> --config ${cfg}   (once the case is published)`]);
  expect(out.join("\n")).not.toContain("investigate start");
});

test("each case has its ground-truth.json beside the cases folder, naming the case and the hash of its first entry, and the index lists them", async () => {
  expect(await synthTasks(ctx(), { only: null, marking: "TLP:GREEN" })).toBe(0);
  const made = cases();
  const index = readIndex(config);
  expect(index.format).toBe(1);
  expect(index.cases.map((c) => c.storyline).sort()).toEqual(truths.map((t) => t.storyline).sort());
  for (const row of index.cases) {
    const c = made.find((m) => m.id === row.case)!;
    expect(row.made_by).toBe("tasks");
    expect(row.origin).toBe(c.entries[0]!.hash);
    const file = truthPath(config, c.id);
    expect(file).toBe(join(config.data_dir, "synth-truth", c.id, "ground-truth.json"));
    const t = JSON.parse(readFileSync(file, "utf8")) as TruthFile;
    expect(t.case).toBe(c.id);
    expect(t.origin).toBe(c.entries[0]!.hash);
    expect(t.made_by).toBe("tasks");
    const { case: _c, origin: _o, made_by: _m, ...rest } = t;
    expect(rest).toEqual(truths.find((x) => x.storyline === row.storyline)! as never);
  }
  // beside the cases, not inside a case's folder: nothing of the truth is under the cases folder
  const caseFiles = walk(join(config.data_dir, "cases"));
  expect(caseFiles.length).toBeGreaterThan(0);
  expect(caseFiles.some((p) => p.includes("synth-truth") || p.endsWith("ground-truth.json"))).toBe(false);
  expect(readdirSync(join(config.data_dir, "synth-truth")).filter((n) => n.includes(".tmp"))).toEqual([]);
});

test("no case has a run, a known answer or a query; its ledger holds only what createCase writes", async () => {
  expect(await synthTasks(ctx(), { only: null, marking: "TLP:GREEN" })).toBe(0);
  const wb = Workbench.open(config.data_dir, { store: config.cases.store, memory: config.memory.store });
  try {
    for (const c of wb.listCases()) {
      const s = wb.session(c.id);
      expect(s.entries().map((e) => e.type)).toEqual(["case.created", "case.type_set"]);
      expect(s.state.run.status).toBe("none");
      expect(s.state.answers).toEqual({});
      expect(s.state.published).toEqual([]);
    }
  } finally {
    wb.close();
  }
});

test("a second tasks makes no case; --only makes the named ones; an unknown id exits 1 and makes nothing", async () => {
  const [a, b] = [truths[0]!.storyline, truths[1]!.storyline];
  expect(await synthTasks(ctx(), { only: ["no-such-storyline", a], marking: "TLP:GREEN" })).toBe(1);
  expect(err.join("\n")).toContain("no-such-storyline");
  expect(cases()).toEqual([]);
  err = [];
  expect(await synthTasks(ctx(), { only: [b, a], marking: "TLP:GREEN" })).toBe(0);
  expect(cases().length).toBe(2);
  expect(readIndex(config).cases.map((c) => c.storyline).sort()).toEqual([a, b].sort());
  expect(await synthTasks(ctx(), { only: [a], marking: "TLP:GREEN" })).toBe(0);
  expect(cases().length).toBe(2);
  expect(await synthTasks(ctx(), { only: null, marking: "TLP:GREEN" })).toBe(0);
  expect(cases().length).toBe(truths.length);
  out = [];
  expect(await synthTasks(ctx(), { only: null, marking: "TLP:GREEN" })).toBe(0);
  expect(cases().length).toBe(truths.length);
  expect(readIndex(config).cases.length).toBe(truths.length);
  expect(out.join("\n")).toContain("no case made");
});

test("no entry and no blob of any case made holds the truth's summary or a claim", async () => {
  expect(await synthTasks(ctx(), { only: null, marking: "TLP:GREEN" })).toBe(0);
  const secrets = truths.flatMap((t) => [t.summary, ...t.findings.map((f) => f.claim)]);
  const truthDir = join(config.data_dir, "synth-truth");
  const files = walk(config.data_dir).filter((p) => !p.startsWith(truthDir));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const bytes = readFileSync(f).toString("latin1");
    for (const s of secrets) expect(bytes.includes(s)).toBe(false);
  }
  for (const c of cases()) for (const e of c.entries) for (const s of secrets) expect(JSON.stringify(e).includes(s)).toBe(false);
});

test("a truth file that is not a ground truth is named and the others are still made", async () => {
  const bad = truths[2]!.storyline;
  const file = join(built.dir, "truth", `${bad}.json`);
  const before = readFileSync(file);
  writeFileSync(file, "{\"format\": 1, \"storyline\": \"not really\"}\n");
  try {
    expect(await synthTasks(ctx(), { only: null, marking: "TLP:GREEN" })).toBe(1);
  } finally {
    writeFileSync(file, before);
  }
  expect(err.join("\n")).toContain(file);
  expect(err.join("\n")).toContain("is not a ground truth");
  expect(cases().length).toBe(truths.length - 1);
  expect(readIndex(config).cases.map((c) => c.storyline)).not.toContain(bad);
});
