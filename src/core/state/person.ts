// The person (slice 8): questions an agent puts to them, their answers, their statements, and their overrules. Browser-safe: imports only src/core.
import { CONFIDENCES } from "../types";
import type { Card, Entry, PersonBasis, Product, Question } from "../types";
import { holds, keepsValue, namesFinding, revisedRulingReason, ruledFindings, rulingText } from "./conflicts";
import { has, isBool, isObj, isOneOf, isStr, isStrList, isStrOrNull, malformed, recordSkip } from "./guards";
import { isObservable } from "./shapes";
import { PROBE_ACTOR_ID } from "./improve";
import type { CaseState, Overrule, OverruleState, QuestionState } from "./types";

/** The source a finding names when it rests on the person's word. */
export const PERSON_SOURCE = "the person";

/** How the person knows, in words. */
export const BASIS_TEXT: Record<PersonBasis, string> = { saw: "saw it myself", did: "did it myself", told: "was told", unstated: "did not say how" };

/** True for a person's statement: a card with `person`. made_by "human" alone does not say so (a pivot a person runs makes one too). */
export const isPersonCard = (c: Pick<Card, "person">): boolean => c.person !== undefined;

const isQuestion = (x: unknown): x is Question =>
  isObj(x) && isStr(x.id) && isStr(x.text) && isStr(x.why) && isStrList(x.cards) && Array.isArray(x.about) && x.about.every(isObservable) && isBool(x.blocking);

const isOverrulePayload = (x: Record<string, unknown>): boolean =>
  isStr(x.finding) && isStr(x.draft_hash) && isStrOrNull(x.likelihood) && (x.confidence === null || isOneOf(x.confidence, CONFIDENCES))
  && (x.stays === null || isBool(x.stays)) && isStr(x.note);

/** True for an overrule with nothing set: it withdraws the one before it. */
const withdrawn = (o: Overrule): boolean => o.likelihood === null && o.confidence === null && o.stays === null;

/**
 * Questions, answers, the waiver a person's resume of a question hold makes, and overrules. Runs before applyRun, which clears the hold.
 * An overrule is a person's, gives a note, and is of a finding some draft has held; the latest of a finding replaces the one before it whole.
 */
export function applyPerson(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "question.asked": {
      const q = entry.payload.question;
      if (!isQuestion(q)) return malformed(s, entry);
      if (entry.actor.kind !== "agent") return recordSkip(s, entry, "a question to the person is an agent's");
      if (!/^ask-[1-9]\d*$/.test(q.id)) return recordSkip(s, entry, "a question's id is ask-<n>");
      if (q.text.trim() === "") return recordSkip(s, entry, "a question needs text");
      if (has(s.questions, q.id)) return s;
      const stage = isStr(entry.stage) ? entry.stage : entry.actor.stage;
      const state: QuestionState = {
        id: q.id, text: q.text, why: q.why, cards: [...q.cards], about: q.about.map((o) => ({ type: o.type, value: o.value })), blocking: q.blocking,
        run: s.run.id, stage, by: entry.actor.id, seq: entry.seq, ts: entry.ts, answer: null, waived: null,
      };
      return { ...s, questions: { ...s.questions, [q.id]: state } };
    }
    case "question.answered": {
      const { question, card } = entry.payload;
      if (!isStr(question) || !isStr(card)) return malformed(s, entry);
      if (entry.actor.kind !== "human") return recordSkip(s, entry, "an answer is a person's");
      if (!has(s.questions, question) || s.questions[question]!.answer !== null) return s;
      const c = has(s.cards, card) ? s.cards[card]! : null;
      if (c === null || c.person === undefined || c.person.answers !== question) return recordSkip(s, entry, "an answer names the person's card that answers the question");
      const q = s.questions[question]!;
      return { ...s, questions: { ...s.questions, [question]: { ...q, answer: { card, by: entry.actor.id, seq: entry.seq, ts: entry.ts } } } };
    }
    case "finding.overruled": {
      const p = entry.payload;
      if (!isOverrulePayload(p)) return malformed(s, entry);
      if (entry.actor.kind !== "human") return recordSkip(s, entry, "an overrule is a person's");
      if (p.note.trim() === "") return recordSkip(s, entry, "an overrule gives a note");
      if (p.likelihood !== null && p.likelihood.trim() === "") return recordSkip(s, entry, "a likelihood needs a term");
      if (p.stays === false && (p.likelihood !== null || p.confidence !== null)) return recordSkip(s, entry, "a dropped finding has no likelihood or confidence to set");
      if (!s.drafts.some((d) => d.product.key_findings.some((f) => f.id === p.finding))) return s;
      const o: Overrule = {
        finding: p.finding, draft_hash: p.draft_hash, likelihood: p.likelihood, confidence: p.confidence, stays: p.stays, note: p.note,
        by: entry.actor.id, seq: entry.seq, ts: entry.ts,
      };
      const was = has(s.overrules, p.finding) ? s.overrules[p.finding]! : null;
      const earlier: Overrule[] = was === null ? [] : [...was.earlier, overruleOf(was)];
      return { ...s, overrules: { ...s.overrules, [p.finding]: { ...o, earlier } } };
    }
    case "run.resumed": {
      // a person going on without the answer waives the questions the run was held for; in a probe child, where no person is there to answer,
      // improve-probe goes on without it the same way (probeVeto has skipped that actor anywhere else)
      const hold = s.run.hold;
      const byProbe = entry.actor.kind === "system" && entry.actor.id === PROBE_ACTOR_ID && s.improve.probe_of !== null;
      if (s.run.status !== "paused" || (entry.actor.kind !== "human" && !byProbe) || hold === null || hold.kind !== "question") return s;
      const waiting = waitingOn(s, hold.stage);
      if (waiting.length === 0) return s;
      const waived = { by: entry.actor.id, seq: entry.seq, ts: entry.ts };
      // fromEntries and spread define own properties, so an id of "__proto__" is an ordinary key
      return { ...s, questions: { ...s.questions, ...Object.fromEntries(waiting.map((q) => [q.id, { ...q, waived: { ...waived } }])) } };
    }
    default:
      return s;
  }
}

