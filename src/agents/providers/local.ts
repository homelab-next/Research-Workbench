import type { Json } from "../../core/canonical";
import { isPlainObject } from "../../core/canonical";
import type { Usage } from "../../core/state";
import type { Where } from "../../core/types";
import { assertNoEcho, CONTROL, LOOPBACK, loadCredential, NUMERIC_LOOPBACK, parseBase, readCapped, refuseOwnServer, scrub, TimedOut, TooBig } from "../../modules/connectors/shared";
import type { Secrets } from "../../modules/secrets";
import type { ModelInfo, Provider, ToolCall, TurnRequest, TurnResult } from "./types";

export const DEFAULT_CONTEXT = 8192;
export const MODEL_MAX_BYTES = 16 * 1024 * 1024;
/** The most tool calls one reply may hold; a reply with more is a failure, not a list to work through. */
export const MAX_REPLY_CALLS = 64;

export interface LocalOptions {
  id: string;
  base_url: string;
  where: Where;
  credential: string | null;
  secrets: Secrets;
  context: number | null;
  efforts: string[];
  timeout_ms: number;
  max_bytes?: number;
  /** `host:port` of this workbench's own server, asked each time: a model endpoint may not point at it. */
  refuse_hosts?: () => readonly string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const ECHOED = "the endpoint echoed the credential; response refused";

class Failure extends Error {
  constructor(message: string, readonly raw: Uint8Array | null = null) { super(message); }
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const oneLine = (s: string): string => s.replace(new RegExp(CONTROL.source, "g"), " ").trim().slice(0, 300);

/** A chat-completions endpoint with tool calls, such as LM Studio. Reaches only the one base URL it was given. */
export class LocalProvider implements Provider {
  readonly kind = "local" as const;
  readonly id: string;
  readonly where: Where;
  readonly #base: string;
  readonly #origin: string;
  readonly #secret: string | null;
  readonly #context: number | null;
  readonly #efforts: string[];
  readonly #timeout: number;
  readonly #max: number;
  readonly #own: () => readonly string[];

  constructor(opts: LocalOptions) {
    this.#own = opts.refuse_hosts ?? (() => []);
    this.#refuseOwnServer(opts.base_url);
    const u = parseBase(opts.base_url);
    if (opts.where === "machine" && !LOOPBACK.has(u.hostname)) {
      throw new Error(`a model at ${u.host} is not on this machine: where must be network or hosted`);
    }
    if (opts.where === "machine" && !NUMERIC_LOOPBACK.has(u.hostname)) {
      throw new Error("a model on this machine must give a numeric address: write 127.0.0.1 in place of localhost");
    }
    this.id = opts.id;
    this.where = opts.where;
    this.#base = u.href.replace(/\/+$/, "");
    this.#origin = u.origin;
    this.#secret = opts.credential === null ? null : loadCredential(opts.secrets, opts.credential);
    this.#context = opts.context;
    this.#efforts = [...opts.efforts];
    this.#timeout = opts.timeout_ms;
    this.#max = opts.max_bytes ?? MODEL_MAX_BYTES;
  }

  /** Throws a plain Error naming the cause when the endpoint is the workbench's own server. */
  #refuseOwnServer(location: string): void {
    try {
      refuseOwnServer(location, this.#own());
    } catch {
      throw new Error("this model endpoint points at the workbench's own server");
    }
  }

