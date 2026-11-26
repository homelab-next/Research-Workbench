import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import type { Actor, Cost, EntryInput, Plan, PlanStep, TimeWindow, Where } from "../core/types";
import { mayGo } from "../agents/pack";
import { runPivot } from "../modules/pivots";
import { stepPins } from "../modules/pins";
import { playbookProblem } from "../modules/playbook-run";
import { runProposal } from "../modules/proposals";
import type { RunnerDeps, RunQueryResult } from "../modules/runner";
import type { Hop, SeekLimits } from "../modules/seeker";
import type { EngineDeps } from "./engine";

/**
 * What the planner's output says: sub-goals with a starting set, a wanted type and either a route of pivot ids or a playbook (with an
 * empty route). Code builds the plan from it.
 */
export interface PlanOutput {
  goal: string;
  subgoals: { title: string; question: string; have: { type: string; value: string }[]; want: string; route: string[]; playbook?: string }[];
}

export class PlanRefused extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "PlanRefused";
  }
}

const isText = (x: unknown): x is string => typeof x === "string";
const isPlainRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** What is wrong with the shape of the planner's output, if anything. buildPlan reads only what this has checked. */
function shapeProblem(o: unknown): string | null {
  const bad = "the plan output is not in the required shape: ";
  if (!isPlainRecord(o) || !isText(o.goal) || !Array.isArray(o.subgoals) || o.subgoals.length === 0) return `${bad}it needs a goal and at least one sub-goal`;
  for (const g of o.subgoals) {
    if (!isPlainRecord(g) || !isText(g.title) || !isText(g.question) || !isText(g.want) || !Array.isArray(g.have) || !Array.isArray(g.route)
      || !g.route.every(isText) || !g.have.every((h) => isPlainRecord(h) && isText(h.type) && isText(h.value))) {
      return `${bad}each sub-goal needs a title, question, want, have list and a route of pivot ids`;
    }
    const byRoute = g.playbook === undefined && g.route.length > 0;
    const byPlaybook = isText(g.playbook) && g.route.length === 0;
    if (!byRoute && !byPlaybook) return `${bad}each sub-goal needs a route of pivot ids, or a playbook and an empty route`;
  }
  return null;
}

/**
 * The plan for the planner's output, or every reason it cannot be built. A route must be one the route finder offers for the
 * starting types, the wanted type and the frame's limits. `research` is where the Research stage's model runs, for the warnings.
 */
export function buildPlan(
  id: string, output: PlanOutput, deps: Pick<EngineDeps, "registry" | "seeker" | "config" | "runner">,
  frame: { window: TimeWindow; limits: SeekLimits }, research: { where: Where } | null,
): Plan | { errors: string[] } {
  const shape = shapeProblem(output);
  if (shape !== null) return { errors: [shape] };
  const errors: string[] = [];
  const subgoals: Plan["subgoals"] = [];
  const steps: PlanStep[] = [];
  for (const [i, sg] of output.subgoals.entries()) {
    const name = `sub-goal "${sg.title}"`;
    const wrong = sg.have.find((h) => !deps.runner.observables.matches(h.type, h.value));
    if (wrong !== undefined) {
      errors.push(`${name}: "${wrong.value}" is not a ${wrong.type}`);
      continue;
    }
    if (sg.playbook !== undefined) {
      const built = playbookStep(sg.playbook, sg, name, `s${steps.length + 1}`, `g${i + 1}`, deps, frame);
      if (typeof built === "string") {
        errors.push(built);
        continue;
      }
      steps.push(built);
      subgoals.push({ id: built.subgoal, title: sg.title, question: sg.question, steps: [built.id] });
      continue;
    }
    const types = [...new Set(sg.have.map((h) => h.type))];
    const offered = deps.seeker.routes(types, sg.want, frame.limits).find((r) => r.hops.length === sg.route.length && r.hops.every((h, n) => h.pivot === sg.route[n]));
    if (offered === undefined) {
      errors.push(`${name}: the route ${sg.route.join(", ")} is not one the route finder offers from ${types.join(", ")} to ${sg.want}`);
      continue;
    }
    const goalId = `g${i + 1}`;
    const ids: string[] = [];
    offered.hops.forEach((hop: Hop, n) => {
      const stepId = `s${steps.length + 1}`;
      ids.push(stepId);
      const warnings: string[] = [];
      if (!hop.confirmed) warnings.push("unconfirmed source");
      if (research !== null && !mayGo(hop.marking, research.where, deps.config.marking_policy)) {
        warnings.push(`this source is marked ${hop.marking}, which the Research stage's model may not receive`);
      }
      steps.push({
        id: stepId, subgoal: goalId, pivot: hop.pivot, source: hop.source,
        from: { type: hop.from, value: n === 0 ? sg.have.find((h) => h.type === hop.from)!.value : "" }, to: hop.to,
        window: { ...frame.window }, needs_window: hop.needs_window, free: hop.free, weight: hop.weight, estimate: null, empty_means: hop.empty_means, warnings,
        // the seeker offers only loaded pivots, so the pins can be computed
        pins: stepPins(deps.registry, { pivot: hop.pivot })!,
      });
    });
    subgoals.push({ id: goalId, title: sg.title, question: sg.question, steps: ids });
  }
  return errors.length > 0 ? { errors } : { id, goal: output.goal, window: { ...frame.window }, subgoals, steps };
}

