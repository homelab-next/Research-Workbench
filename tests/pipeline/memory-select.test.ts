import { expect, test } from "bun:test";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { foldLessons, lessonHash, readMemoryLock } from "../../src/core/lessons";
import type { CaseFacts, LessonDraft, StoreState } from "../../src/core/lessons";
import { fold } from "../../src/core/state";
import type { Actor, Card, Finding, LessonOrigin, Marking, Payloads, Product, Trigger } from "../../src/core/types";
import type { MemoryUse } from "../../src/pipeline/loops";
import { buildMemoryLock, factsOf, matches, selectLessons } from "../../src/pipeline/memory";
import { EntryBuilder, card } from "../helpers/entries";

const person: Actor = { kind: "human", id: "analyst" };
const code: Actor = { kind: "system", id: "engine" };
const FROM: LessonOrigin = { kind: "person" };
const WINDOW = { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" };

// ---------- the store ----------

type Step =
  | { propose: string; d?: Partial<LessonDraft> }
  | { accept: string }
  | { reject: string }
  | { retire: string };

const draft = (over: Partial<LessonDraft> = {}): LessonDraft => ({
  case_type: "unknown-device", title: "Check the lobby access point first", text: "A device seen only on AP-3 is usually a guest in the lobby.",
  triggers: [], marking: "TLP:GREEN", supersedes: null, ...over,
});

/** A store folded from its own ledger: each step is one entry, by code for a proposal and by a person for a decision. */
function storeOf(steps: Step[]): StoreState {
  const b = new EntryBuilder("memory");
  const drafts: Record<string, LessonDraft> = {};
  for (const s of steps) {
    if ("propose" in s) {
      const d = draft(s.d);
      drafts[s.propose] = d;
      b.add("lesson.proposed", { lesson: s.propose, ...d, hash: lessonHash(d), from: FROM }, { actor: person });
    } else if ("accept" in s) {
      const d = drafts[s.accept]!;
      b.add("lesson.accepted", { lesson: s.accept, hash: lessonHash(d), marking: d.marking }, { actor: person });
    } else if ("reject" in s) {
      b.add("lesson.rejected", { lesson: s.reject, reason: "not useful" }, { actor: person });
    } else {
      b.add("lesson.retired", { lesson: s.retire, reason: "out of date" }, { actor: person });
    }
  }
  const st = foldLessons(b.entries);
  expect(st.skipped).toEqual([]);
  return st;
}

const facts = (over: Partial<CaseFacts> = {}): CaseFacts => ({
  type: "unknown-device", marking: "TLP:AMBER", observables: ["address"], sources: ["wifi"], findings: ["The unknown device is a guest phone in the lobby."], ...over,
});
const use = (stage: string, selector: string, store: "shared" | "case" = "shared"): MemoryUse => ({ stage, component: `${stage}-memory`, store, selector });
const USES = [use("research", "unknown-device")];
const ids = (r: { lessons: { lesson: string }[] }): string[] => r.lessons.map((l) => l.lesson);

// ---------- a case ----------

const product = (statements: string[]): Product => {
  const key_findings: Finding[] = statements.map((statement, i) => ({
    id: `F${i + 1}`, statement, likelihood: "likely", confidence: "moderate", confidence_basis: "b", cites: [], assumptions: [], reasoning: "r",
  }));
  return {
    objective: "o", question: "q", marking: "TLP:AMBER", summary: "s", key_findings, gaps_and_limits: "", alternatives: "", assessment: "",
    sources: [], assumptions: [], change: "",
  };
};
const issued = (query: string, source: string): Payloads["query.issued"] => ({
  query, source, source_hash: "h", pivot: null, pivot_hash: null, connector: "c", text: "t", bound: {}, window: { from: null, to: null },
  why: "w", estimate: null, step: null, verifies: null, purpose: "result",
});
const extracted = (type: string, value: string): NonNullable<Card["extracted"]>[number] => ({ type, value, column: "a", rule: "r", row: 0, by: "code" });
const statement = (id: string, about: { type: string; value: string }[]): Card => card(id, {
  kind: "note", made_by: "human", columns: [], column_types: [], rows: [], row_count: 0, coverage: null,
  person: { basis: "saw", detail: "in the lobby", about, answers: null },
});

function caseBuilder(marking: Marking = "TLP:AMBER", type: string | null = "unknown-device"): EntryBuilder {
  const b = new EntryBuilder("CASE-1");
  b.add("case.created", {
    id: "CASE-1", title: "An unknown device", asked: "what is it?", why: "w", starting: [{ type: "mac", value: "02:00:5e:00:53:01" }, { type: "address", value: "192.0.2.10" }],
    window: WINDOW, objective: null, marking,
  }, { actor: person });
  if (type !== null) b.add("case.type_set", { type }, { actor: person });
  return b;
}

test("factsOf reads the type, the marking, the observable types of the starting values, extracted values and statements, the sources of the queries and of the loop, and the latest draft's finding statements", () => {
  const b = caseBuilder();
  b.add("query.issued", issued("q1", "wifi"));
  b.add("query.issued", issued("q2", "dhcp"));
  b.add("card.created", { card: card("c1", { extracted: [extracted("hostname", "printer-3.example.net")] }) });
  b.add("card.created", { card: statement("c2", [{ type: "user", value: "guest-1" }]) }, { actor: person });
  b.add("draft.revised", { draft: { n: 1, hash: "d1", author: code, product: product(["An old finding"]), reason: "r" } });
  b.add("draft.revised", { draft: { n: 2, hash: "d2", author: code, product: product(["The device is a guest phone", "It joined at noon"]), reason: "r" } });
  const state = fold(b.entries);
  expect(state.skipped).toEqual([]);
  expect(factsOf(state, ["netflow"])).toEqual({
    type: "unknown-device", marking: "TLP:AMBER",
    observables: ["address", "hostname", "mac", "user"],
    sources: ["dhcp", "netflow", "wifi"],
    findings: ["The device is a guest phone", "It joined at noon"],
  });
});

test("factsOf leaves out a discarded card's values, and lists each type and source once, sorted", () => {
  const b = caseBuilder("TLP:GREEN", null);
  b.add("query.issued", issued("q1", "wifi"));
  b.add("query.issued", issued("q2", "wifi"));
  b.add("card.created", { card: card("c1", { extracted: [extracted("address", "192.0.2.11"), extracted("hostname", "a.example.net")] }) });
  b.add("card.created", { card: card("c2", { extracted: [extracted("user", "guest-2")] }) });
  b.add("card.discarded", { card: "c2" });
  b.add("card.created", { card: statement("c3", [{ type: "domain", value: "example.org" }]) }, { actor: person });
  b.add("card.discarded", { card: "c3" });
  const state = fold(b.entries);
  expect(state.skipped).toEqual([]);
  const f = factsOf(state, ["wifi", "dhcp", "wifi"]);
  expect(f).toEqual({ type: null, marking: "TLP:GREEN", observables: ["address", "hostname", "mac"], sources: ["dhcp", "wifi"], findings: [] });
  // it copies: the facts share nothing with the state
  f.observables.push("x");
  expect(factsOf(state, []).observables).toEqual(["address", "hostname", "mac"]);
});

test("a case with no type is given no lesson, and nothing is listed as left out", () => {
  const store = storeOf([{ propose: "LESSON-1" }, { accept: "LESSON-1" }, { propose: "LESSON-2", d: { marking: "TLP:RED" } }, { accept: "LESSON-2" }]);
  expect(selectLessons(store, facts({ type: null }), [use("research", "*"), ...USES], { max: 12 })).toEqual({ lessons: [], left_out: [] });
});

test("only a shared lesson of the case's type is selected: a proposed, rejected, retired or superseded one never is", () => {
  const store = storeOf([
    { propose: "LESSON-1" }, // stays proposed
    { propose: "LESSON-2" }, { reject: "LESSON-2" },
    { propose: "LESSON-3" }, { accept: "LESSON-3" }, { retire: "LESSON-3" },
    { propose: "LESSON-4" }, { accept: "LESSON-4" },
    { propose: "LESSON-5", d: { supersedes: "LESSON-4", text: "A newer version of the lobby lesson." } }, { accept: "LESSON-5" },
    { propose: "LESSON-6", d: { case_type: "phishing" } }, { accept: "LESSON-6" },
    { propose: "LESSON-7", d: { text: "Shared and of the type." } }, { accept: "LESSON-7" },
  ]);
  expect(store.lessons["LESSON-4"]!.status).toBe("superseded");
  const r = selectLessons(store, facts(), [use("research", "*")], { max: 12 });
  expect(ids(r)).toEqual(["LESSON-7", "LESSON-5"]);
  expect(r.left_out).toEqual([]);
});

test("shared/unknown-device takes unknown-device lessons for an unknown-device case and nothing for a case of another type; shared/* takes the case's own type", () => {
  const store = storeOf([
    { propose: "LESSON-1" }, { accept: "LESSON-1" },
    { propose: "LESSON-2", d: { case_type: "phishing" } }, { accept: "LESSON-2" },
  ]);
  expect(ids(selectLessons(store, facts(), USES, { max: 12 }))).toEqual(["LESSON-1"]);
  expect(selectLessons(store, facts({ type: "phishing" }), USES, { max: 12 })).toEqual({ lessons: [], left_out: [] });
  expect(ids(selectLessons(store, facts({ type: "phishing" }), [use("research", "*")], { max: 12 }))).toEqual(["LESSON-2"]);
  expect(ids(selectLessons(store, facts(), [use("research", "*")], { max: 12 }))).toEqual(["LESSON-1"]);
  // a case/notes use takes no lesson
  expect(selectLessons(store, facts(), [use("research", "notes", "case")], { max: 12 })).toEqual({ lessons: [], left_out: [] });
});

test("a lesson's stages are the stages whose use takes it, sorted", () => {
  const store = storeOf([{ propose: "LESSON-1" }, { accept: "LESSON-1" }]);
  const uses = [use("research", "*"), use("assemble", "unknown-device"), use("research", "unknown-device"), use("plan", "phishing"), use("frame", "notes", "case")];
  const l = selectLessons(store, facts(), uses, { max: 12 }).lessons[0]!;
  expect(l.stages).toEqual(["assemble", "research"]);
});

test("a lesson stricter than the case is left out for its marking; one as strict as the case is selected", () => {
  // a TLP:RED lesson and a TLP:GREEN case: left_out [{ lesson: "LESSON-2", why: "marking" }], and its text is nowhere in the lock's canonical JSON
  const RED_TEXT = "Only for the strictest cases: the lobby badge reader logs.";
  const store = storeOf([
    { propose: "LESSON-1", d: { marking: "TLP:GREEN" } }, { accept: "LESSON-1" },
    // stricter, and its trigger does not match either: the first reason is its marking
    { propose: "LESSON-2", d: { marking: "TLP:RED", text: RED_TEXT, title: "Badge reader", triggers: [{ source: "badges" }] } }, { accept: "LESSON-2" },
  ]);
  const f = facts({ marking: "TLP:GREEN" });
  const r = selectLessons(store, f, USES, { max: 12 });
  expect(ids(r)).toEqual(["LESSON-1"]);
  expect(r.left_out).toEqual([{ lesson: "LESSON-2", why: "marking" }]);
  const lock = buildMemoryLock({ state: store, origin: "e".repeat(64), head: { seq: store.seq, hash: "f".repeat(64) } }, f, USES, { max: 12 });
  const text = canonical(lock as unknown as Json);
  expect(text).not.toContain(RED_TEXT);
  expect(text).not.toContain("Badge reader");
  // a TLP:RED case takes it
  expect(ids(selectLessons(store, facts({ marking: "TLP:RED", sources: ["badges"] }), USES, { max: 12 }))).toEqual(["LESSON-2", "LESSON-1"]);
});

test("every trigger must match: observable by type, source by id, finding by text in any case", () => {
  const f = facts();
  expect(matches({ observable: "address" }, f)).toBe(true);
  expect(matches({ observable: "mac" }, f)).toBe(false);
  expect(matches({ source: "wifi" }, f)).toBe(true);
  expect(matches({ source: "dhcp" }, f)).toBe(false);
  expect(matches({ finding: "GUEST PHONE" }, f)).toBe(true);
  expect(matches({ finding: "printer" }, f)).toBe(false);
  // a finding's words are text, never a pattern
  expect(matches({ finding: "guest.*lobby" }, f)).toBe(false);
  // an observable type is not matched by a source of the same name, nor the other way round
  expect(matches({ source: "address" }, f)).toBe(false);
  const all: Trigger[] = [{ observable: "address" }, { source: "wifi" }, { finding: "Guest Phone" }];
  const store = storeOf([
    { propose: "LESSON-1", d: { triggers: all } }, { accept: "LESSON-1" },
    { propose: "LESSON-2", d: { triggers: [...all.slice(0, 2), { observable: "mac" }], text: "Needs a mac." } }, { accept: "LESSON-2" },
  ]);
  const r = selectLessons(store, f, USES, { max: 12 });
  expect(ids(r)).toEqual(["LESSON-1"]);
  expect(r.left_out).toEqual([{ lesson: "LESSON-2", why: "trigger" }]);
});

test("a lesson with no trigger is selected for every case of its type, and says so in matched", () => {
  const store = storeOf([{ propose: "LESSON-1", d: { triggers: [] } }, { accept: "LESSON-1" }]);
  const l = selectLessons(store, facts({ observables: [], sources: [], findings: [] }), USES, { max: 12 }).lessons[0]!;
  expect(l.matched).toEqual(["every unknown-device case"]);
});

test("matched holds each matched trigger in words", () => {
  const store = storeOf([{ propose: "LESSON-1", d: { triggers: [{ observable: "address" }, { source: "wifi" }] } }, { accept: "LESSON-1" }]);
  const l = selectLessons(store, facts(), USES, { max: 12 }).lessons[0]!;
  expect(l.matched).toEqual(["observable address is present", "source wifi was used"]);
});

test("lessons are ordered newest acceptance first, then by id, and cut at max; the rest are left out for the cap", () => {
  const store = storeOf([
    { propose: "LESSON-1" }, { propose: "LESSON-2", d: { text: "two" } }, { propose: "LESSON-3", d: { text: "three" } }, { propose: "LESSON-4", d: { text: "four" } },
    { accept: "LESSON-3" }, { accept: "LESSON-1" }, { accept: "LESSON-4" }, { accept: "LESSON-2" },
  ]);
  const all = selectLessons(store, facts(), USES, { max: 12 });
  expect(ids(all)).toEqual(["LESSON-2", "LESSON-4", "LESSON-1", "LESSON-3"]);
  expect(all.left_out).toEqual([]);
  const cut = selectLessons(store, facts(), USES, { max: 2 });
  expect(ids(cut)).toEqual(["LESSON-2", "LESSON-4"]);
  expect(cut.left_out).toEqual([{ lesson: "LESSON-1", why: "cap" }, { lesson: "LESSON-3", why: "cap" }]);
  // a lesson left out for its marking or a trigger does not take a place under the cap
  const mixed = storeOf([
    { propose: "LESSON-1" }, { propose: "LESSON-2", d: { text: "red", marking: "TLP:RED" } }, { propose: "LESSON-3", d: { text: "trigger", triggers: [{ source: "dhcp" }] } },
    { accept: "LESSON-1" }, { accept: "LESSON-2" }, { accept: "LESSON-3" },
  ]);
  const m = selectLessons(mixed, facts(), USES, { max: 1 });
  expect(ids(m)).toEqual(["LESSON-1"]);
  expect(m.left_out).toEqual([{ lesson: "LESSON-2", why: "marking" }, { lesson: "LESSON-3", why: "trigger" }]);
});

test("selection is the same for the same store and facts, whatever order the store's record holds its lessons in", () => {
  const store = storeOf([
    { propose: "LESSON-1" }, { propose: "LESSON-2", d: { text: "two", triggers: [{ source: "wifi" }] } }, { propose: "LESSON-3", d: { text: "three", marking: "TLP:RED" } },
    { accept: "LESSON-2" }, { accept: "LESSON-1" }, { accept: "LESSON-3" },
  ]);
  const reversed: StoreState = {
    ...store,
    lessons: Object.fromEntries(Object.entries(store.lessons).reverse()),
    order: [...store.order].reverse(),
  };
  expect(Object.keys(reversed.lessons)).toEqual(["LESSON-3", "LESSON-2", "LESSON-1"]);
  const a = selectLessons(store, facts(), USES, { max: 12 });
  expect(selectLessons(reversed, facts(), USES, { max: 12 })).toEqual(a);
  expect(canonical(selectLessons(reversed, facts(), [...USES].reverse(), { max: 12 }) as unknown as Json)).toBe(canonical(a as unknown as Json));
  // and selection changes neither its store nor its facts
  const before = canonical(store as unknown as Json);
  const f = facts();
  selectLessons(store, f, USES, { max: 12 });
  expect(canonical(store as unknown as Json)).toBe(before);
  expect(f).toEqual(facts());
});

test("buildMemoryLock holds the store's origin and head, the facts, the lessons and what was left out, and readMemoryLock reads its canonical JSON back", () => {
  const store = storeOf([
    { propose: "LESSON-1", d: { triggers: [{ observable: "address" }] } }, { accept: "LESSON-1" },
    { propose: "LESSON-2", d: { text: "red", marking: "TLP:RED" } }, { accept: "LESSON-2" },
  ]);
  const head = { seq: store.seq, hash: "f".repeat(64) };
  const f = facts();
  const lock = buildMemoryLock({ state: store, origin: "e".repeat(64), head }, f, USES, { max: 12 });
  const l1 = store.lessons["LESSON-1"]!;
  expect(lock).toEqual({
    format: 1, store: { origin: "e".repeat(64), head }, case_type: "unknown-device", facts: f,
    lessons: [{
      lesson: "LESSON-1", hash: lessonHash(draft({ triggers: [{ observable: "address" }] })), case_type: "unknown-device", title: l1.title, text: l1.text,
      marking: "TLP:GREEN", triggers: [{ observable: "address" }], matched: ["observable address is present"], from: { kind: "person" },
      accepted: { by: "analyst", seq: l1.decided!.seq, ts: l1.decided!.ts }, supersedes: null, stages: ["research"],
    }],
    left_out: [{ lesson: "LESSON-2", why: "marking" }],
  });
  // the selected lesson's hash is the one the person accepted, so a replay reads exactly what was given
  expect(lock.lessons[0]!.hash).toBe(l1.hash);
  expect(readMemoryLock(new TextEncoder().encode(canonical(lock as unknown as Json)))).toEqual(lock);
  // the lock shares nothing with the store or the facts
  lock.lessons[0]!.triggers.push({ source: "x" });
  lock.facts.observables.push("x");
  expect(store.lessons["LESSON-1"]!.triggers).toEqual([{ observable: "address" }]);
  expect(f.observables).toEqual(["address"]);
});

test("a lesson retired or superseded after a lock was built stays in that lock, and is not selected for a new one", () => {
  const b = new EntryBuilder("memory");
  const d1 = draft();
  b.add("lesson.proposed", { lesson: "LESSON-1", ...d1, hash: lessonHash(d1), from: FROM }, { actor: person });
  b.add("lesson.accepted", { lesson: "LESSON-1", hash: lessonHash(d1), marking: d1.marking }, { actor: person });
  const d2 = draft({ text: "other" });
  b.add("lesson.proposed", { lesson: "LESSON-2", ...d2, hash: lessonHash(d2), from: FROM }, { actor: person });
  b.add("lesson.accepted", { lesson: "LESSON-2", hash: lessonHash(d2), marking: d2.marking }, { actor: person });
  const at = b.entries.length;
  const then = foldLessons(b.entries);
  const bound = buildMemoryLock({ state: then, origin: null, head: { seq: at, hash: "a".repeat(64) } }, facts(), USES, { max: 12 });
  const bytes = canonical(bound as unknown as Json);
  b.add("lesson.retired", { lesson: "LESSON-1", reason: "out of date" }, { actor: person });
  const d3 = draft({ text: "newer", supersedes: "LESSON-2" });
  b.add("lesson.proposed", { lesson: "LESSON-3", ...d3, hash: lessonHash(d3), from: FROM }, { actor: person });
  b.add("lesson.accepted", { lesson: "LESSON-3", hash: lessonHash(d3), marking: d3.marking }, { actor: person });
  const now = foldLessons(b.entries);
  expect(now.skipped).toEqual([]);
  expect(ids(bound)).toEqual(["LESSON-2", "LESSON-1"]);
  expect(canonical(bound as unknown as Json)).toBe(bytes);
  // the store at the bound head selects what the lock holds
  expect(buildMemoryLock({ state: foldLessons(b.entries, at), origin: null, head: { seq: at, hash: "a".repeat(64) } }, facts(), USES, { max: 12 })).toEqual(bound);
  expect(ids(buildMemoryLock({ state: now, origin: null, head: { seq: now.seq, hash: "b".repeat(64) } }, facts(), USES, { max: 12 }))).toEqual(["LESSON-3"]);
});

test("with no shared use there are no lessons", () => {
  const store = storeOf([{ propose: "LESSON-1" }, { accept: "LESSON-1" }]);
  expect(selectLessons(store, facts(), [], { max: 12 })).toEqual({ lessons: [], left_out: [] });
  expect(selectLessons(store, facts(), [use("research", "notes", "case")], { max: 12 })).toEqual({ lessons: [], left_out: [] });
  const lock = buildMemoryLock({ state: store, origin: null, head: { seq: store.seq, hash: "c".repeat(64) } }, facts(), [], { max: 12 });
  expect(lock.lessons).toEqual([]);
  expect(lock.left_out).toEqual([]);
});
