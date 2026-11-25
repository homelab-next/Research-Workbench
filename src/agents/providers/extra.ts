import type { Json } from "../../core/canonical";
import { isPlainObject } from "../../core/canonical";
import { SAMPLING_KEYS } from "./sampling";

/** A map merged into the chat request body as it is: what a model or a stage adds that the workbench does not send itself (e.g. `chat_template_kwargs`). */
export type RequestExtra = Record<string, Json>;

/** The keys the workbench sets itself; request_extra may not name them. `stream` is among them because a streamed reply cannot be read. */
export const RESERVED_REQUEST_KEYS: readonly string[] = ["model", "messages", "tools", "tool_choice", "response_format", "max_tokens", "stream", ...SAMPLING_KEYS];

/** Why `value` is not a usable request_extra, or null when it is. */
export function requestExtraProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return "request_extra must be a map of request fields";
  const taken = Object.keys(value).filter((k) => RESERVED_REQUEST_KEYS.includes(k));
  if (taken.length > 0) return `request_extra may not set ${taken.join(", ")}: the workbench sends ${taken.length === 1 ? "it" : "them"} itself (sampling and max_output_tokens have their own fields)`;
  return null;
}

/** `base` then `later`, key by key, leaving out any reserved key. */
export function mergeRequestExtra(base: RequestExtra | undefined, later: RequestExtra | undefined): RequestExtra {
  const out: RequestExtra = {};
  for (const src of [base, later]) {
    if (src === undefined) continue;
    for (const [k, v] of Object.entries(src)) if (!RESERVED_REQUEST_KEYS.includes(k)) out[k] = v;
  }
  return out;
}
