import type { Entry } from "../core/types";

export interface Changed { cards: string[]; lanes: string[]; stages: string[] }

const text = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null);
const obj = (x: unknown): Record<string, unknown> => (typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const add = (list: string[], x: string | null): void => { if (x !== null && !list.includes(x)) list.push(x); };

/** What an entry touched, for the highlight: the card and lane ids its payload names, and its stage. Reads loosely: nothing here throws for an odd payload. */
export function changedBy(entry: Entry): Changed {
  const p = obj(entry.payload);
  const out: Changed = { cards: [], lanes: [], stages: [] };
  add(out.cards, text(p.card) ?? text(obj(p.card).id));
  add(out.lanes, text(p.lane));
  add(out.stages, text(p.stage));
  if (entry.type === "stage.sent_back") { add(out.stages, text(p.from)); add(out.stages, text(p.to)); }
  if (out.stages.length === 0 && (entry.type.startsWith("stage.") || entry.type.startsWith("gate."))) add(out.stages, entry.stage);
  return out;
}

export interface ReplayFilter { actor: string | null; type: string | null; stage: string | null }

export function matches(entry: Entry, filter: ReplayFilter): boolean {
  return (filter.actor === null || entry.actor.id === filter.actor)
    && (filter.type === null || entry.type === filter.type)
    && (filter.stage === null || entry.stage === filter.stage);
}

/** The seq of the first entry after (dir 1) or before (dir -1) `from` that `pass` accepts, or null at the end. */
export function seek(entries: readonly Entry[], from: number, dir: 1 | -1, pass: (e: Entry) => boolean): number | null {
  for (let i = dir === 1 ? Math.max(from, 0) : Math.min(from, entries.length + 1) - 2; i >= 0 && i < entries.length; i += dir) {
    if (pass(entries[i]!)) return entries[i]!.seq;
  }
  return null;
}

/** The seq of the next (dir 1) or previous (dir -1) entry that passes the filter, or null at the end. */
export function step(entries: readonly Entry[], from: number, dir: 1 | -1, filter: ReplayFilter): number | null {
  return seek(entries, from, dir, (e) => matches(e, filter));
}

const BOUNDARIES = new Set(["stage.started", "stage.finished", "gate.waiting", "gate.passed"]);
/** True for the entries that open or close a stage or sit at a gate. */
export const isBoundary = (e: Entry): boolean => BOUNDARIES.has(e.type);
