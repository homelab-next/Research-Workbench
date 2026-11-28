// Slice 14, Task 13: the Judge scores every probe against its known answer, after Compose has chosen. Scores are code; a model, when the stage
// runs one, only names which produced finding states a claim code left unmatched. The improve record each test needs is written by stand-in
// runners of the earlier stages, as a real run writes it; the Judge is the real runner, driven by the real engine.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { Providers } from "../../src/agents/providers";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import type { Script, ScriptTurn } from "../../src/agents/providers/scripted";
import { compose } from "../../src/cli/compose";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import { readAnswers, readScoreSheet } from "../../src/core/state/improve";
import type { AnswerCopy, ProbeOutput } from "../../src/core/state/improve";
import { scoreSheet, scoreOutput } from "../../src/core/score";
import type { Actor, Draft, EntryInput, ExpectedFinding, Finding, Product } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnv, StageRunner } from "../../src/pipeline/engine";
import { setKnownAnswer, withdrawKnownAnswer } from "../../src/pipeline/improve/answers";
import type { ImproveHost, TaskRef, TaskView } from "../../src/pipeline/improve/host";
import { MODEL_GAVE_NONE, answersOf, judgeRunner, matcherParts } from "../../src/pipeline/improve/judge";
import { IMPROVE_ROLES } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { sampleRoot } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
const ENGINE: Actor = { kind: "system", id: "engine" };
const agentOf = (stage: string): Actor => ({ kind: "agent", id: stage, stage, profile: "improve-test", model: "judge-test", effort: null, where: "machine" });
const assembler: Actor = { kind: "agent", id: "assemble", stage: "assemble", profile: "default", model: "scripted-m", effort: null, where: "machine" };
const SCALE = ["unlikely", "likely"];
const TITLES: Record<string, string> = { select: "Select", propose: "Propose", probe: "Probe", compose: "Compose", judge: "Judge", reflect: "Reflect", adopt: "Adopt" };
const secrets = { runner: { secrets: () => [] as string[] } } as unknown as Pick<EngineDeps, "runner">;
const CLAIMS = ["alpha beta gamma delta", "epsilon zeta eta theta", "iota kappa lambda mu"];
const STATEMENTS = ["alpha beta gamma delta", "epsilon zeta eta theta", "iota kappa lambda mu"];
const UNRELATED = "nothing relevant was seen on this host";
const CANARY = "canary-text";

const finding = (id: string, statement: string, likelihood = "likely", confidence: Finding["confidence"] = "high"): Finding =>
  ({ id, statement, likelihood, confidence, confidence_basis: "one source", cites: [], assumptions: [], reasoning: "because" });
const productOf = (findings: Finding[]): Product => ({
  objective: "Decide", question: "Is 192.0.2.10 beaconing?", marking: "TLP:GREEN", summary: "A summary.", key_findings: findings, gaps_and_limits: "", alternatives: "",
  assessment: "An assessment.", sources: [], assumptions: [], change: "",
});
const outputOf = (findings: Finding[] | null): ProbeOutput => findings === null
  ? { format: 1, outcome: "incomplete", reason: "it waits for a person", draft_hash: null, product: null, stats: { lookups: 0, tokens: 0, model_calls: 0, stages: [] } }
  : { format: 1, outcome: "drafted", reason: "", draft_hash: "d".repeat(64), product: productOf(findings), stats: { lookups: 1, tokens: 10, model_calls: 1, stages: [] } };

interface Rig {
  dir: string; wb: Workbench; config: Config; composed: ReturnType<typeof compose>; sample: ReturnType<typeof sampleRoot>; sessions: CaseSession[];
  tasks: CaseSession[]; taskCalls: string[];
}
const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) {
    for (const s of r.sessions) if (s.open) expect(s.state.skipped).toEqual([]);
    try { r.composed.close(); } catch { /* closed */ }
    try { r.wb.close(); } catch { /* closed */ }
    r.sample.close();
    rmSync(r.dir, { recursive: true, force: true });
  }
});

