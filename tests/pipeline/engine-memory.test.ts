// Slice 13, Task 9: the engine binds the lessons code selected into a run, and a person sets a case's type. With no type set at creation, Frame
// asks the person a blocking question proposing one (controller ruling 3): the run waits after Frame, and Plan is given the lessons of the type
// the person confirms.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import { readMemoryLock } from "../../src/core/lessons";
import type { LessonDraft, MemoryLock } from "../../src/core/lessons";
import type { CaseSession } from "../../src/core/session";
import { fold } from "../../src/core/state";
import type { Actor, Entry, Marking } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { memoryParts } from "../../src/agents/memory";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { Engine, RunRefused } from "../../src/pipeline/engine";
import type { MemoryHost } from "../../src/pipeline/engine";
import { memoryUses } from "../../src/pipeline/loops";
import { CASE_TYPE_WHY, storeHost } from "../../src/pipeline/memory";
import { noteMemory } from "../../src/pipeline/notes";
import { sampleRoot } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
const code: Actor = { kind: "system", id: "engine" };
const TYPES = "kind: case-types\nid: sample-types\ntypes:\n  - { id: unknown-device, title: Unknown device, about: A device on the network that no inventory names. }\n  - { id: phishing, title: Phishing, about: A message that tries to take a person's credentials. }\n";
const LOBBY = "LOBBYMARK: read the lease table before the flows; it names the device first.";
const RED_TEXT = "REDMARKER: the lobby AP-3 is watched by a tool this case may not name.";
const PHISH = "PHISHMARK: read the message headers before the links.";

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let config: Config;
let wb: Workbench;
let composed: ReturnType<typeof compose>;
const sessions: CaseSession[] = [];

/**
 * The sample's root with what this slice brings: two case types, a profile whose Plan and Research list memory references, and a loop "memo"
 * that reads the shared lessons of the case's type and the case's notes at Plan and Research.
 */