/**
 * The one plan step a playbook sub-goal becomes, or the reason it cannot: the playbook must exist, have no costly lookup (a person starts
 * one of those), take the sub-goal's values over the frame's window, find the wanted type, and use no unconfirmed source the frame rules out.
 */
function playbookStep(
  id: string, sg: PlanOutput["subgoals"][number], name: string, stepId: string, goalId: string,
  deps: Pick<EngineDeps, "registry" | "runner">, frame: { window: TimeWindow; limits: SeekLimits },
): PlanStep | string {
  const p = deps.registry.playbook(id);
  if (p === null) return `${name}: there is no playbook ${id}`;
  const costly = deps.registry.costlyPivots(p);
  if (costly.length > 0) return `${name}: the playbook ${id} has costly lookups (${costly.join(", ")}); a person can start it from the Pivot panel`;
  const have = sg.have.map((h) => ({ type: h.type, value: h.value }));
  const problem = playbookProblem(deps.runner, p, have, frame.window);
  if (problem !== null) return `${name}: ${problem}`;
  // the registry loads a playbook only when every pivot it names is loaded
  const pivots = p.steps.map((s) => deps.registry.pivot(s.pivot)!);
  const ends = p.end.map((e) => deps.registry.pivot(p.steps.find((s) => s.id === e)!.pivot)!);
  if (ends.some((x) => x.to !== sg.want)) {
    const types = [...new Set(ends.map((x) => x.to))];
    return `${name}: the playbook ${id} ends on steps that find ${types.join(" and ")}; a plan step needs every end step to find ${sg.want}`;
  }
  const unconfirmed = [...new Set(pivots.map((x) => x.source))].filter((src) => deps.registry.source(src)?.confirmed === false);
  if (!frame.limits.allow_unconfirmed && unconfirmed.length > 0) return `${name}: the playbook ${id} uses the unconfirmed source ${unconfirmed[0]!}`;
  // as for a route step, the gate says which unconfirmed sources the playbook asks
  const warnings = unconfirmed.map((src) => `uses the unconfirmed source ${src}`);
  const first = have.find((h) => h.type === p.inputs[0]!.type)!;
  return {
    id: stepId, subgoal: goalId, pivot: "", source: "", from: { ...first }, to: sg.want, window: { ...frame.window },
    needs_window: pivots.some((x) => x.needs_window), free: true, weight: 0, estimate: null,
    // an empty answer is a proven negative only when every end step says so
    empty_means: ends.every((x) => x.empty_means === "proven-negative") ? "proven-negative" : "not-seen", warnings,
    playbook: { id: p.id, hash: p.hash, inputs: have },
    // the playbook and every pivot it names are loaded (checked above), so the pins can be computed
    pins: stepPins(deps.registry, { pivot: "", playbook: { id: p.id, hash: p.hash, inputs: have } })!,
  };
}

