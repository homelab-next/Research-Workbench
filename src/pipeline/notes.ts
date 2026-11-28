// The notebook (slice 13): short notes an agent or a person writes into a case for the stages and runs after them. A note is an entry of the
// case's own ledger (memory.noted, memory.revised, memory.dropped); it is never evidence and is never cited.
import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import { liveNotes, NOTE_CARDS_MAX, NOTE_TEXT_MAX } from "../core/state";
import type { CaseState } from "../core/state";
import type { Actor, NoteKind } from "../core/types";

export class NoteRefused extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "NoteRefused";
  }
}

export const DEFAULT_MAX_NOTES = 40;

type Link = { run: string | null; stage: string | null; job: string | null };
const NO_LINK: Link = { run: null, stage: null, job: null };

/** A note's text as compared for a repeat. */
const trimmed = (t: string): string => t.trim();

function checkBody(state: Readonly<CaseState>, text: string, cards: readonly string[]): void {
  if (text.trim() === "") throw new NoteRefused("a note needs text");
  if (text.length > NOTE_TEXT_MAX) throw new NoteRefused(`a note is at most ${NOTE_TEXT_MAX} characters`);
  if (cards.length > NOTE_CARDS_MAX) throw new NoteRefused(`a note names at most ${NOTE_CARDS_MAX} cards`);
  for (const c of cards) if (!Object.hasOwn(state.cards, c)) throw new NoteRefused(`unknown card: ${c}`);
}

/** The note `item` names, in the notebook; throws when there is none or it was dropped. */
function held(state: Readonly<CaseState>, item: string): void {
  if (!Object.hasOwn(state.memory.notes, item)) throw new NoteRefused(`there is no note ${item}`);
  if (state.memory.notes[item]!.dropped !== null) throw new NoteRefused(`note ${item} was dropped`);
}

/** Adds a note by an agent or a person; returns its id. Throws NoteRefused, writing nothing. */
export function noteMemory(session: CaseSession, input: { kind: NoteKind; text: string; cards?: string[]; actor: Actor; link?: Link; max_notes?: number }): string {
  if (input.actor.kind === "system") throw new NoteRefused("a note is written by an agent or a person");
  const cards = input.cards ?? [];
  const max = input.max_notes ?? DEFAULT_MAX_NOTES;
  const link = input.link ?? NO_LINK;
  let id = "";
  // the checks and the append in one builder, so two agents noting at once cannot pass the cap or repeat each other
  session.commit((state, ids) => {
    checkBody(state, input.text, cards);
    const live = liveNotes(state);
    if (live.length >= max) throw new NoteRefused(`the notebook holds ${live.length} notes, the most it may; a person may drop one`);
    const repeat = live.find((n) => trimmed(n.text) === trimmed(input.text));
    if (repeat !== undefined) throw new NoteRefused(`that note is already in the notebook (${repeat.id})`);
    id = ids.next("memory");
    return [{ type: "memory.noted", actor: input.actor, ...link, payload: { item: id, kind: input.kind, text: input.text, cards: [...cards] } }];
  });
  return id;
}

/** A person changes a note's kind, text and cards; its author stays. Throws NoteRefused, writing nothing. */
export function reviseMemory(session: CaseSession, input: { item: string; kind: NoteKind; text: string; cards?: string[]; actor: Actor }): void {
  if (input.actor.kind !== "human") throw new NoteRefused("only a person revises a note");
  const cards = input.cards ?? [];
  session.commit((state) => {
    held(state, input.item);
    checkBody(state, input.text, cards);
    return [{ type: "memory.revised", actor: input.actor, payload: { item: input.item, kind: input.kind, text: input.text, cards: [...cards] } }];
  });
}

/** A person takes a note out of the notebook, with the reason. Throws NoteRefused, writing nothing. */
export function dropMemory(session: CaseSession, input: { item: string; reason: string; actor: Actor }): void {
  if (input.actor.kind !== "human") throw new NoteRefused("only a person drops a note");
  session.commit((state) => {
    held(state, input.item);
    if (input.reason.trim() === "") throw new NoteRefused("dropping a note needs a reason");
    return [{ type: "memory.dropped", actor: input.actor, payload: { item: input.item, reason: input.reason } }];
  });
}