function withMemory(root: string): void {
  writeFileSync(join(root, "case-types.yaml"), TYPES);
  const edit = (rel: string, from: string, to: string): void => {
    const p = join(root, rel);
    const text = readFileSync(p, "utf8");
    if (!text.includes(from)) throw new Error(`${from} not in ${rel}`);
    writeFileSync(p, text.replace(from, to));
  };
  const profile = readFileSync(join(root, "context", "profile.yaml"), "utf8").replace("id: investigation", "id: memory-test")
    .replace("    skills: [ask-the-person]\n  research:", "    skills: [ask-the-person]\n    references: [shared-lessons, case-notes]\n  research:")
    .replace("    procedure: research-sop\n", "    procedure: research-sop\n    references: [shared-lessons, case-notes]\n");
  writeFileSync(join(root, "context", "memory-profile.yaml"), profile);
  const loopBody = Bun.YAML.parse(readFileSync(join(root, "loops", "investigation.yaml"), "utf8")) as Record<string, unknown>;
  const reads = { "reference:shared-lessons": { memory: "shared/*" }, "reference:case-notes": { memory: "case/notes" } };
  // memo's Frame is inline, held to a schema of its own with the optional case_type and answered by a script of its own that names
  // unknown-device; the investigation loop's Frame, its schema and its script are as they were
  const frame = Bun.YAML.parse(readFileSync(join(root, "stages", "frame.yaml"), "utf8")) as Record<string, unknown>;
  const { kind: _kind, ...frameBody } = frame;
  const typedFrame = { ...frameBody, schema: "frame-typed", model: { provider: "scripted", model: "memo-frame", effort: null } };
  const stages = (loopBody.stages as string[]).map((x) => (x === "frame" ? typedFrame : x));
  writeFileSync(join(root, "loops", "memo.yaml"), JSON.stringify({ ...loopBody, id: "memo", title: "Memo", profile: "memory-test", stages, components: { plan: reads, research: reads } }));
  const schema = readFileSync(join(root, "context", "schemas", "frame-output.yaml"), "utf8").replace("id: frame-output", "id: frame-typed");
  writeFileSync(join(root, "context", "schemas", "frame-typed.yaml"), schema);
  edit("context/schemas/frame-typed.yaml", `"notes": {"type": "string"}}}`, `"notes": {"type": "string"}, "case_type": {"type": ["string", "null"]}}}`);
  type Turn = { actor: string; reply: { content?: string } };
  const script = Bun.YAML.parse(readFileSync(join(root, "scripts", "sample-run.yaml"), "utf8")) as { turns: Turn[] };
  const framing = script.turns.filter((t) => t.actor === "orchestrator").map((t) => (t.reply.content === undefined ? t : { ...t, reply: { content: JSON.stringify({ ...JSON.parse(t.reply.content), case_type: "unknown-device" }) } }));
  writeFileSync(join(root, "scripts", "memo-frame.yaml"), JSON.stringify({ kind: "script", id: "memo-frame", title: "Memo Frame", turns: [...framing, ...framing] }));
  // a second run of a case plans again: Plan's turns once more at the end of the script
  writeFileSync(join(root, "scripts", "sample-run.yaml"), JSON.stringify({ ...script, turns: [...script.turns, ...script.turns.filter((t) => t.actor === "planner")] }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-memory-"));
  sample = sampleRoot(dir);
  withMemory(sample.root);
  const base = loadConfig({ env: {}, home: dir, repoRoot: dir });
  config = {
    ...base, data_dir: join(dir, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 },
    loops: { ...base.loops, store: join(dir, "wb", "loops"), imports: join(dir, "wb", "imported") },
  };
  wb = Workbench.open(config.data_dir, { onError: () => {} });
  composed = compose(config, wb);
  expect(composed.problems.filter((p) => p.startsWith("loop "))).toEqual([]);
  composed.deps.memory = storeHost(() => wb.memory);
  sessions.length = 0;
});
afterEach(() => {
  for (const s of sessions) if (s.open) expect(s.state.skipped).toEqual([]);
  try { composed.close(); } catch { /* closed */ }
  try { wb.close(); } catch { /* closed */ }
  sample.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = { title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" as const };
function newCase(opts: { loop?: string; type?: string } = {}): CaseSession {
  const s = wb.createCase(input, human, { loop: opts.loop ?? "memo", ...(opts.type === undefined ? {} : { type: opts.type }) });
  sessions.push(s);
  return s;
}
/** A lesson a person proposes and accepts in the workbench's store; its id. */
function share(over: Partial<LessonDraft> = {}): string {
  const draft: LessonDraft = { case_type: "unknown-device", title: "Read the lease table first", text: LOBBY, triggers: [], marking: "TLP:GREEN", supersedes: null, ...over };
  const { lesson } = wb.memory.propose(draft, { kind: "person" }, human);
  wb.memory.accept(lesson.id, { actor: human, hash: lesson.hash });
  return lesson.id;
}
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
type Bound = Extract<Entry, { type: "memory.bound" }>;
const boundOf = (s: CaseSession): Bound[] => s.entries().filter((e): e is Bound => e.type === "memory.bound");
const lockOf = (s: CaseSession, e: Bound): MemoryLock => readMemoryLock(s.blobs.get(e.payload.lock.blob))!;
type Req = Extract<Entry, { type: "model.request" }>;
const requests = (s: CaseSession, stage: string): Req[] => s.entries().filter((e): e is Req => e.type === "model.request" && e.stage === stage);
/** The shared lessons each request of a stage was given, by id. */
const lessonsAt = (s: CaseSession, stage: string): string[][] => requests(s, stage).map((r) => r.payload.pack.filter((i) => i.kind === "shared-lesson").map((i) => i.id));
const sentAt = (s: CaseSession, stage: string): string => requests(s, stage).map((r) => s.blobs.text(r.payload.messages.blob)).join("\n");
const blobsText = (s: CaseSession): string => readdirSync(join(s.dir, "blobs")).filter((n) => !n.startsWith(".")).map((n) => readFileSync(join(s.dir, "blobs", n), "utf8")).join("\n");
const typeQuestion = (s: CaseSession) => Object.values(s.state.questions).find((q) => q.why === CASE_TYPE_WHY) ?? null;

/** A typed memo case run to its plan gate. */
async function typedToPlanGate(): Promise<{ s: CaseSession; engine: Engine }> {
  const s = newCase({ type: "unknown-device" });
  const engine = Engine.open(s, composed.deps);
  engine.start(human);
  expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "plan" });
  return { s, engine };
}
/** An untyped memo case run until it waits on Frame's question. */
async function toFrameQuestion(): Promise<{ s: CaseSession; engine: Engine }> {
  const s = newCase();
  const engine = Engine.open(s, composed.deps);
  engine.start(human);
  const sum = await engine.advance();
  expect(sum.status).toBe("paused");
  expect(s.state.run.hold).toEqual({ kind: "question", stage: "frame" });
  return { s, engine };
}

// ---- Step 1: a loop with no memory is untouched

test("starting a run of the investigation loop writes loop.bound and run.started and no memory.bound, with a store that holds shared lessons", async () => {
  share();
  const s = newCase({ loop: "investigation", type: "unknown-device" });
  const engine = Engine.open(s, composed.deps);
  const calls = commitsOf(s);
  engine.start(human);
  expect(calls).toEqual([["loop.bound", "run.started"]]);
  expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "plan" });
  expect(boundOf(s)).toEqual([]);
  expect(s.state.memory.bound).toBeNull();
});

