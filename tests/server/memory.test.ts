// Slice 13, Task 11: the memory store's routes. The Memory page reads the store grouped by case type; a case's Memory lens reads what its run
// was given. Every write to the store is a person's, named by the server, one at a time; a lesson's text never reaches a case whose marking is
// weaker than the lesson's.
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shared } from "../../src/core/lessons";
import type { LessonDraft } from "../../src/core/lessons";
import type { Actor } from "../../src/core/types";
import type { CaseMemoryView, MemoryView } from "../../src/core/wire";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps } from "../../src/pipeline/engine";
import { CASE_TYPE_WHY } from "../../src/pipeline/memory";
import { served, withMemoryLoop } from "../helpers/served";
import type { Served } from "../helpers/served";

const opened: Served[] = [];
afterEach(async () => {
  for (const s of opened.splice(0)) {
    for (const c of s.wb.listCases()) expect(s.app.hub.read(c.id).state.skipped).toEqual([]);
    expect(s.wb.memory.state.skipped).toEqual([]);
    await s.close();
  }
});
const open = async (opts: Parameters<typeof served>[0] = {}): Promise<Served> => {
  const s = await served({ before: (root) => withMemoryLoop(root), ...opts });
  opened.push(s);
  return s;
};
const person = (s: Served): Actor => ({ kind: "human", id: s.config.user });
const getJson = async <T>(s: Served, path: string): Promise<T> => {
  const res = await s.get(path);
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};
const draft = (over: Partial<LessonDraft> = {}): LessonDraft => ({
  case_type: "unknown-device", title: "Read the lease table first", text: "The lease table names a lobby device before the flows do.", triggers: [], marking: "TLP:GREEN", supersedes: null, ...over,
});
/** A lesson a person proposes in the store directly; its id and hash. */
const proposeDirect = (s: Served, over: Partial<LessonDraft> = {}): { id: string; hash: string } => {
  const { lesson } = s.wb.memory.propose(draft(over), { kind: "person" }, person(s));
  return { id: lesson.id, hash: lesson.hash };
};
const shareDirect = (s: Served, over: Partial<LessonDraft> = {}): string => {
  const l = proposeDirect(s, over);
  s.wb.memory.accept(l.id, { actor: person(s), hash: l.hash });
  return l.id;
};
const body = { case_type: "unknown-device", title: "Read the lease table first", text: "The lease table names a lobby device before the flows do.", triggers: [], marking: "TLP:GREEN" };
const proposeRoute = (s: Served, over: Record<string, unknown> = {}): Promise<Response> => s.post("/api/memory/lessons", { ...body, ...over });
const hashOf = (s: Served, id: string): string => s.wb.memory.state.lessons[id]!.hash;

/** A memo case with no type, run until Frame's question of the case's type holds it; the question's id. */
async function heldOnType(s: Served): Promise<{ id: string; question: string }> {
  const id = await s.newCase({ loop: "memo" });
  expect((await s.command(id, "start_run")).status).toBe(200);
  await s.app.hub.idle();
  const st = s.app.hub.read(id).state;
  expect(st.run).toMatchObject({ status: "paused", hold: { kind: "question", stage: "frame" } });
  const q = Object.values(st.questions).find((x) => x.why === CASE_TYPE_WHY)!;
  return { id, question: q.id };
}

// ---------- the reads ----------

