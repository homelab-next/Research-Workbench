// The seed loop's script, and the seed loop on a tiny --scripted synthetic setup built once under a fresh temporary folder. Synthetic only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TINY_PARAMS } from "pivot/synth/params";
import { readGroundTruth } from "pivot/synth/truth";
import type { GroundTruth, PublicTask } from "pivot/synth/truth";
import { compose } from "../../src/cli/compose";
import { hostsFor } from "../../src/cli/improve";
import type { CaseSession } from "../../src/core/session";
import type { Actor } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { loadRegistry } from "../../src/modules/registry-record";
import { blockers, latestDraft } from "../../src/core/state";
import { buildSetup } from "../../src/synth/build";
import type { Built } from "../../src/synth/build";
import { SEED_FINDING, seedScript } from "../../src/synth/seed-script";

let tmp: string;
let built: Built;
let truths: GroundTruth[];
let pivotTitle: (id: string) => string | null;
let pivotTo: (id: string) => string | null;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "synth-seed-script-"));
  mkdirSync(join(tmp, "home"));
  built = buildSetup(join(tmp, "setup"), { params: TINY_PARAMS, model: "scripted" }, null);
  const dir = join(built.dir, "truth");
  truths = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "mess.json").sort().map((f) => readGroundTruth(readFileSync(join(dir, f)))!);
  const registry = loadRegistry([{ path: join(built.dir, "root"), trusted: true, credentials: [] }]);
  pivotTitle = (id) => registry.pivot(id)?.title ?? null;
  pivotTo = (id) => registry.pivot(id)?.to ?? null;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Turn { actor: string; when?: string[]; reply: { content?: string; tool_calls?: { tool: string; args: Record<string, unknown> }[] } }
const parse = (text: string): { kind: string; id: string; turns: Turn[] } => Bun.YAML.parse(text) as { kind: string; id: string; turns: Turn[] };
const tasks = (): PublicTask[] => truths.map((t) => t.task);
const ACTORS = ["analyst", "orchestrator", "planner", "publisher", "researcher-g1"];

test("the script parses as a kind: script manifest of id synth-seed, with five actors' turns a task", () => {
  expect(truths.length).toBe(9);
  const s = parse(seedScript(tasks(), pivotTitle, pivotTo));
  expect(s.kind).toBe("script");
  expect(s.id).toBe("synth-seed");
  for (const t of tasks()) {
    const mine = s.turns.filter((x) => x.when?.includes(t.question));
    expect([...new Set(mine.map((x) => x.actor))].sort()).toEqual(ACTORS);
    const assess = mine.flatMap((x) => x.reply.tool_calls ?? []).filter((c) => c.tool === "propose_assessment");
    expect(assess.length).toBe(1);
    expect(assess[0]!.args.claim).toBe(SEED_FINDING);
    expect(assess[0]!.args.likelihood).toBe("roughly even chance");
    expect(assess[0]!.args.confidence).toBe("low");
    expect(assess[0]!.args.cites).toEqual([`{{card:${pivotTitle(t.seed_route[0]!)}: ${t.starting[0]!.value}}}`]);
    const plan = JSON.parse(mine.find((x) => x.actor === "planner")!.reply.content!) as { subgoals: { have: unknown[]; route: string[] }[] };
    expect(plan.subgoals.length).toBe(1);
    expect(plan.subgoals[0]!.have).toEqual([t.starting[0]!]);
    expect(plan.subgoals[0]!.route).toEqual(t.seed_route);
    const pub = JSON.parse(mine.find((x) => x.actor === "publisher")!.reply.content!) as { title: string; note: string };
    expect(pub).toEqual({ title: `[synthetic] ${t.title}`, note: "Seeded synthetic task; the product judges nothing." });
  }
  // the build wrote the same script into the root
  expect(readFileSync(join(built.dir, "root", "scripts", "synth-seed.yaml"), "utf8")).toBe(seedScript(tasks(), pivotTitle, pivotTo));
});

test("every turn of a task carries that task's question in when, and no two tasks share a question", () => {
  const qs = tasks().map((t) => t.question);
  expect(new Set(qs).size).toBe(qs.length);
  for (const a of qs) for (const b of qs) if (a !== b) expect(b.includes(a)).toBe(false);
  const s = parse(seedScript(tasks(), pivotTitle, pivotTo));
  for (const turn of s.turns) {
    expect(turn.when).toBeDefined();
    expect(turn.when!.filter((w) => qs.includes(w)).length).toBe(1);
  }
  expect(s.turns.length).toBe(qs.length * 7);
});

test("the script holds no summary and no claim of any truth of the build it was made for", () => {
  const text = seedScript(tasks(), pivotTitle, pivotTo);
  for (const t of truths) {
    expect(text.includes(t.summary)).toBe(false);
    for (const f of t.findings) expect(text.includes(f.claim)).toBe(false);
  }
  const file = readFileSync(join(built.dir, "root", "scripts", "synth-seed.yaml"), "utf8");
  for (const t of truths) {
    expect(file.includes(t.summary)).toBe(false);
    for (const f of t.findings) expect(file.includes(f.claim)).toBe(false);
  }
});

