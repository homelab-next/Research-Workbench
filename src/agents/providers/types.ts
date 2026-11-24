import type { Schema } from "../../core/schema";
import type { Usage } from "../../core/state";
import type { Where } from "../../core/types";

export interface ToolSpec { name: string; description: string; parameters: Schema }
/** `arguments` is the text the model gave, unparsed. */
export interface ToolCall { id: string; name: string; arguments: string }
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }
/** `loaded`: true when the endpoint says the model is in memory with a context; false when it answered a listing that does not say so; null when it has no such listing. */
export interface ModelInfo { id: string; context: number | null; efforts: string[]; loaded: boolean | null }
/** `key` is the calling agent's actor id; `ordinal` is how many model requests that actor id has already made in the case. */
/** `response_format`: the reply is to be one JSON object matching `schema`; sent only to a provider whose `structured_output` is true. */
export interface TurnRequest { model: string; effort: string | null; messages: ChatMessage[]; tools: ToolSpec[]; key: string; ordinal: number; response_format?: { name: string; schema: Schema } }
export type TurnResult =
  | { kind: "answer"; content: string; reasoning: string | null; tool_calls: ToolCall[]; stop: "end" | "tool_calls" | "length"; usage: Usage; served_by: string; raw: Uint8Array }
  | { kind: "declined"; reason: string; served_by: string; raw: Uint8Array }
  | { kind: "error"; message: string; raw: Uint8Array | null; transient?: Transient };
/** A failure that may not recur when the same request is made again: no answer in time, or the endpoint could not be reached. */
export type Transient = { kind: "timeout"; ms: number } | { kind: "transport" };
export interface Provider {
  readonly id: string;
  readonly kind: "scripted" | "local";
  readonly where: Where;
  /** The most tokens a reply may hold, when the provider sets one (a local model sends it as max_tokens). */
  readonly max_output_tokens?: number;
  /** True when the provider can be asked for a reply that matches a JSON schema (an OpenAI-compatible json_schema response_format). */
  readonly structured_output?: boolean;
  models(): Promise<ModelInfo[]>;
  /** The exact request body `turn` sends for this request. Pure; contacts nothing; never holds a header. */
  body(req: TurnRequest): Uint8Array;
  /** One model turn. Never throws: transport and protocol failures are `kind: "error"`. */
  turn(req: TurnRequest): Promise<TurnResult>;
}
