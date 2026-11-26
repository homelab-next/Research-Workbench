import { timelineOf } from "../../core/state/timeline";
import type { TimelineMark, TimelineModel, TimelineRow } from "../../core/state/timeline";
import type { Open } from "../app";
import { cardChip } from "../chips";
import { clear, keepFocus, syncList } from "../dom";
import { makeS } from "../svg";
import type { Ui, View } from "../ui";

/** The rows drawn; the rest are counted. */
export const TIMELINE_ROWS = 200;
const WIDTH = 1000;
const MIN_BAR = 4;
const HALF_HOUR = 30 * 60 * 1000;
const LABEL_CUT = 60;

/** The two ends of an axis. */
export interface Axis { from: string | null; to: string | null }

/** x in 0..1000 for a time on the model's axis. An axis of no width is widened by 30 minutes each side. */
export function timelineScale(model: Axis): (ts: string) => number {
  if (model.from === null || model.to === null) return () => WIDTH / 2;
  let lo = Date.parse(model.from);
  let hi = Date.parse(model.to);
  if (!(hi > lo)) { lo -= HALF_HOUR; hi += HALF_HOUR; }
  return (ts) => {
    const x = ((Date.parse(ts) - lo) / (hi - lo)) * WIDTH;
    return Math.min(WIDTH, Math.max(0, Number.isFinite(x) ? x : 0));
  };
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const cut = (text: string): string => (text.length > LABEL_CUT ? `${text.slice(0, LABEL_CUT)}…` : text);

/** The Timeline lens: what was observed, on the data's own time axis, a row per value and a mark per card that saw it. */
export function makeTimeline(ui: Ui, open: Open): View {
  const { h } = ui;
  const s = makeS(ui.doc);
  const { store, nav } = open;
  const hiddenTypes = new Set<string>();
  const expanded = new Set<string>();
  const head = h("div", { class: "tl-head" });
  const filter = h("div", { class: "filter tl-filter", role: "group", name: "Show types" });
  const axis = h("p", { class: "tl-axis" });
  const notes = h("div", { class: "tl-notes" });
  const list = h("div", { class: "tl-rows" });
  const more = h("p", { class: "tl-more", hidden: true });
  const empty = h("p", { class: "empty" }, "No card carries an observed time yet. A pivot gives one when its manifest declares times.");
  const el = h("div", { class: "lens lens-timeline", name: "Timeline" }, head, empty, notes, list, more);
  head.append(filter, axis);
  let seen: unknown[] | null = null;
  let filterKey = "";

  const typeTitle = (id: string): string => ui.ref.types.find((t) => t.id === id)?.title ?? id;
  const pivotTitle = (id: string): string => ui.ref.pivots.find((p) => p.id === id)?.title ?? id;
  const line = (m: TimelineMark): string => {
    const parts = [m.card, `${m.role === "found" ? "found by" : "subject of"} ${pivotTitle(m.pivot)}`, `${m.first} → ${m.last}`];
    if (m.count !== null) parts.push(`${m.count} ${plural(m.count, "event", "events")}`);
    return parts.join(" · ");
  };

  const strip = (model: TimelineModel, row: TimelineRow, x: (ts: string) => number): SVGElement => {
    const bars = (width: number, at: number): { x: number; width: number } => {
      const w = Math.max(MIN_BAR, width);
      return { x: Math.min(at, WIDTH - w), width: w };
    };
    const winFrom = x(model.window.from ?? model.from ?? "");
    const winTo = model.window.to === null ? WIDTH : x(model.window.to);
    const shade = model.window.from === null && model.window.to === null ? null : s("rect", { class: "tl-window", x: model.window.from === null ? 0 : winFrom, y: 0, width: Math.max(0, winTo - (model.window.from === null ? 0 : winFrom)), height: 20 });
    const peak = Math.max(1, ...row.marks.flatMap((m) => m.points.map((p) => p[1])));
    const marks = row.marks.map((m) => {
      const text = line(m);
      const shapes = m.points.length > 0
        ? m.points.map((p) => {
            const height = Math.max(2, (18 * p[1]) / peak);
            return s("rect", { class: "tl-point", ...bars(MIN_BAR, x(p[0])), y: 19 - height, height });
          })
        : [s("rect", { class: "tl-span", ...bars(x(m.last) - x(m.first), x(m.first)), y: 6, height: 8 })];
      return s("g", { class: `tl-mark tl-${m.role}`, data: { card: m.card }, hidden: true, on: { click: () => nav.focusCard(m.card) } }, s("title", null, text), shapes);
    });
    return s("svg", { class: "tl-strip", viewBox: [0, 0, WIDTH, 20], stretch: true, hidden: true }, shade, marks);
  };

  // What the rows are painted from now: a row is repainted only when its own signature changes.
  let model: TimelineModel | null = null;
  let x: (ts: string) => number = () => 0;
  const painted = new WeakMap<HTMLElement, string>();
  const sigOf = (m: TimelineModel, row: TimelineRow): string => JSON.stringify([m.from, m.to, m.window, row, expanded.has(row.key)]);

  const fill = (wrap: HTMLElement, row: TimelineRow): void => {
    const m = model!;
    const sig = sigOf(m, row);
    if (painted.get(wrap) === sig) return;
    painted.set(wrap, sig);
    const full = `${typeTitle(row.type)} ${row.value}`;
    const open = expanded.has(row.key);
    const detail = h("ul", { class: "tl-detail", hidden: !open },
      row.marks.map((mk) => h("li", null, cardChip(ui, mk.card, (c) => nav.focusCard(c)), line(mk).slice(mk.card.length))));
    const button = h("button", {
      type: "button", class: "tl-label", title: full, aria: { expanded: String(open) },
      on: { click: () => {
        if (expanded.has(row.key)) expanded.delete(row.key); else expanded.add(row.key);
        keepFocus(wrap, () => fill(wrap, row));
      } },
    }, cut(full));
    clear(wrap);
    wrap.append(button, strip(m, row, x), detail);
  };
  const makeRow = (row: TimelineRow): HTMLElement => {
    const wrap = h("div", { class: "tl-row", data: { key: row.key } });
    fill(wrap, row);
    return wrap;
  };

  const note = (cls: string, text: string): HTMLElement => h("p", { class: cls }, text);

  const typeBox = (t: string): HTMLElement => h("label", null, h("input", {
    type: "checkbox", checked: !hiddenTypes.has(t), name: typeTitle(t),
    on: { change: (e) => { if ((e.target as HTMLInputElement).checked) hiddenTypes.delete(t); else hiddenTypes.add(t); view.update(); } },
  }), ` ${typeTitle(t)}`);

  const paint = (state: typeof store.shown): void => {
    const m = timelineOf(state);
    model = m;
    empty.hidden = m.rows.length > 0;
    axis.hidden = m.from === null;
    axis.textContent = m.from === null || m.to === null ? "" : `${m.from} → ${m.to}`;
    const types = [...new Set(m.rows.map((r) => r.type))].sort();
    syncList(filter, types, (t) => t, typeBox, (label, t) => { (label.querySelector("input") as HTMLInputElement).checked = !hiddenTypes.has(t); });
    clear(notes);
    if (m.untimed > 0) notes.append(note("tl-untimed", `${m.untimed} ${plural(m.untimed, "value has", "values have")} no observed time (${plural(m.untimed, "its pivot declares none", "their pivots declare none")}); ${plural(m.untimed, "it is", "they are")} in the Graph.`));
    if (m.unread > 0) notes.append(note("tl-unread", `${m.unread} ${plural(m.unread, "row had", "rows had")} a time that could not be read.`));
    if (m.legacy) notes.append(note("tl-legacy", "Some cards were recorded before times were; their values are in the Graph only."));
    const rows = m.rows.filter((r) => !hiddenTypes.has(r.type));
    x = timelineScale(m);
    syncList(list, rows.slice(0, TIMELINE_ROWS), (r) => r.key, makeRow, fill);
    const left = rows.length - TIMELINE_ROWS;
    more.hidden = left <= 0;
    more.textContent = left > 0 ? `${left} more ${plural(left, "value", "values")}: narrow by type.` : "";
  };

  const view: View = {
    el,
    update() {
      const state = store.shown;
      // the model reads the case's meta, its cards and its queries; an entry that changes none of them changes nothing here
      const reads = [state.meta, state.cards, state.queries];
      const key = [...hiddenTypes].sort().join(",");
      if (seen !== null && reads.every((r, i) => r === seen![i]) && filterKey === key) return;
      seen = reads;
      filterKey = key;
      keepFocus(el, () => paint(state));
    },
  };
  return view;
}
