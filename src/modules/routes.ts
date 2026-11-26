import type { CaseSession } from "../core/session";
import type { Actor, Cost, Observable, TimeWindow } from "../core/types";
import { runPivot } from "./pivots";
import type { RunnerDeps, RunQueryResult } from "./runner";
import { DEFAULT_LIMITS } from "./seeker";
import type { Hop, Seeker, SeekLimits } from "./seeker";
import { followRoute, MAX_PIVOT_RUNS } from "pivot/plan/follow";
import type { HopRun } from "pivot/plan/follow";
import { DEFAULT_SEARCH } from "pivot/plan/search";

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
export { MAX_PIVOT_RUNS } from "pivot/plan/follow";

/** A hop's run as pivot's walker reads it, with the runner's own result kept beside it. */
type Ran = HopRun & { result: RunQueryResult };

function hopRunOf(r: RunQueryResult): HopRun {
  switch (r.status) {
    case "done": return { status: "done", coverage: r.coverage, columns: r.columns, rows: r.data };
    case "failed": return { status: "failed" };
    case "needs_budget": return { status: "needs_budget" };
    case "refused": return { status: "refused", reasons: r.reasons };
  }
}

/**
 * Follows the seeker's routes hop by hop until it learns a value of `want` it was not given. The walk is pivot's `followRoute`
 * (one type goal, the seeker's routes); each lookup it asks for is this workbench's `runPivot`, so every query it sends is
 * the runner's, with its custody. Each pass walks the seeker's routes in order and runs the first hop that has a value not yet
 * tried with it, up to the fan-out limit. A lookup marks only that pivot and value as done, whatever it returned. A route with no
 * such hop has run dry: the pivot that ran dry (the hop before the first one with nothing to start from, or the last hop) is
 * blocked, and stays blocked only while it has no untried value. Routes around blocked pivots are walked first, then routes
 * through them, so a hop ahead of a blocked pivot can still find the values that open it again. Stops when no route has
 * anything left to try, or after MAX_PIVOT_RUNS runs.
 * `reached` holds values of `want` that were found, never the ones given in `have`. `caveats` says, in plain words,
 * what an answer rests on that a reader should know: partial coverage, unconfirmed sources, costly hops waiting for a
 * budget (with the agent's proposal), the run cap, the fan-out cap, and values left unfollowed once the goal was reached.
 */
export async function runRoute(session: CaseSession, deps: RunnerDeps, seeker: Seeker, input: RouteInput): Promise<RouteResult> {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const walked = await followRoute<Ran>(deps.registry, deps.observables, {
    have: input.have, goal: { kind: "type", type: input.want }, limits: { ...DEFAULT_SEARCH, ...limits },
    ...(input.max_fanout === undefined ? {} : { max_fanout: input.max_fanout }), max_runs: MAX_PIVOT_RUNS,
    routes: (have, blocked) => seeker.routes(have, input.want, limits, blocked),
  }, async (hop, value) => {
    const r = await runPivot(session, deps, {
      pivot: hop.pivot, value, window: input.window, why: `${input.why} — ${hop.title}`, actor: input.actor,
      subgoal: input.subgoal ?? null, run: input.run ?? null, stage: input.stage ?? null, job: input.job ?? null,
    });
    return { ...hopRunOf(r), result: r };
  });
  const trail: TrailItem[] = walked.trail.map(({ hop, value, run: { result: r }, found }) => ({
    hop, value, status: r.status, outcome: r.status === "done" ? r.outcome : null,
    card: r.status === "done" ? r.card : null, query: r.status === "done" || r.status === "failed" ? r.query : null,
    found,
    proposal: r.status === "needs_budget" ? r.proposal : null, estimate: r.status === "needs_budget" ? r.estimate : null,
  }));
  // The walker's caveats, worded as the workbench words them: a budget wait names the agent's proposal, a refusal keeps the pivot caveat as pivot words it.
  const caveats: string[] = [];
  const caveat = (text: string): void => { if (!caveats.includes(text)) caveats.push(text); };
  for (const c of walked.caveats) {
    const waits = trail.filter((t) => t.status === "needs_budget" && c === `${t.hop.pivot}: needs a budget`);
    if (waits.length > 0) {
      for (const t of waits) caveat(t.proposal !== null ? `${t.hop.pivot}: needs a budget (proposal ${t.proposal})` : `${t.hop.pivot}: needs a budget`);
      continue;
    }
    caveat(c);
  }
  return {
    outcome: walked.outcome, reached: walked.reached, trail, cards: trail.flatMap((t) => (t.card === null ? [] : [t.card])), blocked: walked.blocked, caveats,
  };
}
