// Slice 14, Task 9: Select takes the tasks of a case type and the target loop's version. It records, of a known answer, only its seq and hash.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import { readTaskInputs, readTaskRecord } from "../../src/core/state";
import type { Actor, Draft, ExpectedFinding, Marking, Product, StageDef } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { foldLessons, lessonHash, readMemoryLock } from "../../src/core/lessons";
import type { LessonDraft } from "../../src/core/lessons";
import type { EngineDeps, StageEnd, StageEnv } from "../../src/pipeline/engine";
import { setKnownAnswer } from "../../src/pipeline/improve/answers";
import type { ImproveHost, TaskView } from "../../src/pipeline/improve/host";
import { selectRunner, targetProblem, taskInputs, taskRecord } from "../../src/pipeline/improve/select";
import type { LoopCatalog, ResolvedLoop } from "../../src/pipeline/loops";
import { EntryBuilder } from "../helpers/entries";

const human: Actor = { kind: "human", id: "analyst" };
const assembler: Actor = { kind: "agent", id: "assemble", stage: "assemble", profile: "default", model: "scripted-m", effort: null, where: "machine" };
const CANARY = "canary-7f3a";
const SCALE = ["remote", "unlikely", "even", "likely", "almost certain"];
const blob = (c: string) => ({ blob: c.repeat(64), bytes: 10 });

