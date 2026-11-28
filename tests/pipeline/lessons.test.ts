// Slice 13, Task 10: the Feedback stage asks once, after the publish, what would have made the case faster or more correct, and files each
// answer as a proposal from the case. It never accepts: a lesson is shared only by a person. A published run never waits on lessons.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { shared } from "../../src/core/lessons";
import type { CaseSession } from "../../src/core/session";
import { latestDraft } from "../../src/core/state";
import type { Actor, Entry, Marking, Product } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { loadProfile } from "../../src/agents/context";
import { Providers } from "../../src/agents/providers";
import type { Provider } from "../../src/agents/providers/types";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import { loadConfig } from "../../src/modules/config";
import type { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, MemoryHost, StageEnd, StageRunner } from "../../src/pipeline/engine";
import { MOP_IDS } from "../../src/pipeline/feedback";
import { LESSONS_QUESTION, MAX_PROPOSED, lessonFloor } from "../../src/pipeline/lessons";
import { loadPipeline } from "../../src/pipeline/manifests";
import type { Role, StageManifest } from "../../src/pipeline/manifests";
import { storeHost } from "../../src/pipeline/memory";
import { feedbackRunner } from "../../src/pipeline/stages/feedback";
import { publishRunner } from "../../src/pipeline/stages/publish";
import { PLAN, START, WINDOW, person } from "../helpers/tools-fixture";
import { sampleRoot } from "../helpers/sample-root";

const planner: Actor = { kind: "agent", id: "planner", stage: "plan", profile: "investigation", model: "m", effort: null, where: "machine" };
const PASS: Extract<StageEnd, { kind: "finished" }> = { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
const SECRET = "Zq7-placeholder-secret-41";
const TYPES = [{ id: "unknown-device", title: "Unknown device", about: "A device on the network that no inventory names." }];
const SCHEMA = [
  "kind: schema",
  "id: lessons-output",
  "title: Lessons output",
  'schema: {"type": "object", "additionalProperties": false, "required": ["lessons"], "properties": {"lessons": {"type": "array", "maxItems": 3, "items": {"type": "object", "additionalProperties": false, "required": ["title", "text", "triggers"], "properties": {"title": {"type": "string"}, "text": {"type": "string"}, "triggers": {"type": "array", "items": {"type": "object"}}}}}}}',
  "",
].join("\n");

type Lesson = { title: string; text: string; triggers: Json[] };
const L1: Lesson = { title: "Read the lease table first", text: "The lobby lease table names a device before the flows do; it would have saved two queries here.", triggers: [{ observable: "address" }] };
const L2: Lesson = { title: "Ask the inventory owner early", text: "An unnamed device on AP-3 was a visitor's; asking first would have closed the case sooner.", triggers: [{ finding: "unknown device" }] };
const L3: Lesson = { title: "Check the reputation last", text: "Reputation said nothing an internal source did not; run it after the internal pivots.", triggers: [] };
const answer = (...ls: Lesson[]): { content: string } => ({ content: JSON.stringify({ lessons: ls }) });

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let registry: Registry;
let wb: Workbench;
const sessions: CaseSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lessons-"));
  sample = sampleRoot(dir);
  writeFileSync(join(sample.root, "context", "schemas", "lessons-output.yaml"), SCHEMA);
  const profile = join(sample.root, "context", "profile.yaml");
  writeFileSync(profile, `${readFileSync(profile, "utf8")}  feedback:\n    agent: reviewer\n    persona: evaluator\n    goal: Say what would have made this case faster or more correct.\n`);
  registry = loadRegistry([{ path: sample.root, trusted: true, credentials: [] }]);
  wb = Workbench.open(join(dir, "wb"), { onError: () => {} });
  sessions.length = 0;
});
afterEach(() => {
  for (const s of sessions) if (s.open) expect(s.state.skipped).toEqual([]);
  try { wb.close(); } catch { /* closed */ }
  sample.close();
  rmSync(dir, { recursive: true, force: true });
});

