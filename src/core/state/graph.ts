// The graph of observed values: a node per value, an edge per pivot link (design 6b §6). Browser-safe, pure.
import { allObserved, valueKey } from "./observed";
import type { CaseState } from "./types";

export interface GraphNode { key: string; type: string; value: string; cards: string[]; starting: boolean; more: number }
export interface GraphEdge { key: string; from: string; to: string; via: { pivot: string; card: string }[] }
export interface GraphModel { nodes: GraphNode[]; edges: GraphEdge[]; legacy: boolean }

/** Nodes: the starting values, then every value of every card's observed in the order the cards were made. Edges: the value a pivot ran on to each value it found. */
export function graphOf(state: CaseState): GraphModel {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const node = (type: string, value: string): GraphNode => {
    const key = valueKey(type, value);
    let n = nodes.get(key);
    if (n === undefined) {
      n = { key, type, value, cards: [], starting: false, more: 0 };
      nodes.set(key, n);
    }
    return n;
  };
  for (const o of state.meta?.starting ?? []) node(o.type, o.value).starting = true;
  let legacy = false;
  for (const o of allObserved(state)) {
    if (o.legacy) legacy = true;
    const from = node(o.from.type, o.from.value);
    if (!from.cards.includes(o.card)) from.cards.push(o.card);
    from.more += o.more;
    for (const f of o.found) {
      const to = node(f.type, f.value);
      if (!to.cards.includes(o.card)) to.cards.push(o.card);
      if (to.key === from.key) continue;
      const key = `${from.key}>${to.key}`;
      let e = edges.get(key);
      if (e === undefined) {
        e = { key, from: from.key, to: to.key, via: [] };
        edges.set(key, e);
      }
      if (!e.via.some((v) => v.pivot === o.pivot && v.card === o.card)) e.via.push({ pivot: o.pivot, card: o.card });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], legacy };
}
