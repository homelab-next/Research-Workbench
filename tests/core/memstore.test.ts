import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENESIS } from "../../src/core/hash";
import { foldLessons, lessonHash } from "../../src/core/lessons";
import type { LessonDraft } from "../../src/core/lessons";
import { MEMORY_CHAIN, MemoryRefused, MemoryStore } from "../../src/core/memstore";
import { Refused } from "../../src/core/refused";
import type { Actor, LessonOrigin } from "../../src/core/types";
import { verifyLedger } from "../../src/core/verify";

const person: Actor = { kind: "human", id: "analyst" };
const code: Actor = { kind: "system", id: "engine" };
const agent: Actor = { kind: "agent", id: "feedback", stage: "feedback", profile: "unknown-device", model: "scripted-m", effort: null, where: "machine" };
const FROM_CASE: LessonOrigin = {
  kind: "case", case: "CASE-1", origin: "a".repeat(64), run: "run-1", head: { seq: 40, hash: "b".repeat(64) },
  product: { n: 1, draft_hash: "c".repeat(64) }, stage: "feedback", model: true,
};
const PERSON: LessonOrigin = { kind: "person" };
const draft = (over: Partial<LessonDraft> = {}): LessonDraft => ({
  case_type: "unknown-device", title: "Check the lobby access point first", text: "A device seen only on AP-3 is usually a guest in the lobby.",
  triggers: [{ observable: "address" }], marking: "TLP:GREEN", supersedes: null, ...over,
});

const dirs: string[] = [];
const stores: MemoryStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) if (s.open) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
let tick = 0;
function fresh(): MemoryStore {
  const d = mkdtempSync(join(tmpdir(), "rw-memstore-"));
  dirs.push(d);
  const s = MemoryStore.open(join(d, "memory"), { now: () => new Date(Date.UTC(2026, 10, 27, 10, 0, tick++)).toISOString() });
  stores.push(s);
  return s;
}
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MemoryRefused);
    expect(err).toBeInstanceOf(Refused);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

test("a store opened in a new folder is empty, with origin null and head seq 0", () => {
  const s = fresh();
  expect(MEMORY_CHAIN).toBe("memory");
  expect(s.open).toBe(true);
  expect(s.origin()).toBeNull();
  expect(s.head()).toEqual({ seq: 0, hash: GENESIS });
  expect(s.entries()).toEqual([]);
  expect(s.state).toEqual({ seq: 0, lessons: {}, order: [], count: 0, skipped: [] });
  expect(existsSync(join(s.dir, "ledger.sqlite"))).toBe(true);
  expect(statSync(join(s.dir, "blobs")).isDirectory()).toBe(true);
});

test("propose files LESSON-1 then LESSON-2, and the state is the fold of the ledger", () => {
  const store = fresh();
  const one = store.propose(draft(), FROM_CASE, code);
  const two = store.propose(draft({ title: "Ask the front desk" }), PERSON, person);
  expect(one.fresh).toBe(true);
  expect(one.lesson).toMatchObject({ id: "LESSON-1", status: "proposed", hash: lessonHash(draft()), from: FROM_CASE });
  expect(two.lesson.id).toBe("LESSON-2");
  expect(store.state).toEqual(foldLessons(store.entries()));
  expect(store.state.skipped).toEqual([]);
  expect(store.origin()).toBe(store.entries()[0]!.hash);
  expect(store.head().seq).toBe(2);
  expect(store.entries(1).map((e) => e.seq)).toEqual([2]);
  expect(store.entries()[0]!.case).toBe("memory");
  // only the draft's fields are written: a seed's extra fields are not
  expect(Object.keys(store.entries()[0]!.payload).sort()).toEqual(["case_type", "from", "hash", "lesson", "marking", "supersedes", "text", "title", "triggers"]);
});

test("the same proposal from the same case and run is filed once", () => {
  const store = fresh();
  const first = store.propose(draft(), FROM_CASE, code);
  const second = store.propose(draft(), FROM_CASE, code);
  expect(second.fresh).toBe(false);
  expect(second.lesson.id).toBe(first.lesson.id);
  expect(store.entries().length).toBe(1);
  // another run of the case is another proposal
  const third = store.propose(draft(), { ...FROM_CASE, run: "run-2" } as LessonOrigin, code);
  expect(third).toMatchObject({ fresh: true, lesson: { id: "LESSON-2" } });
});

