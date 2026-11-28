// Slice 13 (memory), end to end on the sample and the scripted model. The sample's unknown-device loop reads the shared lessons a person has
// accepted for its case type and the case's own notebook; its Feedback stage proposes lessons, which only a person shares. One served workbench
// runs the story once (runStory) and the tests below read it: a case with no type is asked its type by Frame and waits; the person's answer
// binds the lessons; the run publishes; Feedback files one proposal and drops one; a person accepts it on the Memory page's route; later
// cases bind it. Markings, replay, verify, the store file and the case file are checked against that record.
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { memoryParts } from "../../src/agents/memory";
import { compose } from "../../src/cli/compose";
import { BlobStore } from "../../src/core/blobs";
import { sha256Hex } from "../../src/core/hash";
import { Ledger } from "../../src/core/ledger";
import { foldLessons, readMemoryLock, shared } from "../../src/core/lessons";
import type { MemoryLock } from "../../src/core/lessons";
import { fold } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Actor, Entry, Marking } from "../../src/core/types";
import { verifyCase, verifyMemory, verifyMemoryLinks } from "../../src/core/verify";
import type { MemoryView } from "../../src/core/wire";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps } from "../../src/pipeline/engine";
import { memoryUses } from "../../src/pipeline/loops";
import type { MemoryUse } from "../../src/pipeline/loops";
import { loadPipeline } from "../../src/pipeline/manifests";
import { CASE_TYPE_WHY } from "../../src/pipeline/memory";
import { sampleRoot } from "../helpers/sample-root";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

