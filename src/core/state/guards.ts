// Shape checks shared by the reducers and the schema validator. Browser-safe: no runtime imports.

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
