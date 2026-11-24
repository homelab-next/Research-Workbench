import type { Json } from "../core/canonical";
import { Refused } from "../core/refused";
import type { Schema } from "../core/schema";
import type { CaseSession } from "../core/session";
import { cardRefs, latestDraft } from "../core/state";
import type { Actor, Card, Entry, ModelChoice, Section } from "../core/types";
import type { AgentView, PartView } from "../core/wire";
import { ContextError, casePart, packPart, partOf, stageParts } from "../agents/context";
import type { PackPart } from "../agents/context";
import { runAgent } from "../agents/loop";
import { assemblePack, packBudget } from "../agents/pack";
import { DEFAULT_CONTEXT } from "../agents/providers/local";
import type { Provider } from "../agents/providers/types";
import { DEFAULT_LIMITS } from "../modules/seeker";
import type { EngineDeps } from "../pipeline/engine";
import { draftPart } from "../pipeline/stages/agent";
import { defineCommand } from "./commands";
import type { CommandContext } from "./commands";
import type { CaseHub } from "./hub";
import { modelsFor, shown } from "./views";

/** Asking the agent is refused: nothing was written. */
export class AskRefused extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "AskRefused";
  }
}

const STAGE = "agent";
const QUESTION_MAX = 4000;
const EXCERPT = 600;
const TITLE_CHARS = 60;
const NOTE_BODY = 4000;
/** An answer is clipped well inside the ledger's payload limit. */
const ANSWER_MAX = 60_000;
/** The kinds of manifest a person may add to one turn. */
const ADDABLE: readonly string[] = ["skill", "procedure", "reference", "lesson"];
const NO_MODEL = "Your agent has no model. Choose one in the Agent lens.";
const FIXED = "the base rules and the case cannot be left out";
const SECTION_TITLE = { summary: "Summary", gaps_and_limits: "Gaps and limits", alternatives: "Alternatives", assessment: "Assessment" } as const;
type AnswerSection = keyof typeof SECTION_TITLE;

const keyOf = (p: { kind: string; id: string }): string => `${p.kind}:${p.id}`;
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** The model your agent would use: the person's pick for stage `agent`, else the model of the pipeline's Assemble stage; with the provider that lists it. Null when there is none. */
interface Resolved { choice: ModelChoice; provider: Provider; context: number }
async function resolveModel(session: CaseSession, deps: EngineDeps): Promise<Resolved | null> {
  const { state } = session;
  const choice = Object.hasOwn(state.stage_models, STAGE) ? state.stage_models[STAGE]! : (deps.pipeline.stages.find((s) => s.role === "assemble")?.model ?? null);
  if (choice === null) return null;
  const provider = deps.providers.get(choice.provider);
  if (provider === null) return null;
  const listed = (await modelsFor(deps, state.meta?.marking ?? "TLP:RED")).find((m) => m.provider === choice.provider && m.model === choice.model);
  if (listed === undefined) return null;
  return { choice, provider, context: listed.context ?? DEFAULT_CONTEXT };
}

/** The parts your agent would be given now, in priority order, before anything is left out. Throws AskRefused for an added item that is not one a person may add. */
export function agentParts(session: CaseSession, deps: EngineDeps, added: readonly string[]): PackPart[] {
  const { state } = session;
  const { registry, profile } = deps;
  try {
    const parts: PackPart[] = [...stageParts(registry, profile, STAGE, { schema: null, objective: state.meta?.objective ?? null }), casePart(state)];
    const draft = latestDraft(state);
    if (draft !== null) parts.push(draftPart(session, draft));
    const kept = Object.values(state.cards).filter((c) => c.place === "lane").sort((a, b) => b.created_seq - a.created_seq);
    for (const card of kept) parts.push(packPart({ card, registry }));
    const entries = session.entries();
    for (const t of [...state.conversation].reverse()) {
      if (t.answer === null) continue;
      // the request that wrote the answer is exact even when two answers were being written at once
      const wrote = entries.find((e) => e.type === "model.request" && e.payload.request === t.request)
        ?? entries.findLast((e) => e.type === "agent.answered" && e.payload.turn === t.turn);
      parts.push(packPart({
        kind: "turn", id: t.turn, title: `Earlier: ${clip(t.asked, TITLE_CHARS)}`, text: `Asked: ${t.asked}\nAnswered: ${t.answer}`, fixed: false,
        entries, written_by: wrote === undefined ? [] : [wrote], floor: null,
      }));
    }
    for (const key of added) {
      const at = key.indexOf(":");
      const kind = at < 0 ? "" : key.slice(0, at);
      const id = at < 0 ? "" : key.slice(at + 1);
      if (!ADDABLE.includes(kind) || registry.get(kind, id) === null) throw new AskRefused(`unknown context item ${key}`);
      if (parts.some((p) => keyOf(p) === key)) continue;
      try {
        parts.push(partOf(registry, kind, id));
      } catch (err) {
        if (err instanceof ContextError) throw new AskRefused(`unknown context item ${key}`);
        throw err;
      }
    }
    return parts;
  } catch (err) {
    if (err instanceof ContextError) throw new AskRefused(err.message);
    throw err;
  }
}

