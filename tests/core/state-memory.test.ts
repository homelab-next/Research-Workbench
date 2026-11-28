import { expect, test } from "bun:test";
import { fold, initial, initialMemory, liveNotes } from "../../src/core/state";
import type { Actor, BlobRef, Payloads, StageDef } from "../../src/core/types";
import { card, EntryBuilder } from "../helpers/entries";

const person: Actor = { kind: "human", id: "analyst" };
const code: Actor = { kind: "system", id: "engine" };
const researcher: Actor = { kind: "agent", id: "researcher", stage: "research", profile: "investigation", model: "scripted-m", effort: null, where: "machine" };

const CASE: Payloads["case.created"] = {
  id: "CASE-1", title: "An unknown device", asked: "What is 192.0.2.44?", why: "alert", starting: [{ type: "ip", value: "192.0.2.44" }],
  window: { from: null, to: null }, objective: null, marking: "TLP:AMBER",
};
const stages: StageDef[] = [
  { id: "frame", title: "Frame", phase: "direct", runs: "agent", gate: null, reviews: false, model: null },
  { id: "research", title: "Research", phase: "collect", runs: "agent", gate: null, reviews: false, model: null },
];
const runStarted = (run: string): Payloads["run.started"] => ({ run, pipeline: "unknown-device", pipeline_hash: "h".repeat(64), stages });
const note = (item: string, over: Partial<Payloads["memory.noted"]> = {}): Payloads["memory.noted"] => ({
  item, kind: "pointer", text: "the access point in the lobby is ap-3; see c5", cards: ["c5"], ...over,
});

function opened(): EntryBuilder {
  const b = new EntryBuilder();
  b.add("case.created", CASE, { actor: person });
  return b;
}
function running(): EntryBuilder {
  const b = opened();
  b.add("run.started", runStarted("run-1"), { actor: code });
  return b;
}

// ---------- the case's type ----------

test("a ledger with none of the new entries has an empty memory and a memory counter of 0", () => {
  const s = fold(running().entries);
  expect(s.memory).toEqual({ type: null, type_by: null, proposed_type: null, notes: {}, order: [], pending: null, bound: null }); expect(s.counters.memory).toBe(0);
  expect(initial().memory).toEqual(initialMemory());
  expect(s.skipped).toEqual([]);
});

test("case.type_set by a person sets the type at any time; by code only before the first run: the workbench sets a case's type only when the case is made", () => {
  const b = opened();
  const byCode = b.add("case.type_set", { type: "unknown-device" }, { actor: code });
  let s = fold(b.entries);
  expect(s.memory.type).toBe("unknown-device");
  expect(s.memory.type_by).toEqual({ actor: "engine", seq: byCode.seq });
  b.add("run.started", runStarted("run-1"), { actor: code });
  const late = b.add("case.type_set", { type: "phishing" }, { actor: code });
  s = fold(b.entries);
  expect(s.memory.type).toBe("unknown-device");
  expect(s.skipped).toEqual([{ seq: late.seq, type: "case.type_set", reason: "the workbench sets a case's type only when the case is made" }]);
  const byPerson = b.add("case.type_set", { type: "phishing" }, { actor: person });
  s = fold(b.entries);
  expect(s.memory.type).toBe("phishing");
  expect(s.memory.type_by).toEqual({ actor: "analyst", seq: byPerson.seq });
  expect(s.skipped).toHaveLength(1);
});

test("case.type_set by an agent is skipped: a case's type is set by a person or the workbench", () => {
  const b = opened();
  const e = b.add("case.type_set", { type: "unknown-device" }, { actor: researcher });
  const s = fold(b.entries);
  expect(s.memory.type).toBeNull();
  expect(s.memory.type_by).toBeNull();
  expect(s.skipped).toEqual([{ seq: e.seq, type: "case.type_set", reason: "a case's type is set by a person or the workbench" }]);
});

