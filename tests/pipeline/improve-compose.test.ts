// Slice 14, Task 12: Compose picks the candidate the contrasts support, or none.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { Providers } from "../../src/agents/providers";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import type { Script, ScriptReply } from "../../src/agents/providers/scripted";
import { compose } from "../../src/cli/compose";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { REDACTED } from "../../src/core/redact";
import type { CaseSession } from "../../src/core/session";
import type { CaseState } from "../../src/core/state";
import { initialImprove, readContrasts } from "../../src/core/state/improve";
import type { Contrast, ProbeOutput } from "../../src/core/state/improve";
import type { Actor, Entry, EntryInput, Finding, Product } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnd, StageEnv, StageRunner } from "../../src/pipeline/engine";
import { WHY_MAX, composeParts, composeRunner, contrastsOf } from "../../src/pipeline/improve/compose";
import { IMPROVE_ROLES } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { sampleRoot } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
const ENGINE: Actor = { kind: "system", id: "engine" };
const agentOf = (stage: string): Actor => ({ kind: "agent", id: stage, stage, profile: "improve-test", model: "compose-run", effort: null, where: "machine" });
const SECRET = "tok-9f8e7d6c5b4a3921";
const CANARY = "CANARY-known-answer-3c1d";

// ---------- pure contrasts

const hex = (c: string): string => c.repeat(64);
const finding = (statement: string, likelihood = "likely", confidence: Finding["confidence"] = "moderate"): Finding => (
  { id: "F1", statement, likelihood, confidence, confidence_basis: "b", cites: ["c1"], assumptions: [], reasoning: "r" }
);
const product = (findings: Finding[], over: Partial<Product> = {}): Product => ({
  objective: "o", question: "Who is behind the traffic?", marking: "TLP:GREEN", summary: "sum", key_findings: findings, gaps_and_limits: "gaps", alternatives: "alt",
  assessment: "assess", sources: [], assumptions: [], change: "", ...over,
});
const stats = (lookups: number, tokens: number): ProbeOutput["stats"] => ({ lookups, tokens, model_calls: 2, stages: [{ id: "frame", status: "passed", attempts: 1 }] });
const drafted = (findings: Finding[], lookups = 10, tokens = 1000, over: Partial<Product> = {}): ProbeOutput => (
  { format: 1, outcome: "drafted", reason: "", draft_hash: hex("d"), product: product(findings, over), stats: stats(lookups, tokens) }
);
const incomplete = (reason: string): ProbeOutput => ({ format: 1, outcome: "incomplete", reason, draft_hash: null, product: null, stats: stats(3, 50) });

/** The part of a state contrastsOf reads: the tasks and the staged candidates, in order. */
function stateOf(tasks: string[], candidates: string[]): CaseState {
  const improve = initialImprove();
  improve.task_order = tasks;
  improve.candidate_order = candidates;
  for (const k of candidates) improve.candidates[k] = { candidate: k, change: "chg-1", status: "staged", loop_hash: hex("a"), lock: null, reason: "", seq: 1 };
  return { improve } as unknown as CaseState;
}

test("contrastsOf lists the findings a candidate added, removed and changed against the base, per task, and the lookups and tokens of both", () => {
  const outputs: Record<string, ProbeOutput> = {
    "base/T1": drafted([finding("The host beacons hourly"), finding("The host is a printer", "likely", "high")], 12, 1200),
    "K1/T1": drafted([finding("the host beacons hourly  ", "unlikely", "moderate"), finding("The host talks to a rare domain")], 20, 2500),
    "base/T2": drafted([finding("Same on both")], 5, 500),
    "K1/T2": drafted([finding("Same on both")], 6, 600),
  };
  const got = contrastsOf(stateOf(["T1", "T2"], ["K1"]), outputs);
  expect(got).toEqual([
    {
      task: "T1", candidate: "K1", base: "drafted", now: "drafted", added: ["The host talks to a rare domain"], removed: ["The host is a printer"],
      changed: [{ statement: "the host beacons hourly", likelihood: ["likely", "unlikely"], confidence: null }], lookups: [12, 20], tokens: [1200, 2500],
    },
    { task: "T2", candidate: "K1", base: "drafted", now: "drafted", added: [], removed: [], changed: [], lookups: [5, 6], tokens: [500, 600] },
  ] satisfies Contrast[]);
  // a changed confidence is a pair too
  const c = contrastsOf(stateOf(["T1"], ["K1"]), { "base/T1": drafted([finding("X", "likely", "low")]), "K1/T1": drafted([finding("x", "likely", "high")]) });
  expect(c[0]!.changed).toEqual([{ statement: "x", likelihood: null, confidence: ["low", "high"] }]);
});

