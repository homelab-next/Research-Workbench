import { graphOf } from "../../core/state/graph";
import type { GraphEdge, GraphModel, GraphNode } from "../../core/state/graph";
import type { Open } from "../app";
import { belongsByValue } from "../belongs";
import type { Verdict } from "../belongs";
import { cardChip } from "../chips";
import { clear } from "../dom";
import { layoutGraph } from "../graphlayout";
import type { GraphLayout, PlacedNode } from "../graphlayout";
import { makeS } from "../svg";
import type { Ui, View } from "../ui";

const GLYPHS: Record<Verdict, { glyph: string; cls: string }> = {
  "known": { glyph: "✓", cls: "belongs-known" },
  "not known: proven": { glyph: "✗", cls: "belongs-proven" },
  "not seen": { glyph: "?", cls: "belongs-not-seen" },
  "could not tell": { glyph: "?", cls: "belongs-unknown" },
};
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** The Graph lens: the observed values as nodes and the pivots that found one from another as edges, laid out the same way every time. */
export function makeGraph(ui: Ui, open: Open): View {
  const { h } = ui;
  const s = makeS(ui.doc);
  const { store, nav } = open;
  const hiddenTypes = new Set<string>();
  let selected: string | null = null;
  let focus: string | null = null;
  let cursor: string | null = null;
  let seen: unknown = null;
  let sig = "";
  let model: GraphModel = { nodes: [], edges: [], legacy: false };
  let layout: GraphLayout | null = null;

  const filter = h("div", { class: "filter graph-filter", role: "group", name: "Show types" });
  const count = h("span", { class: "graph-count" });
  const whole = h("button", { type: "button", class: "graph-whole", on: { click: () => { focus = null; refresh(); } } }, "Whole graph");
  const head = h("div", { class: "graph-head" }, filter, count, whole);
  const notes = h("div", { class: "graph-notes" });
  const empty = h("p", { class: "empty" }, "No lookup has linked these yet.");
  const scroll = h("div", { class: "graph-scroll" });
  const side = h("aside", { class: "graph-detail" });
  const body = h("div", { class: "graph-body" }, scroll, side);
  const el = h("div", { class: "lens lens-graph", name: "Graph" }, head, empty, notes, body);

  const typeTitle = (id: string): string => ui.ref.types.find((t) => t.id === id)?.title ?? id;
  const pivotTitle = (id: string): string => ui.ref.pivots.find((p) => p.id === id)?.title ?? id;
  const nameOf = (n: GraphNode): string => `${typeTitle(n.type)} ${n.value}`;
  const byKey = (): Map<string, GraphNode> => new Map(model.nodes.map((n) => [n.key, n]));

  const viaText = (e: GraphEdge): string => e.via.map((v) => `${pivotTitle(v.pivot)} · ${v.card}`).join("; ");
  const titles = (e: GraphEdge): string => [...new Set(e.via.map((v) => pivotTitle(v.pivot)))].join(", ");

  const refresh = (): void => { seen = null; view.update(); };

  const select = (key: string): void => { selected = key; cursor = key; refresh(); };
  const focusNode = (key: string): void => {
    for (const n of el.querySelectorAll("g.node")) if (n.getAttribute("data-key") === key) (n as unknown as HTMLElement).focus();
  };
  const move = (to: string): void => { cursor = to; refresh(); focusNode(to); };

  const onKey = (e: Event): void => {
    const ev = e as KeyboardEvent;
    const at = (ev.target as Element).closest?.("g.node")?.getAttribute("data-key");
    if (at === null || at === undefined || layout === null) return;
    const order = layout.nodes.map((n) => n.key);
    const i = order.indexOf(at);
    const go = (to: number): void => { ev.preventDefault(); move(order[Math.max(0, Math.min(order.length - 1, to))]!); };
    switch (ev.key) {
      case "ArrowRight": case "ArrowDown": go(i + 1); break;
      case "ArrowLeft": case "ArrowUp": go(i - 1); break;
      case "Home": go(0); break;
      case "End": go(order.length - 1); break;
      case "Enter": case " ": ev.preventDefault(); select(at); break;
    }
  };

  const drawNode = (p: PlacedNode, n: GraphNode, cls: string, verdict: { verdict: Verdict; text: string } | undefined, tab: boolean): SVGElement => {
    const g = verdict === undefined ? null : GLYPHS[verdict.verdict];
    const label = [`${nameOf(n)}, ${plural(n.cards.length, "card", "cards")}`, verdict?.text, p.more > 0 ? `${p.more} more linked values not drawn` : null].filter((x) => x != null).join(", ");
    const classes = ["node", cls, n.key === selected ? "selected" : "", n.starting ? "starting" : "", g?.cls ?? ""].filter((x) => x !== "").join(" ");
    return s("g", { class: classes, translate: [p.x, p.y], role: "button", tabindex: tab ? 0 : -1, name: label, data: { key: n.key }, aria: { pressed: String(n.key === selected) }, on: { click: () => select(n.key) } },
      s("title", null, `${nameOf(n)}${verdict === undefined ? "" : ` · ${verdict.text}`}`),
      s("rect", { width: 180, height: 26, rx: 6 }),
      s("text", { class: "node-type", x: 8, y: 10 }, typeTitle(n.type)),
      s("text", { class: "node-value", x: 8, y: 21 }, p.label),
      g === null ? null : s("text", { class: "belongs", x: 172, y: 18, anchor: "end" }, g.glyph),
      p.more > 0 ? s("text", { class: "more", x: 172, y: 9, anchor: "end" }, `+${p.more}`) : null);
  };

  const drawing = (lay: GraphLayout, nodes: Map<string, GraphNode>, types: string[], verdicts: ReturnType<typeof belongsByValue>): SVGElement => {
    const first = lay.nodes.some((p) => p.key === cursor) ? cursor : lay.nodes[0]?.key ?? null;
    const edges = lay.edges.map((pe) => {
      const e = model.edges.find((x) => x.key === pe.key)!;
      const end = pe.points[pe.points.length - 1]!;
      const mine = selected !== null && (pe.from === selected || pe.to === selected);
      const mid = pe.points[Math.floor((pe.points.length - 1) / 2)]!;
      const next = pe.points[Math.floor((pe.points.length - 1) / 2) + 1]!;
      return s("g", { class: mine ? "edge selected" : "edge", data: { from: pe.from, to: pe.to } },
        s("title", null, viaText(e)), s("path", { points: pe.points }), s("circle", { class: "edge-end", cx: end[0], cy: end[1], r: 3 }),
        mine ? s("text", { class: "edge-label", x: (mid[0] + next[0]) / 2, y: (mid[1] + next[1]) / 2 - 3, anchor: "middle" }, titles(e)) : null);
    });
    const placed = lay.nodes.map((p) => {
      const n = nodes.get(p.key)!;
      return drawNode(p, n, `t${types.indexOf(n.type) % 8}`, verdicts.get(n.key), p.key === first);
    });
    return s("svg", { class: "graph-svg", role: "group", name: "Observed values and the pivots that linked them", width: lay.width, height: lay.height, viewBox: [0, 0, lay.width, lay.height], on: { keydown: onKey } }, edges, placed);
  };

  const details = (n: GraphNode | undefined, verdicts: ReturnType<typeof belongsByValue>): void => {
    clear(side);
    if (n === undefined) { side.append(h("p", { class: "muted" }, "Select a value to see its cards and links.")); return; }
    const nodes = byKey();
    const verdict = verdicts.get(n.key);
    const last = n.cards.length === 0 ? null : n.cards[n.cards.length - 1]!;
    const reason = store.at !== null ? "Return to live to pivot" : last === null ? "No card holds this value yet" : null;
    const links = model.edges.flatMap((e) => {
      const out = e.from === n.key ? [{ arrow: "→", other: nodes.get(e.to)!, e }] : [];
      return e.to === n.key ? [{ arrow: "←", other: nodes.get(e.from)!, e }, ...out] : out;
    });
    side.append(
      ...[h("h3", null, nameOf(n)),
      verdict === undefined ? null : h("p", { class: `belongs-verdict ${GLYPHS[verdict.verdict].cls}` }, verdict.text),
      h("div", { class: "node-cards" }, n.cards.length === 0 ? h("span", { class: "muted" }, "No card holds this value yet.") : n.cards.map((c) => cardChip(ui, c, (id) => nav.focusCard(id)))),
      h("ul", { class: "node-links" }, links.map((l) => h("li", null, `${l.arrow} `,
        h("button", { type: "button", class: "link", data: { action: "focus" }, title: `Focus the graph on ${nameOf(l.other)}`, on: { click: () => { focus = l.other.key; selected = l.other.key; cursor = l.other.key; refresh(); } } }, nameOf(l.other)),
        ` · ${titles(l.e)} · ${[...new Set(l.e.via.map((v) => v.card))].join(", ")}`))),
      n.more > 0 ? h("p", { class: "node-more" }, `Its cards hold ${n.more} more ${n.more === 1 ? "value" : "values"} than they list.`) : null,
      h("div", { class: "node-actions" },
        h("button", { type: "button", data: { action: "pivot" }, disabled: reason !== null, title: reason ?? "Pivot from this value", on: { click: () => { if (reason === null && last !== null) nav.pivot(last, [{ type: n.type, value: n.value }]); } } }, "Pivot…"),
        h("button", { type: "button", data: { action: "focus-self" }, on: { click: () => { focus = n.key; refresh(); } } }, "Focus on this value"))].filter((x) => x !== null));
  };

  const view: View = {
    el,
    update() {
      const state = store.shown;
      const dock = ui.prefs.get<unknown>("dock", "bottom") === "right" ? "tall" : "wide";
      const key = [dock, [...hiddenTypes].sort().join(","), focus ?? "", selected ?? "", cursor ?? ""].join("|");
      if (seen === state && sig === key) return;
      seen = state;
      sig = key;
      const hadFocus = el.contains(ui.doc.activeElement);
      model = graphOf(state);
      const nodes = byKey();
      if (selected !== null && !nodes.has(selected)) selected = null;
      if (focus !== null && !nodes.has(focus)) focus = null;
      const types = [...new Set(model.nodes.map((n) => n.type))].sort();
      for (const t of [...hiddenTypes]) if (!types.includes(t)) hiddenTypes.delete(t);
      const verdicts = belongsByValue(state, ui.ref);
      layout = layoutGraph(model, { dir: dock, types: hiddenTypes.size === 0 ? null : new Set(types.filter((t) => !hiddenTypes.has(t))), focus });

      clear(filter);
      for (const t of types) {
        filter.append(h("label", null, h("input", {
          type: "checkbox", checked: !hiddenTypes.has(t), name: typeTitle(t),
          on: { change: (e) => { if ((e.target as HTMLInputElement).checked) hiddenTypes.delete(t); else hiddenTypes.add(t); refresh(); } },
        }), ` ${typeTitle(t)}`));
      }
      count.textContent = `Showing ${layout.shown} of ${layout.of} values`;
      count.hidden = model.nodes.length === 0;
      whole.hidden = focus === null;
      empty.hidden = model.edges.length > 0;
      clear(notes);
      if (model.legacy) notes.append(h("p", { class: "graph-legacy" }, "Some cards were recorded before links were; their links are read from the first 50 rows."));
      clear(scroll);
      if (layout.nodes.length > 0) scroll.append(drawing(layout, nodes, types, verdicts));
      details(selected === null ? undefined : nodes.get(selected), verdicts);
      if (hadFocus && cursor !== null) focusNode(cursor);
    },
  };
  return view;
}
