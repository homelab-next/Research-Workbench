import type { Json } from "../../core/canonical";
import type { CaseSession } from "../../core/session";
import type { StepOutcome, TimeWindow } from "../../core/types";
import { pivotWeight } from "../../modules/manifests";
import { bindPivot, runPivot, yielded } from "../../modules/pivots";
import { answeredBefore, reuseNote } from "../../modules/reuse";
import type { Reused } from "../../modules/reuse";
import type { PivotManifest } from "../../modules/registry";
import { previewCell, runQuery } from "../../modules/runner";
import type { RunQueryResult } from "../../modules/runner";
import { cardBrief, scrubCoverage } from "./cards";
import type { ToolContext, ToolDef, ToolResult } from "./index";
import { idArg, json, MAX_BOUND_KEYS, MAX_BOUND_VALUE, MAX_TEXT, params, scrub, str, ToolError, VIEW_ROWS } from "./kit";

/** What a finished query says in plain words. A partial result is never called a negative. */
function describe(r: Extract<RunQueryResult, { status: "done" }>, empty: string | null): string {
  const partial = r.coverage.kind === "partial" ? `partial: ${r.coverage.reason}` : null;
  if (r.rows === 0) {
    const meaning = empty === "proven-negative" && partial === null ? "proven negative" : "not seen (not proof of absence)";
    return ["no rows", partial, meaning].filter((x) => x !== null).join(" · ");
  }
  return `${r.rows === 1 ? "1 row" : `${r.rows} rows`} · ${partial ?? "full coverage"}`;
}

/** The one view `run_pivot`, `run_step` and `run_query` share. `marking` is the source's when anything ran. */
export function resultOf(ctx: ToolContext, r: RunQueryResult, pivot: PivotManifest | null, sourceId: string): ToolResult {
  const source = ctx.deps.registry.source(sourceId);
  const hide = (t: string): string => scrub(ctx.deps.registry, t);
  const none = { outcome: null, card: null, rows: null, coverage: null, empty: null, columns: null, data: null, found: null, proposal: null, estimate: null, reasons: null };
  switch (r.status) {
    case "done": {
      const card = r.card !== null && Object.hasOwn(ctx.session.state.cards, r.card) ? ctx.session.state.cards[r.card]! : null;
      const empty = card === null ? null : card.empty;
      const reused = "reused" in r ? (r as Reused) : null;
      const view = {
        ...none, ...(reused === null ? {} : { reused: { query: reused.reused.query, at: reused.reused.at } }), status: r.status, outcome: r.outcome, card: card === null ? null : [cardBrief(ctx.deps.registry, card)], rows: r.rows, coverage: scrubCoverage(ctx.deps.registry, r.coverage), empty,
        columns: r.columns, data: r.data.slice(0, VIEW_ROWS).map((row) => row.map(previewCell)),
        found: pivot === null ? null : yielded(pivot, r, ctx.deps.observables).map((o) => o.value),
      };
      const said = describe(r, empty);
      return { ok: true, summary: reused === null ? said : `${reuseNote(reused)} · ${said}`, view: json(view), marking: source === null ? null : source.marking };
    }
    case "failed":
      return {
        ok: false, summary: hide(`the query failed: ${r.error}`), view: json({ ...none, status: r.status, reasons: [hide(r.error)] }),
        marking: source === null ? null : source.marking,
      };
    case "needs_budget":
      return {
        ok: true, summary: r.proposal === null ? "waiting for a person's budget" : `waiting for a person's budget (proposal ${r.proposal})`,
        view: json({ ...none, status: r.status, proposal: r.proposal, estimate: r.estimate }), marking: null,
      };
    case "refused":
      return { ok: false, summary: hide(r.reasons.join("; ")), view: json({ ...none, status: r.status, reasons: r.reasons.map(hide) }), marking: null };
  }
}

function acceptedPlan(session: CaseSession): NonNullable<CaseSession["state"]["plan"]["current"]> {
  const p = session.state.plan;
  if (p.status !== "accepted" || p.current === null) throw new ToolError("the plan has not been accepted");
  return p.current;
}

