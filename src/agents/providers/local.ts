import type { Json } from "../../core/canonical";
import { isPlainObject } from "../../core/canonical";
import type { Usage } from "../../core/state";
import type { Where } from "../../core/types";
import { assertNoEcho, CONTROL, LOOPBACK, loadCredential, NUMERIC_LOOPBACK, parseBase, readCapped, refuseOwnServer, scrub, TimedOut, TooBig } from "../../modules/connectors/shared";
import type { Secrets } from "../../modules/secrets";
import { mergeRequestExtra, requestExtraProblem } from "./extra";
import type { RequestExtra } from "./extra";
import { mergeSampling } from "./sampling";
import type { ModelInfo, Provider, Sampling, ToolCall, Transient, TurnRequest, TurnResult } from "./types";

export const DEFAULT_CONTEXT = 8192;
/** The most tokens a reply may hold (reasoning included) when the manifest names no max_output_tokens; sent as max_tokens on every chat request. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
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
  /** How many slots share the context (the manifest's `parallel`); absent when it says nothing. */
  parallel?: number;
  efforts: string[];
  timeout_ms: number;
  max_bytes?: number;
  /** Sent as max_tokens on every chat request; DEFAULT_MAX_OUTPUT_TOKENS when absent. */
  max_output_tokens?: number;
  /** Sampling settings sent on every chat request (a request's own win key by key). */
  sampling?: Sampling;
  /** Whether a request may carry a json_schema response_format; true when absent. */
  structured_output?: boolean;
  /** Extra fields merged into every chat request body (a request's own win key by key); may not name a key the workbench sends itself. */
  request_extra?: RequestExtra;
  /** `host:port` of this workbench's own server, asked each time: a model endpoint may not point at it. */
  refuse_hosts?: () => readonly string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const ECHOED = "the endpoint echoed the credential; response refused";

class Failure extends Error {
  constructor(message: string, readonly raw: Uint8Array | null = null, readonly transient: Transient | null = null, readonly cause_: "context" | null = null) { super(message); }
}

/** What an endpoint says a request got wrong. */
const CONTEXT_RE = /context (?:size|length|window)|exceed\w* .{0,40}context|maximum context|n_ctx|too many tokens/i;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const oneLine = (s: string): string => s.replace(new RegExp(CONTROL.source, "g"), " ").trim().slice(0, 300);

/** A chat-completions endpoint with tool calls, such as LM Studio. Reaches only the one base URL it was given. */
export class LocalProvider implements Provider {
  readonly kind = "local" as const;
  readonly id: string;
  readonly where: Where;
  readonly max_output_tokens: number;
  readonly structured_output: boolean;
  readonly sampling: Sampling;
  readonly request_extra: RequestExtra;
  readonly #base: string;
  readonly #origin: string;
  readonly #secret: string | null;
  readonly #context: number | null;
  readonly #parallel: number | null;
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
    this.#parallel = opts.parallel ?? null;
    this.#efforts = [...opts.efforts];
    this.#timeout = opts.timeout_ms;
    this.#max = opts.max_bytes ?? MODEL_MAX_BYTES;
    this.max_output_tokens = opts.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.structured_output = opts.structured_output ?? true;
    this.sampling = mergeSampling(undefined, opts.sampling);
    if (opts.request_extra !== undefined) {
      const problem = requestExtraProblem(opts.request_extra);
      if (problem !== null) throw new Error(problem);
    }
    this.request_extra = mergeRequestExtra(undefined, opts.request_extra);
  }

  /** The endpoint's own line about a refusal: `error.message`, else a string `error`, else a string `message`; "" when it gives none. */
  #endpointSaid(parsed: unknown): string {
    if (!isPlainObject(parsed)) return "";
    const e = parsed.error;
    const said = isPlainObject(e) && typeof e.message === "string" ? e.message : typeof e === "string" ? e : typeof parsed.message === "string" ? parsed.message : "";
    return this.#redact(said);
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
      // timeout: false turns off Bun's own idle timer (5 minutes by default), so timeout_ms above is the only deadline
      const res = await fetch(url, { method, headers, ...(body === null ? {} : { body: body as unknown as BodyInit }), redirect: "error", signal: ctl.signal, timeout: false });
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
      if (timedOut || err instanceof TimedOut) throw new Failure(`no answer within ${this.#timeout} ms`, null, { kind: "timeout", ms: this.#timeout });
      if (err instanceof TooBig) throw new Failure(`the reply was larger than ${this.#max} bytes; refused`);
      const e = err as Error;
      // a redirect is refused here too; it is not transient, as asking again meets it again
      const transient: Transient | null = (e.message ?? "").toLowerCase().includes("redirect") ? null : { kind: "transport" };
      throw new Failure(this.#redact(`the endpoint could not be reached: ${e.message ?? String(err)}`), null, transient);
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
    return listed.map((id) => ({ id, context: loaded.get(id) ?? this.#context ?? DEFAULT_CONTEXT, efforts: [...this.#efforts], loaded: loaded.has(id) ? true : details ? false : null, parallel: this.#parallel }));
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
      if (req.tool_choice !== undefined) out.tool_choice = req.tool_choice;
    }
    out.stream = false;
    out.max_tokens = req.max_output_tokens ?? this.max_output_tokens;
    Object.assign(out, mergeSampling(this.sampling, req.sampling));
    // reserved keys are left out of both, so these add fields and never replace one the workbench set; a chosen effort below wins over a reasoning_effort here
    Object.assign(out, mergeRequestExtra(this.request_extra, req.request_extra));
    if (req.effort !== null && this.#efforts.includes(req.effort)) out.reasoning_effort = req.effort;
    if (req.response_format !== undefined && this.structured_output) {
      const name = req.response_format.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "output";
      out.response_format = { type: "json_schema", json_schema: { name, schema: req.response_format.schema as unknown as Json, strict: true } };
    }
    return enc.encode(JSON.stringify(out));
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    try {
      return await this.#turn(req);
    } catch (err) {
      if (err instanceof Failure) return { kind: "error", message: err.message, raw: err.raw, ...(err.transient === null ? {} : { transient: err.transient }), ...(err.cause_ === null ? {} : { cause: err.cause_ }) };
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
    if (r.status !== 200) {
      const said = this.#endpointSaid(parsed);
      if (said !== "" && CONTEXT_RE.test(said)) throw new Failure(`the request did not fit the model's context (the endpoint said: ${said})`, raw, null, "context");
      throw new Failure(said === "" ? `the endpoint answered ${r.status}` : `the endpoint answered ${r.status}: ${said}`, raw);
    }
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
    // LM Studio sometimes says "stop" while calling tools: the calls decide. A reply cut off at the output limit stays cut off, calls or not.
    if (base === "tool_calls" && tool_calls.length === 0) throw new Failure("the reply says it stopped to call tools but holds no tool calls", raw);
    const stop = base === "length" ? "length" : tool_calls.length > 0 ? "tool_calls" : base;
    const u = isPlainObject(parsed) && isPlainObject(parsed.usage) ? parsed.usage : {};
    const details = isPlainObject(u.completion_tokens_details) ? u.completion_tokens_details : {};
    const usage: Usage = { input: num(u.prompt_tokens), output: num(u.completion_tokens), reasoning: num(details.reasoning_tokens) };
    const reasoning = typeof msg.reasoning_content === "string" && msg.reasoning_content !== "" ? msg.reasoning_content : null;
    return { kind: "answer", content: msg.content ?? "", reasoning, tool_calls, stop, usage, served_by, raw };
  }
}
