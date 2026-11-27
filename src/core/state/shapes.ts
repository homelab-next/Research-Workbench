// Shape checks for the records the fold and the workbench share. Browser-safe: no runtime imports.
import { CARD_KINDS, CARD_MAKERS, EMPTY_MEANS, isMarking, PERSON_BASES, STAGE_OUTCOMES } from "../types";
import type { BlobRef, Card, ExtractedValue, Observable, Observed, Payloads, PersonStatement, Span, TimeWindow } from "../types";
import { isNum, isObj, isOneOf, isStr, isStrList, isStrOrNull } from "./guards";
import { isCoverage, isObserved } from "pivot/types";

export const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
export const isTimeWindow = (x: unknown): x is TimeWindow => isObj(x) && isStrOrNull(x.from) && isStrOrNull(x.to);
export const isObservable = (x: unknown): x is Observable => isObj(x) && isStr(x.type) && isStr(x.value);
/** The shape of a person's statement on a card: how they know, the detail, what it is about, and the question it answers (or null). */
export const isPersonStatement = (x: unknown): x is PersonStatement =>
  isObj(x) && isOneOf(x.basis, PERSON_BASES) && isStr(x.detail) && Array.isArray(x.about) && x.about.every(isObservable) && isStrOrNull(x.answers);

// isCoverage and isObserved are pivot's (the vocabulary it shares with the workbench), the same checks re-exported.
export { isCoverage, isObserved } from "pivot/types";

export const isCard = (x: unknown): x is Card =>
  isObj(x) && isStr(x.id) && isStr(x.title) && isStr(x.body) && isOneOf(x.kind, CARD_KINDS) && isOneOf(x.made_by, CARD_MAKERS)
  && isStrOrNull(x.query) && isStrList(x.columns) && Array.isArray(x.column_types) && x.column_types.every(isStrOrNull)
  && Array.isArray(x.rows) && x.rows.every(Array.isArray) && isCount(x.row_count)
  && (x.coverage === null || isCoverage(x.coverage)) && (x.empty === null || isOneOf(x.empty, EMPTY_MEANS))
  && isMarking(x.marking) && isStrOrNull(x.source) && isStrOrNull(x.step) && isStrOrNull(x.subgoal)
  && isStr(x.why) && isStrOrNull(x.event_time) && isStrList(x.quality_notes) && (x.observed === undefined || isObserved(x.observed))
  && (x.person === undefined || isPersonStatement(x.person))
  && (x.extracted === undefined || (Array.isArray(x.extracted) && x.extracted.every(isExtractedValue)));

/** The shape of one value an extract rule gave: code-derived, with its type, value, column, rule and a row count from 0. */
export const isExtractedValue = (x: unknown): x is ExtractedValue =>
  isObj(x) && isStr(x.type) && isStr(x.value) && isStr(x.column) && isStr(x.rule) && isCount(x.row) && x.by === "code";

/** The fields of a card and nothing else. */
export function cardFields(c: Card): Card {
  const { id, title, body, kind, made_by, query, columns, column_types, rows, row_count, coverage, empty, marking, source, step, subgoal, why, event_time, quality_notes } = c;
  const fields: Card = { id, title, body, kind, made_by, query, columns, column_types, rows, row_count, coverage, empty, marking, source, step, subgoal, why, event_time, quality_notes };
  const seen = c.observed === undefined ? fields : { ...fields, observed: observedFields(c.observed) };
  const observed = c.extracted === undefined ? seen
    : { ...seen, extracted: c.extracted.map((x): ExtractedValue => ({ type: x.type, value: x.value, column: x.column, rule: x.rule, row: x.row, by: "code" })) };
  if (c.person === undefined) return observed;
  const { basis, detail, about, answers } = c.person;
  return { ...observed, person: { basis, detail, about: about.map((o) => ({ type: o.type, value: o.value })), answers } };
}

/** The fields of an observed and nothing else, copied so the state shares nothing with the payload. */
function observedFields(o: Observed): Observed {
  const span = (x: Span): Span => ({ first: x.first, last: x.last, count: x.count });
  return {
    pivot: o.pivot, from: { type: o.from.type, value: o.from.value }, span: span(o.span),
    found: o.found.map((f) => ({ type: f.type, value: f.value, ...span(f), points: f.points.map(([t, n]): [string, number] => [t, n]) })),
    more: o.more, unread: o.unread,
  };
}

export type CaseCreated = Payloads["case.created"];

export const isCaseCreated = (x: unknown): x is CaseCreated =>
  isObj(x) && isStr(x.id) && isStr(x.title) && isStr(x.asked) && isStr(x.why) && Array.isArray(x.starting) && x.starting.every(isObservable)
  && isTimeWindow(x.window) && isStrOrNull(x.objective) && isMarking(x.marking);

/** The fields of a case.created payload and nothing else. */
export function caseFields(c: CaseCreated): CaseCreated {
  const { id, title, asked, why, starting, window, objective, marking } = c;
  return { id, title, asked, why, starting, window, objective, marking };
}

/** The shape of a blob reference. The fold does not check that `blob` is a hash; the verifier checks the bytes. */
export const isBlobRefShape = (x: unknown): x is BlobRef => isObj(x) && isStr(x.blob) && isNum(x.bytes) && (x.media === undefined || isStr(x.media));

/** Is this payload the shape of a `stage.finished`? */
export function isStageFinishedShape(x: unknown): x is Payloads["stage.finished"] {
  return isObj(x) && isStr(x.stage) && isNum(x.attempt) && isOneOf(x.outcome, STAGE_OUTCOMES) && isStrOrNull(x.draft_hash)
    && (x.output === null || isBlobRefShape(x.output)) && isStrOrNull(x.reason);
}
