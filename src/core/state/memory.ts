// The fold for memory (slice 13): a case's type, its notebook, and what a run was given from the shared store. Browser-safe: no runtime
// imports but the shared shape checks. The store's own entries (lesson.*) and the workbench chain's (memory.exported, memory.loaded) are not
// a case's: they fall through, as module.loaded does.
import { NOTE_KINDS } from "../types";
import type { Entry, Payloads } from "../types";
import { has, isObj, isOneOf, isStr, isStrList, isStrOrNull, malformed, recordSkip } from "./guards";
import { isRunStartedShape } from "./run";
import { isBlobRefShape, isCount } from "./shapes";
import type { BoundMemory, CaseState, MemoryState, NoteState } from "./types";

export const NOTE_TEXT_MAX = 600;
export const NOTE_CARDS_MAX = 10;
export const CASE_TYPE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const LESSON_ID = /^LESSON-[1-9][0-9]{0,8}$/;

export function initialMemory(): MemoryState {
  return { type: null, type_by: null, proposed_type: null, notes: {}, order: [], pending: null, bound: null };
}

/** The notes still in the notebook, newest first. */
export function liveNotes(state: Readonly<CaseState>): NoteState[] {
  const m = state.memory;
  const out: NoteState[] = [];
  for (let i = m.order.length - 1; i >= 0; i--) {
    const n = m.notes[m.order[i]!];
    if (n !== undefined && n.dropped === null) out.push(n);
  }
  return out;
}

const isCaseType = (x: unknown): x is string => isStr(x) && CASE_TYPE_ID.test(x);
const isItem = (x: unknown): x is string => isStr(x) && x !== "";
const isNoteBody = (x: Record<string, unknown>): boolean =>
  isItem(x.item) && isOneOf(x.kind, NOTE_KINDS) && isStr(x.text) && x.text !== "" && x.text.length <= NOTE_TEXT_MAX
  && isStrList(x.cards) && x.cards.length <= NOTE_CARDS_MAX;

const isTypeSet = (x: unknown): x is Payloads["case.type_set"] => isObj(x) && (x.type === null || isCaseType(x.type));
const isTypeProposed = (x: unknown): x is Payloads["case.type_proposed"] => isObj(x) && isCaseType(x.type) && isStr(x.why);
const isNoted = (x: unknown): x is Payloads["memory.noted"] => isObj(x) && isNoteBody(x);
const isRevised = (x: unknown): x is Payloads["memory.revised"] => isObj(x) && isNoteBody(x);
const isDropped = (x: unknown): x is Payloads["memory.dropped"] => isObj(x) && isItem(x.item) && isStr(x.reason);

const isHead = (x: unknown): x is { seq: number; hash: string } => isObj(x) && isCount(x.seq) && isStr(x.hash);
const isBound = (x: unknown): x is Payloads["memory.bound"] =>
  isObj(x) && isBlobRefShape(x.lock) && isObj(x.store) && isStrOrNull(x.store.origin) && isHead(x.store.head)
  && (x.case_type === null || isCaseType(x.case_type))
  && Array.isArray(x.lessons) && x.lessons.every((l) => isObj(l) && isStr(l.lesson) && LESSON_ID.test(l.lesson) && isStr(l.hash));

/** A run is in progress: started, and not finished. */
const inProgress = (s: CaseState): boolean => s.run.id !== null && s.run.status !== "none" && s.run.status !== "finished";

const withMemory = (s: CaseState, m: Partial<MemoryState>): CaseState => ({ ...s, memory: { ...s.memory, ...m } });

const NOTEBOOK = "a note is revised or dropped while it is in the notebook";
const PERSON_ONLY = "only a person revises or drops a note";

/** The note `item` names, while it is in the notebook; null when there is none or it was dropped. */
function inNotebook(s: CaseState, item: string): NoteState | null {
  const n = has(s.memory.notes, item) ? s.memory.notes[item]! : null;
  return n !== null && n.dropped === null ? n : null;
}

/**
 * case.type_set, case.type_proposed, memory.noted, memory.revised, memory.dropped and memory.bound, and run.started (which moves a pending
 * memory.bound to `bound` when it is the entry right before). Runs before applyRun, so it sees the run as it was before this entry. Nothing
 * here changes the run, the cards, the plan, the loop or the meta.
 */
