import { expect, test } from "bun:test";
import { apply, cardLocation, fold, initial } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Payloads } from "../../src/core/types";
import { EntryBuilder, card } from "../helpers/entries";

const CASE: Payloads["case.created"] = {
  id: "case-1", title: "Beaconing", asked: "Is 192.0.2.10 beaconing?", why: "alert", starting: [{ type: "ip", value: "192.0.2.10" }],
  window: { from: null, to: null }, objective: null, marking: "TLP:AMBER",
};

/** Builder with two cards in Incoming and two lanes (l1 target, l2). */
function setup(): EntryBuilder {
  const b = new EntryBuilder();
  b.add("lane.created", { lane: "l1", title: "One", subgoal: null });
  b.add("lane.created", { lane: "l2", title: "Two", subgoal: "sg" });
  b.add("card.created", { card: card("c1") });
  b.add("card.created", { card: card("c2") });
  return b;
}

test("initial state is empty and at seq 0", () => {
  const s = initial();
  expect(s).toMatchObject({ seq: 0, head_ts: null, meta: null, incoming: [], lanes: [], target: null, discarded: [], undoable: [] });
  expect(s.counters.card).toBe(0);
  expect(s.run.status).toBe("none");
  expect(s.plan.status).toBe("none");
  expect(Object.values(s.counters).every((n) => n === 0)).toBe(true);
});

test("initial() returns a fresh object each time", () => {
  expect(initial()).not.toBe(initial());
  expect(initial().incoming).not.toBe(initial().incoming);
});

test("case.created sets meta", () => {
  const b = new EntryBuilder();
  b.add("case.created", CASE);
  expect(fold(b.entries).meta).toEqual(CASE);
});

test("case.phase_changed sets phase", () => {
  const b = new EntryBuilder();
  b.add("case.phase_changed", { phase: "collect" });
  expect(fold(b.entries).phase).toBe("collect");
});

test("every entry advances seq and head_ts, known or not", () => {
  const b = new EntryBuilder();
  const e = b.add("setting.changed", { key: "k", value: 1 });
  expect(apply(initial(), e)).toMatchObject({ seq: 1, head_ts: e.ts });
});

test("a new card arrives in Incoming and bumps the card counter", () => {
  const s = fold(new EntryBuilder().also((b) => b.add("card.created", { card: card("c1") })).entries);
  expect(s.incoming).toEqual(["c1"]);
  expect(s.cards.c1).toMatchObject({ place: "incoming", lane: null, pinned: false, created_seq: 1, validated: null });
  expect(s.counters.card).toBe(1);
});

test("counters bump per entry kind", () => {
  const b = new EntryBuilder();
  b.add("lane.created", { lane: "l1", title: "t", subgoal: null });
  b.add("job.started", { job: "j1", title: "t", kind: "query", source: null });
  b.add("agent.asked", { turn: "u1", text: "?", left_out: [], added: [] });
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages: [] });
  b.add("tool.called", { request: "r1", call: "t1", tool: "x", args: null, why: "" });
  const s = fold(b.entries);
  expect(s.counters).toMatchObject({ lane: 1, job: 1, turn: 1, run: 1, call: 1, card: 0 });
});

test("the first lane created becomes the keep target", () => {
  const s = fold(setup().entries);
  expect(s.target).toBe("l1");
  expect(s.lanes.map((l) => l.id)).toEqual(["l1", "l2"]);
  expect(s.lanes[1]).toEqual({ id: "l2", title: "Two", subgoal: "sg", cards: [] });
});

test("keep moves a card from Incoming to the end of a lane", () => {
  const b = setup();
  b.add("card.kept", { card: "c1", lane: "l1", index: null });
  b.add("card.kept", { card: "c2", lane: "l1", index: null });
  const s = fold(b.entries);
  expect(s.incoming).toEqual([]);
  expect(s.lanes[0]!.cards).toEqual(["c1", "c2"]);
  expect(s.cards.c1).toMatchObject({ place: "lane", lane: "l1" });
});