/** The improve loop with its Judge a script, or an agent for the judge-output schema. */
function improveLoop(judgeAgent: boolean): Record<string, Json> {
  const stages = IMPROVE_ROLES.map((role, i): Record<string, Json> => {
    const agent = role === "propose" || role === "compose" || role === "reflect" || (role === "judge" && judgeAgent);
    return {
      id: role, title: TITLES[role]!, order: i + 1, runs: agent ? "agent" : role === "adopt" ? "human" : "script", role, gate: role === "adopt" ? "adopt" : null, reviews: false,
      tools: [], schema: role === "judge" && judgeAgent ? "judge-output" : null,
      model: agent ? { provider: "scripted", model: role === "judge" ? "judge-test" : "sample-device", effort: null } : null, on_pass: IMPROVE_ROLES[i + 1] ?? null, on_fail: null,
      ...(role === "probe" ? { probe: { plan_gate: "accept" } } : {}),
    };
  });
  return { kind: "loop", id: "improve", title: "Improve", version: 1, profile: "improve-test", entry: "select", stages };
}
const JUDGE_SCHEMA = {
  kind: "schema", id: "judge-output", title: "Judge output",
  schema: {
    type: "object", additionalProperties: false, required: ["matches", "texts"],
    properties: {
      matches: { type: "array", items: { type: "object", additionalProperties: false, required: ["probe", "expected", "produced"], properties: { probe: { type: "string" }, expected: { type: "integer" }, produced: { type: ["string", "null"] } } } },
      texts: { type: "array", items: { type: "object", additionalProperties: false, required: ["probe", "verdict"], properties: { probe: { type: "string" }, verdict: { type: "string", enum: ["agrees", "partly", "disagrees"] } } } },
    },
  },
};
const profileOf = (judgeAgent: boolean) => ({
  kind: "profile", id: "improve-test", title: "Improve (test)", rules: "base-rules", framework: "intel-cycle", standard: "icd203",
  stages: Object.fromEntries((judgeAgent ? ["propose", "compose", "judge", "reflect"] : ["propose", "compose", "reflect"]).map((id) => [id, { agent: id === "judge" ? "judge" : "analyst", persona: "analyst", goal: `The ${id} stage of the test.` }])),
});

function rig(judgeAgent: boolean): Rig {
  const dir = mkdtempSync(join(tmpdir(), "improve-judge-"));
  const sample = sampleRoot(dir);
  writeFileSync(join(sample.root, "loops", "improve.yaml"), JSON.stringify(improveLoop(judgeAgent), null, 2));
  writeFileSync(join(sample.root, "context", "improve-test-profile.yaml"), JSON.stringify(profileOf(judgeAgent), null, 2));
  writeFileSync(join(sample.root, "context", "schemas", "judge-output.yaml"), JSON.stringify(JUDGE_SCHEMA, null, 2));
  const base = loadConfig({ env: {}, home: dir, repoRoot: dir });
  const config: Config = {
    ...base, data_dir: join(dir, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 },
    loops: { ...base.loops, store: join(dir, "wb", "loops"), imports: join(dir, "wb", "imported") },
  };
  const wb = Workbench.open(config.data_dir, { onError: () => {} });
  const r: Rig = { dir, wb, config, composed: compose(config, wb), sample, sessions: [], tasks: [], taskCalls: [] };
  rigs.push(r);
  return r;
}

const input = { title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: null, marking: "TLP:GREEN" as const };
const blobOf = (s: CaseSession, x: Json) => s.blobs.put(canonical(x));

/** A task case: published product 1 with a known answer holding one expected finding, `claims` of them when given. */
function taskCase(r: Rig, i: number, claims: ExpectedFinding[] | null = null, text = `${CANARY} the host beacons, task ${i + 1}`): CaseSession {
  const s = r.wb.createCase(input, human);
  r.sessions.push(s);
  const draft: Draft = { n: 1, hash: sha256Hex(canonical(productOf([finding("f1", `the draft of task ${i + 1}`)]) as never)), author: assembler, product: productOf([finding("f1", `the draft of task ${i + 1}`)]), reason: "first" };
  s.commit(() => [
    { type: "draft.revised", actor: assembler, payload: { draft } },
    { type: "product.published", actor: human, payload: { n: 1, draft_hash: draft.hash, head_hash: "b".repeat(64), dir: "products/1", bundle: { blob: "c".repeat(64), bytes: 10 } } },
  ]);
  setKnownAnswer(s, secrets, { product: 1, text, findings: claims ?? [{ claim: CLAIMS[i]!, likelihood: "likely", confidence: "high" }], marking: "TLP:GREEN", actor: human }, SCALE);
  r.tasks.push(s);
  return s;
}

