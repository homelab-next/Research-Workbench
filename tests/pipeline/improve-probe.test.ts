// Slice 14, Task 11: Probe runs every task under the base and each candidate as probe children, each bound to its version.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import { BlobStore } from "../../src/core/blobs";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import { fold, probeOutputOf, readProbeOutput } from "../../src/core/state";
import type { TaskInputs } from "../../src/core/state";
import type { Actor, Entry, EntryInput, Marking } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import type { ChildLink, NewCase, ProbeMark } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { checkCandidate, stageCandidate } from "../../src/modules/loop-stage";
import type { ManifestFile } from "../../src/modules/loop-write";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnv, StageRunner } from "../../src/pipeline/engine";
import type { ImproveHost, ProbeRef } from "../../src/pipeline/improve/host";
import { driveProbe, NO_IMPROVE_HOST, PROBE_PLAN_ACCEPTS, probeBudgets, probeLink } from "../../src/pipeline/improve/probe";
import type { ResolvedLoop } from "../../src/pipeline/loops";
import { planRunner } from "../../src/pipeline/stages/plan";
import { IMPROVE_ROLES } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { readChild } from "../../src/pipeline/subloop";
import type { ChildRef } from "../../src/pipeline/subloop";
import { sampleRoot } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
const ENGINE: Actor = { kind: "system", id: "engine" };
const PROBE: Actor = { kind: "system", id: "improve-probe" };
const TARGET = "investigation";
const TYPE = "unknown-device";
const agentOf = (stage: string): Actor => ({ kind: "agent", id: stage, stage, profile: "investigation", model: "sample-run", effort: null, where: "machine" });

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let config: Config;
let wb: Workbench;
let composed: ReturnType<typeof compose>;
let host: Host;
const sessions: CaseSession[] = [];

const TITLES: Record<string, string> = { select: "Select", propose: "Propose", probe: "Probe", compose: "Compose", judge: "Judge", reflect: "Reflect", adopt: "Adopt" };
/** The improve loop, written in the test with seven inline stages. */
function improveLoop(): Record<string, Json> {
  const stages = IMPROVE_ROLES.map((role, i): Record<string, Json> => {
    const agent = role === "propose" || role === "compose" || role === "reflect";
    return {
      id: role, title: TITLES[role]!, order: i + 1, runs: agent ? "agent" : role === "adopt" ? "human" : "script", role, gate: role === "adopt" ? "adopt" : null, reviews: false,
      tools: [], schema: null, model: agent ? { provider: "scripted", model: "sample-device", effort: null } : null, on_pass: IMPROVE_ROLES[i + 1] ?? null, on_fail: null,
      ...(role === "probe" ? { probe: { plan_gate: "accept" } } : {}),
    };
  });
  return { kind: "loop", id: "improve", title: "Improve", version: 1, profile: "improve-test", entry: "select", stages };
}
const IMPROVE_PROFILE = {
  kind: "profile", id: "improve-test", title: "Improve (test)", rules: "base-rules", framework: "intel-cycle", standard: "icd203",
  stages: Object.fromEntries(["propose", "compose", "reflect"].map((id) => [id, { agent: "analyst", persona: "analyst", goal: `The ${id} stage of the test.` }])),
};

