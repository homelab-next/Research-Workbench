import type { Entry } from "../types";
import { applyAnalysis } from "./analysis";
import { applyCards } from "./cards";
import { isObj, isStr, malformed, recordSkip } from "./guards";
import { applyRun } from "./run";
import { caseFields, isCaseCreated } from "./shapes";
import type { CaseState, IdKind } from "./types";

export type Reducer = (state: CaseState, entry: Entry) => CaseState;

/** Which counter an entry type advances: the creating entries of each id kind. */
const COUNTED: Partial<Record<Entry["type"], IdKind>> = {
  "card.created": "card",
  "lane.created": "lane",
  "query.issued": "query",
  "job.started": "job",
  "proposal.created": "proposal",
  "challenge.raised": "challenge",
  "model.request": "request",
  "tool.called": "call",
  "agent.asked": "turn",
  "run.started": "run",
  "plan.proposed": "plan",
};

/** The id kind an entry of this type creates, if any. */
export function countedKind(type: string): IdKind | undefined {
  return Object.hasOwn(COUNTED, type) ? COUNTED[type as Entry["type"]] : undefined;
}

/** The case itself: case.created and case.phase_changed. */
export function applyCase(s: CaseState, entry: Entry): CaseState {
  if (entry.type === "case.created") return isCaseCreated(entry.payload) ? { ...s, meta: caseFields(entry.payload) } : malformed(s, entry);
  if (entry.type === "case.phase_changed") return isStr(entry.payload.phase) ? { ...s, phase: entry.payload.phase } : malformed(s, entry);
  return s;
}

/** One reducer per area; each takes the state and the entry and returns a state. Add new areas here. */
export const REDUCERS: readonly Reducer[] = [applyCase, applyCards, applyRun, applyAnalysis];

/** Leaves everything as it was except seq, head_ts and the record of what was skipped. */
function skip(state: CaseState, entry: Entry, reason: string): CaseState {
  return recordSkip({ ...state, seq: entry.seq, head_ts: entry.ts }, entry, reason);
}

/** `apply` with an explicit reducer list; exists so tests can inject a failing reducer. */
export function applyWith(state: CaseState, entry: Entry, reducers: readonly Reducer[]): CaseState {
  // Not an entry at all: there is no seq to advance to, so nothing changes. The fold never throws.
  if (!isObj(entry)) return state;
  if (!isObj(entry.payload)) return skip(state, entry, "malformed payload");
  try {
    let next: CaseState = { ...state, seq: entry.seq, head_ts: entry.ts };
    const kind = countedKind(entry.type);
    if (kind) next.counters = { ...state.counters, [kind]: state.counters[kind] + 1 };
    for (const reduce of reducers) next = reduce(next, entry);
    return next;
  } catch (err) {
    return skip(state, entry, `could not be applied: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function apply(state: CaseState, entry: Entry): CaseState {
  return applyWith(state, entry, REDUCERS);
}
