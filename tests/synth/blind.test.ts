// Nothing an investigating agent or a person's ordinary output sees names a storyline: a tiny --scripted synthetic setup built under a fresh
// temporary folder by the person's own commands (spawned with a clean environment and a HOME of its own), every task made and every storyline
// seeded; then no case record, no pack part, no request a model was sent and no line build, show, tasks or seed-tasks printed (without
// --reveal) holds a storyline's id, its title, or "malicious" or "benign". Only show --reveal and <data>/synth-truth/index.json name them.
// Synthetic only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { casePart } from "../../src/agents/context";
import type { CaseSession } from "../../src/core/session";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { storyLabels } from "../../src/synth/setup";
import type { SynthSetup } from "../../src/synth/setup";
import { readIndex } from "../../src/synth/tasks";
import { cleanEnv } from "../helpers/clean-env";

const REPO = join(import.meta.dir, "..", "..");
// the parameters of TINY_PARAMS, as the person types them
const TINY = ["--seed", "15", "--start", "2026-10-01", "--days", "4", "--users", "12", "--hosts", "16", "--sites", "2", "--volume", "0.05", "--scale", "50000"];

let tmp: string;
let home: string;
let dir: string;
let config: Config;
let setup: SynthSetup;
const said: Record<string, { code: number; out: string }> = {};

function synth(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync([process.execPath, "run", "synth", ...args], { cwd: REPO, env: cleanEnv(home), stdout: "pipe", stderr: "pipe", timeout: 240_000 });
  return { code: p.exitCode ?? -1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "synth-blind-"));
  home = join(tmp, "home");
  mkdirSync(home);
  dir = join(tmp, "setup");
  said.build = synth(["build", dir, "--scripted", ...TINY]);
  if (said.build.code !== 0) throw new Error(`the build failed: ${said.build.out}`);
  const cfg = join(dir, "config.yaml");
  config = loadConfig({ path: cfg, env: {}, home });
  setup = JSON.parse(readFileSync(join(dir, "synth.json"), "utf8")) as SynthSetup;
  said.show = synth(["show", "--config", cfg]);
  said.tasks = synth(["tasks", "--config", cfg]);
  said["seed-tasks"] = synth(["seed-tasks", "--config", cfg]);
  said.reveal = synth(["show", "--config", cfg, "--reveal"]);
}, 600_000);
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

/** The words that would give a storyline away: each id, each title, and the two verdicts. */
function tells(): { what: string; test: (text: string) => boolean }[] {
  return [
    ...setup.storylines.flatMap((s) => [
      { what: s.id, test: (t: string) => t.includes(s.id) },
      { what: s.title, test: (t: string) => t.includes(s.title) },
    ]),
    { what: "malicious or benign", test: (t: string) => /\b(?:malicious|benign)\b/i.test(t) },
  ];
}
const told = (text: string): string[] => tells().filter((x) => x.test(text)).map((x) => x.what);

/** Every case of the setup, read in a workbench closed again. */
function withCases<T>(fn: (cases: CaseSession[]) => T): T {
  const wb = Workbench.open(config.data_dir, { store: config.cases.store, memory: config.memory.store, onError: () => {} });
  try {
    return fn(wb.listCases().map((c) => wb.session(c.id)));
  } finally {
    wb.close();
  }
}

/** Every blob an entry's payload names, at any depth. */
function blobsOf(x: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(x)) for (const v of x) blobsOf(v, out);
  else if (x !== null && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (typeof o.blob === "string" && /^[0-9a-f]{64}$/.test(o.blob)) out.add(o.blob);
    for (const v of Object.values(o)) blobsOf(v, out);
  }
  return out;
}

test("the commands ran: every storyline has a task case and a seeded case", () => {
  for (const f of ["show", "tasks", "seed-tasks", "reveal"]) expect({ f, code: said[f]!.code }).toEqual({ f, code: 0 });
  const index = readIndex(config).cases;
  expect(setup.storylines.length).toBe(9);
  expect(index.filter((c) => c.made_by === "tasks").length).toBe(9);
  expect(index.filter((c) => c.made_by === "seed-tasks").length).toBe(9);
});

test("no case's record, nor the case part of its pack, names a storyline or a verdict", () => {
  withCases((cases) => {
    expect(cases.length).toBe(18);
    for (const s of cases) {
      const m = s.state.meta!;
      const record = JSON.stringify({ title: m.title, asked: m.asked, why: m.why, starting: m.starting, window: m.window, objective: m.objective });
      expect({ case: s.id, told: told(record) }).toEqual({ case: s.id, told: [] });
      expect({ case: s.id, told: told(casePart(s.state).text) }).toEqual({ case: s.id, told: [] });
      expect(m.why).toBe(`synthetic task, seed ${setup.params.seed}`);
    }
  });
});

