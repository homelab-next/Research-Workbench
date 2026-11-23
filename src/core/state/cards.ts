import type { Entry, Place } from "../types";
import type { CardState, CaseState, LaneState, UndoItem } from "./types";

const UNDO_LIMIT = 50;
const PLACES: readonly string[] = ["incoming", "lane", "discarded"];

const isStr = (x: unknown): x is string => typeof x === "string";
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const idx = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
/** Own-property lookup, so ids like "constructor" are ordinary keys. */
function cardOf(s: CaseState, id: unknown): CardState | undefined {
  return isStr(id) && Object.hasOwn(s.cards, id) ? s.cards[id] : undefined;
}

interface Dest { place: Place; lane: string | null; index: number | null }

export function cardLocation(state: CaseState, card: string): { place: Place; lane: string | null; index: number } | null {
  const c = cardOf(state, card);
  if (!c) return null;
  const list =
    c.place === "incoming" ? state.incoming
    : c.place === "discarded" ? state.discarded
    : state.lanes.find((l) => l.id === c.lane)?.cards;
  if (!list) return null;
  const index = list.indexOf(card);
  return index < 0 ? null : { place: c.place, lane: c.place === "lane" ? c.lane : null, index };
}

function insertAt(list: string[], id: string, index: number | null): string[] {
  const at = index === null ? list.length : Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, at), id, ...list.slice(at)];
}

/** Moves an existing card to `dest`, copying only the lists it touches. A lane that is gone sends the card to Incoming. */
function relocate(s: CaseState, id: string, dest: Dest): CaseState {
  const c = cardOf(s, id);
  if (!c) return s;
  let { incoming, discarded, lanes } = s;
  if (c.place === "incoming") incoming = incoming.filter((x) => x !== id);
  else if (c.place === "discarded") discarded = discarded.filter((x) => x !== id);
  else lanes = lanes.map((l) => (l.id === c.lane ? { ...l, cards: l.cards.filter((x) => x !== id) } : l));

  let place = dest.place;
  let lane: string | null = place === "lane" ? dest.lane : null;
  if (place === "lane" && !lanes.some((l) => l.id === lane)) { place = "incoming"; lane = null; }

  if (place === "incoming") incoming = insertAt(incoming, id, dest.index);
  else if (place === "discarded") discarded = insertAt(discarded, id, dest.index);
  else lanes = lanes.map((l) => (l.id === lane ? { ...l, cards: insertAt(l.cards, id, dest.index) } : l));

  const next: CardState = { ...c, place, lane };
  return { ...s, cards: { ...s.cards, [id]: next }, incoming, discarded, lanes };
}

/** Records where the card is now, so an undo can put it back, then applies `change`. */
function undoable(s: CaseState, seq: number, id: string, change: (s: CaseState) => CaseState): CaseState {
  const loc = cardLocation(s, id);
  if (!loc) return s;
  const item: UndoItem = { seq, card: id, place: loc.place, lane: loc.lane, index: loc.index };
  const moved = change(s);
  if (moved === s) return s;
  return { ...moved, undoable: [...s.undoable, item].slice(-UNDO_LIMIT) };
}

const hasLane = (s: CaseState, lane: unknown) => isStr(lane) && s.lanes.some((l) => l.id === lane);

export function applyCards(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "card.created": {
      const c = entry.payload.card;
      if (!isObj(c) || !isStr(c.id) || Object.hasOwn(s.cards, c.id)) return s;
      const state: CardState = {
        ...c, place: "incoming", lane: null, pinned: false,
        created_seq: entry.seq, created_ts: entry.ts, validated: null,
      };
      return { ...s, cards: { ...s.cards, [c.id]: state }, incoming: [...s.incoming, c.id] };
    }
    case "card.kept": {
      const { card, lane } = entry.payload;
      if (!cardOf(s, card) || !hasLane(s, lane)) return s;
      const index = idx(entry.payload.index);
      return undoable(s, entry.seq, card, (x) => relocate(x, card, { place: "lane", lane, index }));
    }
    case "card.moved": {
      const { card, lane } = entry.payload;
      if (!cardOf(s, card) || !hasLane(s, lane)) return s;
      const index = idx(entry.payload.index);
      return undoable(s, entry.seq, card, (x) => relocate(x, card, { place: "lane", lane, index }));
    }
    case "card.discarded": {
      const { card } = entry.payload;
      const place = cardOf(s, card)?.place;
      if (!place || place === "discarded") return s;
      return undoable(s, entry.seq, card, (x) => relocate(x, card, { place: "discarded", lane: null, index: null }));
    }
    case "card.restored": {
      const { card } = entry.payload;
      if (cardOf(s, card)?.place !== "discarded") return s;
      return relocate(s, card, { place: "incoming", lane: null, index: null });
    }
    case "card.sent_back": {
      const { card } = entry.payload;
      if (cardOf(s, card)?.place !== "lane") return s;
      return undoable(s, entry.seq, card, (x) => relocate(x, card, { place: "incoming", lane: null, index: null }));
    }
    case "card.pinned": {
      const { card, pinned } = entry.payload;
      const c = cardOf(s, card);
      if (!c || typeof pinned !== "boolean") return s;
      return { ...s, cards: { ...s.cards, [card]: { ...c, pinned } } };
    }
    case "lane.created": {
      const { lane, title, subgoal } = entry.payload;
      if (!isStr(lane) || !isStr(title) || !(subgoal === null || isStr(subgoal)) || hasLane(s, lane)) return s;
      const l: LaneState = { id: lane, title, subgoal, cards: [] };
      return { ...s, lanes: [...s.lanes, l], target: s.target ?? lane };
    }
    case "lane.renamed": {
      const { lane, title } = entry.payload;
      if (!hasLane(s, lane) || !isStr(title)) return s;
      return { ...s, lanes: s.lanes.map((l) => (l.id === lane ? { ...l, title } : l)) };
    }
    case "lane.removed": {
      const { lane } = entry.payload;
      const gone = s.lanes.find((l) => l.id === lane);
      if (!gone) return s;
      const lanes = s.lanes.filter((l) => l.id !== lane);
      const back = gone.cards.flatMap((id): [string, CardState][] => {
        const c = cardOf(s, id);
        return c ? [[id, { ...c, place: "incoming", lane: null }]] : [];
      });
      const cards = { ...s.cards, ...Object.fromEntries(back) };
      return {
        ...s, lanes, cards, incoming: [...s.incoming, ...gone.cards],
        target: s.target === lane ? (lanes[0]?.id ?? null) : s.target,
      };
    }
    case "lane.target_set": {
      const { lane } = entry.payload;
      if (!hasLane(s, lane) || s.target === lane) return s;
      return { ...s, target: lane };
    }
    case "undo": {
      const { target, card, place, lane } = entry.payload;
      if (!cardOf(s, card) || !isStr(place) || !PLACES.includes(place) || !(lane === null || isStr(lane))) return s;
      const moved = relocate(s, card, { place, lane, index: idx(entry.payload.index) });
      return { ...moved, undoable: moved.undoable.filter((u) => u.seq !== target) };
    }
    default:
      return s;
  }
}