test("GET /api/memory groups lessons by case type, proposals first, each with its provenance in words, its triggers in words and its history", async () => {
  const s = await open();
  const shared1 = shareDirect(s, { triggers: [{ observable: "address" }] });
  const proposed = proposeDirect(s, { title: "Ask the front desk", text: "The front desk keeps a list of the lobby's guests." }).id;
  const phishing = proposeDirect(s, { case_type: "phishing", title: "Read the headers", text: "The headers say where a message came from." }).id;
  const view = await getJson<MemoryView>(s, "/api/memory");
  expect(view.store).toEqual({ origin: s.wb.memory.origin(), head: s.wb.memory.head(), lessons: 3, skipped: 0 });
  // one group per loaded type, by id; no group for unloaded types when there are none
  expect(view.groups.map((g) => g.type?.id ?? null)).toEqual(["phishing", "unknown-device"]);
  expect(view.groups[1]!.type).toEqual({ id: "unknown-device", title: "Unknown device", about: "A device on the network that no inventory names." });
  expect(view.groups[0]!.lessons.map((l) => l.id)).toEqual([phishing]);
  expect(view.groups[1]!.lessons.map((l) => [l.id, l.status])).toEqual([[proposed, "proposed"], [shared1, "accepted"]]);
  const l = view.groups[1]!.lessons[1]!;
  expect(l).toMatchObject({
    case_type: "unknown-device", title: "Read the lease table first", triggers: [{ observable: "address" }], trigger_words: ["observable address is present"],
    marking: "TLP:GREEN", proposed_marking: "TLP:GREEN", supersedes: null, superseded_by: null,
    from: { words: "proposed by a person", case: null, kind: "person", model: false },
    proposed: { by: s.config.user }, decided: { by: s.config.user, reason: null },
  });
  expect(l.history.map((h) => [h.what, h.by])).toEqual([["proposed", s.config.user], ["accepted", s.config.user]]);
  expect(l.history.map((h) => h.seq)).toEqual([1, 2]);
  expect(view.files).toEqual([]);
});

test("a lesson whose case type is not loaded now is in the last group", async () => {
  const s = await open();
  shareDirect(s);
  const gone = proposeDirect(s, { case_type: "printer", title: "Printers wake at night", text: "A lobby printer phones home at night." }).id;
  const view = await getJson<MemoryView>(s, "/api/memory");
  expect(view.groups.map((g) => g.type?.id ?? null)).toEqual(["phishing", "unknown-device", null]);
  expect(view.groups.at(-1)!.lessons.map((l) => [l.id, l.case_type])).toEqual([[gone, "printer"]]);
});

test("the requester and the leader may not read memory: 403", async () => {
  for (const role of ["requester", "leader"] as const) {
    const s = await open({ role });
    const id = s.app.hub.create({ title: "T", asked: "A", why: "W", starting: [], window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, objective: null, marking: "TLP:GREEN" }, person(s)).id;
    for (const path of ["/api/memory", `/api/cases/${id}/memory`, "/api/memory/files/memory.TLP-GREEN.0123456789ab.memory.tar.gz"]) {
      const res = await s.get(path);
      expect(`${path} ${res.status}`).toBe(`${path} 403`);
      expect(await res.json()).toEqual({ ok: false, refused: [`the ${role} view may not read memory`] });
    }
    const res = await proposeRoute(s);
    expect(res.status).toBe(403);
    expect(s.wb.memory.head().seq).toBe(0);
  }
});

test("a lesson's text holding a source's location is shown scrubbed", async () => {
  const s = await open();
  const location = /location:\s*(\S+)/.exec(readFileSync(join(s.dir, "sample", "sources", "reputation.yaml"), "utf8"))![1]!;
  shareDirect(s, { title: `Ask ${location} last`, text: `The reputation service at ${location} answers slowly.` });
  const text = await (await s.get("/api/memory")).text();
  expect(text).not.toContain(location);
  expect(text).not.toContain(new URL(location).host);
  const id = (await heldOnType(s)).id;
  expect((await s.command(id, "set_case_type", { type: "unknown-device" })).status).toBe(200);
  await s.app.hub.idle();
  const lens = await (await s.get(`/api/cases/${id}/memory`)).text();
  expect(lens).toContain("answers slowly");
  expect(lens).not.toContain(new URL(location).host);
});