test("keep with an index inserts at that position", () => {
  const b = setup();
  b.add("card.created", { card: card("c3") });
  b.add("card.kept", { card: "c1", lane: "l1", index: null });
  b.add("card.kept", { card: "c2", lane: "l1", index: null });
  b.add("card.kept", { card: "c3", lane: "l1", index: 1 });
  expect(fold(b.entries).lanes[0]!.cards).toEqual(["c1", "c3", "c2"]);
});

test("move reorders within a lane and moves across lanes", () => {
  const b = setup();
  b.add("card.kept", { card: "c1", lane: "l1", index: null });
  b.add("card.kept", { card: "c2", lane: "l1", index: null });
  b.add("card.moved", { card: "c2", lane: "l1", index: 0 });
  expect(fold(b.entries).lanes[0]!.cards).toEqual(["c2", "c1"]);
  b.add("card.moved", { card: "c2", lane: "l2", index: 0 });
  const s = fold(b.entries);
  expect(s.lanes[0]!.cards).toEqual(["c1"]);
  expect(s.lanes[1]!.cards).toEqual(["c2"]);
  expect(s.cards.c2).toMatchObject({ place: "lane", lane: "l2" });
});

test("discard moves a card to Discarded from Incoming or from a lane", () => {
  const b = setup();
  b.add("card.kept", { card: "c1", lane: "l1", index: null });
  b.add("card.discarded", { card: "c1" });
  b.add("card.discarded", { card: "c2" });
  const s = fold(b.entries);
  expect(s.discarded).toEqual(["c1", "c2"]);
  expect(s.incoming).toEqual([]);
  expect(s.lanes[0]!.cards).toEqual([]);
  expect(s.cards.c1).toMatchObject({ place: "discarded", lane: null });
});

test("restore returns a discarded card to Incoming", () => {
  const b = setup();
  b.add("card.discarded", { card: "c1" });
  b.add("card.restored", { card: "c1" });
  const s = fold(b.entries);
  expect(s.discarded).toEqual([]);
  expect(s.incoming).toEqual(["c2", "c1"]);
  expect(s.cards.c1!.place).toBe("incoming");
});

test("send back returns a kept card to Incoming", () => {
  const b = setup();
  b.add("card.kept", { card: "c1", lane: "l1", index: null });
  b.add("card.sent_back", { card: "c1" });
  const s = fold(b.entries);
  expect(s.lanes[0]!.cards).toEqual([]);
  expect(s.incoming).toEqual(["c2", "c1"]);
  expect(s.cards.c1).toMatchObject({ place: "incoming", lane: null });
});

test("pin and unpin", () => {
  const b = setup();
  b.add("card.pinned", { card: "c1", pinned: true });
  expect(fold(b.entries).cards.c1!.pinned).toBe(true);
  b.add("card.pinned", { card: "c1", pinned: false });
  expect(fold(b.entries).cards.c1!.pinned).toBe(false);
});

test("rename, remove and retarget lanes", () => {
  const b = setup();
  b.add("lane.renamed", { lane: "l2", title: "Renamed" });
  expect(fold(b.entries).lanes[1]!.title).toBe("Renamed");
  b.add("lane.target_set", { lane: "l2" });
  expect(fold(b.entries).target).toBe("l2");
  b.add("card.kept", { card: "c1", lane: "l2", index: null });
  b.add("lane.removed", { lane: "l2" });
  let s = fold(b.entries);
  expect(s.lanes.map((l) => l.id)).toEqual(["l1"]);
  expect(s.target).toBe("l1");
  expect(s.incoming).toEqual(["c2", "c1"]);
  expect(s.cards.c1).toMatchObject({ place: "incoming", lane: null });
  b.add("lane.removed", { lane: "l1" });
  s = fold(b.entries);
  expect(s.lanes).toEqual([]);
  expect(s.target).toBeNull();
});

