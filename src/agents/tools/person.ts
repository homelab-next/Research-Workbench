// ask_person (slice 8): a stage puts a question to the person running the investigation. Asking does not stop the agent's work.
import type { Json } from "../../core/canonical";
import { openQuestions, runQuestions } from "../../core/state";
import type { CaseState } from "../../core/state";
import type { Observable } from "../../core/types";
import { aboutProblem, MAX_ABOUT_VALUES } from "../../modules/about";
import type { ToolContext, ToolDef, ToolResult } from "./index";
import { idArg, MAX_TEXT, params, str, ToolError } from "./kit";

/** At most this many unanswered questions in a run, when the context gives no cap. */
export const DEFAULT_MAX_OPEN = 3;

const CARRY_ON = "carry on with what does not depend on the answer";

/** A question as compared for a repeat: white space folded and case ignored. */
const sameText = (t: string): string => t.replace(/\s+/g, " ").trim().toLowerCase();

const aboutOf = (v: Json | undefined): Observable[] =>
  Array.isArray(v) ? (v as { type: string; value: string }[]).map((o): Observable => ({ type: o.type, value: o.value })) : [];
const strings = (v: Json | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The stage's question the person went on without answering in this run, when there is one: its later questions do not block. */
const waivedOf = (state: Readonly<CaseState>, stage: string | null): string | null =>
  runQuestions(state).find((q) => q.stage === stage && q.waived !== null && q.answer === null)?.id ?? null;

async function askPerson(ctx: ToolContext, a: Record<string, Json>): Promise<ToolResult> {
  const max = ctx.max_open_questions ?? DEFAULT_MAX_OPEN;
  if (max <= 0) throw new ToolError("this root does not let a stage ask the person");
  const text = str(a.question);
  const cards = strings(a.cards);
  const about = aboutOf(a.about);
  const problem = aboutProblem(ctx.deps.registry, ctx.deps.observables, about);
  if (problem !== null) throw new ToolError(problem);
  const stage = ctx.link.stage ?? ctx.actor.stage;
  let id = "";
  let waived: string | null = null;
  // the count, the repeat and the append in one builder, so two agents asking at once cannot pass the cap
  ctx.session.commit((state, ids) => {
    for (const c of cards) {
      if (!Object.hasOwn(state.cards, c)) throw new ToolError(`unknown card: ${c}`);
      if (state.cards[c]!.place === "discarded") throw new ToolError(`card ${c} was discarded`);
    }
    const open = openQuestions(state);
    const repeat = open.find((q) => sameText(q.text) === sameText(text));
    if (repeat !== undefined) throw new ToolError(`that question is already open as ${repeat.id}`);
    if (open.length >= max) {
      const n = open.length;
      throw new ToolError(`${n} ${n === 1 ? "question to the person is" : "questions to the person are"} already open (${open.map((q) => q.id).join(", ")}); go on without asking another`);
    }
    waived = waivedOf(state, stage);
    id = ids.next("question");
    const question = { id, text, why: str(a.why), cards, about, blocking: a.blocking === true && waived === null };
    return [{ type: "question.asked", actor: ctx.actor, ...ctx.link, stage, payload: { question } }];
  });
  if (!Object.hasOwn(ctx.session.state.questions, id)) throw new ToolError("the question was not recorded");
  const blocking = ctx.session.state.questions[id]!.blocking;
  const status = waived === null ? `asked; ${CARRY_ON}` : `asked, not blocking: the person went on without answering ${waived}; ${CARRY_ON}`;
  return { ok: true, summary: `asked ${id}`, view: { question: id, blocking, status }, marking: null };
}

const value = { type: "string", minLength: 1, maxLength: MAX_TEXT } as const;
export const PERSON_TOOLS: ToolDef[] = [
  {
    name: "ask_person",
    description: "Ask the person running the investigation something no source holds: what a device is, where it is, who installed it, whether it is expected. They can go and look. Asking does not stop your work: carry on with what does not depend on the answer. Set blocking only when this stage's result would be wrong without the answer.",
    parameters: params({
      question: { type: "string", minLength: 1, maxLength: MAX_TEXT, pattern: "\\S", description: "the question, as the person will read it" },
      cards: { type: "array", items: idArg, maxItems: 20, description: "ids of the cards the question is about" },
      about: { type: "array", maxItems: MAX_ABOUT_VALUES, items: { type: "object", additionalProperties: false, required: ["type", "value"], properties: { type: idArg, value } }, description: "the values the question is about, each with its type" },
      blocking: { type: "boolean", description: "true only when this stage's result would be wrong without the answer" },
    }, ["question", "blocking"]),
    call: askPerson,
  },
];
