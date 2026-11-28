// Slice 14, Task 14: Reflect is given Compose's choice, the contrasts and the scores, never an answer's text or a claim, and files what its
// model answers as lesson proposals of the request's case type, from the improve case and its Reflect stage. Nothing is accepted.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { shared } from "../../src/core/lessons";
import type { CaseSession } from "../../src/core/session";
import type { AnswerCopy, Contrast, ScoreSheet } from "../../src/core/state";
import { strictest } from "../../src/core/types";
import type { Actor, Entry, EntryInput, Marking } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { Providers } from "../../src/agents/providers";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, MemoryHost, StageEnv, StageRunner } from "../../src/pipeline/engine";
import type { ImproveHost } from "../../src/pipeline/improve/host";
import { reflectParts } from "../../src/pipeline/improve/reflect";
import { IMPROVE_ROLES } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { storeHost } from "../../src/pipeline/memory";
import { sampleRoot } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
const ENGINE: Actor = { kind: "system", id: "engine" };
const agentOf = (stage: string): Actor => ({ kind: "agent", id: stage, stage, profile: "improve-test", model: "reflect-m", effort: null, where: "machine" });
const SECRET = "Zq7-placeholder-secret-58";
const CANARY = "CANARY-7f3e-answer-text";
const CLAIMS = ["Quarterly firmware beacons reach a parked registrar", "Badge readers misreport their vendor string"];
const ANSWER_TEXT = `The kiosk is a visitor's tablet. ${CANARY}`;

type Lesson = { title: string; text: string; triggers: Json[] };
const L1: Lesson = { title: "Read the lease table first", text: "The staged skill that read the lease table first drafted with fewer lookups and scored higher.", triggers: [{ observable: "address" }] };
const L2: Lesson = { title: "Name the device by its vendor prefix", text: "The probes that named the vendor prefix matched more expected findings.", triggers: [] };
const L3: Lesson = { title: "Stop after the inventory answers", text: "Both probes spent lookups after the inventory had answered; the scores did not change.", triggers: [] };
const answer = (...ls: Lesson[]): { content: string } => ({ content: JSON.stringify({ lessons: ls }) });

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let config: Config;
let wb: Workbench;
let composed: ReturnType<typeof compose>;
const sessions: CaseSession[] = [];

const TITLES: Record<string, string> = { select: "Select", propose: "Propose", probe: "Probe", compose: "Compose", judge: "Judge", reflect: "Reflect", adopt: "Adopt" };
/** The improve loop with seven inline stages; Reflect runs an agent with the lessons schema on the scripted model reflect-m. */
function improveLoop(): Record<string, Json> {
  const stages = IMPROVE_ROLES.map((role, i): Record<string, Json> => {
    const agent = role === "propose" || role === "compose" || role === "reflect";
    return {
      id: role, title: TITLES[role]!, order: i + 1, runs: agent ? "agent" : role === "adopt" ? "human" : "script", role, gate: role === "adopt" ? "adopt" : null, reviews: false,
      tools: [], schema: role === "reflect" ? "lessons-output" : null, model: agent ? { provider: "scripted", model: "reflect-m", effort: null } : null,
      on_pass: IMPROVE_ROLES[i + 1] ?? null, on_fail: null,
      ...(role === "probe" ? { probe: { plan_gate: "accept" } } : {}),
    };
  });
  return { kind: "loop", id: "improve", title: "Improve", version: 1, profile: "improve-test", entry: "select", stages };
}
const IMPROVE_PROFILE = {
  kind: "profile", id: "improve-test", title: "Improve (test)", rules: "base-rules", framework: "intel-cycle", standard: "icd203",
  stages: Object.fromEntries(["propose", "compose", "reflect"].map((id) => [id, { agent: "analyst", persona: "analyst", goal: `The ${id} stage of the test.` }])),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "improve-reflect-"));
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

function improveCase(marking: Marking = "TLP:GREEN"): CaseSession {
  const s = wb.createCase(
    { title: "Improve", asked: "Improve the investigation loop", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: null, marking },
    human, { loop: "improve" },
  );
  sessions.push(s);
  s.commit(() => [{ type: "improve.requested", actor: human, payload: { target: "investigation", case_type: "unknown-device", tasks: 1, candidates: 1 } }]);
  return s;
}

