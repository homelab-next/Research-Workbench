// Slice 14, Task 8: the engine runs an improve loop to its adopt gate and binds a probe child's staged version.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import { BlobStore } from "../../src/core/blobs";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import type { CaseSession } from "../../src/core/session";
import type { Actor, EntryInput } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import type { ChildLink } from "../../src/core/workbench";
import { loadConfig, rootsOf } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { loadRegistry } from "../../src/modules/registry-record";
import { Engine, NOT_IN_WORKBENCH, RunRefused } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnv, StageRunner } from "../../src/pipeline/engine";
import type { ImproveHost, ProbeRef } from "../../src/pipeline/improve/host";
import { IMPROVE_RUNNERS } from "../../src/pipeline/improve/runners";
import { loadLoops } from "../../src/pipeline/loops";
import type { ResolvedLoop } from "../../src/pipeline/loops";
import { IMPROVE_ROLES } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { sampleRoot } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
const ENGINE: Actor = { kind: "system", id: "engine" };
const agentOf = (stage: string): Actor => ({ kind: "agent", id: stage, stage, profile: "investigation", model: "sample-device", effort: null, where: "machine" });

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let config: Config;
let wb: Workbench;
let composed: ReturnType<typeof compose>;
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
/** The improve loop's profile: an entry for each stage that runs an agent. */
const IMPROVE_PROFILE = {
  kind: "profile", id: "improve-test", title: "Improve (test)", rules: "base-rules", framework: "intel-cycle", standard: "icd203",
  stages: Object.fromEntries(["propose", "compose", "reflect"].map((id) => [id, { agent: "analyst", persona: "analyst", goal: `The ${id} stage of the test.` }])),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-improve-"));
  sample = sampleRoot(dir);
  writeFileSync(join(sample.root, "loops", "improve.yaml"), JSON.stringify(improveLoop(), null, 2));
  writeFileSync(join(sample.root, "context", "improve-test-profile.yaml"), JSON.stringify(IMPROVE_PROFILE, null, 2));
  const base = loadConfig({ env: {}, home: dir, repoRoot: dir });
  config = {
    ...base, data_dir: join(dir, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 },
    loops: { ...base.loops, store: join(dir, "wb", "loops"), imports: join(dir, "wb", "imported") },
  };
  wb = Workbench.open(config.data_dir, { onError: () => {} });
  composed = compose(config, wb);
  sessions.length = 0;
});
afterEach(() => {
  for (const s of sessions) if (s.open) expect(s.state.skipped).toEqual([]);
  try { composed.close(); } catch { /* closed */ }
  try { wb.close(); } catch { /* closed */ }
  sample.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = { title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: null, marking: "TLP:GREEN" as const };
const originOf = (s: CaseSession): string => s.entries(0, 1)[0]!.hash;

/** An improve case: made for the loop improve, with improve.requested by the person as the third entry of its ledger. */
function improveCase(): CaseSession {
  const s = wb.createCase(input, human, { loop: "improve" });
  sessions.push(s);
  s.commit(() => [{ type: "improve.requested", actor: human, payload: { target: "investigation", case_type: "unknown-device", tasks: 1, candidates: 1 } }]);
  expect(s.state.improve.request).not.toBeNull();
  return s;
}
/** A probe child of `parent` for loop investigation, marked as the probe `candidate`/T1. */
function probeChild(parent: CaseSession, candidate = "K1"): CaseSession {
  const link: ChildLink = { parent: parent.id, run: "run-1", stage: "probe", attempt: 1, loop: "investigation", input_hash: "0b".repeat(32), depth: 1, floor: "TLP:GREEN" };
  const s = wb.createCase(input, ENGINE, { loop: "investigation", link });
  sessions.push(s);
  s.commit(() => [{
    type: "probe.child", actor: ENGINE,
    payload: { improve: parent.id, origin: originOf(parent), probe: `${candidate}/T1`, candidate, task: "T1", plan_gate: "accept", max_lookups: 10 },
  }]);
  expect(s.state.improve.probe_of).not.toBeNull();
  return s;
}

/** A host that records what the engine asks of it; `staged` the staging store it gives. */
function fakeHost(calls: string[], opts: { staged?: BlobStore; endThrows?: boolean } = {}): ImproveHost {
  const no = (what: string) => (): never => { throw new Error(`the engine does not call ${what}`); };
  return {
    tasks: no("tasks"), task: no("task"), stage: no("stage"), check: no("check"),
    staged: (i) => {
      calls.push(`staged:${i.case}:${i.origin}`);
      if (opts.staged === undefined) throw new Error("no staging store");
      return opts.staged;
    },
    clear: (i) => { calls.push(`clear:${i.case}:${i.origin}`); },
    probes: {
      find: no("probes.find"), create: no("probes.create"), drive: no("probes.drive"), read: no("probes.read"),
      end: (ref: ProbeRef, reason: string) => {
        calls.push(`end:${ref.id}:${ref.probe}:${ref.run}:${ref.stage}:${ref.attempt}:${ref.input_hash}:${ref.origin}:${reason}`);
        if (opts.endThrows === true) throw new Error("the child is gone");
      },
    },
  };
}

type Action = (env: StageEnv) => void;
const commitIn = (env: StageEnv, entries: (s: CaseSession, next: (kind: "change") => string) => EntryInput[]): void => {
  env.session.commit((st, ids) => entries(env.session, (kind) => ids.next(kind)).map((e) => ({ ...e, run: st.run.id, stage: env.stage.id })));
};
const put = (s: CaseSession, x: Json) => s.blobs.put(canonical(x));
/** Select's record: the selection, and (with `task`) one task. */
const selects = (task: boolean): Action => (env) => commitIn(env, (s) => [
  {
    type: "improve.selected", actor: ENGINE,
    payload: { target: "investigation", version: 1, loop_hash: composed.deps.loops!.current("investigation")!.pipeline.hash, lock: put(s, { lock: 1 }), case_type: "unknown-device", scale: ["unlikely", "likely"], left_out: [] },
  },
  ...(task ? [{
    type: "improve.task", actor: ENGINE,
    payload: {
      task: "T1", case: "CASE-90", origin: "f".repeat(64), head: { seq: 9, hash: "9".repeat(64) }, product: { n: 1, draft_hash: "d".repeat(64) }, answer: { seq: 8, hash: "8".repeat(64) },
      marking: "TLP:GREEN", inputs: put(s, { inputs: 1 }), record: put(s, { record: 1 }),
    },
  } as EntryInput] : []),
]);
/** Propose's change chg-1 (two skill files) and its candidate K1, staged. */
const proposes: Action = (env) => commitIn(env, (s, next) => [
  {
    type: "builder.proposed", actor: agentOf("propose"),
    payload: {
      change: next("change"), title: "Clearer research", why: "fewer misses", root: "sample",
      files: [{ path: "skills/a.md", kind: "skill", id: "a", before: "4".repeat(64), after: "5".repeat(64) }, { path: "skills/b.md", kind: "skill", id: "b", before: "6".repeat(64), after: "7".repeat(64) }],
      bundle: put(s, { bundle: 1 }),
    },
  },
  { type: "improve.candidate", actor: ENGINE, payload: { candidate: "K1", change: "chg-1", status: "staged", loop_hash: "a1".repeat(32), lock: put(s, { staged: 1 }), reason: "" } },
]);
const PROBE_ORIGIN = "0a".repeat(32);
const probesBase: Action = (env) => commitIn(env, () => [{
  type: "probe.started", actor: ENGINE,
  payload: { probe: "base/T1", candidate: "base", task: "T1", child: "CASE-77", origin: PROBE_ORIGIN, loop_hash: "e".repeat(64), input_hash: "0b".repeat(32), budgets: { lookups: 60, tokens: 300000 } },
}]);
const choosesK1: Action = (env) => commitIn(env, (s) => [{ type: "compose.chosen", actor: agentOf("compose"), payload: { candidate: "K1", why: "fewer misses", contrasts: put(s, { contrasts: 1 }) } }]);

/** A runner for each improve role that records its call and passes, after its action; `stall` stalls that role instead. */
function runnersOf(calls: string[], actions: Partial<Record<string, Action>> = {}, stall: string | null = null): Partial<Record<Role, StageRunner>> {
  const out: Partial<Record<Role, StageRunner>> = {};
  for (const role of IMPROVE_ROLES) {
    out[role] = async (env) => {
      calls.push(`${env.stage.id}:${env.stage.role}:${env.attempt}`);
      actions[role]?.(env);
      if (role === stall) return { kind: "stalled", reason: `${role} stalled in the test` };
      return { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
    };
  }
  return out;
}
const depsWith = (host: ImproveHost | undefined, over: Partial<EngineDeps> = {}): EngineDeps => ({ ...composed.deps, ...(host === undefined ? {} : { improve: host }), ...over });

/** The staged version of loop investigation: the persona edited, its bytes only in `store`; the root is put back. */
function stagedLoop(store: BlobStore): ResolvedLoop {
  const p = join(sample.root, "context", "personas", "researcher.md");
  const text = readFileSync(p, "utf8");
  writeFileSync(p, text.replace("You are the researcher.", "You are the staged researcher."));
  try {
    const roots = rootsOf(config);
    const registry = loadRegistry(roots, { content: store });
    const loops = loadLoops(registry, { registry, content: store, chain: wb.chain, trusted: roots.filter((r) => r.trusted).map((r) => r.path), output: () => null }, { max_depth: config.loops.max_depth, max_children: config.loops.max_children });
    const loop = loops.current("investigation");
    if (loop === null) throw new Error(loops.problems("investigation").join(" | "));
    return loop;
  } finally {
    writeFileSync(p, text);
  }
}

// ---- the seven stages and the adopt gate

test("an improve run starts each of the seven stages in order with the runner of its role", async () => {
  const s = improveCase();
  const calls: string[] = [];
  const engine = Engine.open(s, depsWith(fakeHost([])), { runners: runnersOf(calls) });
  expect(engine.unusable).toBeNull();
  engine.start(human);
  const summary = await engine.advance();
  expect(calls).toEqual(IMPROVE_ROLES.map((r) => `${r}:${r}:1`));
  expect(s.entries().filter((e) => e.type === "stage.started").map((e) => (e.type === "stage.started" ? e.payload.stage : ""))).toEqual([...IMPROVE_ROLES]);
  expect(summary).toMatchObject({ status: "finished", outcome: "completed" });
  // the engine's own runners for the seven roles are IMPROVE_RUNNERS
  expect(Object.keys(IMPROVE_RUNNERS).sort()).toEqual([...IMPROVE_ROLES].sort());
});

test("with a chosen candidate that has an undecided file, the run waits at the adopt gate after Adopt passes", async () => {
  const s = improveCase();
  const engine = Engine.open(s, depsWith(fakeHost([])), { runners: runnersOf([], { select: selects(false), propose: proposes, compose: choosesK1 }) });
  engine.start(human);
  await engine.advance();
  expect(engine.summary()).toMatchObject({ status: "waiting", waiting: "adopt" });
  expect(s.state.improve.chosen?.candidate).toBe("K1");
  expect(s.state.run.stages.find((x) => x.id === "adopt")!.status).toBe("waiting");
  expect(s.entries().filter((e) => e.type === "gate.waiting").map((e) => (e.type === "gate.waiting" ? e.payload.gate : ""))).toEqual(["adopt"]);
  // a second drive waits on: nothing more is written
  const n = s.entries().length;
  expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "adopt" });
  expect(s.entries().length).toBe(n);
});

test("with nothing chosen there is no adopt gate: the run finishes completed", async () => {
  const s = improveCase();
  const engine = Engine.open(s, depsWith(fakeHost([])), { runners: runnersOf([], { select: selects(false), propose: proposes }) });
  engine.start(human);
  expect(await engine.advance()).toMatchObject({ status: "finished", outcome: "completed", waiting: null });
  expect(s.entries().some((e) => e.type === "gate.waiting")).toBe(false);
});

test("gate.passed adopt by a person takes the run on to its end, completed", async () => {
  const s = improveCase();
  const calls: string[] = [];
  const engine = Engine.open(s, depsWith(fakeHost(calls)), { runners: runnersOf([], { select: selects(false), propose: proposes, compose: choosesK1 }) });
  engine.start(human);
  expect(await engine.advance()).toMatchObject({ waiting: "adopt" });
  s.commit((st) => [
    { type: "builder.decided", actor: human, payload: { change: "chg-1", file: 0, accepted: false, written: null }, run: st.run.id },
    { type: "builder.decided", actor: human, payload: { change: "chg-1", file: 1, accepted: false, written: null }, run: st.run.id },
    { type: "gate.passed", actor: human, payload: { gate: "adopt" }, run: st.run.id },
  ]);
  expect(await engine.advance()).toMatchObject({ status: "finished", outcome: "completed" });
  // the run's end clears the staging store (no probe was started)
  expect(calls).toEqual([`clear:${s.id}:${originOf(s)}`]);
});

// ---- a probe child's staged version

test("a probe child's engine, made after a restart, rebuilds its staged version from its own lock and the staging store", () => {
  const parent = improveCase();
  const child = probeChild(parent);
  const store = new BlobStore(join(dir, "staged", "blobs"));
  const staged = stagedLoop(store);
  const live = composed.deps.loops!.current("investigation")!;
  expect(staged.pipeline.hash).not.toBe(live.pipeline.hash);
  // the live catalogue cannot rebuild it: its persona's bytes are only in the staging store
  expect(typeof composed.deps.loops!.fromLock(staged.lock)).toBe("string");
  const calls: string[] = [];
  const first = new Engine(child, depsWith(fakeHost(calls, { staged: store })));
  first.start(ENGINE, { loop: staged });
  first.close();
  const again = new Engine(child, depsWith(fakeHost(calls, { staged: store })));
  expect(again.unusable).toBeNull();
  expect(again.loop!.pipeline.hash).toBe(staged.pipeline.hash);
  expect(again.bound.components!.get("research", "persona", "researcher")!.text).toContain("You are the staged researcher.");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c === `staged:${parent.id}:${originOf(parent)}`)).toBe(true);
  again.close();
});