test("GET /api/cases/CASE-1/memory says the type, what Frame proposed, what the run was given with the trigger that matched each, and how many were left out and why", async () => {
  const s = await open();
  const given = shareDirect(s, { triggers: [{ observable: "address" }] });
  shareDirect(s, { title: "A watched access point", text: "REDMARKER: the lobby AP-3 is watched.", marking: "TLP:RED" });
  shareDirect(s, { title: "Printers", text: "A printer's firmware phones home.", triggers: [{ finding: "printer firmware" }] });
  const { id, question } = await heldOnType(s);
  const before = await getJson<CaseMemoryView>(s, `/api/cases/${id}/memory`);
  expect(before).toMatchObject({
    type: null, type_title: null, proposed_type: { type: "unknown-device", title: "Unknown device" }, reads: { shared: true, notes: true },
    bound: { lessons: [], left_out: { marking: 0, trigger: 0, cap: 0 } }, proposed: [],
  });
  expect(typeof before.proposed_type!.why).toBe("string");
  // the person confirms Frame's proposal: the type is set and memory bound again, and Plan reads the lessons
  expect((await s.command(id, "answer_question", { question, answer: "yes" })).status).toBe(200);
  await s.app.hub.idle();
  const after = await getJson<CaseMemoryView>(s, `/api/cases/${id}/memory`);
  const bound = s.app.hub.read(id).state.memory.bound!;
  expect(after).toMatchObject({ type: "unknown-device", type_title: "Unknown device", proposed_type: null, reads: { shared: true, notes: true } });
  expect(after.bound).toEqual({
    seq: bound.seq, store_head: s.wb.memory.head().seq,
    lessons: [{
      id: given, title: "Read the lease table first", text: "The lease table names a lobby device before the flows do.", marking: "TLP:GREEN",
      matched: ["observable address is present"], stages: ["plan", "research"], from: "proposed by a person", still_shared: true,
    }],
    left_out: { marking: 1, trigger: 1, cap: 0 },
  });
  // the text of the lesson left out for its marking is nowhere in the case's view
  expect(JSON.stringify(after)).not.toContain("REDMARKER");
});

test("a lesson retired since the run bound it is still listed for that run, marked no longer shared", async () => {
  const s = await open();
  const given = shareDirect(s);
  const { id, question } = await heldOnType(s);
  expect((await s.command(id, "answer_question", { question, answer: "unknown-device" })).status).toBe(200);
  await s.app.hub.idle();
  s.wb.memory.retire(given, { actor: person(s), reason: "the lobby has a new lease table" });
  const view = await getJson<CaseMemoryView>(s, `/api/cases/${id}/memory`);
  expect(view.bound!.lessons.map((l) => [l.id, l.still_shared])).toEqual([[given, false]]);
});

test("a case of the investigation loop reads no memory: reads is { shared: false, notes: false } and bound is null", async () => {
  const s = await open();
  shareDirect(s);
  const id = await s.newCase();
  await s.toPlanGate(id);
  expect(await getJson<CaseMemoryView>(s, `/api/cases/${id}/memory`)).toEqual({
    type: null, type_title: null, proposed_type: null, reads: { shared: false, notes: false }, bound: null, proposed: [],
  });
  expect((await s.get("/api/cases/CASE-99/memory")).status).toBe(404);
});

// ---------- the store's commands ----------

test("POST /api/memory/lessons files a proposal by the person, and it is not shared", async () => {
  const s = await open();
  const res = await proposeRoute(s, { triggers: [{ observable: "address" }] });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: "LESSON-1" });
  const [e] = s.wb.memory.entries();
  expect(e!.type).toBe("lesson.proposed");
  expect(e!.actor).toEqual({ kind: "human", id: s.config.user });
  expect(e!.payload).toMatchObject({ lesson: "LESSON-1", from: { kind: "person" }, triggers: [{ observable: "address" }], supersedes: null });
  expect(shared(s.wb.memory.state)).toEqual([]);
  // what the store refuses is 409 with its reason; what is not a lesson at all is 400
  expect(await (await proposeRoute(s, { case_type: "printer" })).json()).toEqual({ ok: false, refused: ['there is no case type "printer"'] });
  expect((await proposeRoute(s, { triggers: [{ observable: "no-such-type" }] })).status).toBe(409);
  expect((await proposeRoute(s, { title: 7 })).status).toBe(400);
  expect((await proposeRoute(s, { extra: 1 })).status).toBe(400);
  expect(s.wb.memory.head().seq).toBe(1);
});

