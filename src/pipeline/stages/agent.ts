import type { Json } from "../../core/canonical";
import { parseJson } from "../../core/canonical";
import type { Schema } from "../../core/schema";
import type { CaseSession } from "../../core/session";
import { runUsage } from "../../core/state";
import type { Actor, Draft, Entry, ModelChoice, PackItem, TimeWindow } from "../../core/types";
import { ContextError, casePart, packPart, schemaOf, stageParts, withLive } from "../../agents/context";
import type { PackPart } from "../../agents/context";
import { memoryParts } from "../../agents/memory";
import type { CallRecord } from "../../agents/loop";
import { runAgent } from "../../agents/loop";
import { assemblePack, fitProblem, packBudget, slotContext } from "../../agents/pack";
import { DEFAULT_CONTEXT } from "../../agents/providers/local";
import type { ModelInfo, Provider } from "../../agents/providers/types";
import type { DraftWork, Forced } from "../../agents/draft";
import { citedOf } from "../../agents/draft";
import type { ToolContext, ToolName } from "../../agents/tools";
import type { SeekLimits } from "../../modules/seeker";
import { DEFAULT_LIMITS } from "../../modules/seeker";
import type { StageEnd, StageEnv } from "../engine";
import type { Role } from "../manifests";
import type { Registry } from "../../modules/registry";
import type { Components } from "../components";
import { memoryUses } from "../loops";
import { questionsPart } from "../questions";

export type AgentStageEnd = { kind: "output"; output: Json; calls: CallRecord[] } | Exclude<StageEnd, { kind: "finished" }>;

type AgentActor = Extract<Actor, { kind: "agent" }>;

const firstLine = (t: string): string => t.split("\n")[0]!.slice(0, 300);

/** The stage's title as the run knows it. */
export const titleOf = (env: StageEnv): string => env.session.state.run.stages.find((s) => s.id === env.stage.id)?.title ?? env.stage.title;

/** The models each provider listed in this process, the latest listing of each kept: a failed list read falls back on it. */
const listedBefore = new WeakMap<Provider, Map<string, ModelInfo>>();

/** The agent's actor and its provider and model, from the stage's chosen model; or why there is none. */
export async function resolveAgent(env: StageEnv, actorId: string, chosen?: ModelChoice): Promise<{ actor: AgentActor; provider: Provider; model: string; effort: string | null; /** tokens each request has */ context: number } | { stalled: string }> {
  const { state } = env.session;
  const title = titleOf(env);
  const choice = chosen ?? state.run.stages.find((s) => s.id === env.stage.id)?.model ?? null;
  if (choice === null) return { stalled: `${title}: no model is chosen for this stage. Choose one and resume.` };
  const provider = env.deps.providers.get(choice.provider);
  if (provider === null) return { stalled: `${title}: the provider "${choice.provider}" is not available. Choose another model and resume.` };
  let info: ModelInfo | undefined;
  try {
    const listed = await provider.models();
    const seen = listedBefore.get(provider) ?? new Map<string, ModelInfo>();
    for (const m of listed) seen.set(m.id, m);
    listedBefore.set(provider, seen);
    info = listed.find((m) => m.id === choice.model);
    if (info === undefined) return { stalled: `${title}: the provider "${choice.provider}" does not list the model "${choice.model}". Choose another model and resume.` };
  } catch (err) {
    // a busy endpoint may not answer a model list; a model this process saw listed is called all the same, and the call says what it finds
    info = listedBefore.get(provider)?.get(choice.model);
    if (info === undefined) {
      const why = firstLine(err instanceof Error ? err.message : String(err));
      return { stalled: `${title}: the model list of the provider "${choice.provider}" could not be read (${why}). Check that the endpoint answers and resume.` };
    }
  }
  const actor: AgentActor = { kind: "agent", id: actorId, stage: env.stage.id, profile: env.deps.profile.id, model: choice.model, effort: choice.effort, where: provider.where };
  return { actor, provider, model: choice.model, effort: choice.effort, context: slotContext(info.context ?? DEFAULT_CONTEXT, info.parallel) };
}

