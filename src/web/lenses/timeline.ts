import { timelineOf } from "../../core/state/timeline";
import type { TimelineMark, TimelineModel, TimelineRow } from "../../core/state/timeline";
import type { Open } from "../app";
import { cardChip } from "../chips";
import { clear } from "../dom";
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
  let seen: unknown = null;
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

  const makeRow = (model: TimelineModel, row: TimelineRow, x: (ts: string) => number): HTMLElement => {
    const full = `${typeTitle(row.type)} ${row.value}`;
    const detail = h("ul", { class: "tl-detail", hidden: !expanded.has(row.key) },
      row.marks.map((m) => h("li", null, cardChip(ui, m.card, (c) => nav.focusCard(c)), line(m).slice(m.card.length))));
    const button = h("button", {
      type: "button", class: "tl-label", title: full, aria: { expanded: String(expanded.has(row.key)) },
      on: { click: () => {
        if (expanded.has(row.key)) expanded.delete(row.key); else expanded.add(row.key);
        const again = makeRow(model, row, x);
        wrap.replaceWith(again);
        (again.querySelector(".tl-label") as HTMLElement).focus();
      } },
    }, cut(full));
    const wrap = h("div", { class: "tl-row", data: { key: row.key } }, button, strip(model, row, x), detail);
    return wrap;
  };

  const note = (cls: string, text: string): HTMLElement => h("p", { class: cls }, text);

  return {
    el,
    update() {
      const state = store.shown;
      const key = [...hiddenTypes].sort().join(",");
      if (seen === state && filterKey === key) return;
      seen = state;
      filterKey = key;
      const model = timelineOf(state);
      empty.hidden = model.rows.length > 0;
      axis.hidden = model.from === null;
      axis.textContent = model.from === null || model.to === null ? "" : `${model.from} → ${model.to}`;
      const types = [...new Set(model.rows.map((r) => r.type))].sort();
      clear(filter);
      for (const t of types) {
        filter.append(h("label", null, h("input", {
          type: "checkbox", checked: !hiddenTypes.has(t), name: typeTitle(t),
          on: { change: (e) => { if ((e.target as HTMLInputElement).checked) hiddenTypes.delete(t); else hiddenTypes.add(t); seen = null; this.update(); } },
        }), ` ${typeTitle(t)}`));
      }
      clear(notes);
      if (model.untimed > 0) notes.append(note("tl-untimed", `${model.untimed} ${plural(model.untimed, "value has", "values have")} no observed time (${plural(model.untimed, "its pivot declares none", "their pivots declare none")}); ${plural(model.untimed, "it is", "they are")} in the Graph.`));
      if (model.unread > 0) notes.append(note("tl-unread", `${model.unread} ${plural(model.unread, "row had", "rows had")} a time that could not be read.`));
      if (model.legacy) notes.append(note("tl-legacy", "Some cards were recorded before times were; their values are in the Graph only."));
      const rows = model.rows.filter((r) => !hiddenTypes.has(r.type));
      const x = timelineScale(model);
      clear(list);
      for (const r of rows.slice(0, TIMELINE_ROWS)) list.append(makeRow(model, r, x));
      const left = rows.length - TIMELINE_ROWS;
      more.hidden = left <= 0;
      more.textContent = left > 0 ? `${left} more ${plural(left, "value", "values")}: narrow by type.` : "";
    },
  };
}
