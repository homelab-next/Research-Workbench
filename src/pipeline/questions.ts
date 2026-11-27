// Questions put to the person (slice 8): the person's answer as a card of theirs, and the run's questions as one pack part every agent stage sees.
import { ContextError, packPart } from "../agents/context";
import type { PackPart } from "../agents/context";
import { CARD_REF, FORM_EXCEPTIONS } from "../agents/draft";
import { scrub } from "../agents/tools/kit";
import type { CaseSession } from "../core/session";
import { runQuestions } from "../core/state";
import type { QuestionState } from "../core/state";
import { MARKINGS, strictest } from "../core/types";
import type { Actor, Entry, Marking, Observable, PersonBasis } from "../core/types";
import type { Registry } from "../modules/registry";
import type { RunnerDeps } from "../modules/runner";
import { checkStatement, personCard, PersonRefused } from "./person";

const TITLE_CHARS = 60;

const oneLine = (t: string): string => t.replace(/\s+/g, " ").trim();
/** "Answer to ask-1: <the question, cut at 60 characters with …>". */
const answerTitle = (q: QuestionState): string => {
  const text = oneLine(q.text);
  return `Answer to ${q.id}: ${text.length > TITLE_CHARS ? `${text.slice(0, TITLE_CHARS)}…` : text}`;
};

const askedEntry = (session: CaseSession, q: QuestionState): Entry | null => session.entries().find((e) => e.seq === q.seq) ?? null;

/** The marking of the request that wrote the question; null when it cannot be known. */
export function questionMarking(session: CaseSession, q: QuestionState): Marking | null {
  const e = askedEntry(session, q);
  if (e === null) return null;
  try {
    return packPart({ kind: "note", id: q.id, title: "", text: "", fixed: false, entries: session.entries(), written_by: [e], floor: null }).marking;
  } catch (err) {
    if (err instanceof ContextError) return null;
    throw err;
  }
}

/** Records the person's answer: a statement card that answers the question, and question.answered naming it, in one commit. Returns the card id. Throws PersonRefused. */
export function answerQuestion(session: CaseSession, deps: RunnerDeps, input: { actor: Actor; question: string; answer: string; basis: PersonBasis; detail: string; about: Observable[] | null; marking: Marking | null }): string {
  if (input.actor.kind !== "human") throw new PersonRefused("only a person may answer a question");
  const state = session.state;
  const q = Object.hasOwn(state.questions, input.question) ? state.questions[input.question]! : null;
  if (q === null) throw new PersonRefused(`there is no question ${input.question.slice(0, 40)}`);
  if (q.answer !== null) throw new PersonRefused(`${q.id} is already answered (card ${q.answer.card}); add a statement to correct it`);
  if (input.answer.trim() === "") throw new PersonRefused("an answer needs text");
  const caseMarking = state.meta?.marking ?? "TLP:RED";
  if (input.marking !== null && MARKINGS.indexOf(input.marking) < MARKINGS.indexOf(caseMarking)) throw new PersonRefused(`an answer cannot be marked below the case's ${caseMarking}`);
  const about = input.about ?? q.about;
  const asked = questionMarking(session, q);
  // no request to read the marking from: the answer is as strict as can be
  const marking = checkStatement(session, deps, { actor: input.actor, statement: input.answer, detail: input.detail, about, marking: input.marking }, [asked ?? "TLP:RED"]);
  const detail = input.detail.trim();
  let id = "";
  session.commit((s, ids) => {
    const now = Object.hasOwn(s.questions, q.id) ? s.questions[q.id]! : null;
    if (now !== null && now.answer !== null) throw new PersonRefused(`${q.id} is already answered (card ${now.answer.card}); add a statement to correct it`);
    id = ids.next("card");
    const card = personCard(id, { title: answerTitle(q), statement: input.answer, basis: input.basis, detail, about, answers: q.id, marking });
    return [
      { type: "card.created", actor: input.actor, cause: q.seq, payload: { card } },
      { type: "question.answered", actor: input.actor, cause: q.seq, payload: { question: q.id, card: id } },
    ];
  });
  return id;
}

/** Names joined for a sentence: "ask-1", "ask-1 and ask-2", "ask-1, ask-2 and ask-3". */
const andList = (ids: readonly string[]): string => (ids.length < 2 ? ids.join("") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)!}`);

/** Why a run paused after a pass: "waiting for the person's answer to ask-1. Answer it in the Narrative lens, or resume to go on without it." */
export function waitingReason(waiting: readonly QuestionState[]): string {
  const it = waiting.length === 1 ? "it" : "them";
  return `waiting for the person's answer to ${andList(waiting.map((q) => q.id))}. Answer ${it} in the Narrative lens, or resume to go on without ${it}.`;
}

export const OPEN_QUESTIONS = "Questions the person has not answered:";

/**
 * gaps_and_limits with the note of open questions: any earlier note (from OPEN_QUESTIONS to FORM_EXCEPTIONS, or to the end) is replaced, it sits
 * before the form exceptions note, and with no open question none is left. A card id in a question is written "card <n>", so the note cites no card.
 */
export function withOpenQuestions(gaps: string, open: readonly { id: string; text: string }[]): string {
  const at = gaps.indexOf(OPEN_QUESTIONS);
  const fx = gaps.indexOf(FORM_EXCEPTIONS, at < 0 ? 0 : at);
  if (at < 0 && open.length === 0) return gaps;
  const own = gaps.slice(0, at >= 0 ? at : fx >= 0 ? fx : gaps.length).replace(/\s+$/, "");
  const tail = fx < 0 ? "" : gaps.slice(fx);
  const plain = (t: string): string => t.replace(CARD_REF, (id) => `card ${id.slice(1)}`).replace(/\s+/g, " ").trim();
  const note = open.length === 0 ? "" : `${OPEN_QUESTIONS}\n${open.map((q) => `- ${q.id}: ${plain(q.text)}`).join("\n")}`;
  return [own, note, tail].filter((x) => x !== "").join("\n\n");
}

const LEAD = "Questions put to the person in this run. An answer is a card: cite it like any card, and say the finding rests on the person's word.";

/** The run's questions as one pack part: who asked, the text, and the answer or that there is none. Null when the run has none. Throws ContextError as packPart does. */
export function questionsPart(session: CaseSession, registry: Registry): PackPart | null {
  const state = session.state;
  const qs = runQuestions(state);
  if (qs.length === 0) return null;
  const titleOf = (stage: string | null): string => (stage === null ? "an agent" : state.run.stages.find((s) => s.id === stage)?.title ?? stage);
  const answers: Marking[] = [];
  const lines = qs.map((q) => {
    const head = `- ${q.id} (asked by ${titleOf(q.stage)}${q.blocking ? "; blocking" : ""}): ${scrub(registry, oneLine(q.text))}`;
    const card = q.answer === null || !Object.hasOwn(state.cards, q.answer.card) ? null : state.cards[q.answer.card]!;
    if (card !== null) {
      answers.push(card.marking);
      return `${head} Answered in card ${card.id}: ${scrub(registry, oneLine(card.body))}`;
    }
    if (q.waived !== null) return `${head} Not answered; the person went on without answering: name this under gaps_and_limits.`;
    return `${head} Not answered yet.`;
  });
  const entries = session.entries();
  const asked = qs.map((q) => entries.find((e) => e.seq === q.seq)).filter((e): e is Entry => e !== undefined);
  return packPart({
    kind: "note", id: "questions", title: "Questions put to the person", text: [LEAD, ...lines].join("\n"), fixed: true,
    entries, written_by: asked, floor: answers.length === 0 ? null : strictest(...answers),
  });
}