test("no request a model was sent (Frame's among them) and no entry of any case names a storyline or its title", () => {
  withCases((cases) => {
    let requests = 0;
    for (const s of cases) {
      for (const e of s.entries()) {
        const texts = [JSON.stringify(e.payload), ...(e.type === "model.request" ? [...blobsOf(e.payload)].map((b) => new TextDecoder().decode(s.blobs.get(b))) : [])];
        if (e.type === "model.request") requests++;
        // a source's field notes may speak of malicious documents or a feed's benign verdicts; what is held here is that no storyline is named
        const named = texts.flatMap(told).filter((w) => w !== "malicious or benign");
        expect({ case: s.id, seq: e.seq, type: e.type, named }).toEqual({ case: s.id, seq: e.seq, type: e.type, named: [] });
      }
    }
    expect(requests).toBeGreaterThan(9 * 5);
  });
});

test("the Frame request of every seeded case carries the neutral why and no verdict word in its task", () => {
  withCases((cases) => {
    const seeded = cases.filter((s) => s.state.loop.id === "synth-seed");
    expect(seeded.length).toBe(9);
    for (const s of seeded) {
      const frame = s.entries().find((e) => e.type === "model.request")!;
      const text = [...blobsOf(frame.payload)].map((b) => new TextDecoder().decode(s.blobs.get(b))).join("\n");
      expect(text).toContain(`Why it was asked: synthetic task, seed ${setup.params.seed}`);
      const task = text.slice(text.indexOf("Frame this investigation."));
      expect({ case: s.id, told: told(task.slice(0, task.indexOf("Reply with"))) }).toEqual({ case: s.id, told: [] });
    }
  });
});

test("build, show, tasks and seed-tasks print no storyline id, title or verdict; they print each storyline's neutral label", () => {
  const labels = storyLabels(setup);
  for (const f of ["build", "show", "tasks", "seed-tasks"]) {
    expect({ f, told: told(said[f]!.out) }).toEqual({ f, told: [] });
  }
  for (const label of labels.values()) {
    expect(said.build!.out).toContain(`  ${label} (`);
    expect(said.show!.out).toContain(`  ${label} (`);
  }
  expect(said.tasks!.out).toMatch(/CASE-\d+ story-\d+ \(/);
  expect(said["seed-tasks"]!.out).toMatch(/seeded CASE-\d+ for story-\d+:/);
});

test("the labels are story-1 to story-9, stable, and in an order that is neither the ids' nor grouped by verdict; show --reveal maps each to its storyline", () => {
  const labels = storyLabels(setup);
  expect([...labels.values()].sort()).toEqual(Array.from({ length: 9 }, (_, i) => `story-${i + 1}`).sort());
  expect(storyLabels(setup)).toEqual(labels);
  const byLabel = setup.storylines.map((s) => ({ ...s, n: Number(labels.get(s.id)!.slice(6)) })).sort((a, b) => a.n - b.n);
  expect(byLabel.map((s) => s.id)).not.toEqual(setup.storylines.map((s) => s.id).sort());
  const verdicts = byLabel.map((s) => (s.malicious ? "m" : "b")).join("");
  expect(verdicts).not.toBe("mmmmmbbbb");
  expect(verdicts).not.toBe("bbbbmmmmm");
  for (const s of setup.storylines) expect(said.reveal!.out).toContain(`  ${labels.get(s.id)}: ${s.id}, ${s.malicious ? "malicious" : "benign"}, ${s.title}`);
  // the index beside the cases keeps the real id
  expect(readIndex(config).cases.map((c) => c.storyline).sort()).toEqual([...setup.storylines.map((s) => s.id), ...setup.storylines.map((s) => s.id)].sort());
});

test("--only takes a label; an id is refused in the sentence an unknown label gets, which lists the labels only", () => {
  const cfg = join(dir, "config.yaml");
  const again = synth(["tasks", "--config", cfg, "--only", "story-2"]);
  expect(again).toEqual({ code: 0, out: expect.stringContaining("no case made") });
  const id = setup.storylines[0]!.id;
  const refused = synth(["tasks", "--config", cfg, "--only", id]);
  expect(refused.code).toBe(1);
  expect(refused.out).toContain(`no storyline ${id} in this setup; name one by its label: story-1, story-2`);
  // what the command said, but the id the person typed (bun echoes the command line, and the sentence repeats what was asked for)
  const line = refused.out.split("\n").find((l) => l.startsWith("no storyline "))!;
  expect(told(line.replace(`no storyline ${id} `, ""))).toEqual([]);
});