test("without the staging store that child's engine says its version is not in this workbench, and its run pauses on a drive", async () => {
  const parent = improveCase();
  const child = probeChild(parent);
  const store = new BlobStore(join(dir, "staged", "blobs"));
  const staged = stagedLoop(store);
  const first = new Engine(child, depsWith(fakeHost([], { staged: store })));
  first.start(ENGINE, { loop: staged });
  first.close();
  const lost = new Engine(child, depsWith(undefined));
  expect(lost.unusable).toBe(NOT_IN_WORKBENCH);
  expect(await lost.advance()).toMatchObject({ status: "paused", pause_reason: NOT_IN_WORKBENCH });
  expect(child.entries().some((e) => e.type === "stage.started")).toBe(false);
  // a host whose staging store cannot be made is the same
  const broken = new Engine(child, depsWith(fakeHost([])));
  expect(broken.unusable).toBe(NOT_IN_WORKBENCH);
});

test("an engine of a case that is no probe child never asks for a staging store", async () => {
  const calls: string[] = [];
  const host = fakeHost(calls, { staged: new BlobStore(join(dir, "staged", "blobs")) });
  const plain = wb.createCase({ ...input, objective: "sample-objective" }, human, { loop: "investigation" });
  sessions.push(plain);
  const e1 = Engine.open(plain, depsWith(host));
  e1.start(human);
  const e2 = new Engine(plain, depsWith(host));
  expect(e2.unusable).toBeNull();
  expect(e2.loop!.pipeline.hash).toBe(composed.deps.loops!.current("investigation")!.pipeline.hash);
  // the improve case itself is no probe child
  const imp = improveCase();
  const e3 = Engine.open(imp, depsWith(host), { runners: runnersOf([], {}, "select") });
  e3.start(human);
  await e3.advance();
  expect(new Engine(imp, depsWith(host)).unusable).toBeNull();
  expect(calls.filter((c) => c.startsWith("staged:"))).toEqual([]);
  for (const e of [e1, e2, e3]) e.close();
});