function proposedPlan(session: CaseSession): Plan {
  const { plan, run } = session.state;
  if (run.id === null || run.status === "none" || run.status === "finished") throw new PlanRefused("there is no run in progress");
  if (run.waiting !== "plan") throw new PlanRefused("the run is not waiting at the plan gate");
  if (plan.status !== "proposed" || plan.current === null) throw new PlanRefused("there is no proposed plan");
  return plan.current;
}
function onlyAPerson(actor: Actor, what = "decide on a plan"): void {
  if (actor.kind !== "human") throw new PlanRefused(`only a person may ${what}`);
}
const link = (session: CaseSession): { run?: string } => (session.state.run.id === null ? {} : { run: session.state.run.id });

export function acceptPlan(session: CaseSession, input: { steps?: string[]; budgets?: Record<string, number>; actor: Actor }): void {
  onlyAPerson(input.actor);
  const plan = proposedPlan(session);
  const known = new Set(plan.steps.map((s) => s.id));
  const steps = input.steps === undefined ? plan.steps.map((s) => s.id) : [...new Set(input.steps)];
  if (steps.length === 0) throw new PlanRefused("a plan with no accepted step cannot be accepted; deny it instead");
  const unknown = steps.find((s) => !known.has(s));
  if (unknown !== undefined) throw new PlanRefused(`unknown step: ${unknown}`);
  const budgets: Record<string, number> = {};
  for (const [step, budget] of Object.entries(input.budgets ?? {})) {
    const s = plan.steps.find((x) => x.id === step);
    if (s === undefined || !steps.includes(step)) throw new PlanRefused(`a budget names ${step}, which is not an accepted step`);
    if (s.free) throw new PlanRefused(`step ${step} is free and needs no budget`);
    if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) throw new PlanRefused(`the budget for ${step} must be a number above zero`);
    budgets[step] = budget;
  }
  const ordered = plan.steps.map((s) => s.id).filter((s) => steps.includes(s));
  const { actor } = input;
  session.commit((_state, ids) => {
    const out: EntryInput[] = [{ type: "plan.accepted", actor, ...link(session), payload: { plan: plan.id, steps: ordered, budgets } }];
    for (const g of plan.subgoals) {
      if (!g.steps.some((s) => steps.includes(s))) continue;
      if (session.state.lanes.some((l) => l.subgoal === g.id)) continue;
      out.push({ type: "lane.created", actor, ...link(session), payload: { lane: ids.next("lane"), title: g.title, subgoal: g.id } });
    }
    out.push({ type: "gate.passed", actor, ...link(session), payload: { gate: "plan" } });
    return out;
  });
}

/** `anchor` is called once the denial is written: closing a run is anchored, and the caller says how. */
export function denyPlan(session: CaseSession, input: { reason: string; actor: Actor }, anchor: () => void): void {
  onlyAPerson(input.actor);
  const plan = proposedPlan(session);
  const { actor } = input;
  session.commit(() => [
    { type: "plan.denied", actor, ...link(session), payload: { plan: plan.id, reason: input.reason } },
    { type: "run.finished", actor, ...link(session), payload: { outcome: "stopped" } },
  ]);
  anchor();
}

/** The gate is passed with the request, so the plan stage runs again: the plan stays "replanning" until the planner proposes another. */
export function requestReplan(session: CaseSession, input: { note: string; actor: Actor }): void {
  onlyAPerson(input.actor);
  const plan = proposedPlan(session);
  const { actor } = input;
  session.commit(() => [
    { type: "plan.replan_requested", actor, ...link(session), payload: { plan: plan.id, note: input.note } },
    { type: "gate.passed", actor, ...link(session), payload: { gate: "plan" } },
  ]);
}

/**
 * Runs the proposal a costly step raised, once per step under this plan's acceptance (checked from the ledger: a proposal.accepted it caused),
 * with the budget the person gave that step when accepting the plan and in that person's name. Null when the step has no budget, the proposal is not open or not for that step, or the step's budget was used.
 */
