import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../src/core/blobs";
import { Ledger } from "../../src/core/ledger";
import { CaseSession } from "../../src/core/session";
import { fold } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Actor, Entry, EntryInput } from "../../src/core/types";
import { card } from "../helpers/entries";

const human: Actor = { kind: "human", id: "analyst" };
let dir: string;
let ledger: Ledger;
let s: CaseSession;
const errors: unknown[] = [];

function open(): CaseSession {
  ledger = Ledger.open(join(dir, "ledger.sqlite"), "CASE-1");
  return new CaseSession({ id: "CASE-1", dir, ledger, blobs: new BlobStore(join(dir, "blobs")), onError: (e) => void errors.push(e) });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "session-"));
  errors.length = 0;
  s = open();
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

const newCard = (id: string): EntryInput => ({ type: "card.created", payload: { card: card(id) }, actor: human });

test("commit appends what the builder returns and advances state", () => {
  const out = s.commit((_state, ids) => [{ type: "card.created", payload: { card: card(ids.next("card")) }, actor: human }]);
  expect(out).toHaveLength(1);
  expect(s.state.incoming).toEqual(["c1"]);
  expect(s.state.seq).toBe(s.head().seq);
});

test("the allocator counts up within one commit and across commits", () => {
  s.commit((_st, ids) => [newCard(ids.next("card")), newCard(ids.next("card"))]);
  expect(s.state.incoming).toEqual(["c1", "c2"]);
  let seen: string[] = [];
  s.commit((_st, ids) => {
    seen = [ids.next("card"), ids.next("card")];
    return [];
  });
  expect(seen).toEqual(["c3", "c4"]);
  s.commit((_st, ids) => [newCard(ids.next("card"))]);
  expect(s.state.incoming).toEqual(["c1", "c2", "c3"]);
});

test("the builder sees the state as of the previous commit", () => {
  s.commit(() => [newCard("c1")]);
  let seenIncoming: string[] = [];
  s.commit((state) => {
    seenIncoming = state.incoming;
    return [newCard("c2")];
  });
  expect(seenIncoming).toEqual(["c1"]);
  expect(s.state.incoming).toEqual(["c1", "c2"]);
});

test("a builder that throws writes nothing and leaves state unchanged", () => {
  const before = s.state, head = s.head();
  expect(() => s.commit(() => { throw new Error("boom"); })).toThrow("boom");
  expect(s.head()).toEqual(head);
  expect(s.state).toBe(before);
});

test("an invalid entry in a commit writes none of them", () => {
  const before = s.state, head = s.head();
  const bad = { type: "setting.changed", payload: { key: "k", value: NaN }, actor: human } as EntryInput;
  expect(() => s.commit(() => [newCard("c1"), bad])).toThrow();
  expect(s.head()).toEqual(head);
  expect(s.state).toBe(before);
});

test("a builder returning no entries is a no-op", () => {
  const before = s.state, head = s.head();
  expect(s.commit(() => [])).toEqual([]);
  expect(s.head()).toEqual(head);
  expect(s.state).toBe(before);
});

test("subscribers get each entry with the state after it", () => {
  const got: { seq: number; incoming: number; stateSeq: number }[] = [];
  const stop = s.subscribe((e, st) => got.push({ seq: e.seq, incoming: st.incoming.length, stateSeq: st.seq }));
  s.commit(() => [newCard("c1"), newCard("c2")]);
  expect(got).toEqual([{ seq: 1, incoming: 1, stateSeq: 1 }, { seq: 2, incoming: 2, stateSeq: 2 }]);
  stop();
  s.commit(() => [newCard("c3")]);
  expect(got).toHaveLength(2);
});

test("a throwing subscriber does not undo the commit or starve others", () => {
  let reached = 0;
  s.subscribe(() => { throw new Error("bad listener"); });
  s.subscribe(() => { reached += 1; });
  const out = s.commit(() => [newCard("c1"), newCard("c2")]);
  expect(out).toHaveLength(2);
  expect(s.state.incoming).toEqual(["c1", "c2"]);
  expect(reached).toBe(2);
  expect(errors).toHaveLength(2);
});

test("state at entry N is the same live and replayed", () => {
  const recorded: CaseState[] = [];
  s.subscribe((_e: Entry, st) => { recorded[st.seq] = structuredClone(st); });
  s.commit(() => [
    { type: "lane.created", payload: { lane: "l1", title: "One", subgoal: null }, actor: human },
    { type: "lane.created", payload: { lane: "l2", title: "Two", subgoal: null }, actor: human },
  ]);
  for (let i = 1; i <= 8; i++) s.commit((_st, ids) => [newCard(ids.next("card"))]);
  for (let i = 1; i <= 8; i++) {
    s.commit(() => [{ type: "card.kept", payload: { card: `c${i}`, lane: i % 2 ? "l1" : "l2", index: null }, actor: human }]);
  }
  s.commit(() => [{ type: "card.discarded", payload: { card: "c1" }, actor: human }]);
  const target = s.state.undoable[s.state.undoable.length - 1]!;
  s.commit(() => [{ type: "undo", payload: { target: target.seq, card: target.card, place: target.place, lane: target.lane, index: target.index }, actor: human }]);
  for (let i = 9; i <= 18; i++) s.commit((_st, ids) => [newCard(ids.next("card"))]);
  expect(s.head().seq).toBe(30);
  const all = s.entries();
  for (let n = 1; n <= 30; n++) {
    expect(fold(all, n)).toEqual(recorded[n]!);
    expect(s.stateAt(n)).toEqual(recorded[n]!);
  }
  expect(s.stateAt(0).seq).toBe(0);
  expect(s.entries(28).map((e) => e.seq)).toEqual([29, 30]);
});

test("a session opened on an existing case rebuilds the same state", () => {
  s.commit(() => [
    { type: "lane.created", payload: { lane: "l1", title: "One", subgoal: null }, actor: human },
    newCard("c1"),
  ]);
  s.commit(() => [{ type: "card.kept", payload: { card: "c1", lane: "l1", index: null }, actor: human }]);
  const expected = s.state, head = s.head();
  ledger.close();
  const again = open();
  expect(again.state).toEqual(expected);
  expect(again.head()).toEqual(head);
});
