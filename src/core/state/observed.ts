// What each card observed, as the lenses read it (design 6b §5.5, §6). Browser-safe: imports nothing outside src/core.
import { MAX_SIGHTINGS } from "../types";
import type { Observed, Sighting } from "../types";
import type { CardState, CaseState } from "./types";

/** A value's key: the key Incoming's "known value" highlight uses. */
export const valueKey = (type: string, value: string): string => `${type}|${value}`;

export type CardObserved = Observed & { card: string; legacy: boolean };

/** The type of the first typed preview cell holding each value, over every card in the order made; cached per state. */
const typedCells = new WeakMap<CaseState, Map<string, string>>();

/** The cards in the order they were made: created_seq, then id. */
function inOrder(state: CaseState): CardState[] {
  return Object.values(state.cards).sort((a, b) => a.created_seq - b.created_seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function cellTypes(state: CaseState): Map<string, string> {
  const known = typedCells.get(state);
  if (known !== undefined) return known;
  const out = new Map<string, string>();
  for (const c of inOrder(state)) {
    for (const row of c.rows) {
      if (!Array.isArray(row)) continue;
      c.column_types.forEach((type, i) => {
        const v: unknown = row[i];
        if (typeof type === "string" && typeof v === "string" && !out.has(v)) out.set(v, type);
      });
    }
  }
  typedCells.set(state, out);
  return out;
}

/** The legacy reading (§5.5): the pivot and value from the card's query, found from the typed preview cells, no times. */
function legacyOf(state: CaseState, card: CardState): CardObserved | null {
  if (card.kind !== "result" || typeof card.query !== "string" || !Object.hasOwn(state.queries, card.query)) return null;
  const q = state.queries[card.query]!;
  if (q.pivot === null || q.value === null) return null;
  const value = q.value;
  const type = state.meta?.starting.find((o) => o.value === value)?.type ?? cellTypes(state).get(value) ?? "unknown";
  const found: Sighting[] = [];
  const seen = new Set<string>();
  let more = 0;
  for (const row of card.rows) {
    if (!Array.isArray(row)) continue;
    card.column_types.forEach((t, i) => {
      const v: unknown = row[i];
      if (typeof t !== "string" || typeof v !== "string" || seen.has(valueKey(t, v))) return;
      seen.add(valueKey(t, v));
      if (found.length >= MAX_SIGHTINGS) more++;
      else found.push({ type: t, value: v, first: null, last: null, count: null, points: [] });
    });
  }
  return { card: card.id, legacy: true, pivot: q.pivot, from: { type, value }, span: { first: null, last: null, count: null }, found, more, unread: 0 };
}

/** What the card observed: its own `observed`, or the legacy reading (design §5.5). Null for a card with neither, and for a discarded card. */
export function cardObserved(state: CaseState, card: CardState): CardObserved | null {
  if (card.place === "discarded") return null;
  if (card.observed !== undefined) return { ...card.observed, card: card.id, legacy: false };
  return legacyOf(state, card);
}

/** cardObserved of every card that has one, in the order the cards were made (created_seq, then id). */
export function allObserved(state: CaseState): CardObserved[] {
  return inOrder(state).flatMap((c) => {
    const o = cardObserved(state, c);
    return o === null ? [] : [o];
  });
}
