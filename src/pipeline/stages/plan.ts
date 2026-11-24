import type { Json } from "../../core/canonical";
import type { Actor, Where } from "../../core/types";
import type { PackPart } from "../../agents/context";
import { buildPlan } from "../plans";
import type { PlanOutput } from "../plans";
import type { StageEnd, StageEnv } from "../engine";
import { frameOf, lastOutput, noSchema, stageAgent } from "./agent";

/** The `where` of the provider chosen for the first stage whose role is research; null when it cannot be resolved. */
function researchWhere(env: StageEnv): { where: Where } | null {
  const stage = env.deps.pipeline.stages.find((s) => s.role === "research");
  const choice = stage === undefined ? null : env.session.state.run.stages.find((s) => s.id === stage.id)?.model ?? null;
  const provider = choice === null ? null : env.deps.providers.get(choice.provider);
  return provider === null || provider === undefined ? null : { where: provider.where };
}

/** Plan: the planner names a route per sub-goal; code checks each against the route finder and builds the plan, which is only a proposal. */
export async function planRunner(env: StageEnv): Promise<StageEnd> {
  const { session, deps, stage } = env;
  const stalled = noSchema(env);
  if (stalled !== null) return stalled;
  const state = session.state;
  const frameOut = lastOutput(session, "frame");
  const extras: PackPart[] = [];
  if (frameOut !== null) extras.push({ kind: "frame", id: "frame-output", title: "Frame's output", text: JSON.stringify(frameOut, null, 2), marking: null, fixed: false });
  if (state.plan.status === "replanning") {
    const asked = [...session.entries()].reverse().find((e) => e.type === "plan.replan_requested");
    if (asked !== undefined && asked.type === "plan.replan_requested") {
      extras.push({ kind: "note", id: "replan-note", title: "The person's re-plan note", text: asked.payload.note, marking: null, fixed: false });
    }
  }
  const actorId = deps.profile.stages[stage.id]?.agent ?? "planner";
  const frame = frameOf(session);
  const research = researchWhere(env);
  const m = state.meta;
  let task = [
    "Plan this investigation.",
    m === null ? "" : `The question asked: ${m.asked}`,
    `Reply with the goal and, for each sub-goal, its starting values, the type wanted and a route of pivot ids that the route finder offers (use find_routes).`,
  ].filter((x) => x !== "").join("\n");

  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const end = await stageAgent(env, { actor_id: actorId, task, extras });
    if (end.kind !== "output") return end;
    const out = end.output as unknown as PlanOutput;
    const built = buildPlan("", out, deps, frame, research);
    if (!("errors" in built)) {
      session.commit((s, ids) => {
        const plan = buildPlan(ids.next("plan"), out, deps, frame, research);
        if ("errors" in plan) throw new Error(`the plan could not be built: ${plan.errors.join("; ")}`);
        const actor = lastAgentActor(session, actorId);
        return [{ type: "plan.proposed", actor, run: s.run.id, stage: stage.id, payload: { plan } }];
      });
      return { kind: "finished", outcome: "pass", draft_hash: null, output: end.output as Json, reason: null };
    }
    errors = built.errors;
    task = `Your plan was refused by the route finder:\n${errors.map((e) => `- ${e}`).join("\n")}\nReply again with the whole plan, using only routes it offers.`;
  }
  return { kind: "stalled", reason: `Plan: the planner's routes were refused twice: ${errors.join("; ")}` };
}

/** The agent actor the planner's last request was made as. */
function lastAgentActor(session: StageEnv["session"], actorId: string): Extract<Actor, { kind: "agent" }> {
  const e = [...session.entries()].reverse().find((x) => x.type === "model.request" && x.actor.kind === "agent" && x.actor.id === actorId);
  if (e === undefined || e.actor.kind !== "agent") throw new Error("the planner made no request");
  return e.actor;
}