let dir: string;
let wb: Workbench;
const sessions: CaseSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "improve-select-"));
  wb = Workbench.open(join(dir, "wb"), { onError: () => {} });
  sessions.length = 0;
});
afterEach(() => {
  for (const s of sessions) if (s.open) expect(s.state.skipped).toEqual([]);
  try { wb.close(); } catch { /* closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const productOf = (marking: Marking, summary: string): Product => ({
  objective: "Decide", question: "Is 192.0.2.10 beaconing?", marking, summary,
  key_findings: [{ id: "f1", statement: "192.0.2.10 connects to 198.51.100.7 every 60 s", likelihood: "likely", confidence: "moderate", confidence_basis: "one source", cites: [], assumptions: [], reasoning: "periodic" }],
  gaps_and_limits: "", alternatives: "", assessment: "Likely beaconing.", sources: [{ source: "netflow", quality: "good" }], assumptions: [], change: "",
});
const draftOf = (n: number, product: Product): Draft => ({ n, hash: sha256Hex(canonical(product as never)), author: assembler, product, reason: "first" });
const findings: ExpectedFinding[] = [{ claim: `${CANARY} the host beacons to the remote address each minute`, likelihood: "likely", confidence: "moderate" }];
const secretless = { runner: { secrets: () => [] as string[] } } as unknown as Pick<EngineDeps, "runner">;

interface TaskOpts { caseMarking?: Marking; productMarking?: Marking; answerMarking?: Marking | null; products?: number; answered?: number[]; type?: string }
/** A task case: product(s) published, a known answer on each of `answered` (the first by default) unless answerMarking is null. */
function taskCase(o: TaskOpts = {}): CaseSession {
  const { caseMarking = "TLP:GREEN", productMarking = "TLP:GREEN", answerMarking = "TLP:GREEN", products = 1, answered = [1] } = o;
  const s = wb.createCase(
    { title: "A beaconing host", asked: "Is 192.0.2.10 beaconing?", why: "alert", starting: [{ type: "ip", value: "192.0.2.10" }], window: { from: null, to: null }, objective: "Decide", marking: caseMarking },
    human,
  );
  sessions.push(s);
  for (let n = 1; n <= products; n++) {
    const draft = draftOf(n, productOf(productMarking, `Regular connections, draft ${n}.`));
    s.commit(() => [
      { type: "draft.revised", actor: assembler, payload: { draft } },
      { type: "product.published", actor: human, payload: { n, draft_hash: draft.hash, head_hash: "b".repeat(64), dir: `products/${n}`, bundle: blob("c") } },
    ]);
  }
  if (answerMarking !== null) {
    for (const n of answered) setKnownAnswer(s, secretless, { product: n, text: `${CANARY} It was beaconing to a test address.`, findings, marking: answerMarking, actor: human }, SCALE);
  }
  return s;
}
const viewOf = (s: CaseSession, state: TaskView["state"] = s.state): TaskView => ({
  ref: { case: s.id, origin: s.entries(0, 1)[0]!.hash }, state, head: { seq: s.state.seq, hash: s.entries().at(-1)!.hash }, entries: (a, b) => s.entries(a, b),
});

const SELECT_STAGE: StageDef = { id: "select", title: "Select", phase: null, runs: "script", gate: null, reviews: false, model: null };
/** An improve case at its first stage, in a run: marked `marking`, asking for `tasks` tasks of type `type`. */
function improveCase(o: { marking?: Marking; tasks?: number; type?: string; target?: string } = {}): CaseSession {
  const { marking = "TLP:AMBER", tasks = 3, type = "unknown-device", target = "investigation" } = o;
  const s = wb.createCase({ title: "Improve", asked: "Improve", why: "w", starting: [], window: { from: null, to: null }, objective: null, marking }, human, { loop: "improve" });
  sessions.push(s);
  s.commit(() => [{ type: "improve.requested", actor: human, payload: { target, case_type: type, tasks, candidates: 2 } }]);
  s.commit((_, ids) => [{ type: "run.started", actor: { kind: "system", id: "engine" }, payload: { run: ids.next("run"), pipeline: "improve", pipeline_hash: "a".repeat(64), stages: [SELECT_STAGE] } }]);
  expect(s.state.improve.request).not.toBeNull();
  return s;
}

/** The target loop as the catalog gives it: no sub-loop, a standard of five likelihood terms. */
function targetLoop(over: { standard?: string | null; hash?: string; version?: number; stages?: { role: string; runs: string }[]; subloops?: number } = {}): ResolvedLoop {
  const { standard = "icd203", hash = "e".repeat(64), version = 4, stages = [{ role: "frame", runs: "agent" }, { role: "assemble", runs: "agent" }], subloops = 0 } = over;
  return {
    manifest: { id: "investigation", version, hash: "f".repeat(64) },
    pipeline: { stages },
    profile: { standard },
    components: {
      get: (stage: string, kind: string, id: string) =>
        stage === "*" && kind === "standard" && id === standard
          ? { body: { likelihood: SCALE.map((term) => ({ term })), judgment_markers: ["we judge"], change_terms: ["changed"] } }
          : null,
      items: () => [],
    },
    lock: { format: 1, loop: "investigation", version, title: "Investigation", about: "", hash, legacy_hash: null, manifest: { path: null, hash: "f".repeat(64) }, profile: "p", entry: "agent", items: [], subloops: Array.from({ length: subloops }, (_, i) => ({ stage: `s${i}`, loop: "child", hash: "c".repeat(64) })) },
  } as unknown as ResolvedLoop;
}
function catalog(loops: Record<string, ResolvedLoop | null>, problems: Record<string, string[]> = {}): LoopCatalog {
  return { current: (id: string) => loops[id] ?? null, problems: (id: string) => problems[id] ?? (loops[id] === undefined || loops[id] === null ? [`no loop manifest ${id}`] : []) } as unknown as LoopCatalog;
}

function hostOf(views: TaskView[], types: Record<string, string> = {}): ImproveHost & { asked: string[] } {
  const no = (what: string) => (): never => { throw new Error(`Select does not call ${what}`); };
  const asked: string[] = [];
  return {
    asked,
    tasks: (type: string) => { asked.push(type); return views.filter((v) => (types[v.ref.case] ?? "unknown-device") === type); },
    task: no("task"), staged: no("staged"), stage: no("stage"), check: no("check"), clear: no("clear"),
    probes: { find: no("find"), create: no("create"), drive: no("drive"), read: no("read"), end: no("end") },
  } as ImproveHost & { asked: string[] };
}

interface DepsOpts { host?: ImproveHost | null; loops?: LoopCatalog; lock?: unknown; memory?: unknown }
function envOf(session: CaseSession, o: DepsOpts = {}): StageEnv {
  const deps = {
    config: { improve: { own_tokens: 400000 }, memory: { max_lessons: 12 } },
    loops: o.loops ?? catalog({ investigation: targetLoop() }),
    improve: o.host === null ? undefined : o.host,
    lock: o.lock,
    memory: o.memory,
  } as unknown as EngineDeps;
  return { session, deps, stage: SELECT_STAGE as never, attempt: 1, onNeedsBudget: async () => null };
}
interface SelectOut { target: string; version: number; loop_hash: string; tasks: { task: string; case: string }[]; left_out: { case: string; why: "marking" | "cap" }[] }
const outOf = (end: StageEnd): SelectOut => {
  expect(end.kind).toBe("finished");
  if (end.kind !== "finished") throw new Error("not finished");
  expect(end.outcome).toBe("pass");
  return end.output as unknown as SelectOut;
};

test("Select takes the cases of the type with a known answer, newest first, up to the number asked, as T1, T2…", async () => {
  const a = taskCase(), b = taskCase(), c = taskCase(), d = taskCase();
  const imp = improveCase({ tasks: 2 });
  const host = hostOf([d, c, b, a].map((s) => viewOf(s)));
  const out = outOf(await selectRunner(envOf(imp, { host })));
  expect(host.asked).toEqual(["unknown-device"]);
  expect(out.tasks).toEqual([{ task: "T1", case: d.id }, { task: "T2", case: c.id }]);
  expect(out.left_out).toEqual([{ case: b.id, why: "cap" }, { case: a.id, why: "cap" }]);
  expect(imp.state.improve.task_order).toEqual(["T1", "T2"]);
  expect(imp.state.improve.tasks.T1).toMatchObject({ case: d.id, origin: d.entries(0, 1)[0]!.hash, product: { n: 1 }, marking: "TLP:GREEN" });
  expect(imp.state.improve.tasks.T1!.head).toEqual({ seq: d.state.seq, hash: d.entries().at(-1)!.hash });
  expect(imp.state.improve.selected).toMatchObject({ target: "investigation", version: 4, loop_hash: "e".repeat(64), case_type: "unknown-device", run: "run-1" });
  expect(out).toMatchObject({ target: "investigation", version: 4, loop_hash: "e".repeat(64) });
});

test("a case with no known answer, of another type, an improve case and a probe child are not tasks", async () => {
  const good = taskCase();
  const unanswered = taskCase({ answerMarking: null });
  const other = taskCase();
  const improveOne = improveCase();
  // a probe child: a case with probe.child
  const probe = wb.createCase(
    { title: "p", asked: "q", why: "w", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN" }, { kind: "system", id: "engine" },
    { loop: "investigation", link: { parent: improveOne.id, run: "run-1", stage: "probe", attempt: 1, loop: "investigation", input_hash: "0b".repeat(32), depth: 1, floor: "TLP:GREEN" } },
  );
  sessions.push(probe);
  probe.commit(() => [{ type: "probe.child", actor: { kind: "system", id: "engine" }, payload: { improve: improveOne.id, origin: improveOne.entries(0, 1)[0]!.hash, probe: "base/T1", candidate: "base", task: "T1", plan_gate: "accept", max_lookups: 10 } }]);
  expect(probe.state.improve.probe_of).not.toBeNull();
  const imp = improveCase();
  const host = hostOf([viewOf(good), viewOf(unanswered), viewOf(other), viewOf(improveOne), viewOf(probe)], { [other.id]: "phishing" });
  const out = outOf(await selectRunner(envOf(imp, { host })));
  expect(out.tasks).toEqual([{ task: "T1", case: good.id }]);
  // none of them is "left out": they were never tasks
  expect(out.left_out).toEqual([]);
});

test("Select takes the greatest product number that has a known answer, and no other", async () => {
  const s = taskCase({ products: 3, answered: [1, 2] });
  const imp = improveCase();
  outOf(await selectRunner(envOf(imp, { host: hostOf([viewOf(s)]) })));
  expect(imp.state.improve.tasks.T1!.product.n).toBe(2);
  expect(imp.state.improve.tasks.T1!.product.draft_hash).toBe(s.state.published.find((p) => p.n === 2)!.draft_hash);
  expect(imp.state.improve.tasks.T1!.answer).toEqual({ seq: s.state.answers["2"]!.seq, hash: s.state.answers["2"]!.hash });
});

test("a task whose case, product or answer is stricter than the improve case is left out for its marking; the rest beyond the cap for the cap", async () => {
  const fine = taskCase({ caseMarking: "TLP:AMBER", productMarking: "TLP:AMBER", answerMarking: "TLP:AMBER" });
  const strictCase = taskCase({ caseMarking: "TLP:RED", productMarking: "TLP:RED", answerMarking: "TLP:RED" });
  const strictProduct = taskCase({ caseMarking: "TLP:GREEN", productMarking: "TLP:RED", answerMarking: "TLP:RED" });
  const strictAnswer = taskCase({ caseMarking: "TLP:GREEN", productMarking: "TLP:GREEN", answerMarking: "TLP:RED" });
  const second = taskCase();
  const beyond = taskCase();
  const imp = improveCase({ marking: "TLP:AMBER", tasks: 2 });
  const host = hostOf([beyond, strictAnswer, strictProduct, strictCase, fine, second].map((s) => viewOf(s)));
  const out = outOf(await selectRunner(envOf(imp, { host })));
  expect(out.tasks).toEqual([{ task: "T1", case: beyond.id }, { task: "T2", case: fine.id }]);
  expect(out.left_out).toEqual([
    { case: strictAnswer.id, why: "marking" }, { case: strictProduct.id, why: "marking" }, { case: strictCase.id, why: "marking" }, { case: second.id, why: "cap" },
  ]);
  expect(imp.state.improve.selected!.left_out).toEqual(out.left_out);
  // a task is marked at least as strictly as its case, its product and its answer
  expect(imp.state.improve.tasks.T1!.marking).toBe("TLP:GREEN");
  expect(imp.state.improve.tasks.T2!.marking).toBe("TLP:AMBER");
});

test("with no task Select fails with the sentence and the run pauses", async () => {
  const unanswered = taskCase({ answerMarking: null });
  const imp = improveCase();
  const before = imp.entries().length;
  const end = await selectRunner(envOf(imp, { host: hostOf([viewOf(unanswered)]) }));
  expect(end).toEqual({ kind: "finished", outcome: "fail", draft_hash: null, output: null, reason: "there is no unknown-device case with a known answer on a published product here" });
  expect(imp.entries().length).toBe(before);
  // the engine pauses a run whose stage failed with no stage to send work back to (next.ts: "<stage> failed: <reason>"), so Select writes nothing itself
});

test("improve.task holds the answer's seq and hash and nothing of its text: no blob of the improve case holds the canary", async () => {
  const s = taskCase();
  const imp = improveCase();
  outOf(await selectRunner(envOf(imp, { host: hostOf([viewOf(s)]) })));
  const t = imp.state.improve.tasks.T1!;
  expect(t.answer).toEqual({ seq: s.state.answers["1"]!.seq, hash: s.state.answers["1"]!.hash });
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name)));
  };
  walk(imp.dir);
  expect(files.length).toBeGreaterThan(2);
  for (const f of files) expect(readFileSync(f, "utf8"), f).not.toContain(CANARY);
  expect(JSON.stringify(imp.entries())).not.toContain(CANARY);
  // the task's blobs say what the original run said, from named fields
  const inputs = readTaskInputs(imp.blobs.get(t.inputs.blob))!;
  expect(inputs).toEqual({ question: "Is 192.0.2.10 beaconing?", starting: [{ type: "ip", value: "192.0.2.10" }], window: { from: null, to: null }, objective: "Decide", marking: "TLP:GREEN", title: "A beaconing host" });
  const record = readTaskRecord(imp.blobs.get(t.record.blob))!;
  expect(record.product.summary).toBe("Regular connections, draft 1.");
  // the known answer is still the task case's own
  expect(s.state.answers["1"]!.text).toContain(CANARY);
});