test("case.type_set with null by a person clears the type", () => {
  const b = running();
  b.add("case.type_set", { type: "unknown-device" }, { actor: person });
  expect(fold(b.entries).memory.type).toBe("unknown-device");
  b.add("case.type_set", { type: null }, { actor: person });
  const s = fold(b.entries);
  expect(s.memory.type).toBeNull();
  expect(s.memory.type_by).toBeNull();
  expect(s.skipped).toEqual([]);
});

test("case.type_proposed by code is the proposed type while no type is set, and changes nothing once one is; a type set by a person clears it", () => {
  const b = running();
  const p = b.add("case.type_proposed", { type: "unknown-device", why: "Frame read the question as this type" }, { actor: code, run: "run-1", stage: "frame" });
  let s = fold(b.entries);
  expect(s.memory.proposed_type).toEqual({ type: "unknown-device", why: "Frame read the question as this type", seq: p.seq });
  expect(s.memory.type).toBeNull();
  b.add("case.type_set", { type: "unknown-device" }, { actor: person });
  s = fold(b.entries);
  expect(s.memory.type).toBe("unknown-device");
  expect(s.memory.proposed_type).toBeNull();
  const before = s;
  const again = b.add("case.type_proposed", { type: "phishing", why: "Frame read the question as this type" }, { actor: code });
  s = fold(b.entries);
  expect(s).toEqual({ ...before, seq: again.seq, head_ts: again.ts });
  expect(s.skipped).toEqual([]);
});

test("case.type_proposed by a person is skipped: a person sets a case's type; a stage proposes one", () => {
  const b = running();
  const e = b.add("case.type_proposed", { type: "unknown-device", why: "I think so" }, { actor: person });
  const s = fold(b.entries);
  expect(s.memory.proposed_type).toBeNull();
  expect(s.skipped).toEqual([{ seq: e.seq, type: "case.type_proposed", reason: "a person sets a case's type; a stage proposes one" }]);
});

// ---------- the notebook ----------

test("memory.noted by an agent is a note with its stage, author, seq and time, and takes the next id", () => {
  const b = running();
  const n = b.add("memory.noted", note("m1"), { actor: researcher, run: "run-1", stage: "research" });
  const s = fold(b.entries);
  expect(s.memory.notes.m1).toEqual({ id: "m1", kind: "pointer", text: "the access point in the lobby is ap-3; see c5", cards: ["c5"], by: "agent", author: "researcher", stage: "research", noted_seq: n.seq, noted_ts: n.ts, revised: null, dropped: null });
  expect(s.memory.order).toEqual(["m1"]); expect(s.counters.memory).toBe(1);
  expect(s.skipped).toEqual([]);
});

test("memory.noted by code, with an id already used, with text over 600 characters or more than 10 cards is skipped with its reason", () => {
  // "a note is written by an agent or a person" · "a note's id is used once" · malformed memory.noted
  const b = running();
  const byCode = b.add("memory.noted", note("m1"), { actor: code });
  b.add("memory.noted", note("m2"), { actor: person });
  const twice = b.add("memory.noted", note("m2", { text: "another" }), { actor: researcher });
  const long = b.add("memory.noted", note("m4", { text: "x".repeat(601) }), { actor: researcher });
  const many = b.add("memory.noted", note("m5", { cards: Array.from({ length: 11 }, (_, i) => `c${i + 1}`) }), { actor: researcher });
  b.add("memory.noted", note("m6", { text: "y".repeat(600), cards: Array.from({ length: 10 }, (_, i) => `c${i + 1}`) }), { actor: researcher });
  const s = fold(b.entries);
  expect(s.skipped).toEqual([
    { seq: byCode.seq, type: "memory.noted", reason: "a note is written by an agent or a person" },
    { seq: twice.seq, type: "memory.noted", reason: "a note's id is used once" },
    { seq: long.seq, type: "memory.noted", reason: "malformed memory.noted" },
    { seq: many.seq, type: "memory.noted", reason: "malformed memory.noted" },
  ]);
  expect(s.memory.order).toEqual(["m2", "m6"]);
  expect(s.memory.notes.m2!.text).toBe("the access point in the lobby is ap-3; see c5");
  expect(s.memory.notes.m2).toMatchObject({ by: "human", author: "analyst", stage: null });
  // the counter counts every memory.noted, as every creating entry is counted, so the allocator never gives an id twice
  expect(s.counters.memory).toBe(6);
});