test("a proposal from a case names the case and its product, and a marking below the case's is refused", async () => {
  const s = await open();
  const id = await s.newCase();
  await s.toPublishGate(id);
  expect((await s.command(id, "approve")).status).toBe(200);
  await s.app.hub.idle();
  const session = s.app.hub.read(id);
  const published = session.state.published.at(-1)!;
  const low = await proposeRoute(s, { case: id, marking: "TLP:CLEAR" });
  expect(low.status).toBe(409);
  expect(await low.json()).toEqual({ ok: false, refused: [`a lesson from ${id} is marked at least TLP:GREEN`] });
  expect(s.wb.memory.head().seq).toBe(0);
  const res = await proposeRoute(s, { case: id, item: "m1" });
  expect(res.status).toBe(200);
  const lesson = s.wb.memory.state.lessons["LESSON-1"]!;
  expect(lesson.from).toEqual({
    kind: "case", case: id, origin: session.entries(0, 1)[0]!.hash, run: session.state.run.id, head: { seq: session.head().seq, hash: session.head().hash },
    product: { n: published.n, draft_hash: published.draft_hash }, stage: null, model: false,
  });
  const view = await getJson<MemoryView>(s, "/api/memory");
  const shown = view.groups.flatMap((g) => g.lessons).find((l) => l.id === "LESSON-1")!;
  expect(shown.from).toMatchObject({ case: id, kind: "case", model: false });
  expect(shown.from.words).toContain(id);
  expect((await getJson<CaseMemoryView>(s, `/api/cases/${id}/memory`)).proposed).toEqual([{ id: "LESSON-1", title: "Read the lease table first", status: "proposed" }]);
  expect((await proposeRoute(s, { case: "CASE-99" })).status).toBe(404);
});

test("accept with the hash shown shares the lesson; with a stale hash it is refused: the proposal changed since you opened it", async () => {
  const s = await open();
  await proposeRoute(s);
  const stale = await s.post("/api/memory/lessons/LESSON-1/accept", { hash: "0".repeat(64) });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ ok: false, refused: ["the proposal changed since you opened it"] });
  const lower = await s.post("/api/memory/lessons/LESSON-1/accept", { hash: hashOf(s, "LESSON-1"), marking: "TLP:CLEAR" });
  expect(lower.status).toBe(409);
  const ok = await s.post("/api/memory/lessons/LESSON-1/accept", { hash: hashOf(s, "LESSON-1"), marking: "TLP:AMBER" });
  expect(ok.status).toBe(200);
  expect(s.wb.memory.state.lessons["LESSON-1"]).toMatchObject({ status: "accepted", marking: "TLP:AMBER" });
  expect((await s.post("/api/memory/lessons/LESSON-9/accept", { hash: "0".repeat(64) })).status).toBe(409);
});