/** The questions of the current run, in the order asked. */
export function runQuestions(state: Readonly<CaseState>): QuestionState[] {
  const run = state.run.id;
  return Object.values(state.questions).filter((q) => run !== null && q.run === run).sort((a, b) => a.seq - b.seq);
}

/** runQuestions without an answer (waived ones included). */
export const openQuestions = (state: Readonly<CaseState>): QuestionState[] => runQuestions(state).filter((q) => q.answer === null);

/** The open, blocking, not waived questions the stage asked in the current run. */
export const waitingOn = (state: Readonly<CaseState>, stage: string): QuestionState[] =>
  openQuestions(state).filter((q) => q.stage === stage && q.blocking && q.waived === null);

/** An overrule's own fields, without the ones it replaced. */
function overruleOf(o: OverruleState): Overrule {
  const { finding, draft_hash, likelihood, confidence, stays, note, by, seq, ts } = o;
  return { finding, draft_hash, likelihood, confidence, stays, note, by, seq, ts };
}

/**
 * The overrules that set something (not withdrawn), in the order they were last made. An overrule that a ruling on the same finding, made after it
 * and keeping a value, has replaced is left out: the person's later act holds (final review I2; ruledFindings leaves out the other way round).
 */
export const activeOverrules = (state: Readonly<CaseState>): OverruleState[] =>
  Object.values(state.overrules).filter((o) => !withdrawn(o) && !Object.values(state.conflicts).some((c) => c.finding === o.finding && c.ruling !== null && c.ruling.seq > o.seq && keepsValue(c)))
    .sort((a, b) => a.seq - b.seq);

/** "likelihood almost certain, confidence high" | "must stay" | "dropped" | "overrule withdrawn". */
export function overruleSays(o: Overrule): string {
  const set: string[] = [];
  if (o.likelihood !== null) set.push(`likelihood ${o.likelihood}`);
  if (o.confidence !== null) set.push(`confidence ${o.confidence}`);
  if (set.length > 0) return set.join(", ");
  return o.stays === true ? "must stay" : o.stays === false ? "dropped" : "overrule withdrawn";
}

/** `${o.finding}: ${overruleSays(o)}. Note: ${o.note.trim()}`. */
export const overruleText = (o: Overrule): string => `${o.finding}: ${overruleSays(o)}. Note: ${o.note.trim()}`;

/**
 * Why the analyst is sent the overrule (controller ruling 5): code sets the values, and the analyst rewrites the finding's confidence_basis and
 * reasoning to rest on the person's note. A dropped finding is left out by code; a withdrawn overrule hands the finding back to the analyst.
 */
export function overruleReason(o: Overrule): string {
  if (withdrawn(o)) return `the person withdrew the overrule of ${o.finding}. Note: ${o.note.trim()} ${o.finding} is the analyst's to assess again.`;
  if (o.stays === false) return `the person overruled ${overruleText(o)} Code leaves ${o.finding} out.`;
  return `the person overruled ${overruleText(o)} Code holds ${o.finding} to it; rewrite ${o.finding}'s confidence_basis and reasoning to rest on the person's note.`;
}

/** Whether the product holds the overrule: absent when stays is false; otherwise present with each value that is set. Null for a withdrawn one. */
export function holdsOverrule(product: Product, o: Overrule): boolean | null {
  if (withdrawn(o)) return null;
  const f = product.key_findings.find((x) => x.id === o.finding);
  if (o.stays === false) return f === undefined;
  if (f === undefined) return false;
  return (o.likelihood === null || f.likelihood === o.likelihood) && (o.confidence === null || f.confidence === o.confidence);
}

