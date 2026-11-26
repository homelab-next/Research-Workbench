// Shape checks for the records the fold and the workbench share. Browser-safe: no runtime imports.
import { CARD_KINDS, CARD_MAKERS, EMPTY_MEANS, isMarking, MAX_POINTS, MAX_SIGHTINGS, PARTIAL_REASONS, STAGE_OUTCOMES } from "../types";
import type { BlobRef, Card, Coverage, Observable, Observed, Payloads, Sighting, Span, TimeWindow } from "../types";
import { isNum, isObj, isOneOf, isStr, isStrList, isStrOrNull } from "./guards";

export const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
export const isTimeWindow = (x: unknown): x is TimeWindow => isObj(x) && isStrOrNull(x.from) && isStrOrNull(x.to);
export const isObservable = (x: unknown): x is Observable => isObj(x) && isStr(x.type) && isStr(x.value);

export const isCoverage = (x: unknown): x is Coverage =>
  isObj(x) && (x.kind === "full" || (x.kind === "partial" && isOneOf(x.reason, PARTIAL_REASONS) && (x.detail === undefined || isStr(x.detail))));

/** A time as the runner writes it: UTC with milliseconds. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isTimeOrNull = (x: unknown): x is string | null => x === null || (isStr(x) && TIME.test(x));
const isCountOrNull = (x: unknown): x is number | null => x === null || isCount(x);
const isSpan = (x: Record<string, unknown>): boolean => isTimeOrNull(x.first) && isTimeOrNull(x.last) && isCountOrNull(x.count);
const isPoint = (x: unknown): x is [string, number] => Array.isArray(x) && x.length === 2 && isStr(x[0]) && TIME.test(x[0]) && isCount(x[1]);
const isSighting = (x: unknown): x is Sighting =>
  isObj(x) && isSpan(x) && isStr(x.type) && isStr(x.value) && Array.isArray(x.points) && x.points.length <= MAX_POINTS && x.points.every(isPoint);

/** What a card observed: at most MAX_SIGHTINGS sightings of at most MAX_POINTS points; every time normalised, every count a count. */
export const isObserved = (x: unknown): x is Observed =>
  isObj(x) && isStr(x.pivot) && isObservable(x.from) && isObj(x.span) && isSpan(x.span) && Array.isArray(x.found) && x.found.length <= MAX_SIGHTINGS
  && x.found.every(isSighting) && isCount(x.more) && isCount(x.unread);

export const isCard = (x: unknown): x is Card =>
  isObj(x) && isStr(x.id) && isStr(x.title) && isStr(x.body) && isOneOf(x.kind, CARD_KINDS) && isOneOf(x.made_by, CARD_MAKERS)
  && isStrOrNull(x.query) && isStrList(x.columns) && Array.isArray(x.column_types) && x.column_types.every(isStrOrNull)
  && Array.isArray(x.rows) && x.rows.every(Array.isArray) && isCount(x.row_count)
  && (x.coverage === null || isCoverage(x.coverage)) && (x.empty === null || isOneOf(x.empty, EMPTY_MEANS))
  && isMarking(x.marking) && isStrOrNull(x.source) && isStrOrNull(x.step) && isStrOrNull(x.subgoal)
  && isStr(x.why) && isStrOrNull(x.event_time) && isStrList(x.quality_notes) && (x.observed === undefined || isObserved(x.observed));

/** The fields of a card and nothing else. */
export function cardFields(c: Card): Card {
  const { id, title, body, kind, made_by, query, columns, column_types, rows, row_count, coverage, empty, marking, source, step, subgoal, why, event_time, quality_notes } = c;
  const fields: Card = { id, title, body, kind, made_by, query, columns, column_types, rows, row_count, coverage, empty, marking, source, step, subgoal, why, event_time, quality_notes };
  return c.observed === undefined ? fields : { ...fields, observed: observedFields(c.observed) };
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
