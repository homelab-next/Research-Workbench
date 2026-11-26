import { expect, test } from "bun:test";
import { fold } from "../../src/core/state";
import { graphOf } from "../../src/core/state/graph";
import type { Card, Observed, Observable, Payloads } from "../../src/core/types";
import { EntryBuilder, card } from "../helpers/entries";

const found = (type: string, value: string) => ({ type, value, first: null, last: null, count: null, points: [] });
const obs = (pivot: string, from: Observable, f: Observable[], more = 0): Observed => ({
  pivot, from, span: { first: null, last: null, count: null }, found: f.map((x) => found(x.type, x.value)), more, unread: 0,
});
const A = (v: string): Observable => ({ type: "address", value: v });
const D = (v: string): Observable => ({ type: "domain", value: v });
const caseWith = (starting: Observable[]): Payloads["case.created"] => ({
  id: "case-1", title: "t", asked: "a", why: "w", starting, window: { from: null, to: null }, objective: null, marking: "TLP:AMBER",
});
function build(starting: Observable[], cards: Record<string, Observed>, discard: string[] = []) {
  const b = new EntryBuilder();
  b.add("case.created", caseWith(starting));
  for (const [id, observed] of Object.entries(cards)) b.add("card.created", { card: card(id, { observed } as Partial<Card>) });
  for (const id of discard) b.add("card.discarded", { card: id });
  return fold(b.entries);
}
const initial = () => fold([]);

const s = build([A("198.51.100.77")], {
  c1: obs("address_to_domains", A("198.51.100.77"), [D("a.example.com"), D("b.example.com")], 30),
  c2: obs("domain_to_addresses", D("a.example.com"), [A("192.0.2.17")]),
});
const g = graphOf(s);

test("the starting values come first, then values in the order cards were made: the value a pivot ran on, then what it found", () => {
  expect(g.nodes.map((n) => n.key)).toEqual(["address|198.51.100.77", "domain|a.example.com", "domain|b.example.com", "address|192.0.2.17"]);
  expect(g.nodes[0]).toMatchObject({ starting: true, cards: ["c1"] });
  expect(g.nodes[1]).toMatchObject({ starting: false, cards: ["c1", "c2"] });
  expect(g.legacy).toBe(false);
});

test("an edge from the value a pivot ran on to each value it found, with the pivot and the card", () => {
  expect(g.edges[0]).toEqual({ key: "address|198.51.100.77>domain|a.example.com", from: "address|198.51.100.77", to: "domain|a.example.com", via: [{ pivot: "address_to_domains", card: "c1" }] });
});

test("two cards saying the same link make one edge with both; the two directions are two edges; a value found from itself makes none", () => {
  const t = graphOf(build([], {
    c1: obs("p", A("A"), [A("B"), A("A")]),
    c2: obs("q", A("B"), [A("A")]),
    c3: obs("p", A("A"), [A("B")]),
  }));
  expect(t.edges.map((e) => [e.key, e.via.map((v) => v.card)])).toEqual([["address|A>address|B", ["c1", "c3"]], ["address|B>address|A", ["c2"]]]);
});

test("a node counts the values its cards could not list", () => {
  expect(g.nodes[0]!.more).toBe(30);
  expect(g.nodes[1]!.more).toBe(0);
});

test("a discarded card's values and links are gone; a starting value stays", () => {
  const t = graphOf(build([A("198.51.100.77")], { c1: obs("p", A("198.51.100.77"), [D("a.example.com")]) }, ["c1"]));
  expect(t.nodes.map((n) => n.key)).toEqual(["address|198.51.100.77"]);
  expect(t.nodes[0]).toMatchObject({ starting: true, cards: [] });
  expect(t.edges).toEqual([]);
});

test("a value holding the key's separator is still one node", () => {
  const t = graphOf(build([], { c1: obs("p", A("S"), [{ type: "note", value: "a|b" }]) }));
  const n = t.nodes.filter((x) => x.type === "note");
  expect(n.length).toBe(1);
  expect(n[0]!.key).toBe("note|a|b");
  expect(t.edges[0]!.to).toBe("note|a|b");
  expect(t.nodes.some((x) => x.key === t.edges[0]!.to)).toBe(true);
});

test("no case gives no nodes; the same state gives the same model", () => {
  expect(graphOf(initial())).toEqual({ nodes: [], edges: [], legacy: false });
  expect(graphOf(s)).toEqual(graphOf(s));
});
