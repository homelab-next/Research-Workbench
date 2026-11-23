import { MAX_TS, MIN_TS } from "./types";
import type { Bound, QueryRequest } from "./types";

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;

/** Names inside {...}, in order of first use. */
export function placeholders(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return seen;
}

/** The request's bound values plus the window ends, open ends replaced by the minimum and maximum timestamps. */
export function effectiveBound(req: QueryRequest): Bound {
  return { ...req.bound, "window.from": req.window.from ?? MIN_TS, "window.to": req.window.to ?? MAX_TS };
}
