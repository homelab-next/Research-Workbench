import { afterEach, beforeEach, expect, test } from "bun:test";
import { liveNotes } from "../../src/core/state";
import { fold } from "../../src/core/state";
import { dropMemory, noteMemory, NoteRefused, reviseMemory } from "../../src/pipeline/notes";
import { agent, fixture, person } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
beforeEach(async () => {
  f = fixture(true);
  // a step's card, c1, for the notes that name one
  await f.call("run_step", { step: "s1", why: "w" });
});
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});
const link = { run: "run-1", stage: "research", job: null };

/** The refusal's message, with nothing written. */
function refusal(fn: () => unknown): string {
  const before = f.s.entries().length;
  let message = "";
  try { fn(); } catch (err) { expect(err).toBeInstanceOf(NoteRefused); message = (err as Error).message; }
  expect(message).not.toBe("");
  expect(f.s.entries().length).toBe(before);
  return message;
}

test("a person's note and an agent's note are entries of the case, with ids m1 and m2, and the state is the fold", () => {
  expect(noteMemory(f.s, { kind: "fact", text: "AP-3 is in the lobby", actor: person })).toBe("m1");
  expect(noteMemory(f.s, { kind: "pointer", text: "see the flow card", cards: ["c1"], actor: agent, link })).toBe("m2");
  expect(f.s.state.memory.order).toEqual(["m1", "m2"]);
  expect(f.s.state.memory.notes.m1).toMatchObject({ by: "human", author: "analyst", kind: "fact", text: "AP-3 is in the lobby" });
  expect(f.s.state.memory.notes.m2).toMatchObject({ by: "agent", cards: ["c1"] });
  expect(f.s.state.counters.memory).toBe(2);
  expect(f.s.state).toEqual(fold(f.s.entries()));
  expect(liveNotes(f.s.state).map((n) => n.id)).toEqual(["m2", "m1"]);
  expect(f.s.state.skipped).toEqual([]);
});

test("an agent's note carries its run and stage", () => {
  noteMemory(f.s, { kind: "decision", text: "use the flow source", actor: agent, link });
  const e = f.s.entries().at(-1)!;
  expect(e).toMatchObject({ type: "memory.noted", run: "run-1", stage: "research", actor: { kind: "agent", id: "researcher-g1" } });
});

test("a note with no text, too long, naming a card the case does not hold, or the same as a live one is refused and nothing is written", () => {
  expect(refusal(() => noteMemory(f.s, { kind: "fact", text: "  ", actor: person }))).toBe("a note needs text");
  expect(refusal(() => noteMemory(f.s, { kind: "fact", text: "x".repeat(601), actor: person }))).toBe("a note is at most 600 characters");
  expect(refusal(() => noteMemory(f.s, { kind: "fact", text: "x", cards: Array.from({ length: 11 }, () => "c1"), actor: person }))).toBe("a note names at most 10 cards");
  expect(refusal(() => noteMemory(f.s, { kind: "fact", text: "x", cards: ["c99"], actor: person }))).toBe("unknown card: c99");
  expect(refusal(() => noteMemory(f.s, { kind: "fact", text: "x", actor: { kind: "system", id: "engine" } }))).toBe("a note is written by an agent or a person");
  noteMemory(f.s, { kind: "fact", text: "same words", actor: person });
  expect(refusal(() => noteMemory(f.s, { kind: "decision", text: "  same words ", actor: agent, link }))).toBe("that note is already in the notebook (m1)");
});

test("the notebook holds at most max_notes live notes", () => {
  noteMemory(f.s, { kind: "fact", text: "a", actor: person, max_notes: 1 });
  expect(refusal(() => noteMemory(f.s, { kind: "fact", text: "b", actor: person, max_notes: 1 }))).toBe("the notebook holds 1 notes, the most it may; a person may drop one");
});

test("revise by a person changes the note and keeps its author; by an agent it is refused", () => {
  noteMemory(f.s, { kind: "fact", text: "old", actor: agent, link });
  reviseMemory(f.s, { item: "m1", kind: "decision", text: "new", cards: [], actor: person });
  expect(f.s.state.memory.notes.m1).toMatchObject({ kind: "decision", text: "new", author: "researcher-g1", by: "agent" });
  expect(f.s.state.memory.notes.m1!.revised).not.toBeNull();
  expect(refusal(() => reviseMemory(f.s, { item: "m1", kind: "fact", text: "x", actor: agent }))).toBe("only a person revises a note");
  expect(refusal(() => reviseMemory(f.s, { item: "m9", kind: "fact", text: "x", actor: person }))).toBe("there is no note m9");
  expect(refusal(() => reviseMemory(f.s, { item: "m1", kind: "fact", text: "", actor: person }))).toBe("a note needs text");
});

test("drop by a person takes the note out of liveNotes; a dropped note is not revised or dropped again", () => {
  noteMemory(f.s, { kind: "fact", text: "one", actor: person });
  expect(refusal(() => dropMemory(f.s, { item: "m1", reason: "x", actor: agent }))).toBe("only a person drops a note");
  expect(refusal(() => dropMemory(f.s, { item: "m1", reason: " ", actor: person }))).toBe("dropping a note needs a reason");
  dropMemory(f.s, { item: "m1", reason: "wrong" , actor: person });
  expect(liveNotes(f.s.state)).toEqual([]);
  expect(f.s.state.memory.notes.m1!.dropped).toMatchObject({ by: "analyst", reason: "wrong" });
  expect(refusal(() => reviseMemory(f.s, { item: "m1", kind: "fact", text: "y", actor: person }))).toBe("note m1 was dropped");
  expect(refusal(() => dropMemory(f.s, { item: "m1", reason: "again", actor: person }))).toBe("note m1 was dropped");
  expect(refusal(() => dropMemory(f.s, { item: "m7", reason: "again", actor: person }))).toBe("there is no note m7");
});

test("after a drop the same text may be noted again", () => {
  noteMemory(f.s, { kind: "fact", text: "one", actor: person });
  dropMemory(f.s, { item: "m1", reason: "wrong", actor: person });
  expect(noteMemory(f.s, { kind: "fact", text: "one", actor: person })).toBe("m2");
  expect(liveNotes(f.s.state).map((n) => n.id)).toEqual(["m2"]);
});