/** The test's host: the real workbench, one engine per probe child, the real staging over a staging folder. `probes.drive` is driveProbe. */
class Host implements ImproveHost {
  readonly engines = new Map<string, Engine>();
  created: string[] = [];
  ended: { id: string; reason: string }[] = [];
  /** Runners a child's engine is opened with, by the child's state (its probe's task, say). */
  childRunners: (s: CaseSession) => Partial<Record<Role, StageRunner>> = () => ({});
  afterEnd: ((ref: ProbeRef) => void) | null = null;
  endFailsOnce = false;
  constructor(private readonly deps: () => EngineDeps) {}
  private store(i: { case: string }): string { return join(dir, "staged", i.case); }
  engine(id: string): Engine {
    let e = this.engines.get(id);
    if (e === undefined) {
      const s = wb.session(id);
      if (!sessions.includes(s)) sessions.push(s);
      e = Engine.open(s, { ...this.deps(), improve: this }, { runners: this.childRunners(s) });
      this.engines.set(id, e);
    }
    return e;
  }
  tasks(): never { throw new Error("Probe reads no task"); }
  task(): never { throw new Error("Probe reads no task"); }
  staged(i: { case: string; origin: string | null }): BlobStore { return new BlobStore(join(this.store(i), "blobs")); }
  stage(i: { case: string; origin: string | null }, _root: string, files: ManifestFile[], target: string): ReturnType<ImproveHost["stage"]> {
    return stageCandidate(candidateDeps(), sample.root, files, target, this.staged(i));
  }
  check(_root: string, files: ManifestFile[], target: string): ReturnType<ImproveHost["check"]> { return checkCandidate(candidateDeps(), sample.root, files, target); }
  clear(i: { case: string }): void { rmSync(this.store(i), { recursive: true, force: true }); }
  probes: ImproveHost["probes"] = {
    find: (link: ChildLink) => {
      const id = wb.findChild(link);
      return id === null ? null : { id, origin: wb.loadedOrigin(id)! };
    },
    create: (input: NewCase, link: ChildLink, mark: ProbeMark, type: string) => {
      const s = wb.createCase(input, ENGINE, { loop: link.loop, link, probe: mark, type });
      sessions.push(s);
      this.created.push(s.id);
      return { id: s.id, origin: s.entries(0, 1)[0]!.hash };
    },
    drive: async (ref: ProbeRef, opts: { loop: ResolvedLoop }) => {
      if (this.probes.read(ref) === null) throw new Error(`${ref.id} is not the child`);
      return driveProbe(this.engine(ref.id), wb.session(ref.id), opts.loop);
    },
    read: (ref: ChildRef) => {
      let s: CaseSession;
      try { s = wb.session(ref.id); } catch { return null; }
      return readChild(s, ref);
    },
    end: (ref: ProbeRef, reason: string) => {
      if (this.endFailsOnce) {
        this.endFailsOnce = false;
        throw new Error("the process stopped");
      }
      const st = wb.session(ref.id).state.run.status;
      if (st !== "none" && st !== "finished") this.engine(ref.id).endProbe(reason);
      this.ended.push({ id: ref.id, reason });
      this.afterEnd?.(ref);
    },
  };
}