test("a run started before this slice, paused, resumes and reaches its gate with an empty memory and nothing skipped", async () => {
  // the slice 12 code path: an investigation run, with no memory host and no case type, that writes none of the new entries
  const { memory: _m, ...old } = composed.deps;
  const s = newCase({ loop: "investigation" });
  const first = Engine.open(s, old);
  first.start(human);
  first.pause(human);
  const id = s.id;
  const before = s.entries();
  expect(before.some((e) => e.type.startsWith("memory.") || e.type.startsWith("case.type"))).toBe(false);
  wb.close();
  composed.close();

  wb = Workbench.open(config.data_dir, { onError: () => {} });
  composed = compose(config, wb);
  composed.deps.memory = storeHost(() => wb.memory);
  share();
  const again = wb.session(id);
  sessions.push(again);
  const engine = Engine.open(again, composed.deps);
  expect(await engine.resume(human)).toMatchObject({ status: "waiting", waiting: "plan" });
  expect(again.entries().slice(0, before.length)).toEqual(before);
  expect(boundOf(again)).toEqual([]);
  expect(again.state.memory).toEqual({ type: null, type_by: null, proposed_type: null, notes: {}, order: [], pending: null, bound: null });
  expect(again.state.skipped).toEqual([]);
});

// ---- Step 3: the bind

test("starting a run of a loop that reads shared memory writes loop.bound, memory.bound and run.started in one commit, in that order", () => {
  share();
  const s = newCase({ type: "unknown-device" });
  const engine = Engine.open(s, composed.deps);
  const calls = commitsOf(s);
  engine.start(human);
  expect(calls).toEqual([["loop.bound", "memory.bound", "run.started"]]);
  const types = s.entries().map((e) => e.type);
  expect(types.slice(types.indexOf("loop.bound"))).toEqual(["loop.bound", "memory.bound", "run.started"]);
  expect(s.state.memory.bound).not.toBeNull();
  expect(s.state.memory.pending).toBeNull();
});

