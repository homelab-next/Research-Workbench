import { afterEach, expect, test } from "bun:test";
import { LocalProvider, DEFAULT_CONTEXT, DEFAULT_MAX_OUTPUT_TOKENS } from "../../src/agents/providers/local";
import type { TurnRequest, TurnResult } from "../../src/agents/providers";
import { Secrets } from "../../src/modules/secrets";
import type { Schema } from "../../src/core/schema";
import { startStandin } from "../helpers/http-standin";
import { startModelStandin } from "../helpers/model-standin";
import type { StandinReply } from "../helpers/model-standin";

const KEY = "sk-local-secret-value";
const stops: (() => void)[] = [];
afterEach(() => { while (stops.length > 0) stops.pop()!(); });

const standin = (replies: (StandinReply | ((b: Record<string, never>) => StandinReply))[], extra: { details?: boolean; models?: { id: string; loaded_context_length?: number }[] } = {}) => {
  const m = startModelStandin({ ...extra, replies: replies as StandinReply[] });
  stops.push(m.stop);
  return m;
};
const provider = (url: string, o: { credential?: string | null; context?: number | null; efforts?: string[]; timeout_ms?: number; max_bytes?: number; max_output_tokens?: number; structured_output?: boolean; sampling?: Record<string, number> } = {}) =>
  new LocalProvider({
    id: "lm", base_url: url, where: "machine", credential: o.credential ?? null, secrets: new Secrets({ LM_KEY: KEY }, null),
    context: o.context ?? null, efforts: o.efforts ?? [], timeout_ms: o.timeout_ms ?? 5000, ...(o.max_bytes === undefined ? {} : { max_bytes: o.max_bytes }),
    ...(o.max_output_tokens === undefined ? {} : { max_output_tokens: o.max_output_tokens }),
    ...(o.structured_output === undefined ? {} : { structured_output: o.structured_output }),
    ...(o.sampling === undefined ? {} : { sampling: o.sampling }),
  });
const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  model: "qwen/qwen3.6-35b-a3b", effort: null, key: "a", ordinal: 0,
  messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }], tools: [], ...over,
});
const ok = (message: Record<string, unknown>, finish = "stop", extra: Record<string, unknown> = {}): StandinReply =>
  ({ json: { choices: [{ finish_reason: finish, message }], ...extra } as never });
const asError = (r: TurnResult): string => { if (r.kind !== "error") throw new Error(`expected error, got ${r.kind}`); return r.message; };

test("lists models with the context the endpoint has loaded", async () => {
  const m = standin([], { models: [{ id: "qwen/qwen3.6-35b-a3b", loaded_context_length: 131072 }] });
  expect(await provider(m.url).models()).toEqual([{ id: "qwen/qwen3.6-35b-a3b", context: 131072, efforts: [], loaded: true }]);
});

test("a model the details endpoint lists with no loaded context is not loaded; one it does not list at all is not loaded either", async () => {
  const m = standin([], { models: [{ id: "idle" }] });
  expect((await provider(m.url).models())[0]!.loaded).toBe(false);
  const d = startStandin({
    "GET /v1/models": () => Response.json({ data: [{ id: "absent" }] }),
    "GET /api/v0/models": () => Response.json({ data: [{ id: "other", loaded_context_length: 4096 }] }),
  });
  stops.push(d.stop);
  expect((await provider(`${d.url}/v1`).models())[0]!.loaded).toBe(false);
});

test("without the details endpoint loaded is null", async () => {
  const m = standin([], { details: false, models: [{ id: "m" }] });
  expect((await provider(m.url).models())[0]!.loaded).toBeNull();
});

test("without the details endpoint the manifest's context is used, else the default", async () => {
  const a = standin([], { details: false, models: [{ id: "m" }] });
  expect(await provider(a.url, { context: 4096, efforts: ["low"] }).models()).toEqual([{ id: "m", context: 4096, efforts: ["low"], loaded: null }]);
  expect((await provider(a.url).models())[0]!.context).toBe(DEFAULT_CONTEXT);
  expect(DEFAULT_CONTEXT).toBe(8192);
});