/** A host that gives the task cases of the rig and counts how often it is asked. */
function hostOf(r: Rig): ImproveHost {
  const no = (what: string) => (): never => { throw new Error(`the Judge does not call ${what}`); };
  return {
    tasks: no("tasks"), stage: no("stage"), check: no("check"), staged: no("staged"), clear: () => {},
    task: (ref: TaskRef): TaskView | null => {
      r.taskCalls.push(ref.case);
      const s = r.tasks.find((t) => t.id === ref.case);
      if (s === undefined || s.entries(0, 1)[0]!.hash !== ref.origin) return null;
      return { ref, state: s.state, head: s.head(), entries: (from, to) => s.entries(from, to) };
    },
    probes: { find: no("probes.find"), create: no("probes.create"), drive: no("probes.drive"), read: no("probes.read"), end: no("probes.end") },
  };
}

type Action = (env: StageEnv) => void;
const commitIn = (env: StageEnv, entries: (s: CaseSession, next: (kind: "change") => string) => EntryInput[]): void => {
  env.session.commit((st, ids) => entries(env.session, (kind) => ids.next(kind)).map((e) => ({ ...e, run: st.run.id, stage: env.stage.id })));
};

interface Record14 { outputs: Record<string, ProbeOutput>; chosen: boolean; candidate: boolean }
/** The record Select, Propose, Probe and Compose leave: n tasks, base and (when `candidate`) K1, each probe's output a blob, and the choice. */
function recorded(r: Rig, n: number, rec: Record14): Action {
  return (env) => commitIn(env, (s, next) => {
    const out: EntryInput[] = [
      {
        type: "improve.selected", actor: ENGINE,
        payload: { target: "investigation", version: 1, loop_hash: "a".repeat(64), lock: blobOf(s, { lock: 1 }), case_type: "unknown-device", scale: SCALE, left_out: [] },
      },
    ];
    for (let i = 0; i < n; i++) {
      const t = r.tasks[i]!;
      const a = t.state.answers["1"]!;
      out.push({
        type: "improve.task", actor: ENGINE,
        payload: {
          task: `T${i + 1}`, case: t.id, origin: t.entries(0, 1)[0]!.hash, head: { seq: t.head().seq, hash: t.head().hash }, product: { n: 1, draft_hash: a.draft_hash },
          answer: { seq: a.seq, hash: a.hash }, marking: "TLP:GREEN", inputs: blobOf(s, { inputs: i }), record: blobOf(s, { record: i }),
        },
      });
    }
    if (rec.candidate) {
      out.push(
        {
          type: "builder.proposed", actor: agentOf("propose"),
          payload: { change: next("change"), title: "Clearer research", why: "fewer misses", root: "sample", files: [{ path: "skills/a.md", kind: "skill", id: "a", before: "4".repeat(64), after: "5".repeat(64) }], bundle: blobOf(s, { bundle: 1 }) },
        },
        { type: "improve.candidate", actor: ENGINE, payload: { candidate: "K1", change: "chg-1", status: "staged", loop_hash: "b".repeat(64), lock: blobOf(s, { staged: 1 }), reason: "" } },
      );
    }
    const candidates = rec.candidate ? ["base", "K1"] : ["base"];
    for (const c of candidates) for (let i = 0; i < n; i++) {
      const probe = `${c}/T${i + 1}`;
      out.push({
        type: "probe.started", actor: ENGINE,
        payload: { probe, candidate: c, task: `T${i + 1}`, child: `CASE-${c}-${i}`, origin: "0a".repeat(32), loop_hash: "e".repeat(64), input_hash: "0b".repeat(32), budgets: { lookups: 60, tokens: 300000 } },
      });
    }
    for (const c of candidates) for (let i = 0; i < n; i++) {
      const probe = `${c}/T${i + 1}`;
      const o = rec.outputs[probe]!;
      out.push({
        type: "probe.finished", actor: ENGINE,
        payload: {
          probe, child: `CASE-${c}-${i}`, child_run: null, head: { seq: 5, hash: "5".repeat(64) }, outcome: o.outcome, reason: o.reason, draft_hash: o.draft_hash,
          output_hash: sha256Hex(canonical(o as unknown as Json)), output: blobOf(s, o as unknown as Json), lookups: 1, tokens: 10,
        },
      });
    }
    if (rec.chosen) out.push({ type: "compose.chosen", actor: agentOf("compose"), payload: { candidate: rec.candidate ? "K1" : null, why: "fewer misses", contrasts: blobOf(s, { contrasts: 1 }) } });
    return out;
  });
}

