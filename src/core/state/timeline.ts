// The Timeline model: what was observed, per value, on the data's own time (design 6b §5.6). Browser-safe: imports nothing outside src/core.
import type { TimeWindow } from "../types";
import { allObserved, valueKey } from "./observed";
import type { CaseState } from "./types";

export interface TimelineMark { card: string; pivot: string; role: "subject" | "found"; first: string; last: string; count: number | null; points: [string, number][] }
export interface TimelineRow { key: string; type: string; value: string; first: string; last: string; marks: TimelineMark[] }
export interface TimelineModel {
  rows: TimelineRow[];
  /** The axis: the case window widened to what was observed; both null when there is no row. */
  from: string | null; to: string | null;
  window: TimeWindow;
  untimed: number;      // values observed with no time at all
  unread: number;       // rows whose time could not be read, over every card
  legacy: boolean;      // some card was read the legacy way
}

const less = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function timelineOf(state: CaseState): TimelineModel {
  const window: TimeWindow = { from: state.meta?.window.from ?? null, to: state.meta?.window.to ?? null };
  const rows = new Map<string, TimelineRow>();
  const seen = new Set<string>();
  let unread = 0;
  let legacy = false;
  const mark = (type: string, value: string, m: TimelineMark): void => {
    const key = valueKey(type, value);
    const row = rows.get(key);
    if (row === undefined) { rows.set(key, { key, type, value, first: m.first, last: m.last, marks: [m] }); return; }
    row.marks.push(m);
    if (m.first < row.first) row.first = m.first;
    if (m.last > row.last) row.last = m.last;
  };
  for (const o of allObserved(state)) {
    unread = Math.min(Number.MAX_SAFE_INTEGER, unread + o.unread);
    if (o.legacy) legacy = true;
    seen.add(valueKey(o.from.type, o.from.value));
    if (o.span.first !== null && o.span.last !== null) {
      mark(o.from.type, o.from.value, { card: o.card, pivot: o.pivot, role: "subject", first: o.span.first, last: o.span.last, count: o.span.count, points: [] });
    }
    for (const f of o.found) {
      seen.add(valueKey(f.type, f.value));
      if (f.first === null || f.last === null) continue;
      mark(f.type, f.value, { card: o.card, pivot: o.pivot, role: "found", first: f.first, last: f.last, count: f.count, points: f.points.map((p) => [p[0], p[1]]) });
    }
  }
  const list = [...rows.values()].sort((a, b) => less(a.first, b.first) || less(a.type, b.type) || less(a.value, b.value));
  let from: string | null = null;
  let to: string | null = null;
  if (list.length > 0) {
    from = list.reduce((m, r) => (r.first < m ? r.first : m), list[0]!.first);
    to = list.reduce((m, r) => (r.last > m ? r.last : m), list[0]!.last);
    if (window.from !== null && window.from < from) from = window.from;
    if (window.to !== null && window.to > to) to = window.to;
  }
  let untimed = 0;
  for (const k of seen) if (!rows.has(k)) untimed++;
  return { rows: list, from, to, window, untimed, unread, legacy };
}