export function applyMemory(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "case.type_set": {
      const p = entry.payload as unknown;
      if (!isTypeSet(p)) return malformed(s, entry);
      if (entry.actor.kind === "agent") return recordSkip(s, entry, "a case's type is set by a person or the workbench");
      if (entry.actor.kind === "system" && s.run.status !== "none") return recordSkip(s, entry, "the workbench sets a case's type only when the case is made");
      return withMemory(s, { type: p.type, type_by: p.type === null ? null : { actor: entry.actor.id, seq: entry.seq }, proposed_type: null });
    }
    case "case.type_proposed": {
      const p = entry.payload as unknown;
      if (!isTypeProposed(p)) return malformed(s, entry);
      if (entry.actor.kind === "human") return recordSkip(s, entry, "a person sets a case's type; a stage proposes one");
      if (entry.actor.kind === "agent") return recordSkip(s, entry, "a case's type is proposed by the workbench, from a stage's checked output");
      // once the case has a type, a proposal has nothing to propose
      if (s.memory.type !== null) return s;
      return withMemory(s, { proposed_type: { type: p.type, why: p.why, seq: entry.seq } });
    }
    case "memory.noted": {
      const p = entry.payload as unknown;
      if (!isNoted(p)) return malformed(s, entry);
      if (entry.actor.kind === "system") return recordSkip(s, entry, "a note is written by an agent or a person");
      if (has(s.memory.notes, p.item)) return recordSkip(s, entry, "a note's id is used once");
      const note: NoteState = {
        id: p.item, kind: p.kind, text: p.text, cards: [...p.cards], by: entry.actor.kind, author: entry.actor.id,
        stage: entry.actor.kind === "agent" ? entry.actor.stage : null, noted_seq: entry.seq, noted_ts: entry.ts, revised: null, dropped: null,
      };
      // a computed key defines an own property, so an item holding "__proto__" is an ordinary key
      return withMemory(s, { notes: { ...s.memory.notes, [p.item]: note }, order: [...s.memory.order, p.item] });
    }
    case "memory.revised": {
      const p = entry.payload as unknown;
      if (!isRevised(p)) return malformed(s, entry);
      if (entry.actor.kind !== "human") return recordSkip(s, entry, PERSON_ONLY);
      const n = inNotebook(s, p.item);
      if (n === null) return recordSkip(s, entry, NOTEBOOK);
      const revised: NoteState = { ...n, kind: p.kind, text: p.text, cards: [...p.cards], revised: { by: entry.actor.id, seq: entry.seq, ts: entry.ts } };
      return withMemory(s, { notes: { ...s.memory.notes, [n.id]: revised } });
    }
    case "memory.dropped": {
      const p = entry.payload as unknown;
      if (!isDropped(p)) return malformed(s, entry);
      if (entry.actor.kind !== "human") return recordSkip(s, entry, PERSON_ONLY);
      const n = inNotebook(s, p.item);
      if (n === null) return recordSkip(s, entry, NOTEBOOK);
      const dropped: NoteState = { ...n, dropped: { by: entry.actor.id, reason: p.reason, seq: entry.seq, ts: entry.ts } };
      return withMemory(s, { notes: { ...s.memory.notes, [n.id]: dropped } });
    }
    case "memory.bound": {
      const p = entry.payload as unknown;
      if (!isBound(p)) return malformed(s, entry);
      if (entry.actor.kind === "agent") return recordSkip(s, entry, "a run's memory is bound by a person or the workbench");
      const ref = p.lock.media === undefined ? { blob: p.lock.blob, bytes: p.lock.bytes } : { blob: p.lock.blob, bytes: p.lock.bytes, media: p.lock.media };
      const b: BoundMemory = {
        lock: ref, store: { origin: p.store.origin, head: { seq: p.store.head.seq, hash: p.store.head.hash } }, case_type: p.case_type,
        lessons: p.lessons.map((l) => ({ lesson: l.lesson, hash: l.hash })), seq: entry.seq,
      };
      // during a run (a person set the case's type) it is what the stages that start from now on are given; before one, it waits for run.started
      return inProgress(s) ? withMemory(s, { bound: b }) : withMemory(s, { pending: b });
    }
    case "run.started": {
      // a start applyRun refuses as malformed starts no run, and binds nothing
      if (!isRunStartedShape(entry.payload)) return s;
      const pending = s.memory.pending;
      if (pending === null && s.memory.bound === null) return s;
      return withMemory(s, { pending: null, bound: pending !== null && pending.seq === entry.seq - 1 ? pending : null });
    }
    default:
      return s;
  }
}