test("taskRecord holds the product, the stages, the queries, the counts and the usage, and is built from named fields: a state with an extra field holding the canary gives a record without it", () => {
  const s = taskCase();
  const base = s.state;
  const polluted = { ...base, answers_copy: { text: CANARY }, stray: CANARY, run: { ...base.run, stray: CANARY, stages: [{ id: "frame", title: "Frame", phase: null, runs: "agent", gate: null, reviews: false, model: null, status: "passed", attempts: 2, last_reason: "sent back once", stray: CANARY }], usage: { input: 11, output: 7, reasoning: 3, stray: CANARY }, model_calls: 4, calls_at_start: 0, usage_at_start: { input: 0, output: 0, reasoning: 0 }, sendbacks: { "a>b": 2, "c>d": 1 } },
    queries: { q1: { id: "q1", source: "netflow", pivot: "ip_to_flows", rows: 12, status: "done", stray: CANARY, text: `select ${CANARY}` }, q2: { id: "q2", source: "dhcp", pivot: null, rows: null, status: "failed", error: CANARY } },
    questions: { x1: {}, x2: {}, x3: {} },
  };
  const rec = taskRecord({ state: polluted as never }, 1);
  expect(JSON.stringify(rec)).not.toContain(CANARY);
  expect(rec.product).toEqual(productOf("TLP:GREEN", "Regular connections, draft 1."));
  expect(rec.stages).toEqual([{ id: "frame", title: "Frame", status: "passed", attempts: 2, last_reason: "sent back once" }]);
  expect(rec.queries).toEqual([{ source: "netflow", pivot: "ip_to_flows", outcome: "done", rows: 12 }, { source: "dhcp", pivot: null, outcome: "failed", rows: null }]);
  expect(rec.questions).toBe(3);
  expect(rec.sendbacks).toBe(3);
  expect(rec.usage).toEqual({ input: 11, output: 7, calls: 4 });
  expect(Object.keys(rec).sort()).toEqual(["product", "queries", "questions", "sendbacks", "stages", "usage"]);
  expect(Object.keys(taskInputs(base)).sort()).toEqual(["marking", "objective", "question", "starting", "title", "window"]);
});