export async function spendPlanBudget(session: CaseSession, deps: RunnerDeps, proposal: string, step: string | null): Promise<RunQueryResult | null> {
  const { plan } = session.state;
  if (step === null || plan.current === null || plan.status !== "accepted") return null;
  const planId = plan.current.id;
  const accepted = [...session.entries()].reverse().find((e) => e.type === "plan.accepted" && e.payload.plan === planId);
  if (accepted === undefined || accepted.type !== "plan.accepted" || accepted.actor.kind !== "human") return null;
  if (!accepted.payload.steps.includes(step) || !Object.hasOwn(accepted.payload.budgets, step)) return null;
  const p = Object.hasOwn(session.state.proposals, proposal) ? session.state.proposals[proposal]! : null;
  if (p === null || p.kind !== "costly_query" || p.status !== "open" || p.step !== step) return null;
  // paid once per step under this acceptance: an earlier plan, or an earlier run, used its own budget, not this one
  const spent = session.entries().some((e) => {
    if (e.type !== "proposal.accepted" || e.cause !== accepted.seq) return false;
    const earlier = Object.hasOwn(session.state.proposals, e.payload.proposal) ? session.state.proposals[e.payload.proposal]! : null;
    return earlier !== null && earlier.kind === "costly_query" && earlier.step === step;
  });
  if (spent) return null;
  // the run as it is now: if it is stopped, paused or replaced before the query is priced, nothing is accepted in the person's name
  const run0 = session.state.run.id;
  const guard = (): string | null => {
    const now = session.state.run;
    if (now.id !== run0) return "the run changed while the query was being priced";
    if (now.status === "finished" || now.status === "paused") return `the run is ${now.status}`;
    return null;
  };
  return runProposal(session, deps, { proposal, budget: accepted.payload.budgets[step]!, actor: accepted.actor, cause: accepted.seq, guard });
}

/**
 * A person asks what a costly step would cost, before accepting the plan. The step is priced through the runner, which records an estimate
 * query when the source has to be asked and runs nothing else; the figure is then recorded as step.estimated. Null when no price could be had.
 */
export function checkEstimate(session: CaseSession, input: { step: string; actor: Actor }): PlanStep {
  onlyAPerson(input.actor, "ask for an estimate");
  const plan = proposedPlan(session);
  const step = plan.steps.find((s) => s.id === input.step);
  if (step === undefined) throw new PlanRefused(`there is no step ${input.step}`);
  if (step.free) throw new PlanRefused(`step ${step.id} is free and needs no estimate`);
  if (step.from.value === "") throw new PlanRefused(`step ${step.id} starts from what an earlier step finds; it can be priced only after that step has run`);
  return step;
}

export async function estimateStep(session: CaseSession, deps: RunnerDeps, input: { step: string; actor: Actor }): Promise<Cost | null> {
  const step = checkEstimate(session, input);
  const plan = session.state.plan.current!;
  const began = session.state.seq;
  const { actor } = input;
  const result = await runPivot(session, deps, {
    pivot: step.pivot, value: step.from.value, window: step.window, why: `estimate for plan step ${step.id}`, actor, step: step.id, budget: null,
    ...(session.state.run.id === null ? {} : { run: session.state.run.id }),
  });
  if (result.status === "refused") throw new PlanRefused(result.reasons.join("; "));
  if (result.status !== "needs_budget") throw new PlanRefused("this step is no longer priced as the plan says");
  // the plan may have been decided while the source was asked; the write below is one synchronous commit, so nothing can come between this look and it
  const { run } = session.state;
  if (session.state.plan.current?.id !== plan.id || session.state.plan.status !== "proposed" || run.status === "finished" || run.status === "none" || run.waiting !== "plan") throw new PlanRefused("the plan was decided while the estimate was being made");
  const issued = Object.values(session.state.queries).filter((q) => q.purpose === "estimate" && q.step === step.id && q.issued_seq > began).sort((a, b) => b.issued_seq - a.issued_seq)[0];
  session.commit(() => [{ type: "step.estimated", actor, ...link(session), payload: { step: step.id, estimate: result.estimate, query: issued?.id ?? null } }]);
  return result.estimate;
}