test("a failed model list rejects without the credential in the message", async () => {
  const m = standin([]);
  m.stop();
  const err = await provider(m.url, { credential: "LM_KEY" }).models().then(() => null, (e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  expect(err!.message).not.toContain(KEY);
});

test("sends exactly the bytes body() returned and no stored header", async () => {
  const m = standin([ok({ content: "ok" })]);
  const p = provider(m.url, { credential: "LM_KEY" });
  const r = req({ tools: [{ name: "t", description: "d", parameters: { type: "object" } }] });
  await p.turn(r);
  expect(m.requests.find((x) => x.method === "POST")!.body).toBe(new TextDecoder().decode(p.body(r)));
  expect(new TextDecoder().decode(p.body(r))).not.toContain("authorization");
  expect(new TextDecoder().decode(p.body(r))).not.toContain(KEY);
});

test("body shape: tools only when present, effort only when the manifest lists it, tool calls mapped", () => {
  const p = provider("http://127.0.0.1:1/v1", { efforts: ["low", "high"] });
  const plain = JSON.parse(new TextDecoder().decode(p.body(req()))) as Record<string, unknown>;
  expect(plain).toEqual({ model: "qwen/qwen3.6-35b-a3b", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }], stream: false, max_tokens: 8192 });
  const rich = JSON.parse(new TextDecoder().decode(p.body(req({
    effort: "high",
    tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
    messages: [{ role: "assistant", content: "", tool_calls: [{ id: "c1", name: "t", arguments: "{}" }] }, { role: "tool", content: "r", tool_call_id: "c1" }],
  })))) as Record<string, unknown>;
  expect(rich.reasoning_effort).toBe("high");
  expect(rich.tools).toEqual([{ type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } }]);
  expect((rich.messages as unknown[])[0]).toEqual({ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] });
  expect((rich.messages as unknown[])[1]).toEqual({ role: "tool", content: "r", tool_call_id: "c1" });
  const unlisted = JSON.parse(new TextDecoder().decode(p.body(req({ effort: "max" })))) as Record<string, unknown>;
  expect("reasoning_effort" in unlisted).toBe(false);
});

test("an answer carries content, reasoning, usage and the model that served it", async () => {
  const m = standin([ok({ content: "ok", reasoning_content: "thinking" }, "stop", { usage: { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 3 } }, model: "served" })]);
  const r = await provider(m.url).turn(req());
  expect(r).toMatchObject({ kind: "answer", content: "ok", reasoning: "thinking", stop: "end", usage: { input: 10, output: 4, reasoning: 3 }, served_by: "served" });
  expect(r.kind === "answer" && r.raw.length > 0).toBe(true);
});

test("absent content, reasoning, usage and model get their defaults", async () => {
  const m = standin([ok({ content: null, reasoning_content: "" })]);
  const r = await provider(m.url).turn(req());
  expect(r).toMatchObject({ kind: "answer", content: "", reasoning: null, tool_calls: [], usage: { input: 0, output: 0, reasoning: 0 }, served_by: "qwen/qwen3.6-35b-a3b" });
});

test("tool calls come back with their argument text untouched", async () => {
  const args = '{"why": "x", "value": "a\\"b"}';
  const m = standin([ok({ content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "look", arguments: args } }] }, "tool_calls")]);
  const r = await provider(m.url).turn(req());
  expect(r).toMatchObject({ kind: "answer", stop: "tool_calls", tool_calls: [{ id: "c9", name: "look", arguments: args }] });
});

test("a length stop and a content filter are told apart", async () => {
  const m = standin([ok({ content: "cut" }, "length"), ok({ content: "" }, "content_filter"), ok({ content: "", refusal: "no can do" }, "stop")]);
  const p = provider(m.url);
  expect(await p.turn(req())).toMatchObject({ kind: "answer", stop: "length" });
  expect(await p.turn(req())).toMatchObject({ kind: "declined" });
  expect(await p.turn(req())).toMatchObject({ kind: "declined", reason: "no can do" });
});

