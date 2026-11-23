// Shape checks for the records the fold and the workbench share. Browser-safe: no runtime imports.
import { CARD_KINDS, CARD_MAKERS, EMPTY_MEANS, isMarking, PARTIAL_REASONS } from "../types";
import type { Card, Coverage, Observable, Payloads, TimeWindow } from "../types";
import { isObj, isOneOf, isStr, isStrList, isStrOrNull } from "./guards";

export const isCount = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
export const isTimeWindow = (x: unknown): x is TimeWindow => isObj(x) && isStrOrNull(x.from) && isStrOrNull(x.to);
export const isObservable = (x: unknown): x is Observable => isObj(x) && isStr(x.type) && isStr(x.value);

export const isCoverage = (x: unknown): x is Coverage =>
  isObj(x) && (x.kind === "full" || (x.kind === "partial" && isOneOf(x.reason, PARTIAL_REASONS) && (x.detail === undefined || isStr(x.detail))));

export const isCard = (x: unknown): x is Card =>
  isObj(x) && isStr(x.id) && isStr(x.title) && isStr(x.body) && isOneOf(x.kind, CARD_KINDS) && isOneOf(x.made_by, CARD_MAKERS)
  && isStrOrNull(x.query) && isStrList(x.columns) && Array.isArray(x.column_types) && x.column_types.every(isStrOrNull)
  && Array.isArray(x.rows) && x.rows.every(Array.isArray) && isCount(x.row_count)
  && (x.coverage === null || isCoverage(x.coverage)) && (x.empty === null || isOneOf(x.empty, EMPTY_MEANS))
  && isMarking(x.marking) && isStrOrNull(x.source) && isStrOrNull(x.step) && isStrOrNull(x.subgoal)
  && isStr(x.why) && isStrOrNull(x.event_time) && isStrList(x.quality_notes);

/** The fields of a card and nothing else. */
export function cardFields(c: Card): Card {
  const { id, title, body, kind, made_by, query, columns, column_types, rows, row_count, coverage, empty, marking, source, step, subgoal, why, event_time, quality_notes } = c;
  return { id, title, body, kind, made_by, query, columns, column_types, rows, row_count, coverage, empty, marking, source, step, subgoal, why, event_time, quality_notes };
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