// ---- resumeProbe and endProbe

test("resumeProbe writes run.resumed by improve-probe for an interrupted probe child, once; endProbe ends its run as stopped with the reason", () => {
  const parent = improveCase();
  const child = probeChild(parent, "base");
  const anchors: { case: string; why: string }[] = [];
  const engine = new Engine(child, depsWith(fakeHost([]), { anchor: (a) => anchors.push({ case: a.case, why: a.why }) }));
  engine.start(ENGINE);
  // not interrupted: nothing to resume
  expect(engine.resumeProbe()).toBe(false);
  child.commit((s) => [{ type: "run.interrupted", actor: { kind: "system", id: "recovery" }, payload: {}, run: s.run.id }]);
  expect(child.state.run.status).toBe("interrupted");
  const n = child.entries().length;
  expect(engine.resumeProbe()).toBe(true);
  const resumed = child.entries().at(-1)!;
  expect(resumed.type).toBe("run.resumed");
  expect(resumed.actor).toEqual({ kind: "system", id: "improve-probe" });
  expect(child.state.run.status).toBe("running");
  expect(engine.resumeProbe()).toBe(false);
  expect(child.entries().length).toBe(n + 1);
  engine.endProbe("its output was read");
  const end = child.entries().at(-1)!;
  expect(end.type === "run.finished" && end.payload).toEqual({ outcome: "stopped", reason: "its output was read" });
  expect(end.actor).toEqual({ kind: "system", id: "improve-probe" });
  expect(child.state.run.outcome).toBe("stopped");
  expect(anchors).toEqual([{ case: child.id, why: "closed" }]);
  // with no run in progress, endProbe writes nothing
  const m = child.entries().length;
  engine.endProbe("again");
  expect(child.entries().length).toBe(m);
  engine.close();
});

