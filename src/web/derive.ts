import { blockers, latestDraft, publishable, runConflicts, subgoalAnswered } from "../core/state";
import type { CardState, CaseState, StageState } from "../core/state";
import type { LensId } from "./app";

export type IncomingSort = "arrived" | "event_time" | "step" | "source" | "started_by" | "status";
export type IncomingGroup = "none" | "step" | "source" | "started_by" | "type";
export interface IncomingView { sort: IncomingSort; reverse: boolean; group: IncomingGroup }
export const SORTS: readonly IncomingSort[] = ["arrived", "event_time", "step", "source", "started_by", "status"];
export const GROUPS: readonly IncomingGroup[] = ["none", "step", "source", "started_by", "type"];

export type CardStatus = "answered" | "partial" | "proven negative" | "nothing found";
/** Partial coverage is never a proven negative: it is "partial" whatever else the card says. */
export function cardStatus(card: CardState): CardStatus {
  if (card.coverage !== null && card.coverage.kind === "partial") return "partial";
  if (card.row_count > 0) return "answered";
  return card.empty === "proven-negative" && card.coverage !== null && card.coverage.kind === "full" ? "proven negative" : "nothing found";
}

/** "Started by" is the actor of the card's query, else whoever made the card. */
export function startedBy(state: CaseState, card: CardState): string {
  const q = card.query !== null && Object.hasOwn(state.queries, card.query) ? state.queries[card.query]! : null;
  return q === null ? card.made_by : q.by.id;
}

function sortKey(state: CaseState, card: CardState, sort: IncomingSort): string | number | null {
  switch (sort) {
    case "arrived": return card.created_seq;
    case "event_time": return card.event_time;
    case "step": return card.step ?? "";
    case "source": return card.source ?? "";
    case "started_by": return startedBy(state, card);
    case "status": return cardStatus(card);
  }
}
const cmp = (a: string | number | null, b: string | number | null): number => {
  if (a === b) return 0;
  if (a === null) return 1;              // nothing sorts last, in either direction of the sort itself
  if (b === null) return -1;
  return a < b ? -1 : 1;
};
function groupOf(state: CaseState, card: CardState, group: IncomingGroup): string | null {
  switch (group) {
    case "none": return null;
    case "step": return card.step ?? "no step";
    case "source": return card.source ?? "no source";
    case "started_by": return startedBy(state, card);
    case "type": return card.kind;
  }
}

/** Incoming in display order: pinned cards first within each group, then by the sort; groups in order of their first card. */
export function orderIncoming(state: CaseState, view: IncomingView): { group: string | null; cards: string[] }[] {
  const cards = state.incoming.flatMap((id, i) => (Object.hasOwn(state.cards, id) ? [{ c: state.cards[id]!, i }] : []));
  const sorted = (list: typeof cards): typeof cards => {
    const out = [...list].sort((a, b) => cmp(sortKey(state, a.c, view.sort), sortKey(state, b.c, view.sort)) || a.i - b.i);
    return view.reverse ? out.reverse() : out;
  };
  const ordered = [...cards.filter((x) => x.c.pinned), ...sorted(cards.filter((x) => !x.c.pinned))];
  const groups = new Map<string | null, string[]>();
  for (const { c } of ordered) {
    const g = groupOf(state, c, view.group);
    const list = groups.get(g);
    if (list === undefined) groups.set(g, [c.id]); else list.push(c.id);
  }
  return [...groups].map(([group, ids]) => ({ group, cards: ids }));
}

/** "<type>|<value>" for every starting value and every typed cell of a kept card. */
export function knownValues(state: CaseState): Set<string> {
  const out = new Set<string>();
  for (const o of state.meta?.starting ?? []) out.add(`${o.type}|${o.value}`);
  for (const lane of state.lanes) {
    for (const id of lane.cards) {
      const c = Object.hasOwn(state.cards, id) ? state.cards[id]! : null;
      if (c === null) continue;
      c.column_types.forEach((type, col) => {
        if (type === null) return;
        for (const row of c.rows) { const v = row[col]; if (v !== undefined && v !== null) out.add(`${type}|${cellText(v)}`); }
      });
    }
  }
  return out;
}

/** A cell as text: strings as they are, null as nothing, anything else as JSON. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export function goals(state: CaseState): { done: number; of: number } {
  const all = state.plan.current?.subgoals ?? [];
  return { done: all.filter((g) => subgoalAnswered(state, g)).length, of: all.length };
}

export type StageMark = "passed" | "passed earlier draft" | "running" | "failed" | "waiting" | "declined" | "blocked" | "idle";
/** A review stage reads "passed" only when it passed the latest draft's hash; a pass on an older draft reads "passed earlier draft". */
export function stageMark(state: CaseState, stage: StageState): StageMark {
  if (stage.status !== "passed") return stage.status;
  const latest = latestDraft(state);
  if (!stage.reviews || latest === null) return "passed";
  const review = Object.hasOwn(state.reviews, latest.hash) ? state.reviews[latest.hash]! : null;
  return review !== null && review.passed_stages.includes(stage.id) ? "passed" : "passed earlier draft";
}

export type NextThing = { label: string; command: "accept_plan" | "approve" | "resume" } | { label: string; lens: LensId };
/** What Shift+Enter does now, with the words its button carries; null when the run waits on nothing a single key should do. */
export function nextThing(state: CaseState): NextThing | null {
  const { run } = state;
  if (unsettled(state)) return { label: "Settle the disagreement", lens: "narrative" };
  if (run.status === "paused" || run.status === "interrupted") return { label: "Resume the run", command: "resume" };
  if (run.status !== "waiting") return null;
  if (run.waiting === "plan" && state.plan.current !== null) {
    const steps = state.plan.current.steps;
    const costly = steps.filter((s) => !s.free).length;
    return costly === 0 ? { label: "Review the plan", command: "accept_plan" } : { label: `Review plan: ${costly} steps need a budget`, lens: "steps" };
  }
  if (run.waiting === "publish") {
    const latest = latestDraft(state);
    if (latest === null) return null;
    return publishable(state, latest.hash)
      ? { label: "Review the draft", command: "approve" }
      : { label: `Review draft: ${blockers(state, latest.hash).length} blockers`, lens: "narrative" };
  }
  return null;
}

/** A disagreement between reviewers the person has not ruled on yet: Resume would only pause again, so the brief sends the person to rule. */
function unsettled(state: CaseState): boolean {
  return (state.run.status === "paused" || state.run.status === "interrupted") && runConflicts(state).some((c) => c.ruling === null);
}

export function runButton(state: CaseState): { label: string; command: "start_run" | "resume" | null; lens: LensId | null; disabled: boolean } {
  const { run } = state;
  if (unsettled(state)) return { label: "Settle the disagreement", command: null, lens: "narrative", disabled: false };
  switch (run.status) {
    case "none": return { label: "Run", command: "start_run", lens: null, disabled: false };
    case "running": return { label: "Running", command: null, lens: null, disabled: true };
    case "paused": case "interrupted": return { label: "Resume", command: "resume", lens: null, disabled: false };
    case "waiting": return run.waiting === "publish"
      ? { label: "Review draft", command: null, lens: "narrative", disabled: false }
      : { label: "Review plan", command: null, lens: "steps", disabled: false };
    case "finished": return { label: "Run again", command: "start_run", lens: null, disabled: false };
  }
}