test("memory.revised by a person replaces the kind, text and cards and keeps who noted it; by an agent it is skipped: only a person revises or drops a note", () => {
  const b = running();
  const n = b.add("memory.noted", note("m1"), { actor: researcher, stage: "research" });
  const r = b.add("memory.revised", { item: "m1", kind: "fact", text: "ap-3 is in the lobby", cards: ["c5", "c6"] }, { actor: person });
  const byAgent = b.add("memory.revised", { item: "m1", kind: "decision", text: "changed", cards: [] }, { actor: researcher });
  const byCode = b.add("memory.dropped", { item: "m1", reason: "old" }, { actor: code });
  const s = fold(b.entries);
  expect(s.memory.notes.m1).toEqual({
    id: "m1", kind: "fact", text: "ap-3 is in the lobby", cards: ["c5", "c6"], by: "agent", author: "researcher", stage: "research", noted_seq: n.seq, noted_ts: n.ts,
    revised: { by: "analyst", seq: r.seq, ts: r.ts }, dropped: null,
  });
  expect(s.skipped).toEqual([
    { seq: byAgent.seq, type: "memory.revised", reason: "only a person revises or drops a note" },
    { seq: byCode.seq, type: "memory.dropped", reason: "only a person revises or drops a note" },
  ]);
});

test("memory.dropped by a person marks the note dropped; liveNotes leaves it out; a second drop, and a revision of a dropped note, are skipped: a note is revised or dropped while it is in the notebook", () => {
  const b = running();
  b.add("memory.noted", note("m1"), { actor: researcher });
  b.add("memory.noted", note("m2", { kind: "fact", text: "second" }), { actor: researcher });
  const d = b.add("memory.dropped", { item: "m1", reason: "no longer true" }, { actor: person });
  const twice = b.add("memory.dropped", { item: "m1", reason: "again" }, { actor: person });
  const revise = b.add("memory.revised", { item: "m1", kind: "fact", text: "back", cards: [] }, { actor: person });
  const missing = b.add("memory.dropped", { item: "m9", reason: "never was" }, { actor: person });
  const s = fold(b.entries);
  expect(s.memory.notes.m1!.dropped).toEqual({ by: "analyst", reason: "no longer true", seq: d.seq, ts: d.ts });
  expect(s.memory.notes.m1!.text).toBe("the access point in the lobby is ap-3; see c5");
  expect(liveNotes(s).map((x) => x.id)).toEqual(["m2"]);
  const reason = "a note is revised or dropped while it is in the notebook";
  expect(s.skipped).toEqual([
    { seq: twice.seq, type: "memory.dropped", reason },
    { seq: revise.seq, type: "memory.revised", reason },
    { seq: missing.seq, type: "memory.dropped", reason },
  ]);
});

test("liveNotes is newest first", () => {
  const b = running();
  for (const id of ["m1", "m2", "m3"]) b.add("memory.noted", note(id), { actor: id === "m2" ? person : researcher });
  const s = fold(b.entries);
  expect(liveNotes(s).map((x) => x.id)).toEqual(["m3", "m2", "m1"]);
  expect(liveNotes(initial())).toEqual([]);
});

// ---------- what a run was given from the shared store ----------

const lock: BlobRef = { blob: "a".repeat(64), bytes: 10 };
const O = "o".repeat(64);
const H = "b".repeat(64);
const LH = "c".repeat(64);
const memBound = (over: Partial<Payloads["memory.bound"]> = {}): Payloads["memory.bound"] => ({
  lock, store: { origin: O, head: { seq: 9, hash: H } }, case_type: "unknown-device", lessons: [{ lesson: "LESSON-2", hash: LH }], ...over,
});

