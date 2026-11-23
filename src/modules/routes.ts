import type { CaseSession } from "../core/session";
import type { Actor, Observable, TimeWindow } from "../core/types";
import { runPivot, yielded } from "./pivots";
import type { RunnerDeps, RunQueryResult } from "./runner";
import { DEFAULT_LIMITS } from "./seeker";
import type { Hop, Seeker, SeekLimits } from "./seeker";

export interface TrailItem {
  hop: Hop; value: string; status: RunQueryResult["status"]; outcome: string | null; card: string | null; query: string | null; found: string[];
}

export interface RouteInput {
  have: Observable[]; want: string; window: TimeWindow; why: string; actor: Actor; limits?: SeekLimits; subgoal?: string | null;
  max_fanout?: number; run?: string | null; stage?: string | null; job?: string | null;
}
export interface RouteResult { outcome: "answered" | "blocked"; reached: Observable[]; trail: TrailItem[]; cards: string[]; blocked: string[]; caveats: string[] }

/** The most pivot runs one call makes, whatever the routes and values. */
export const MAX_PIVOT_RUNS = 50;

/**
 * Follows the seeker's best route hop by hop. A hop that finds nothing of its target type, is refused, fails or needs a budget
 * blocks its pivot and the run re-routes from what it knows. Never runs a pivot on the same value twice; stops after MAX_PIVOT_RUNS runs.
 * `caveats` says, in plain words, what an answer rests on that a reader should know: partial coverage, unconfirmed sources, the run cap, the fan-out cap.
 */
export async function runRoute(session: CaseSession, deps: RunnerDeps, seeker: Seeker, input: RouteInput): Promise<RouteResult> {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const fanout = Math.max(1, Math.floor(input.max_fanout ?? 5));
  const known = new Map<string, string[]>();
  const add = (o: Observable): boolean => {
    const list = known.get(o.type) ?? [];
    if (list.includes(o.value)) return false;
    list.push(o.value);
    known.set(o.type, list);
    return true;
  };
  for (const o of input.have) add(o);
  const done = new Set<string>();
  const blocked: string[] = [];
  const trail: TrailItem[] = [];
  const caveats: string[] = [];
  const caveat = (text: string): void => { if (!caveats.includes(text)) caveats.push(text); };
  let runs = 0;

  const finish = (): RouteResult => {
    const reached = (known.get(input.want) ?? []).map((value) => ({ type: input.want, value }));
    return { outcome: reached.length > 0 ? "answered" : "blocked", reached, trail, cards: trail.flatMap((t) => (t.card === null ? [] : [t.card])), blocked, caveats };
  };
  const block = (pivot: string): void => { if (!blocked.includes(pivot)) blocked.push(pivot); };

  for (;;) {
    if ((known.get(input.want)?.length ?? 0) > 0) return finish();
    const have = [...known.entries()].filter(([, v]) => v.length > 0).map(([t]) => t);
    const route = seeker.routes(have, input.want, limits, new Set(blocked))[0];
    if (route === undefined) return finish();
    const hop = route.hops.find((h) => (known.get(h.from) ?? []).some((v) => !done.has(`${h.pivot}|${v}`)));
    if (hop === undefined) {
      const last = route.hops[route.hops.length - 1];
      if (last === undefined) return finish();
      block(last.pivot);
      continue;
    }
    const pending = (known.get(hop.from) ?? []).filter((v) => !done.has(`${hop.pivot}|${v}`));
    for (const v of pending) done.add(`${hop.pivot}|${v}`); // values beyond the fan-out cap are never run for this pivot
    let reachedGoal = false;
    let gained = false;
    for (const value of pending.slice(0, fanout)) {
      if (runs >= MAX_PIVOT_RUNS) {
        caveat(`stopped after ${MAX_PIVOT_RUNS} lookups`);
        return finish();
      }
      runs++;
      const r = await runPivot(session, deps, {
        pivot: hop.pivot, value, window: input.window, why: `${input.why} — ${hop.title}`, actor: input.actor,
        subgoal: input.subgoal ?? null, run: input.run ?? null, stage: input.stage ?? null, job: input.job ?? null,
      });
      const pivot = deps.registry.pivot(hop.pivot);
      const found = pivot !== null ? yielded(pivot, r, deps.observables) : [];
      for (const o of found) add(o);
      if (found.length > 0) gained = true;
      if (r.status === "done") {
        if (r.coverage.kind === "partial") caveat(`${hop.pivot}: partial coverage (${r.coverage.reason})`);
        if (!hop.confirmed) caveat(`${hop.pivot}: unconfirmed source ${hop.source}`);
      }
      trail.push({
        hop, value, status: r.status, outcome: r.status === "done" ? r.outcome : null,
        card: r.status === "done" ? r.card : null, query: r.status === "done" || r.status === "failed" ? r.query : null,
        found: found.map((o) => o.value),
      });
      if (r.status === "needs_budget") break; // asking again for the next value would only repeat the request
      if (hop.to === input.want && (known.get(input.want)?.length ?? 0) > 0) {
        reachedGoal = true; // the goal is known; the hop's other values are not worth a lookup
        break;
      }
    }
    if (!reachedGoal && pending.length > fanout) caveat(`${hop.pivot}: ${pending.length - fanout} values not tried (fan-out limit ${fanout})`);
    if (!gained) block(hop.pivot);
  }
}
