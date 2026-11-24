import type { CaseSession } from "../core/session";
import type { Actor } from "../core/types";
import type { Bound } from "./connectors";
import type { PivotManifest } from "./registry";
import { runQuery } from "./runner";
import type { RunnerDeps, RunQueryResult } from "./runner";

export interface RunProposalInput { proposal: string; budget: number; actor: Actor }

/**
 * A person accepts an agent's costly_query proposal with a budget and runs it. Only a person may; the proposal must be
 * open; its pivot (if any) must be unchanged and its source still loaded. Writes proposal.accepted with the budget, then
 * runs the stored text, bound values and window through runQuery, citing the acceptance. A refusal writes nothing.
 */
export async function runProposal(session: CaseSession, deps: RunnerDeps, input: RunProposalInput): Promise<RunQueryResult> {
  const refused = (reason: string): RunQueryResult => ({ status: "refused", reasons: [reason] });
  if (input.actor.kind !== "human") return refused("only a person may accept and run a proposal");
  const p = Object.hasOwn(session.state.proposals, input.proposal) ? session.state.proposals[input.proposal]! : null;
  if (p === null) return refused(`unknown proposal: ${input.proposal}`);
  if (p.kind !== "costly_query") return refused(`proposal ${p.id} is not a costly query`);
  if (p.status !== "open") return refused(`proposal ${p.id} is ${p.status}, not open`);
  if (typeof input.budget !== "number" || !Number.isFinite(input.budget) || input.budget <= 0) return refused("the budget must be a number above zero");
  const source = deps.registry.source(p.source);
  if (source === null) return refused(`the source ${p.source} is no longer loaded`);
  let pivot: PivotManifest | null = null;
  if (p.pivot !== null) {
    pivot = deps.registry.pivot(p.pivot);
    if (pivot === null || pivot.hash !== p.pivot_hash) return refused(`the pivot ${p.pivot} has changed since the proposal`);
    if (pivot.source !== source.id) return refused(`the pivot ${p.pivot} is now for source ${pivot.source}`);
  }
  const accepted = session.commit(() => [{
    type: "proposal.accepted", actor: input.actor, cause: p.seq, payload: { proposal: p.id, budget: input.budget },
  }])[0]!;
  return runQuery(session, deps, {
    source: source.id, text: p.text, bound: { ...p.bound } as Bound, window: { ...p.window }, why: p.why, actor: input.actor, pivot,
    title: p.title, step: p.step, subgoal: p.subgoal, budget: input.budget, cause: accepted.seq,
  });
}