test("memory.bound followed at once by run.started is what that run was given", () => {
  const b = opened();
  const b2 = b.add("memory.bound", memBound(), { actor: code });
  expect(fold(b.entries).memory.pending).toEqual({ ...memBound(), seq: b2.seq });
  expect(fold(b.entries).memory.bound).toBeNull();
  b.add("run.started", runStarted("run-1"), { actor: code });
  const s = fold(b.entries);
  expect(s.memory.bound).toEqual({ lock, store: { origin: O, head: { seq: 9, hash: H } }, case_type: "unknown-device", lessons: [{ lesson: "LESSON-2", hash: LH }], seq: b2.seq }); expect(s.memory.pending).toBeNull();
  expect(s.skipped).toEqual([]);
});

test("a run.started that does not come right after the memory.bound, or with none before it, has bound null", () => {
  // a second run started with no memory.bound after a bound one: bound is null again
  const b = opened();
  b.add("memory.bound", memBound(), { actor: code });
  b.add("case.phase_changed", { phase: "direct" }, { actor: code });
  b.add("run.started", runStarted("run-1"), { actor: code });
  let s = fold(b.entries);
  expect(s.memory.bound).toBeNull();
  expect(s.memory.pending).toBeNull();
  b.add("run.finished", { outcome: "stopped" }, { actor: code });
  b.add("memory.bound", memBound(), { actor: person });
  b.add("run.started", runStarted("run-2"), { actor: person });
  expect(fold(b.entries).memory.bound).not.toBeNull();
  b.add("run.finished", { outcome: "stopped" }, { actor: code });
  b.add("run.started", runStarted("run-3"), { actor: code });
  s = fold(b.entries);
  expect(s.memory.bound).toBeNull();
  expect(s.memory.pending).toBeNull();
  expect(s.skipped).toEqual([]);
});

test("memory.bound while a run is in progress replaces what the run was given", () => {
  const b = opened();
  b.add("memory.bound", memBound(), { actor: code });
  b.add("run.started", runStarted("run-1"), { actor: code });
  b.add("case.type_set", { type: "phishing" }, { actor: person });
  const again = b.add("memory.bound", memBound({ case_type: "phishing", lessons: [] }), { actor: person });
  const s = fold(b.entries);
  expect(s.memory.bound).toEqual({ ...memBound({ case_type: "phishing", lessons: [] }), seq: again.seq });
  expect(s.memory.pending).toBeNull();
  expect(s.skipped).toEqual([]);
});

test("memory.bound by an agent is skipped: a run's memory is bound by a person or the workbench", () => {
  const b = running();
  const e = b.add("memory.bound", memBound(), { actor: researcher });
  const s = fold(b.entries);
  expect(s.memory.bound).toBeNull();
  expect(s.memory.pending).toBeNull();
  expect(s.skipped).toEqual([{ seq: e.seq, type: "memory.bound", reason: "a run's memory is bound by a person or the workbench" }]);
});

test("a malformed case.type_set, case.type_proposed, memory.noted, memory.revised, memory.dropped or memory.bound is recorded as malformed", () => {
  // type: 1 · type: "Unknown Device" · kind: "rule" · cards: [1] · reason: 2 · lock: {} · lessons: [{ lesson: "L3" }]
  const b = running();
  b.add("memory.noted", note("m1"), { actor: researcher });
  const bad: [keyof Payloads, unknown][] = [
    ["case.type_set", { type: 1 }],
    ["case.type_set", { type: "Unknown Device" }],
    ["case.type_proposed", { type: "Unknown Device", why: "w" }],
    ["case.type_proposed", { type: "unknown-device" }],
    ["memory.noted", note("m2", { kind: "rule" as never })],
    ["memory.noted", note("m2", { cards: [1] as never })],
    ["memory.noted", note("m2", { text: "" })],
    ["memory.revised", { item: "m1", kind: "rule", text: "t", cards: [] }],
    ["memory.revised", { item: "m1", kind: "fact", text: "t", cards: [1] }],
    ["memory.dropped", { item: "m1", reason: 2 }],
    ["memory.bound", memBound({ lock: {} as never })],
    ["memory.bound", memBound({ lessons: [{ lesson: "L3" }] as never })],
    ["memory.bound", memBound({ lessons: [{ lesson: "LESSON-3" }] as never })],
    ["memory.bound", memBound({ store: { origin: 5, head: { seq: 9, hash: H } } as never })],
    ["memory.bound", memBound({ case_type: "Unknown Device" })],
  ];
  const at = bad.map(([type, payload]) => b.add(type, payload as never, { actor: person }).seq);
  const s = fold(b.entries);
  expect(s.skipped).toEqual(bad.map(([type], i) => ({ seq: at[i]!, type, reason: `malformed ${type}` })));
  expect(s.memory.type).toBeNull();
  expect(s.memory.notes.m1!.kind).toBe("pointer");
  expect(s.memory.order).toEqual(["m1"]);
  expect(s.memory.bound).toBeNull();
});