function newCase(opts: { type?: string | null; marking?: Marking } = {}): CaseSession {
  const type = opts.type === undefined ? "unknown-device" : opts.type;
  const s = wb.createCase(
    { title: "t", asked: "Who is behind 198.51.100.77?", why: "w", starting: [{ type: "address", value: START }], window: WINDOW, objective: null, marking: opts.marking ?? "TLP:GREEN" },
    person, type === null ? {} : { type },
  );
  sessions.push(s);
  return s;
}
const product = (marking: Marking): Product => ({
  objective: "o", question: "q", marking, summary: "s", key_findings: [], gaps_and_limits: "", alternatives: "", assessment: "", sources: [], assumptions: [], change: "c",
});

interface Rig { s: CaseSession; engine: Engine; deps: EngineDeps; feedback: StageManifest }
/** An engine over the case whose stages before Publish are code, Publish and Feedback real; Feedback runs an agent when `agent` is true. */
function rig(s: CaseSession, reviewer: { content?: string; declined?: string; error?: string; tool_calls?: { tool: string; args: Record<string, Json> }[] }[], opts: { agent?: boolean; productMarking?: Marking; memory?: MemoryHost | null } = {}): Rig {
  const { pipeline } = loadPipeline(registry);
  const agent = opts.agent ?? true;
  const stages = pipeline!.stages.map((st) => (st.role !== "feedback" || !agent ? st : {
    ...st, runs: "agent" as const, schema: "lessons-output", tools: ["list_cards", "read_card"] as StageManifest["tools"], model: { provider: "scripted", model: "feedback-m", effort: null },
  }));
  const deps: EngineDeps = {
    config: loadConfig({ env: {}, home: dir, repoRoot: dir }), registry, runner: sample.deps, seeker: sample.seeker,
    providers: new Providers([new ScriptedProvider({ id: "scripted", scripts: [
      { id: "sample-run", turns: [{ actor: "publisher", reply: { content: JSON.stringify({ title: "T", note: "" }) } }] },
      { id: "feedback-m", turns: reviewer.map((reply) => ({ actor: "reviewer", reply })) },
    ] })]),
    pipeline: { ...pipeline!, stages }, profile: loadProfile(registry, "investigation"), case_types: TYPES,
  };
  if (opts.memory !== null) {
    deps.memory = opts.memory ?? storeHost(() => wb.memory, { secrets: () => [SECRET], case_types: () => TYPES.map((t) => t.id), observables: () => registry.types().map((t) => t.id) });
  }
  const pass = (): StageEnd => ({ ...PASS, draft_hash: latestDraft(s.state)?.hash ?? null });
  const p = product(opts.productMarking ?? "TLP:GREEN");
  const runners: Partial<Record<Role, StageRunner>> = {
    frame: async () => PASS,
    plan: async () => { s.commit((_st, ids) => [{ type: "plan.proposed", actor: planner, payload: { plan: PLAN(ids.next("plan")) } }]); return PASS; },
    research: async () => PASS,
    assemble: async () => {
      const hash = sha256Hex(canonical(p as unknown as Json));
      s.commit((st) => [{ type: "draft.revised", actor: planner, payload: { draft: { n: st.drafts.length + 1, hash, author: planner, product: p, reason: "r" } } }]);
      return { ...PASS, draft_hash: hash };
    },
    checks: async () => pass(), evaluate: async () => pass(), challenge: async () => pass(),
    publish: publishRunner, feedback: feedbackRunner,
  };
  return { s, engine: new Engine(s, deps, { runners }), deps, feedback: stages.find((st) => st.role === "feedback")! };
}
/** Runs the case to its publish gate and approves; Feedback has not started. */
async function toApproved(r: Rig): Promise<void> {
  r.engine.start(person);
  await r.engine.advance();
  r.s.commit(() => [
    { type: "plan.accepted", actor: person, payload: { plan: r.s.state.plan.current!.id, steps: ["s1"], budgets: {} } },
    { type: "gate.passed", actor: person, payload: { gate: "plan" } },
  ]);
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  r.engine.approve({ actor: person });
}
const store = () => wb.memory.state;
const filed = () => store().order.map((id) => store().lessons[id]!);
type Req = Extract<Entry, { type: "model.request" }>;
const requests = (s: CaseSession): Req[] => s.entries().filter((e): e is Req => e.type === "model.request" && e.stage === "feedback");
type Finished = Extract<Entry, { type: "stage.finished" }>;
const feedbackEnds = (s: CaseSession): Finished[] => s.entries().filter((e): e is Finished => e.type === "stage.finished" && e.payload.stage === "feedback");
const outputOf = (s: CaseSession, e: Finished): unknown => (e.payload.output === null ? null : JSON.parse(s.blobs.text(e.payload.output.blob)));
const measures = (s: CaseSession) => s.entries().filter((e) => e.type === "feedback.recorded");