test("the lock blob is in the case's blobs, reads as a MemoryLock, and names the store's origin and head then", () => {
  share();
  const origin = wb.memory.origin();
  const head = wb.memory.head();
  const s = newCase({ type: "unknown-device" });
  Engine.open(s, composed.deps).start(human);
  share({ title: "A later lesson", text: "Filed after the run bound." });
  const [bound] = boundOf(s);
  expect(s.blobs.has(bound!.payload.lock.blob)).toBe(true);
  const lock = lockOf(s, bound!);
  expect(lock.format).toBe(1);
  expect(lock.store).toEqual({ origin, head });
  expect(bound!.payload.store).toEqual({ origin, head });
  expect(lock.facts.type).toBe("unknown-device");
  expect(lock.facts.marking).toBe("TLP:GREEN");
});

test("memory.bound lists each locked lesson by id and hash, and the case's type", () => {
  const a = share();
  const b = share({ title: "Read the DHCP name", text: "The DHCP lease often names the maker." });
  share({ case_type: "phishing", title: "Headers first", text: PHISH });
  const s = newCase({ type: "unknown-device" });
  Engine.open(s, composed.deps).start(human);
  const [bound] = boundOf(s);
  const lock = lockOf(s, bound!);
  expect(bound!.payload.case_type).toBe("unknown-device");
  expect(lock.lessons.map((l) => l.lesson)).toEqual([b, a]);
  expect(bound!.payload.lessons).toEqual(lock.lessons.map((l) => ({ lesson: l.lesson, hash: l.hash })));
  expect(lock.lessons.every((l) => l.stages.join() === "plan,research")).toBe(true);
});

test("a TLP:RED lesson is not in a TLP:GREEN case's lock: no blob of the case holds its text", async () => {
  share();
  const red = share({ title: "A watched access point", text: RED_TEXT, marking: "TLP:RED" });
  const { s, engine } = await typedToPlanGate();
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  const lock = lockOf(s, boundOf(s)[0]!);
  expect(lock.lessons.map((l) => l.lesson)).not.toContain(red);
  expect(lock.left_out).toEqual([{ lesson: red, why: "marking" }]);
  const all = blobsText(s);
  expect(all).toContain("LOBBYMARK");
  expect(all).not.toContain("REDMARKER");
  expect(all).not.toContain("A watched access point");
});

test("a case with no type binds a lock with no lessons", () => {
  share();
  const s = newCase();
  Engine.open(s, composed.deps).start(human);
  const [bound] = boundOf(s);
  expect(bound!.payload.case_type).toBeNull();
  expect(bound!.payload.lessons).toEqual([]);
  expect(lockOf(s, bound!).lessons).toEqual([]);
});

test("with no memory host the run binds an empty lock and still starts", () => {
  const { memory: _m, ...deps } = composed.deps;
  const s = newCase({ type: "unknown-device" });
  Engine.open(s, deps).start(human);
  const [bound] = boundOf(s);
  expect(bound!.payload.store).toEqual({ origin: null, head: { seq: 0, hash: "" } });
  expect(bound!.payload.lessons).toEqual([]);
  expect(s.state.run.status).toBe("running");
});

test("the store is read once at the start and never while the stages run", async () => {
  share();
  const real = storeHost(() => wb.memory);
  let reads = 0;
  composed.deps.memory = { read: () => { reads++; return real.read(); }, propose: (d, f) => real.propose(d, f) } satisfies MemoryHost;
  const s = newCase({ type: "unknown-device" });
  const engine = Engine.open(s, composed.deps);
  engine.start(human);
  expect(reads).toBe(1);
  expect(await engine.advance()).toMatchObject({ waiting: "plan" });
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await engine.advance()).toMatchObject({ waiting: "publish" });
  expect(reads).toBe(1);
  expect(lessonsAt(s, "plan").flat().length).toBeGreaterThan(0);
});

// ---- Step 5: a run keeps what it locked