function runnersOf(actions: Partial<Record<string, Action>>, judge: StageRunner = judgeRunner): Partial<Record<Role, StageRunner>> {
  const out: Partial<Record<Role, StageRunner>> = {};
  for (const role of IMPROVE_ROLES) {
    out[role] = role === "judge" ? judge : async (env) => {
      actions[role]?.(env);
      return { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
    };
  }
  return out;
}

function improveCase(r: Rig, n: number): CaseSession {
  const s = r.wb.createCase(input, human, { loop: "improve" });
  r.sessions.push(s);
  s.commit(() => [{ type: "improve.requested", actor: human, payload: { target: "investigation", case_type: "unknown-device", tasks: n, candidates: 1 } }]);
  return s;
}
const turn = (actor: string, content: Json, when?: string[]): ScriptTurn => ({ actor, reply: { content: JSON.stringify(content) }, ...(when === undefined ? {} : { when }) });
const providersOf = (turns: ScriptTurn[], extra: ScriptTurn["reply"][] = []): Providers => {
  const script: Script = { id: "judge-test", turns: [...turns, ...extra.map((reply): ScriptTurn => ({ actor: "judge", reply }))] };
  return new Providers([new ScriptedProvider({ id: "scripted", scripts: [script, { id: "sample-device", turns: [] }] })]);
};

function engineFor(r: Rig, s: CaseSession, actions: Partial<Record<string, Action>>, providers?: Providers, host: ImproveHost = hostOf(r)): Engine {
  const deps: EngineDeps = { ...r.composed.deps, improve: host, ...(providers === undefined ? {} : { providers }) };
  const engine = Engine.open(s, deps, { runners: runnersOf(actions) });
  expect(engine.unusable).toBeNull();
  return engine;
}

/** Every output of the scenario: base matches only task 1; K1 matches all three. */
function scenario(): Record14 {
  const outputs: Record<string, ProbeOutput> = {};
  for (let i = 0; i < 3; i++) {
    outputs[`base/T${i + 1}`] = outputOf([finding("f1", i === 0 ? STATEMENTS[0]! : UNRELATED)]);
    outputs[`K1/T${i + 1}`] = outputOf([finding("f1", STATEMENTS[i]!)]);
  }
  return { outputs, chosen: true, candidate: true };
}
const requestsOf = (s: CaseSession) => s.entries().filter((e) => e.type === "model.request");

// ---- answersOf

test("answersOf reads each task's answer at the seq and hash Select recorded, though the person revised it since", async () => {
  const r = rig(false);
  for (let i = 0; i < 3; i++) taskCase(r, i);
  const s = improveCase(r, 3);
  const engine = engineFor(r, s, { select: recorded(r, 3, scenario()) });
  engine.start(human);
  await engine.advance();
  // the person revises task 1's answer after Select: the entry Select named is still the one read
  setKnownAnswer(r.tasks[0]!, secrets, { product: 1, text: "A revised answer.", findings: [{ claim: "a revised claim", likelihood: "unlikely", confidence: "low" }], marking: "TLP:GREEN", actor: human }, SCALE);
  const got = answersOf(s.state, hostOf(r));
  expect(Array.isArray(got)).toBe(true);
  const answers = got as AnswerCopy[];
  expect(answers.map((a) => a.task)).toEqual(["T1", "T2", "T3"]);
  expect(answers[0]!).toEqual({
    task: "T1", seq: s.state.improve.tasks.T1!.answer.seq, hash: s.state.improve.tasks.T1!.answer.hash, text: `${CANARY} the host beacons, task 1`,
    findings: [{ claim: CLAIMS[0]!, likelihood: "likely", confidence: "high" }], marking: "TLP:GREEN",
  });
  expect(answers[0]!.hash).not.toBe(r.tasks[0]!.state.answers["1"]!.hash);
});

test("a task that is not loaded, or whose ledger holds no such entry, is the sentence", async () => {
  const r = rig(false);
  taskCase(r, 0);
  const s = improveCase(r, 1);
  const engine = engineFor(r, s, { select: recorded(r, 1, { ...scenario(), outputs: { "base/T1": outputOf([finding("f1", UNRELATED)]), "K1/T1": outputOf([finding("f1", UNRELATED)]) } }) });
  engine.start(human);
  await engine.advance();
  const task = r.tasks[0]!;
  expect(answersOf(s.state, { task: () => null })).toBe(`task ${task.id} is not loaded; load it from the store so its known answer can be read`);
  // a task whose ledger holds no entry of that seq and hash
  const stale: Pick<ImproveHost, "task"> = {
    task: (ref) => ({ ref, state: task.state, head: task.head(), entries: () => task.entries().filter((e) => e.type !== "answer.known") }),
  };
  expect(answersOf(s.state, stale)).toBe(`the known answer Select named is not in ${task.id}'s ledger`);
});

test("a task whose known answer was withdrawn after Select is unscored, with the reason; its answer is not copied", async () => {
  const r = rig(false);
  for (let i = 0; i < 3; i++) taskCase(r, i);
  const s = improveCase(r, 3);
  // the person withdraws task 1's answer once Select has named it, before the Judge runs
  const withdraw = () => withdrawKnownAnswer(r.tasks[0]!, secrets, { product: 1, reason: "it was wrong", actor: human });
  const engine = engineFor(r, s, { select: recorded(r, 3, scenario()), compose: withdraw });
  engine.start(human);
  await engine.advance();
  expect(r.tasks[0]!.state.answers).toEqual({});
  const scored = s.state.improve.scored!;
  const answers = readAnswers(s.blobs.get(scored.answers.blob))!;
  expect(answers.map((a) => a.task)).toEqual(["T2", "T3"]);
  expect(JSON.stringify(answers)).not.toContain("task 1");
  const sheet = readScoreSheet(s.blobs.get(scored.scores.blob))!;
  expect(sheet.outputs.map((o) => o.probe)).toEqual(["base/T2", "base/T3", "K1/T2", "K1/T3"]);
  expect(scored.summary).toEqual([{ candidate: "base", score: 0, drafted: 2, tasks: 2 }, { candidate: "K1", score: 1000, drafted: 2, tasks: 2 }]);
  const fin = s.entries().find((x) => x.type === "stage.finished" && x.payload.stage === "judge")!;
  expect((fin.payload as { reason: string | null }).reason).toBe(`the known answer of task T1 (${r.tasks[0]!.id}) was withdrawn after Select; its outputs are unscored`);
});

// ---- the runner

test("the Judge stalls before Compose has chosen and reads no answer", async () => {
  const r = rig(false);
  for (let i = 0; i < 3; i++) taskCase(r, i);
  const s = improveCase(r, 3);
  const engine = engineFor(r, s, { select: recorded(r, 3, { ...scenario(), chosen: false }) });
  engine.start(human);
  const summary = await engine.advance();
  expect(summary.status).toBe("paused");
  expect(summary.pause_reason).toContain("the judge runs after Compose has chosen");
  expect(r.taskCalls).toEqual([]);
  expect(s.state.improve.scored).toBeNull();
  expect(s.entries().some((e) => e.type === "judge.scored")).toBe(false);
});

test("with a script stage every output is scored in code: the summary is base first, then the candidates", async () => {
  const r = rig(false);
  for (let i = 0; i < 3; i++) taskCase(r, i);
  const s = improveCase(r, 3);
  const engine = engineFor(r, s, { select: recorded(r, 3, scenario()) });
  engine.start(human);
  const done = await engine.advance();
  // K1 was chosen and has undecided files: the run goes on past the Judge to the adopt gate
  expect(done).toMatchObject({ status: "waiting", waiting: "adopt" });
  expect(s.state.improve.scored!.summary).toEqual([{ candidate: "base", score: 333, drafted: 3, tasks: 3 }, { candidate: "K1", score: 1000, drafted: 3, tasks: 3 }]);
  expect(s.state.improve.scored!.matcher).toBe("code");
  // one commit: judge.scored by the engine, in the Judge's stage
  const e = s.entries().find((x) => x.type === "judge.scored")!;
  expect(e.actor).toEqual(ENGINE);
  expect(e.stage).toBe("judge");
  expect(s.entries().filter((x) => x.type === "judge.scored").length).toBe(1);
  expect(requestsOf(s)).toEqual([]);
  const fin = s.entries().find((x) => x.type === "stage.finished" && x.payload.stage === "judge")!;
  expect(JSON.parse(s.blobs.text((fin.payload as { output: { blob: string } }).output.blob))).toMatchObject({ matcher: "code", reason: null, summary: s.state.improve.scored!.summary });
});

test("the answers blob and the sheet are blobs of the improve case, and the sheet is what scoreSheet gives for them", async () => {
  const r = rig(false);
  for (let i = 0; i < 3; i++) taskCase(r, i);
  const s = improveCase(r, 3);
  const sc = scenario();
  const engine = engineFor(r, s, { select: recorded(r, 3, sc) });
  engine.start(human);
  await engine.advance();
  const scored = s.state.improve.scored!;
  const answers = readAnswers(s.blobs.get(scored.answers.blob))!;
  const sheet = readScoreSheet(s.blobs.get(scored.scores.blob))!;
  expect(answers.map((a) => a.task)).toEqual(["T1", "T2", "T3"]);
  expect(answers[1]!.findings).toEqual([{ claim: CLAIMS[1]!, likelihood: "likely", confidence: "high" }]);
  const again = scoreSheet(
    ["base", "K1"].flatMap((c) => answers.map((a) => scoreOutput({ probe: `${c}/${a.task}`, candidate: c, task: a.task }, sc.outputs[`${c}/${a.task}`]!, a, SCALE))),
    SCALE, ["base", "K1"],
  );
  expect(sheet).toEqual(again);
  expect(sheet.outputs.map((o) => o.probe)).toEqual(["base/T1", "base/T2", "base/T3", "K1/T1", "K1/T2", "K1/T3"]);
  expect(sheet.summary).toEqual(scored.summary);
  // the blobs are in the improve case's own store and named by judge.scored
  expect(s.blobs.has(scored.answers.blob)).toBe(true);
  expect(s.blobs.has(scored.scores.blob)).toBe(true);
});

test("an incomplete output scores 0, and a candidate-less run judges the base alone", async () => {
  const r = rig(false);
  taskCase(r, 0);
  const s = improveCase(r, 1);
  const engine = engineFor(r, s, { select: recorded(r, 1, { outputs: { "base/T1": outputOf(null) }, chosen: true, candidate: false }) });
  engine.start(human);
  await engine.advance();
  expect(s.state.improve.scored!.summary).toEqual([{ candidate: "base", score: 0, drafted: 0, tasks: 1 }]);
});

// ---- the matcher model

/** One task, base output whose finding states the claim in other words; K1 the same words. */
function oneTask(r: Rig): Record14 {
  taskCase(r, 0, [{ claim: CLAIMS[0]!, likelihood: "likely", confidence: "high" }, { claim: "an unrelated second claim nobody states", likelihood: "likely", confidence: "high" }]);
  return {
    outputs: { "base/T1": outputOf([finding("f1", "the host calls out to a rare address on a timer"), finding("f2", "a second thing happened")]), "K1/T1": outputOf([finding("f1", STATEMENTS[0]!)]) },
    chosen: true, candidate: true,
  };
}

test("with an agent stage the model is asked only about what code left unmatched, and its matches are scored by code", async () => {
  const r = rig(true);
  const sc = oneTask(r);
  const s = improveCase(r, 1);
  const reply = { matches: [{ probe: "base/T1", expected: 0, produced: "f1" }], texts: [] };
  const engine = engineFor(r, s, { select: recorded(r, 1, sc) }, providersOf([turn("judge", reply)]));
  engine.start(human);
  const done = await engine.advance();
  expect(done).toMatchObject({ status: "waiting", waiting: "adopt" });
  const reqs = requestsOf(s);
  expect(reqs.length).toBe(1);
  expect(reqs[0]!.stage).toBe("judge");
  const asked = s.blobs.text((reqs[0]!.payload as { messages: { blob: string } }).messages.blob);
  // the base's unmatched claims and its findings by id are asked; K1's output had nothing left, so it is not
  expect(asked).toContain("base/T1");
  expect(asked).toContain("the host calls out to a rare address on a timer");
  expect(asked).toContain(CLAIMS[0]!);
  expect(asked).not.toContain("K1/T1");
  const sheet = readScoreSheet(s.blobs.get(s.state.improve.scored!.scores.blob))!;
  const base = sheet.outputs.find((o) => o.probe === "base/T1")!;
  expect(base.findings[0]).toMatchObject({ expected: 0, produced: "f1", by: "model", score: 1000 });
  expect(base.findings[1]).toMatchObject({ expected: 1, produced: null, by: null, score: 0 });
  expect(base.score).toBe(500);
  expect(base.left_over).toEqual(["f2"]);
  expect(s.state.improve.scored!.matcher).toBe("code+model");
  expect(s.state.improve.scored!.summary[0]).toEqual({ candidate: "base", score: 500, drafted: 1, tasks: 1 });
});

test("a model's match that names a finding the output does not have is dropped", async () => {
  const r = rig(true);
  const sc = oneTask(r);
  const s = improveCase(r, 1);
  const reply = {
    matches: [
      { probe: "base/T1", expected: 0, produced: "f9" }, { probe: "base/T9", expected: 0, produced: "f1" }, { probe: "base/T1", expected: 7, produced: "f1" },
      { probe: "base/T1", expected: 1, produced: null },
    ],
    texts: [{ probe: "base/T9", verdict: "agrees" }],
  };
  const engine = engineFor(r, s, { select: recorded(r, 1, sc) }, providersOf([turn("judge", reply)]));
  engine.start(human);
  await engine.advance();
  const sheet = readScoreSheet(s.blobs.get(s.state.improve.scored!.scores.blob))!;
  const base = sheet.outputs.find((o) => o.probe === "base/T1")!;
  expect(base.findings.map((f) => f.produced)).toEqual([null, null]);
  expect(base.score).toBe(0);
  expect(s.state.improve.scored!.matcher).toBe("code");
});

test("an answer with no expected finding is scored from the model's verdict on its text", async () => {
  const r = rig(true);
  taskCase(r, 0, [], `${CANARY} It was a scheduled health check.`);
  const s = improveCase(r, 1);
  const sc: Record14 = { outputs: { "base/T1": outputOf([finding("f1", "a health check ran")]), "K1/T1": outputOf([finding("f1", "a health check ran")]) }, chosen: true, candidate: true };
  const reply = { matches: [], texts: [{ probe: "base/T1", verdict: "partly" }, { probe: "K1/T1", verdict: "agrees" }] };
  const engine = engineFor(r, s, { select: recorded(r, 1, sc) }, providersOf([turn("judge", reply)]));
  engine.start(human);
  await engine.advance();
  const asked = s.blobs.text((requestsOf(s)[0]!.payload as { messages: { blob: string } }).messages.blob);
  expect(asked).toContain("a scheduled health check");
  expect(s.state.improve.scored!.summary).toEqual([{ candidate: "base", score: 500, drafted: 1, tasks: 1 }, { candidate: "K1", score: 1000, drafted: 1, tasks: 1 }]);
  expect(s.state.improve.scored!.matcher).toBe("code+model");
});

test("a script stage leaves an answer with no expected finding unscored", async () => {
  const r = rig(false);
  taskCase(r, 0, [], "It was a scheduled health check.");
  const s = improveCase(r, 1);
  const sc: Record14 = { outputs: { "base/T1": outputOf([finding("f1", "a health check ran")]), "K1/T1": outputOf([finding("f1", "a health check ran")]) }, chosen: true, candidate: true };
  const engine = engineFor(r, s, { select: recorded(r, 1, sc) });
  engine.start(human);
  await engine.advance();
  const sheet = readScoreSheet(s.blobs.get(s.state.improve.scored!.scores.blob))!;
  expect(sheet.outputs.map((o) => o.score)).toEqual([null, null]);
  expect(s.state.improve.scored!.summary).toEqual([{ candidate: "base", score: 0, drafted: 1, tasks: 1 }, { candidate: "K1", score: 0, drafted: 1, tasks: 1 }]);
});

test("a model that declines leaves the code's scores, matcher code, and a fixed reason (never the model's words) in the stage's output; the stage passes", async () => {
  const r = rig(true);
  const sc = oneTask(r);
  const s = improveCase(r, 1);
  const engine = engineFor(r, s, { select: recorded(r, 1, sc) }, providersOf([], [{ declined: `I will not compare these: ${CLAIMS[0]!}` }]));
  engine.start(human);
  const done = await engine.advance();
  expect(done).toMatchObject({ status: "waiting", waiting: "adopt" });
  expect(s.state.improve.scored!.matcher).toBe("code");
  expect(s.state.improve.scored!.summary).toEqual([{ candidate: "base", score: 0, drafted: 1, tasks: 1 }, { candidate: "K1", score: 500, drafted: 1, tasks: 1 }]);
  const fin = s.entries().find((x) => x.type === "stage.finished" && x.payload.stage === "judge")!;
  expect(fin.payload).toMatchObject({ outcome: "pass" });
  const out = JSON.parse(s.blobs.text((fin.payload as { output: { blob: string } }).output.blob)) as { reason: string; matcher: string };
  expect(out.matcher).toBe("code");
  expect(out.reason).toBe(MODEL_GAVE_NONE);
  // a decline that quotes a claim leaves it in no stage output or reason
  expect(JSON.stringify(fin.payload)).not.toContain(CLAIMS[0]!);
});

test("a model that errors leaves the code's scores too: the Judge never holds the run", async () => {
  const r = rig(true);
  const sc = oneTask(r);
  const s = improveCase(r, 1);
  const engine = engineFor(r, s, { select: recorded(r, 1, sc) }, providersOf([], [{ error: "the endpoint fell over" }]));
  engine.start(human);
  expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "adopt" });
  expect(s.state.improve.scored!.matcher).toBe("code");
});

