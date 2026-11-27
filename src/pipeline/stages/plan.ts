import type { Json } from "../../core/canonical";
import { isPlainObject } from "../../core/canonical";
import type { Schema } from "../../core/schema";
import type { Actor, Where } from "../../core/types";
import type { Registry } from "../../modules/registry";
import { ContextError, packPart } from "../../agents/context";
import type { PackPart } from "../../agents/context";
import { buildPlan } from "../plans";
import { gapsPart, gleanPart } from "../glean";
import type { PlanOutput } from "../plans";
import type { StageEnd, StageEnv } from "../engine";
import { frameOf, lastPass, noSchema, requestsOfPass, stageAgent, stageOfRole, titleOf } from "./agent";

/** The `where` of the provider chosen for the first stage whose role is research; null when it cannot be resolved. */
function researchWhere(env: StageEnv): { where: Where } | null {
  const stage = env.deps.pipeline.stages.find((s) => s.role === "research");
  const choice = stage === undefined ? null : env.session.state.run.stages.find((s) => s.id === stage.id)?.model ?? null;
  const provider = choice === null ? null : env.deps.providers.get(choice.provider);
  return provider === null || provider === undefined ? null : { where: provider.where };
}

/**
 * What the planner's answer may name: the registry's observable types, the playbooks it may plan (loaded, no costly lookup and, when `limits`
 * is given, no unconfirmed source those limits rule out) and the pivots.
 */
export interface PlanChoices { types: string[]; playbooks: string[]; pivots: string[] }
export function planChoices(registry: Registry, limits: { allow_unconfirmed: boolean } = { allow_unconfirmed: true }): PlanChoices {
  return {
    types: registry.types().map((t) => t.id),
    playbooks: registry.playbooks().filter((p) => registry.whyNotPlannable(p, limits) === null).map((p) => p.id),
    pivots: registry.pivots().map((p) => p.id),
  };
}

/**
 * The plan-output schema narrowed to what exists: a sub-goal's want and each have's type are one of the types, a route's items one of the
 * pivots, and the playbook one of the playbooks it may plan; with none, the sub-goal has no playbook property. A schema without these
 * properties is unchanged where they are missing; the given schema is never changed.
 */
export function planSchema(schema: Schema, c: PlanChoices): Schema {
  const goals = schema.properties?.subgoals;
  const item = goals?.items;
  if (goals === undefined || item?.properties === undefined) return schema;
  const props: Record<string, Schema> = { ...item.properties };
  const { want, have, route, playbook } = props;
  if (want !== undefined) props.want = { ...want, enum: [...c.types] };
  const haveType = have?.items?.properties?.type;
  if (have !== undefined && haveType !== undefined) {
    props.have = { ...have, items: { ...have.items!, properties: { ...have.items!.properties, type: { ...haveType, enum: [...c.types] } } } };
  }
  if (route?.items !== undefined) props.route = { ...route, items: { ...route.items, enum: [...c.pivots] } };
  if (playbook !== undefined) {
    if (c.playbooks.length === 0) delete props.playbook;
    else props.playbook = { ...playbook, enum: [...c.playbooks] };
  }
  const required = item.required?.filter((r) => Object.hasOwn(props, r));
  const narrowed: Schema = { ...item, properties: props, ...(required === undefined ? {} : { required }) };
  return { ...schema, properties: { ...schema.properties, subgoals: { ...goals, items: narrowed } } };
}

/** The re-ask's sentences for a planner's answer that names what does not exist: each wrong value, with the values allowed there. */
export function planExplain(c: PlanChoices): (answer: Json) => string[] {
  const oneOf = (at: string, allowed: string[]): string => (allowed.length === 0 ? `${at} must be left out: there is none to name` : `${at} must be one of: ${allowed.join(", ")}`);
  return (answer) => {
    if (!isPlainObject(answer) || !Array.isArray(answer.subgoals)) return [];
    const out: string[] = [];
    answer.subgoals.forEach((g, i) => {
      if (!isPlainObject(g)) return;
      const at = `subgoals[${i}]`;
      if (typeof g.want === "string" && !c.types.includes(g.want)) out.push(oneOf(`${at}.want`, c.types));
      if (Array.isArray(g.have)) {
        g.have.forEach((h, n) => {
          if (isPlainObject(h) && typeof h.type === "string" && !c.types.includes(h.type)) out.push(oneOf(`${at}.have[${n}].type`, c.types));
        });
      }
      if (Array.isArray(g.route)) {
        g.route.forEach((p, n) => { if (typeof p === "string" && !c.pivots.includes(p)) out.push(oneOf(`${at}.route[${n}]`, c.pivots)); });
      }
      if (g.playbook !== undefined && !(typeof g.playbook === "string" && c.playbooks.includes(g.playbook))) out.push(oneOf(`${at}.playbook`, c.playbooks));
    });
    return out;
  };
}