test("a person's proposal that is already a proposed or shared lesson is refused: that lesson is already LESSON-1", () => {
  const store = fresh();
  store.propose(draft(), FROM_CASE, code);
  expect(refusal(() => store.propose(draft(), PERSON, person))).toBe("that lesson is already LESSON-1");
  store.accept("LESSON-1", { actor: person, hash: lessonHash(draft()) });
  expect(refusal(() => store.propose(draft(), PERSON, person))).toBe("that lesson is already LESSON-1");
  store.retire("LESSON-1", { actor: person, reason: "the lobby changed" });
  expect(store.propose(draft(), PERSON, person)).toMatchObject({ fresh: true, lesson: { id: "LESSON-2" } });
  expect(store.entries().length).toBe(4);
});

test("a proposal whose text holds a secret value is refused without the value in the message", () => {
  const store = fresh();
  const secret = "hunter2-synthetic-token";
  for (const d of [draft({ text: `The key is ${secret}.` }), draft({ title: `Use ${secret}` }), draft({ triggers: [{ finding: `saw ${secret}` }] })]) {
    const why = refusal(() => store.propose(d, PERSON, person, { secrets: [secret, "short"] }));
    expect(why).toBe("the lesson holds a secret value");
    expect(why).not.toContain(secret);
  }
  // a value shorter than 8 characters is not searched for
  expect(store.propose(draft({ text: "A short word is fine." }), PERSON, person, { secrets: ["short"] }).fresh).toBe(true);
  expect(store.entries().length).toBe(1);
});

test("a proposal for a case type or an observable type that is not here is refused when the lists are given", () => {
  const store = fresh();
  expect(refusal(() => store.propose(draft({ case_type: "phishing" }), PERSON, person, { case_types: ["unknown-device"] }))).toBe('there is no case type "phishing"');
  expect(refusal(() => store.propose(draft({ triggers: [{ observable: "mac" }] }), PERSON, person, { observables: ["address", "ip"] }))).toBe('"mac" is not an observable type here');
  expect(refusal(() => store.propose({ ...draft(), title: "" }, PERSON, person))).toBe("a lesson needs a title of 1 to 120 characters");
  expect(store.entries()).toEqual([]);
  expect(store.propose(draft(), PERSON, person, { case_types: ["unknown-device"], observables: ["address"] }).fresh).toBe(true);
});

test("accept by a person with the hash they saw shares it; with another hash it is refused: the proposal changed since you opened it", () => {
  const store = fresh();
  store.propose(draft(), FROM_CASE, code);
  expect(refusal(() => store.accept("LESSON-1", { actor: person, hash: "e".repeat(64) }))).toBe("the proposal changed since you opened it");
  expect(refusal(() => store.accept("LESSON-9", { actor: person, hash: lessonHash(draft()) }))).toBe("there is no lesson LESSON-9");
  const l = store.accept("LESSON-1", { actor: person, hash: lessonHash(draft()) });
  expect(l).toMatchObject({ status: "accepted", marking: "TLP:GREEN", decided: { by: "analyst", reason: null } });
  expect(refusal(() => store.accept("LESSON-1", { actor: person, hash: lessonHash(draft()) }))).toBe("LESSON-1 is accepted; only a proposed lesson is accepted");
  expect(store.state).toEqual(foldLessons(store.entries()));
  expect(store.state.skipped).toEqual([]);
});