test("a lesson retired while a run is in progress stays in that run's stages; the case's next run binds without it", async () => {
  const id = share();
  const { s, engine } = await typedToPlanGate();
  wb.memory.retire(id, { actor: human, reason: "no longer holds" });
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await engine.advance()).toMatchObject({ waiting: "publish" });
  expect(lessonsAt(s, "research").every((ids) => ids.includes(id))).toBe(true);
  expect(sentAt(s, "research")).toContain("LOBBYMARK");
  engine.stop(human, "start again");
  engine.start(human);
  const next = boundOf(s).at(-1)!;
  expect(next.payload.lessons).toEqual([]);
});

test("a lesson superseded while a run is in progress: this run reads the old text, the next run the new", async () => {
  const id = share();
  const { s, engine } = await typedToPlanGate();
  const newer = share({ text: "NEWMARK: read the lease table, then the DHCP name.", supersedes: id });
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await engine.advance()).toMatchObject({ waiting: "publish" });
  expect(sentAt(s, "research")).toContain("LOBBYMARK");
  expect(sentAt(s, "research")).not.toContain("NEWMARK");
  engine.stop(human, "start again");
  engine.start(human);
  const lock = lockOf(s, boundOf(s).at(-1)!);
  expect(lock.lessons.map((l) => l.lesson)).toEqual([newer]);
  expect(lock.lessons[0]!.text).toContain("NEWMARK");
});

test("replaying the case gives each stage the same parts with the store closed and its folder moved away", async () => {
  share();
  const { s, engine } = await typedToPlanGate();
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await engine.advance()).toMatchObject({ waiting: "publish" });
  const entries = s.entries();
  const lock = composed.deps.loops!.current("memo")!.lock;
  const uses = memoryUses(lock);
  // what each stage was given live, as its first request lists it
  const live = new Map<number, string[]>();
  for (const e of entries) {
    if (e.type !== "stage.started" || !["plan", "research"].includes(e.payload.stage)) continue;
    const req = entries.find((x): x is Req => x.type === "model.request" && x.stage === e.payload.stage && x.seq > e.seq);
    live.set(e.seq, req!.payload.pack.filter((i) => i.kind === "shared-lesson" || i.kind === "case-note").map((i) => `${i.kind}:${i.id}:${i.hash}`));
  }
  wb.memory.close();
  renameSync(join(config.data_dir, "memory"), join(dir, "memory-away"));
  expect(existsSync(join(config.data_dir, "memory"))).toBe(false);
  for (const [seq, given] of live) {
    const at = { state: fold(entries, seq), entries: () => entries.slice(0, seq), blobs: s.blobs };
    const stage = (entries[seq - 1] as Extract<Entry, { type: "stage.started" }>).payload.stage;
    const parts = memoryParts(at, stage, uses, composed.deps.registry);
    expect(parts.map((p) => `${p.kind}:${p.id}`)).toEqual(given.map((g) => g.split(":").slice(0, 2).join(":")));
    expect(given.length).toBeGreaterThan(0);
  }
});

test("the case's notes written in run 1 are in run 2's packs", async () => {
  const { s, engine } = await typedToPlanGate();
  noteMemory(s, { kind: "fact", text: "AP-3 is in the lobby.", actor: human, link: { run: s.state.run.id, stage: null, job: null } });
  engine.stop(human, "start again");
  engine.start(human);
  expect(await engine.advance()).toMatchObject({ waiting: "plan" });
  const last = requests(s, "plan").at(-1)!;
  expect(last.payload.pack.filter((i) => i.kind === "case-note").map((i) => i.id)).toEqual(["m1"]);
  expect(s.blobs.text(last.payload.messages.blob)).toContain("AP-3 is in the lobby.");
});

// ---- Step 7: setting the type; with none at creation, Frame asks and the run waits (controller ruling 3)

