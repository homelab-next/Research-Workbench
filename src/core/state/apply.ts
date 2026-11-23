import type { Entry } from "../types";
import { applyCards } from "./cards";
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
  if (entry.type === "case.created") return { ...s, meta: entry.payload };
  if (entry.type === "case.phase_changed") return { ...s, phase: entry.payload.phase };
  return s;
}

/** One reducer per area; each takes the state and the entry and returns a state. Add new areas here. */
const REDUCERS: readonly Reducer[] = [applyCase, applyCards];

export function apply(state: CaseState, entry: Entry): CaseState {
  let next: CaseState = { ...state, seq: entry.seq, head_ts: entry.ts };
  const kind = COUNTED[entry.type];
  if (kind) next.counters = { ...state.counters, [kind]: state.counters[kind] + 1 };
  for (const reduce of REDUCERS) next = reduce(next, entry);
  return next;
}