/** What every agent stage shares: the model, the pack, the actor, the tool context, the loop and what the loop ended with. */
export async function stageAgent(env: StageEnv, opts: {
  actor_id: string; task: string; extras: PackPart[]; subgoal?: string | null; job?: string | null;
  draft?: DraftWork | null; draft_hash?: string | null; onNeedsBudget?: ToolContext["onNeedsBudget"]; omit_tools?: readonly ToolName[];
  /** The output schema as this case's record allows it: applied to the schema in the pack and to the one the answer is held to (and sent as structured output). */
  narrow?: (s: Schema) => Schema;
  /** Sentences the re-ask adds for an answer that failed its schema. */
  explain?: (answer: Json) => string[];
  /** What the work still lacks (names): see AgentSpec.lacking. */
  lacking?: () => string[];
  lackingAsk?: (missing: string[]) => string;
  /** What is forced while something is lacking: see AgentSpec.force. */
  force?: (missing: string[]) => Forced | null;
  /** Cards the task is about (a reviewer's draft's cited cards): one the pack leaves out is named in the task. */
  cited?: readonly string[];
}): Promise<AgentStageEnd> {
  const { session, deps, stage } = env;
  const title = titleOf(env);
  const who = await resolveAgent(env, opts.actor_id);
  if ("stalled" in who) return { kind: "stalled", reason: who.stalled };
  const cap = stage.max_output_tokens ?? who.provider.max_output_tokens;
  if (who.provider.kind === "local") {
    const problem = cap === undefined ? null : fitProblem(who.context, cap);
    if (problem !== null) return { kind: "stalled", reason: `${title}: ${problem}` };
  }
  // the stage's fast model, when its manifest names one and it resolves; otherwise the stage's model takes every turn
  let fast: { provider: Provider; model: string; effort: string | null; context: number } | null = null;
  if (stage.fast_model != null) {
    const got = await resolveAgent(env, opts.actor_id, stage.fast_model);
    if (!("stalled" in got)) fast = { provider: got.provider, model: got.model, effort: got.effort, context: got.context };
    // a local fast model that cannot take the stage's reply cap beside its context is not used: the stage's model takes every turn
    if (fast !== null && fast.provider.kind === "local" && cap !== undefined && fitProblem(fast.context, cap) !== null) fast = null;
  }
  // read after the await: a person may have changed the case, the run or a stage limit while the model was being resolved
  const state = session.state;

  let pack: ReturnType<typeof assemblePack>;
  let schema: ReturnType<typeof schemaOf> | null = null;
  try {
    const asked = questionsPart(session, deps.registry);
    const from = contextFrom(deps);
    const uses = deps.lock === undefined ? [] : memoryUses(deps.lock).filter((u) => u.stage === stage.id);
    const parts = [
      ...stageParts(from, deps.profile, stage.id, { schema: stage.schema, objective: state.meta?.objective ?? null, ...(opts.narrow === undefined ? {} : { narrow: opts.narrow }) }), casePart(state),
      ...memoryParts(session, stage.id, uses, deps.registry), ...(asked === null ? [] : [asked]), ...opts.extras,
    ];
    if (stage.schema !== null) schema = opts.narrow === undefined ? schemaOf(from, stage.schema, stage.id) : opts.narrow(schemaOf(from, stage.schema, stage.id));
    pack = assemblePack(parts, { budget: packBudget(fast === null ? who.context : Math.min(who.context, fast.context)), case_marking: state.meta!.marking, max_marking: Object.hasOwn(state.pack_limits, stage.id) ? state.pack_limits[stage.id]! : null });
  } catch (err) {
    if (err instanceof ContextError) return { kind: "stalled", reason: `${title}: ${firstLine(err.message)}` };
    throw err;
  }
  if ("too_big" in pack) return { kind: "stalled", reason: `${title}: the fixed context does not fit this model` };
  const leftLine = citedLeftOutLine(pack.left_out, opts.cited ?? []);
  const task = leftLine === null ? opts.task : `${opts.task}\n${leftLine}`;

  const { window, limits } = frameOf(env);
  const end = await runAgent(session, {
    ...(fast === null ? {} : { fast: { provider: fast.provider, model: fast.model, effort: fast.effort } }),
    actor: who.actor, provider: who.provider, model: who.model, effort: who.effort, pack, task, tools: stage.tools.filter((t) => !(opts.omit_tools ?? []).includes(t)), schema,
    ...(stage.schema === null ? {} : { schema_id: stage.schema }),
    ...(opts.explain === undefined ? {} : { explain: opts.explain }),
    ...(opts.lacking === undefined ? {} : { lacking: opts.lacking }),
    ...(opts.lackingAsk === undefined ? {} : { lackingAsk: opts.lackingAsk }),
    ...(opts.force === undefined ? {} : { force: opts.force }),
    ...(stage.sampling === null || stage.sampling === undefined ? {} : { sampling: stage.sampling }),
    ...(stage.max_output_tokens === null || stage.max_output_tokens === undefined ? {} : { max_output_tokens: stage.max_output_tokens }),
    ...(stage.max_turns === null || stage.max_turns === undefined ? {} : { max_turns: stage.max_turns }),
    ...(stage.request_extra === null || stage.request_extra === undefined ? {} : { request_extra: stage.request_extra }),
    policy: deps.config.marking_policy, max_marking: Object.hasOwn(state.pack_limits, stage.id) ? state.pack_limits[stage.id]! : null,
    ctx: {
      session, deps: deps.runner, seeker: deps.seeker, actor: who.actor, link: { run: state.run.id, stage: stage.id, job: opts.job ?? null },
      draft: opts.draft ?? null, draft_hash: opts.draft_hash ?? null, subgoal: opts.subgoal ?? null, window, limits,
      ...(opts.onNeedsBudget === undefined ? {} : { onNeedsBudget: opts.onNeedsBudget }),
      max_open_questions: deps.config.questions.max_open, max_notes: deps.config.memory.max_notes,
    },
  });
  switch (end.kind) {
    case "done": return { kind: "output", output: end.output, calls: end.calls };
    case "invalid": return { kind: "stalled", reason: `${title}'s output failed its schema twice: ${end.returned} (${end.errors.join("; ")})` };
    case "declined": return { kind: "declined", reason: end.reason };
    case "blocked": return { kind: "blocked", marking: end.marking };
    case "error": if (end.cause === "context") return { kind: "stalled", reason: `${title}: ${end.message}. Lower this stage's max_output_tokens, or load the model with a larger context in one slot, and resume.` };
      return { kind: "stalled", reason: end.retried === true
      ? `${title}: ${end.message}. Try a lower effort or another model, and resume.`
      : `${title}: the model call failed: ${end.message}` };
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

/** The stage's latest stage.finished with outcome pass and an output, with that output; null when there is none. */
export function lastPass(session: CaseSession, stage: string): { output: Json; entry: Entry } | null {
  const entries = session.entries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type !== "stage.finished" || e.payload.stage !== stage || e.payload.outcome !== "pass" || e.payload.output === null) continue;
    const parsed = parseJson(session.blobs.text(e.payload.output.blob));
    return parsed === null ? null : { output: parsed.value, entry: e };
  }
  return null;
}