test("a question with a quote, a colon and a brace is written so that the YAML parses back to it", () => {
  const base = tasks()[0]!;
  const odd: PublicTask = { ...base, title: `A "title": {odd} 'one' #1`, question: `Why did "it" say: {{x}} and } # not a comment?\nA second line, 'quoted'.` };
  const s = parse(seedScript([odd], pivotTitle, pivotTo));
  expect(s.turns.length).toBe(7);
  for (const turn of s.turns) expect(turn.when).toEqual([odd.question]);
  const goals = JSON.parse(s.turns.find((x) => x.actor === "orchestrator")!.reply.content!) as { goals: { title: string; question: string }[] };
  expect(goals.goals[0]!.question).toBe(odd.question);
  expect(JSON.parse(s.turns.find((x) => x.actor === "publisher")!.reply.content!).title).toBe(`[synthetic] ${odd.title}`);
});

// ---------- the seed loop on the built setup ----------

const configOf = (): Config => loadConfig({ path: built.config, env: {}, home: join(tmp, "home") });

test("the built root has the loop synth-seed, usable, on the scripted model synth-seed, and compose has no problem about it", () => {
  const loop = Bun.YAML.parse(readFileSync(join(built.dir, "root", "loops", "synth-seed.yaml"), "utf8")) as { id: string; profile: string; case_type?: unknown; stages: { runs: string; model: unknown }[] };
  expect(loop.id).toBe("synth-seed");
  expect(loop.profile).toBe("synth-seed");
  expect(loop.case_type).toBeUndefined();
  for (const st of loop.stages) expect(st.model).toEqual(st.runs === "agent" ? { provider: "scripted", model: "synth-seed", effort: null } : null);
  const config = configOf();
  const wb = Workbench.open(config.data_dir, { store: config.cases.store, memory: config.memory.store, onError: () => {} });
  try {
    const c = compose(config, wb);
    try {
      expect(c.deps.loops!.current("synth-seed")).not.toBeNull();
      expect(c.deps.loops!.problems("synth-seed")).toEqual([]);
      expect(c.problems.filter((p) => p.includes("synth-seed"))).toEqual([]);
    } finally {
      c.close();
    }
  } finally {
    wb.close();
  }
});

/** Each storyline's seed case, run to its plan gate, accepted with no budget, and run to its publish gate; what was seen at each. */
interface Seen { storyline: string; session: CaseSession; atPlan: { status: string; waiting: string | null; steps: { free: boolean }[] }; atPublish: { status: string; waiting: string | null; why?: string; blockers: string[] } }
let seen: Seen[] | null = null;
let runsWb: Workbench | null = null;
afterAll(() => runsWb?.close());
async function seedRuns(): Promise<Seen[]> {
  if (seen !== null) return seen;
  const config = configOf();
  const human: Actor = { kind: "human", id: config.user };
  const wb = Workbench.open(join(tmp, "runs"), { onError: () => {} });
  runsWb = wb;
  const composed = compose({ ...config, data_dir: join(tmp, "runs") }, wb);
  const deps = { ...composed.deps };
  const host = hostsFor(wb, deps, () => {});
  const out: Seen[] = [];
  try {
    for (const t of truths) {
      const task = t.task;
      const session = wb.createCase(
        { title: `[synthetic] ${task.title}`, asked: task.question, why: `synthetic task: storyline ${task.storyline}`, starting: task.starting, window: task.window, objective: "synth-objective", marking: "TLP:GREEN" },
        human, { loop: "synth-seed", type: task.case_type },
      );
      const engine = host.engine(session.id);
      engine.start(human);
      await engine.advance();
      const a = session.state;
      const atPlan = { status: a.run.status, waiting: a.run.waiting, steps: (a.plan.current?.steps ?? []).map((x) => ({ free: x.free })) };
      if (a.run.waiting === "plan") {
        engine.acceptPlan({ actor: human });
        await engine.advance();
      }
      const b = session.state;
      const draft = latestDraft(b);
      out.push({ storyline: t.storyline, session, atPlan, atPublish: { status: b.run.status, waiting: b.run.waiting, ...(b.run.pause_reason === null ? {} : { why: b.run.pause_reason }), blockers: draft === null ? ["no draft"] : blockers(b, draft.hash) } });
      expect(b.skipped).toEqual([]);
    }
  } finally {
    host.close();
    composed.close();
  }
  seen = out;
  return out;
}

test("a seed case runs to its plan gate with one free step, and after the plan is accepted to its publish gate with no blocker, for each of the nine storylines", async () => {
  const runs = await seedRuns();
  expect(runs.length).toBe(9);
  for (const r of runs) {
    expect({ storyline: r.storyline, ...r.atPlan }).toEqual({ storyline: r.storyline, status: "waiting", waiting: "plan", steps: [{ free: true }] });
    expect({ storyline: r.storyline, ...r.atPublish }).toEqual({ storyline: r.storyline, status: "waiting", waiting: "publish", blockers: [] });
  }
}, 120_000);

test("the seed run asked only free lookups: no costly_query proposal, no estimate query", async () => {
  const runs = await seedRuns();
  for (const r of runs) {
    const entries = r.session.entries();
    const costly = entries.filter((e) => e.type === "proposal.created" && (e.payload as { kind?: string }).kind === "costly_query");
    expect(costly).toEqual([]);
    const issued = entries.filter((e) => e.type === "query.issued").map((e) => e.payload as { purpose: string });
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.filter((q) => q.purpose === "estimate")).toEqual([]);
  }
}, 120_000);