test("keep, move, discard and send back are undoable, newest last", () => {
  const b = new EntryBuilder();
  b.add("lane.created", { lane: "l1", title: "One", subgoal: null });
  b.add("card.created", { card: card("c1") });
  b.add("card.kept", { card: "c1", lane: "l1", index: null });
  b.add("card.discarded", { card: "c1" });
  expect(fold(b.entries).undoable).toEqual([
    { seq: 3, card: "c1", place: "incoming", lane: null, index: 0 },
    { seq: 4, card: "c1", place: "lane", lane: "l1", index: 0 },
  ]);
  b.add("card.restored", { card: "c1" });
  b.add("card.pinned", { card: "c1", pinned: true });
  expect(fold(b.entries).undoable).toHaveLength(2);
  b.add("card.kept", { card: "c1", lane: "l1", index: null });
  b.add("card.moved", { card: "c1", lane: "l1", index: 0 });
  b.add("card.sent_back", { card: "c1" });
  const u = fold(b.entries).undoable;
  expect(u.map((i) => i.seq)).toEqual([3, 4, 7, 8, 9]);
  expect(u[4]).toEqual({ seq: 9, card: "c1", place: "lane", lane: "l1", index: 0 });
});

test("undo puts the card back where the payload says and drops the item", () => {
  const b = new EntryBuilder();
  b.add("lane.created", { lane: "l1", title: "One", subgoal: null });
  b.add("card.created", { card: card("c1") });
  b.add("card.kept", { card: "c1", lane: "l1", index: null });
  b.add("card.discarded", { card: "c1" });
  b.add("undo", { target: 4, card: "c1", place: "lane", lane: "l1", index: 0 });
  const s = fold(b.entries);
  expect(s.lanes[0]!.cards).toEqual(["c1"]);
  expect(s.discarded).toEqual([]);
  expect(s.cards.c1).toMatchObject({ place: "lane", lane: "l1" });
  expect(s.undoable.map((i) => i.seq)).toEqual([3]);
});

test("undo back to Incoming and to Discarded", () => {
  const b = setup();
  b.add("card.kept", { card: "c1", lane: "l1", index: null });
  b.add("undo", { target: 5, card: "c1", place: "incoming", lane: null, index: 0 });
  let s = fold(b.entries);
  expect(s.incoming).toEqual(["c1", "c2"]);
  expect(s.undoable).toEqual([]);
  b.add("undo", { target: 99, card: "c2", place: "discarded", lane: null, index: null });
  s = fold(b.entries);
  expect(s.discarded).toEqual(["c2"]);
  expect(s.cards.c2).toMatchObject({ place: "discarded", lane: null });
});

test("undo into a lane that no longer exists puts the card in Incoming", () => {
  const b = setup();
  b.add("card.kept", { card: "c1", lane: "l2", index: null });
  b.add("card.discarded", { card: "c1" });
  b.add("lane.removed", { lane: "l2" });
  b.add("undo", { target: 6, card: "c1", place: "lane", lane: "l2", index: 0 });
  const s = fold(b.entries);
  expect(s.cards.c1).toMatchObject({ place: "incoming", lane: null });
  expect(s.incoming).toContain("c1");
  expect(s.discarded).toEqual([]);
});

test("the undo stack holds at most 50 items", () => {
  const b = setup();
  for (let i = 0; i < 60; i++) b.add("card.kept", { card: "c1", lane: i % 2 ? "l1" : "l2", index: null });
  const u = fold(b.entries).undoable;
  expect(u).toHaveLength(50);
  expect(u[49]!.seq).toBe(b.entries.length);
  expect(u[0]!.seq).toBe(b.entries.length - 49);
});

test("cardLocation finds a card in each place and returns null when unknown", () => {
  const b = setup();
  b.add("card.created", { card: card("c3") });
  b.add("card.kept", { card: "c1", lane: "l2", index: null });
  b.add("card.discarded", { card: "c3" });
  const s = fold(b.entries);
  expect(cardLocation(s, "c1")).toEqual({ place: "lane", lane: "l2", index: 0 });
  expect(cardLocation(s, "c2")).toEqual({ place: "incoming", lane: null, index: 0 });
  expect(cardLocation(s, "c3")).toEqual({ place: "discarded", lane: null, index: 0 });
  expect(cardLocation(s, "nope")).toBeNull();
});

