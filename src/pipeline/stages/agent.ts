import type { Json } from "../../core/canonical";
import { parseJson } from "../../core/canonical";
import type { CaseSession } from "../../core/session";
import { runUsage } from "../../core/state";
import type { Actor, Draft, TimeWindow } from "../../core/types";
import { ContextError, cardPart, casePart, schemaOf, stageParts } from "../../agents/context";
import type { PackPart } from "../../agents/context";
import type { CallRecord } from "../../agents/loop";
import { runAgent } from "../../agents/loop";
import { assemblePack, packBudget } from "../../agents/pack";
import { DEFAULT_CONTEXT } from "../../agents/providers/local";
import type { Provider } from "../../agents/providers/types";
import type { DraftWork } from "../../agents/draft";
import type { ToolContext, ToolName } from "../../agents/tools";
import type { SeekLimits } from "../../modules/seeker";
import { DEFAULT_LIMITS } from "../../modules/seeker";
import type { StageEnd, StageEnv } from "../engine";

export type AgentStageEnd = { kind: "output"; output: Json; calls: CallRecord[] } | Exclude<StageEnd, { kind: "finished" }>;

type AgentActor = Extract<Actor, { kind: "agent" }>;

const firstLine = (t: string): string => t.split("\n")[0]!.slice(0, 300);

/** The stage's title as the run knows it. */
export const titleOf = (env: StageEnv): string => env.session.state.run.stages.find((s) => s.id === env.stage.id)?.title ?? env.stage.title;

/** The agent's actor and its provider and model, from the stage's chosen model; or why there is none. */
export async function resolveAgent(env: StageEnv, actorId: string): Promise<{ actor: AgentActor; provider: Provider; model: string; effort: string | null; context: number } | { stalled: string }> {
  const { state } = env.session;
  const title = titleOf(env);
  const choice = state.run.stages.find((s) => s.id === env.stage.id)?.model ?? null;
  if (choice === null) return { stalled: `${title}: no model is chosen for this stage. Choose one and resume.` };
  const provider = env.deps.providers.get(choice.provider);
  if (provider === null) return { stalled: `${title}: the provider "${choice.provider}" is not available. Choose another model and resume.` };
  const listed = await provider.models().catch(() => []);
  const info = listed.find((m) => m.id === choice.model);
  if (info === undefined) return { stalled: `${title}: the provider "${choice.provider}" does not list the model "${choice.model}". Choose another model and resume.` };
  const actor: AgentActor = { kind: "agent", id: actorId, stage: env.stage.id, profile: env.deps.profile.id, model: choice.model, effort: choice.effort, where: provider.where };
  return { actor, provider, model: choice.model, effort: choice.effort, context: info.context ?? DEFAULT_CONTEXT };
}

/** What every agent stage shares: the model, the pack, the actor, the tool context, the loop and what the loop ended with. */
export async function stageAgent(env: StageEnv, opts: {
  actor_id: string; task: string; extras: PackPart[]; subgoal?: string | null; job?: string | null;
  draft?: DraftWork | null; draft_hash?: string | null; onNeedsBudget?: ToolContext["onNeedsBudget"]; omit_tools?: readonly ToolName[];
}): Promise<AgentStageEnd> {
  const { session, deps, stage } = env;
  const title = titleOf(env);
  const who = await resolveAgent(env, opts.actor_id);
  if ("stalled" in who) return { kind: "stalled", reason: who.stalled };
  // read after the await: a person may have changed the case, the run or a stage limit while the model was being resolved
  const state = session.state;

  let pack: ReturnType<typeof assemblePack>;
  let schema: ReturnType<typeof schemaOf> | null = null;
  try {
    const parts = [...stageParts(deps.registry, deps.profile, stage.id, { schema: stage.schema, objective: state.meta?.objective ?? null }), casePart(state), ...opts.extras];
    if (stage.schema !== null) schema = schemaOf(deps.registry, stage.schema);
    pack = assemblePack(parts, { budget: packBudget(who.context), case_marking: state.meta!.marking, max_marking: Object.hasOwn(state.pack_limits, stage.id) ? state.pack_limits[stage.id]! : null });
  } catch (err) {
    if (err instanceof ContextError) return { kind: "stalled", reason: `${title}: ${firstLine(err.message)}` };
    throw err;
  }
  if ("too_big" in pack) return { kind: "stalled", reason: `${title}: the fixed context does not fit this model` };

  const { window, limits } = frameOf(session);
  const end = await runAgent(session, {
    actor: who.actor, provider: who.provider, model: who.model, effort: who.effort, pack, task: opts.task, tools: stage.tools.filter((t) => !(opts.omit_tools ?? []).includes(t)), schema,
    policy: deps.config.marking_policy, max_marking: Object.hasOwn(state.pack_limits, stage.id) ? state.pack_limits[stage.id]! : null,
    ctx: {
      session, deps: deps.runner, seeker: deps.seeker, actor: who.actor, link: { run: state.run.id, stage: stage.id, job: opts.job ?? null },
      draft: opts.draft ?? null, draft_hash: opts.draft_hash ?? null, subgoal: opts.subgoal ?? null, window, limits,
      ...(opts.onNeedsBudget === undefined ? {} : { onNeedsBudget: opts.onNeedsBudget }),
    },
  });
  switch (end.kind) {
    case "done": return { kind: "output", output: end.output, calls: end.calls };
    case "invalid": return { kind: "stalled", reason: `${title}'s output failed its schema twice: ${end.errors.join("; ")}` };
    case "declined": return { kind: "declined", reason: end.reason };
    case "blocked": return { kind: "blocked", marking: end.marking };
    case "error": return { kind: "stalled", reason: `${title}: the model call failed: ${end.message}` };
    case "stopped":
      if (end.why === "paused") return { kind: "stopped" };
      if (end.why === "budget") {
        const used = runUsage(session.state).usage;
        return { kind: "stalled", reason: `The model budget for this run is used up (${used.input + used.output} of ${session.state.run.budget_tokens} tokens). Raise it and resume.` };
      }
      return { kind: "stalled", reason: `${title}: the agent used all its turns without an answer` };
  }
}

