import { expect, test } from "bun:test";
import { fold, initial } from "../../src/core/state";
import { timelineOf } from "../../src/core/state/timeline";
import type { Card, Observed, Observable, Payloads, Sighting } from "../../src/core/types";
import { EntryBuilder, card } from "../helpers/entries";

const T = (day: number, hh = 0): string => `2026-11-${String(day).padStart(2, "0")}T${String(hh).padStart(2, "0")}:00:00.000Z`;
const sight = (type: string, value: string, first: string | null, last: string | null, count: number | null = null): Sighting => ({ type, value, first, last, count, points: [] });
const obs = (pivot: string, from: Observable, span: Observed["span"], found: Sighting[], unread = 0): Observed => ({ pivot, from, span, found, more: 0, unread });
const caseWith = (window: Payloads["case.created"]["window"]): Payloads["case.created"] => ({
  id: "case-1", title: "t", asked: "a", why: "w", starting: [], window, objective: null, marking: "TLP:AMBER",
});
const ADDR: Observable = { type: "address", value: "198.51.100.77" };
const DOM: Observable = { type: "domain", value: "a.example.com" };
function build(cards: [string, Partial<Card>][], window: Payloads["case.created"]["window"] = { from: null, to: null }) {
  const b = new EntryBuilder();
  b.add("case.created", caseWith(window));
  for (const [id, over] of cards) b.add("card.created", { card: card(id, over) });
  return { b, s: fold(b.entries) };
}
const C1 = obs("address_to_domains", ADDR, { first: T(17, 1), last: T(19, 5), count: 7 }, [sight("domain", "a.example.com", T(17, 1), T(19, 5), 7)]);
const C2 = obs("domain_to_clients", DOM, { first: T(18), last: T(20), count: 5 }, [sight("address", "192.0.2.17", T(18), T(20), 5)]);

test("one row per value with a time; a mark per card and role; the row spans its marks and adds nothing up", () => {
  const { s } = build([["c1", { observed: C1 }], ["c2", { observed: C2 }]]);
  const m = timelineOf(s);
  const row = m.rows.find((r) => r.key === "domain|a.example.com")!;
  expect(row).toMatchObject({ first: T(17, 1), last: T(20) });
  expect(row.marks.map((k) => [k.card, k.role, k.count])).toEqual([["c1", "found", 7], ["c2", "subject", 5]]);
  expect("count" in row).toBe(false);
  expect(m.rows.length).toBe(3);
});

test("a card with no rows makes no subject mark", () => {
  const empty = obs("domain_to_clients", DOM, { first: null, last: null, count: null }, []);
  const { s } = build([["c1", { observed: empty }]]);
  expect(timelineOf(s).rows).toEqual([]);
});

test("rows are in order of first seen, then type, then value", () => {
  const o = obs("p", ADDR, { first: T(18), last: T(18), count: 1 }, [sight("domain", "b.example.com", T(17), T(17)), sight("domain", "a.example.com", T(18), T(18))]);
  const { s } = build([["c1", { observed: o }]]);
  expect(timelineOf(s).rows.map((r) => r.key)).toEqual(["domain|b.example.com", "address|198.51.100.77", "domain|a.example.com"]);
});

test("the axis is the case window widened to what was observed; an open end is ignored", () => {
  const { s } = build([["c1", { observed: C1 }], ["c2", { observed: C2 }]], { from: T(18), to: null });
  const m = timelineOf(s);
  expect([m.from, m.to]).toEqual([T(17, 1), T(20)]);
  expect(m.window).toEqual({ from: T(18), to: null });
  const wide = timelineOf(build([["c1", { observed: C1 }]], { from: T(10), to: T(25) }).s);
  expect([wide.from, wide.to]).toEqual([T(10), T(25)]);
});

test("values with no time are counted, not listed; unread rows and legacy cards are reported", () => {
  const o1 = obs("p", ADDR, { first: T(17), last: T(17), count: 1 }, [sight("domain", "x.example.com", null, null), sight("domain", "y.example.com", null, null)], 2);
  const o2 = obs("p", DOM, { first: null, last: null, count: null }, [], 1);
  const b = new EntryBuilder();
  b.add("case.created", caseWith({ from: null, to: null }));
  b.add("query.issued", {
    query: "q1", source: "dns-logs", source_hash: "h", pivot: "address_to_domains", pivot_hash: "ph", connector: "files", text: "select", bound: { value: "192.0.2.9" } as never,
    window: { from: null, to: null }, why: "w", estimate: null, step: null, verifies: null, purpose: "result",
  });
  b.add("query.result", { query: "q1", result: { blob: "0".repeat(64), bytes: 1 }, rows: 1, rows_hash: "r", coverage: { kind: "full" }, duration_ms: 1, cost: null });
  b.add("card.created", { card: card("c1", { observed: o1 }) });
  b.add("card.created", { card: card("c2", { observed: o2 }) });
  b.add("card.created", { card: card("c3", { query: "q1", columns: ["n"], column_types: ["domain"], rows: [["z.example.com"]], row_count: 1 }) });
  const m = timelineOf(fold(b.entries));
  expect(m.rows.map((r) => r.key)).toEqual(["address|198.51.100.77"]);
  // x, y, the legacy subject 192.0.2.9 (unknown type) and z are untimed; the empty card's subject too
  expect(m).toMatchObject({ untimed: 5, unread: 3, legacy: true });
});

test("a discarded card's marks are gone", () => {
  const { b } = build([["c1", { observed: C1 }], ["c2", { observed: C2 }]]);
  b.add("card.discarded", { card: "c2" });
  const m = timelineOf(fold(b.entries));
  expect(m.rows.map((r) => r.key)).toEqual(["address|198.51.100.77", "domain|a.example.com"]);
  expect(m.rows[1]!.marks.map((k) => k.card)).toEqual(["c1"]);
});

test("a case with no card, and a state with no case, give an empty model", () => {
  const empty = { rows: [], from: null, to: null, window: { from: null, to: null }, untimed: 0, unread: 0, legacy: false };
  expect(timelineOf(initial())).toEqual(empty);
  expect(timelineOf(build([]).s)).toEqual(empty);
});

test("everything at one instant gives an axis of that instant", () => {
  const o = obs("p", ADDR, { first: T(17), last: T(17), count: 1 }, []);
  const m = timelineOf(build([["c1", { observed: o }]]).s);
  expect([m.from, m.to]).toEqual([T(17), T(17)]);
});