test("the credential is sent as a bearer token and never returned", async () => {
  const m = standin([ok({ content: "ok" })]);
  const r = await provider(m.url, { credential: "LM_KEY" }).turn(req());
  expect(m.requests.find((x) => x.method === "POST")!.headers.authorization).toBe(`Bearer ${KEY}`);
  expect(JSON.stringify(r)).not.toContain(KEY);
});

test("no authorization header without a credential", async () => {
  const m = standin([ok({ content: "ok" })]);
  await provider(m.url).turn(req());
  expect(m.requests.find((x) => x.method === "POST")!.headers.authorization).toBeUndefined();
});

test("a 500, a non-JSON body, no choices and an unknown finish reason are errors", async () => {
  const m = standin([{ status: 500, text: "boom" }, { text: "not json" }, { json: { nothing: 1 } }, ok({ content: "x" }, "mystery")]);
  const p = provider(m.url);
  expect(asError(await p.turn(req()))).toBe("the endpoint answered 500");
  expect(asError(await p.turn(req()))).toMatch(/not JSON/);
  expect(asError(await p.turn(req()))).toMatch(/choices/);
  expect(asError(await p.turn(req()))).toMatch(/mystery/);
});

test("a slow endpoint is an error after the timeout, not a hang", async () => {
  const m = standin([{ delayMs: 2000, json: {} }]);
  const t0 = Date.now();
  expect(asError(await provider(m.url, { timeout_ms: 200 }).turn(req()))).toBe("no answer within 200 ms");
  expect(Date.now() - t0).toBeLessThan(1500);
}, 5000);

test("a refused connection is an error", async () => {
  const m = standin([]);
  m.stop();
  const msg = asError(await provider(m.url, { credential: "LM_KEY" }).turn(req()));
  expect(msg).not.toContain("\n");
  expect(msg).not.toContain(KEY);
});

test("a redirect is refused", async () => {
  const other = standin([ok({ content: "elsewhere" })]);
  const m = standin([{ redirect: `${other.url}/chat/completions` }]);
  expect(asError(await provider(m.url, { credential: "LM_KEY" }).turn(req()))).toMatch(/could not be reached/);
  expect(other.requests.filter((x) => x.method === "POST")).toEqual([]);
});

test("a reply over the size cap is an error", async () => {
  const m = standin([{ text: "x".repeat(5000) }]);
  expect(asError(await provider(m.url, { max_bytes: 1024 }).turn(req()))).toMatch(/larger|too large|cap/i);
});

test("a reply that echoes the credential is refused and its bytes are dropped", async () => {
  const m = standin([ok({ content: `your key is ${KEY}` }), ok({ content: Buffer.from(KEY).toString("base64") })]);
  const p = provider(m.url, { credential: "LM_KEY" });
  for (let i = 0; i < 2; i++) {
    const r = await p.turn(req());
    expect(r).toEqual({ kind: "error", message: "the endpoint echoed the credential; response refused", raw: null });
  }
});

test("turn never throws", async () => {
  const m = standin([{ status: 500 }, { text: "{" }, { json: { choices: [] } }, { json: { choices: [{}] } }, { json: { choices: [{ finish_reason: "stop", message: { content: 5, tool_calls: "x" } }] } }, { json: null as never }]);
  const p = provider(m.url);
  for (let i = 0; i < 6; i++) {
    const r = await p.turn(req());
    expect(["answer", "declined", "error"]).toContain(r.kind);
  }
});

const calls = (...cs: unknown[]) => ok({ content: null, tool_calls: cs }, "tool_calls");
const call = (id: string, name = "look") => ({ id, type: "function", function: { name, arguments: "{}" } });