/** The stall for a stage whose manifest names no output schema, or null when it names one. */
export function noSchema(env: StageEnv): StageEnd | null {
  return env.stage.schema === null ? { kind: "stalled", reason: `stage ${env.stage.id} has no output schema` } : null;
}

/** Why a window is not one the case may use: backwards, or not inside the case's own (open ends allow anything); null when it is fine. */
export function windowProblem(w: { from: string; to: string }, within: TimeWindow): string | null {
  if (!(w.from <= w.to)) return `the window from ${w.from} to ${w.to} ends before it begins`;
  if ((within.from !== null && w.from < within.from) || (within.to !== null && w.to > within.to)) {
    return `the window from ${w.from} to ${w.to} is not inside the case window (${within.from ?? "open"} to ${within.to ?? "open"})`;
  }
  return null;
}

/** The output blob of the stage's latest stage.finished with outcome pass; null when there is none. */
export function lastOutput(session: CaseSession, stage: string): Json | null {
  const entries = session.entries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type !== "stage.finished" || e.payload.stage !== stage || e.payload.outcome !== "pass" || e.payload.output === null) continue;
    const parsed = parseJson(session.blobs.text(e.payload.output.blob));
    return parsed === null ? null : parsed.value;
  }
  return null;
}

/** The window and limits Frame chose, with max_hops from the defaults; the case window and the defaults when there is no Frame output. */
export function frameOf(session: CaseSession): { window: TimeWindow; limits: SeekLimits } {
  const meta = session.state.meta;
  const fallback = { window: meta === null ? { from: null, to: null } : { ...meta.window }, limits: { ...DEFAULT_LIMITS } };
  const out = lastOutput(session, "frame");
  if (out === null || typeof out !== "object" || Array.isArray(out)) return fallback;
  const { window, limits } = out as { window?: { from?: unknown; to?: unknown }; limits?: { allow_unconfirmed?: unknown; max_weight?: unknown } };
  if (window === undefined || limits === undefined || typeof window.from !== "string" || typeof window.to !== "string") return fallback;
  if (windowProblem({ from: window.from, to: window.to }, fallback.window) !== null) return fallback;
  return {
    window: { from: window.from, to: window.to },
    limits: {
      allow_unconfirmed: limits.allow_unconfirmed === true,
      max_weight: typeof limits.max_weight === "number" && Number.isFinite(limits.max_weight) ? limits.max_weight : null,
      max_hops: DEFAULT_LIMITS.max_hops,
    },
  };
}

/** The agent actor the named agent's latest model request was made as; throws when it made none. */
export function agentActor(session: CaseSession, actorId: string): AgentActor {
  const e = [...session.entries()].reverse().find((x) => x.type === "model.request" && x.actor.kind === "agent" && x.actor.id === actorId);
  if (e === undefined || e.actor.kind !== "agent") throw new Error(`${actorId} made no request`);
  return e.actor;
}

/** The cards a draft's findings cite, as pack parts (a card that no longer exists is left out). */
export function citedCardParts(session: CaseSession, draft: Draft): PackPart[] {
  const ids = [...new Set(draft.product.key_findings.flatMap((f) => f.cites))];
  return ids.filter((id) => Object.hasOwn(session.state.cards, id)).map((id) => cardPart(session.state.cards[id]!));
}

/** The draft's product as a part the model cannot lose from its context. */
export function draftPart(draft: Draft): PackPart {
  return { kind: "draft", id: `draft-${draft.n}`, title: `Draft ${draft.n} (${draft.hash.slice(0, 12)})`, text: JSON.stringify(draft.product, null, 2), marking: draft.product.marking, fixed: true };
}