const LIKELIHOOD = /likel|probab|chance|certain|overclaim|overstat|understat/i;
// whole words only: "confidence_basis" is a field, not a confidence to change
const CONFIDENCE = /\b(?:over|under|un)?confiden(?:ce|t)\b/i;
const RESTORE = /restor|reinstat|missing|bring back/i;
const DROP = /\b(?:drop|remov|delet|omit|withdraw)\w*/i;

// a point about how the finding is put (its reasoning, basis or wording), which the analyst rewrites to rest on the person's note
const WORDING = /\b(?:reasoning|reasons?|confidence_basis|basis|wording|worded|statement|argu\w*|explain\w*|rationale|justif\w*)\b/i;
// a point that asks for another value all the same
const ANOTHER_VALUE = /\b(?:should be|must be|lower\w*|rais\w*|reduc\w*|increas\w*|downgrad\w*|upgrad\w*|revert\w*|instead|chang\w* (?:it|the likelihood|the confidence)|move\w* (?:it|back))\b/i;

/**
 * Whether a reviewer's point would move the overruled finding back: it names the finding and speaks to what was set. A point about the finding's
 * reasoning, basis or wording that does not ask for another value is not (controller ruling on I4): it goes back to the analyst as usual.
 */
export function reopensOverrule(point: string, o: Overrule): boolean {
  if (!namesFinding(point, o.finding)) return false;
  const aboutWording = WORDING.test(point) && !ANOTHER_VALUE.test(point);
  return (o.likelihood !== null && LIKELIHOOD.test(point) && !aboutWording)
    || (o.confidence !== null && CONFIDENCE.test(point) && !aboutWording)
    || (o.stays === false && RESTORE.test(point))
    || (o.stays !== false && !withdrawn(o) && DROP.test(point));
}

/**
 * One line per ruling of the current run and per active overrule the product does not hold (a ruling an overrule has replaced gives none).
 * blockers() lists them: a draft that does not hold the person's word is not published.
 */
export function unheld(state: Readonly<CaseState>, product: Product): string[] {
  const out: string[] = [];
  for (const c of ruledFindings(state).values()) {
    if (holds(product, c) === false) out.push(`The draft does not hold your ruling on ${c.finding} (${rulingText(state, c)})`);
  }
  for (const o of activeOverrules(state)) {
    if (holdsOverrule(product, o) === false) out.push(`The draft does not hold your overrule of ${o.finding} (${overruleSays(o)})`);
  }
  return out;
}

/** A change of the person's since the latest draft was made: what "Send back to Assemble with my changes" sends, each with its reason (slice 10). `text` is
 * what the screen shows after the change's label (its finding's id, else its own id). */
export interface GateChange { kind: "overrule" | "ruling" | "answer"; id: string; finding: string | null; text: string; reason: string; seq: number }

/**
 * The person's changes since the latest draft was made, in the order made: each overrule (the latest of its finding, active or withdrawn), each
 * revised ruling, and each answer to a question. A question's text is a model's, so it is named by id only; the answer is a card the pack carries.
 * At the publish gate none of these sends work back by itself; the person sends them at once (slice 10, which reverses controller ruling 6).
 */
export function gateChanges(state: Readonly<CaseState>, entries: readonly Entry[]): GateChange[] {
  const d = state.drafts.length === 0 ? null : state.drafts[state.drafts.length - 1]!;
  if (d === null) return [];
  const made = entries.findLast((e) => e.type === "draft.revised" && (e.payload as { draft?: { hash?: unknown } }).draft?.hash === d.hash)?.seq ?? 0;
  const active = new Set(activeOverrules(state).map((o) => o.finding));
  const out: GateChange[] = [];
  for (const o of Object.values(state.overrules)) {
    if (o.seq <= made || !(active.has(o.finding) || withdrawn(o))) continue;
    // withdrawing an overrule that was itself made after the draft (never sent) changes nothing for the draft
    if (withdrawn(o) && (o.earlier.length === 0 || o.earlier[o.earlier.length - 1]!.seq > made)) continue;
    out.push({ kind: "overrule", id: o.finding, finding: o.finding, text: `overruled: ${overruleSays(o)}. Note: ${o.note.trim()}`, reason: overruleReason(o), seq: o.seq });
  }
  for (const c of Object.values(state.conflicts)) {
    if (c.ruling === null || c.ruling.seq <= made || c.earlier_rulings === undefined || c.earlier_rulings.length === 0) continue;
    out.push({ kind: "ruling", id: c.id, finding: c.finding, text: `revised the ruling on ${c.id}: ${rulingText(state, c)}`, reason: revisedRulingReason(state, c) ?? "", seq: c.ruling.seq });
  }
  for (const q of Object.values(state.questions)) {
    if (q.answer === null || q.answer.seq <= made) continue;
    out.push({ kind: "answer", id: q.id, finding: null, text: `answered: card ${q.answer.card}`, reason: `the person answered ${q.id}: their answer is card ${q.answer.card}, a statement of theirs; read it and say whether it changes any finding.`, seq: q.answer.seq });
  }
  return out.sort((a, b) => a.seq - b.seq);
}