// ---- Step 1

test("a Feedback stage that runs no agent records the measures and proposes nothing, as before", async () => {
  const s = newCase();
  const r = rig(s, [answer(L1)], { agent: false });
  await toApproved(r);
  expect(await r.engine.advance()).toMatchObject({ status: "finished", outcome: "published" });
  expect(measures(s)).toHaveLength(MOP_IDS.length);
  expect(requests(s)).toEqual([]);
  expect(feedbackEnds(s).map((e) => [e.payload.outcome, e.payload.output, e.payload.reason])).toEqual([["pass", null, null]]);
  expect(store().count).toBe(0);
});

test("a Feedback stage that runs an agent asks once after the publish and files each lesson as a proposal from the case", async () => {
  const s = newCase();
  const r = rig(s, [answer(L1, L2)]);
  await toApproved(r);
  expect(requests(s)).toEqual([]);
  expect(await r.engine.advance()).toMatchObject({ status: "finished", outcome: "published" });
  expect(measures(s)).toHaveLength(MOP_IDS.length);
  const reqs = requests(s);
  expect(reqs).toHaveLength(1);
  const published = s.entries().find((e) => e.type === "product.published")!;
  expect(reqs[0]!.seq).toBeGreaterThan(published.seq);
  expect(s.blobs.text(reqs[0]!.payload.messages.blob)).toContain(LESSONS_QUESTION);
  expect(s.blobs.text(reqs[0]!.payload.messages.blob)).toContain("Answer with at most 3 lessons for later cases of type unknown-device (Unknown device).");
  expect(filed()).toHaveLength(2);
  const l = filed()[0]!;
  expect(l).toMatchObject({ status: "proposed", case_type: "unknown-device", from: { kind: "case", case: "CASE-1", run: "run-1", product: { n: 1 }, stage: "feedback", model: true } });
  expect(l).toMatchObject({ title: L1.title, text: L1.text, triggers: L1.triggers, supersedes: null });
  expect(s.id).toBe("CASE-1");
  const started = s.entries().filter((e) => e.type === "stage.started" && e.payload.stage === "feedback").at(-1)!;
  expect(l.from).toEqual({
    kind: "case", case: "CASE-1", origin: s.entries()[0]!.hash, run: "run-1", head: { seq: started.seq, hash: started.hash },
    product: { n: 1, draft_hash: latestDraft(s.state)!.hash }, stage: "feedback", model: true,
  });
  // filed by the workbench, never by the model
  expect(wb.memory.entries().map((e) => e.actor)).toEqual([{ kind: "system", id: "feedback" }, { kind: "system", id: "feedback" }]);
});