test("accept, reject and retire by code or by an agent are refused and write nothing", () => {
  const store = fresh();
  store.propose(draft(), FROM_CASE, code);
  store.propose(draft({ title: "Second" }), FROM_CASE, code);
  store.accept("LESSON-2", { actor: person, hash: lessonHash(draft({ title: "Second" })) });
  const before = store.entries().length;
  for (const actor of [code, agent]) {
    expect(refusal(() => store.accept("LESSON-1", { actor, hash: lessonHash(draft()) }))).toBe("only a person accepts a lesson");
    expect(refusal(() => store.reject("LESSON-1", { actor, reason: "no" }))).toBe("only a person rejects a lesson");
    expect(refusal(() => store.retire("LESSON-2", { actor, reason: "old" }))).toBe("only a person retires a lesson");
  }
  expect(refusal(() => store.propose(draft({ title: "By a model" }), FROM_CASE, agent))).toBe("a lesson is filed by the workbench or a person, never by a model");
  expect(refusal(() => store.reject("LESSON-1", { actor: person, reason: " " }))).toBe("a rejection needs a reason");
  expect(refusal(() => store.retire("LESSON-2", { actor: person, reason: "" }))).toBe("retiring a lesson needs a reason");
  expect(store.entries().length).toBe(before);
  expect(store.reject("LESSON-1", { actor: person, reason: "not so here" }).status).toBe("rejected");
  expect(store.retire("LESSON-2", { actor: person, reason: "the lobby changed" }).status).toBe("retired");
  expect(store.state.skipped).toEqual([]);
});

test("accept may raise the marking and may not lower it", () => {
  const store = fresh();
  store.propose(draft({ marking: "TLP:AMBER" }), FROM_CASE, code);
  const hash = lessonHash(draft({ marking: "TLP:AMBER" }));
  expect(refusal(() => store.accept("LESSON-1", { actor: person, hash, marking: "TLP:GREEN" }))).toBe("a lesson's marking is raised, never lowered");
  expect(store.entries().length).toBe(1);
  const l = store.accept("LESSON-1", { actor: person, hash, marking: "TLP:RED" });
  expect(l).toMatchObject({ marking: "TLP:RED", proposed_marking: "TLP:AMBER" });
});

test("a proposal that supersedes a lesson retired since is refused at accept: LESSON-2 supersedes LESSON-1, which is not shared", () => {
  const store = fresh();
  store.propose(draft(), FROM_CASE, code);
  expect(refusal(() => store.propose(draft({ title: "v2", supersedes: "LESSON-1" }), PERSON, person))).toBe("LESSON-2 supersedes LESSON-1, which is not shared");
  expect(refusal(() => store.propose(draft({ title: "v2", supersedes: "LESSON-7" }), PERSON, person))).toBe("there is no lesson LESSON-7");
  store.accept("LESSON-1", { actor: person, hash: lessonHash(draft()) });
  const v2 = draft({ title: "v2", supersedes: "LESSON-1" });
  expect(store.propose(v2, PERSON, person).lesson.id).toBe("LESSON-2");
  store.retire("LESSON-1", { actor: person, reason: "the lobby changed" });
  const before = store.entries().length;
  expect(refusal(() => store.accept("LESSON-2", { actor: person, hash: lessonHash(v2) }))).toBe("LESSON-2 supersedes LESSON-1, which is not shared");
  expect(store.entries().length).toBe(before);
});

test("the store's ledger and blobs verify with verifyLedger, and a second open reads the same state", () => {
  const store = fresh();
  store.propose(draft(), FROM_CASE, code);
  store.accept("LESSON-1", { actor: person, hash: lessonHash(draft()) });
  store.propose(draft({ title: "Ask the front desk" }), PERSON, person);
  store.reject("LESSON-2", { actor: person, reason: "the desk does not know" });
  const report = verifyLedger(join(store.dir, "ledger.sqlite"), join(store.dir, "blobs"));
  expect(report).toMatchObject({ ok: true, case: "memory", entries: 4, head: store.head().hash, firstBad: null });
  const state = store.state;
  const head = store.head();
  const origin = store.origin();
  store.close();
  const again = MemoryStore.open(store.dir);
  stores.push(again);
  expect(again.state).toEqual(state);
  expect(again.head()).toEqual(head);
  expect(again.origin()).toBe(origin);
});

test("a closed store refuses every write", () => {
  const store = fresh();
  store.propose(draft(), FROM_CASE, code);
  store.close();
  expect(store.open).toBe(false);
  const closed = "the memory store is closed";
  expect(refusal(() => store.propose(draft({ title: "x" }), PERSON, person))).toBe(closed);
  expect(refusal(() => store.accept("LESSON-1", { actor: person, hash: lessonHash(draft()) }))).toBe(closed);
  expect(refusal(() => store.reject("LESSON-1", { actor: person, reason: "no" }))).toBe(closed);
  expect(refusal(() => store.retire("LESSON-1", { actor: person, reason: "no" }))).toBe(closed);
  store.close();
});