test("accept, reject and retire name the person from the configuration; a body with an actor is refused", async () => {
  const s = await open();
  await proposeRoute(s);
  await proposeRoute(s, { title: "Ask the front desk" });
  const agent = { kind: "agent", id: "x" };
  for (const [path, b] of [
    ["/api/memory/lessons/LESSON-1/accept", { hash: hashOf(s, "LESSON-1"), actor: agent }],
    ["/api/memory/lessons/LESSON-2/reject", { reason: "no", actor: agent }],
    ["/api/memory/lessons/LESSON-1/retire", { reason: "no", actor: agent }],
    ["/api/memory/lessons", { ...body, actor: agent }],
    ["/api/memory/export", { actor: agent }],
    ["/api/memory/load", { file: "memory.TLP-GREEN.0123456789ab.memory.tar.gz", typed: "0123456789ab", actor: agent }],
  ] as const) {
    const res = await s.post(path, b);
    expect(`${path} ${res.status}`).toBe(`${path} 400`);
    expect(await res.json()).toEqual({ ok: false, refused: ["the server names the actor"] });
  }
  expect(s.wb.memory.head().seq).toBe(2);
  expect((await s.post("/api/memory/lessons/LESSON-1/accept", { hash: hashOf(s, "LESSON-1") })).status).toBe(200);
  expect((await s.post("/api/memory/lessons/LESSON-2/reject", { reason: "the front desk keeps no list" })).status).toBe(200);
  expect((await s.post("/api/memory/lessons/LESSON-1/retire", { reason: "the lobby has a new lease table" })).status).toBe(200);
  const written = s.wb.memory.entries().slice(2);
  expect(written.map((e) => [e.type, e.actor])).toEqual([
    ["lesson.accepted", { kind: "human", id: s.config.user }], ["lesson.rejected", { kind: "human", id: s.config.user }], ["lesson.retired", { kind: "human", id: s.config.user }],
  ]);
});

test("two proposals sent at once get two ids", async () => {
  const s = await open();
  const [a, b] = await Promise.all([proposeRoute(s), proposeRoute(s, { title: "Ask the front desk" })]);
  const ids = [((await a.json()) as { id: string }).id, ((await b.json()) as { id: string }).id].sort();
  expect(ids).toEqual(["LESSON-1", "LESSON-2"]);
  expect(s.wb.memory.state.skipped).toEqual([]);
});

test("reject and retire need a reason", async () => {
  const s = await open();
  await proposeRoute(s);
  await proposeRoute(s, { title: "Ask the front desk" });
  await s.post("/api/memory/lessons/LESSON-1/accept", { hash: hashOf(s, "LESSON-1") });
  const head = s.wb.memory.head().seq;
  expect(await (await s.post("/api/memory/lessons/LESSON-2/reject", {})).json()).toEqual({ ok: false, refused: ["reason must be text"] });
  expect(await (await s.post("/api/memory/lessons/LESSON-2/reject", { reason: " " })).json()).toEqual({ ok: false, refused: ["a rejection needs a reason"] });
  expect(await (await s.post("/api/memory/lessons/LESSON-1/retire", { reason: "" })).json()).toEqual({ ok: false, refused: ["retiring a lesson needs a reason"] });
  expect(s.wb.memory.head().seq).toBe(head);
});

/** A served workbench whose store holds two lessons, one shared, exported; the file's name and its head's first 12 hex. */
async function exported(s: Served): Promise<{ file: string; head12: string }> {
  await proposeRoute(s);
  await proposeRoute(s, { title: "Ask the front desk" });
  await s.post("/api/memory/lessons/LESSON-1/accept", { hash: hashOf(s, "LESSON-1") });
  const res = await s.post("/api/memory/export", {});
  expect(res.status).toBe(200);
  const { file } = (await res.json()) as { file: string };
  return { file, head12: s.wb.memory.head().hash.slice(0, 12) };
}

