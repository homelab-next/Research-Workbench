import type { CaseSession } from "../core/session";
import type { Actor, Observable, TimeWindow } from "../core/types";
import type { Bound } from "./connectors";
import type { Observables } from "./observables";
import type { PivotManifest } from "./registry";
import { runQuery } from "./runner";
import type { RunnerDeps, RunQueryResult } from "./runner";

export class PivotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PivotError";
  }
}

/** The pivot's query template with the value to bind. Throws PivotError unless the value is of the pivot's `from` type. */
export function bindPivot(pivot: PivotManifest, value: string, observables: Observables): { text: string; bound: Bound } {
  if (!observables.matches(pivot.from, value)) throw new PivotError(`pivot ${pivot.id} takes a ${pivot.from}; the value given is not one`);
  return { text: pivot.query, bound: { value } };
}

export interface PivotInput {
  pivot: string; value: string; window: TimeWindow; why: string; actor: Actor;
  step?: string | null; subgoal?: string | null; budget?: number | null; run?: string | null; stage?: string | null; job?: string | null;
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
    run: input.run ?? null, stage: input.stage ?? null, job: input.job ?? null,
  });
}

/**
 * Distinct values of the pivot's `to` type in a finished result. Only the columns the pivot's `yields` maps to that type are read
 * (the registry refuses a pivot with none). Nulls, non-strings and values that fail the type's pattern are dropped.
 */
export function yielded(pivot: PivotManifest, result: RunQueryResult, observables: Observables): Observable[] {
  if (result.status !== "done") return [];
  const named = result.columns.map((c, i) => ({ c, i })).filter(({ c }) => Object.hasOwn(pivot.yields, c) && pivot.yields[c] === pivot.to);
  const cols = named.map((x) => x.i);
  const seen = new Set<string>();
  const out: Observable[] = [];
  for (const row of result.data) {
    for (const i of cols) {
      const v = row[i];
      if (typeof v !== "string" || seen.has(v) || !observables.matches(pivot.to, v)) continue;
      seen.add(v);
      out.push({ type: pivot.to, value: v });
    }
  }
  return out;
}