test("a candidate whose output is the base's has an empty contrast", () => {
  const same = drafted([finding("A finding"), finding("Another", "unlikely", "low")]);
  const [c] = contrastsOf(stateOf(["T1"], ["K1"]), { "base/T1": same, "K1/T1": structuredClone(same) });
  expect(c).toMatchObject({ added: [], removed: [], changed: [], lookups: [10, 10], tokens: [1000, 1000] });
  const [d] = contrastsOf(stateOf(["T1"], ["K1"]), { "base/T1": incomplete("it waits"), "K1/T1": incomplete("it waits") });
  expect(d).toMatchObject({ base: "incomplete", now: "incomplete", added: [], removed: [], changed: [] });
});

test("an incomplete base and a drafted candidate is a contrast that says so", () => {
  const [c] = contrastsOf(stateOf(["T1"], ["K1"]), { "base/T1": incomplete("its run was stopped"), "K1/T1": drafted([finding("Found it")]) });
  expect(c).toMatchObject({ base: "incomplete", now: "drafted", added: ["Found it"], removed: [], changed: [] });
  const [d] = contrastsOf(stateOf(["T1"], ["K1"]), { "base/T1": drafted([finding("Found it")]), "K1/T1": incomplete("it waits") });
  expect(d).toMatchObject({ base: "drafted", now: "incomplete", added: [], removed: ["Found it"] });
  // in words
  const parts = composeParts(sessionStub(), { "base/T1": incomplete("its run was stopped"), "K1/T1": drafted([finding("Found it")]) }, [c!]);
  const text = parts.find((p) => p.kind === "contrasts")!.text;
  expect(text).toContain("base gave no draft");
  expect(text).toContain("K1 gave a draft");
});

test("contrastsOf is the same whatever order the outputs are given in", () => {
  const entries: [string, ProbeOutput][] = [
    ["base/T1", drafted([finding("a"), finding("b")])], ["K1/T1", drafted([finding("b"), finding("c")])], ["K2/T1", drafted([finding("a", "unlikely")])],
    ["base/T2", incomplete("x")], ["K1/T2", drafted([finding("d")])], ["K2/T2", incomplete("y")],
  ];
  const state = stateOf(["T1", "T2"], ["K1", "K2"]);
  const forward = contrastsOf(state, Object.fromEntries(entries));
  const reversed = contrastsOf(state, Object.fromEntries([...entries].reverse()));
  expect(reversed).toEqual(forward);
  expect(forward.map((c) => `${c.candidate}/${c.task}`)).toEqual(["K1/T1", "K2/T1", "K1/T2", "K2/T2"]);
  expect(contrastsOf(state, Object.fromEntries(entries))).toEqual(forward);
});

/** A session stand-in for composeParts when no blob is read: parts of the outputs and the contrasts need only the case's marking and the tasks. */
function sessionStub(): CaseSession {
  const state = stateOf(["T1"], ["K1"]);
  return { state: { ...state, meta: { marking: "TLP:GREEN" } }, entries: () => [], blobs: { get: () => { throw new Error("no blob"); } } } as unknown as CaseSession;
}

// ---------- the stage

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let config: Config;
let wb: Workbench;
let composed: ReturnType<typeof compose>;
const sessions: CaseSession[] = [];