test("empty or repeated tool call identity is an error that keeps the bytes", async () => {
  const m = standin([calls(call("a"), call("a")), calls(call("")), calls(call("a", ""))]);
  const p = provider(m.url);
  for (const re of [/share an id/, /empty id or name/, /empty id or name/]) {
    const r = await p.turn(req());
    expect(asError(r)).toMatch(re);
    expect(r.kind === "error" && r.raw !== null && r.raw.length > 0).toBe(true);
  }
});

test("a malformed tool call is an error", async () => {
  const m = standin([calls({ id: "a", function: { name: "x" } }), calls("nope")]);
  const p = provider(m.url);
  expect(asError(await p.turn(req()))).toMatch(/malformed/);
  expect(asError(await p.turn(req()))).toMatch(/malformed/);
});

test("tool calls decide the stop, whatever the finish reason", async () => {
  const m = standin([ok({ content: "", tool_calls: [call("a")] }, "stop"), ok({ content: "" }, "tool_calls")]);
  const p = provider(m.url);
  expect(await p.turn(req())).toMatchObject({ kind: "answer", stop: "tool_calls", tool_calls: [{ id: "a" }] });
  expect(asError(await p.turn(req()))).toMatch(/no tool calls/);
});

test("a body that trickles in is cut off at the timeout", async () => {
  const enc = new TextEncoder();
  const s = startStandin({
    "POST /v1/chat/completions": () => new Response(new ReadableStream({
      async start(c) { for (let i = 0; i < 40; i++) { c.enqueue(enc.encode(" ")); await Bun.sleep(50); } c.close(); },
    })),
  });
  stops.push(s.stop);
  const t0 = Date.now();
  expect(asError(await provider(`${s.url}/v1`, { timeout_ms: 300 }).turn(req()))).toBe("no answer within 300 ms");
  expect(Date.now() - t0).toBeLessThan(1500);
}, 5000);

test("a model list that echoes the credential rejects without it", async () => {
  const m = standin([], { models: [{ id: KEY }] });
  const err = await provider(m.url, { credential: "LM_KEY" }).models().then(() => null, (e: Error) => e);
  expect(err!.message).toBe("the endpoint echoed the credential; response refused");
});

test("a reply with more than 64 tool calls is a failure", async () => {
  const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, type: "function", function: { name: "look", arguments: "{}" } }));
  const m = standin([ok({ content: null, tool_calls: calls(65) }, "tool_calls"), ok({ content: null, tool_calls: calls(64) }, "tool_calls")]);
  const p = provider(m.url);
  expect(asError(await p.turn(req()))).toContain("the reply holds 65 tool calls; at most 64 are accepted");
  expect(await p.turn(req())).toMatchObject({ kind: "answer", stop: "tool_calls" });
});

test("every chat request carries max_tokens: the manifest's limit, 8192 when it gives none", async () => {
  expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(8192);
  const m = standin([ok({ content: "a" }), ok({ content: "b" })]);
  await provider(m.url).turn(req());
  await provider(m.url, { max_output_tokens: 2048 }).turn(req());
  const sent = m.requests.filter((x) => x.method === "POST").map((x) => (JSON.parse(x.body) as { max_tokens: unknown }).max_tokens);
  expect(sent).toEqual([8192, 2048]);
  expect(provider(m.url, { max_output_tokens: 2048 }).max_output_tokens).toBe(2048);
});

test("a reply cut off at the output limit is a length stop even when it holds tool calls", async () => {
  const m = standin([ok({ content: "", tool_calls: [call("a")] }, "length")]);
  expect(await provider(m.url).turn(req())).toMatchObject({ kind: "answer", stop: "length" });
});