const human: Actor = { kind: "human", id: "analyst" };
const caseInput = { title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" as const };
/** The entry types slice 13 adds to a case's ledger. */
const SLICE_13_TYPES = ["case.type_set", "case.type_proposed", "memory.noted", "memory.revised", "memory.dropped", "memory.bound"];
const MEMORY_STAGES = ["plan", "research", "assemble"];
const AMBER_TEXT = "AMBERMARK: in the sample, a lobby device on AP-3 is answered from the asset list.";
const RED_TEXT = "REDMARK: in the sample, a lesson no GREEN case may read.";

const dirs: string[] = [];
const closers: (() => unknown)[] = [];
afterAll(async () => {
  while (closers.length > 0) await closers.pop()!();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string): string => { const d = mkdtempSync(join(tmpdir(), `memory-acc-${name}-`)); dirs.push(d); return d; };

type Bound = Extract<Entry, { type: "memory.bound" }>;
type Req = Extract<Entry, { type: "model.request" }>;
const boundOf = (entries: readonly Entry[]): Bound[] => entries.filter((e): e is Bound => e.type === "memory.bound");
const requestsOf = (entries: readonly Entry[], stage?: string): Req[] => entries.filter((e): e is Req => e.type === "model.request" && (stage === undefined || e.stage === stage));
const partsOf = (r: Req, kind: string): string[] => r.payload.pack.filter((i) => i.kind === kind).map((i) => i.id);
const lockOf = (blobs: { get(hash: string): Uint8Array }, e: Bound): MemoryLock => readMemoryLock(blobs.get(e.payload.lock.blob))!;
const blobsText = (caseDir: string): string => readdirSync(join(caseDir, "blobs")).filter((n) => !n.startsWith(".")).map((n) => readFileSync(join(caseDir, "blobs", n), "utf8")).join("\n");
const ok = async (r: Promise<{ status: number; body: unknown }>, what: string): Promise<void> => {
  const got = await r;
  if (got.status !== 200) throw new Error(`${what} failed: ${JSON.stringify(got)}`);
};

// ---------- the story, once ----------

interface Story {
  s: Served;
  /** The store as compose left it, before any person decided. */
  seeded: { ids: string[]; statuses: string[]; from: string[]; shared: number; markings: Marking[] };
  /** CASE-1 as it was made from the loop with no type named, then after the person cleared its type. */
  made: { type: string | null; type_by: unknown; cleared: string | null };
  /** CASE-1 when the run stopped after Frame. */
  asked: { status: string; hold: unknown; question: { text: string; blocking: boolean; stage: string | null } | null; plan_requests: number; bound: { case_type: string | null; lessons: number } | null };
  first: string; firstEntries: Entry[]; firstState: CaseState; firstDir: string;
  /** What Feedback filed, by the store's ids. */
  proposal: string;
  second: string; secondEntries: Entry[];
  third: string; thirdEntries: Entry[];
  /** The store just before the proposal was accepted: GET /api/memory's group for unknown-device. */
  memoryPage: MemoryView;
  /** The seeds in the order the person accepted them (the Memory page's order); a binding lists the newest acceptance first. */
  acceptedSeeds: string[];
}
let story: Promise<Story> | undefined;
async function runStory(): Promise<Story> {
  const errors: unknown[] = [];
  const s = await served({ onError: (e) => { errors.push(e); } });
  closers.push(async () => { await s.close(); expect(errors).toEqual([]); });
  if (s.problems.length > 0) throw new Error(`compose: ${s.problems.join("; ")}`);
  const st0 = s.wb.memory.state;
  const seeded: Story["seeded"] = {
    ids: [...st0.order], statuses: st0.order.map((id) => st0.lessons[id]!.status), from: st0.order.map((id) => st0.lessons[id]!.from.kind),
    shared: shared(st0).length, markings: st0.order.map((id) => st0.lessons[id]!.marking),
  };
  // a person accepts both seeds on the Memory page: the hash each row was drawn with
  const page = (await (await s.get("/api/memory")).json()) as MemoryView;
  const acceptedSeeds: string[] = [];
  for (const l of page.groups.find((g) => g.type?.id === "unknown-device")!.lessons) {
    acceptedSeeds.push(l.id);
    const r = await s.post(`/api/memory/lessons/${l.id}/accept`, { hash: l.hash });
    if (r.status !== 200) throw new Error(`accepting ${l.id}: ${r.status} ${await r.text()}`);
  }

  // CASE-1: made from the Unknown device loop with no type named; the person clears the type, so Frame must ask it
  const first = await s.newCase({ loop: "unknown-device" });
  const m0 = s.app.hub.read(first).state.memory;
  const made: Story["made"] = { type: m0.type, type_by: m0.type_by, cleared: null };
  await ok(s.command(first, "set_case_type", { type: null }), "clearing the type");
  made.cleared = s.app.hub.read(first).state.memory.type;
  await ok(s.command(first, "start_run"), "start_run");
  await s.app.hub.idle();
  const at = s.app.hub.read(first).state;
  const q = Object.values(at.questions).find((x) => x.why === CASE_TYPE_WHY) ?? null;
  const asked: Story["asked"] = {
    status: at.run.status, hold: at.run.hold, question: q === null ? null : { text: q.text, blocking: q.blocking, stage: q.stage },
    plan_requests: requestsOf(s.entries(first), "plan").length,
    bound: at.memory.bound === null ? null : { case_type: at.memory.bound.case_type, lessons: at.memory.bound.lessons.length },
  };
  if (q === null) throw new Error(`Frame did not ask the case's type: ${at.run.status} ${at.run.pause_reason}`);
  // the person answers: the proposal is the type
  await ok(s.command(first, "answer_question", { question: q.id, answer: "yes" }), "answering Frame's question");
  await s.app.hub.idle();
  if (s.app.hub.read(first).state.run.waiting !== "plan") throw new Error(`not at the plan gate: ${JSON.stringify(s.app.hub.read(first).state.run)}`);
  await ok(s.command(first, "accept_plan", { budgets: { s3: 1 } }), "accept_plan");
  await s.app.hub.idle();
  if (s.app.hub.read(first).state.run.waiting !== "publish") throw new Error(`not at the publish gate: ${JSON.stringify(s.app.hub.read(first).state.run)}`);
  await ok(s.command(first, "approve"), "approve");
  await s.app.hub.idle();
  const firstEntries = s.entries(first);
  const firstState = s.app.hub.read(first).state;
  const filed = s.wb.memory.state.order.filter((id) => !seeded.ids.includes(id));
  if (filed.length !== 1) throw new Error(`Feedback filed ${filed.length} lessons`);
  const proposal = filed[0]!;

  // CASE-2: typed by the loop; it binds at its start, while the proposal is not shared
  const second = await s.newCase({ loop: "unknown-device" });
  await s.toPlanGate(second);
  const memoryPage = (await (await s.get("/api/memory")).json()) as MemoryView;
  // the person accepts the proposal on the Memory page, with the hash its row was drawn with
  const row = memoryPage.groups.find((g) => g.type?.id === "unknown-device")!.lessons.find((l) => l.id === proposal)!;
  const accepted = await s.post(`/api/memory/lessons/${proposal}/accept`, { hash: row.hash });
  if (accepted.status !== 200) throw new Error(`accepting ${proposal}: ${accepted.status} ${await accepted.text()}`);
  // CASE-3: binds three
  const third = await s.newCase({ loop: "unknown-device" });
  await s.toPlanGate(third);
  return {
    s, seeded, made, asked, first, firstEntries, firstState, firstDir: join(s.config.data_dir, "cases", first), proposal,
    second, secondEntries: s.entries(second), third, thirdEntries: s.entries(third), memoryPage, acceptedSeeds,
  };
}
const theStory = (): Promise<Story> => (story ??= runStory());

/** The loop's memory uses, from the case's own deps. */
const usesOf = (t: Story, id: string): MemoryUse[] => memoryUses(t.s.app.hub.depsFor(id).lock!);

// ---------- Step 1 ----------

test("compose files the sample's two seeds as proposals, and neither is shared until a person accepts it", async () => {
  const t = await theStory();
  expect(t.seeded).toEqual({ ids: ["LESSON-1", "LESSON-2"], statuses: ["proposed", "proposed"], from: ["seed", "seed"], shared: 0, markings: ["TLP:CLEAR", "TLP:CLEAR"] });
  const store = t.s.wb.memory;
  const seeds = store.entries().filter((e) => e.type === "lesson.proposed" && (e.payload as { from: { kind: string } }).from.kind === "seed");
  expect(seeds.map((e) => [(e.payload as { lesson: string }).lesson, (e.payload as { title: string }).title, e.actor])).toEqual([
    ["LESSON-1", "Read the connection message before the lease", { kind: "system", id: "seed" }],
    ["LESSON-2", "An empty answer proves absence only from a list declared complete", { kind: "system", id: "seed" }],
  ]);
  // their acceptance is a person's, each of the hash it was shown
  for (const id of ["LESSON-1", "LESSON-2"]) {
    const acc = store.entries().find((e) => e.type === "lesson.accepted" && (e.payload as { lesson: string }).lesson === id)!;
    expect(acc.actor).toEqual({ kind: "human", id: t.s.config.user });
    expect((acc.payload as { hash: string }).hash).toBe(store.state.lessons[id]!.hash);
  }
  // compose again files nothing twice
  expect(t.s.reload()).toEqual([]);
  expect(store.entries().filter((e) => e.type === "lesson.proposed" && (e.payload as { from: { kind: string } }).from.kind === "seed").length).toBe(2);
}, 300_000);

test("a case of the unknown-device loop, made with no type named, has the loop's type", async () => {
  const t = await theStory();
  expect(t.made.type).toBe("unknown-device");
  expect(t.made.type_by).toMatchObject({ actor: "loop-default" });
  const set = t.firstEntries.find((e) => e.type === "case.type_set")!;
  expect([set.payload, set.actor]).toEqual([{ type: "unknown-device" }, { kind: "system", id: "loop-default" }]);
  expect(t.made.cleared).toBeNull();
  // the other cases the loop made took it too
  for (const e of [t.secondEntries, t.thirdEntries]) expect(e.find((x) => x.type === "case.type_set")!.payload).toEqual({ type: "unknown-device" });
}, 300_000);

test("a case with no type is asked its type by Frame, blocking: the run waits after Frame, the person's answer sets the type and binds the lessons, and Plan's pack holds them", async () => {
  const t = await theStory();
  expect(t.asked.status).toBe("paused");
  expect(t.asked.hold).toEqual({ kind: "question", stage: "frame" });
  expect(t.asked.question).toMatchObject({ blocking: true, stage: "frame" });
  expect(t.asked.question!.text).toContain("Unknown device");
  expect(t.asked.plan_requests).toBe(0);
  // at the start the case had no type: the binding gave nothing
  expect(t.asked.bound).toEqual({ case_type: null, lessons: 0 });
  const bound = boundOf(t.firstEntries);
  expect(bound.length).toBe(2);
  expect(bound[0]!.payload).toMatchObject({ case_type: null, lessons: [] });
  // the answer: case.type_set by the person and a new memory.bound, in one commit, before Plan's first request
  const answered = t.firstEntries.find((e) => e.type === "question.answered")!;
  const typeSet = t.firstEntries.filter((e) => e.type === "case.type_set").at(-1)!;
  expect(typeSet.actor).toEqual({ kind: "human", id: t.s.config.user });
  expect(typeSet.payload).toEqual({ type: "unknown-device" });
  expect(bound[1]!.seq).toBeGreaterThan(typeSet.seq);
  expect(bound[1]!.seq).toBeLessThan(answered.seq);
  expect(bound[1]!.payload.case_type).toBe("unknown-device");
  const newestFirst = [...t.acceptedSeeds].reverse();
  expect(newestFirst.sort()).toEqual(["LESSON-1", "LESSON-2"]);
  expect(bound[1]!.payload.lessons.map((l) => l.lesson)).toEqual([...t.acceptedSeeds].reverse());
  const plan = requestsOf(t.firstEntries, "plan");
  expect(plan.length).toBeGreaterThan(0);
  expect(plan[0]!.seq).toBeGreaterThan(answered.seq);
  for (const r of plan) expect(partsOf(r, "shared-lesson")).toEqual([...t.acceptedSeeds].reverse());
  expect(t.firstState.skipped).toEqual([]);
}, 300_000);

test("with both seeds accepted, a GREEN unknown-device case starting from an address binds the address lesson at its start, and binds the assets lesson too (the loop says it uses assets)", async () => {
  const t = await theStory();
  const entries = t.secondEntries;
  const started = entries.find((e) => e.type === "run.started")!;
  const bound = boundOf(entries);
  expect(bound.length).toBe(1);
  // in the commit of run.started, just before it
  expect(bound[0]!.seq).toBe(started.seq - 1);
  expect(entries[started.seq - 3]!.type).toBe("loop.bound");
  const lock = lockOf(t.s.app.hub.read(t.second).blobs, bound[0]!);
  expect(lock.case_type).toBe("unknown-device");
  expect(lock.facts.marking).toBe("TLP:GREEN");
  expect(lock.facts.observables).toContain("address");
  expect(lock.facts.sources).toEqual(["assets", "wifi"]);
  const byId = Object.fromEntries(lock.lessons.map((l) => [l.lesson, l]));
  expect(Object.keys(byId).sort()).toEqual(["LESSON-1", "LESSON-2"]);
  expect(byId["LESSON-1"]!.matched.join(" ")).toContain("address");
  expect(byId["LESSON-2"]!.matched.join(" ")).toContain("assets");
  expect(byId["LESSON-1"]!.stages.sort()).toEqual(["assemble", "plan", "research"]);
  expect(lock.left_out).toEqual([]);
}, 300_000);

test("the run reaches the plan gate, a person accepts the plan, and Research's first request holds both lessons as shared-lesson parts after the case", async () => {
  const t = await theStory();
  expect(t.firstEntries.some((e) => e.type === "plan.accepted" && e.actor.kind === "human")).toBe(true);
  const research = requestsOf(t.firstEntries).filter((r) => r.stage === "research");
  expect(research.length).toBeGreaterThan(0);
  const pack = research[0]!.payload.pack;
  const kinds = pack.map((i) => i.kind);
  expect(partsOf(research[0]!, "shared-lesson")).toEqual([...t.acceptedSeeds].reverse());
  // after the stage's own parts and the case, never fixed
  const caseAt = kinds.indexOf("case");
  expect(caseAt).toBeGreaterThanOrEqual(0);
  for (const [i, item] of pack.entries()) if (item.kind === "shared-lesson") { expect(i).toBeGreaterThan(caseAt); expect(item.fixed).toBe(false); }
  for (const k of ["rules", "persona", "procedure"]) if (kinds.includes(k)) expect(kinds.indexOf(k)).toBeLessThan(kinds.indexOf("shared-lesson"));
  // the text the model was sent holds the lesson under the workbench's lead line
  const sent = t.s.app.hub.read(t.first).blobs.text(research[0]!.payload.messages.blob);
  expect(sent).toContain("A lesson from an earlier case, accepted by a person.");
  expect(sent).toContain("connection message names the host a device announced");
}, 300_000);

test("the researcher's note is in Assemble's pack as a case-note part", async () => {
  const t = await theStory();
  const noted = t.firstEntries.filter((e) => e.type === "memory.noted");
  expect(noted.length).toBe(1);
  expect(noted[0]!.actor.kind).toBe("agent");
  expect(noted[0]!.stage).toBe("research");
  const note = t.firstState.memory.notes.m1!;
  expect(note).toMatchObject({ kind: "pointer", by: "agent" });
  expect(note.cards.length).toBe(1);
  expect(t.firstState.cards[note.cards[0]!]!.title).toBe("Asset with the address, by asset list: 192.0.2.17");
  const assemble = requestsOf(t.firstEntries, "assemble");
  expect(assemble.length).toBeGreaterThan(0);
  for (const r of assemble) expect(partsOf(r, "case-note")).toEqual(["m1"]);
  const item = assemble[0]!.payload.pack.find((i) => i.kind === "case-note")!;
  expect(item.fixed).toBe(false);
  // a note is never cited: no finding of the published product names it
  const product = t.firstState.drafts.find((d) => d.hash === t.firstState.published.at(-1)!.draft_hash)!.product;
  expect(JSON.stringify(product)).not.toContain("m1]");
}, 300_000);

test("the run publishes at the person's gate, Feedback files one proposal from the case and drops the other with its reason, and the run finishes published", async () => {
  const t = await theStory();
  expect(t.firstState.run).toMatchObject({ status: "finished", outcome: "published" });
  expect(t.firstState.published.length).toBe(1);
  const gate = t.firstEntries.find((e) => e.type === "product.published")!;
  expect(gate.actor).toEqual({ kind: "human", id: t.s.config.user });
  const fin = t.firstEntries.filter((e): e is Extract<Entry, { type: "stage.finished" }> => e.type === "stage.finished" && e.stage === "feedback").at(-1)!;
  expect(fin.seq).toBeGreaterThan(gate.seq);
  expect(fin.payload.outcome).toBe("pass");
  const output = JSON.parse(t.s.app.hub.read(t.first).blobs.text((fin.payload as unknown as { output: { blob: string } }).output.blob)) as { lessons: { lesson: string; title: string }[]; dropped: { title: string; why: string }[] };
  expect(output.lessons.map((l) => [l.lesson, l.title])).toEqual([[t.proposal, "Follow the internal peer before the outside address"]]);
  expect(output.dropped.map((d) => d.title)).toEqual(["Read the hardware address first"]);
  expect(output.dropped[0]!.why).toContain("mac-address");
  // the proposal is from the case, written by its Feedback stage's model, marked at least the case's marking, and waits for a person
  const l = t.s.wb.memory.state.lessons[t.proposal]!;
  const filed = t.s.wb.memory.entries().find((e) => e.type === "lesson.proposed" && (e.payload as { lesson: string }).lesson === t.proposal)!;
  expect(filed.actor.kind).toBe("system");
  expect(l.from).toMatchObject({ kind: "case", case: t.first, origin: t.firstEntries[0]!.hash, stage: "feedback", model: true, product: { n: 1 } });
  expect(l.marking).toBe("TLP:GREEN");
  expect(l.triggers).toEqual([{ observable: "address" }]);
  expect(t.memoryPage.groups.find((g) => g.type?.id === "unknown-device")!.lessons.find((x) => x.id === t.proposal)!.status).toBe("proposed");
}, 300_000);

test("the proposal is not shared: a second unknown-device case binds the two seeds and not it; after a person accepts it, a third case binds three", async () => {
  const t = await theStory();
  expect(boundOf(t.secondEntries).flatMap((e) => e.payload.lessons.map((l) => l.lesson)).sort()).toEqual(["LESSON-1", "LESSON-2"]);
  expect(requestsOf(t.secondEntries, "plan").every((r) => !partsOf(r, "shared-lesson").includes(t.proposal))).toBe(true);
  // the person's acceptance is on the store's chain, by the person, of the hash the Memory page showed
  const acc = t.s.wb.memory.entries().find((e) => e.type === "lesson.accepted" && (e.payload as { lesson: string }).lesson === t.proposal)!;
  expect(acc.actor).toEqual({ kind: "human", id: t.s.config.user });
  const third = boundOf(t.thirdEntries);
  expect(third.length).toBe(1);
  // newest acceptance first
  const three = [t.proposal, ...[...t.acceptedSeeds].reverse()];
  expect(third[0]!.payload.lessons.map((l) => l.lesson)).toEqual(three);
  for (const r of requestsOf(t.thirdEntries, "plan")) expect(partsOf(r, "shared-lesson")).toEqual(three);
}, 300_000);

test("a TLP:RED lesson accepted for unknown-device is in no blob of a TLP:GREEN case and in the lock of a TLP:RED one", async () => {
  const t = await theStory();
  const { s } = t;
  // a person proposes and accepts a TLP:AMBER and a TLP:RED lesson for the type
  const ids: Record<string, string> = {};
  for (const [marking, text] of [["TLP:AMBER", AMBER_TEXT], ["TLP:RED", RED_TEXT]] as const) {
    const r = await s.post("/api/memory/lessons", { case_type: "unknown-device", title: `A ${marking} lesson`, text, triggers: [], marking, supersedes: null });
    expect(r.status).toBe(200);
    const id = ((await r.json()) as { id: string }).id;
    const hash = s.wb.memory.state.lessons[id]!.hash;
    expect((await s.post(`/api/memory/lessons/${id}/accept`, { hash })).status).toBe(200);
    ids[marking] = id;
  }
  // a GREEN case runs to its plan gate: neither text is in any blob of it, and the lock names them only as left out for their marking
  const green = await s.newCase({ loop: "unknown-device" });
  await s.toPlanGate(green);
  const greenDir = join(s.config.data_dir, "cases", green);
  const text = blobsText(greenDir);
  expect(text).not.toContain("AMBERMARK");
  expect(text).not.toContain("REDMARK");
  const greenLock = lockOf(s.app.hub.read(green).blobs, boundOf(s.entries(green))[0]!);
  expect(greenLock.lessons.map((l) => l.lesson)).not.toContain(ids["TLP:AMBER"]);
  expect(greenLock.left_out.filter((x) => x.why === "marking").map((x) => x.lesson).sort()).toEqual([ids["TLP:AMBER"]!, ids["TLP:RED"]!].sort());
  // a lesson left out is named by id and reason only: no title or text of it is in the case
  for (const x of greenLock.left_out) expect(Object.keys(x).sort()).toEqual(["lesson", "why"]);
  for (const r of requestsOf(s.entries(green))) for (const i of r.payload.pack) expect(i.kind === "shared-lesson" && [ids["TLP:AMBER"], ids["TLP:RED"]].includes(i.id)).toBe(false);
  // an AMBER case's lock holds the AMBER lesson and not the RED; a RED case's holds both
  for (const [marking, want] of [["TLP:AMBER", [ids["TLP:AMBER"]]], ["TLP:RED", [ids["TLP:AMBER"], ids["TLP:RED"]]]] as const) {
    const id = await s.newCase({ loop: "unknown-device", marking });
    expect((await s.command(id, "start_run")).status).toBe(200);
    await s.app.hub.idle();
    const lock = lockOf(s.app.hub.read(id).blobs, boundOf(s.entries(id))[0]!);
    const locked = lock.lessons.map((l) => l.lesson);
    for (const w of want) expect(locked).toContain(w!);
    if (marking === "TLP:AMBER") expect(locked).not.toContain(ids["TLP:RED"]);
    expect(lock.lessons.find((l) => l.lesson === want.at(-1))!.marking).toBe(marking);
    expect(s.app.hub.read(id).state.skipped).toEqual([]);
  }
  expect(s.app.hub.read(green).state.skipped).toEqual([]);
}, 300_000);

test("the case's ledger verifies, replays to the same state at every entry, and each stage's parts at replay are the parts its request recorded, with the store folder moved away", async () => {
  const t = await theStory();
  expect(verifyCase(t.firstDir).ok).toBe(true);
  // the case's folder alone, in a folder with no store beside it: its replay reads nothing else
  const alone = tmp("alone");
  cpSync(t.firstDir, join(alone, t.first), { recursive: true });
  const ledger = Ledger.open(join(alone, t.first, "ledger.sqlite"), t.first);
  const entries = ledger.read();
  ledger.close();
  expect(entries).toEqual(t.firstEntries);
  expect(existsSync(join(alone, "memory"))).toBe(false);
  for (let n = 1; n <= entries.length; n++) {
    const at = fold(entries, n);
    expect(at.skipped).toEqual([]);
  }
  expect(fold(entries, entries.length)).toEqual(t.firstState);
  const blobs = new BlobStore(join(alone, t.first, "blobs"));
  const uses = usesOf(t, t.first);
  const registry = t.s.app.hub.depsFor(t.first).registry;
  const checked = replayParts(entries, blobs, uses, registry);
  expect(checked).toBeGreaterThan(0);
}, 300_000);

/**
 * For each request of a stage that reads memory: the memory parts rebuilt from the case's fold where that stage pass started (a stage sees the
 * notes as they are when it starts) have the ids and hashes its pack lists, and its messages hold their text.
 */
function replayParts(entries: readonly Entry[], blobs: BlobStore, uses: readonly MemoryUse[], registry: Parameters<typeof memoryParts>[3]): number {
  let checked = 0;
  for (const e of requestsOf(entries)) {
    if (!MEMORY_STAGES.includes(e.stage ?? "")) continue;
    const start = entries.filter((x) => x.type === "stage.started" && x.seq < e.seq && (x.payload as { stage: string }).stage === e.stage).at(-1)!.seq;
    const at = { state: fold([...entries], start), entries: () => entries.slice(0, start), blobs };
    const parts = memoryParts(at, e.stage!, uses, registry);
    const recorded = e.payload.pack.filter((i) => i.kind === "shared-lesson" || i.kind === "case-note").map((i) => `${i.kind}:${i.id}:${i.hash}`);
    expect(parts.map((p) => `${p.kind}:${p.id}:${sha256Hex(p.text)}`)).toEqual(recorded);
    const sent = blobs.text(e.payload.messages.blob);
    for (const p of parts) expect(sent).toContain(p.text.split("\n")[1]!);
    checked += recorded.length;
  }
  return checked;
}

test("the store verifies, its fold at every n is foldLessons(entries, n), and verifyMemoryLinks matches every locked lesson", async () => {
  const t = await theStory();
  const storeDir = t.s.config.memory.store;
  const report = verifyMemory(storeDir);
  expect(report.ok).toBe(true);
  expect(report.lessons).toEqual({ ok: true, bad: [], skipped: 0 });
  const entries = t.s.wb.memory.entries();
  for (let n = 1; n <= entries.length; n++) expect(foldLessons(entries, n)).toEqual(foldLessons(entries.slice(0, n)));
  expect(foldLessons(entries)).toEqual(t.s.wb.memory.state as ReturnType<typeof foldLessons>);
  expect(t.s.wb.memory.state.skipped).toEqual([]);
  for (const id of [t.first, t.second, t.third]) {
    // each case verifies and replays on its own too
    expect(verifyCase(join(t.s.config.data_dir, "cases", id)).ok).toBe(true);
    const own = t.s.entries(id);
    for (let n = 1; n <= own.length; n++) expect(fold(own, n).skipped).toEqual([]);
    expect(fold(own, own.length)).toEqual(t.s.app.hub.read(id).state);
    const links = verifyMemoryLinks(join(t.s.config.data_dir, "cases", id), storeDir);
    expect(links.ok).toBe(true);
    expect(links.links.length).toBeGreaterThan(0);
    for (const l of links.links) expect(l.status).toBe("matches");
  }
}, 300_000);

test("the store exported from this workbench loads into a new one, and a case there binds the same lessons with the same hashes", async () => {
  const t = await theStory();
  const res = await t.s.post("/api/memory/export", {});
  expect(res.status).toBe(200);
  const { file } = (await res.json()) as { file: string };
  expect(file).toMatch(/^memory\.TLP-[A-Z+]+\.[0-9a-f]{12}\.memory\.tar\.gz$/);
  const path = join(t.s.config.memory.files, file);
  // a new workbench over the same root: the store is loaded before it is first composed (compose would file the seeds into an empty store)
  const d = tmp("fresh");
  const config: Config = { ...t.s.config, data_dir: join(d, "wb"), cases: { ...t.s.config.cases, store: join(d, "wb", "store") }, loops: { ...t.s.config.loops, store: join(d, "wb", "loops"), imports: join(d, "wb", "imported") }, memory: { ...t.s.config.memory, store: join(d, "wb", "memory"), files: join(d, "wb", "memory-files") } };
  const wb = Workbench.open(config.data_dir, { onError: () => {}, memory: config.memory.store });
  try {
    const loaded = await wb.loadMemory(path, { actor: human });
    expect(loaded.head).toEqual(t.s.wb.memory.head());
    expect(wb.memory.origin()).toBe(t.s.wb.memory.origin());
    const composed = compose(config, wb);
    try {
      expect(composed.problems).toEqual([]);
      // the seeds were filed already: compose files nothing
      expect(wb.memory.head()).toEqual(t.s.wb.memory.head());
      const s = wb.createCase(caseInput, human, { loop: "unknown-device", type: "unknown-device" });
      const engine = Engine.open(s, composed.deps);
      engine.start(human);
      engine.close();
      const here = boundOf(s.entries())[0]!.payload.lessons;
      const greenNow = shared(t.s.wb.memory.state).filter((l) => l.case_type === "unknown-device" && l.marking !== "TLP:AMBER" && l.marking !== "TLP:RED");
      expect(here.map((l) => l.lesson).sort()).toEqual(greenNow.map((l) => l.id).sort());
      const there = boundOf(t.thirdEntries)[0]!.payload.lessons;
      expect(here).toEqual(there);
      expect(s.state.skipped).toEqual([]);
    } finally {
      composed.close();
    }
  } finally {
    wb.close();
  }
}, 300_000);

test("the case unloads to a case file and loads into a workbench with an empty memory store; its replay gives the same parts", async () => {
  const t = await theStory();
  const res = await t.s.post(`/api/cases/${t.first}/unload`, {});
  expect(res.status).toBe(200);
  const { file } = (await res.json()) as { file: string };
  const d = tmp("carried");
  const wb = Workbench.open(join(d, "wb"), { onError: () => {}, memory: join(d, "wb", "memory") });
  try {
    expect(wb.memory.head().seq).toBe(0);
    const { session } = await wb.loadCase(join(t.s.config.cases.store, file), { actor: human });
    const entries = session.entries();
    expect(entries.slice(0, t.firstEntries.length)).toEqual(t.firstEntries);
    expect(verifyCase(session.dir).ok).toBe(true);
    for (let n = 1; n <= entries.length; n++) expect(fold(entries, n).skipped).toEqual([]);
    const lock = t.s.app.hub.depsFor(t.second).lock!;
    const checked = replayParts(entries, new BlobStore(join(session.dir, "blobs")), memoryUses(lock), t.s.app.hub.depsFor(t.second).registry);
    expect(checked).toBeGreaterThan(0);
    // nothing was written into the empty store, and the lock is another store's
    expect(wb.memory.head().seq).toBe(0);
    expect(verifyMemoryLinks(session.dir, join(d, "wb", "memory")).links.every((l) => l.status === "not_this_store")).toBe(true);
  } finally {
    wb.close();
  }
}, 300_000);

// ---------- the investigation loop is what it was ----------

/** An investigation case run to a published product on a served workbench; its entries. */
async function investigationRun(s: Served): Promise<Entry[]> {
  const id = await s.newCase();
  await s.toPublishGate(id);
  await ok(s.command(id, "approve"), "approve");
  await s.app.hub.idle();
  expect(s.app.hub.read(id).state.run.outcome).toBe("published");
  return s.entries(id);
}
/**
 * What an entry says, without when it was written and what follows from that, from the case's own id or from the port of the stand-in service:
 * the chain's hashes, how long a query took, the hash of the case part (its text names the case), and the hash of each blob (a request's
 * messages and a bundle hold the id and the times; their sizes stay).
 */
const said = (e: Entry): unknown => JSON.parse(JSON.stringify({ ...e, ts: null, hash: null, prev_hash: null }, (k, v: unknown) => {
  if (k === "ts" || /_ts$/.test(k) || k === "blob" || k === "head_hash" || k === "duration_ms") return null;
  if (typeof v === "string") return v.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>");
  if (typeof v !== "object" || v === null) return v;
  if ((v as { kind?: unknown }).kind === "case" && "hash" in v) return { ...v, hash: null };
  // each workbench's stand-in reputation service listens on a port of its own, which is part of that source's hash
  if ((v as { source?: unknown }).source === "reputation" && "source_hash" in v) return { ...v, source_hash: null };
  return v;
}));

test("an investigation-loop case in the same workbench writes no memory entry, and its ledger is entry for entry what the slice 12 acceptance run writes", async () => {
  const t = await theStory();
  const now = await investigationRun(t.s);
  expect(now.some((e) => SLICE_13_TYPES.includes(e.type))).toBe(false);
  // the sample as slice 12 had it: no case types, no seeds, no unknown-device loop
  const errors: unknown[] = [];
  const before = await served({
    onError: (e) => { errors.push(e); },
    before: (root) => {
      for (const f of ["case-types.yaml", "memory", "loops/unknown-device.yaml", "context/unknown-device-profile.yaml", "context/schemas/lessons-output.yaml", "context/schemas/frame-with-type.yaml", "context/personas/reviewer.md", "scripts/sample-device.yaml"]) rmSync(join(root, f), { recursive: true });
    },
  });
  try {
    expect(before.problems).toEqual([]);
    expect(before.wb.memory.head().seq).toBe(0);
    const then = await investigationRun(before);
    expect(then.some((e) => SLICE_13_TYPES.includes(e.type))).toBe(false);
    expect(now.map((e) => e.type)).toEqual(then.map((e) => e.type));
    // the same entries, but for the case's own id
    const id = (es: Entry[]): RegExp => new RegExp(`\\b${es[0]!.case}\\b`, "g");
    const as = (es: Entry[]): string => JSON.stringify(es.map(said)).replace(id(es), "CASE-N");
    expect(JSON.parse(as(now))).toEqual(JSON.parse(as(then)));
  } finally {
    await before.close();
  }
  expect(errors).toEqual([]);
}, 300_000);

test("a ledger written before this slice folds with an empty memory and nothing skipped", async () => {
  // slice 12's old-ledger path: the pipeline of the stage manifests, no loops, no memory host, no case types
  const d = tmp("old");
  const sample = sampleRoot(d);
  closers.push(() => sample.close());
  const config: Config = { ...loadConfig({ env: {}, home: d, repoRoot: d }), data_dir: join(d, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 } };
  mkdirSync(config.data_dir, { recursive: true });
  const wb = Workbench.open(config.data_dir, { onError: () => {} });
  const composed = compose(config, wb);
  try {
    const { loops: _l, components: _c, content: _b, memory: _m, case_types: _t, ...rest } = composed.deps;
    const old: EngineDeps = { ...rest, pipeline: loadPipeline(composed.deps.registry).pipeline! };
    const s = wb.createCase(caseInput, human);
    const engine = Engine.open(s, old);
    engine.start(human);
    expect((await engine.advance()).waiting).toBe("plan");
    engine.close();
    const entries = s.entries();
    expect(entries.some((e) => SLICE_13_TYPES.includes(e.type) || e.type.startsWith("loop.") || e.type.startsWith("lesson."))).toBe(false);
    for (let n = 1; n <= entries.length; n++) {
      const at = fold(entries, n);
      expect(at.memory).toEqual({ type: null, type_by: null, proposed_type: null, notes: {}, order: [], pending: null, bound: null });
      expect(at.counters.memory ?? 0).toBe(0);
      expect(at.skipped).toEqual([]);
    }
  } finally {
    composed.close();
    wb.close();
  }
}, 120_000);
