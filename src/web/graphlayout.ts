// The Graph's layered layout (design 6b §8.1): pure, whole numbers, the same model and options always give the same layout. Browser-safe.
import type { GraphModel } from "../core/state/graph";

export const GRAPH = { nodes: 60, children: 12, w: 180, h: 26, gapX: 70, gapY: 8, indent: 24, pad: 12, label: 22 } as const;

export interface PlacedNode { key: string; x: number; y: number; layer: number; label: string; more: number }
export interface PlacedEdge { key: string; from: string; to: string; points: [number, number][] }
export interface GraphLayout { nodes: PlacedNode[]; edges: PlacedEdge[]; width: number; height: number; shown: number; of: number }

const r2 = (n: number): number => Math.round(n * 100) / 100;
const cut = (value: string): string => {
  const cs = Array.from(value);
  return cs.length > GRAPH.label ? `${cs.slice(0, GRAPH.label).join("")}…` : value;
};

interface Walked { key: string; layer: number; parent: string | null }

export function layoutGraph(model: GraphModel, opts: { dir: "wide" | "tall"; types: ReadonlySet<string> | null; focus: string | null }): GraphLayout {
  const { pad, w, h, gapX, gapY, indent } = GRAPH;
  const visible = model.nodes.filter((n) => opts.types === null || opts.types.has(n.type));
  const order = new Map(visible.map((n, i) => [n.key, i]));
  const byKey = new Map(visible.map((n) => [n.key, n]));
  const edges = model.edges.filter((e) => order.has(e.from) && order.has(e.to) && e.from !== e.to);

  const adj = new Map<string, Set<string>>(visible.map((n) => [n.key, new Set<string>()]));
  for (const e of edges) {
    adj.get(e.from)!.add(e.to);
    adj.get(e.to)!.add(e.from);
  }
  const neighbours = (key: string): string[] => [...adj.get(key)!].sort((x, y) => order.get(x)! - order.get(y)!);

  const placed = new Map<string, Walked>();
  const passed = new Set<string>();
  const queue: string[] = [];
  const children = new Map<string, string[]>();
  const root = (key: string): void => {
    if (placed.size < GRAPH.nodes) {
      placed.set(key, { key, layer: 0, parent: null });
      queue.push(key);
    } else passed.add(key);
  };

  const focused = opts.focus !== null && order.has(opts.focus);
  if (focused) root(opts.focus!);
  else for (const n of visible) if (n.starting) root(n.key);

  for (;;) {
    while (queue.length > 0) {
      const at = queue.shift()!;
      const mine = placed.get(at)!;
      for (const nb of neighbours(at)) {
        if (placed.has(nb) || passed.has(nb)) continue;
        const kids = children.get(at) ?? [];
        if (kids.length < GRAPH.children && placed.size < GRAPH.nodes) {
          placed.set(nb, { key: nb, layer: mine.layer + 1, parent: at });
          children.set(at, [...kids, nb]);
          queue.push(nb);
        } else passed.add(nb);
      }
    }
    if (focused) break;
    const next = visible.find((n) => !placed.has(n.key) && !passed.has(n.key));
    if (next === undefined) break;
    root(next.key);
  }

  // The order the keyboard walks: placement order, or the tree depth-first when tall.
  let walk: Walked[] = [...placed.values()];
  if (opts.dir === "tall") {
    const out: Walked[] = [];
    const visit = (key: string): void => {
      out.push(placed.get(key)!);
      for (const k of children.get(key) ?? []) visit(k);
    };
    for (const p of walk) if (p.parent === null) visit(p.key);
    walk = out;
  }

  const seenInLayer = new Map<number, number>();
  const at = new Map<string, PlacedNode>();
  const nodes: PlacedNode[] = walk.map((p, line) => {
    const n = byKey.get(p.key)!;
    const idx = seenInLayer.get(p.layer) ?? 0;
    seenInLayer.set(p.layer, idx + 1);
    const hidden = neighbours(p.key).filter((k) => !placed.has(k)).length;
    const pn: PlacedNode = opts.dir === "wide"
      ? { key: p.key, x: r2(pad + p.layer * (w + gapX)), y: r2(pad + idx * (h + gapY)), layer: p.layer, label: cut(n.value), more: hidden }
      : { key: p.key, x: r2(pad + p.layer * indent), y: r2(pad + line * (h + gapY)), layer: p.layer, label: cut(n.value), more: hidden };
    at.set(p.key, pn);
    return pn;
  });

  const placedEdges: PlacedEdge[] = edges.filter((e) => at.has(e.from) && at.has(e.to)).map((e) => {
    const f = at.get(e.from)!, t = at.get(e.to)!;
    let pts: [number, number][];
    if (opts.dir === "tall") {
      const [u, l] = f.y <= t.y ? [f, t] : [t, f];
      pts = [[u.x + 8, u.y + h], [u.x + 8, l.y + h / 2], [l.x, l.y + h / 2]];
    } else if (f.layer === t.layer) {
      const x = f.x + w + 16;
      pts = [[f.x + w, f.y + h / 2], [x, f.y + h / 2], [x, t.y + h / 2], [t.x + w, t.y + h / 2]];
    } else {
      const [lo, hi] = f.layer < t.layer ? [f, t] : [t, f];
      const mx = lo.x + w + gapX / 2;
      pts = [[lo.x + w, lo.y + h / 2], [mx, lo.y + h / 2], [mx, hi.y + h / 2], [hi.x, hi.y + h / 2]];
    }
    return { key: e.key, from: e.from, to: e.to, points: pts.map(([x, y]): [number, number] => [r2(x), r2(y)]) };
  });

  const width = nodes.length === 0 ? pad * 2 : Math.max(...nodes.map((n) => n.x)) + w + pad;
  const height = nodes.length === 0 ? pad * 2 : Math.max(...nodes.map((n) => n.y)) + h + pad;
  return { nodes, edges: placedEdges, width, height, shown: nodes.length, of: visible.length };
}
