// Shape checks shared by the reducers and the schema validator. Browser-safe: no runtime imports.

import type { Entry } from "../types";
import type { CaseState } from "./types";

export const isStr = (x: unknown): x is string => typeof x === "string";
export const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
export const isBool = (x: unknown): x is boolean => typeof x === "boolean";
/** A non-null object that is not an array. */
export const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
export const isStrList = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);
export const isStrOrNull = (x: unknown): x is string | null => x === null || isStr(x);
export const isOneOf = <T extends string>(x: unknown, set: readonly T[]): x is T => isStr(x) && (set as readonly string[]).includes(x);
/** Own-property lookup, so ids like "constructor" or "__proto__" are ordinary keys. */
export const has = <T>(rec: Record<string, T>, id: unknown): id is string => isStr(id) && Object.hasOwn(rec, id);

// ---------- recording what the fold could not apply ----------

/** How many skipped entries the state remembers (the most recent). */
export const SKIP_LIMIT = 100;

/** Adds `entry` to `skipped` with `reason`, once: a second reducer refusing the same entry for the same reason adds nothing. */
export function recordSkip(s: CaseState, entry: Entry, reason: string): CaseState {
  const last = s.skipped[s.skipped.length - 1];
  if (last !== undefined && last.seq === entry.seq && last.reason === reason) return s;
  return { ...s, skipped: [...s.skipped, { seq: entry.seq, type: String(entry.type), reason }].slice(-SKIP_LIMIT) };
}

/**
 * A shape rejection: the payload is not the shape its entry type defines. Recorded as
 * "malformed <entry type>". An entry that is well formed but refers to something missing is not
 * malformed; the reducer returns the state unchanged instead.
 */
export function malformed(s: CaseState, entry: Entry): CaseState {
  return recordSkip(s, entry, `malformed ${String(entry.type)}`);
}