const TITLES: Record<string, string> = { select: "Select", propose: "Propose", probe: "Probe", compose: "Compose", judge: "Judge", reflect: "Reflect", adopt: "Adopt" };
function improveLoop(): Record<string, Json> {
  const stages = IMPROVE_ROLES.map((role, i): Record<string, Json> => {
    const agent = role === "propose" || role === "compose" || role === "reflect";
    return {
      id: role, title: TITLES[role]!, order: i + 1, runs: agent ? "agent" : role === "adopt" ? "human" : "script", role, gate: role === "adopt" ? "adopt" : null, reviews: false,
      tools: [], schema: role === "compose" ? "compose-output" : null, model: agent ? { provider: "scripted", model: "compose-run", effort: null } : null,
      on_pass: IMPROVE_ROLES[i + 1] ?? null, on_fail: null, ...(role === "probe" ? { probe: { plan_gate: "accept" } } : {}),
    };
  });
  return { kind: "loop", id: "improve", title: "Improve", version: 1, profile: "improve-test", entry: "select", stages };
}
const IMPROVE_PROFILE = {
  kind: "profile", id: "improve-test", title: "Improve (test)", rules: "base-rules", framework: "intel-cycle", standard: "icd203",
  stages: Object.fromEntries(["propose", "compose", "reflect"].map((id) => [id, { agent: id, persona: "analyst", goal: `The ${id} stage of the test.` }])),
};
const COMPOSE_SCHEMA = {
  kind: "schema", id: "compose-output", title: "Compose output",
  schema: { type: "object", additionalProperties: false, required: ["choice", "why"], properties: { choice: { type: "string" }, why: { type: "string" } } },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "improve-compose-"));
  sample = sampleRoot(dir);
  writeFileSync(join(sample.root, "loops", "improve.yaml"), JSON.stringify(improveLoop(), null, 2));
  writeFileSync(join(sample.root, "context", "improve-test-profile.yaml"), JSON.stringify(IMPROVE_PROFILE, null, 2));
  writeFileSync(join(sample.root, "context", "schemas", "compose-output.yaml"), JSON.stringify(COMPOSE_SCHEMA, null, 2));
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
const say = (x: unknown): ScriptReply => ({ content: JSON.stringify(x) });
const put = (s: CaseSession, x: Json) => s.blobs.put(canonical(x));

