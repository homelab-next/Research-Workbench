import type { Entry } from "../types";
import { applyCards } from "./cards";
import { applyRun } from "./run";
import type { CaseState, IdKind } from "./types";

export type Reducer = (state: CaseState, entry: Entry) => CaseState;

/** Which counter an entry type advances. */
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

function applyCase(s: CaseState, entry: Entry): CaseState {
  if (entry.type === "case.created") return typeof entry.payload.id === "string" && typeof entry.payload.title === "string" ? { ...s, meta: entry.payload } : s;
  if (entry.type === "case.phase_changed") return typeof entry.payload.phase === "string" ? { ...s, phase: entry.payload.phase } : s;
  return s;
}

/** One reducer per area; each takes the state and the entry and returns a state. Add new areas here. */
export const REDUCERS: readonly Reducer[] = [applyCase, applyCards, applyRun];

const SKIP_LIMIT = 100;
const isRecord = (x: unknown): boolean => typeof x === "object" && x !== null && !Array.isArray(x);

function skip(state: CaseState, entry: Entry, reason: string): CaseState {
  const skipped = [...state.skipped, { seq: entry.seq, type: String(entry.type), reason }].slice(-SKIP_LIMIT);
  return { ...state, seq: entry.seq, head_ts: entry.ts, skipped };
}

/** `apply` with an explicit reducer list; exists so tests can inject a failing reducer. */
export function applyWith(state: CaseState, entry: Entry, reducers: readonly Reducer[]): CaseState {
  if (!isRecord(entry.payload)) return skip(state, entry, "malformed payload");
  try {
    let next: CaseState = { ...state, seq: entry.seq, head_ts: entry.ts };
    const kind = Object.hasOwn(COUNTED, entry.type) ? COUNTED[entry.type] : undefined;
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