test("nothing is accepted: every lesson filed is proposed, and shared() is empty", async () => {
  const s = newCase();
  const r = rig(s, [answer(L1, L2, L3)]);
  await toApproved(r);
  await r.engine.advance();
  expect(filed().map((l) => l.status)).toEqual(["proposed", "proposed", "proposed"]);
  expect(shared(store())).toEqual([]);
  expect(wb.memory.entries().map((e) => e.type)).toEqual(["lesson.proposed", "lesson.proposed", "lesson.proposed"]);
  // the code that proposes never reaches the store itself, and has no way to accept
  for (const f of ["src/pipeline/lessons.ts", "src/pipeline/stages/feedback.ts"]) {
    const text = readFileSync(join(import.meta.dir, "..", "..", f), "utf8");
    expect(text).not.toContain("memstore");
    expect(text).not.toMatch(/\.accept\(|lesson\.accepted/);
  }
});

test("the lesson's marking is the strictest of the case, the product and the stage's model requests", async () => {
  // a GREEN case whose product is AMBER: AMBER
  const s = newCase();
  const r = rig(s, [answer(L1)], { productMarking: "TLP:AMBER" });
  await toApproved(r);
  await r.engine.advance();
  expect(s.state.meta!.marking).toBe("TLP:GREEN");
  expect(filed()[0]!.marking).toBe("TLP:AMBER");
  expect(lessonFloor(s, "feedback")).toBe("TLP:AMBER");
  // a case marked AMBER whose product is GREEN is AMBER too, and a request marked RED in the pass makes it RED
  const s2 = newCase({ marking: "TLP:AMBER" });
  const r2 = rig(s2, [answer(L1)]);
  await toApproved(r2);
  await r2.engine.advance();
  expect(filed()[1]!.marking).toBe("TLP:AMBER");
  const req = requests(s2).at(-1)!;
  expect(req.payload.marking).toBe("TLP:AMBER");
  // the floor reads each request of the stage pass: one marked RED (as the case's own pass would record it) raises it
  s2.commit(() => [{ type: "stage.started", actor: { kind: "system", id: "engine" }, run: "run-1", stage: "feedback", payload: { stage: "feedback", attempt: 9 } }]);
  expect(lessonFloor(s2, "feedback")).toBe("TLP:AMBER");
  s2.commit((_st, ids) => [{ type: "model.request", actor: req.actor, run: "run-1", stage: "feedback", payload: { ...req.payload, request: ids.next("request"), marking: "TLP:RED" } }]);
  expect(lessonFloor(s2, "feedback")).toBe("TLP:RED");
});

test("a lesson with no text, with a trigger that is not one, or naming an observable type that is not loaded is dropped with its reason and the others are filed", async () => {
  const s = newCase();
  const noText: Lesson = { title: "No text", text: "  ", triggers: [] };
  const badTrigger: Lesson = { title: "Bad trigger", text: "Something useful.", triggers: [{ colour: "blue" }] };
  const unknown: Lesson = { title: "Unknown type", text: "Something useful.", triggers: [{ observable: "toaster" }] };
  const r = rig(s, [{ content: JSON.stringify({ lessons: [noText, L1, badTrigger] }) }, answer(unknown)]);
  await toApproved(r);
  await r.engine.advance();
  expect(filed().map((l) => l.title)).toEqual([L1.title]);
  const out = outputOf(s, feedbackEnds(s).at(-1)!) as { dropped: { title: string; why: string }[] };
  expect(out.dropped).toEqual([
    { title: "No text", why: "a lesson needs text of 1 to 1200 characters" },
    { title: "Bad trigger", why: "a trigger is { observable: <type> }, { source: <id> } or { finding: <3 to 200 characters> }" },
  ]);
  // a second case: the store refuses an observable type that is not loaded
  const s2 = newCase();
  const r2 = rig(s2, [answer(unknown)]);
  await toApproved(r2);
  await r2.engine.advance();
  expect((outputOf(s2, feedbackEnds(s2).at(-1)!) as { dropped: unknown }).dropped).toEqual([{ title: "Unknown type", why: '"toaster" is not an observable type here' }]);
  expect(filed()).toHaveLength(1);
});

test("more than three lessons fail the schema; the stage passes with: no lessons were proposed", async () => {
  expect(MAX_PROPOSED).toBe(3);
  const s = newCase();
  const four = answer(L1, L2, L3, { ...L3, title: "A fourth" });
  const r = rig(s, [four, four]);
  await toApproved(r);
  expect(await r.engine.advance()).toMatchObject({ status: "finished", outcome: "published" });
  const end = feedbackEnds(s).at(-1)!;
  expect(end.payload.outcome).toBe("pass");
  expect(end.payload.reason).toStartWith("no lessons were proposed: Feedback's output failed its schema twice");
  expect(store().count).toBe(0);
});

test("the stage's output lists what was filed and what was dropped, and is the stage.finished output of the case", async () => {
  const s = newCase();
  const r = rig(s, [answer(L1, { title: "Empty", text: "", triggers: [] }, L2)]);
  await toApproved(r);
  await r.engine.advance();
  const ends = feedbackEnds(s);
  expect(ends).toHaveLength(1);
  expect(ends[0]!.payload).toMatchObject({ outcome: "pass", reason: null });
  expect(outputOf(s, ends[0]!)).toEqual({
    lessons: [{ lesson: "LESSON-1", title: L1.title, fresh: true }, { lesson: "LESSON-2", title: L2.title, fresh: true }],
    dropped: [{ title: "Empty", why: "a lesson needs text of 1 to 1200 characters" }],
  });
});

test("a case with no type, and a run that did not publish, ask the model nothing", async () => {
  const s = newCase({ type: null });
  const r = rig(s, [answer(L1)]);
  await toApproved(r);
  expect(await r.engine.advance()).toMatchObject({ status: "finished", outcome: "published" });
  expect(requests(s)).toEqual([]);
  expect(feedbackEnds(s).map((e) => e.payload.output)).toEqual([null]);
  // a run that did not publish: Feedback run by hand before the publish asks nothing
  const s2 = newCase();
  const r2 = rig(s2, [answer(L1)]);
  r2.engine.start(person);
  const end = await feedbackRunner({ session: s2, deps: r2.deps, stage: r2.feedback, attempt: 1, onNeedsBudget: async () => null });
  expect(end).toEqual({ kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null });
  expect(requests(s2)).toEqual([]);
  // and with no memory store here, nothing is asked either
  const s3 = newCase();
  const r3 = rig(s3, [answer(L1)], { memory: null });
  await toApproved(r3);
  await r3.engine.advance();
  expect(requests(s3)).toEqual([]);
  expect(feedbackEnds(s3).at(-1)!.payload).toMatchObject({ outcome: "pass", reason: "this workbench has no memory store here" });
  expect(store().count).toBe(0);
});

// ---- Step 5: a published run never waits on lessons

test("a model that errors, declines or is blocked at Feedback: the stage passes with the reason, the run finishes published, nothing is filed", async () => {
  const declined = newCase();
  const r1 = rig(declined, [{ declined: "I will not write lessons" }]);
  await toApproved(r1);
  expect(await r1.engine.advance()).toMatchObject({ status: "finished", outcome: "published" });
  expect(feedbackEnds(declined).at(-1)!.payload).toMatchObject({ outcome: "pass", reason: "no lessons were proposed: I will not write lessons" });

  const errored = newCase();
  const r2 = rig(errored, [{ error: "the endpoint fell over" }, { error: "the endpoint fell over" }]);
  await toApproved(r2);
  expect(await r2.engine.advance()).toMatchObject({ status: "finished", outcome: "published" });
  const e2 = feedbackEnds(errored).at(-1)!.payload;
  expect(e2.outcome).toBe("pass");
  expect(e2.reason).toStartWith("no lessons were proposed: Feedback: ");
  expect(e2.reason).toContain("the endpoint fell over");

  const blocked = newCase();
  const r3 = rig(blocked, [answer(L1)]);
  await toApproved(r3);
  r3.deps.config = { ...r3.deps.config, marking_policy: { ...r3.deps.config.marking_policy, "TLP:GREEN": [] } };
  expect(await r3.engine.advance()).toMatchObject({ status: "finished", outcome: "published" });
  expect(feedbackEnds(blocked).at(-1)!.payload).toMatchObject({ outcome: "pass", reason: "no lessons were proposed: the stage's model may not receive data marked TLP:GREEN" });

  for (const s of [declined, errored, blocked]) expect(measures(s)).toHaveLength(MOP_IDS.length);
  expect(store().count).toBe(0);
});

test("a person pauses during Feedback and resumes: the measures are recorded once and each lesson is filed once", async () => {
  const s = newCase();
  const r = rig(s, [{ tool_calls: [{ tool: "list_cards", args: {} }] }, answer(L1, L2)]);
  const inner = r.deps.providers.get("scripted")!;
  let paused = false;
  const pausing: Provider = {
    id: inner.id, kind: inner.kind, where: inner.where, models: () => inner.models(), body: (q) => inner.body(q),
    turn: async (q) => {
      const got = await inner.turn(q);
      if (q.key === "reviewer" && !paused) { paused = true; r.engine.pause(person); }
      return got;
    },
  };
  r.deps.providers = new Providers([pausing]);
  await toApproved(r);
  expect(await r.engine.advance()).toMatchObject({ status: "paused" });
  expect(paused).toBe(true);
  expect(feedbackEnds(s)).toEqual([]);
  expect(measures(s)).toHaveLength(MOP_IDS.length);
  expect(await r.engine.resume(person)).toMatchObject({ status: "finished", outcome: "published" });
  expect(measures(s)).toHaveLength(MOP_IDS.length);
  expect(filed().map((l) => l.title)).toEqual([L1.title, L2.title]);
  expect(feedbackEnds(s)).toHaveLength(1);
});

test("the process stops after one lesson was filed and before the stage finished: the resumed stage files the rest and not the first again", async () => {
  const s = newCase();
  const r = rig(s, [answer(L1, L2, L3), answer(L1, L2, L3)]);
  const real = r.deps.memory!;
  let calls = 0;
  // the store is reached, the first lesson is filed, and the process stops before the second
  r.deps.memory = { read: () => real.read(), propose: (d, f) => { calls++; if (calls === 2) throw new Error("the process stopped"); return real.propose(d, f); } };
  await toApproved(r);
  expect(await r.engine.advance()).toMatchObject({ status: "paused" });
  expect(feedbackEnds(s)).toEqual([]);
  expect(filed().map((l) => l.title)).toEqual([L1.title]);
  r.deps.memory = real;
  expect(await r.engine.resume(person)).toMatchObject({ status: "finished", outcome: "published" });
  expect(filed().map((l) => l.title)).toEqual([L1.title, L2.title, L3.title]);
  expect(outputOf(s, feedbackEnds(s).at(-1)!)).toEqual({
    lessons: [{ lesson: "LESSON-1", title: L1.title, fresh: false }, { lesson: "LESSON-2", title: L2.title, fresh: true }, { lesson: "LESSON-3", title: L3.title, fresh: true }],
    dropped: [],
  });
  expect(measures(s)).toHaveLength(MOP_IDS.length);
});

test("a lesson holding a secret value is dropped: the lesson holds a secret value", async () => {
  const s = newCase();
  const leaky: Lesson = { title: `Use ${SECRET} to log in`, text: "The lease table needs a login.", triggers: [] };
  const leakyText: Lesson = { title: "Log in to the lease table", text: `The password is ${SECRET}.`, triggers: [] };
  const r = rig(s, [answer(leaky, L1, leakyText)]);
  await toApproved(r);
  await r.engine.advance();
  expect(filed().map((l) => l.title)).toEqual([L1.title]);
  const end = feedbackEnds(s).at(-1)!;
  const out = outputOf(s, end) as { dropped: { title: string; why: string }[] };
  expect(out.dropped.map((d) => d.why)).toEqual(["the lesson holds a secret value", "the lesson holds a secret value"]);
  // the stage's output does not repeat the value, and nothing in the store holds it
  expect(s.blobs.text(end.payload.output!.blob)).not.toContain(SECRET);
  expect(JSON.stringify(wb.memory.entries())).not.toContain(SECRET);
});

test("the Feedback agent's requests are in the case's ledger with their packs, like any stage's", async () => {
  const s = newCase();
  const r = rig(s, [answer(L1)]);
  await toApproved(r);
  await r.engine.advance();
  const reqs = requests(s);
  expect(reqs).toHaveLength(1);
  const req = reqs[0]!;
  expect(req.actor).toMatchObject({ kind: "agent", id: "reviewer", stage: "feedback", model: "feedback-m" });
  expect(req.run).toBe("run-1");
  const kinds = req.payload.pack.map((i) => i.kind);
  expect(kinds).toContain("draft");
  expect(kinds).toContain("case");
  expect(kinds).toContain("schema");
  expect(req.payload.tools).toEqual(["list_cards", "read_card"]);
  expect(s.entries().some((e) => e.type === "model.response" && e.payload.request === req.payload.request)).toBe(true);
});