interface Setup {
  /** staged candidates by id; a name in `dropped` is a candidate that was dropped */
  staged: string[]; dropped?: string[]; tasks: string[]; outputs: Record<string, ProbeOutput>; unfinished?: string[];
}
/** The record Select, Propose and Probe leave in the improve case, written in the run's own commits. */
function recordOf(setup: Setup, env: StageEnv, stageId: string): void {
  const s = env.session;
  const entry = (e: EntryInput): EntryInput => ({ ...e, run: s.state.run.id, stage: stageId } as EntryInput);
  if (stageId === "select") {
    s.commit(() => [
      entry({ type: "improve.selected", actor: ENGINE, payload: { target: "investigation", version: 1, loop_hash: "e".repeat(64), lock: put(s, { lock: 1 }), case_type: "unknown-device", scale: ["unlikely", "likely"], left_out: [] } }),
      ...setup.tasks.map((t, i) => entry({
        type: "improve.task", actor: ENGINE,
        payload: {
          task: t, case: `CASE-9${i}`, origin: "f".repeat(64), head: { seq: 9, hash: "9".repeat(64) }, product: { n: 1, draft_hash: "d".repeat(64) }, answer: { seq: 8, hash: "8".repeat(64) },
          marking: "TLP:GREEN", inputs: put(s, { question: `Question of ${t}: who is behind the traffic?`, starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN", title: `Task ${t}` }),
          record: put(s, { product: product([]) as unknown as Json, stages: [], queries: [], questions: 0, sendbacks: 0, usage: { input: 0, output: 0, calls: 0 } }),
        },
      })),
    ]);
  } else if (stageId === "propose") {
    const all = [...setup.staged, ...(setup.dropped ?? [])].sort();
    if (all.length === 0) return;
    s.commit((st, ids) => {
      const out: EntryInput[] = [];
      for (const k of all) {
        const change = ids.next("change");
        out.push(entry({
          type: "builder.proposed", actor: agentOf("propose"),
          payload: { change, title: `Change ${k}`, why: "fewer misses", root: "sample", files: [{ path: `skills/${k}.md`, kind: "skill", id: k, before: "4".repeat(64), after: "5".repeat(64) }], bundle: put(s, { bundle: k }) },
        }));
        const staged = setup.staged.includes(k);
        out.push(entry({
          type: "improve.candidate", actor: ENGINE,
          payload: { candidate: k, change, status: staged ? "staged" : "dropped", loop_hash: staged ? "a1".repeat(32) : null, lock: staged ? put(s, { staged: k }) : null, reason: staged ? "" : "it did not resolve" },
        }));
      }
      void st;
      return out;
    });
  } else if (stageId === "probe") {
    const ids = ["base", ...setup.staged].flatMap((k) => setup.tasks.map((t) => `${k}/${t}`));
    s.commit(() => ids.flatMap((id) => {
      const [candidate, task] = id.split("/") as [string, string];
      const out: EntryInput[] = [entry({
        type: "probe.started", actor: ENGINE,
        payload: { probe: id, candidate, task, child: `CASE-7${id.length}`, origin: "0a".repeat(32), loop_hash: "e".repeat(64), input_hash: "0b".repeat(32), budgets: { lookups: 60, tokens: 300000 } },
      })];
      if (!(setup.unfinished ?? []).includes(id)) {
        const o = setup.outputs[id]!;
        out.push(entry({
          type: "probe.finished", actor: ENGINE,
          payload: {
            probe: id, child: `CASE-7${id.length}`, child_run: null, head: { seq: 9, hash: "9".repeat(64) }, outcome: o.outcome, reason: o.reason, draft_hash: o.draft_hash,
            output_hash: "7".repeat(64), output: put(s, o as unknown as Json), lookups: o.stats.lookups, tokens: o.stats.tokens,
          },
        }));
      }
      return out;
    }));
  }
}

/** Runs an improve case through its seven stages with the real Compose; the other roles write the record or pass. */
async function run(setup: Setup, scripts: ReplyScript, opts: { secrets?: string[] } = {}) {
  const s = wb.createCase(input, human, { loop: "improve" });
  sessions.push(s);
  s.commit(() => [{ type: "improve.requested", actor: human, payload: { target: "investigation", case_type: "unknown-device", tasks: setup.tasks.length, candidates: Math.max(1, setup.staged.length) } }]);
  const calls: string[] = [];
  const atJudge: { chosen: string | null | undefined } = { chosen: undefined };
  const runners: Partial<Record<Role, StageRunner>> = {};
  for (const role of IMPROVE_ROLES) {
    runners[role] = async (env): Promise<StageEnd> => {
      calls.push(role);
      if (role === "compose") return composeRunner(env);
      recordOf(setup, env, role);
      if (role === "judge") atJudge.chosen = env.session.state.improve.chosen === null ? undefined : env.session.state.improve.chosen.candidate;
      return { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
    };
  }
  const script: Script[] = [{ id: "compose-run", turns: scripts.map((reply) => ({ actor: "compose", reply })) }];
  const deps: EngineDeps = {
    ...composed.deps, providers: new Providers([new ScriptedProvider({ id: "scripted", scripts: script })]),
    runner: { ...composed.deps.runner, secrets: () => opts.secrets ?? [] },
  };
  const engine = Engine.open(s, deps, { runners });
  expect(engine.unusable).toBeNull();
  engine.start(human);
  const summary = await engine.advance();
  return { s, calls, summary, engine, atJudge };
}
type ReplyScript = ScriptReply[];
const requests = (s: CaseSession): Extract<Entry, { type: "model.request" }>[] => s.entries().filter((e): e is Extract<Entry, { type: "model.request" }> => e.type === "model.request");
const messagesOf = (s: CaseSession, r: Entry): string => (JSON.parse(s.blobs.text((r as Extract<Entry, { type: "model.request" }>).payload.messages.blob)) as { messages: { content: string }[] }).messages.map((m) => m.content).join("\n");

const TWO_TASKS: Setup = {
  staged: ["K1", "K2"], dropped: ["K3"], tasks: ["T1", "T2"],
  outputs: {
    "base/T1": drafted([finding("The host beacons hourly")], 12, 1200), "K1/T1": drafted([finding("The host beacons hourly"), finding("It resolves a rare domain")], 14, 1500),
    "K2/T1": incomplete("it waits for a person at its plan gate"), "base/T2": incomplete("its run was stopped"), "K1/T2": drafted([finding("It resolves a rare domain")]),
    "K2/T2": drafted([finding("Something else", "unlikely", "low")]),
  },
};

test("Compose's model is given each task's question, each probe's output and the contrasts, and its choice is recorded with its reason and the contrasts blob", async () => {
  const { s, atJudge, calls } = await run(TWO_TASKS, [say({ choice: "K1", why: "K1 found the rare domain on both tasks" })]);
  expect(calls.slice(0, 4)).toEqual(["select", "propose", "probe", "compose"]);
  const [req] = requests(s);
  expect(requests(s)).toHaveLength(1);
  const text = messagesOf(s, req!);
  expect(text).toContain("Question of T1: who is behind the traffic?");
  expect(text).toContain("Question of T2: who is behind the traffic?");
  for (const id of ["base/T1", "K1/T1", "K2/T1", "base/T2", "K1/T2", "K2/T2"]) expect(text).toContain(id);
  expect(text).toContain("The host beacons hourly");
  expect(text).toContain("It resolves a rare domain");
  expect(text).toContain("it waits for a person at its plan gate");
  expect(text).toContain("assess");
  expect(text).toContain("Pick the one candidate the differences support across the tasks, or none. Say why from the differences. You are not told which answer is right.");
  expect(text).toContain("base");
  const chosen = s.entries().filter((e) => e.type === "compose.chosen");
  expect(chosen).toHaveLength(1);
  const c = chosen[0] as Extract<Entry, { type: "compose.chosen" }>;
  expect(c.actor).toMatchObject({ kind: "agent", id: "compose", stage: "compose" });
  expect(c.payload).toMatchObject({ candidate: "K1", why: "K1 found the rare domain on both tasks" });
  const contrasts = readContrasts(s.blobs.get(c.payload.contrasts.blob))!;
  expect(contrasts).toEqual(contrastsOf(s.state, Object.fromEntries(s.state.improve.probe_order.map((p) => [p, JSON.parse(s.blobs.text(s.state.improve.probes[p]!.finished!.output.blob)) as ProbeOutput]))));
  expect(contrasts.map((x) => `${x.candidate}/${x.task}`)).toEqual(["K1/T1", "K2/T1", "K1/T2", "K2/T2"]);
  expect(s.state.improve.chosen?.candidate).toBe("K1");
  // the choice was in the ledger before the Judge ran
  expect(atJudge.chosen).toBe("K1");
  const seqs = s.entries();
  expect(seqs.findIndex((e) => e.type === "compose.chosen")).toBeLessThan(seqs.findIndex((e) => e.type === "stage.started" && e.payload.stage === "judge"));
  // the parts carry the improve case's marking
  const outs = Object.fromEntries(s.state.improve.probe_order.map((p) => [p, JSON.parse(s.blobs.text(s.state.improve.probes[p]!.finished!.output.blob)) as ProbeOutput]));
  const parts = composeParts(s, outs, contrasts);
  expect(parts.map((p) => p.marking)).toEqual(parts.map(() => "TLP:GREEN"));
  expect(parts.map((p) => p.kind)).toEqual(["task", "task", ...Array(6).fill("probe"), "contrasts"]);
  expect(req!.payload.pack.filter((i) => i.kind === "probe")).toHaveLength(6);
});

test("the schema the model is held to names only the staged candidates and none", async () => {
  const { s } = await run(TWO_TASKS, [say({ choice: "none", why: "no clear gain" })]);
  const text = messagesOf(s, requests(s)[0]!);
  expect(text).toContain("Reply with one JSON object that matches this schema");
  expect(text).toMatch(/"enum":\s*\[\s*"K1",\s*"K2",\s*"none"\s*\]/);
  expect(text).not.toMatch(/"enum":\s*\[[^\]]*"K3"/);
});

test("an answer naming a dropped candidate is re-asked once and then stalls the stage", async () => {
  const bad = say({ choice: "K3", why: "the dropped one" });
  const { s, summary } = await run(TWO_TASKS, [bad, bad]);
  expect(requests(s)).toHaveLength(2);
  expect(s.entries().filter((e) => e.type === "compose.chosen")).toEqual([]);
  expect(s.state.improve.chosen).toBeNull();
  const stalled = s.entries().filter((e) => e.type === "stage.finished").pop() as Extract<Entry, { type: "stage.finished" }> | undefined;
  expect(summary.status).not.toBe("finished");
  expect(`${summary.pause_reason ?? ""} ${stalled?.payload.reason ?? ""}`).toContain("Compose's output failed its schema twice");
});

test("none is a choice: compose.chosen has candidate null and the model's reason", async () => {
  const { s } = await run(TWO_TASKS, [say({ choice: "none", why: "the differences do not agree across tasks" })]);
  const c = s.entries().find((e) => e.type === "compose.chosen") as Extract<Entry, { type: "compose.chosen" }>;
  expect(c.payload.candidate).toBeNull();
  expect(c.payload.why).toBe("the differences do not agree across tasks");
  expect(s.state.improve.chosen).toMatchObject({ candidate: null, why: "the differences do not agree across tasks" });
});

test("with no staged candidate the engine records none and calls no model", async () => {
  const setup: Setup = { staged: [], dropped: ["K1"], tasks: ["T1"], outputs: { "base/T1": drafted([finding("A finding")]) } };
  const { s, summary, calls } = await run(setup, []);
  expect(requests(s)).toEqual([]);
  const c = s.entries().find((e) => e.type === "compose.chosen") as Extract<Entry, { type: "compose.chosen" }>;
  expect(c.actor).toEqual(ENGINE);
  expect(c.payload).toMatchObject({ candidate: null, why: "no candidate was staged" });
  expect(readContrasts(s.blobs.get(c.payload.contrasts.blob))).toEqual([]);
  expect(calls).toEqual([...IMPROVE_ROLES]);
  expect(summary).toMatchObject({ status: "finished", outcome: "completed" });
});

test("Compose's pack holds no known answer and no score: the canary is in no model.request of the stage", async () => {
  // a known answer's text and an expected claim sit in the improve case's blobs, named by no entry Compose reads; no score exists before the Judge
  const { s } = await (async () => {
    const r = await run(TWO_TASKS, [say({ choice: "K1", why: "it did better" })]);
    return r;
  })();
  s.blobs.put(canonical({ text: CANARY, findings: [{ claim: `${CANARY} claim` }] }));
  for (const r of requests(s)) {
    const text = messagesOf(s, r);
    expect(text).not.toContain(CANARY);
    expect(text).not.toMatch(/score|known answer|expected finding/i);
    expect(r.payload.pack.map((i) => i.kind).filter((k) => k === "answer" || k === "score")).toEqual([]);
  }
  expect(s.state.improve.scored).toBeNull();
  // and the file reads no answer and no score
  const source = readFileSync(join(import.meta.dir, "..", "..", "src", "pipeline", "improve", "compose.ts"), "utf8");
  for (const word of ["knownAnswerOf", "state.answers", "improve.scored", "judge.ts", "answers.ts"]) expect(source).not.toContain(word);
});

test("a secret value in the model's reason is written redacted", async () => {
  const { s } = await run(TWO_TASKS, [say({ choice: "K1", why: `K1 is better; the token was ${SECRET} in a lookup` })], { secrets: [SECRET] });
  const c = s.entries().find((e) => e.type === "compose.chosen") as Extract<Entry, { type: "compose.chosen" }>;
  expect(c.payload.why).toBe(`K1 is better; the token was ${REDACTED} in a lookup`);
  expect(s.state.improve.chosen?.why).not.toContain(SECRET);
});

test("a reason is cut at WHY_MAX", async () => {
  expect(WHY_MAX).toBe(2000);
  const { s } = await run(TWO_TASKS, [say({ choice: "none", why: "w".repeat(WHY_MAX + 500) })]);
  const c = s.entries().find((e) => e.type === "compose.chosen") as Extract<Entry, { type: "compose.chosen" }>;
  expect(c.payload.why.length).toBeLessThanOrEqual(WHY_MAX);
  expect(c.payload.why.length).toBeGreaterThan(WHY_MAX - 10);
});

test("a probe that has not finished stalls Compose and no model is called", async () => {
  const { s, summary } = await run({ ...TWO_TASKS, unfinished: ["K2/T2"] }, [say({ choice: "K1", why: "x" })]);
  expect(requests(s)).toEqual([]);
  expect(s.state.improve.chosen).toBeNull();
  expect(summary.status).not.toBe("finished");
  const stalled = `${summary.pause_reason ?? ""} ${s.entries().filter((e) => e.type === "stage.finished").map((e) => (e.type === "stage.finished" ? e.payload.reason ?? "" : "")).join(" ")}`;
  expect(stalled).toContain("K2/T2");
});

test("run again after the choice is recorded, Compose calls no model", async () => {
  const { s } = await run(TWO_TASKS, [say({ choice: "K1", why: "first" })]);
  expect(requests(s)).toHaveLength(1);
  // Compose run a second time, as a restarted run would, on a session whose record already holds the choice
  const again = await runComposeAgain(s);
  expect(again).toMatchObject({ kind: "finished", outcome: "pass" });
  expect(requests(s)).toHaveLength(1);
  expect(s.entries().filter((e) => e.type === "compose.chosen")).toHaveLength(1);
});

/** Compose run a second time, as a restarted run would, on a session whose record already holds the choice. */
async function runComposeAgain(s: CaseSession): Promise<StageEnd> {
  const loop = composed.deps.loops!.current("improve")!;
  const stage = loop.pipeline.stages.find((x) => x.role === "compose")!;
  const env: StageEnv = { session: s, deps: { ...composed.deps, pipeline: loop.pipeline, profile: loop.profile }, stage, attempt: 2, onNeedsBudget: async () => null };
  return composeRunner(env);
}
