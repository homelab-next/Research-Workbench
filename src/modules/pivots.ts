import type { CaseSession } from "../core/session";
import type { Actor, Observable, TimeWindow } from "../core/types";
import type { Bound } from "./connectors";
import type { Observables } from "./observables";
import type { PivotManifest } from "./registry";
import { runQuery } from "./runner";
import { bindPivot, PivotError, yielded as yieldedOf } from "pivot/plan/pivots";
import type { RunnerDeps, RunQueryResult } from "./runner";

// bindPivot and PivotError are pivot's; runPivot stays here, where it calls the runner.
export { bindPivot, PivotError } from "pivot/plan/pivots";

export interface PivotInput {
  pivot: string; value: string; window: TimeWindow; why: string; actor: Actor;
  step?: string | null; subgoal?: string | null; budget?: number | null; run?: string | null; stage?: string | null; job?: string | null;
  /** Set by the playbook runner: the query is issued with purpose "playbook". */
  purpose?: "playbook";
}

/** Runs one pivot on one value through the runner. An unknown pivot or a value of the wrong type is refused, not thrown. */
export async function runPivot(session: CaseSession, deps: RunnerDeps, input: PivotInput): Promise<RunQueryResult> {
  const pivot = deps.registry.pivot(input.pivot);
  if (pivot === null) return { status: "refused", reasons: [`unknown pivot: ${input.pivot}`] };
  let bound: { text: string; bound: Bound };
  try {
    bound = bindPivot(pivot, input.value, deps.observables);
  } catch (err) {
    if (err instanceof PivotError) return { status: "refused", reasons: [err.message] };
    throw err;
  }
  return runQuery(session, deps, {
    source: pivot.source, text: bound.text, bound: bound.bound, window: input.window, why: input.why, actor: input.actor, pivot,
    step: input.step ?? null, subgoal: input.subgoal ?? null, budget: input.budget ?? null,
    run: input.run ?? null, stage: input.stage ?? null, job: input.job ?? null, ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
  });
}

/**
 * Distinct values of the pivot's `to` type in a finished result. Only the columns the pivot's `yields` maps to that type are read
 * (the registry refuses a pivot with none). Nulls, non-strings and values that fail the type's pattern are dropped.
 */
export function yielded(pivot: PivotManifest, result: RunQueryResult, observables: Observables): Observable[] {
  return result.status !== "done" ? [] : yieldedOf(pivot, result.columns, result.data, observables);
}
