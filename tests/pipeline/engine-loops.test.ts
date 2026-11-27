import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import type { CaseSession } from "../../src/core/session";
import { fold } from "../../src/core/state";
import type { Actor, Entry } from "../../src/core/types";
import { verifyCase } from "../../src/core/verify";
import { Workbench } from "../../src/core/workbench";
import { loadConfig, rootsOf } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { loadRegistry } from "../../src/modules/registry-record";
import { runQuery } from "../../src/modules/runner";
import { latestOutput } from "../../src/cli/compose";
import { Engine, RunRefused } from "../../src/pipeline/engine";
import type { EngineDeps, StageRunner } from "../../src/pipeline/engine";
import { loadLoops, readLock } from "../../src/pipeline/loops";
import type { LoopCatalog } from "../../src/pipeline/loops";
import { loadPipeline } from "../../src/pipeline/manifests";
import { sampleRoot } from "../helpers/sample-root";

/** The sample's pipeline hash as the workbench computed it before slice 12. */
const SAMPLE_LEGACY_HASH = "19f7829f3f9c97faf5c149c0eddc4b047471ca3b2119f168abe2cbef93761329";
const CHANGED = "the pipeline has changed since this run started";
const NOT_HERE = "this run's loop version is not in this workbench; import its loop file";
const human: Actor = { kind: "human", id: "analyst" };

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let config: Config;
let wb: Workbench;
let composed: ReturnType<typeof compose>;
const sessions: CaseSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-loops-"));
  sample = sampleRoot(dir);
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

/** What the workbench ran with before slice 12: the pipeline of every stage manifest (id "default", the old formula's hash), and no loops. */
function oldDepsOf(deps: EngineDeps): EngineDeps {
  const { loops: _l, components: _c, content: _b, ...rest } = deps;
  return { ...rest, pipeline: loadPipeline(deps.registry).pipeline! };
}
const input = { title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" as const };
function newCase(opts?: { loop?: string }): CaseSession {
  const s = wb.createCase(input, human, opts);
  sessions.push(s);
  return s;
}
const reasonsOf = (entries: readonly Entry[]): string[] => entries.flatMap((e) => (e.type === "run.paused" ? [e.payload.reason] : []));
const editFile = (rel: string, from: string, to: string): void => {
  const p = join(sample.root, rel);
  const text = readFileSync(p, "utf8");
  if (!text.includes(from)) throw new Error(`${from} not in ${rel}`);
  writeFileSync(p, text.replace(from, to));
};
/** The commits a session makes from now on, as the entry types of each. */
function commitsOf(s: CaseSession): string[][] {
  const calls: string[][] = [];
  const commit = s.commit.bind(s);
  s.commit = ((fn: Parameters<CaseSession["commit"]>[0]) => {
    const written = commit(fn);
    calls.push(written.map((e) => e.type));
    return written;
  }) as CaseSession["commit"];
  return calls;
}
/** A catalogue of the roots as they are now, with nothing replaced on the composed deps. */
function catalogNow(): LoopCatalog {
  const roots = rootsOf(config);
  const registry = loadRegistry(roots, { content: wb.chainBlobs });
  return loadLoops(registry, {
    registry, content: wb.chainBlobs, chain: wb.chain, trusted: roots.filter((r) => r.trusted).map((r) => r.path),
    output: (loop, output) => latestOutput(wb.chain, wb.chainBlobs, loop, output),
  }, { max_depth: config.loops.max_depth, max_children: config.loops.max_children });
}
/** What the latest model request of a stage sent: the messages, as text. */
const sentAt = (s: CaseSession, stage: string): string => {
  const req = s.entries().filter((e) => e.type === "model.request" && e.stage === stage).at(-1);
  if (req === undefined || req.type !== "model.request") throw new Error(`no model request at ${stage}`);
  return s.blobs.text(req.payload.messages.blob);
};
const FIRST_PERSONA = "You are the researcher.";
const EDITED_PERSONA = "You are the edited researcher.";

// ---- Step 1: a run started before slice 12

test("a run started before slice 12 and waiting at its plan gate goes on with a loops-aware engine: no pause, nothing skipped, no loop.bound written", async () => {
  const first = newCase();
  const old = Engine.open(first, oldDepsOf(composed.deps));
  old.start(human);
  expect((await old.advance()).waiting).toBe("plan");
  const started = first.entries().find((e) => e.type === "run.started")!;
  expect(started.type === "run.started" && [started.payload.pipeline, started.payload.pipeline_hash]).toEqual(["default", SAMPLE_LEGACY_HASH]);
  const id = first.id;
  wb.close();
  composed.close();

  wb = Workbench.open(config.data_dir, { onError: () => {} });
  composed = compose(config, wb);
  const again = wb.session(id);
  sessions.push(again);
  const engine = Engine.open(again, composed.deps);
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  const entries = again.entries();
  expect(entries.some((e) => e.type === "run.paused" && /pipeline has changed/.test(e.payload.reason))).toBe(false);
  expect(entries.some((e) => e.type === "loop.bound")).toBe(false);
  expect(again.state.skipped).toEqual([]);
});

test("a run started before slice 12 is given deps without components and is held to the legacy hash of its loop", async () => {
  const first = newCase();
  const old = Engine.open(first, oldDepsOf(composed.deps));
  old.start(human);
  expect((await old.advance()).waiting).toBe("plan");
  const engine = Engine.open(first, composed.deps);
  expect(engine.unusable).toBeNull();
  expect("components" in engine.bound).toBe(false);
  expect(engine.bound.pipeline.legacy_hash).toBe(SAMPLE_LEGACY_HASH);
  expect(engine.bound.pipeline.hash).toBe(composed.deps.loops!.current("investigation")!.pipeline.hash);
  expect(engine.loop!.manifest.id).toBe("investigation");
  // a stage of a legacy run reads its context live from the registry, as before the slice: an edited persona reaches it
  editFile("context/personas/researcher.md", FIRST_PERSONA, EDITED_PERSONA);
  composed.reload();
  const after = Engine.open(first, composed.deps);
  expect("components" in after.bound).toBe(false);
  after.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await after.advance()).toMatchObject({ waiting: "publish" });
  expect(sentAt(first, "research")).toContain(EDITED_PERSONA);
  expect(reasonsOf(first.entries())).toEqual([]);
});