test("a timeout and an unreachable endpoint are marked transient; other failures are not", async () => {
  const slow = standin([{ delayMs: 2000, json: {} }]);
  expect(await provider(slow.url, { timeout_ms: 200 }).turn(req())).toMatchObject({ kind: "error", transient: { kind: "timeout", ms: 200 } });
  const gone = standin([]);
  gone.stop();
  expect(await provider(gone.url).turn(req())).toMatchObject({ kind: "error", transient: { kind: "transport" } });
  const bad = standin([{ text: "not json" }, { status: 500, text: "boom" }]);
  for (let i = 0; i < 2; i++) {
    const r = await provider(bad.url).turn(req());
    expect(r.kind === "error" && "transient" in r).toBe(false);
  }
}, 5000);

test("a request asking for structured output carries an OpenAI-style json_schema response_format, unless the manifest turns it off", async () => {
  const schema: Schema = { type: "object", required: ["n"], properties: { n: { type: "number" } }, additionalProperties: false };
  const asked = req({ response_format: { name: "research-output", schema } });
  const on = provider("http://127.0.0.1:1/v1");
  expect(on.structured_output).toBe(true);
  const sent = JSON.parse(new TextDecoder().decode(on.body(asked))) as Record<string, unknown>;
  expect(sent.response_format).toEqual({ type: "json_schema", json_schema: { name: "research-output", schema, strict: true } });
  expect(JSON.parse(new TextDecoder().decode(on.body(req()))) as Record<string, unknown>).not.toHaveProperty("response_format");
  const off = provider("http://127.0.0.1:1/v1", { structured_output: false });
  expect(off.structured_output).toBe(false);
  expect(JSON.parse(new TextDecoder().decode(off.body(asked))) as Record<string, unknown>).not.toHaveProperty("response_format");
});

const SAMPLING = { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 1.5, frequency_penalty: 0.1, repeat_penalty: 1.1 };
const sentBodies = (m: { requests: { method: string; body: string }[] }): Record<string, unknown>[] => m.requests.filter((x) => x.method === "POST").map((x) => JSON.parse(x.body) as Record<string, unknown>);

test("the manifest's sampling settings go in the chat request body under the OpenAI field names, and only those given", async () => {
  const m = standin([ok({ content: "a" }), ok({ content: "b" })]);
  await provider(m.url, { sampling: SAMPLING }).turn(req());
  await provider(m.url, { sampling: { temperature: 0.2 } }).turn(req());
  const [all, some] = sentBodies(m);
  expect(all).toMatchObject(SAMPLING);
  expect(some!.temperature).toBe(0.2);
  for (const k of ["top_p", "top_k", "min_p", "presence_penalty", "frequency_penalty", "repeat_penalty"]) expect(some).not.toHaveProperty(k);
  const p = provider(m.url, { sampling: SAMPLING });
  expect(JSON.parse(new TextDecoder().decode(p.body(req()))) as Record<string, unknown>).toMatchObject(SAMPLING);
  expect(JSON.parse(new TextDecoder().decode(provider(m.url).body(req()))) as Record<string, unknown>).not.toHaveProperty("temperature");
});

test("a request's own sampling and max_output_tokens win over the model's, key by key", async () => {
  const m = standin([ok({ content: "a" })]);
  const p = provider(m.url, { sampling: SAMPLING, max_output_tokens: 1000 });
  await p.turn(req({ sampling: { temperature: 0.3, top_k: 40 }, max_output_tokens: 4096 }));
  expect(sentBodies(m)[0]).toMatchObject({ ...SAMPLING, temperature: 0.3, top_k: 40, max_tokens: 4096 });
});

test("every request turns off Bun's own idle timeout, so the manifest's timeout_ms is the only one", async () => {
  const m = standin([ok({ content: "a" })], { models: [{ id: "m" }] });
  const real = globalThis.fetch;
  const inits: Record<string, unknown>[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => { inits.push({ ...(init ?? {}) }); return real(input, init); }) as typeof fetch;
  try {
    const p = provider(m.url, { timeout_ms: 400000 });
    await p.models();
    expect((await p.turn(req())).kind).toBe("answer");
  } finally {
    globalThis.fetch = real;
  }
  expect(inits.length).toBe(3);
  for (const init of inits) expect(init.timeout).toBe(false);
});
