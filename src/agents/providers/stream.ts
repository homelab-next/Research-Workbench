import type { Json } from "../../core/canonical";
import { isPlainObject } from "../../core/canonical";

/** Splits a server-sent event stream into the data of each event, as text arrives in pieces. Comments and other fields are skipped. */
export class SseEvents {
  #buf = "";
  #data: string[] = [];

  /** The data of every event completed by `text`. */
  push(text: string): string[] {
    this.#buf += text;
    const out: string[] = [];
    for (;;) {
      const nl = this.#buf.indexOf("\n");
      if (nl === -1) break;
      const line = this.#buf.slice(0, nl).replace(/\r$/, "");
      this.#buf = this.#buf.slice(nl + 1);
      if (line === "") {
        if (this.#data.length > 0) out.push(this.#data.join("\n"));
        this.#data = [];
      } else if (line.startsWith("data:")) {
        this.#data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      }
    }
    return out;
  }

  /** The data of an event the stream ended in without its blank line, if any. */
  end(): string[] {
    const rest = this.push("\n\n");
    this.#buf = "";
    return rest;
  }
}

interface CallParts { id: string; type: string; name: string; arguments: string }

/** What one chunk added to the reply's reasoning and content. */
export interface Added { reasoning: string; content: string }

/**
 * Builds, from the chunks of a streamed chat completion, the object the same reply would have been had it not been streamed:
 * `{ id, object: "chat.completion", created, model, choices: [{ index: 0, message, finish_reason }], usage }`.
 */
export class StreamAssembly {
  #top: Record<string, Json> = {};
  #role: string | null = null;
  #content: string | null = null;
  #reasoning: string | null = null;
  #reasoningAlt: string | null = null;
  #refusal: string | null = null;
  readonly #calls = new Map<number, CallParts>();
  /** The key of the call the latest tool-call piece went to. */
  #lastCall: number | null = null;
  #finish: Json = null;
  #usage: Json | undefined;

  /** True once a chunk gave a finish reason. */
  get finished(): boolean { return this.#finish !== null; }

  /** Adds one parsed chunk. A chunk not in the expected form adds nothing. */
  add(chunk: unknown): Added {
    const added: Added = { reasoning: "", content: "" };
    if (!isPlainObject(chunk)) return added;
    for (const k of ["id", "created", "model", "system_fingerprint"] as const) {
      const v = chunk[k];
      if (v !== undefined && v !== null && this.#top[k] === undefined) this.#top[k] = v as Json;
    }
    if (isPlainObject(chunk.usage)) this.#usage = chunk.usage as Json;
    const choice = Array.isArray(chunk.choices) ? chunk.choices.find((c: unknown) => isPlainObject(c) && (c.index ?? 0) === 0) : undefined;
    if (!isPlainObject(choice)) return added;
    if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") this.#finish = choice.finish_reason;
    const d = choice.delta;
    if (!isPlainObject(d)) return added;
    if (typeof d.role === "string" && this.#role === null) this.#role = d.role;
    if (typeof d.content === "string") { this.#content = (this.#content ?? "") + d.content; added.content = d.content; }
    if (typeof d.reasoning_content === "string") { this.#reasoning = (this.#reasoning ?? "") + d.reasoning_content; added.reasoning += d.reasoning_content; }
    if (typeof d.reasoning === "string") { this.#reasoningAlt = (this.#reasoningAlt ?? "") + d.reasoning; added.reasoning += d.reasoning; }
    if (typeof d.refusal === "string") this.#refusal = (this.#refusal ?? "") + d.refusal;
    if (Array.isArray(d.tool_calls)) {
      d.tool_calls.forEach((c: unknown, at: number) => {
        if (!isPlainObject(c)) return;
        const index = this.#keyOf(c, at);
        const part = this.#calls.get(index) ?? { id: "", type: "function", name: "", arguments: "" };
        if (typeof c.id === "string" && c.id !== "" && part.id === "") part.id = c.id;
        if (typeof c.type === "string" && c.type !== "") part.type = c.type;
        const f = c.function;
        if (isPlainObject(f)) {
          if (typeof f.name === "string" && f.name !== "" && part.name === "") part.name = f.name;
          if (typeof f.arguments === "string") part.arguments += f.arguments;
        }
        this.#calls.set(index, part);
        this.#lastCall = index;
      });
    }
    return added;
  }

  /**
   * Which call a tool-call piece belongs to: its `index` when it has one (LM Studio and OpenAI send it). Without one, a piece with a new id
   * starts a new call, one with a known id continues that call, and one with no id continues the call before it (or the one at its place).
   */
  #keyOf(c: Record<string, unknown>, at: number): number {
    if (typeof c.index === "number" && Number.isInteger(c.index)) return c.index;
    if (typeof c.id === "string" && c.id !== "") {
      for (const [k, part] of this.#calls) if (part.id === c.id) return k;
      return this.#calls.size === 0 ? at : Math.max(...this.#calls.keys()) + 1;
    }
    return this.#lastCall ?? at;
  }

  /** The reply as one completion; `finish` replaces the finish reason (a reply cut short), and `reasoning: false` leaves the reasoning out. */
  result(opts: { finish?: string; reasoning?: boolean } = {}): Record<string, Json> {
    const message: Record<string, Json> = { role: this.#role ?? "assistant", content: this.#content };
    if (opts.reasoning !== false && this.#reasoning !== null) message.reasoning_content = this.#reasoning;
    if (opts.reasoning !== false && this.#reasoningAlt !== null) message.reasoning = this.#reasoningAlt;
    if (this.#refusal !== null) message.refusal = this.#refusal;
    if (this.#calls.size > 0) {
      message.tool_calls = [...this.#calls.entries()].sort((a, b) => a[0] - b[0])
        .map(([, c]) => ({ id: c.id, type: c.type, function: { name: c.name, arguments: c.arguments } }));
    }
    const out: Record<string, Json> = { ...this.#top, object: "chat.completion", choices: [{ index: 0, message, finish_reason: opts.finish ?? this.#finish }] };
    if (this.#usage !== undefined) out.usage = this.#usage;
    return out;
  }
}
