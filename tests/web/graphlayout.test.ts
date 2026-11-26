import { expect, test } from "bun:test";
import type { GraphEdge, GraphModel, GraphNode } from "../../src/core/state/graph";
import { GRAPH, layoutGraph } from "../../src/web/graphlayout";

const nd = (type: string, value: string, starting = false): GraphNode => ({ key: `${type}|${value}`, type, value, cards: ["c1"], starting, more: 0 });
const ed = (a: GraphNode, b: GraphNode): GraphEdge => ({ key: `${a.key}>${b.key}`, from: a.key, to: b.key, via: [{ pivot: "p", card: "c1" }] });
const model = (nodes: GraphNode[], edges: GraphEdge[]): GraphModel => ({ nodes, edges, legacy: false });
const WIDE = { dir: "wide", types: null, focus: null } as const;
const TALL = { dir: "tall", types: null, focus: null } as const;

const S = nd("address", "S", true), a = nd("domain", "a"), b = nd("domain", "b"), c = nd("address", "c");
const base = model([S, a, b, c], [ed(S, a), ed(S, b), ed(a, c)]);

test("wide: layers are columns by distance from the starting values; a layer stacks in walk order", () => {
  const l = layoutGraph(base, WIDE);
  expect(l.nodes.map((n) => [n.key, n.layer, n.x, n.y])).toEqual([["address|S", 0, 12, 12], ["domain|a", 1, 262, 12], ["domain|b", 1, 262, 46], ["address|c", 2, 512, 12]]);
  expect([l.width, l.height]).toEqual([704, 84]);
  expect([l.shown, l.of]).toEqual([4, 4]);
});

test("tall: one node a line in the walk tree's depth-first order, indented by layer", () => {
  const l = layoutGraph(base, TALL);
  expect(l.nodes.map((n) => [n.key, n.x, n.y])).toEqual([["address|S", 12, 12], ["domain|a", 36, 46], ["address|c", 60, 80], ["domain|b", 36, 114]]);
});

test("an edge is walked in either direction: a value that found a starting value sits one layer from it", () => {
  const x = nd("domain", "x");
  const l = layoutGraph(model([S, x], [ed(x, S)]), WIDE);
  expect(l.nodes.map((n) => [n.key, n.layer])).toEqual([["address|S", 0], ["domain|x", 1]]);
});

test("values no starting value reaches start again at layer 0, first in model order", () => {
  const p = nd("domain", "p"), q = nd("domain", "q");
  const l = layoutGraph(model([S, p, q], [ed(q, p)]), WIDE);
  expect(l.nodes.map((n) => [n.key, n.layer])).toEqual([["address|S", 0], ["domain|p", 0], ["domain|q", 1]]);
});

test("a loop ends: A found B and B found A place both once", () => {
  const A = nd("address", "A", true), B = nd("address", "B");
  const l = layoutGraph(model([A, B], [ed(A, B), ed(B, A)]), WIDE);
  expect(l.nodes.map((n) => n.key)).toEqual(["address|A", "address|B"]);
  expect(l.edges.length).toBe(2);
});

test("a node places 12 neighbours and counts the rest; they are not made roots", () => {
  const hub = nd("address", "hub", true);
  const kids = Array.from({ length: 30 }, (_, i) => nd("domain", `k${String(i).padStart(2, "0")}`));
  const l = layoutGraph(model([hub, ...kids], kids.map((k) => ed(hub, k))), WIDE);
  expect(l.nodes.length).toBe(13);
  expect(l.nodes[0]!.more).toBe(18);
  expect([l.shown, l.of]).toEqual([13, 31]);
  expect(l.nodes.every((n) => n.layer <= 1)).toBe(true);
});

test("at most 60 nodes are placed", () => {
  const nodes: GraphNode[] = [nd("address", "h0", true)];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < 8; i++) {
    const hub = nodes.find((n) => n.value === `h${i}`)!;
    const next = nd("address", `h${i + 1}`);
    nodes.push(next);
    edges.push(ed(hub, next));
    for (let k = 0; k < 11; k++) {
      const leaf = nd("domain", `l${i}-${k}`);
      nodes.push(leaf);
      edges.push(ed(hub, leaf));
    }
  }
  const l = layoutGraph(model(nodes, edges), WIDE);
  expect(l.nodes.length).toBe(60);
  expect(l.of).toBe(nodes.length);
});

test("focus roots the walk at one node; a filter hides a type and its edges", () => {
  const f = layoutGraph(base, { dir: "wide", types: null, focus: "domain|a" });
  expect(f.nodes.map((n) => [n.key, n.layer])).toEqual([["domain|a", 0], ["address|S", 1], ["address|c", 1], ["domain|b", 2]]);
  const t = layoutGraph(base, { dir: "wide", types: new Set(["address"]), focus: null });
  expect(t.nodes.map((n) => n.key)).toEqual(["address|S", "address|c"]);
  expect(t.edges).toEqual([]);
  expect(t.of).toBe(2);
});

test("an edge is drawn only between placed nodes; its points are whole numbers of at most two decimals", () => {
  const hub = nd("address", "hub", true);
  const kids = Array.from({ length: 14 }, (_, i) => nd("domain", `k${String(i).padStart(2, "0")}`));
  const l = layoutGraph(model([hub, ...kids], kids.map((k) => ed(hub, k))), WIDE);
  const placed = new Set(l.nodes.map((n) => n.key));
  expect(l.edges.length).toBe(12);
  for (const e of l.edges) {
    expect(placed.has(e.from) && placed.has(e.to)).toBe(true);
    for (const [x, y] of e.points) for (const v of [x, y]) expect(Math.round(v * 100) / 100).toBe(v);
  }
  const first = l.edges[0]!;
  expect(first.points[0]).toEqual([12 + GRAPH.w, 12 + GRAPH.h / 2]);
  expect(first.points[first.points.length - 1]).toEqual([262, 12 + GRAPH.h / 2]);
  const same = layoutGraph(model([nd("address", "A", true), nd("address", "B")].map((n, i) => (i === 0 ? n : n)), []), WIDE);
  expect(same.edges).toEqual([]);
  const tall = layoutGraph(base, TALL);
  expect(tall.edges[0]!.points).toEqual([[20, 38], [20, 59], [36, 59]]);
});

test("a label is cut at 22 characters with an ellipsis", () => {
  const l = layoutGraph(model([nd("note", "a".repeat(40), true)], []), WIDE);
  expect(l.nodes[0]!.label).toBe("aaaaaaaaaaaaaaaaaaaaaa…");
  expect(layoutGraph(model([nd("note", "short", true)], []), WIDE).nodes[0]!.label).toBe("short");
});

test("a new card adds nodes without moving the nodes of earlier layers", () => {
  const d = nd("domain", "d"), e = nd("address", "e");
  const more = model([S, a, b, c, d, e], [ed(S, a), ed(S, b), ed(a, c), ed(S, d), ed(d, e)]);
  const before = layoutGraph(base, WIDE), after = layoutGraph(more, WIDE);
  for (const n of before.nodes.filter((x) => x.layer <= 1)) {
    const m = after.nodes.find((x) => x.key === n.key)!;
    expect([m.x, m.y]).toEqual([n.x, n.y]);
  }
  expect(after.nodes.length).toBe(6);
});

test("the same model and options give the same layout", () => {
  expect(layoutGraph(base, WIDE)).toEqual(layoutGraph(base, WIDE));
  expect(layoutGraph(base, TALL)).toEqual(layoutGraph(base, TALL));
});
