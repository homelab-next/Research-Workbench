import { blockers, isPersonCard, latestDraft, publishable, runConflicts, subgoalAnswered } from "../core/state";
import type { CardState, CaseState, StageState } from "../core/state";
import type { LensId } from "./app";

export type IncomingSort = "arrived" | "event_time" | "step" | "source" | "started_by" | "status";
export type IncomingGroup = "none" | "step" | "source" | "started_by" | "type";
export interface IncomingView { sort: IncomingSort; reverse: boolean; group: IncomingGroup }
export const SORTS: readonly IncomingSort[] = ["arrived", "event_time", "step", "source", "started_by", "status"];
export const GROUPS: readonly IncomingGroup[] = ["none", "step", "source", "started_by", "type"];

export type CardStatus = "statement" | "answered" | "partial" | "proven negative" | "nothing found";
/** Partial coverage is never a proven negative: it is "partial" whatever else the card says. */
export function cardStatus(card: CardState): CardStatus {
  if (isPersonCard(card)) return "statement";            // what a person said has no rows by nature: never "nothing found"
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

export type StageMark = "passed" | "passed earlier draft" | "running" | "failed" | "waiting" | "declined" | "blocked" | "idle" | "sent back";

/**
 * The latest draft this stage wrote when a review stage has failed it: the draft's number and the title of the stage that sent it back.
 * Null when the latest draft is not this stage's (an agent's, by stage id), when the stage is running or has ended otherwise, or when no review stage has failed
 * that draft (a review stage that failed an earlier draft and has not yet run on this one has not sent it back).
 */
export function sentBack(state: CaseState, stage: StageState): { draft: number; by: string } | null {
  const latest = latestDraft(state);
  if (latest === null || latest.author.kind !== "agent" || latest.author.stage !== stage.id) return null;
  if (stage.status !== "passed" && stage.status !== "idle") return null;
  const { run } = state;
  const named = Object.hasOwn(run.sent_back_to, stage.id) ? run.stages.find((x) => x.id === run.sent_back_to[stage.id]) : undefined;
  // a review stage's "failed" is from its last finish: it sent this draft back only if that finish was on this draft
  const failedThis = Object.hasOwn(state.reviews, latest.hash) ? state.reviews[latest.hash]!.failed_stages ?? [] : [];
  const from = named ?? run.stages.find((x) => x.reviews && x.status === "failed" && failedThis.includes(x.id));
  return from === undefined ? null : { draft: latest.n, by: from.title };
}

/** A review stage reads "passed" only when it passed the latest draft's hash; a pass on an older draft reads "passed earlier draft". A stage whose draft a review stage failed reads "sent back". */
export function stageMark(state: CaseState, stage: StageState): StageMark {
  if (sentBack(state, stage) !== null) return "sent back";
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
    case "waiting":
      if (run.waiting === "publish") return { label: "Review draft", command: null, lens: "narrative", disabled: false };
      // the adopt gate is decided file by file in the improve case's own view, never by this button
      if (run.waiting === "adopt") return { label: "Waiting at Adopt", command: null, lens: null, disabled: true };
      return { label: "Review plan", command: null, lens: "steps", disabled: false };
    case "finished": return { label: "Run again", command: "start_run", lens: null, disabled: false };
  }
}

/**
 * The brief's two buttons from one list: at a gate the next-thing button stands for the run button; a resume is the run button's alone; and the
 * next-thing button is dropped when its label or its command is the run button's.
 */
export function briefButtons(state: CaseState): { run: ReturnType<typeof runButton> | null; next: NextThing | null } {
  const next0 = nextThing(state);
  const rb = runButton(state);
  if (state.run.status === "waiting" && next0 !== null) return { run: null, next: next0 };
  const same = next0 !== null && (next0.label === rb.label || ("command" in next0 && rb.command !== null && next0.command === rb.command));
  return { run: rb, next: next0 === null || same ? null : next0 };
}
