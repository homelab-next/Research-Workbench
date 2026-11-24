import type { CaseSession } from "../core/session";
import type { Actor, Cost, Observable, TimeWindow } from "../core/types";
import { runPivot, yielded } from "./pivots";
import type { RunnerDeps, RunQueryResult } from "./runner";
import { DEFAULT_LIMITS } from "./seeker";
import type { Hop, Seeker, SeekLimits } from "./seeker";

/** One pivot run on one value. `proposal` and `estimate` are set when the hop needs a budget (the proposal is an agent's). */
export interface TrailItem {
  hop: Hop; value: string; status: RunQueryResult["status"]; outcome: string | null; card: string | null; query: string | null; found: string[];
  proposal: string | null; estimate: Cost | null;
}

export interface RouteInput {
  have: Observable[]; want: string; window: TimeWindow; why: string; actor: Actor; limits?: SeekLimits; subgoal?: string | null;
  max_fanout?: number; run?: string | null; stage?: string | null; job?: string | null;
}
export interface RouteResult { outcome: "answered" | "blocked"; reached: Observable[]; trail: TrailItem[]; cards: string[]; blocked: string[]; caveats: string[] }

/** The most pivot runs one call makes, whatever the routes and values. */
export const MAX_PIVOT_RUNS = 50;

/**
 * Follows the seeker's routes hop by hop until it learns a value of `want` it was not given. Each pass walks the
 * seeker's routes in order and runs the first hop that has a value not yet tried with it, up to the fan-out limit.
 * A lookup marks only that pivot and value as done, whatever it returned. A route with no such hop has run dry: the
 * pivot that ran dry (the hop before the first one with nothing to start from, or the last hop) is blocked, and stays
 * blocked only while it has no untried value. Routes around blocked pivots are walked first, then routes through
 * them, so a hop ahead of a blocked pivot can still find the values that open it again. Stops when no route has
 * anything left to try, or after MAX_PIVOT_RUNS runs.
 * `reached` holds values of `want` that were found, never the ones given in `have`. `caveats` says, in plain words,
 * what an answer rests on that a reader should know: partial coverage, unconfirmed sources, costly hops waiting for a
 * budget, the run cap, the fan-out cap, and values left unfollowed once the goal was reached.
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
  const given = new Set<string>();
  for (const o of input.have) {
    add(o);
    if (o.type === input.want) given.add(o.value);
  }
  const done = new Set<string>();
  const blocked: string[] = [];
  const trail: TrailItem[] = [];
  const caveats: string[] = [];
  const caveat = (text: string): void => { if (!caveats.includes(text)) caveats.push(text); };
  let runs = 0;

  const reachedValues = (): string[] => (known.get(input.want) ?? []).filter((v) => !given.has(v));
  const untried = (h: Hop): string[] => (known.get(h.from) ?? []).filter((v) => !done.has(`${h.pivot}|${v}`));
  const finish = (): RouteResult => {
    const reached = reachedValues().map((value) => ({ type: input.want, value }));
    return { outcome: reached.length > 0 ? "answered" : "blocked", reached, trail, cards: trail.flatMap((t) => (t.card === null ? [] : [t.card])), blocked, caveats };
  };
  const block = (pivot: string): boolean => {
    if (blocked.includes(pivot)) return false;
    blocked.push(pivot);
    return true;
  };

  for (;;) {
    if (reachedValues().length > 0) return finish();
    // a blocked pivot that has gained an untried value is open again
    for (const p of [...blocked]) {
      const pivot = deps.registry.pivot(p);
      if (pivot !== null && (known.get(pivot.from) ?? []).some((v) => !done.has(`${p}|${v}`))) blocked.splice(blocked.indexOf(p), 1);
    }
    const have = [...known.entries()].filter(([, v]) => v.length > 0).map(([t]) => t);
    // Routes around the blocked pivots come first. Routes through them follow: a hop ahead of a blocked pivot may still
    // find the new values that would open it again.
    const routes = seeker.routes(have, input.want, limits, new Set(blocked));
    if (blocked.length > 0) routes.push(...seeker.routes(have, input.want, limits));
    let hop: Hop | undefined;
    let newlyBlocked = false;
    for (const route of routes) {
      hop = route.hops.find((h) => untried(h).length > 0);
      if (hop !== undefined) break;
      // dry: the hop just before the first one with nothing to start from (or the last hop) is the one that ran dry
      const gap = route.hops.findIndex((h) => (known.get(h.from) ?? []).length === 0);
      const dry = route.hops[gap === -1 ? route.hops.length - 1 : gap - 1];
      if (dry !== undefined && block(dry.pivot)) newlyBlocked = true;
    }
    if (hop === undefined) {
      if (newlyBlocked) continue;
      return finish();
    }
    const pending = untried(hop);
    for (const v of pending) done.add(`${hop.pivot}|${v}`); // values beyond the fan-out cap are never run for this pivot
    let ran = 0;
    let reachedGoal = false;
    for (const value of pending.slice(0, fanout)) {
      if (runs >= MAX_PIVOT_RUNS) {
        caveat(`stopped after ${MAX_PIVOT_RUNS} lookups`);
        return finish();
      }
      runs++;
      ran++;
      const r = await runPivot(session, deps, {
        pivot: hop.pivot, value, window: input.window, why: `${input.why} — ${hop.title}`, actor: input.actor,
        subgoal: input.subgoal ?? null, run: input.run ?? null, stage: input.stage ?? null, job: input.job ?? null,
      });
      const pivot = deps.registry.pivot(hop.pivot);
      const found = pivot !== null ? yielded(pivot, r, deps.observables) : [];
      for (const o of found) add(o);
      if (r.status === "done") {
        if (r.coverage.kind === "partial") caveat(`${hop.pivot}: partial coverage (${r.coverage.reason})`);
        if (!hop.confirmed) caveat(`${hop.pivot}: unconfirmed source ${hop.source}`);
      }
      trail.push({
        hop, value, status: r.status, outcome: r.status === "done" ? r.outcome : null,
        card: r.status === "done" ? r.card : null, query: r.status === "done" || r.status === "failed" ? r.query : null,
        found: found.map((o) => o.value),
        proposal: r.status === "needs_budget" ? r.proposal : null, estimate: r.status === "needs_budget" ? r.estimate : null,
      });
      if (r.status === "needs_budget") {
        caveat(r.proposal !== null ? `${hop.pivot}: needs a budget (proposal ${r.proposal})` : `${hop.pivot}: needs a budget`);
        break; // asking again for the next value would only repeat the request
      }
      if (hop.to === input.want && reachedValues().length > 0) {
        reachedGoal = true; // the goal is known; the hop's other values are not worth a lookup, but the answer says so
        break;
      }
    }
    const left = pending.length - ran;
    if (reachedGoal && left > 0) caveat(`${hop.pivot}: ${left} value${left === 1 ? "" : "s"} not followed after the goal was reached`);
    else if (!reachedGoal && pending.length > fanout) caveat(`${hop.pivot}: ${pending.length - fanout} values not tried (fan-out limit ${fanout})`);
  }
}