  #redact(text: string): string {
    return oneLine(scrub(text, this.#secret === null ? [] : [this.#secret]));
  }

  /** One request. Throws Failure with a scrubbed one-line message; the bytes are returned only when they passed the echo check. */
  async #send(method: "GET" | "POST", url: string, body: Uint8Array | null): Promise<{ status: number; raw: Uint8Array; parsed: unknown }> {
    try {
      this.#refuseOwnServer(this.#base);
    } catch (err) {
      throw new Failure((err as Error).message);
    }
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, this.#timeout);
    try {
      const headers: Record<string, string> = {};
      if (body !== null) headers["content-type"] = "application/json";
      if (this.#secret !== null) headers.authorization = `Bearer ${this.#secret}`;
      const res = await fetch(url, { method, headers, ...(body === null ? {} : { body: body as unknown as BodyInit }), redirect: "error", signal: ctl.signal });
      const raw = await readCapped(res, ctl.signal, this.#max);
      let parsed: unknown;
      try { parsed = JSON.parse(dec.decode(raw)); } catch { parsed = undefined; }
      try {
        assertNoEcho(raw, this.#secret === null ? [] : [this.#secret], parsed);
      } catch {
        throw new Failure(ECHOED);
      }
      return { status: res.status, raw, parsed };
    } catch (err) {
      if (err instanceof Failure) throw err;
      if (timedOut || err instanceof TimedOut) throw new Failure(`no answer within ${this.#timeout} ms`);
      if (err instanceof TooBig) throw new Failure(`the reply was larger than ${this.#max} bytes; refused`);
      const e = err as Error;
      throw new Failure(this.#redact(`the endpoint could not be reached: ${e.message ?? String(err)}`));
    } finally {
      clearTimeout(timer);
    }
  }

  async models(): Promise<ModelInfo[]> {
    let listed: string[];
    try {
      const r = await this.#send("GET", `${this.#base}/models`, null);
      if (r.status !== 200) throw new Failure(`the endpoint answered ${r.status}`);
      if (!isPlainObject(r.parsed) || !Array.isArray(r.parsed.data)) throw new Failure("the model list is not in the expected form");
      listed = r.parsed.data.flatMap((m: unknown) => (isPlainObject(m) && typeof m.id === "string" ? [m.id] : []));
    } catch (err) {
      throw new Error(err instanceof Failure ? err.message : this.#redact((err as Error).message));
    }
    const loaded = new Map<string, number>();
    let details = false;
    try {
      const d = await this.#send("GET", `${this.#origin}/api/v0/models`, null);
      if (d.status === 200 && isPlainObject(d.parsed) && Array.isArray(d.parsed.data)) {
        details = true;
        for (const m of d.parsed.data as unknown[]) {
          if (isPlainObject(m) && typeof m.id === "string" && typeof m.loaded_context_length === "number") loaded.set(m.id, m.loaded_context_length);
        }
      }
    } catch { /* not LM Studio, or it did not answer: the manifest's context applies */ }
    return listed.map((id) => ({ id, context: loaded.get(id) ?? this.#context ?? DEFAULT_CONTEXT, efforts: [...this.#efforts], loaded: loaded.has(id) ? true : details ? false : null }));
  }

  body(req: TurnRequest): Uint8Array {
    const out: Record<string, Json> = {
      model: req.model,
      messages: req.messages.map((m): Json => {
        const o: Record<string, Json> = { role: m.role, content: m.content };
        if (m.tool_calls !== undefined) o.tool_calls = m.tool_calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } }));
        if (m.tool_call_id !== undefined) o.tool_call_id = m.tool_call_id;
        return o;
      }),
    };
    if (req.tools.length > 0) {
      out.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters as Json } }));
    }
    out.stream = false;
    if (req.effort !== null && this.#efforts.includes(req.effort)) out.reasoning_effort = req.effort;
    return enc.encode(JSON.stringify(out));
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    try {
      return await this.#turn(req);
    } catch (err) {
      if (err instanceof Failure) return { kind: "error", message: err.message, raw: err.raw };
      return { kind: "error", message: this.#redact(`the reply could not be read: ${(err as Error).message ?? String(err)}`), raw: null };
    }
  }

  async #turn(req: TurnRequest): Promise<TurnResult> {
    let r: { status: number; raw: Uint8Array; parsed: unknown };
    try {
      r = await this.#send("POST", `${this.#base}/chat/completions`, this.body(req));
    } catch (err) {
      if (err instanceof Failure && err.message === ECHOED) return { kind: "error", message: ECHOED, raw: null };
      throw err;
    }
    const { raw, parsed } = r;
    if (r.status !== 200) throw new Failure(`the endpoint answered ${r.status}`, raw);
    if (parsed === undefined) throw new Failure("the reply is not JSON", raw);
    const choice = isPlainObject(parsed) && Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    if (!isPlainObject(choice) || !isPlainObject(choice.message)) throw new Failure("the reply has no choices", raw);
    const msg = choice.message;
    const served_by = isPlainObject(parsed) && typeof parsed.model === "string" && parsed.model !== "" ? parsed.model : req.model;
    const finish = choice.finish_reason;
    const refusal = typeof msg.refusal === "string" && msg.refusal !== "" ? msg.refusal : null;
    if (finish === "content_filter" || refusal !== null) {
      return { kind: "declined", reason: refusal ?? "the endpoint's content filter stopped the reply", served_by, raw };
    }
    const base = finish === "stop" ? "end" : finish === "tool_calls" ? "tool_calls" : finish === "length" ? "length" : null;
    if (base === null) throw new Failure(`the reply stopped for an unknown reason: ${this.#redact(String(finish))}`, raw);
    if (msg.content !== null && msg.content !== undefined && typeof msg.content !== "string") throw new Failure("the reply's content is not text", raw);
    const tool_calls: ToolCall[] = [];
    if (msg.tool_calls !== undefined && msg.tool_calls !== null) {
      if (!Array.isArray(msg.tool_calls)) throw new Failure("the reply's tool calls are not a list", raw);
      if (msg.tool_calls.length > MAX_REPLY_CALLS) throw new Failure(`the reply holds ${msg.tool_calls.length} tool calls; at most ${MAX_REPLY_CALLS} are accepted`, raw);
      for (const c of msg.tool_calls as unknown[]) {
        const f = isPlainObject(c) ? c.function : undefined;
        if (!isPlainObject(c) || typeof c.id !== "string" || !isPlainObject(f) || typeof f.name !== "string" || typeof f.arguments !== "string") {
          throw new Failure("a tool call in the reply is malformed", raw);
        }
        if (c.id === "" || f.name === "") throw new Failure("a tool call in the reply has an empty id or name", raw);
        if (tool_calls.some((t) => t.id === c.id)) throw new Failure("two tool calls in the reply share an id", raw);
        tool_calls.push({ id: c.id, name: f.name, arguments: f.arguments });
      }
    }
    // LM Studio sometimes says "stop" while calling tools: the calls decide.
    if (base === "tool_calls" && tool_calls.length === 0) throw new Failure("the reply says it stopped to call tools but holds no tool calls", raw);
    const stop = tool_calls.length > 0 ? "tool_calls" : base;
    const u = isPlainObject(parsed) && isPlainObject(parsed.usage) ? parsed.usage : {};
    const details = isPlainObject(u.completion_tokens_details) ? u.completion_tokens_details : {};
    const usage: Usage = { input: num(u.prompt_tokens), output: num(u.completion_tokens), reasoning: num(details.reasoning_tokens) };
    const reasoning = typeof msg.reasoning_content === "string" && msg.reasoning_content !== "" ? msg.reasoning_content : null;
    return { kind: "answer", content: msg.content ?? "", reasoning, tool_calls, stop, usage, served_by, raw };
  }
}