test("export writes a file into memory.files that GET /api/memory lists; load of it into another served workbench with an empty store gives that workbench the lessons", async () => {
  const a = await open();
  const { file, head12 } = await exported(a);
  expect(readdirSync(a.config.memory.files)).toEqual([file]);
  expect(a.wb.chain.read().some((e) => e.type === "memory.exported" && e.actor.kind === "human")).toBe(true);
  const view = await getJson<MemoryView>(a, "/api/memory");
  expect(view.files).toEqual([{ file, bytes: readFileSync(join(a.config.memory.files, file)).length, marking: "TLP:GREEN", lessons: 2, head: head12, problem: null }]);
  // the download is an attachment that never runs as a page
  const down = await a.get(`/api/memory/files/${file}`);
  expect(down.status).toBe(200);
  expect(down.headers.get("content-disposition")).toBe(`attachment; filename="${file}"`);
  expect(down.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await down.arrayBuffer())).toEqual(new Uint8Array(readFileSync(join(a.config.memory.files, file))));
  expect((await a.get("/api/memory/files/memory.TLP-GREEN.0123456789ab.memory.tar.gz")).status).toBe(404);

  const b = await open();
  expect(existsSync(b.config.memory.files)).toBe(false);
  mkdirSync(b.config.memory.files, { recursive: true });
  copyFileSync(join(a.config.memory.files, file), join(b.config.memory.files, file));
  const res = await b.post("/api/memory/load", { file, typed: head12 });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ lessons: 2 });
  const loaded = await getJson<MemoryView>(b, "/api/memory");
  expect(loaded.store.origin).toBe(a.wb.memory.origin());
  expect(loaded.groups.flatMap((g) => g.lessons).map((l) => [l.id, l.status]).sort()).toEqual([["LESSON-1", "accepted"], ["LESSON-2", "proposed"]]);
  expect(b.wb.chain.read().some((e) => e.type === "memory.loaded" && e.actor.kind === "human")).toBe(true);
});

test("load with the wrong typed text, of a file of another store, or while a run is running is refused and the store is what it was", async () => {
  const a = await open();
  const { file, head12 } = await exported(a);
  const b = await open();
  mkdirSync(b.config.memory.files, { recursive: true });
  copyFileSync(join(a.config.memory.files, file), join(b.config.memory.files, file));
  const load = (typed: string): Promise<Response> => b.post("/api/memory/load", { file, typed });
  // the wrong characters typed
  const wrong = await load("ffffffffffff");
  expect(wrong.status).toBe(409);
  expect(await wrong.json()).toEqual({ ok: false, refused: ["the characters typed are not the first 12 of the file's head; nothing was loaded"] });
  expect(b.wb.memory.head().seq).toBe(0);
  // while a run is running
  const id = await b.newCase();
  new Engine(b.wb.session(id), (b.app.hub as unknown as { deps: EngineDeps }).deps).start(person(b));
  const running = await load(head12);
  expect(running.status).toBe(409);
  expect(await running.json()).toEqual({ ok: false, refused: [`a memory store is not loaded while a run is running (${id}); pause or stop it first`] });
  expect(b.wb.memory.head().seq).toBe(0);
  b.app.hub.engine(id).stop(person(b), "test");
  // a file of another store, once this one has a lesson of its own
  await proposeRoute(b);
  const before = b.wb.memory.head();
  const other = await load(head12);
  expect(other.status).toBe(409);
  expect(((await other.json()) as { refused: string[] }).refused[0]).toContain("another workbench's memory store");
  expect(b.wb.memory.head()).toEqual(before);
  expect(b.wb.chain.read().some((e) => e.type === "memory.loaded")).toBe(false);
});

test("a file name with a slash or .. is refused", async () => {
  const s = await open();
  for (const file of ["../memory.TLP-GREEN.0123456789ab.memory.tar.gz", "a/memory.TLP-GREEN.0123456789ab.memory.tar.gz", "..", "memory.TLP-GREEN.0123456789ab.tar.gz", "", 7, null]) {
    const res = await s.post("/api/memory/load", { file, typed: "0123456789ab" });
    expect(`${String(file)} ${res.status}`).toBe(`${String(file)} 400`);
    expect(await res.json()).toEqual({ ok: false, refused: ["file must be a memory file's name"] });
  }
  for (const path of ["%2E%2E%2Fmemory.TLP-GREEN.0123456789ab.memory.tar.gz", "a%2Fmemory.TLP-GREEN.0123456789ab.memory.tar.gz", "..", "%2E%2E"]) {
    const res = await s.get(`/api/memory/files/${path}`);
    expect(`${path} ${[400, 404].includes(res.status)}`).toBe(`${path} true`);
  }
  const res = await s.get("/api/memory/files/%2E%2E%2Fmemory.TLP-GREEN.0123456789ab.memory.tar.gz");
  expect(await res.json()).toEqual({ ok: false, refused: ["file must be a memory file's name"] });
});