test("the only model requests of the case that hold a claim or an answer's text are the Judge's", async () => {
  const r = rig(true);
  const sc = oneTask(r);
  const s = improveCase(r, 1);
  const engine = engineFor(r, s, { select: recorded(r, 1, sc) }, providersOf([turn("judge", { matches: [], texts: [] })]));
  engine.start(human);
  await engine.advance();
  const reqs = requestsOf(s);
  expect(reqs.length).toBeGreaterThan(0);
  const holding = reqs.filter((e) => {
    const m = s.blobs.text((e.payload as { messages: { blob: string } }).messages.blob);
    return m.includes(CLAIMS[0]!) || m.includes(CANARY);
  });
  expect(holding.length).toBe(reqs.length);
  expect(holding.every((e) => e.stage === "judge")).toBe(true);
  // nothing before the Judge's stage: no entry before judge started holds a claim in a blob it names
  const started = s.entries().find((x) => x.type === "stage.started" && x.payload.stage === "judge")!;
  for (const e of s.entries().filter((x) => x.seq < started.seq)) expect(JSON.stringify(e)).not.toContain(CANARY);
});

test("run again after the scores are recorded, the Judge reads nothing and writes nothing", async () => {
  const r = rig(false);
  for (let i = 0; i < 3; i++) taskCase(r, i);
  const s = improveCase(r, 3);
  const engine = engineFor(r, s, { select: recorded(r, 3, scenario()) });
  engine.start(human);
  await engine.advance();
  const scored = s.state.improve.scored!;
  const calls = r.taskCalls.length;
  expect(calls).toBeGreaterThan(0);
  const before = s.entries().length;
  // the runner itself, called again in the same run
  const env: StageEnv = {
    session: s, deps: { ...r.composed.deps, improve: hostOf(r) }, stage: r.composed.deps.loops!.current("improve")!.pipeline.stages.find((x) => x.id === "judge")!, attempt: 2,
    onNeedsBudget: async () => null,
  };
  const end = await judgeRunner(env);
  expect(end).toMatchObject({ kind: "finished", outcome: "pass" });
  expect(r.taskCalls.length).toBe(calls);
  expect(s.entries().length).toBe(before);
  expect(s.state.improve.scored).toEqual(scored);
});

test("matcherParts lists, per output, the claims code left unmatched by number and its findings by id", async () => {
  const r = rig(false);
  const sc = oneTask(r);
  const s = improveCase(r, 1);
  const copy: AnswerCopy[] = [{
    task: "T1", seq: 1, hash: "x", text: "the text", marking: "TLP:GREEN",
    findings: [{ claim: CLAIMS[0]!, likelihood: "likely", confidence: "high" }, { claim: "second claim here", likelihood: "likely", confidence: "high" }],
  }];
  const parts = matcherParts(s, copy, { "base/T1": sc.outputs["base/T1"]!, "K1/T1": sc.outputs["K1/T1"]!, "K1/T2": outputOf(null) });
  expect(parts.map((p) => p.id)).toEqual(["base/T1"]);
  const text = parts[0]!.text;
  expect(text).toContain(`0: ${CLAIMS[0]!}`);
  expect(text).toContain("1: second claim here");
  expect(text).toContain("f1: the host calls out to a rare address on a timer");
  expect(parts[0]!.marking).not.toBeNull();
});
