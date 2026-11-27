import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import { cardRefs, fold } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Actor, Card, Entry } from "../../src/core/types";
import type { ChildLink } from "../../src/core/workbench";
import { Workbench } from "../../src/core/workbench";
import { verifyLinks } from "../../src/core/verify";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageRunner } from "../../src/pipeline/engine";
import type { LoopCatalog, ResolvedLoop } from "../../src/pipeline/loops";
import type { StageManifest } from "../../src/pipeline/manifests";
import { outputHash, outputsOf, readChild } from "../../src/pipeline/subloop";
import type { ChildCases, ChildRef } from "../../src/pipeline/subloop";
import { subloopRunner } from "../../src/pipeline/stages/subloop";
import { sampleRoot } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
const ENGINE: Actor = { kind: "system", id: "engine" };
const SCRIPTED = { provider: "scripted", model: "sample-run", effort: null };

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let config: Config;
let wb: Workbench;
let composed: ReturnType<typeof compose>;
let host: Host;
const sessions: CaseSession[] = [];
const engines: Engine[] = [];

/** The test's host: ChildCases over the real workbench, one engine per child, as the hub keeps them. */
class Host implements ChildCases {
  readonly engines = new Map<string, Engine>();
  created = 0;
  afterCreate: (() => void) | null = null;
  constructor(private readonly deps: () => EngineDeps) {}
  engine(id: string): Engine {
    let e = this.engines.get(id);
    if (e === undefined) {
      const s = wb.session(id);
      if (!sessions.includes(s)) sessions.push(s);
      e = Engine.open(s, this.deps());
      engines.push(e);
      this.engines.set(id, e);
    }
    return e;
  }
  find(link: ChildLink): ReturnType<ChildCases["find"]> {
    const id = wb.findChild(link);
    return id === null ? null : { id, origin: wb.loadedOrigin(id)! };
  }
  create(input: Parameters<ChildCases["create"]>[0], link: ChildLink, cards: Card[]): ReturnType<ChildCases["create"]> {
    const s = wb.createCase(input, ENGINE, { loop: link.loop, link, cards });
    sessions.push(s);
    this.created += 1;
    this.afterCreate?.();
    return { id: s.id, origin: s.entries(0, 1)[0]!.hash };
  }
  async drive(ref: ChildRef, opts: { loop: ResolvedLoop }): Promise<ReturnType<Engine["summary"]>> {
    if (this.read(ref) === null) throw new Error(`${ref.id} is not the child`);
    const e = this.engine(ref.id);
    if (wb.session(ref.id).state.run.status === "none") e.start(ENGINE, { loop: opts.loop });
    return e.advance();
  }
  read(ref: ChildRef): ReturnType<ChildCases["read"]> {
    let s: CaseSession;
    try { s = wb.session(ref.id); } catch { return null; }
    return readChild(s, ref);
  }
}