test("improve.selected names the target's current version, its hash and its lock, and the scale of its standard, least likely first", async () => {
  const s = taskCase();
  const imp = improveCase();
  const target = targetLoop({ version: 7, hash: "9".repeat(64) });
  outOf(await selectRunner(envOf(imp, { host: hostOf([viewOf(s)]), loops: catalog({ investigation: target }) })));
  const sel = imp.state.improve.selected!;
  expect(sel).toMatchObject({ target: "investigation", version: 7, loop_hash: "9".repeat(64), scale: SCALE });
  expect(JSON.parse(new TextDecoder().decode(imp.blobs.get(sel.lock.blob)))).toEqual(JSON.parse(canonical(target.lock as never)));
  // a target with no standard of likelihood terms has no scale: the fold takes a selection only with a term in its scale, so Select stalls and writes nothing
  const imp2 = improveCase();
  const before = imp2.entries().length;
  const none = await selectRunner(envOf(imp2, { host: hostOf([viewOf(s)]), loops: catalog({ investigation: targetLoop({ standard: null }) }) }));
  expect(none).toEqual({ kind: "stalled", reason: "the standard of loop investigation lists no likelihood terms, so a task's findings cannot be scored" });
  expect(imp2.entries().length).toBe(before);
});

test("a target that is not usable, is an improve loop, or runs a sub-loop stalls with its sentence", async () => {
  const s = taskCase();
  const loops = catalog(
    { investigation: targetLoop(), improve: targetLoop({ stages: [{ role: "select", runs: "script" }, { role: "adopt", runs: "human" }] }), nested: targetLoop({ stages: [{ role: "subloop", runs: "loop" }] }), nested2: targetLoop({ subloops: 1 }), broken: null },
    { broken: ["the manifest names no stage"] },
  );
  const cases: [string, string][] = [
    ["ghost", "there is no usable loop ghost: no loop manifest ghost"],
    ["broken", "there is no usable loop broken: the manifest names no stage"],
    ["improve", "an improve loop is not improved by an improve loop"],
    ["nested", "loop nested runs a sub-loop; this version improves a loop with none"],
    ["nested2", "loop nested2 runs a sub-loop; this version improves a loop with none"],
  ];
  for (const [target, sentence] of cases) {
    expect(targetProblem(loops, target), target).toBe(sentence);
    const imp = improveCase({ target });
    const before = imp.entries().length;
    expect(await selectRunner(envOf(imp, { host: hostOf([viewOf(s)]), loops })), target).toEqual({ kind: "stalled", reason: sentence });
    expect(imp.entries().length).toBe(before);
  }
  expect(targetProblem(loops, "investigation")).toBeNull();
});