const host: ImproveHost = {
  tasks: () => [], task: () => null, staged: () => { throw new Error("no staging store"); }, stage: () => ({ ok: false, problems: ["not here"] }),
  check: () => { throw new Error("not here"); }, clear: () => {},
  probes: { find: () => null, create: () => { throw new Error("not here"); }, drive: () => { throw new Error("not here"); }, read: () => null, end: () => {} },
};

const put = (s: CaseSession, x: unknown) => s.blobs.put(canonical(x as Json));
const commitIn = (env: StageEnv, entries: (s: CaseSession, next: (kind: "change") => string) => EntryInput[]): void => {
  env.session.commit((st, ids) => entries(env.session, (kind) => ids.next(kind)).map((e) => ({ ...e, run: st.run.id, stage: env.stage.id })));
};
const output = (s: CaseSession, outcome: "drafted" | "incomplete") => put(s, {
  format: 1, outcome, reason: "", draft_hash: outcome === "drafted" ? "d".repeat(64) : null, product: null, stats: { lookups: 3, tokens: 900, model_calls: 2, stages: [] },
});

const CONTRASTS: Contrast[] = [{
  task: "T1", candidate: "K1", base: "drafted", now: "drafted", added: ["The kiosk leases its address each night"], removed: ["The address is unassigned"],
  changed: [{ statement: "The address belongs to a lobby kiosk", likelihood: ["likely", "very likely"], confidence: ["moderate", "high"] }], lookups: [7, 4], tokens: [9000, 6100],
}];
const ANSWERS: AnswerCopy[] = [{
  task: "T1", seq: 8, hash: "8".repeat(64), text: ANSWER_TEXT,
  findings: [{ claim: CLAIMS[0]!, likelihood: "likely", confidence: "high" }, { claim: CLAIMS[1]!, likelihood: "unlikely", confidence: "low" }], marking: "TLP:GREEN",
}];
const SHEET: ScoreSheet = {
  format: 1, scale: ["unlikely", "likely", "very likely"],
  outputs: [
    {
      probe: "base/T1", candidate: "base", task: "T1", outcome: "drafted", score: 375, text: null, left_over: ["The address is unassigned"],
      findings: [
        { expected: 0, produced: "The address belongs to a lobby kiosk", by: "code", similarity: 600, likelihood_distance: 0, confidence_distance: 500, score: 750 },
        { expected: 1, produced: null, by: null, similarity: null, likelihood_distance: null, confidence_distance: null, score: 0 },
      ],
    },
    {
      probe: "K1/T1", candidate: "K1", task: "T1", outcome: "drafted", score: 938, text: null, left_over: [],
      findings: [
        { expected: 0, produced: "The address belongs to a lobby kiosk", by: "code", similarity: 600, likelihood_distance: 500, confidence_distance: 0, score: 875 },
        { expected: 1, produced: "The kiosk leases its address each night", by: "model", similarity: 100, likelihood_distance: 0, confidence_distance: 0, score: 1000 },
      ],
    },
  ],
  summary: [{ candidate: "base", score: 375, drafted: 1, tasks: 1 }, { candidate: "K1", score: 938, drafted: 1, tasks: 1 }],
};

