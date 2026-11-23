import type { Entry } from "../types";
import { apply } from "./apply";
import type { CaseState, IdKind } from "./types";

export { apply } from "./apply";
export { applyAnalysis, blockers, latestDraft, publishable } from "./analysis";
export { cardLocation } from "./cards";
export { cardFields, caseFields, isCard, isCaseCreated, isCoverage, isObservable, isTimeWindow } from "./shapes";
export * from "./types";

export function initial(): CaseState {
  const counters = {} as Record<IdKind, number>;
  for (const k of ["card", "lane", "query", "job", "proposal", "challenge", "request", "call", "turn", "run", "plan"] as const) counters[k] = 0;
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
    run: {
      id: null, status: "none", outcome: null, pause_reason: null, waiting: null, stages: [], current: null,
      sendbacks: {}, usage: { input: 0, output: 0, reasoning: 0 }, model_calls: 0, budget_tokens: null,
    },
    plan: { current: null, status: "none", accepted_steps: [], budgets: {}, steps: {} },
    jobs: {},
    queries: {},
    proposals: {},
    drafts: [],
    reviews: {},
    challenges: {},
    published: [],
    feedback: [],
    conversation: [],
  };
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