/** The parts that go, after the person's left-out keys; a key that names nothing or a part that is fixed is refused. */
function without(parts: PackPart[], left_out: readonly string[]): PackPart[] {
  for (const key of left_out) {
    const part = parts.find((p) => keyOf(p) === key);
    if (part === undefined) throw new AskRefused(`unknown context item ${key}`);
    if (part.fixed) throw new AskRefused(FIXED);
  }
  return parts.filter((p) => !left_out.includes(keyOf(p)));
}

export async function agentView(session: CaseSession, deps: EngineDeps): Promise<AgentView> {
  const { state } = session;
  const parts = agentParts(session, deps, []);
  const have = new Set(parts.map(keyOf));
  const who = await resolveModel(session, deps);
  const addable = ADDABLE.flatMap((kind) => deps.registry.all(kind)
    .filter((m) => deps.registry.rootOf(m.path)?.trusted === true && !have.has(`${kind}:${m.id}`))
    .map((m) => ({ key: `${kind}:${m.id}`, title: shown(deps, m.title) })));
  const objective = state.meta?.objective ?? null;
  return {
    agent: deps.profile.stages[STAGE]?.agent ?? "assistant", profile: shown(deps, deps.profile.title),
    objective: objective === null ? null : shown(deps, deps.registry.get("objective", objective)?.title ?? objective),
    model: who?.choice ?? null, budget_chars: who === null ? null : packBudget(who.context),
    parts: parts.map((p): PartView => ({
      key: keyOf(p), kind: p.kind, id: p.id, title: shown(deps, p.title), chars: p.text.length, fixed: p.fixed, marking: p.marking, excerpt: shown(deps, p.text.slice(0, EXCERPT)),
    })),
    addable,
  };
}

/** One question after another per case, so two answers are never being written at once; it is not the case's command queue, which a slow model must not hold. */
const lines = new WeakMap<CaseHub, Map<string, Promise<unknown>>>();
function inTurn(hub: CaseHub, id: string, work: () => Promise<void>): Promise<void> {
  const mine = lines.get(hub) ?? new Map<string, Promise<unknown>>();
  lines.set(hub, mine);
  const after = mine.get(id) ?? Promise.resolve();
  const run = after.then(work, work);
  const tail = run.then(() => undefined, () => undefined);
  mine.set(id, tail);
  void tail.then(() => { if (mine.get(id) === tail) mine.delete(id); });
  return run;
}

/** Writes agent.asked and returns; the model turn goes on in the background and ends in agent.answered, or in the loop's own record of a decline, a block or an error. */
export async function ask(ctx: CommandContext, input: { text: string; left_out: string[]; added: string[] }, prepared?: unknown): Promise<void> {
  const { hub, session, deps, case: id } = ctx;
  const text = input.text.trim();
  if (text.length < 1 || text.length > QUESTION_MAX) throw new AskRefused("a question must be 1 to 4,000 characters");
  const who = (prepared as Resolved | undefined) ?? (await resolveModel(session, deps));
  if (who === null) throw new AskRefused(NO_MODEL);
  // everything that can be refused is checked before anything is written
  const first = assemblePack(without(agentParts(session, deps, input.added), input.left_out), { budget: packBudget(who.context), case_marking: session.state.meta!.marking, max_marking: null });
  if ("too_big" in first) throw new AskRefused("The fixed context does not fit this model.");
  let turn = "";
  session.commit((_s, ids) => {
    turn = ids.next("turn");
    return [{ type: "agent.asked", actor: ctx.actor, payload: { turn, text, left_out: [...input.left_out], added: [...input.added] } }];
  });
  hub.background(inTurn(hub, id, () => answer(ctx, who, { turn, text, left_out: input.left_out, added: input.added })));
}