test("resumeProbe and endProbe throw in a case that is no probe child and write nothing", () => {
  const plain = wb.createCase({ ...input, objective: "sample-objective" }, human, { loop: "investigation" });
  sessions.push(plain);
  const engine = Engine.open(plain, depsWith(fakeHost([])));
  engine.start(human);
  plain.commit((s) => [{ type: "run.interrupted", actor: { kind: "system", id: "recovery" }, payload: {}, run: s.run.id }]);
  const n = plain.entries().length;
  expect(() => engine.resumeProbe()).toThrow(RunRefused);
  expect(() => engine.endProbe("no")).toThrow(RunRefused);
  // nor in an improve case
  const imp = improveCase();
  const e2 = new Engine(imp, depsWith(fakeHost([])));
  expect(() => e2.resumeProbe()).toThrow(RunRefused);
  expect(() => e2.endProbe("no")).toThrow(RunRefused);
  expect(plain.entries().length).toBe(n);
  expect(plain.state.run.status).toBe("interrupted");
  engine.close();
});

// ---- the end of an improve run

test("when an improve case's run ends, finished or stopped by a person, the host is asked to end its unfinished probe children and then to clear its staging store", async () => {
  const expected = (s: CaseSession): string[] => [
    `end:CASE-77:base/T1:${s.state.run.id}:probe:1:${"0b".repeat(32)}:${PROBE_ORIGIN}:its improve run ended`,
    `clear:${s.id}:${originOf(s)}`,
  ];
  // finished: Probe started base/T1 and did not finish it; nothing was chosen
  const done = improveCase();
  const doneCalls: string[] = [];
  const e1 = Engine.open(done, depsWith(fakeHost(doneCalls)), { runners: runnersOf([], { select: selects(true), propose: proposes, probe: probesBase }) });
  e1.start(human);
  expect(await e1.advance()).toMatchObject({ status: "finished", outcome: "completed" });
  expect(doneCalls).toEqual(expected(done));

  // stopped by a person while Probe is stalled; a host that fails to end a child is reported, and the store is cleared all the same
  const stopped = improveCase();
  const stopCalls: string[] = [];
  const errors: unknown[] = [];
  const e2 = Engine.open(stopped, depsWith(fakeHost(stopCalls, { endThrows: true }), { onError: (e) => errors.push(e) }), {
    runners: runnersOf([], { select: selects(true), propose: proposes, probe: probesBase }, "probe"),
  });
  e2.start(human);
  expect(await e2.advance()).toMatchObject({ status: "paused" });
  expect(stopCalls).toEqual([]);
  e2.stop(human, "enough");
  expect(stopCalls).toEqual(expected(stopped));
  expect(errors.map((e) => (e instanceof Error ? e.message : String(e)))).toEqual(["the child is gone"]);

  // a case that is no improve case asks nothing of the host when its run ends
  const plainCalls: string[] = [];
  const plain = wb.createCase({ ...input, objective: "sample-objective" }, human, { loop: "investigation" });
  sessions.push(plain);
  const e3 = Engine.open(plain, depsWith(fakeHost(plainCalls)));
  e3.start(human);
  e3.stop(human, "not needed");
  expect(plainCalls).toEqual([]);
  for (const e of [e1, e2, e3]) e.close();
});

test("every improve role has its own runner: none answers with the not-built stub", async () => {
  const s = improveCase();
  const engine = Engine.open(s, depsWith(fakeHost([])));
  engine.start(human);
  // with a host that cannot give tasks the run stops at Select with the failure's sentence, not a stub's
  expect(await engine.advance()).toMatchObject({ status: "paused", current: "select", pause_reason: "Select failed unexpectedly: the engine does not call tasks" });
  // each role's behaviour is held by its own test file (improve-select/propose/probe/compose/judge/reflect); here: no role is still the stub
  for (const role of IMPROVE_ROLES) {
    let end: unknown = null;
    try { end = await IMPROVE_RUNNERS[role]({} as StageEnv); } catch { end = "threw"; }
    expect(end).not.toEqual({ kind: "stalled", reason: `${TITLES[role]} is not built yet` });
  }
  engine.close();
});