test("that old run still pauses with today's sentence when a stage manifest changed since it started", async () => {
  const first = newCase();
  const old = Engine.open(first, oldDepsOf(composed.deps));
  old.start(human);
  expect((await old.advance()).waiting).toBe("plan");
  editFile("stages/research.yaml", "title: Research", "title: Research again");
  composed.reload();
  const engine = Engine.open(first, composed.deps);
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await engine.advance()).toMatchObject({ status: "paused", pause_reason: CHANGED });
  expect(first.entries().some((e) => e.type === "loop.bound")).toBe(false);
  expect(first.state.skipped).toEqual([]);
});

test("the old run's ledger folds to the same state at every entry before and after the engine reopened it", async () => {
  const first = newCase();
  const old = Engine.open(first, oldDepsOf(composed.deps));
  old.start(human);
  expect((await old.advance()).waiting).toBe("plan");
  const before = first.entries();
  const id = first.id;
  wb.close();
  composed.close();
  wb = Workbench.open(config.data_dir, { onError: () => {} });
  composed = compose(config, wb);
  const again = wb.session(id);
  sessions.push(again);
  const engine = Engine.open(again, composed.deps);
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  await engine.advance();
  const entries = again.entries();
  expect(entries.slice(0, before.length)).toEqual(before);
  for (let n = 1; n <= entries.length; n++) {
    const at = fold(entries, n);
    if (n <= before.length) expect(at).toEqual(fold(before, n));
    expect(at.skipped).toEqual([]);
  }
  expect(verifyCase(again.dir).ok).toBe(true);
});

// ---- Step 5: a bound run

test("start writes loop.bound and run.started in one commit: the loop id, its version, the version-2 hash, and a lock blob of this case that reads back as the lock", () => {
  const s = newCase();
  const engine = Engine.open(s, composed.deps);
  const commits = commitsOf(s);
  engine.start(human);
  expect(commits).toEqual([["loop.bound", "run.started"]]);
  const loop = composed.deps.loops!.current("investigation")!;
  const bound = s.entries().find((e) => e.type === "loop.bound")!;
  const started = s.entries().find((e) => e.type === "run.started")!;
  if (bound.type !== "loop.bound" || started.type !== "run.started") throw new Error("no start");
  expect(bound.payload).toMatchObject({ loop: "investigation", version: 1, hash: loop.pipeline.hash });
  expect(bound.payload.hash).not.toBe(SAMPLE_LEGACY_HASH);
  expect(bound.actor).toEqual(human);
  expect(started.seq).toBe(bound.seq + 1);
  expect([started.payload.pipeline, started.payload.pipeline_hash]).toEqual(["investigation", loop.pipeline.hash]);
  expect(readLock(s.blobs.get(bound.payload.lock.blob))).toEqual(loop.lock);
  expect(s.blobs.text(bound.payload.lock.blob)).toBe(canonical(loop.lock as unknown as Json));
  expect(s.state.loop.bound).toMatchObject({ loop: "investigation", hash: loop.pipeline.hash });
  expect(engine.bound.pipeline.hash).toBe(loop.pipeline.hash);
  expect(engine.unusable).toBeNull();
  expect(verifyCase(s.dir).ok).toBe(true);
});