test("Frame's proposal selects nothing: the run's lock is as it was", async () => {
  share();
  const { s } = await toFrameQuestion();
  expect(s.state.memory.proposed_type?.type).toBe("unknown-device");
  expect(s.state.memory.type).toBeNull();
  expect(boundOf(s).length).toBe(1);
  expect(s.state.memory.bound!.lessons).toEqual([]);
  const proposed = s.entries().filter((e) => e.type === "case.type_proposed");
  expect(proposed.map((e) => [e.actor, e.payload, e.run, e.stage])).toEqual([[code, { type: "unknown-device", why: "Frame read the question as this type" }, s.state.run.id, "frame"]]);
});

test("with no case type, Frame asks the person a blocking question proposing the type, and the run waits after Frame: Plan has not run", async () => {
  share();
  const { s } = await toFrameQuestion();
  const q = typeQuestion(s)!;
  expect(q).toMatchObject({ stage: "frame", blocking: true, answer: null, by: "orchestrator" });
  expect(q.text).toContain("unknown-device");
  expect(q.text).toContain("Unknown device");
  expect(q.text).toContain("phishing");
  expect(s.state.run.stages.find((x) => x.id === "frame")!.status).toBe("passed");
  expect(requests(s, "plan")).toEqual([]);
  expect(s.entries().some((e) => e.type === "stage.started" && e.payload.stage === "plan")).toBe(false);
});

test("the person's answer to Frame's question sets the type and binds memory again in one commit, and Plan's pack holds the lessons of that type", async () => {
  const id = share();
  share({ case_type: "phishing", title: "Headers first", text: PHISH });
  const { s, engine } = await toFrameQuestion();
  const calls = commitsOf(s);
  engine.answerCaseType({ question: typeQuestion(s)!.id, answer: " Unknown-Device ", actor: human });
  expect(calls).toEqual([["case.type_set", "memory.bound", "card.created", "question.answered"]]);
  expect(s.state.memory.type).toBe("unknown-device");
  expect(s.state.memory.bound!.lessons.map((l) => l.lesson)).toEqual([id]);
  expect(await engine.resume(human)).toMatchObject({ status: "waiting", waiting: "plan" });
  expect(lessonsAt(s, "plan").length).toBeGreaterThan(0);
  expect(lessonsAt(s, "plan").every((ids) => ids.join() === id)).toBe(true);
  expect(sentAt(s, "plan")).toContain("LOBBYMARK");
  expect(sentAt(s, "plan")).not.toContain("PHISHMARK");
  expect(typeQuestion(s)!.answer).not.toBeNull();
  expect(typeQuestion(s)!.waived).toBeNull();
});

test("setCaseType while the run waits on Frame's question answers it in the same commit, and Plan's pack holds the lessons", async () => {
  const id = share();
  const { s, engine } = await toFrameQuestion();
  const calls = commitsOf(s);
  engine.setCaseType({ type: "unknown-device", actor: human });
  expect(calls).toEqual([["case.type_set", "memory.bound", "card.created", "question.answered"]]);
  expect(await engine.resume(human)).toMatchObject({ status: "waiting", waiting: "plan" });
  expect(lessonsAt(s, "plan").every((ids) => ids.join() === id)).toBe(true);
  expect(lessonsAt(s, "plan").length).toBeGreaterThan(0);
});

test("an answer to Frame's question that names no case type is refused and nothing is written; none leaves the case without a type and Plan is given no lesson", async () => {
  share();
  const { s, engine } = await toFrameQuestion();
  const q = typeQuestion(s)!.id;
  const n = s.entries().length;
  expect(() => engine.answerCaseType({ question: q, answer: "a printer, I think", actor: human })).toThrow(RunRefused);
  expect(() => engine.answerCaseType({ question: q, answer: "unknown-device", actor: code })).toThrow("only a person sets a case's type");
  expect(s.entries().length).toBe(n);
  engine.answerCaseType({ question: q, answer: "none", actor: human });
  expect(s.entries().slice(n).map((e) => e.type)).toEqual(["card.created", "question.answered"]);
  expect(s.state.memory.type).toBeNull();
  expect(await engine.resume(human)).toMatchObject({ waiting: "plan" });
  expect(lessonsAt(s, "plan").flat()).toEqual([]);
});

