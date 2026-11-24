import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import type { CaseState } from "../core/state";
import type { Actor, EntryInput } from "../core/types";

/** A triage command the ledger would accept but the case's state makes no sense of; nothing is written. */
export class TriageRefused extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "TriageRefused";
  }
}

type S = Readonly<CaseState>;
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

function cardOf(state: S, card: string) {
  const c = own(state.cards, card);
  if (c === undefined) throw new TriageRefused(`there is no card ${card}`);
  return c;
}
function laneOf(state: S, lane: string) {
  const l = state.lanes.find((x) => x.id === lane);
  if (l === undefined) throw new TriageRefused(`there is no lane ${lane}`);
  return l;
}
function slot(index: number | null | undefined): number | null {
  if (index === null || index === undefined) return null;
  if (!Number.isInteger(index) || index < 0) throw new TriageRefused("the position must be a whole number, zero or more");
  return index;
}
function titleOf(title: string): string {
  const t = typeof title === "string" ? title.trim() : "";
  if (t.length < 1 || t.length > 80) throw new TriageRefused("a lane title must be 1 to 80 characters");
  return t;
}

export function keepCard(session: CaseSession, actor: Actor, input: { card: string; lane?: string; index?: number | null }): void {
  session.commit((state, ids) => {
    const c = cardOf(state, input.card);
    if (c.place === "lane") throw new TriageRefused(`card ${input.card} is already kept`);
    if (c.place === "discarded") throw new TriageRefused(`card ${input.card} is discarded; restore it first`);
    const index = slot(input.index);
    const out: EntryInput[] = [];
    let lane: string;
    if (input.lane !== undefined) lane = laneOf(state, input.lane).id;
    else if (state.lanes.length === 0) {
      lane = ids.next("lane");
      out.push({ type: "lane.created", actor, payload: { lane, title: "Kept", subgoal: null } });
    } else if (state.target !== null) lane = laneOf(state, state.target).id;
    else throw new TriageRefused("the case has no target lane; choose one");
    out.push({ type: "card.kept", actor, payload: { card: input.card, lane, index } });
    return out;
  });
}

export function moveCard(session: CaseSession, actor: Actor, input: { card: string; lane: string; index: number }): void {
  session.commit((state) => {
    const c = cardOf(state, input.card);
    if (c.place !== "lane") throw new TriageRefused(`card ${input.card} is not in a lane`);
    laneOf(state, input.lane);
    const index = slot(input.index);
    if (index === null) throw new TriageRefused("the position must be a whole number, zero or more");
    return [{ type: "card.moved", actor, payload: { card: input.card, lane: input.lane, index } }];
  });
}

export function discardCard(session: CaseSession, actor: Actor, card: string): void {
  session.commit((state) => {
    if (cardOf(state, card).place === "discarded") throw new TriageRefused(`card ${card} is already discarded`);
    return [{ type: "card.discarded", actor, payload: { card } }];
  });
}

export function restoreCard(session: CaseSession, actor: Actor, card: string): void {
  session.commit((state) => {
    if (cardOf(state, card).place !== "discarded") throw new TriageRefused(`card ${card} is not discarded`);
    return [{ type: "card.restored", actor, payload: { card } }];
  });
}

export function sendBackCard(session: CaseSession, actor: Actor, card: string): void {
  session.commit((state) => {
    if (cardOf(state, card).place !== "lane") throw new TriageRefused(`card ${card} is not in a lane`);
    return [{ type: "card.sent_back", actor, payload: { card } }];
  });
}

export function pinCard(session: CaseSession, actor: Actor, card: string, pinned: boolean): void {
  session.commit((state) => {
    cardOf(state, card);
    return [{ type: "card.pinned", actor, payload: { card, pinned } }];
  });
}

/** Returns the new lane's id. */
export function addLane(session: CaseSession, actor: Actor, title: string): string {
  let made = "";
  session.commit((_state, ids) => {
    const t = titleOf(title);
    made = ids.next("lane");
    return [{ type: "lane.created", actor, payload: { lane: made, title: t, subgoal: null } }];
  });
  return made;
}

export function renameLane(session: CaseSession, actor: Actor, lane: string, title: string): void {
  session.commit((state) => {
    laneOf(state, lane);
    return [{ type: "lane.renamed", actor, payload: { lane, title: titleOf(title) } }];
  });
}

export function removeLane(session: CaseSession, actor: Actor, lane: string): void {
  session.commit((state) => {
    const l = laneOf(state, lane);
    if (l.cards.length > 0) throw new TriageRefused(`lane ${l.title} still holds ${l.cards.length} cards`);
    return [{ type: "lane.removed", actor, payload: { lane } }];
  });
}

export function setTarget(session: CaseSession, actor: Actor, lane: string): void {
  session.commit((state) => {
    laneOf(state, lane);
    return [{ type: "lane.target_set", actor, payload: { lane } }];
  });
}

/** Undoes the newest undoable move a person made since the last gate, or the one at `target` (a seq). A system entry, or one from before a gate, cannot be undone. */
export function undo(session: CaseSession, actor: Actor, target?: number): void {
  session.commit((state) => {
    let gate = 0;
    // a publish writes its own card.kept entries after gate.passed and before product.published, in the approver's name: they are the gate's, not the person's
    for (const e of session.entries(0)) if (e.type === "gate.passed" || e.type === "product.published") gate = e.seq;
    const mine = (seq: number): boolean => seq > gate && session.entries(seq - 1, 1)[0]?.actor.kind === "human";
    const item = target === undefined
      ? [...state.undoable].reverse().find((u) => mine(u.seq))
      : state.undoable.find((u) => u.seq === target);
    if (item === undefined) throw new TriageRefused("nothing to undo");
    if (!mine(item.seq)) throw new TriageRefused("that action can no longer be undone");
    return [{ type: "undo", actor, payload: { target: item.seq, card: item.card, place: item.place, lane: item.lane, index: item.index } }];
  });
}