const candidateDeps = () => ({ config, chain: wb.chain, content: wb.chainBlobs, secrets: [] as string[], registry: composed.deps.registry, loops: composed.deps.loops! });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "improve-probe-"));
  sample = sampleRoot(dir);
  writeFileSync(join(sample.root, "loops", "improve.yaml"), JSON.stringify(improveLoop(), null, 2));
  writeFileSync(join(sample.root, "context", "improve-test-profile.yaml"), JSON.stringify(IMPROVE_PROFILE, null, 2));
  // the sample's script runs the reputation lookup (its plan's step s3); code accepts free steps only, so the lookup is made free in this copy
  const rep = join(sample.root, "sources", "reputation.yaml");
  const repText = readFileSync(rep, "utf8");
  if (!repText.includes("cost: { weight: 5, unit: lookups }")) throw new Error("the sample's reputation cost changed");
  writeFileSync(rep, repText.replace("cost: { weight: 5, unit: lookups }", "cost: { weight: 0, unit: lookups }"));
  const base = loadConfig({ env: {}, home: dir, repoRoot: dir });
  config = {
    ...base, data_dir: join(dir, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 },
    loops: { ...base.loops, store: join(dir, "wb", "loops"), imports: join(dir, "wb", "imported") },
  };
  wb = Workbench.open(config.data_dir, { onError: () => {} });
  composed = compose(config, wb);
  host = new Host(() => composed.deps);
  sessions.length = 0;
});
afterEach(() => {
  for (const s of sessions) if (s.open) expect(s.state.skipped).toEqual([]);
  for (const e of host.engines.values()) e.close();
  try { composed.close(); } catch { /* closed */ }
  try { wb.close(); } catch { /* closed */ }
  sample.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = { title: "Improve", asked: "Improve the investigation loop", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: null, marking: "TLP:AMBER" as Marking };
const live = (): ResolvedLoop => composed.deps.loops!.current(TARGET)!;
const ofType = <T extends Entry["type"]>(s: CaseSession, type: T): Extract<Entry, { type: T }>[] => s.entries().filter((e): e is Extract<Entry, { type: T }> => e.type === type);
const put = (s: CaseSession, x: Json) => s.blobs.put(canonical(x));
const commitIn = (env: StageEnv, entries: (s: CaseSession, next: (kind: "change") => string) => EntryInput[]): void => {
  env.session.commit((st, ids) => entries(env.session, (kind) => ids.next(kind)).map((e) => ({ ...e, run: st.run.id, stage: env.stage.id })));
};

/** An improve case, made by the person for the target loop and its case type. */
function improveCase(tasks = 2): CaseSession {
  const s = wb.createCase(input, human, { loop: "improve", improve: { target: TARGET, case_type: TYPE, tasks, candidates: 1 }, type: TYPE });
  sessions.push(s);
  return s;
}
const taskInputs = (n: number): TaskInputs => ({
  question: `Task ${n}: who is behind the traffic to 198.51.100.77?`, starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN", title: `Task ${n}`,
});
/** Select's record: the selection of the live target and `n` tasks (cases that are not loaded here). */
const selects = (n: number) => (env: StageEnv): void => commitIn(env, (s) => [
  {
    type: "improve.selected", actor: ENGINE,
    payload: { target: TARGET, version: 1, loop_hash: live().pipeline.hash, lock: put(s, live().lock as unknown as Json), case_type: TYPE, scale: ["unlikely", "likely"], left_out: [] },
  },
  ...Array.from({ length: n }, (_, i): EntryInput => ({
    type: "improve.task", actor: ENGINE,
    payload: {
      task: `T${i + 1}`, case: `CASE-${90 + i}`, origin: "f".repeat(64), head: { seq: 9, hash: "9".repeat(64) }, product: { n: 1, draft_hash: "d".repeat(64) },
      answer: { seq: 8, hash: "8".repeat(64) }, marking: "TLP:GREEN", inputs: put(s, taskInputs(i + 1) as unknown as Json), record: put(s, { record: i + 1 }),
    },
  })),
]);
const PROCEDURE = "context/procedures/research.md";
const candidateFiles = (): ManifestFile[] => {
  const text = readFileSync(join(sample.root, ...PROCEDURE.split("/")), "utf8");
  if (!text.includes("Say what was not found.")) throw new Error("the sample's procedure changed");
  return [{ path: PROCEDURE, text: text.replace("Say what was not found.", "Say what was not found, and why.") }];
};
/** Propose's record: chg-1 and its candidate K1, staged for real through the host (or dropped). */
const proposes = (status: "staged" | "dropped") => (env: StageEnv): void => {
  const files = candidateFiles();
  const before = readFileSync(join(sample.root, ...PROCEDURE.split("/")), "utf8");
  const staged = status === "staged" ? host.stage({ case: env.session.id, origin: env.session.entries(0, 1)[0]!.hash }, "sample", files, TARGET) : null;
  if (staged !== null && !staged.ok) throw new Error(staged.problems.join(" | "));
  commitIn(env, (s, next) => [
    {
      type: "builder.proposed", actor: agentOf("propose"),
      payload: {
        change: next("change"), title: "Say why", why: "fewer misses", root: "sample",
        files: [{ path: PROCEDURE, kind: "procedure", id: "research-sop", before: sha256Hex(before), after: sha256Hex(files[0]!.text) }],
        bundle: put(s, { files: files.map((f) => ({ path: f.path, text: f.text })) } as unknown as Json),
      },
    },
    staged !== null && staged.ok
      ? { type: "improve.candidate", actor: ENGINE, payload: { candidate: "K1", change: "chg-1", status: "staged", loop_hash: staged.loop.pipeline.hash, lock: put(s, staged.loop.lock as unknown as Json), reason: "" } }
      : { type: "improve.candidate", actor: ENGINE, payload: { candidate: "K1", change: "chg-1", status: "dropped", loop_hash: null, lock: null, reason: "it changes nothing the loop reads" } },
  ]);
};
const STOP_AFTER_PROBE = "the test stops after Probe";
const passWith = (action: ((env: StageEnv) => void) | null): StageRunner => async (env) => {
  action?.(env);
  return { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
};
/** The improve case's runners: Select and Propose write their record; Compose stops the run; Probe is the engine's own. */
const improveRunners = (tasks: number, candidate: "staged" | "dropped" | "none"): Partial<Record<Role, StageRunner>> => ({
  select: passWith(selects(tasks)),
  propose: passWith(candidate === "none" ? null : proposes(candidate)),
  compose: async () => ({ kind: "stalled", reason: STOP_AFTER_PROBE }),
});
const improveDeps = (over: Partial<EngineDeps> = {}): EngineDeps => ({ ...composed.deps, improve: host, ...over });
/** An improve case run to where it stops: Compose, in the test. */
async function runImprove(opts: { tasks?: number; candidate?: "staged" | "dropped" | "none"; deps?: Partial<EngineDeps> } = {}): Promise<{ s: CaseSession; e: Engine }> {
  const s = improveCase(opts.tasks ?? 2);
  const e = Engine.open(s, improveDeps(opts.deps), { runners: improveRunners(opts.tasks ?? 2, opts.candidate ?? "staged") });
  e.start(human);
  await e.advance();
  return { s, e };
}
const child = (id: string): CaseSession => wb.session(id);
const probeStage = (s: CaseSession) => s.state.run.stages.find((x) => x.id === "probe")!;
const boundHash = (c: CaseSession): string | null => c.state.loop.bound?.hash ?? null;

/** A probe child of `parent` made straight on the workbench, for the driver's own tests. */
function probeChildOf(parent: CaseSession, task = "T1", candidate = "base"): CaseSession {
  const probe = `${candidate}/${task}`;
  const link = probeLink(parent.state, "probe", { probe, loop_hash: live().pipeline.hash }, taskInputs(1));
  const mark: ProbeMark = { improve: parent.id, origin: parent.entries(0, 1)[0]!.hash, probe, candidate, task, plan_gate: "accept", max_lookups: 20, max_tokens: 300000 };
  const s = wb.createCase({ ...input, title: "Probe", objective: "sample-objective" }, ENGINE, { loop: TARGET, link, probe: mark, type: TYPE });
  sessions.push(s);
  return s;
}
/** An improve case at its Probe stage's run, for the driver's tests: a run that has selected, so probeLink has a run to name. */
async function parentAtProbe(): Promise<CaseSession> {
  const s = improveCase(1);
  const e = Engine.open(s, improveDeps(), { runners: { ...improveRunners(1, "none"), probe: async () => ({ kind: "stalled", reason: "the test drives its own probe" }) } });
  e.start(human);
  await e.advance();
  e.close();
  return s;
}
const engineOf = (s: CaseSession, runners: Partial<Record<Role, StageRunner>> = {}): Engine => {
  const e = Engine.open(s, improveDeps(), { runners });
  host.engines.set(`own-${s.id}`, e);
  return e;
};
const probeAccepts = (s: CaseSession): number => ofType(s, "plan.accepted").filter((e) => e.actor.kind === "system" && e.actor.id === "improve-probe").length;

// ---- Step 1: the pieces

test("probeBudgets divides the two budgets by the children and floors; a share below 1 is the sentence", () => {
  const cfg = config.improve;
  expect(probeBudgets({ ...cfg, probe_lookups: 240, probe_tokens: 1200000 }, 12)).toEqual({ lookups: 20, tokens: 100000 });
  expect(probeBudgets({ ...cfg, probe_lookups: 10, probe_tokens: 1000 }, 3)).toEqual({ lookups: 3, tokens: 333 });
  expect(probeBudgets({ ...cfg, probe_lookups: 3, probe_tokens: 1000 }, 4)).toBe("the probe budget of 3 lookups does not cover 4 children");
  expect(probeBudgets({ ...cfg, probe_lookups: 240, probe_tokens: 3 }, 4)).toBe("the probe budget of 3 tokens does not cover 4 children");
  // the defaults, for one candidate and three tasks: eight children, every share whole
  expect(probeBudgets(cfg, 8)).toEqual({ lookups: 30, tokens: 150000 });
});

test("probeLink is the same for the same probe and differs between two probes of one task", async () => {
  const s = await parentAtProbe();
  const a = probeLink(s.state, "probe", { probe: "base/T1", loop_hash: "a".repeat(64) }, taskInputs(1));
  expect(probeLink(s.state, "probe", { probe: "base/T1", loop_hash: "a".repeat(64) }, taskInputs(1))).toEqual(a);
  expect(a).toMatchObject({ parent: s.id, run: s.state.run.id!, stage: "probe", attempt: 1, loop: TARGET, depth: 1, floor: "TLP:AMBER" });
  const b = probeLink(s.state, "probe", { probe: "K1/T1", loop_hash: "b".repeat(64) }, taskInputs(1));
  expect(b.input_hash).not.toBe(a.input_hash);
  // the hash is over the probe's id, the loop's hash and the task's inputs: each changes it
  expect(probeLink(s.state, "probe", { probe: "K1/T1", loop_hash: "a".repeat(64) }, taskInputs(1)).input_hash).not.toBe(a.input_hash);
  expect(probeLink(s.state, "probe", { probe: "base/T1", loop_hash: "a".repeat(64) }, taskInputs(2)).input_hash).not.toBe(a.input_hash);
  expect(a.input_hash).toBe(sha256Hex(canonical({ probe: "base/T1", loop_hash: "a".repeat(64), inputs: taskInputs(1) } as unknown as Json)));
});

test("driveProbe starts the child on the loop given, accepts its plan as improve-probe, and returns when it waits at its publish gate", async () => {
  const parent = await parentAtProbe();
  const c = probeChildOf(parent);
  const summary = await driveProbe(engineOf(c), c, live());
  expect(summary).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(boundHash(c)).toBe(live().pipeline.hash);
  expect(ofType(c, "loop.bound")[0]!.actor).toEqual(ENGINE);
  const accepted = ofType(c, "plan.accepted");
  expect(accepted).toHaveLength(1);
  expect(accepted[0]!.actor).toEqual(PROBE);
  expect(ofType(c, "gate.passed").map((e) => [e.payload.gate, e.actor])).toEqual([["plan", PROBE]]);
  expect(probeOutputOf(c.state).outcome).toBe("drafted");
});

test("driveProbe passes no publish gate and writes nothing by a person", async () => {
  const parent = await parentAtProbe();
  const c = probeChildOf(parent);
  await driveProbe(engineOf(c), c, live());
  // and a second drive of a child at its publish gate writes nothing
  const n = c.entries().length;
  expect(await driveProbe(engineOf(c), c, live())).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(c.entries().length).toBe(n);
  expect(c.entries().some((e) => e.actor.kind === "human")).toBe(false);
  expect(c.entries().some((e) => e.type === "product.published" || (e.type === "gate.passed" && e.payload.gate === "publish"))).toBe(false);
});

test("driveProbe resumes an interrupted child once, and leaves a paused one paused", async () => {
  const parent = await parentAtProbe();
  // interrupted: a process stopped while the run was running
  const a = probeChildOf(parent);
  const ea = engineOf(a);
  ea.start(ENGINE, { loop: live() });
  a.commit((st) => [{ type: "run.interrupted", actor: { kind: "system", id: "recovery" }, payload: {}, run: st.run.id }]);
  expect(a.state.run.status).toBe("interrupted");
  expect(await driveProbe(ea, a, live())).toMatchObject({ status: "waiting", waiting: "publish" });
  const resumed = ofType(a, "run.resumed");
  expect(resumed).toHaveLength(1);
  expect(resumed[0]!.actor).toEqual(PROBE);
  // paused, by the engine or a person: left as it is
  const b = probeChildOf(parent, "T1", "K1");
  const eb = engineOf(b);
  eb.start(ENGINE, { loop: live() });
  eb.pause(ENGINE);
  const n = b.entries().length;
  expect(await driveProbe(eb, b, live())).toMatchObject({ status: "paused" });
  expect(b.entries().length).toBe(n);
  expect(ofType(b, "run.resumed")).toHaveLength(0);
});

test("a child that plans again is accepted again, four times at most", async () => {
  expect(PROBE_PLAN_ACCEPTS).toBe(4);
  const parent = await parentAtProbe();
  const c = probeChildOf(parent);
  // Research always fails, and its work goes back to Plan, which plans again: the planner's first plan, proposed once more
  const failResearch: StageRunner = async () => ({ kind: "finished", outcome: "fail", draft_hash: null, output: null, reason: "the research failed in the test" });
  const replan: StageRunner = async (env) => {
    const last = env.session.entries().findLast((x) => x.type === "plan.proposed");
    if (last === undefined || last.type !== "plan.proposed") return planRunner(env);
    env.session.commit((st, ids) => [{ type: "plan.proposed", actor: last.actor, run: st.run.id, stage: env.stage.id, payload: { plan: { ...last.payload.plan, id: ids.next("plan") } } }]);
    return { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
  };
  const e = engineOf(c, { research: failResearch, plan: replan });
  const first = await driveProbe(e, c, live());
  expect(probeAccepts(c)).toBe(4);
  expect(first.status).toBe("paused");
  // a person takes it past the send-back cap: it plans a fifth time, and code accepts no fifth plan
  await e.resume(human);
  expect(c.state.run).toMatchObject({ status: "waiting", waiting: "plan" });
  expect(await driveProbe(e, c, live())).toMatchObject({ status: "waiting", waiting: "plan" });
  expect(probeAccepts(c)).toBe(4);
});

// ---- Step 5: the stage

test("with one staged candidate and two tasks Probe makes four children, base first, each bound to its version", async () => {
  const { s } = await runImprove();
  expect(s.state.run.pause_reason).toBe(STOP_AFTER_PROBE);
  expect(probeStage(s).status).toBe("passed");
  const started = ofType(s, "probe.started").map((e) => e.payload);
  expect(started.map((p) => p.probe)).toEqual(["base/T1", "base/T2", "K1/T1", "K1/T2"]);
  expect(host.created).toEqual(started.map((p) => p.child));
  const k1 = s.state.improve.candidates.K1!;
  expect(k1.loop_hash).not.toBe(s.state.improve.selected!.loop_hash);
  for (const p of started) {
    const want = p.candidate === "base" ? s.state.improve.selected!.loop_hash : k1.loop_hash!;
    expect(p.loop_hash).toBe(want);
    // the two K1 children's loop.bound hash is the candidate's; the two base children's is selected.loop_hash
    expect(boundHash(child(p.child))).toBe(want);
    expect(ofType(child(p.child), "loop.bound")).toHaveLength(1);
  }
  // the stage's output lists each probe's child and outcome
  const out = ofType(s, "stage.finished").find((e) => e.payload.stage === "probe")!.payload.output!;
  expect(JSON.parse(s.blobs.text(out.blob))).toEqual(started.map((p) => ({ probe: p.probe, child: p.child, outcome: "drafted" })));
  // Probe never waits on a child and never passes a gate in the improve case
  expect(s.entries().some((e) => e.type === "gate.passed" || e.type === "plan.accepted")).toBe(false);
  expect(s.state.run.hold).toBeNull();
});

test("each child is marked a probe child, as strictly as the improve case, of the task's case type, with its lookup cap and token budget", async () => {
  const { s } = await runImprove();
  const budgets = probeBudgets(config.improve, 4) as { lookups: number; tokens: number };
  expect(budgets).toEqual({ lookups: 60, tokens: 300000 });
  for (const p of ofType(s, "probe.started").map((e) => e.payload)) {
    expect(p.budgets).toEqual(budgets);
    const c = child(p.child);
    const first = c.entries().slice(0, 6);
    expect(first.map((e) => e.type)).toEqual(["case.created", "case.loop_set", "subloop.child", "case.type_set", "probe.child", "budget.set"]);
    expect(c.state.improve.probe_of).toEqual({ improve: s.id, origin: s.entries(0, 1)[0]!.hash, probe: p.probe, candidate: p.candidate, task: p.task, plan_gate: "accept", max_lookups: 60 });
    expect(first[5]!.type === "budget.set" ? first[5]!.payload : null).toEqual({ tokens: 300000 });
    expect(c.state.meta!.marking).toBe("TLP:AMBER");
    expect(c.state.memory.type).toBe(TYPE);
    // the child's question and values are the task's
    const t = Number(p.task.slice(1));
    expect(c.state.meta!.asked).toBe(taskInputs(t).question);
    expect(c.state.meta!.starting).toEqual([SAMPLE_START]);
    expect(c.state.loop.parent).toMatchObject({ case: s.id, run: s.state.run.id!, stage: "probe", attempt: 1, input_hash: p.input_hash, depth: 1 });
    expect(p.origin).toBe(c.entries(0, 1)[0]!.hash);
  }
});

test("every query of a probe is in that child's own ledger, through runQuery, and none is in the improve case", async () => {
  const { s } = await runImprove();
  expect(ofType(s, "query.issued")).toHaveLength(0);
  for (const e of ofType(s, "probe.finished")) {
    const c = child(e.payload.child);
    const issued = ofType(c, "query.issued");
    expect(issued.length).toBeGreaterThan(0);
    expect(e.payload.lookups).toBe(Object.keys(c.state.queries).length);
    expect(e.payload.lookups).toBeLessThanOrEqual(60);
  }
});

test("probe.finished holds the child's head, the hash of its output and the output as a blob of the improve case", async () => {
  const { s } = await runImprove();
  const finished = ofType(s, "probe.finished").map((e) => e.payload);
  expect(finished.map((p) => p.probe)).toEqual(["base/T1", "base/T2", "K1/T1", "K1/T2"]);
  for (const p of finished) {
    const c = child(p.child);
    const entries = c.entries();
    expect(entries.find((e) => e.seq === p.head.seq)!.hash).toBe(p.head.hash);
    // the output is what the child's fold at that head gives, as a blob of the improve case, and its hash
    const at = probeOutputOf(fold([...entries], p.head.seq));
    expect(p.output_hash).toBe(sha256Hex(canonical(at as unknown as Json)));
    expect(p.output.blob).toBe(p.output_hash);
    expect(readProbeOutput(s.blobs.get(p.output.blob))).toEqual(at);
    expect(p).toMatchObject({ outcome: "drafted", reason: "", draft_hash: at.draft_hash, lookups: at.stats.lookups, tokens: at.stats.tokens });
    expect(p.child_run).toBe(c.state.run.id);
    expect(p.tokens).toBeGreaterThan(0);
  }
});

test("a child that pauses on a question to the person, on a declined model or on its budget is recorded incomplete with the reason, and Probe goes on", async () => {
  const declined: StageRunner = async () => ({ kind: "declined", reason: "the model declined in the test" });
  const asks: StageRunner = async (env) => {
    env.session.commit((st) => [{
      type: "question.asked", actor: agentOf(env.stage.id), run: st.run.id, stage: env.stage.id,
      payload: { question: { id: "q-1", text: "Which network is this?", why: "the test asks", cards: [], about: [], blocking: true } },
    }]);
    return { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
  };
  host.childRunners = (c) => {
    const task = c.state.improve.probe_of?.task;
    return task === "T1" ? { frame: declined } : task === "T2" ? { frame: asks } : {};
  };
  // a share of 1 token: T3's child stops on its budget at its first model call past it
  const { s } = await runImprove({ tasks: 3, candidate: "none", deps: { config: { ...config, improve: { ...config.improve, probe_tokens: 3 } } } });
  expect(probeStage(s).status).toBe("passed");
  const finished = ofType(s, "probe.finished").map((e) => e.payload);
  expect(finished.map((p) => [p.probe, p.outcome])).toEqual([["base/T1", "incomplete"], ["base/T2", "incomplete"], ["base/T3", "incomplete"]]);
  for (const p of finished) {
    const c = child(p.child);
    expect(p.draft_hash).toBeNull();
    expect(p.reason).not.toBe("");
    expect(readProbeOutput(s.blobs.get(p.output.blob))!.reason).toBe(p.reason);
    // ended once recorded, as stopped, by improve-probe
    expect(c.state.run).toMatchObject({ status: "finished", outcome: "stopped" });
  }
  expect(finished[0]!.reason).toMatch(/declined/);
  expect(finished[1]!.reason).toMatch(/Which network is this\?|question/);
  expect(finished[2]!.reason).toMatch(/budget/);
});

test("after its probe is recorded a child's run is ended as stopped by improve-probe; nothing was published", async () => {
  const { s } = await runImprove();
  const finished = ofType(s, "probe.finished");
  expect(host.ended.map((x) => x.id)).toEqual(finished.map((e) => e.payload.child));
  for (const e of finished) {
    const c = child(e.payload.child);
    const end = ofType(c, "run.finished");
    expect(end).toHaveLength(1);
    expect(end[0]!.actor).toEqual(PROBE);
    expect(end[0]!.payload).toEqual({ outcome: "stopped", reason: "a probe ends at its publish gate" });
    // the improve case recorded the child before it was ended
    expect(e.payload.head.seq).toBeLessThan(end[0]!.seq);
    expect(c.entries().some((x) => x.type === "product.published" || (x.type === "gate.passed" && x.payload.gate === "publish"))).toBe(false);
    expect(existsSync(join(c.dir, "products"))).toBe(false);
  }
});

/** Makes the session's next commit that would write an entry of `type` throw, once: a process stopped at that commit. */
function failOnce(s: CaseSession, type: Entry["type"]): void {
  const commit = s.commit.bind(s);
  let armed = true;
  s.commit = ((fn: Parameters<CaseSession["commit"]>[0]) => commit((state, ids) => {
    const out = fn(state, ids);
    if (armed && out.some((x) => x.type === type)) {
      armed = false;
      throw new Error("the process stopped");
    }
    return out;
  })) as CaseSession["commit"];
}

test("a process stopped after probe.started and before probe.finished: run again, Probe finds that child, makes no second one, and records it once", async () => {
  const s = improveCase(1);
  const e = Engine.open(s, improveDeps(), { runners: improveRunners(1, "none") });
  failOnce(s, "probe.finished");
  e.start(human);
  await e.advance();
  expect(s.state.run.status).toBe("paused");
  expect(ofType(s, "probe.started")).toHaveLength(1);
  expect(ofType(s, "probe.finished")).toHaveLength(0);
  expect(host.created).toHaveLength(1);
  await e.resume(human);
  expect(s.state.run.pause_reason).toBe(STOP_AFTER_PROBE);
  expect(host.created).toHaveLength(1);
  expect(wb.listCases()).toHaveLength(2);
  const finished = ofType(s, "probe.finished");
  expect(finished).toHaveLength(1);
  expect(finished[0]!.payload).toMatchObject({ probe: "base/T1", child: host.created[0]!, outcome: "drafted" });
  // a child a stopped process made and never recorded is found for its link, not made twice
  const s2 = improveCase(1);
  const e2 = Engine.open(s2, improveDeps(), { runners: improveRunners(1, "none") });
  failOnce(s2, "probe.started");
  e2.start(human);
  await e2.advance();
  expect(host.created).toHaveLength(2);
  expect(ofType(s2, "probe.started")).toHaveLength(0);
  await e2.resume(human);
  expect(host.created).toHaveLength(2);
  expect(ofType(s2, "probe.started").map((x) => x.payload.child)).toEqual([host.created[1]!]);
  expect(ofType(s2, "probe.finished")).toHaveLength(1);
});

test("a process stopped after probe.finished and before the child was ended: run again, the child is ended", async () => {
  const s = improveCase(1);
  const e = Engine.open(s, improveDeps(), { runners: improveRunners(1, "none") });
  host.endFailsOnce = true;
  e.start(human);
  await e.advance();
  expect(s.state.run.status).toBe("paused");
  expect(ofType(s, "probe.finished")).toHaveLength(1);
  const c = child(host.created[0]!);
  expect(c.state.run).toMatchObject({ status: "waiting", waiting: "publish" });
  await e.resume(human);
  expect(s.state.run.pause_reason).toBe(STOP_AFTER_PROBE);
  expect(c.state.run).toMatchObject({ status: "finished", outcome: "stopped" });
  expect(ofType(c, "run.finished")[0]!.actor).toEqual(PROBE);
  expect(ofType(s, "probe.finished")).toHaveLength(1);
  expect(host.created).toHaveLength(1);
});

test("a person stops the improve run between two probes: Probe ends stopped and starts no other child", async () => {
  const s = improveCase(2);
  const e = Engine.open(s, improveDeps(), { runners: improveRunners(2, "none") });
  host.afterEnd = () => {
    host.afterEnd = null;
    e.stop(human, "enough");
  };
  e.start(human);
  await e.advance();
  expect(s.state.run).toMatchObject({ status: "finished", outcome: "stopped" });
  expect(host.created).toHaveLength(1);
  expect(ofType(s, "probe.started").map((x) => x.payload.probe)).toEqual(["base/T1"]);
  expect(ofType(s, "probe.finished")).toHaveLength(1);
  // the stage wrote nothing after the stop
  const stop = ofType(s, "run.finished")[0]!;
  expect(s.entries().filter((x) => x.seq > stop.seq)).toEqual([]);
});

test("a dropped candidate has no child", async () => {
  const { s } = await runImprove({ tasks: 1, candidate: "dropped" });
  expect(s.state.improve.candidates.K1!.status).toBe("dropped");
  expect(ofType(s, "probe.started").map((x) => x.payload.probe)).toEqual(["base/T1"]);
  expect(host.created).toHaveLength(1);
  expect(probeStage(s).status).toBe("passed");
});

/** Every file under `root` with its hash, by relative path. */
function filesOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = sha256Hex(readFileSync(p));
    }
  };
  walk(root);
  return out;
}

test("Probe leaves the chain's loop.recorded entries, the roots and the content store as they were", async () => {
  const s = improveCase(1);
  let before: { chain: string[]; root: Record<string, string>; content: string[] } | null = null;
  const snapshot = () => ({
    chain: wb.chain.read().filter((x) => x.type === "loop.recorded" || x.type === "module.loaded" || x.type === "manifest.written").map((x) => x.hash),
    root: filesOf(join(sample.root)),
    content: readdirSync(join(config.data_dir, "blobs")).sort(),
  });
  // after Propose has staged K1, and before Probe runs
  const propose = passWith((env) => { proposes("staged")(env); before = snapshot(); });
  const e = Engine.open(s, improveDeps(), { runners: { ...improveRunners(1, "staged"), propose } });
  e.start(human);
  await e.advance();
  expect(ofType(s, "probe.finished").map((x) => x.payload.probe)).toEqual(["base/T1", "K1/T1"]);
  expect(snapshot()).toEqual(before!);
  // the candidate's version is still not in this workbench's registry
  expect(typeof composed.deps.loops!.atHash(TARGET, s.state.improve.candidates.K1!.loop_hash!)).toBe("string");
});

test("a candidate whose staging folder is gone is staged again from its bundle, and gives the recorded hash", async () => {
  const s = improveCase(1);
  // the staging folder is removed after Propose staged K1 (a restart that swept it)
  const propose = passWith((env) => { proposes("staged")(env); host.clear({ case: env.session.id }); });
  const e = Engine.open(s, improveDeps(), { runners: { ...improveRunners(1, "staged"), propose } });
  e.start(human);
  await e.advance();
  expect(s.state.run.pause_reason).toBe(STOP_AFTER_PROBE);
  const k1 = ofType(s, "probe.started").find((x) => x.payload.candidate === "K1")!.payload;
  expect(boundHash(child(k1.child))).toBe(s.state.improve.candidates.K1!.loop_hash);
});

test("Probe stalls without the host, without this run's selection, at the depth cap, and when the budget does not cover the children", async () => {
  const noHost = improveCase(1);
  const e1 = Engine.open(noHost, { ...composed.deps }, { runners: improveRunners(1, "none") });
  e1.start(human);
  await e1.advance();
  expect(noHost.state.run.pause_reason).toBe(NO_IMPROVE_HOST);
  expect(probeStage(noHost).status).not.toBe("passed");
  const noSelection = improveCase(1);
  const e2 = Engine.open(noSelection, improveDeps(), { runners: { ...improveRunners(1, "none"), select: passWith(null) } });
  e2.start(human);
  await e2.advance();
  expect(noSelection.state.run.pause_reason).toBe("Probe: this run has selected no tasks");
  expect(probeStage(noSelection).status).not.toBe("passed");
  const { s: poor } = await runImprove({ tasks: 2, candidate: "none", deps: { config: { ...config, improve: { ...config.improve, probe_lookups: 1 } } } });
  expect(poor.state.run.pause_reason).toBe("the probe budget of 1 lookups does not cover 2 children");
  expect(ofType(poor, "probe.started")).toHaveLength(0);
  const { s: deep } = await runImprove({ tasks: 1, candidate: "none", deps: { config: { ...config, loops: { ...config.loops, max_depth: 0 } } } });
  expect(deep.state.run.pause_reason).toBe("sub-loop depth cap of 0 reached");
  expect(host.created).toHaveLength(0);
});
