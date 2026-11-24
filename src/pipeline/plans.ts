import type { CaseSession } from "../core/session";
import type { Actor, EntryInput, Plan, PlanStep, TimeWindow, Where } from "../core/types";
import { mayGo } from "../agents/pack";
import { runProposal } from "../modules/proposals";
import type { RunnerDeps, RunQueryResult } from "../modules/runner";
import type { Hop, SeekLimits } from "../modules/seeker";
import type { EngineDeps } from "./engine";

/** What the planner's output says: sub-goals with a starting set, a wanted type and a route of pivot ids. Code builds the plan from it. */
export interface PlanOutput {
  goal: string;
  subgoals: { title: string; question: string; have: { type: string; value: string }[]; want: string; route: string[] }[];
}

export class PlanRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanRefused";
  }
}

/**
 * The plan for the planner's output, or every reason it cannot be built. A route must be one the route finder offers for the
 * starting types, the wanted type and the frame's limits. `research` is where the Research stage's model runs, for the warnings.
 */
export function buildPlan(
  id: string, output: PlanOutput, deps: Pick<EngineDeps, "registry" | "seeker" | "config" | "runner">,
  frame: { window: TimeWindow; limits: SeekLimits }, research: { where: Where } | null,
): Plan | { errors: string[] } {
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
      });
    });
    subgoals.push({ id: goalId, title: sg.title, question: sg.question, steps: ids });
  }
  return errors.length > 0 ? { errors } : { id, goal: output.goal, window: { ...frame.window }, subgoals, steps };
}

function proposedPlan(session: CaseSession): Plan {
  const { plan } = session.state;
  if (plan.status !== "proposed" || plan.current === null) throw new PlanRefused("there is no proposed plan");
  return plan.current;
}
function onlyAPerson(actor: Actor): void {
  if (actor.kind !== "human") throw new PlanRefused("only a person may decide on a plan");
}
const link = (session: CaseSession): { run?: string } => (session.state.run.id === null ? {} : { run: session.state.run.id });

export function acceptPlan(session: CaseSession, input: { steps?: string[]; budgets?: Record<string, number>; actor: Actor }): void {
  onlyAPerson(input.actor);
  const plan = proposedPlan(session);
  const known = new Set(plan.steps.map((s) => s.id));
  const steps = input.steps === undefined ? plan.steps.map((s) => s.id) : [...new Set(input.steps)];
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
      out.push({ type: "lane.created", actor, ...link(session), payload: { lane: ids.next("lane"), title: g.title, subgoal: g.id } });
    }
    out.push({ type: "gate.passed", actor, ...link(session), payload: { gate: "plan" } });
    return out;
  });
}

export function denyPlan(session: CaseSession, input: { reason: string; actor: Actor }): void {
  onlyAPerson(input.actor);
  const plan = proposedPlan(session);
  const { actor } = input;
  session.commit(() => [
    { type: "plan.denied", actor, ...link(session), payload: { plan: plan.id, reason: input.reason } },
    { type: "run.finished", actor, ...link(session), payload: { outcome: "stopped" } },
  ]);
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
 * Runs the proposal a costly step raised, once per step, with the budget the person gave that step when accepting the plan and in
 * that person's name. Null when the step has no budget, the proposal is not open or not for that step, or the step's budget was used.
 */
export async function spendPlanBudget(session: CaseSession, deps: RunnerDeps, proposal: string, step: string | null): Promise<RunQueryResult | null> {
  const { plan } = session.state;
  if (step === null || plan.current === null || plan.status !== "accepted") return null;
  const planId = plan.current.id;
  const accepted = [...session.entries()].reverse().find((e) => e.type === "plan.accepted" && e.payload.plan === planId);
  if (accepted === undefined || accepted.type !== "plan.accepted" || !Object.hasOwn(accepted.payload.budgets, step)) return null;
  const p = Object.hasOwn(session.state.proposals, proposal) ? session.state.proposals[proposal]! : null;
  if (p === null || p.kind !== "costly_query" || p.status !== "open" || p.step !== step) return null;
  const spent = session.entries().some((e) => {
    if (e.type !== "proposal.accepted") return false;
    const earlier = Object.hasOwn(session.state.proposals, e.payload.proposal) ? session.state.proposals[e.payload.proposal]! : null;
    return earlier !== null && earlier.kind === "costly_query" && earlier.step === step;
  });
  if (spent) return null;
  return runProposal(session, deps, { proposal, budget: accepted.payload.budgets[step]!, actor: accepted.actor, cause: accepted.seq });
}