/** The six stages before Reflect, and Adopt when `adopt` is false, as runners writing the record later tasks write; Reflect is the real one. */
function runnersOf(opts: { scored?: boolean } = {}): Partial<Record<Role, StageRunner>> {
  const pass = async (): Promise<{ kind: "finished"; outcome: "pass"; draft_hash: null; output: null; reason: null }> => ({ kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null });
  const after = (act: (env: StageEnv) => void): StageRunner => async (env) => { act(env); return pass(); };
  return {
    select: after((env) => commitIn(env, (s) => [
      {
        type: "improve.selected", actor: ENGINE,
        payload: { target: "investigation", version: 1, loop_hash: composed.deps.loops!.current("investigation")!.pipeline.hash, lock: put(s, { lock: 1 }), case_type: "unknown-device", scale: SHEET.scale, left_out: [] },
      },
      {
        type: "improve.task", actor: ENGINE,
        payload: {
          task: "T1", case: "CASE-90", origin: "f".repeat(64), head: { seq: 9, hash: "9".repeat(64) }, product: { n: 1, draft_hash: "d".repeat(64) }, answer: { seq: 8, hash: "8".repeat(64) },
          marking: "TLP:GREEN", inputs: put(s, { inputs: 1 }), record: put(s, { record: 1 }),
        },
      },
    ])),
    propose: after((env) => commitIn(env, (s, next) => [
      {
        type: "builder.proposed", actor: agentOf("propose"),
        payload: {
          change: next("change"), title: "Read the lease table first", why: "fewer lookups", root: "sample",
          files: [{ path: "skills/a.md", kind: "skill", id: "a", before: "4".repeat(64), after: "5".repeat(64) }], bundle: put(s, { bundle: 1 }),
        },
      },
      { type: "improve.candidate", actor: ENGINE, payload: { candidate: "K1", change: "chg-1", status: "staged", loop_hash: "a1".repeat(32), lock: put(s, { staged: 1 }), reason: "" } },
    ])),
    probe: after((env) => commitIn(env, (s) => ["base", "K1"].flatMap((c, i): EntryInput[] => [
      {
        type: "probe.started", actor: ENGINE,
        payload: { probe: `${c}/T1`, candidate: c, task: "T1", child: `CASE-${70 + i}`, origin: "0a".repeat(32), loop_hash: "e".repeat(64), input_hash: "0b".repeat(32), budgets: { lookups: 60, tokens: 300000 } },
      },
      {
        type: "probe.finished", actor: ENGINE,
        payload: {
          probe: `${c}/T1`, child: `CASE-${70 + i}`, child_run: "run-1", head: { seq: 30, hash: "3".repeat(64) }, outcome: "drafted", reason: "", draft_hash: "d".repeat(64),
          output_hash: "c".repeat(64), output: output(s, "drafted"), lookups: 3, tokens: 900,
        },
      },
    ]))),
    compose: after((env) => commitIn(env, (s) => [{ type: "compose.chosen", actor: agentOf("compose"), payload: { candidate: "K1", why: "K1 drafted with fewer lookups", contrasts: put(s, CONTRASTS) } }])),
    judge: after((env) => {
      if (opts.scored === false) return;
      commitIn(env, (s) => [{ type: "judge.scored", actor: ENGINE, payload: { answers: put(s, ANSWERS), scores: put(s, SHEET), matcher: "code+model", summary: SHEET.summary } }]);
    }),
  };
}

interface Rig { s: CaseSession; engine: Engine; deps: EngineDeps }
function rig(s: CaseSession, replies: { content?: string; declined?: string; error?: string }[], opts: { scored?: boolean; memory?: MemoryHost | null } = {}): Rig {
  const deps: EngineDeps = {
    ...composed.deps, improve: host,
    providers: new Providers([new ScriptedProvider({ id: "scripted", scripts: [{ id: "reflect-m", turns: replies.map((reply) => ({ actor: "analyst", reply })) }] })]),
  };
  delete deps.memory;
  if (opts.memory !== null) {
    deps.memory = opts.memory ?? storeHost(() => wb.memory, { secrets: () => [SECRET], case_types: () => ["unknown-device"], observables: () => composed.deps.registry.types().map((t) => t.id) });
  }
  return { s, engine: Engine.open(s, deps, { runners: runnersOf(opts) }), deps };
}

const store = () => wb.memory.state;
/** The lessons filed from a case (the workbench's seed lessons are left out). */
const filed = () => store().order.map((id) => store().lessons[id]!).filter((l) => l.from.kind === "case");
const idOf = (title: string): string => filed().find((l) => l.title === title)!.id;
type Req = Extract<Entry, { type: "model.request" }>;
const requests = (s: CaseSession, stage = "reflect"): Req[] => s.entries().filter((e): e is Req => e.type === "model.request" && e.stage === stage);
type Finished = Extract<Entry, { type: "stage.finished" }>;
const ends = (s: CaseSession, stage = "reflect"): Finished[] => s.entries().filter((e): e is Finished => e.type === "stage.finished" && e.payload.stage === stage);
const outputOf = (s: CaseSession, e: Finished): unknown => (e.payload.output === null ? null : JSON.parse(s.blobs.text(e.payload.output.blob)));
const startedSeq = (s: CaseSession, stage = "reflect"): Entry => s.entries().findLast((e) => e.type === "stage.started" && e.payload.stage === stage)!;