test("start on a case made for a loop that is not usable is refused with the loop's first problem and writes nothing", () => {
  const s = newCase({ loop: "nowhere" });
  const engine = Engine.open(s, composed.deps);
  const before = s.entries().length;
  expect(() => engine.start(human)).toThrow(RunRefused);
  expect(() => engine.start(human)).toThrow('there is no loop "nowhere"');
  expect(s.entries().length).toBe(before);
  expect(engine.unusable).toBe('there is no loop "nowhere"');
});

test("a persona and a stage manifest edited after start do not reach the run: it never pauses for a changed pipeline, and the next model request's pack holds the first persona", async () => {
  const s = newCase();
  const first = composed.deps.registry.get("persona", "researcher")!.hash;
  const engine = Engine.open(s, composed.deps);
  engine.start(human);
  expect((await engine.advance()).waiting).toBe("plan");
  editFile("context/personas/researcher.md", FIRST_PERSONA, EDITED_PERSONA);
  editFile("stages/research.yaml", "title: Research", "title: Research again");
  // compose again on the same workbench: a new catalogue, and a new engine on the same session
  composed.close();
  composed = compose(config, wb);
  expect(composed.deps.registry.get("persona", "researcher")!.hash).not.toBe(first);
  const again = Engine.open(s, composed.deps);
  again.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await again.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(reasonsOf(s.entries())).toEqual([]);
  expect(sentAt(s, "research")).toContain(FIRST_PERSONA);
  expect(sentAt(s, "research")).not.toContain(EDITED_PERSONA);
  expect(s.state.run.stages.find((x) => x.id === "research")!.title).toBe("Research");
});

test("a registry reload while a run works changes nothing for it: the same engine goes on with the deps it bound, and new runs use the new registry", async () => {
  const s = newCase();
  const engine = Engine.open(s, composed.deps);
  engine.start(human);
  expect((await engine.advance()).waiting).toBe("plan");
  const was = engine.bound;
  editFile("context/personas/researcher.md", FIRST_PERSONA, EDITED_PERSONA);
  editFile("stages/research.yaml", "title: Research", "title: Research again");
  expect(composed.reload()).toEqual([]);
  expect(engine.bound).toBe(was);
  expect(engine.bound.registry).not.toBe(composed.deps.registry);
  expect(engine.bound.runner).not.toBe(composed.deps.runner);
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(reasonsOf(s.entries())).toEqual([]);
  expect(sentAt(s, "research")).toContain(FIRST_PERSONA);
  expect(sentAt(s, "research")).not.toContain(EDITED_PERSONA);

  const next = newCase();
  Engine.open(next, composed.deps).start(human);
  const bound = next.entries().find((e) => e.type === "loop.bound")!;
  expect(bound.type === "loop.bound" && bound.payload.hash).toBe(composed.deps.pipeline.hash);
  expect(composed.deps.pipeline.hash).not.toBe(was.pipeline.hash);
});

test("the next run of that case binds the new version", async () => {
  const s = newCase();
  const engine = Engine.open(s, composed.deps);
  engine.start(human);
  expect((await engine.advance()).waiting).toBe("plan");
  const firstHash = engine.bound.pipeline.hash;
  editFile("context/personas/researcher.md", FIRST_PERSONA, EDITED_PERSONA);
  composed.reload();
  engine.stop(human, "start again on the new version");
  engine.start(human);
  const bounds = s.entries().filter((e) => e.type === "loop.bound").map((e) => (e.type === "loop.bound" ? e.payload.hash : ""));
  expect(bounds).toEqual([firstHash, composed.deps.pipeline.hash]);
  expect(bounds[0]).not.toBe(bounds[1]);
  expect(engine.bound.pipeline.hash).toBe(composed.deps.pipeline.hash);
  expect(s.state.loop.bound!.hash).toBe(composed.deps.pipeline.hash);
});

test("a bound run whose lock names a hash the content store does not hold pauses: this run's loop version is not in this workbench; import its loop file", async () => {
  const s = newCase();
  const engine = Engine.open(s, composed.deps);
  engine.start(human);
  expect((await engine.advance()).waiting).toBe("plan");
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  const lock = composed.deps.loops!.current("investigation")!.lock;
  const persona = lock.items.find((i) => i.kind === "persona" && i.id === "researcher")!;
  rmSync(join(config.data_dir, "blobs", persona.hash));
  const again = Engine.open(s, composed.deps);
  expect(again.unusable).toBe(NOT_HERE);
  expect(await again.advance()).toMatchObject({ status: "paused", pause_reason: NOT_HERE });
  expect(s.entries().some((e) => e.type === "stage.started" && e.payload.stage === "research")).toBe(false);
  expect(s.state.skipped).toEqual([]);
});

