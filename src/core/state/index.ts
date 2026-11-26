import type { Entry } from "../types";
import { apply } from "./apply";
import type { CaseState, IdKind } from "./types";

export { apply, applyCase, countedKind, REDUCERS } from "./apply";
export type { Reducer } from "./apply";
export { applyRun, runUsage, stageFinishedCounts, subgoalAnswered } from "./run";
export { applyAnalysis, blockers, latestDraft, notedExceptions, openMustAddress, proposalMarking, publishable } from "./analysis";
export { applyCards, cardLocation } from "./cards";
export { applyPlaybooks } from "./playbooks";
export { applyConflicts, keepText, namesFinding, ruledFindings, rulingText, runConflicts } from "./conflicts";
export { CARD_REF, cardRefs } from "./cites";
export { cardFields, caseFields, isCard, isCaseCreated, isCoverage, isObservable, isObserved, isTimeWindow } from "./shapes";
export * from "./observed";
export * from "./types";

export function initial(): CaseState {
  const counters = {} as Record<IdKind, number>;
  for (const k of ["card", "lane", "query", "job", "proposal", "challenge", "request", "call", "turn", "run", "plan", "conflict"] as const) counters[k] = 0;
  return {
    seq: 0,
    head_ts: null,
    skipped: [],
    meta: null,
    phase: null,
    counters,
    cards: {},
    incoming: [],
    lanes: [],
    target: null,
    discarded: [],
    undoable: [],
    stage_models: {},
    pack_limits: {},
    run: {
      id: null, status: "none", outcome: null, pause_reason: null, waiting: null, stages: [], current: null,
      sendbacks: {}, repeats: {}, sendback_base: {}, sent_back_to: {}, hold: null, usage: { input: 0, output: 0, reasoning: 0 }, model_calls: 0,
      usage_at_start: { input: 0, output: 0, reasoning: 0 }, calls_at_start: 0, budget_tokens: null,
    },
    plan: { current: null, status: "none", accepted_steps: [], budgets: {}, estimates: {}, steps: {} },
    jobs: {},
    queries: {},
    proposals: {},
    drafts: [],
    reviews: {},
    challenges: {},
    made_for: {},
    conflicts: {},
    playbooks: {},
    published: [],
    feedback: [],
    conversation: [],
    agent_usage: { usage: { input: 0, output: 0, reasoning: 0 }, calls: 0 },
  };
}

/**
 * True when `entry` is the one that comes right after `state`. A stream consumer (the session, plan 4's
 * browser store) uses it to notice an entry that was dropped (a jump in seq) or delivered twice, and
 * re-reads from the ledger instead of applying it.
 */
export function isNext(state: Readonly<CaseState>, entry: Entry): boolean {
  return typeof entry === "object" && entry !== null && entry.seq === state.seq + 1;
}

/** Applies entries with `seq <= upTo` (all when omitted), in order. */
export function fold(entries: Entry[], upTo?: number): CaseState {
  let s = initial();
  for (const e of entries) {
    if (upTo !== undefined && e.seq > upTo) break;
    s = apply(s, e);
  }
  return s;
}