test("Reflect's model is given the choice, the contrasts and the scores, and its lessons are filed as proposals of the request's case type from this case and stage", async () => {
  const s = improveCase();
  const r = rig(s, [answer(L1, L2)]);
  r.engine.start(human);
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "adopt" });
  const reqs = requests(s);
  expect(reqs).toHaveLength(1);
  const kinds = reqs[0]!.payload.pack.map((i) => i.kind);
  for (const k of ["improve-choice", "improve-contrasts", "improve-scores"]) expect(kinds).toContain(k);
  const sent = s.blobs.text(reqs[0]!.payload.messages.blob);
  expect(sent).toContain("What would make later unknown-device cases faster or more correct? Answer with at most 3 lessons, each from a difference between the probes that the scores bear out.");
  // the choice and its reason, the contrast in words, the summary and each output's score with its expected findings by number
  for (const words of ["K1", "K1 drafted with fewer lookups", "The kiosk leases its address each night", "The address is unassigned", "lookups 7 to 4", "base: 375", "K1: 938", "expected finding 1", "expected finding 2"]) {
    expect(sent).toContain(words);
  }
  const got = filed();
  expect(got.map((l) => l.title)).toEqual([L1.title, L2.title]);
  const started = startedSeq(s);
  for (const l of got) {
    expect(l.case_type).toBe("unknown-device");
    expect(l.from).toEqual({ kind: "case", case: s.id, origin: s.entries(0, 1)[0]!.hash, run: "run-1", head: { seq: started.seq, hash: started.hash }, product: null, stage: "reflect", model: true });
  }
  const end = ends(s).at(-1)!;
  expect(end.payload.outcome).toBe("pass");
  expect(end.payload.reason).toBeNull();
  expect(outputOf(s, end)).toEqual({ lessons: [{ lesson: idOf(L1.title), title: L1.title, fresh: true }, { lesson: idOf(L2.title), title: L2.title, fresh: true }], dropped: [] });
});

test("a lesson is marked at least as strictly as the improve case; none is accepted", async () => {
  const s = improveCase("TLP:AMBER");
  const r = rig(s, [answer(L1, L3)]);
  r.engine.start(human);
  await r.engine.advance();
  const got = filed();
  expect(got).toHaveLength(2);
  const req = requests(s)[0]!;
  for (const l of got) {
    expect(l.marking).toBe(strictest("TLP:AMBER", req.payload.marking));
    expect(strictest(l.marking, "TLP:AMBER")).toBe(l.marking);
    expect(l.status).toBe("proposed");
  }
  const ours = got.map((l) => l.id);
  expect(shared(store()).filter((l) => ours.includes(l.id))).toEqual([]);
  expect(wb.memory.entries().filter((e) => e.type === "lesson.accepted" && ours.includes((e.payload as { lesson: string }).lesson))).toEqual([]);
});

test("Reflect's pack holds no known answer's text and no claim: the canary and each claim are in no model.request of the stage", async () => {
  const s = improveCase();
  const r = rig(s, [answer(L1)]);
  r.engine.start(human);
  await r.engine.advance();
  expect(s.state.improve.scored).not.toBeNull();
  const reqs = requests(s);
  expect(reqs.length).toBeGreaterThan(0);
  const forbidden = [CANARY, ANSWER_TEXT, ...CLAIMS];
  for (const req of reqs) {
    const sent = s.blobs.text(req.payload.messages.blob);
    for (const f of forbidden) expect(sent).not.toContain(f);
  }
  // the parts themselves, as the stage builds them from the improve case
  for (const p of reflectParts(s)) for (const f of forbidden) expect(`${p.title}\n${p.text}`).not.toContain(f);
  // and the stage's output
  const out = ends(s).at(-1)!.payload.output;
  if (out !== null) for (const f of forbidden) expect(s.blobs.text(out.blob)).not.toContain(f);
});