/**
 * The recorded answer to this pivot on this value over this window, when the case already has one that can stand for it (see answeredBefore);
 * null when the value is not one the pivot takes (the runner then refuses it) or nothing can be reused.
 */
function reusable(ctx: ToolContext, pivot: PivotManifest | null, value: string, window: TimeWindow): Reused | null {
  if (pivot === null || !ctx.deps.observables.matches(pivot.from, value)) return null;
  return answeredBefore(ctx.session, ctx.deps, pivot, bindPivot(pivot, value, ctx.deps.observables).bound, window);
}

async function runPivotTool(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const id = str(args.pivot);
  const pivot = ctx.deps.registry.pivot(id);
  if (pivot === null) throw new ToolError(`unknown pivot: ${id}`);
  const source = ctx.deps.registry.source(pivot.source);
  if (source === null || pivotWeight(pivot, source) !== 0) throw new ToolError(`${id} is costly; it must be a plan step`);
  const plan = acceptedPlan(ctx.session);
  const stepById = new Map(plan.steps.map((s) => [s.id, s]));
  let subgoals = plan.subgoals;
  if (ctx.subgoal !== null) {
    subgoals = plan.subgoals.filter((g) => g.id === ctx.subgoal);
    if (subgoals.length === 0) throw new ToolError(`unknown sub-goal: ${ctx.subgoal}`);
  }
  const goals = subgoals.map((g) => stepById.get(g.steps[g.steps.length - 1] ?? "")?.to).filter((t): t is string => t !== undefined);
  const leads = goals.some((goal) => pivot.to === goal || ctx.seeker.routes([pivot.to], goal, ctx.limits).length > 0);
  if (!leads) throw new ToolError(`${id} does not lead to this sub-goal`);
  // the same lookup answered before in this case is read back, not sent to the source again
  const before = reusable(ctx, pivot, str(args.value), ctx.window);
  if (before !== null) return resultOf(ctx, before, pivot, pivot.source);
  const r = await runPivot(ctx.session, ctx.deps, {
    pivot: id, value: str(args.value), window: ctx.window, why: str(args.why), actor: ctx.actor, subgoal: ctx.subgoal, ...ctx.link,
  });
  return resultOf(ctx, r, pivot, pivot.source);
}

