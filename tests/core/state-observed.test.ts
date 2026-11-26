import { expect, test } from "bun:test";
import { fold } from "../../src/core/state";
import { allObserved, cardObserved, valueKey } from "../../src/core/state/observed";
import type { Card, Observed, Observable, Payloads } from "../../src/core/types";
import { EntryBuilder, card } from "../helpers/entries";

const OBSERVED: Observed = {
  pivot: "address_to_domains", from: { type: "address", value: "198.51.100.77" },
  span: { first: "2026-11-17T01:00:00.000Z", last: "2026-11-19T05:00:00.000Z", count: 8 },
  found: [{ type: "domain", value: "a.example.com", first: "2026-11-17T01:00:00.000Z", last: "2026-11-19T05:00:00.000Z", count: 8, points: [] }],
  more: 0, unread: 0,
};
const caseWith = (starting: Observable[]): Payloads["case.created"] => ({
  id: "case-1", title: "t", asked: "a", why: "w", starting, window: { from: null, to: null }, objective: null, marking: "TLP:AMBER",
});
const ADDR: Observable = { type: "address", value: "198.51.100.77" };

/** query.issued (and its result) for a pivot on a value. */
function issue(b: EntryBuilder, query: string, pivot: string | null, value: unknown): void {
  b.add("query.issued", {
    query, source: "dns-logs", source_hash: "h", pivot, pivot_hash: pivot === null ? null : "ph", connector: "files", text: "select", bound: { value } as Payloads["query.issued"]["bound"],
    window: { from: null, to: null }, why: "w", estimate: null, step: null, verifies: null, purpose: "result",
  });
  b.add("query.result", { query, result: { blob: "0".repeat(64), bytes: 1 }, rows: 3, rows_hash: "r", coverage: { kind: "full" }, duration_ms: 1, cost: null });
}
const legacy = (id: string, query: string, over: Partial<Card> = {}): Card => card(id, {
  query, columns: ["name", "n"], column_types: ["domain", null], rows: [["a.example.com", 3], ["a.example.com", 1], ["b.example.com", 2]], row_count: 3, ...over,
});

test("valueKey is type, bar, value", () => {
  expect(valueKey("domain", "a.example.com")).toBe("domain|a.example.com");
});

test("the fold keeps a query's pivot and the value it ran on", () => {
  const b = new EntryBuilder();
  issue(b, "q1", "address_to_domains", "198.51.100.77");
  issue(b, "q2", null, 7);
  const s = fold(b.entries);
  expect(s.queries.q1).toMatchObject({ pivot: "address_to_domains", value: "198.51.100.77" });
  expect(s.queries.q2).toMatchObject({ pivot: null, value: null });
  expect(s.skipped).toEqual([]);
});

test("cardObserved is the card's own observed, with its card id", () => {
  const b = new EntryBuilder();
  b.add("card.created", { card: card("c1", { observed: OBSERVED }) });
  const s = fold(b.entries);
  expect(cardObserved(s, s.cards.c1!)).toEqual({ ...OBSERVED, card: "c1", legacy: false });
});

test("a discarded card observes nothing; restored, it does again", () => {
  const b = new EntryBuilder();
  b.add("card.created", { card: card("c1", { observed: OBSERVED }) });
  b.add("card.discarded", { card: "c1" });
  const gone = fold(b.entries);
  expect(cardObserved(gone, gone.cards.c1!)).toBeNull();
  expect(allObserved(gone)).toEqual([]);
  b.add("card.restored", { card: "c1" });
  const back = fold(b.entries);
  expect(cardObserved(back, back.cards.c1!)).not.toBeNull();
});

test("a card recorded before observed is read from its query and its typed preview cells, marked legacy", () => {
  const b = new EntryBuilder();
  b.add("case.created", caseWith([ADDR]));
  issue(b, "q1", "address_to_domains", "198.51.100.77");
  b.add("card.created", { card: legacy("c1", "q1") });
  const s = fold(b.entries);
  expect(cardObserved(s, s.cards.c1!)).toEqual({
    card: "c1", legacy: true, pivot: "address_to_domains", from: { type: "address", value: "198.51.100.77" }, span: { first: null, last: null, count: null },
    found: [{ type: "domain", value: "a.example.com", first: null, last: null, count: null, points: [] }, { type: "domain", value: "b.example.com", first: null, last: null, count: null, points: [] }],
    more: 0, unread: 0,
  });
});

test("the legacy reading types its value from a typed cell of an earlier card, else unknown", () => {
  const b = new EntryBuilder();
  b.add("case.created", caseWith([]));
  issue(b, "q1", "address_to_domains", "198.51.100.77");
  b.add("card.created", { card: legacy("c1", "q1") });
  issue(b, "q2", "domain_to_clients", "a.example.com");
  b.add("card.created", { card: legacy("c2", "q2", { columns: ["client"], column_types: ["address"], rows: [["192.0.2.17"]], row_count: 1 }) });
  const s = fold(b.entries);
  expect(cardObserved(s, s.cards.c2!)!.from).toEqual({ type: "domain", value: "a.example.com" });
  expect(cardObserved(s, s.cards.c1!)!.from).toEqual({ type: "unknown", value: "198.51.100.77" });
});

test("an assessment, a note and a card whose query named no pivot have none", () => {
  const b = new EntryBuilder();
  b.add("case.created", caseWith([ADDR]));
  issue(b, "q1", null, "198.51.100.77");
  b.add("card.created", { card: legacy("c1", "q1") });
  b.add("card.created", { card: card("c2", { kind: "assessment" }) });
  b.add("card.created", { card: card("c3", { kind: "note" }) });
  b.add("card.created", { card: legacy("c4", "q9") });
  b.add("card.created", { card: legacy("c5", "constructor") });
  const s = fold(b.entries);
  for (const id of ["c1", "c2", "c3", "c4", "c5"]) expect(cardObserved(s, s.cards[id]!)).toBeNull();
  expect(allObserved(s)).toEqual([]);
});

test("a legacy card with odd cells reads what it can and throws nothing", () => {
  const b = new EntryBuilder();
  b.add("case.created", caseWith([ADDR]));
  issue(b, "q1", "address_to_domains", "198.51.100.77");
  b.add("card.created", { card: legacy("c1", "q1", { columns: ["name"], column_types: ["domain", "domain"], rows: [[], [null], [{ x: 1 }], ["a.example.com", "b.example.com"]] }) });
  const s = fold(b.entries);
  expect(cardObserved(s, s.cards.c1!)!.found.map((f) => f.value)).toEqual(["a.example.com", "b.example.com"]);
});

test("allObserved is in the order the cards were made, and the same for the same state", () => {
  const b = new EntryBuilder();
  b.add("case.created", caseWith([ADDR]));
  b.add("card.created", { card: card("c2", { observed: { ...OBSERVED, pivot: "second" } }) });
  issue(b, "q1", "address_to_domains", "198.51.100.77");
  b.add("card.created", { card: legacy("c1", "q1") });
  b.add("card.created", { card: card("c3", { observed: OBSERVED }) });
  const s = fold(b.entries);
  expect(allObserved(s).map((o) => [o.card, o.legacy])).toEqual([["c2", false], ["c1", true], ["c3", false]]);
  expect(allObserved(s)).toEqual(allObserved(s));
});