/** The output blob of the stage's latest stage.finished with outcome pass; null when there is none. */
export function lastOutput(session: CaseSession, stage: string): Json | null {
  return lastPass(session, stage)?.output ?? null;
}

/** The model requests of the stage pass that ended at this stage.finished: those made in the stage since its latest start before the end. */
export function requestsOfPass(entries: readonly Entry[], finished: Entry): Entry[] {
  if (finished.type !== "stage.finished") return [];
  const stage = finished.payload.stage;
  const started = entries.reduce((n, e) => (e.type === "stage.started" && e.payload.stage === stage && e.seq < finished.seq ? e.seq : n), 0);
  return entries.filter((e) => e.type === "model.request" && e.stage === stage && e.seq > started && e.seq < finished.seq);
}

/** The id of the pipeline's stage with this role; null when it has none. */
export const stageOfRole = (env: StageEnv, role: Role): string | null => env.deps.pipeline.stages.find((s) => s.role === role)?.id ?? null;

/** The window and limits Frame chose, with max_hops from the defaults; the case window and the defaults when there is no Frame output. */
export function frameOf(env: StageEnv): { window: TimeWindow; limits: SeekLimits } {
  const meta = env.session.state.meta;
  const fallback = { window: meta === null ? { from: null, to: null } : { ...meta.window }, limits: { ...DEFAULT_LIMITS } };
  const frame = stageOfRole(env, "frame");
  const out = frame === null ? null : lastOutput(env.session, frame);
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

/** Every card the draft cites, as pack parts: the findings' cards in finding order, then the rest of citedOf(draft). A card no longer in the case is left out. */
/** Where a stage's context is read: its loop's components (a case's objective and a person's lessons from the registry), or the registry's trusted roots when there is no loop. */
export function contextFrom(deps: Pick<StageEnv["deps"], "components" | "registry">): Components | Registry {
  return deps.components === undefined ? deps.registry : withLive(deps.components, deps.registry);
}

export function citedCardParts(session: CaseSession, registry: Registry, draft: Draft): PackPart[] {
  const first = [...new Set(draft.product.key_findings.flatMap((f) => f.cites))];
  const ids = [...first, ...citedOf(draft).filter((id) => !first.includes(id))];
  return ids.filter((id) => Object.hasOwn(session.state.cards, id)).map((id) => packPart({ card: session.state.cards[id]!, registry }));
}

/** The ids citedOf(draft) names that are not in the case, sorted as citedOf sorts. */
export function citedGone(session: CaseSession, draft: Draft): string[] {
  return citedOf(draft).filter((id) => !Object.hasOwn(session.state.cards, id));
}

/** The line a reviewer's task carries when the draft cites cards the case no longer holds; null when it holds them all. */
export function citedGoneLine(session: CaseSession, draft: Draft): string | null {
  const gone = citedGone(session, draft);
  return gone.length === 0 ? null : `Cited by the draft but no longer in the case: ${gone.join(", ")}. Say so; do not judge what they held.`;
}

/** The line a reviewer's task carries when cards the draft cites were left out of its pack (for size or by a limit); null when none was. */
export function citedLeftOutLine(leftOut: readonly PackItem[], cited: readonly string[]): string | null {
  const ids = leftOut.filter((i) => i.kind === "card" && cited.includes(i.id)).map((i) => i.id);
  return ids.length === 0 ? null : `Cited by the draft but left out of your context: ${ids.join(", ")}. Read one you need with read_card; do not judge what you have not read.`;
}

/** The ids citedOf(draft) names whose cards a person has discarded, sorted as citedOf sorts. */
export function citedDiscarded(session: CaseSession, draft: Draft): string[] {
  return citedOf(draft).filter((id) => Object.hasOwn(session.state.cards, id) && session.state.cards[id]!.place === "discarded");
}

/** The line a reviewer's task carries when the draft cites cards a person has discarded; null when it cites none. */
export function citedDiscardedLine(session: CaseSession, draft: Draft): string | null {
  const gone = citedDiscarded(session, draft);
  return gone.length === 0 ? null : `Cited by the draft but discarded from the case: ${gone.join(", ")}. Say so where a finding rests on them.`;
}

/** The draft's product as a part the model cannot lose from its context. It carries the product's marking. */
export function draftPart(session: CaseSession, draft: Draft): PackPart {
  return packPart({
    kind: "draft", id: `draft-${draft.n}`, title: `Draft ${draft.n} (${draft.hash.slice(0, 12)})`, text: JSON.stringify(draft.product, null, 2), fixed: true,
    entries: session.entries(), written_by: [], floor: draft.product.marking,
  });
}