async function runStepTool(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const plan = acceptedPlan(ctx.session);
  const id = str(args.step);
  const step = plan.steps.find((s) => s.id === id);
  if (step === undefined) {
    // a model that names the pivot where it means the step is told which steps it may run
    if (ctx.deps.registry.pivot(id) !== null) {
      const mine = plan.steps.filter((s) => ctx.subgoal === null || s.subgoal === ctx.subgoal);
      const listed = mine.length === 0 ? "none" : mine.map((s) => `${s.id} (${s.pivot})`).join(", ");
      throw new ToolError(`${id} is a pivot, not a step; ${ctx.subgoal === null ? "the plan's" : "this sub-goal's"} steps are ${listed}`);
    }
    throw new ToolError(`unknown step: ${id}`);
  }
  if (!ctx.session.state.plan.accepted_steps.includes(id)) throw new ToolError(`step ${id} was not accepted`);
  const had = Object.hasOwn(ctx.session.state.plan.steps, id) ? ctx.session.state.plan.steps[id]! : null;
  if (had !== null && had.status !== "pending" && had.status !== "running") throw new ToolError("this step has already run");
  if (ctx.subgoal !== null && step.subgoal !== ctx.subgoal) throw new ToolError(`step ${id} belongs to sub-goal ${step.subgoal}, not ${ctx.subgoal}`);
  const value = step.from.value !== "" ? step.from.value : str(args.value);
  if (value === "") throw new ToolError("this step needs a value from an earlier step");
  const pivot = ctx.deps.registry.pivot(step.pivot);
  const earlier = had === null ? [] : had.cards;

  const before = reusable(ctx, pivot, value, step.window);
  if (before !== null) {
    // nothing is run: the step finishes on the recorded answer, citing its query and card
    const note = reuseNote(before);
    const cards = before.card === null || earlier.includes(before.card) ? earlier : [...earlier, before.card];
    ctx.session.commit(() => [
      { type: "step.started", actor: ctx.actor, ...ctx.link, payload: { step: id } },
      { type: "step.finished", actor: ctx.actor, ...ctx.link, cause: before.reused.card_seq, payload: { step: id, outcome: before.outcome, cards, note, reused: before.query } },
    ]);
    return resultOf(ctx, before, pivot, pivot === null ? step.source : pivot.source);
  }

  ctx.session.commit(() => [{ type: "step.started", actor: ctx.actor, ...ctx.link, payload: { step: id } }]);
  const finish = (outcome: StepOutcome, cards: string[], note: string): void => {
    ctx.session.commit(() => [{ type: "step.finished", actor: ctx.actor, ...ctx.link, payload: { step: id, outcome, cards, note } }]);
  };
  try {
    let r = await runPivot(ctx.session, ctx.deps, {
      pivot: step.pivot, value, window: step.window, why: str(args.why), actor: ctx.actor, step: id, subgoal: step.subgoal, ...ctx.link,
    });
    if (r.status === "needs_budget" && r.proposal !== null && ctx.onNeedsBudget !== undefined) {
      const paid = await ctx.onNeedsBudget(r.proposal, id);
      if (paid !== null) r = paid;
    }
    // the marking is that of the pivot that ran, which the runner took from the registry, not of the source the step names
    const result = resultOf(ctx, r, pivot, pivot === null ? step.source : pivot.source);
    const outcome: StepOutcome = r.status === "done" ? r.outcome : r.status === "failed" ? "failed" : "blocked";
    const cards = r.status === "done" && r.card !== null ? [...earlier, r.card] : earlier;
    finish(outcome, cards, result.summary);
    return result;
  } catch (err) {
    // the step is never left running: one failed finish, in its own try, whatever went wrong above
    try {
      finish("failed", earlier, scrub(ctx.deps.registry, (err instanceof Error ? err.message : String(err)).split("\n")[0]!));
    } catch {
      // the record refused it as well; the original error is what the model is told
    }
    throw err;
  }
}

async function runQueryTool(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const source = str(args.source);
  const bound = (args.bound ?? {}) as Record<string, string | number | null>;
  if (Object.keys(bound).length > MAX_BOUND_KEYS) throw new ToolError(`bound may have at most ${MAX_BOUND_KEYS} values`);
  if (Object.values(bound).some((v) => typeof v === "string" && [...v].length > MAX_BOUND_VALUE)) throw new ToolError(`a bound value may be at most ${MAX_BOUND_VALUE} characters`);
  const r = await runQuery(ctx.session, ctx.deps, {
    source, text: str(args.text), bound, window: ctx.window, why: str(args.why),
    actor: ctx.actor, pivot: null, subgoal: ctx.subgoal, ...ctx.link,
  });
  return resultOf(ctx, r, null, source);
}

export const RESEARCH_TOOLS: ToolDef[] = [
  {
    name: "run_step", description: "Run one accepted step of the plan. A later hop needs the value an earlier step found.",
    parameters: params({ step: idArg, value: idArg }, ["step"]), call: runStepTool,
  },
  {
    name: "run_pivot", description: "Run one free pivot on a value, if it leads to your sub-goal. Costly pivots must be plan steps.",
    parameters: params({ pivot: idArg, value: idArg }, ["pivot", "value"]), call: runPivotTool,
  },
  {
    name: "run_query", description: "Run a query you wrote, on a source that allows it. The bound values are strings, numbers or null.",
    parameters: params({
      source: idArg, text: { type: "string", minLength: 1, maxLength: MAX_TEXT },
      bound: { type: "object", additionalProperties: { type: ["string", "number", "null"] } },
    }, ["source", "text"]),
    call: runQueryTool,
  },
];