// ---------- final review I1: a reason is searched for secret values and is capped ----------

test("a reject or retire reason holding a secret value is written with the value redacted; nothing of it is in the ledger", () => {
  const store = fresh();
  const secret = "s3cr3t-Value-0123456789";
  store.propose(draft(), PERSON, person);
  store.propose(draft({ title: "Second" }), PERSON, person);
  store.accept("LESSON-2", { actor: person, hash: lessonHash(draft({ title: "Second" })) });
  store.reject("LESSON-1", { actor: person, reason: `because ${secret}`, secrets: [secret] });
  // the value as it is escaped inside a JSON string is found too
  const escaped = "tok\"en-with-quote-0123";
  store.retire("LESSON-2", { actor: person, reason: `old: ${secret} and ${JSON.stringify(escaped).slice(1, -1)}`, secrets: [secret, escaped] });
  const raw = JSON.stringify(store.entries());
  expect(raw).not.toContain(secret);
  expect(raw).not.toContain("tok\\\\\\\"en");
  expect(store.state.lessons["LESSON-1"]!.decided!.reason).toBe("because [redacted secret]");
  expect(store.state.lessons["LESSON-2"]!.decided!.reason).toBe("old: [redacted secret] and [redacted secret]");
  expect(store.state.skipped).toEqual([]);
});

test("a reason is at most 500 characters: a longer one is refused and writes nothing, and the fold skips one", () => {
  const store = fresh();
  store.propose(draft(), PERSON, person);
  store.propose(draft({ title: "Second" }), PERSON, person);
  store.accept("LESSON-2", { actor: person, hash: lessonHash(draft({ title: "Second" })) });
  const before = store.entries().length;
  expect(refusal(() => store.reject("LESSON-1", { actor: person, reason: "x".repeat(501) }))).toBe("a reason is at most 500 characters");
  expect(refusal(() => store.retire("LESSON-2", { actor: person, reason: "y".repeat(200_000) }))).toBe("a reason is at most 500 characters");
  expect(store.entries().length).toBe(before);
  expect(store.reject("LESSON-1", { actor: person, reason: "x".repeat(500) }).status).toBe("rejected");
  // a ledger written by other code: a rejection with a longer reason is not read
  const [first] = store.entries();
  const long = { ...first!, seq: 2, type: "lesson.rejected", actor: person, payload: { lesson: "LESSON-1", reason: "z".repeat(501) } } as unknown as typeof first;
  const s = foldLessons([first!, long!]);
  expect(s.lessons["LESSON-1"]!.status).toBe("proposed");
  expect(s.skipped.map((k) => k.seq)).toEqual([2]);
});

// ---------- final review Minors 3 and 10 ----------

test("a lesson supersedes only a lesson of its own case type: refused at propose and at accept, and the fold skips one", () => {
  const store = fresh();
  store.propose(draft(), PERSON, person);
  store.accept("LESSON-1", { actor: person, hash: lessonHash(draft()) });
  const other = draft({ case_type: "phishing", title: "Read the headers", supersedes: "LESSON-1" });
  expect(refusal(() => store.propose(other, PERSON, person))).toBe("LESSON-2 supersedes LESSON-1, a lesson of another case type");
  expect(store.entries().length).toBe(2);
  const [p1, a1] = store.entries();
  const forged = { ...p1!, seq: 3, payload: { ...(p1!.payload as object), lesson: "LESSON-2", case_type: "phishing", title: "Read the headers", supersedes: "LESSON-1", hash: lessonHash(other) } } as typeof p1;
  const st = foldLessons([p1!, a1!, forged!]);
  expect(st.skipped).toEqual([{ seq: 3, type: "lesson.proposed", reason: "a lesson supersedes one of its own case type" }]);
  expect(st.lessons["LESSON-1"]!.status).toBe("accepted");
});

test("a proposal holding a secret value as it is escaped inside a JSON string is refused too", () => {
  const store = fresh();
  const secret = "tok\"en-synthetic-0123";
  const escaped = JSON.stringify(secret).slice(1, -1);
  expect(refusal(() => store.propose(draft({ text: `The key is ${escaped}.` }), PERSON, person, { secrets: [secret] }))).toBe("the lesson holds a secret value");
  expect(store.entries()).toEqual([]);
});