test("Engine.bound on a case with no run is the current version of its loop, and of the default loop for a case that names none", () => {
  const plain = newCase();
  const e1 = new Engine(plain, composed.deps);
  expect(e1.bound.pipeline.hash).toBe(composed.deps.loops!.current("investigation")!.pipeline.hash);
  expect(e1.loop!.manifest.id).toBe("investigation");
  expect(e1.unusable).toBeNull();
  // a second loop in the root: the investigation loop under another id
  mkdirSync(join(sample.root, "loops"), { recursive: true });
  writeFileSync(join(sample.root, "loops", "second.yaml"), readFileSync(join(sample.root, "loops", "investigation.yaml"), "utf8").replace("id: investigation", "id: second"));
  composed.reload();
  const other = newCase({ loop: "second" });
  const e2 = new Engine(other, composed.deps);
  expect(e2.loop!.manifest.id).toBe("second");
  expect(e2.bound.pipeline.id).toBe("second");
  expect(e2.bound.pipeline.hash).toBe(composed.deps.loops!.current("second")!.pipeline.hash);
  expect(e2.bound.components).toBe(composed.deps.loops!.current("second")!.components);
  // deps without loops: the engine is what it was
  const old = oldDepsOf(composed.deps);
  const e3 = new Engine(plain, old);
  expect(e3.loop).toBeNull();
  expect(e3.unusable).toBeNull();
  expect(e3.bound.pipeline).toBe(old.pipeline);
});

// ---- guardrails fail closed (controller ruling)