test("entries naming a missing card or lane change only seq", () => {
  const b = new EntryBuilder();
  b.add("card.kept", { card: "nope", lane: "l9", index: null });
  b.add("card.moved", { card: "nope", lane: "l9", index: 0 });
  b.add("lane.renamed", { lane: "l9", title: "x" });
  b.add("undo", { target: 99, card: "nope", place: "incoming", lane: null, index: null });
  const s = fold(b.entries);
  expect({ ...s, seq: 0, head_ts: null } as CaseState).toEqual(initial());
});

test("keep into a missing lane, and no-op transitions, change only seq", () => {
  const b = setup();
  const before = fold(b.entries);
  b.add("card.kept", { card: "c1", lane: "l9", index: null });
  b.add("card.restored", { card: "c1" });
  b.add("card.sent_back", { card: "c1" });
  b.add("lane.target_set", { lane: "l9" });
  b.add("lane.removed", { lane: "l9" });
  b.add("card.pinned", { card: "nope", pinned: true });
  const s = fold(b.entries);
  expect({ ...s, seq: before.seq, head_ts: before.head_ts } as CaseState).toEqual(before);
});

test("an unknown entry type does not throw", () => {
  const e = { ...new EntryBuilder().add("run.resumed", {}), type: "future.thing" } as never;
  expect(() => apply(initial(), e)).not.toThrow();
  expect(apply(initial(), e).seq).toBe(1);
});

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

test("apply never mutates the state it is given", () => {
  const b = new EntryBuilder();
  b.add("case.created", CASE);
  b.add("case.phase_changed", { phase: "collect" });
  b.add("lane.created", { lane: "l1", title: "One", subgoal: null });
  b.add("lane.created", { lane: "l2", title: "Two", subgoal: null });
  b.add("card.created", { card: card("c1") });
  b.add("card.created", { card: card("c2") });
  b.add("card.kept", { card: "c1", lane: "l1", index: null });
  b.add("card.moved", { card: "c1", lane: "l2", index: 0 });
  b.add("card.pinned", { card: "c1", pinned: true });
  b.add("card.discarded", { card: "c2" });
  b.add("card.restored", { card: "c2" });
  b.add("card.sent_back", { card: "c1" });
  b.add("card.kept", { card: "c2", lane: "l1", index: 0 });
  b.add("lane.renamed", { lane: "l1", title: "Renamed" });
  b.add("lane.target_set", { lane: "l2" });
  b.add("undo", { target: 13, card: "c2", place: "incoming", lane: null, index: null });
  b.add("lane.removed", { lane: "l2" });
  let s: CaseState = initial();
  for (const e of b.entries) s = apply(deepFreeze(s), deepFreeze(e));
  expect(s.seq).toBe(b.entries.length);
});

test("fold with upTo stops at that seq", () => {
  const b = setup();
  b.add("card.kept", { card: "c1", lane: "l1", index: null });
  expect(fold(b.entries, 4).incoming).toEqual(["c1", "c2"]);
  expect(fold(b.entries, 4).seq).toBe(4);
  expect(fold(b.entries).incoming).toEqual(["c2"]);
  expect(fold(b.entries, 0)).toEqual(initial());
});

test("folding 5000 entries over 500 cards takes under one second", () => {
  const b = new EntryBuilder();
  b.add("lane.created", { lane: "l1", title: "One", subgoal: null });
  b.add("lane.created", { lane: "l2", title: "Two", subgoal: null });
  for (let i = 0; i < 500; i++) b.add("card.created", { card: card(`c${i}`) });
  for (let i = 0; b.entries.length < 5000; i++) {
    const id = `c${i % 500}`;
    if (i % 3 === 0) b.add("card.kept", { card: id, lane: "l1", index: null });
    else if (i % 3 === 1) b.add("card.moved", { card: id, lane: "l2", index: 0 });
    else b.add("card.pinned", { card: id, pinned: i % 2 === 0 });
  }
  const t0 = performance.now();
  const s = fold(b.entries);
  const ms = performance.now() - t0;
  expect(s.seq).toBe(5000);
  expect(ms).toBeLessThan(1000);
});