test("a case typed at creation is not asked its type, and a loop that reads no shared memory never waits for one", async () => {
  share();
  const { s } = await typedToPlanGate();
  expect(typeQuestion(s)).toBeNull();
  expect(s.entries().some((e) => e.type === "case.type_proposed")).toBe(false);
  const plain = newCase({ loop: "investigation" });
  const engine = Engine.open(plain, composed.deps);
  engine.start(human);
  expect(await engine.advance()).toMatchObject({ waiting: "plan" });
  expect(typeQuestion(plain)).toBeNull();
  expect(plain.state.memory.proposed_type).toBeNull();
});

test("setCaseType by a person at the plan gate writes case.type_set and a new memory.bound in one commit, and Research is given the lessons Plan was not", async () => {
  const id = share();
  const { s, engine } = await toFrameQuestion();
  // the person goes on without answering: Plan runs with no type, so with no lesson
  expect(await engine.resume(human)).toMatchObject({ waiting: "plan" });
  expect(lessonsAt(s, "plan").flat()).toEqual([]);
  const calls = commitsOf(s);
  engine.setCaseType({ type: "unknown-device", actor: human });
  expect(calls).toEqual([["case.type_set", "memory.bound"]]);
  const last = s.entries().slice(-2);
  expect(last.map((e) => [e.type, e.actor, e.run])).toEqual([["case.type_set", human, s.state.run.id], ["memory.bound", human, s.state.run.id]]);
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await engine.advance()).toMatchObject({ waiting: "publish" });
  expect(lessonsAt(s, "research").length).toBeGreaterThan(0);
  expect(lessonsAt(s, "research").every((ids) => ids.join() === id)).toBe(true);
});

test("setCaseType with no run in progress writes case.type_set alone; the next run binds for that type", () => {
  const id = share();
  const s = newCase();
  const engine = Engine.open(s, composed.deps);
  const calls = commitsOf(s);
  engine.setCaseType({ type: "unknown-device", actor: human });
  expect(calls).toEqual([["case.type_set"]]);
  engine.start(human);
  expect(boundOf(s)[0]!.payload).toMatchObject({ case_type: "unknown-device", lessons: [{ lesson: id }] });
});

test("setCaseType by code, to a type that is not loaded, or to the type the case has is refused and nothing is written", () => {
  const s = newCase({ type: "unknown-device" });
  const engine = Engine.open(s, composed.deps);
  engine.start(human);
  const n = s.entries().length;
  expect(() => engine.setCaseType({ type: "phishing", actor: code })).toThrow("only a person sets a case's type");
  expect(() => engine.setCaseType({ type: "insider", actor: human })).toThrow(`there is no case type "insider"`);
  expect(() => engine.setCaseType({ type: "unknown-device", actor: human })).toThrow("that is already this case's type");
  expect(() => engine.setCaseType({ type: "phishing", actor: human })).not.toThrow();
  expect(s.entries().length).toBe(n + 2);
  for (const bad of [() => engine.setCaseType({ type: "phishing", actor: human })]) expect(bad).toThrow(RunRefused);
});

test("setCaseType(null) during a run binds a lock with no lessons", () => {
  share();
  const s = newCase({ type: "unknown-device" });
  const engine = Engine.open(s, composed.deps);
  engine.start(human);
  expect(s.state.memory.bound!.lessons.length).toBe(1);
  engine.setCaseType({ type: null, actor: human });
  const last = boundOf(s).at(-1)!;
  expect(last.payload).toMatchObject({ case_type: null, lessons: [] });
  expect(s.state.memory.type).toBeNull();
  expect(s.state.memory.bound!.lessons).toEqual([]);
  const marking: Marking = lockOf(s, last).facts.marking;
  expect(marking).toBe("TLP:GREEN");
});