test("GET /api/cases/CASE-1/memory?at=N gives the type and the binding in force after entry N; an at that is not an entry's number is 400", async () => {
  const s = await open();
  const first = shareDirect(s, { title: "The first lesson" });
  const id = await s.newCase({ loop: "memo", type: "unknown-device" });
  await s.toPlanGate(id);
  const boundAt = s.app.hub.read(id).state.memory.bound!.seq;
  const mid = s.app.hub.read(id).state.seq;
  const second = shareDirect(s, { title: "The second lesson" });
  expect((await s.command(id, "set_case_type", { type: null })).status).toBe(200);
  expect((await s.command(id, "set_case_type", { type: "unknown-device" })).status).toBe(200);
  const live = await getJson<CaseMemoryView>(s, `/api/cases/${id}/memory`);
  expect(live.bound!.lessons.map((l) => l.id)).toEqual([second, first]);
  const then = await getJson<CaseMemoryView>(s, `/api/cases/${id}/memory?at=${mid}`);
  expect(then.bound!.seq).toBe(boundAt);
  expect(then.bound!.lessons.map((l) => l.id)).toEqual([first]);
  expect(then.type).toBe("unknown-device");
  // after the type was cleared, the binding then in force gave nothing, and the case had no type
  const cleared = s.entries(id).filter((e) => e.type === "memory.bound")[1]!.seq;
  const none = await getJson<CaseMemoryView>(s, `/api/cases/${id}/memory?at=${cleared}`);
  expect([none.type, none.bound!.seq, none.bound!.lessons]).toEqual([null, cleared, []]);
  // before the run bound memory: no binding
  expect((await getJson<CaseMemoryView>(s, `/api/cases/${id}/memory?at=1`)).bound).toBeNull();
  // an at past the head is the case as it stands
  expect(await getJson<CaseMemoryView>(s, `/api/cases/${id}/memory?at=${s.app.hub.read(id).state.seq + 5}`)).toEqual(live);
  for (const bad of ["0", "-1", "x", "1.5", ""]) expect((await s.get(`/api/cases/${id}/memory?at=${bad}`)).status).toBe(400);
});

// ---------- final review I1: a secret in a reason is not stored, exported or served ----------

test("a reject or retire reason holding a credential's value is stored redacted: GET /api/memory and the exported file hold no value; a reason over 500 characters is 409", async () => {
  const value = "s3cr3t-Value-0123456789";
  const s = await open({ credential: { name: "PROBE_CRED", value } });
  await proposeRoute(s);
  await proposeRoute(s, { title: "Ask the front desk" });
  await s.post("/api/memory/lessons/LESSON-2/accept", { hash: hashOf(s, "LESSON-2") });
  const long = await s.post("/api/memory/lessons/LESSON-1/reject", { reason: "a".repeat(200_000) });
  expect(long.status).toBe(409);
  expect(await long.json()).toEqual({ ok: false, refused: ["a reason is at most 500 characters"] });
  expect((await s.post("/api/memory/lessons/LESSON-1/reject", { reason: `because ${value}` })).status).toBe(200);
  expect((await s.post("/api/memory/lessons/LESSON-2/retire", { reason: `old, ${value}` })).status).toBe(200);
  const view = await (await s.get("/api/memory")).text();
  expect(view).not.toContain(value);
  expect(view).toContain("because [redacted secret]");
  expect(JSON.stringify(s.wb.memory.entries())).not.toContain(value);
  const res = await s.post("/api/memory/export", {});
  expect(res.status).toBe(200);
  const { file } = (await res.json()) as { file: string };
  const unpacked = new TextDecoder("latin1").decode(Bun.gunzipSync(readFileSync(join(s.config.memory.files, file))));
  expect(unpacked).not.toContain(value);
});
