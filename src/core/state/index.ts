import type { Entry } from "../types";
import { apply } from "./apply";
import { initialArchive } from "./archive";
import { initialBuilder } from "./builder";
import { initialImprove } from "./improve";
import { initialLoop } from "./loops";
import { initialMemory } from "./memory";
import type { CaseState, IdKind } from "./types";

export { apply, applyCase, countedKind, REDUCERS } from "./apply";
export type { Reducer } from "./apply";
export { applyArchive, initialArchive, unloadDue } from "./archive";
export { applyBuilder, builderMarking, builderOpen, initialBuilder } from "./builder";
export { applyLoops, depthOf, initialLoop, loopOf, subloopKey } from "./loops";
export { applyMemory, CASE_TYPE_ID, initialMemory, LESSON_ID, liveNotes, NOTE_CARDS_MAX, NOTE_TEXT_MAX } from "./memory";
export { applyRun, runUsage, stageFinishedCounts, subgoalAnswered } from "./run";
export { applyAnalysis, blockers, latestDraft, notedExceptions, openMustAddress, proposalMarking, publishable } from "./analysis";
export { applyCards, cardLocation } from "./cards";
export * from "./improve";
export { applyPlaybooks } from "./playbooks";
export { applyConflicts, holds, keepText, namesFinding, revisedRulingReason, ruledFindings, rulingText, runConflicts } from "./conflicts";
export { CARD_REF, cardRefs } from "./cites";
export {
  activeOverrules, applyPerson, BASIS_TEXT, gateChanges, holdsOverrule, isPersonCard, openQuestions, overruleReason, overruleSays, overruleText, PERSON_SOURCE,
  reopensOverrule, runQuestions, unheld, waitingOn,
} from "./person";
export type { GateChange } from "./person";
export { cardFields, caseFields, isCard, isCardOrigin, isCaseCreated, isCoverage, isExtractedValue, isObservable, isObserved, isPersonStatement, isTimeWindow } from "./shapes";
export * from "./observed";
export * from "./types";

export function initial(): CaseState {
  const counters = {} as Record<IdKind, number>;
  for (const k of ["card", "lane", "query", "job", "proposal", "challenge", "request", "call", "turn", "run", "plan", "conflict", "question", "change", "probe", "memory"] as const) counters[k] = 0;
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
    questions: {},
    overrules: {},
    playbooks: {},
    published: [],
    feedback: [],
    conversation: [],
    agent_usage: { usage: { input: 0, output: 0, reasoning: 0 }, calls: 0 },
    archive: initialArchive(),
    loop: initialLoop(),
    builder: initialBuilder(),
    memory: initialMemory(),
    answers: {},
    improve: initialImprove(),
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