test("a lesson that is not a lesson is dropped with its reason; a lesson holding a secret value is dropped and not named by its title", async () => {
  const s = improveCase();
  const empty: Lesson = { title: "Nothing to say", text: "", triggers: [] };
  const leaky: Lesson = { title: `Use ${SECRET} to read the lease table`, text: "The lease table needs a login.", triggers: [] };
  const r = rig(s, [answer(empty, leaky, L1)]);
  r.engine.start(human);
  await r.engine.advance();
  expect(filed().map((l) => l.title)).toEqual([L1.title]);
  const end = ends(s).at(-1)!;
  const out = outputOf(s, end) as { lessons: unknown[]; dropped: { title: string; why: string }[] };
  expect(out.dropped).toHaveLength(2);
  expect(out.dropped[0]!.title).toBe(empty.title);
  expect(out.dropped[0]!.why).toStartWith("a lesson needs text of 1 to");
  expect(out.dropped[1]).toEqual({ title: "lesson 2 of the answer", why: "the lesson holds a secret value" });
  expect(s.blobs.text(end.payload.output!.blob)).not.toContain(SECRET);
  expect(JSON.stringify(wb.memory.entries())).not.toContain(SECRET);
});

test("a model that declines files nothing and the stage passes with the reason", async () => {
  const s = improveCase();
  const r = rig(s, [{ declined: "the model would not answer" }]);
  r.engine.start(human);
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "adopt" });
  expect(filed()).toEqual([]);
  const end = ends(s).at(-1)!;
  expect(end.payload.outcome).toBe("pass");
  expect(end.payload.reason).toStartWith("no lessons were proposed: ");
});

test("a workbench with no memory store files nothing and the stage passes with the reason; the model is not asked", async () => {
  const s = improveCase();
  const r = rig(s, [answer(L1)], { memory: null });
  r.engine.start(human);
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "adopt" });
  expect(requests(s)).toEqual([]);
  const end = ends(s).at(-1)!;
  expect(end.payload.outcome).toBe("pass");
  expect(end.payload.reason).toBe("this workbench has no memory store here");
});

test("Reflect stalls when this run has no scores", async () => {
  const s = improveCase();
  const r = rig(s, [answer(L1)], { scored: false });
  r.engine.start(human);
  const summary = await r.engine.advance();
  expect(summary).toMatchObject({ status: "paused", current: "reflect" });
  expect(summary.pause_reason).toContain("the judge has not scored this run");
  expect(requests(s)).toEqual([]);
  expect(filed()).toEqual([]);
});

test("a stage run again files nothing twice", async () => {
  const s = improveCase();
  const r = rig(s, [answer(L1, L2, L3), answer(L1, L2, L3)]);
  const real = r.deps.memory!;
  let calls = 0;
  // the first lesson is filed, and the process stops before the second
  r.deps.memory = { read: () => real.read(), propose: (d, f) => { calls++; if (calls === 2) throw new Error("the process stopped"); return real.propose(d, f); } };
  r.engine.start(human);
  expect(await r.engine.advance()).toMatchObject({ status: "paused" });
  expect(ends(s)).toEqual([]);
  expect(filed().map((l) => l.title)).toEqual([L1.title]);
  r.deps.memory = real;
  expect(await r.engine.resume(human)).toMatchObject({ status: "waiting", waiting: "adopt" });
  expect(filed().map((l) => l.title)).toEqual([L1.title, L2.title, L3.title]);
  expect(outputOf(s, ends(s).at(-1)!)).toEqual({
    lessons: [{ lesson: idOf(L1.title), title: L1.title, fresh: false }, { lesson: idOf(L2.title), title: L2.title, fresh: true }, { lesson: idOf(L3.title), title: L3.title, fresh: true }],
    dropped: [],
  });
});

test("no file under src/pipeline/improve imports src/core/memstore.ts", () => {
  const at = join(import.meta.dir, "..", "..", "src", "pipeline", "improve");
  const files = readdirSync(at).filter((f) => f.endsWith(".ts"));
  expect(files).toContain("reflect.ts");
  for (const f of files) {
    const text = readFileSync(join(at, f), "utf8");
    expect(text).not.toMatch(/from\s+["'][^"']*core\/memstore["']/);
    expect(text).not.toContain("memstore");
  }
});