/** Plan: the planner names a route per sub-goal; code checks each against the route finder and builds the plan, which is only a proposal. */
export async function planRunner(env: StageEnv): Promise<StageEnd> {
  const { session, deps, stage } = env;
  const stalled = noSchema(env);
  if (stalled !== null) return stalled;
  const state = session.state;
  const entries = session.entries();
  const frameStage = stageOfRole(env, "frame");
  const frameOut = frameStage === null ? null : lastPass(session, frameStage);
  const extras: PackPart[] = [];
  try {
    // Frame's output is text a model wrote: as strict as the requests of that pass
    if (frameOut !== null) {
      extras.push(packPart({
        kind: "frame", id: "frame-output", title: "Frame's output", text: JSON.stringify(frameOut.output, null, 2), fixed: false,
        entries, written_by: requestsOfPass(entries, frameOut.entry), floor: null,
      }));
    }
  } catch (err) {
    if (err instanceof ContextError) return { kind: "stalled", reason: `${titleOf(env)}: ${err.message}` };
    throw err;
  }
  if (state.plan.status === "replanning") {
    const asked = [...entries].reverse().find((e) => e.type === "plan.replan_requested");
    if (asked !== undefined && asked.type === "plan.replan_requested") {
      extras.push(packPart({ kind: "note", id: "replan-note", title: "The person's re-plan note", text: asked.payload.note, fixed: false, entries, written_by: [asked], floor: null }));
    }
  }
  const actorId = deps.profile.stages[stage.id]?.agent ?? "planner";
  const frame = frameOf(env);
  // on a pass after a plan was accepted: what the values extracted since open up, listed by code (the sub-goal titles it quotes are as strict
  // as the plan that named them), and what a playbook the plan ran only in part would also have fetched
  let glean: PackPart | null = null;
  try {
    const proposed = [...entries].reverse().find((e) => e.type === "plan.proposed");
    glean = gleanPart(state, entries, { registry: deps.registry, seeker: deps.seeker }, frame.limits, proposed === undefined ? [] : [proposed]);
    if (glean !== null) extras.push(glean);
    const gaps = gapsPart(state, entries, deps.registry);
    if (gaps !== null) extras.push(gaps);
  } catch (err) {
    if (err instanceof ContextError) return { kind: "stalled", reason: `${titleOf(env)}: ${err.message}` };
    throw err;
  }
  const research = researchWhere(env);
  const m = state.meta;
  let task = [
    "Plan this investigation.",
    m === null ? "" : `The question asked: ${m.asked}`,
    `Reply with the goal and, for each sub-goal, its starting values, the type wanted and a route of pivot ids that the route finder offers (use find_routes).`,
    `Where a playbook fits a sub-goal (use list_playbooks), give its id as "playbook" and an empty route; code runs it with no further model call.`,
    glean === null ? "" : `The part titled "What the new values open up" lists values the workbench extracted since the plan was last accepted, with the pivots from each and the open sub-goals each bears on. Choose which, if any, to follow: a sub-goal may start from one of them.`,
  ].filter((x) => x !== "").join("\n");

  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    // the answer names only what exists, read now: the registry may have been reloaded since the run began
    const choices = planChoices(deps.registry, frame.limits);
    const end = await stageAgent(env, { actor_id: actorId, task, extras, narrow: (s) => planSchema(s, choices), explain: planExplain(choices) });
    if (end.kind !== "output") return end;
    const out = end.output as unknown as PlanOutput;
    const built = buildPlan("", out, deps, frame, research);
    if (!("errors" in built)) {
      session.commit((s, ids) => {
        // a person stopped the run while the planner was answering: nothing is proposed
        if (s.run.id !== state.run.id || s.run.status === "finished") return [];
        const plan = buildPlan(ids.next("plan"), out, deps, frame, research);
        if ("errors" in plan) throw new Error(`the plan could not be built: ${plan.errors.join("; ")}`);
        const actor = lastAgentActor(session, actorId);
        return [{ type: "plan.proposed", actor, run: s.run.id, stage: stage.id, payload: { plan } }];
      });
      if (session.state.run.id !== state.run.id || session.state.run.status === "finished") return { kind: "stopped" };
      return { kind: "finished", outcome: "pass", draft_hash: null, output: end.output as Json, reason: null };
    }
    errors = built.errors;
    // the reasons quote the planner's own output: text a model wrote, as strict as the request that produced it
    const fresh = session.entries();
    const asked = [...fresh].reverse().find((e) => e.type === "model.request" && e.stage === stage.id);
    const reasons = packPart({
      kind: "note", id: "plan-refusal", title: "Why the plan was refused", text: errors.map((e) => `- ${e}`).join("\n"), fixed: false,
      entries: fresh, written_by: asked === undefined ? [] : [asked], floor: null,
    });
    const at = extras.findIndex((x) => x.id === "plan-refusal");
    if (at >= 0) extras[at] = reasons; else extras.push(reasons);
    task = 'Your plan was refused by the route finder. The reasons are in the part titled "Why the plan was refused". Reply again with the whole plan, using only routes it offers.';
  }
  return { kind: "stalled", reason: `Plan: the planner's routes were refused twice: ${errors.join("; ")}` };
}

/** The agent actor the planner's last request was made as. */
function lastAgentActor(session: StageEnv["session"], actorId: string): Extract<Actor, { kind: "agent" }> {
  const e = [...session.entries()].reverse().find((x) => x.type === "model.request" && x.actor.kind === "agent" && x.actor.id === actorId);
  if (e === undefined || e.actor.kind !== "agent") throw new Error("the planner made no request");
  return e.actor;
}