const subloopStage = (over: Record<string, Json> = {}): Record<string, Json> => ({
  id: "investigate", title: "Investigate", order: 2, runs: "loop", role: "subloop", loop: "investigation",
  inputs: { question: "case.question", observables: "case.observables", window: "case.window" },
  returns: { cards: { as: "cards" }, product: { as: "draft_section", section: "assessment" } }, on_pass: null, on_fail: null, ...over,
});
const frameStage = (on_pass: string): Record<string, Json> => ({
  id: "frame", title: "Frame", order: 1, runs: "agent", role: "frame", tools: [], schema: "frame-output", model: SCRIPTED, on_pass, on_fail: null,
});
function writeLoop(id: string, stages: Record<string, Json>[]): void {
  mkdirSync(join(sample.root, "loops"), { recursive: true });
  writeFileSync(join(sample.root, "loops", `${id}.yaml`), JSON.stringify({
    kind: "loop", id, title: id, version: 1, profile: "investigation", entry: "frame", stages, outputs: { findings: { from: "findings" } },
  }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stage-subloop-"));
  sample = sampleRoot(dir);
  const base = loadConfig({ env: {}, home: dir, repoRoot: dir });
  config = {
    ...base, data_dir: join(dir, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 },
    loops: { ...base.loops, store: join(dir, "wb", "loops"), imports: join(dir, "wb", "imported") },
  };
  // the parent loop: Frame, then a stage that runs the investigation loop as a child case
  writeLoop("triage", [frameStage("investigate"), subloopStage()]);
  wb = Workbench.open(config.data_dir, { onError: () => {} });
  composed = compose(config, wb);
  host = new Host(() => ({ ...composed.deps, children: host }));
  sessions.length = 0;
  engines.length = 0;
});
afterEach(() => {
  for (const s of sessions) if (s.open) expect(s.state.skipped).toEqual([]);
  for (const e of engines) e.close();
  try { composed.close(); } catch { /* closed */ }
  try { wb.close(); } catch { /* closed */ }
  sample.close();
  rmSync(dir, { recursive: true, force: true });
});

const passFrame: StageRunner = async () => ({ kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null });
const input = { title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" as const };

/** A parent case of `loop`, its engine (Frame passes without a model), started and advanced to where it stops. */
async function startParent(opts: { loop?: string; deps?: EngineDeps; link?: ChildLink } = {}): Promise<{ s: CaseSession; e: Engine }> {
  const s = wb.createCase(input, human, { loop: opts.loop ?? "triage", ...(opts.link === undefined ? {} : { link: opts.link }) });
  sessions.push(s);
  const e = Engine.open(s, opts.deps ?? { ...composed.deps, children: host }, { runners: { frame: passFrame } });
  engines.push(e);
  e.start(human);
  await e.advance();
  return { s, e };
}
const child = (id = "CASE-2"): CaseSession => wb.session(id);
const childEngine = (id = "CASE-2"): Engine => host.engine(id);
const ofType = <T extends Entry["type"]>(s: CaseSession, type: T): Extract<Entry, { type: T }>[] => s.entries().filter((e): e is Extract<Entry, { type: T }> => e.type === type);
const GATES = new Set(["gate.passed", "plan.accepted", "product.published"]);
/** The commits a session makes from now on, as the entries of each. */
function commitsOf(s: CaseSession): Entry[][] {
  const calls: Entry[][] = [];
  const commit = s.commit.bind(s);
  s.commit = ((fn: Parameters<CaseSession["commit"]>[0]) => {
    const written = commit(fn);
    calls.push([...written]);
    return written;
  }) as CaseSession["commit"];
  return calls;
}
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
/** The child accepts its plan and its product, each by the person, with childSettled on the parent after each. */
async function carryChild(parent: Engine, id = "CASE-2"): Promise<void> {
  const ce = childEngine(id);
  ce.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect((await ce.advance()).waiting).toBe("publish");
  await parent.childSettled(id);
  ce.approve({ actor: human });
  expect((await ce.advance()).outcome).toBe("published");
  await parent.childSettled(id);
}
const investigateOf = (loop = "triage"): StageManifest => composed.deps.loops!.current(loop)!.pipeline.stages.find((x) => x.id === "investigate")!;

// ---- Step 5: the runner

test("the stage makes one child for the investigation loop, records subloop.started with the child, the loop hash, the input hash and the inputs blob, and drives the child", async () => {
  const { s } = await startParent();
  const started = ofType(s, "subloop.started");
  expect(started).toHaveLength(1);
  const p = started[0]!.payload;
  expect(p).toMatchObject({ stage: "investigate", attempt: 1, child: "CASE-2", loop: "investigation", depth: 1 });
  expect(p.loop_hash).toBe(composed.deps.loops!.current("investigation")!.pipeline.hash);
  const inputs = JSON.parse(s.blobs.text(p.inputs.blob)) as Record<string, Json>;
  expect(inputs).toEqual({ question: input.asked, observables: [SAMPLE_START], window: SAMPLE_WINDOW } as unknown as Record<string, Json>);
  expect(p.input_hash).toBe(sha256Hex(canonical(inputs as Json)));
  expect(started[0]!.actor).toEqual(ENGINE);
  expect(wb.listCases()).toHaveLength(2);
  // driven: the child's run started and went as far as it goes without a person
  expect(child().state.run).toMatchObject({ status: "waiting", waiting: "plan" });
});

test("the child's first commit names the parent, the run, the stage, the attempt and the input hash, and its marking is at least the parent's", async () => {
  const { s } = await startParent();
  const first = child().entries().slice(0, 3);
  expect(first.map((e) => e.type)).toEqual(["case.created", "case.loop_set", "subloop.child"]);
  const link = first[2]!.type === "subloop.child" ? first[2]!.payload : null;
  expect(link).toEqual({ parent: s.id, run: s.state.run.id!, stage: "investigate", attempt: 1, loop: "investigation", input_hash: ofType(s, "subloop.started")[0]!.payload.input_hash, depth: 1, floor: "TLP:GREEN" });
  expect(child().state.loop.id).toBe("investigation");
  expect(child().state.meta!.marking).toBe("TLP:GREEN");
  expect(child().state.meta!.title).toBe("Sample (from CASE-1 · Investigate)");
});

test("the child stops at its plan gate: the parent pauses with waiting on child CASE-2 and a child hold, and nothing in either ledger passed a gate", async () => {
  const parent = await startParent();
  expect(parent.s.state.run).toMatchObject({ status: "paused", hold: { kind: "child", stage: "investigate", child: "CASE-2" } });
  expect(parent.s.state.run.pause_reason).toMatch(/^waiting on child CASE-2: /);
  expect([...parent.s.entries(), ...child().entries()].some((e) => e.type === "gate.passed" || e.type === "plan.accepted")).toBe(false);
  expect(wb.listCases().find((c) => c.id === parent.s.id)!.waiting_on).toBe("CASE-2");
});

test("a person accepts the child's plan and approves its product; childSettled after each carries the parent on, and the parent's stage passes when the child has published", async () => {
  const { s, e } = await startParent();
  const ce = childEngine();
  ce.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect((await ce.advance()).waiting).toBe("publish");
  await e.childSettled("CASE-2");
  expect(s.state.run.status).toBe("paused");
  expect(s.state.run.pause_reason).toBe("waiting on child CASE-2: it waits for a person at its publish gate");
  ce.approve({ actor: human });
  expect((await ce.advance()).outcome).toBe("published");
  expect(await e.childSettled("CASE-2")).toMatchObject({ status: "finished", outcome: "completed" });
  expect(s.state.run.stages.find((x) => x.id === "investigate")!.status).toBe("passed");
  // the only resumes in the parent are the engine's, and no person's act was sent to the parent after start
  const resumed = ofType(s, "run.resumed");
  expect(resumed.length).toBe(2);
  expect(resumed.every((x) => x.actor.kind === "system")).toBe(true);
  expect(s.entries().filter((x) => x.actor.kind === "human").map((x) => x.type)).toEqual(["case.created", "case.loop_set", "loop.bound", "run.started"]);
  // every gate of the child was passed by the person
  const gates = child().entries().filter((x) => GATES.has(x.type));
  expect(gates.length).toBeGreaterThan(0);
  for (const g of gates) expect(g.actor).toEqual(human);
  expect(s.entries().some((x) => GATES.has(x.type))).toBe(false);
});

test("subloop.finished records the child's head, its outcome, the output hash and the returned cards, in one commit with those cards", async () => {
  const { s, e } = await startParent();
  const commits = commitsOf(s);
  await carryChild(e);
  const c = child();
  const finished = commits.find((x) => x.some((y) => y.type === "subloop.finished"))!;
  const f = finished.find((y) => y.type === "subloop.finished")!;
  if (f.type !== "subloop.finished") throw new Error("unreachable");
  expect(f.payload).toMatchObject({ stage: "investigate", attempt: 1, child: "CASE-2", child_run: c.state.run.id!, head: c.head(), outcome: "published" });
  const outputs = outputsOf(c.state, composed.deps.loops!.current("investigation")!.manifest.outputs);
  expect(f.payload.output_hash).toBe(outputHash(outputs));
  expect(JSON.parse(s.blobs.text(f.payload.output.blob))).toEqual(JSON.parse(canonical(outputs as Json)));
  const cards = finished.filter((y) => y.type === "card.created").map((y) => (y.type === "card.created" ? y.payload.card : null)!);
  expect(cards.map((x) => x.id)).toEqual(f.payload.cards);
  const kept = outputs.cards as unknown as Card[];
  expect(kept.length).toBeGreaterThan(0);
  expect(cards).toHaveLength(kept.length);
  for (const [i, x] of cards.entries()) {
    expect(x.why).toBe(`from sub-loop investigation run ${c.state.run.id} of CASE-2`);
    expect(x.from).toEqual({ case: "CASE-2", loop: "investigation", run: c.state.run.id!, card: kept[i]!.id, head: c.head().hash });
    expect(x.marking).toBe(kept[i]!.marking);
    expect(x).toMatchObject({ kind: "note", made_by: "system", query: null, source: null });
    expect(cardRefs(x.body)).toEqual([]);
  }
  const proposals = finished.filter((y) => y.type === "proposal.created");
  expect(proposals).toHaveLength(1);
  expect(proposals[0]!.type === "proposal.created" && proposals[0]!.payload.proposal).toMatchObject({ kind: "narrative", by: "sub-loop:investigation", section: "assessment", cites: [] });
  expect(s.state.loop.children[`${s.state.run.id}/investigate/1`]!.finished).toMatchObject({ head: c.head(), outcome: "published", cards: f.payload.cards });
});

test("the parent's queries are none of the child's: every query entry of the investigation is in the child's ledger", async () => {
  const { s, e } = await startParent();
  await carryChild(e);
  const queryTypes = new Set(["query.issued", "query.result", "query.failed"]);
  expect(s.entries().some((x) => queryTypes.has(x.type))).toBe(false);
  expect(s.state.queries).toEqual({});
  expect(child().entries().filter((x) => x.type === "query.issued").length).toBeGreaterThan(0);
  expect(Object.keys(child().state.queries).length).toBeGreaterThan(0);
});

test("a child that was stopped fails the parent's stage with the child's reason, and the parent's on_fail edge is taken or the run pauses", async () => {
  const { s, e } = await startParent();
  childEngine().stop(human, "the question was answered elsewhere");
  await e.childSettled("CASE-2");
  const st = s.state.run.stages.find((x) => x.id === "investigate")!;
  expect(st.status).toBe("failed");
  expect(st.last_reason).toContain("the question was answered elsewhere");
  // this loop's sub-loop stage has no on_fail: the run pauses
  expect(s.state.run.status).toBe("paused");
  expect(s.state.run.pause_reason).toMatch(/^Investigate failed: .*the question was answered elsewhere/);
  expect(ofType(s, "subloop.finished")[0]!.payload).toMatchObject({ outcome: "stopped", cards: [] });
  expect(ofType(s, "card.created")).toHaveLength(0);
});

test("a stopped child with an on_fail edge sends the parent's work back along it", async () => {
  writeLoop("triage", [frameStage("investigate"), subloopStage({ on_fail: "frame" })]);
  composed.reload();
  const { s, e } = await startParent();
  childEngine().stop(human, "not needed");
  await e.childSettled("CASE-2");
  const back = ofType(s, "stage.sent_back");
  expect(back).toHaveLength(1);
  expect(back[0]!.payload).toMatchObject({ from: "investigate", to: "frame" });
  // Frame passed again, and the stage's second attempt made a second child
  expect(ofType(s, "subloop.started").map((x) => [x.payload.attempt, x.payload.child])).toEqual([[1, "CASE-2"], [2, "CASE-3"]]);
});

test("childSettled for another child, by a run that is not paused on a child, or after the run finished writes nothing", async () => {
  const { s, e } = await startParent();
  const n = s.entries().length;
  expect((await e.childSettled("CASE-9")).status).toBe("paused");
  expect(s.entries()).toHaveLength(n);

  const other = wb.createCase(input, human, { loop: "triage" });
  sessions.push(other);
  const oe = Engine.open(other, { ...composed.deps, children: host }, { runners: { frame: passFrame } });
  engines.push(oe);
  oe.start(human);
  oe.pause(human);
  const m = other.entries().length;
  await oe.childSettled("CASE-2");
  expect(other.entries()).toHaveLength(m);

  await carryChild(e);
  expect(s.state.run.status).toBe("finished");
  const k = s.entries().length;
  await e.childSettled("CASE-2");
  expect(s.entries()).toHaveLength(k);
});

test("a person's own resume of the child-hold pause looks at the child again and pauses again while it still waits", async () => {
  const { s, e } = await startParent();
  const before = ofType(s, "run.paused").length;
  const reason = s.state.run.pause_reason;
  await e.resume(human);
  expect(ofType(s, "run.resumed").at(-1)!.actor).toEqual(human);
  expect(ofType(s, "run.paused")).toHaveLength(before + 1);
  expect(s.state.run).toMatchObject({ status: "paused", pause_reason: reason, hold: { kind: "child", child: "CASE-2" } });
  expect(wb.listCases()).toHaveLength(2);
  // a settle that changes nothing for the child writes nothing
  const n = s.entries().length;
  await e.childSettled("CASE-2");
  expect(s.entries()).toHaveLength(n);
});

test("with no ChildCases the stage stalls: this workbench cannot run a sub-loop here", async () => {
  const { s } = await startParent({ deps: composed.deps });
  expect(s.state.run.status).toBe("paused");
  expect(s.state.run.pause_reason).toBe("this workbench cannot run a sub-loop here");
  expect(wb.listCases()).toHaveLength(1);
  expect(ofType(s, "subloop.started")).toHaveLength(0);
});

// ---- Step 9: stops, caps and verification

test("a stop after the child was made and before subloop.started: the next run of the stage adopts that child and makes no second one", async () => {
  // ChildCases.create succeeds, then the parent's commit is made to throw once; exec again: wb.listCases() has two cases, not three
  let parent: CaseSession | null = null;
  host.afterCreate = () => { failOnce(parent!, "subloop.started"); host.afterCreate = null; };
  const s = wb.createCase(input, human, { loop: "triage" });
  sessions.push(s);
  parent = s;
  const e = Engine.open(s, { ...composed.deps, children: host }, { runners: { frame: passFrame } });
  engines.push(e);
  e.start(human);
  await e.advance();
  expect(ofType(s, "subloop.started")).toHaveLength(0);
  expect(s.state.run.pause_reason).toMatch(/the process stopped/);
  expect(wb.listCases()).toHaveLength(2);
  await e.resume(human);
  expect(wb.listCases()).toHaveLength(2);
  expect(host.created).toBe(1);
  expect(ofType(s, "subloop.started").map((x) => x.payload.child)).toEqual(["CASE-2"]);
  expect(s.state.run.hold).toEqual({ kind: "child", stage: "investigate", child: "CASE-2" });
});

test("a stop after the child published and before subloop.finished: the next run records it once, with the same output hash", async () => {
  const { s, e } = await startParent();
  const ce = childEngine();
  ce.acceptPlan({ budgets: { s3: 1 }, actor: human });
  await ce.advance();
  ce.approve({ actor: human });
  expect((await ce.advance()).outcome).toBe("published");
  failOnce(s, "subloop.finished");
  await e.childSettled("CASE-2");
  expect(ofType(s, "subloop.finished")).toHaveLength(0);
  expect(s.state.run.status).toBe("paused");
  await e.resume(human);
  const finished = ofType(s, "subloop.finished");
  expect(finished).toHaveLength(1);
  expect(finished[0]!.payload.output_hash).toBe(outputHash(outputsOf(child().state, composed.deps.loops!.current("investigation")!.manifest.outputs)));
  expect(s.state.run).toMatchObject({ status: "finished", outcome: "completed" });
});

test("a stage run again after subloop.finished returns the recorded result and writes nothing to either ledger", async () => {
  const { s, e } = await startParent();
  await carryChild(e);
  const n = s.entries().length;
  const m = child().entries().length;
  const end = await subloopRunner({ session: s, deps: { ...composed.deps, children: host }, stage: investigateOf(), attempt: 1, onNeedsBudget: async () => null });
  expect(end).toMatchObject({ kind: "finished", outcome: "pass" });
  expect(s.entries()).toHaveLength(n);
  expect(child().entries()).toHaveLength(m);
});

test("a sent-back sub-loop stage is a new attempt and a new child; the first child is left as it is", async () => {
  // a third stage, Recheck, fails its first attempt and sends the work back to the sub-loop stage
  writeLoop("triage", [frameStage("investigate"), subloopStage({ on_pass: "recheck" }), {
    id: "recheck", title: "Recheck", order: 3, runs: "script", role: "feedback", tools: [], on_pass: null, on_fail: "investigate",
  }]);
  composed.reload();
  const recheck: StageRunner = async (env) => ({ kind: "finished", outcome: env.attempt === 1 ? "fail" : "pass", draft_hash: null, output: null, reason: env.attempt === 1 ? "look again" : null });
  const s = wb.createCase(input, human, { loop: "triage" });
  sessions.push(s);
  const e = Engine.open(s, { ...composed.deps, children: host }, { runners: { frame: passFrame, feedback: recheck } });
  engines.push(e);
  e.start(human);
  await e.advance();
  await carryChild(e);
  const firstHead = child().head();
  expect(ofType(s, "subloop.started").map((x) => [x.payload.attempt, x.payload.child])).toEqual([[1, "CASE-2"], [2, "CASE-3"]]);
  expect(s.state.run.hold).toEqual({ kind: "child", stage: "investigate", child: "CASE-3" });
  expect(child("CASE-3").state.loop.parent).toMatchObject({ attempt: 2 });
  expect(child().head()).toEqual(firstHead);
  expect(child().state.run.outcome).toBe("published");
});

test("a case at depth max_depth does not make a child: the run pauses with sub-loop depth cap of 2 reached", async () => {
  const deep: ChildLink = { parent: "CASE-90", run: "run-1", stage: "investigate", attempt: 1, loop: "triage", input_hash: "h", depth: 2, floor: "TLP:GREEN" };
  const { s } = await startParent({ link: deep });
  expect(s.state.run.status).toBe("paused");
  expect(s.state.run.pause_reason).toBe("sub-loop depth cap of 2 reached");
  expect(wb.listCases()).toHaveLength(1);
  expect(host.created).toBe(0);
});

test("a loop that runs itself, past validation, is stopped at the depth cap: each level waits on the one below it", async () => {
  // validation refuses a loop that reaches itself; here a catalogue hands one out anyway, and the engine's own cap still stops it
  const real = composed.deps.loops!;
  const triage = real.current("triage")!;
  const stages = triage.pipeline.stages.map((st) => (st.subloop == null ? st : { ...st, subloop: { ...st.subloop, loop: "triage" } }));
  const self: ResolvedLoop = { ...triage, manifest: { ...triage.manifest, inputs: { question: { type: "question", required: true }, observables: { type: "observables", required: true }, window: { type: "window", required: true } } }, pipeline: { ...triage.pipeline, stages } };
  const loops: LoopCatalog = { ...real, current: (id) => (id === "triage" ? self : real.current(id)), fromLock: (lock) => (lock.loop === "triage" ? self : real.fromLock(lock)) };
  const deps: EngineDeps = { ...composed.deps, loops };
  const selfHost = new Host(() => deps);
  deps.children = selfHost;
  // the children's engines pass Frame without a model too
  selfHost.engine = function (id: string): Engine {
    let x = this.engines.get(id);
    if (x === undefined) {
      const s = wb.session(id);
      sessions.push(s);
      x = Engine.open(s, deps, { runners: { frame: passFrame } });
      engines.push(x);
      this.engines.set(id, x);
    }
    return x;
  };
  const { s } = await startParent({ deps });
  expect(wb.listCases().map((c) => c.id).sort()).toEqual(["CASE-1", "CASE-2", "CASE-3"]);
  expect(wb.session("CASE-3").state.run.pause_reason).toBe("sub-loop depth cap of 2 reached");
  expect(wb.session("CASE-2").state.run.pause_reason).toMatch(/^waiting on child CASE-3: it is paused: sub-loop depth cap of 2 reached/);
  expect(s.state.run.pause_reason).toMatch(/^waiting on child CASE-2: /);
});

test("the ninth sub-loop of a case pauses the run: this case has started 8 sub-loops, the cap", async () => {
  const { s } = await startParent();
  // seven more sub-loops this case started (attempts 2 to 8 of the stage), as the record has them
  s.commit((st) => Array.from({ length: 7 }, (_, i) => ({
    type: "subloop.started" as const, actor: ENGINE, run: st.run.id, stage: "investigate",
    payload: { stage: "investigate", attempt: i + 2, child: `CASE-${90 + i}`, loop: "investigation", loop_hash: "h", input_hash: "h", inputs: s.blobs.put("{}"), depth: 1 },
  })));
  expect(s.state.loop.child_count).toBe(8);
  const n = wb.listCases().length;
  const end = await subloopRunner({ session: s, deps: { ...composed.deps, children: host }, stage: investigateOf(), attempt: 9, onNeedsBudget: async () => null });
  expect(end).toEqual({ kind: "stalled", reason: "this case has started 8 sub-loops, the cap" });
  expect(wb.listCases()).toHaveLength(n);
});

test("replaying the parent reads no child: fold of every prefix equals the live state with the child's folder removed", async () => {
  // capture states live; rmSync the child's folder; fold(parentEntries, seq) toEqual captured for every seq; stateAt too
  const live = new Map<number, CaseState>();
  const s = wb.createCase(input, human, { loop: "triage" });
  sessions.push(s);
  live.set(s.state.seq, structuredClone(s.state));
  const commit = s.commit.bind(s);
  s.commit = ((fn: Parameters<CaseSession["commit"]>[0]) => {
    const written = commit(fn);
    live.set(s.state.seq, structuredClone(s.state));
    return written;
  }) as CaseSession["commit"];
  const e = Engine.open(s, { ...composed.deps, children: host }, { runners: { frame: passFrame } });
  engines.push(e);
  e.start(human);
  await e.advance();
  await carryChild(e);
  expect(s.state.run.outcome).toBe("completed");
  const c = child();
  c.close();
  rmSync(c.dir, { recursive: true, force: true });
  const entries = s.entries();
  for (const [seq, state] of live) {
    expect(fold(entries, seq)).toEqual(state);
    expect(s.stateAt(seq)).toEqual(state);
  }
  expect(live.size).toBeGreaterThan(5);
});

test("a run that ends published gives onOutputs the outputs its loop declares, as outputsOf reads them from its state", async () => {
  const seen: { case: string; outputs: Record<string, Json> }[] = [];
  const deps: EngineDeps = { ...composed.deps, onOutputs: (o) => { seen.push({ case: o.case, outputs: o.outputs }); } };
  const s = wb.createCase(input, human);
  sessions.push(s);
  const e = Engine.open(s, deps);
  engines.push(e);
  e.start(human);
  await e.advance();
  e.acceptPlan({ budgets: { s3: 1 }, actor: human });
  await e.advance();
  e.approve({ actor: human });
  expect((await e.advance()).outcome).toBe("published");
  expect(seen).toHaveLength(1);
  const outputs = seen[0]!.outputs;
  expect(Object.keys(outputs).sort()).toEqual(["cards", "findings", "product"]);
  expect(outputs).toEqual(outputsOf(s.state, composed.deps.loops!.current("investigation")!.manifest.outputs));
  expect(outputs.product).not.toBeNull();
  expect((outputs.cards as unknown as Card[]).length).toBeGreaterThan(0);
});

test("a person's pause made while the child is driven is kept: the stage does not replace it with a child hold, and childSettled does not lift it", async () => {
  const s = wb.createCase(input, human, { loop: "triage" });
  sessions.push(s);
  const e = Engine.open(s, { ...composed.deps, children: host }, { runners: { frame: passFrame } });
  engines.push(e);
  host.afterCreate = () => { e.pause(human); host.afterCreate = null; };
  e.start(human);
  await e.advance();
  expect(s.state.run).toMatchObject({ status: "paused", pause_reason: "paused by analyst", hold: null });
  const n = s.entries().length;
  await e.childSettled("CASE-2");
  expect(s.entries()).toHaveLength(n);
});

// ---- final review: the version lock reaches the child (I1) and the stage reads only its own child (C1)

test("a child binds the version of its loop that the parent's lock names, though that loop was saved after the parent bound; verifyLinks reads that it matches", async () => {
  const s = wb.createCase(input, human, { loop: "triage" });
  sessions.push(s);
  const e = Engine.open(s, { ...composed.deps, children: host }, { runners: { frame: passFrame } });
  engines.push(e);
  e.start(human);
  const named = e.loop!.lock.subloops.find((x) => x.stage === "investigate")!.hash;
  appendFileSync(join(sample.root, "context", "personas", "planner.md"), "\nA line added after the parent bound.\n");
  expect(composed.reload()).toEqual([]);
  const now = composed.deps.loops!.current("investigation")!.pipeline.hash;
  expect(now).not.toBe(named);
  await e.advance();
  const started = ofType(s, "subloop.started")[0]!.payload;
  expect(started.loop_hash).toBe(named);
  const bound = ofType(child(), "loop.bound")[0]!.payload;
  expect(bound.hash).toBe(named);
  expect(child().state.loop.bound!.hash).toBe(named);
  await carryChild(e);
  expect(s.state.run).toMatchObject({ status: "finished", outcome: "completed" });
  expect(verifyLinks(s.dir, join(config.data_dir, "cases"))).toMatchObject({ ok: true, links: [{ child: "CASE-2", status: "matches" }] });
});

test("a child whose run bound another version than the parent's record names holds the stage, and verifyLinks says the version differs", async () => {
  // a host that starts the child on the loop's current version, whatever the parent's lock says
  class Careless extends Host {
    override async drive(ref: Parameters<ChildCases["drive"]>[0]): Promise<ReturnType<Engine["summary"]>> {
      const ce = this.engine(ref.id);
      if (wb.session(ref.id).state.run.status === "none") ce.start(ENGINE);
      return ce.advance();
    }
  }
  const careless = new Careless(() => ({ ...composed.deps, children: careless }));
  const s = wb.createCase(input, human, { loop: "triage" });
  sessions.push(s);
  const e = Engine.open(s, { ...composed.deps, children: careless }, { runners: { frame: passFrame } });
  engines.push(e);
  e.start(human);
  appendFileSync(join(sample.root, "context", "personas", "planner.md"), "\nA line added after the parent bound.\n");
  expect(composed.reload()).toEqual([]);
  await e.advance();
  expect(s.state.run.status).toBe("paused");
  expect(s.state.run.pause_reason).toMatch(/^Investigate: child CASE-2 runs version [0-9a-f]{12} of loop "investigation"; this run's lock names [0-9a-f]{12}$/);
  const ce = careless.engine("CASE-2");
  ce.acceptPlan({ budgets: { s3: 1 }, actor: human });
  await ce.advance();
  ce.approve({ actor: human });
  expect((await ce.advance()).outcome).toBe("published");
  await e.resume(human);
  expect(ofType(s, "subloop.finished")).toHaveLength(0);
  expect(s.state.run.status).toBe("paused");
});

test("a finished child's recorded result is returned first: the stage run again with the child gone passes as recorded", async () => {
  const { s, e } = await startParent();
  await carryChild(e);
  const c = child();
  c.close();
  rmSync(c.dir, { recursive: true, force: true });
  const n = s.entries().length;
  const end = await subloopRunner({ session: s, deps: { ...composed.deps, children: host }, stage: investigateOf(), attempt: 1, onNeedsBudget: async () => null });
  expect(end).toMatchObject({ kind: "finished", outcome: "pass", output: { child: "CASE-2", outcome: "published" } });
  expect(s.entries()).toHaveLength(n);
});

test("a case with the child's id that does not name this parent is not the child: the stage neither drives nor reads it, and says the child is not loaded", async () => {
  const { s, e } = await startParent();
  // the child goes away, and another workbench's CASE-2, an ordinary case, is put in its folder
  const c = child();
  const origin = c.entries()[0]!.hash;
  c.close();
  rmSync(c.dir, { recursive: true, force: true });
  host.engines.delete("CASE-2");
  const elsewhere = Workbench.open(join(dir, "elsewhere"), { onError: () => {} });
  try {
    elsewhere.createCase(input, human);
    elsewhere.createCase({ ...input, title: "Someone else's" }, human);
  } finally {
    elsewhere.close();
  }
  cpSync(join(dir, "elsewhere", "cases", "CASE-2"), join(config.data_dir, "cases", "CASE-2"), { recursive: true });
  const impostor = wb.session("CASE-2");
  sessions.push(impostor);
  expect(impostor.entries()[0]!.hash).not.toBe(origin);
  const n = impostor.entries().length;
  await e.resume(human);
  expect(impostor.entries()).toHaveLength(n);
  expect(s.state.run.pause_reason).toBe("waiting on child CASE-2: child CASE-2 is not loaded; load it from the store");
  expect(await e.childSettled("CASE-2")).toMatchObject({ status: "paused" });
  expect(ofType(s, "subloop.finished")).toHaveLength(0);
});