test("Select stalls without an improve host, and without an improve request", async () => {
  const imp = improveCase();
  expect(await selectRunner(envOf(imp, { host: null }))).toEqual({ kind: "stalled", reason: "this workbench cannot run an improve loop here" });
  const plain = wb.createCase({ title: "p", asked: "q", why: "w", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN" }, human);
  sessions.push(plain);
  plain.commit((_, ids) => [{ type: "run.started", actor: { kind: "system", id: "engine" }, payload: { run: ids.next("run"), pipeline: "improve", pipeline_hash: "a".repeat(64), stages: [SELECT_STAGE] } }]);
  const end = await selectRunner(envOf(plain, { host: hostOf([]) }));
  expect(end.kind).toBe("stalled");
});

test("Select sets the run's budget to improve.own_tokens when it has none, and leaves a budget a person set", async () => {
  const s = taskCase();
  const imp = improveCase();
  expect(imp.state.run.budget_tokens).toBeNull();
  outOf(await selectRunner(envOf(imp, { host: hostOf([viewOf(s)]) })));
  expect(imp.state.run.budget_tokens).toBe(400000);
  const set = imp.entries().find((e) => e.type === "budget.set")!;
  expect(set.actor).toEqual({ kind: "system", id: "engine" });

  const imp2 = improveCase();
  imp2.commit(() => [{ type: "budget.set", actor: human, payload: { tokens: 5000 } }]);
  outOf(await selectRunner(envOf(imp2, { host: hostOf([viewOf(s)]) })));
  expect(imp2.state.run.budget_tokens).toBe(5000);
  expect(imp2.entries().filter((e) => e.type === "budget.set").length).toBe(1);
});

// ---- memory

const lessonDraft = (over: Partial<LessonDraft> = {}): LessonDraft => ({
  case_type: "unknown-device", title: "Check the lobby access point first", text: "A device seen only on AP-3 is usually a guest in the lobby.", triggers: [], marking: "TLP:GREEN", supersedes: null, ...over,
});
function memoryOf(specs: { id: string; d?: Partial<LessonDraft> }[]) {
  const b = new EntryBuilder("memory");
  for (const { id, d: over } of specs) {
    const d = lessonDraft(over);
    b.add("lesson.proposed", { lesson: id, ...d, hash: lessonHash(d), from: { kind: "person" } }, { actor: human });
    b.add("lesson.accepted", { lesson: id, hash: lessonHash(d), marking: d.marking }, { actor: human });
  }
  const state = foldLessons(b.entries);
  expect(state.skipped).toEqual([]);
  return { read: () => ({ state, origin: "m".repeat(12), head: { seq: state.seq, hash: "d".repeat(64) } }) };
}
const improveLockOf = (stages: string[]) => ({
  items: stages.map((stage) => ({ stage, kind: "reference", id: `${stage}-lessons`, title: "t", source: "memory", hash: "h", path: null, memory: "shared/*" })),
});

test("Select binds every shared lesson of the type for the stages that read memory, a triggered one too, and none stricter than the case", async () => {
  const s = taskCase();
  const imp = improveCase({ marking: "TLP:AMBER" });
  const memory = memoryOf([
    { id: "LESSON-1" }, { id: "LESSON-2", d: { triggers: [{ source: "never-used" }] } }, { id: "LESSON-3", d: { marking: "TLP:RED" } }, { id: "LESSON-4", d: { case_type: "phishing" } },
  ]);
  outOf(await selectRunner(envOf(imp, { host: hostOf([viewOf(s)]), lock: improveLockOf(["propose", "reflect"]), memory })));
  const bound = imp.state.memory.bound!;
  expect(bound.lessons.map((l) => l.lesson)).toEqual(["LESSON-2", "LESSON-1"]);
  expect(bound.case_type).toBe("unknown-device");
  const lock = readMemoryLock(imp.blobs.get(bound.lock.blob))!;
  expect(lock.lessons.map((l) => l.lesson)).toEqual(["LESSON-2", "LESSON-1"]);
  expect(lock.lessons.every((l) => l.stages.join() === "propose,reflect")).toBe(true);
  expect(lock.left_out).toEqual([{ lesson: "LESSON-3", why: "marking" }]);
  // written in the commit of improve.selected, by the engine
  const sel = imp.entries().find((e) => e.type === "improve.selected")!;
  const mb = imp.entries().find((e) => e.type === "memory.bound")!;
  expect(mb.seq).toBeGreaterThan(sel.seq);
  expect(mb.actor).toEqual({ kind: "system", id: "engine" });

  // no shared use, or no memory host: no memory.bound
  const imp2 = improveCase();
  outOf(await selectRunner(envOf(imp2, { host: hostOf([viewOf(s)]), lock: { items: [] }, memory })));
  expect(imp2.entries().some((e) => e.type === "memory.bound")).toBe(false);
  const imp3 = improveCase();
  outOf(await selectRunner(envOf(imp3, { host: hostOf([viewOf(s)]), lock: improveLockOf(["propose"]) })));
  expect(imp3.entries().some((e) => e.type === "memory.bound")).toBe(false);
});

test("run again after a stop of the process, Select writes nothing more", async () => {
  const s = taskCase(), t = taskCase();
  const imp = improveCase({ tasks: 1 });
  const env = envOf(imp, { host: hostOf([viewOf(t), viewOf(s)]), lock: improveLockOf(["propose"]), memory: memoryOf([{ id: "LESSON-1" }]) });
  const first = outOf(await selectRunner(env));
  const written = imp.entries().length;
  const again = outOf(await selectRunner(env));
  expect(imp.entries().length).toBe(written);
  expect(again).toEqual(first);
  expect(again.left_out).toEqual([{ case: s.id, why: "cap" }]);
  // a later case does not change what was recorded
  const late = taskCase();
  const third = outOf(await selectRunner(envOf(imp, { host: hostOf([viewOf(late), viewOf(t), viewOf(s)]) })));
  expect(third).toEqual(first);
  expect(imp.entries().length).toBe(written);
});
