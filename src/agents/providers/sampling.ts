import type { Schema } from "../../core/schema";
import type { Sampling } from "./types";

/** The sampling settings a model manifest or a stage manifest may give, with the schema each is checked against. Names are the OpenAI chat-request fields; top_k, min_p and repeat_penalty are the ones LM Studio accepts besides. */
export const SAMPLING_KEYS = ["temperature", "top_p", "top_k", "min_p", "presence_penalty", "frequency_penalty", "repeat_penalty"] as const;

export const SAMPLING_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    temperature: { type: "number", minimum: 0, maximum: 2 },
    top_p: { type: "number", minimum: 0, maximum: 1 },
    top_k: { type: "integer", minimum: 0, maximum: 1000 },
    min_p: { type: "number", minimum: 0, maximum: 1 },
    presence_penalty: { type: "number", minimum: -2, maximum: 2 },
    frequency_penalty: { type: "number", minimum: -2, maximum: 2 },
    repeat_penalty: { type: "number", minimum: 0.1, maximum: 10 },
  },
};

/** The given settings, in a fixed order; `later` wins key by key over `base`. */
export function mergeSampling(base: Sampling | undefined, later: Sampling | undefined): Sampling {
  const out: Sampling = {};
  for (const k of SAMPLING_KEYS) {
    const v = later?.[k] ?? base?.[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** A one-line reading of the settings, "temperature 0.6, top_p 0.95"; "none" when there are none. */
export function describeSampling(s: Sampling | undefined): string {
  const parts = SAMPLING_KEYS.flatMap((k) => (s?.[k] === undefined ? [] : [`${k} ${s[k]}`]));
  return parts.length === 0 ? "none" : parts.join(", ");
}