async function answer(ctx: CommandContext, who: Resolved, q: { turn: string; text: string; left_out: string[]; added: string[] }): Promise<void> {
  const { session, deps } = ctx;
  const state = session.state;
  const pack = assemblePack(without(agentParts(session, deps, q.added), q.left_out), {
    budget: packBudget(who.context), case_marking: state.meta!.marking, max_marking: Object.hasOwn(state.pack_limits, STAGE) ? state.pack_limits[STAGE]! : null,
  });
  if ("too_big" in pack) throw new Error("the fixed context no longer fits the model");
  const actor: Extract<Actor, { kind: "agent" }> = {
    kind: "agent", id: deps.profile.stages[STAGE]?.agent ?? "assistant", stage: STAGE, profile: deps.profile.id, model: who.choice.model, effort: who.choice.effort, where: who.provider.where,
  };
  const window = state.meta === null ? { from: null, to: null } : { ...state.meta.window };
  const end = await runAgent(session, {
    actor, provider: who.provider, model: who.choice.model, effort: who.choice.effort, pack, task: q.text, tools: [], schema: null, outside_run: true,
    policy: deps.config.marking_policy, max_marking: Object.hasOwn(state.pack_limits, STAGE) ? state.pack_limits[STAGE]! : null,
    ctx: { session, deps: deps.runner, seeker: deps.seeker, actor, link: { run: null, stage: null, job: null }, draft: null, draft_hash: null, subgoal: null, window, limits: { ...DEFAULT_LIMITS } },
  });
  // anything but an answer has been recorded by the loop itself (a decline, a block, an error)
  if (end.kind !== "done") return;
  const request = session.entries().findLast((e) => e.type === "model.request" && e.actor.kind === "agent" && e.actor.id === actor.id && e.actor.stage === STAGE);
  if (request === undefined || request.type !== "model.request") throw new Error("the answer has no request");
  const text = clip(end.content.trim() === "" ? "The model returned no text." : end.content, ANSWER_MAX);
  const cites = [...new Set(cardRefs(text))].filter((c) => Object.hasOwn(session.state.cards, c));
  session.commit(() => [{ type: "agent.answered", actor, payload: { turn: q.turn, request: request.payload.request, text, cites } }]);
}

/** The answered turn and the request that wrote it; refuses a turn that is not answered. */
function answered(session: CaseSession, turn: string): { asked: string; text: string; cites: string[]; request: Extract<Entry, { type: "model.request" }> } {
  const t = session.state.conversation.find((x) => x.turn === turn);
  if (t === undefined || t.answer === null) throw new AskRefused(`there is no answered turn ${turn.slice(0, 40)}`);
  const request = session.entries().find((e) => e.type === "model.request" && e.payload.request === t.request);
  if (request === undefined || request.type !== "model.request" || request.actor.kind !== "agent") throw new AskRefused(`the answer to turn ${turn.slice(0, 40)} has no recorded request`);
  return { asked: t.asked, text: t.answer, cites: t.cites, request };
}

const str: Schema = { type: "string" };
const strings: Schema = { type: "array", items: str };
const obj = (properties: Record<string, Schema>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const arg = (a: Record<string, Json>, k: string): string => a[k] as string;

defineCommand("ask", {
  args: obj({ text: str, left_out: strings, added: strings }), then: "nothing",
  // listing the model can be slow: it is done before the case's queue is entered
  prepare: async ({ session, deps }): Promise<Resolved> => {
    const who = await resolveModel(session, deps);
    if (who === null) throw new AskRefused(NO_MODEL);
    return who;
  },
  perform: (ctx, a, prepared) => ask(ctx, { text: arg(a, "text"), left_out: a.left_out as string[], added: a.added as string[] }, prepared),
});

defineCommand("propose_answer", {
  args: obj({ turn: str, section: { enum: Object.keys(SECTION_TITLE) } }), then: "nothing",
  perform: ({ session }, a) => {
    const section = arg(a, "section") as AnswerSection;
    const got = answered(session, arg(a, "turn"));
    const by = got.request.actor as Extract<Actor, { kind: "agent" }>;
    session.commit((_s, ids) => [{
      type: "proposal.created", actor: by,
      payload: { proposal: { id: ids.next("proposal"), kind: "narrative", title: `Your agent's answer as ${SECTION_TITLE[section]}`, by: by.id, section: section as Section, text: got.text, cites: [...got.cites] } },
    }]);
  },
});

defineCommand("keep_answer", {
  args: obj({ turn: str }), then: "nothing",
  perform: ({ session }, a) => {
    const got = answered(session, arg(a, "turn"));
    const by = got.request.actor as Extract<Actor, { kind: "agent" }>;
    session.commit((_s, ids) => {
      const card: Card = {
        id: ids.next("card"), title: `Note: ${clip(got.asked, TITLE_CHARS)}`, body: clip(got.text, NOTE_BODY), kind: "note", made_by: "agent", query: null, columns: [], column_types: [],
        rows: [], row_count: 0, coverage: null, empty: null, marking: got.request.payload.marking, source: null, step: null, subgoal: null, why: got.asked, event_time: null, quality_notes: [],
      };
      return [{ type: "card.created", actor: by, payload: { card } }];
    });
  },
});