test("a loop whose checks stage names a check that cannot load is not usable: compose and reload refuse it, start refuses naming the check, and writes nothing", () => {
  editFile("checks/01-schema.yaml", "script:", "scripted:");
  // reload does not throw (controller ruling): it marks the default loop unusable, naming the check
  expect(composed.reload().join(" | ")).toMatch(/the default loop "investigation" is not usable: .*check "?schema/);
  expect(composed.deps.pipeline.stages).toEqual([]);
  const loops = catalogNow();
  expect(loops.current("investigation")).toBeNull();
  const problems = loops.problems("investigation").join(" | ");
  expect(problems).toContain("schema");
  const s = newCase();
  const engine = Engine.open(s, { ...composed.deps, loops });
  const before = s.entries().length;
  expect(() => engine.start(human)).toThrow(RunRefused);
  expect(() => engine.start(human)).toThrow(/check "?schema/);
  expect(s.entries().length).toBe(before);
});

test("an old run whose loop now names a check that cannot load pauses naming the check, and Checks never runs", async () => {
  const s = newCase();
  const old = Engine.open(s, oldDepsOf(composed.deps));
  old.start(human);
  expect((await old.advance()).waiting).toBe("plan");
  editFile("checks/01-schema.yaml", "script:", "scripted:");
  const engine = Engine.open(s, { ...composed.deps, loops: catalogNow() });
  expect(engine.unusable).toMatch(/check "?schema/);
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  const summary = await engine.advance();
  expect(summary.status).toBe("paused");
  expect(summary.pause_reason).toMatch(/check "?schema/);
  expect(s.entries().some((e) => e.type === "check.run")).toBe(false);
});

test("a bound run whose lock names a check script the content store does not hold pauses before anything runs, and Checks never runs with fewer checks", async () => {
  const s = newCase();
  const engine = Engine.open(s, composed.deps);
  engine.start(human);
  expect((await engine.advance()).waiting).toBe("plan");
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  const lock = composed.deps.loops!.current("investigation")!.lock;
  const script = lock.items.find((i) => i.kind === "check-script")!;
  rmSync(join(config.data_dir, "blobs", script.hash));
  const again = Engine.open(s, composed.deps);
  expect(await again.advance()).toMatchObject({ status: "paused", pause_reason: NOT_HERE });
  expect(s.entries().some((e) => e.type === "check.run")).toBe(false);
});

// ---- the old connector pool stays open while a run bound to it holds it

test("a sql query in flight across a reload completes: the old pool stays open while a run bound to it holds it, and is closed when the last such run ends", async () => {
  const oldPool = composed.deps.runner.pool;
  let closed = 0;
  const closeAll = oldPool.closeAll.bind(oldPool);
  oldPool.closeAll = () => { closed++; closeAll(); };
  const a = newCase();
  const b = newCase();
  const ea = Engine.open(a, composed.deps);
  const eb = Engine.open(b, composed.deps);
  ea.start(human);
  eb.start(human);
  const runner = ea.bound.runner;
  expect(runner.pool).toBe(oldPool);
  // the reload comes while the sql connector's query process is working: once its run has begun, on the next turn of the event loop
  const connector = oldPool.for(composed.deps.registry.source("flows")!);
  const run = connector.run.bind(connector);
  let reloaded: Promise<void> | null = null;
  connector.run = (req) => {
    const out = run(req);
    reloaded = new Promise<void>((done) => { setTimeout(() => { composed.reload(); done(); }, 0); });
    return out;
  };
  const r = await runQuery(a, runner, { source: "flows", text: "select dst from flows where src = {value}", bound: { value: "192.0.2.17" }, window: { from: null, to: null }, why: "in flight across a reload", actor: human });
  expect(reloaded).not.toBeNull();
  await reloaded;
  expect(composed.deps.runner.pool).not.toBe(oldPool);
  expect(closed).toBe(0);
  expect(r.status).toBe("done");
  ea.stop(human, "done with it");
  expect(closed).toBe(0);
  eb.stop(human, "done with it too");
  expect(closed).toBe(1);
  // nothing holds the new pool: the next reload closes it at once
  const second = composed.deps.runner.pool;
  let closedSecond = 0;
  const closeSecond = second.closeAll.bind(second);
  second.closeAll = () => { closedSecond++; closeSecond(); };
  composed.reload();
  expect(closedSecond).toBe(1);
});

// ---- Step 9: loops without both gates

/** A loop of one inline frame stage: no plan gate and no publish gate. */
function writeShortLoop(): void {
  mkdirSync(join(sample.root, "loops"), { recursive: true });
  writeFileSync(join(sample.root, "loops", "short.yaml"), JSON.stringify({
    kind: "loop", id: "short", title: "Short", version: 1, profile: "investigation", entry: "frame",
    stages: [{ id: "frame", title: "Frame", order: 1, runs: "agent", role: "frame", tools: [], schema: "frame-output", model: { provider: "scripted", model: "sample-run", effort: null }, on_pass: null, on_fail: null }],
    outputs: { findings: { from: "findings" } },
  }));
  composed.reload();
}
const passFrame: StageRunner = async () => ({ kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null });

test("a loop with no publish gate finishes as completed when its last stage passes, and is not anchored as closed", async () => {
  writeShortLoop();
  const s = newCase({ loop: "short" });
  const engine = Engine.open(s, composed.deps, { runners: { frame: passFrame } });
  engine.start(human);
  expect(await engine.advance()).toMatchObject({ status: "finished", outcome: "completed" });
  const finished = s.entries().find((e) => e.type === "run.finished")!;
  expect(finished.type === "run.finished" && finished.payload.outcome).toBe("completed");
  expect(wb.chain.read().some((e) => e.type === "case.anchored" && e.payload.case === s.id)).toBe(false);
  expect(s.entries().some((e) => e.type === "gate.waiting")).toBe(false);
});

test("onOutputs is called once for a published run and once for a completed one, never for a stopped one", async () => {
  writeShortLoop();
  const seen: { case: string; loop: string; outcome: string; marking: string; head: { seq: number; hash: string }; outputs: unknown }[] = [];
  const deps: EngineDeps = Object.assign(composed.deps, { onOutputs: (o: (typeof seen)[number]) => { seen.push(o); } });

  const short = newCase({ loop: "short" });
  const es = Engine.open(short, deps, { runners: { frame: passFrame } });
  es.start(human);
  await es.advance();
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ case: short.id, loop: "short", outcome: "completed", marking: "TLP:GREEN", head: short.head(), outputs: {} });

  const stopped = newCase();
  const st = Engine.open(stopped, deps);
  st.start(human);
  await st.advance();
  st.stop(human, "not needed");
  expect(seen).toHaveLength(1);

  const published = newCase();
  const ep = Engine.open(published, deps);
  ep.start(human);
  expect((await ep.advance()).waiting).toBe("plan");
  ep.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect((await ep.advance()).waiting).toBe("publish");
  ep.approve({ actor: human });
  expect((await ep.advance()).outcome).toBe("published");
  expect(seen).toHaveLength(2);
  expect(seen[1]).toMatchObject({ case: published.id, loop: "investigation", outcome: "published", head: published.head(), outputs: {} });
  expect(seen[1]!.head.seq).toBe(published.entries().at(-1)!.seq);
});