test("none of the six entries changes the run, the cards, the plan, the loop or the meta", () => {
  // a paused run with a hold, then each entry: toEqual the state before it in every field but seq, head_ts, counters.memory and memory
  const b = running();
  b.add("card.created", { card: card("c5") }, { actor: researcher });
  b.add("run.paused", { reason: "a person asked to look", hold: { kind: "question", stage: "research" } }, { actor: person });
  const six: [keyof Payloads, unknown, Actor][] = [
    ["case.type_set", { type: "unknown-device" }, person],
    ["case.type_proposed", { type: "unknown-device", why: "w" }, code],
    ["memory.noted", note("m1"), researcher],
    ["memory.revised", { item: "m1", kind: "fact", text: "revised", cards: [] }, person],
    ["memory.dropped", { item: "m1", reason: "done" }, person],
    ["memory.bound", memBound(), person],
  ];
  for (const [type, payload, actor] of six) {
    const before = fold(b.entries);
    const e = b.add(type, payload as never, { actor });
    const after = fold(b.entries);
    const { seq: _a, head_ts: _b, counters: c1, memory: _m1, ...restBefore } = before;
    const { seq: _c, head_ts: _d, counters: c2, memory: _m2, ...restAfter } = after;
    expect(restAfter, type).toEqual(restBefore);
    expect({ ...c2, memory: 0 }, type).toEqual({ ...c1, memory: 0 });
    expect(after.seq).toBe(e.seq);
  }
  const s = fold(b.entries);
  expect(s.run.status).toBe("paused");
  expect(s.skipped).toEqual([]);
});

test("the lesson entries and the two workbench-chain entries change nothing in a case fold and are not skipped", () => {
  const b = running();
  const from: Payloads["lesson.proposed"]["from"] = { kind: "person" };
  const others: [keyof Payloads, unknown][] = [
    ["lesson.proposed", { lesson: "LESSON-1", case_type: "unknown-device", title: "t", text: "x", triggers: [{ observable: "ip" }], marking: "TLP:GREEN", supersedes: null, hash: LH, from }],
    ["lesson.accepted", { lesson: "LESSON-1", hash: LH, marking: "TLP:GREEN" }],
    ["lesson.rejected", { lesson: "LESSON-1", reason: "r" }],
    ["lesson.retired", { lesson: "LESSON-1", reason: "r" }],
    ["memory.exported", { file: "memory.TLP-GREEN.bbbbbbbbbbbb.memory.tar.gz", origin: O, head: { seq: 4, hash: H }, lessons: 1 }],
    ["memory.loaded", { file: "memory.TLP-GREEN.bbbbbbbbbbbb.memory.tar.gz", origin: O, head: { seq: 4, hash: H }, before: { seq: 0, hash: "" } }],
  ];
  for (const [type, payload] of others) {
    const before = fold(b.entries);
    const e = b.add(type, payload as never, { actor: person });
    expect(fold(b.entries), type).toEqual({ ...before, seq: e.seq, head_ts: e.ts });
  }
  expect(fold(b.entries).skipped).toEqual([]);
});
