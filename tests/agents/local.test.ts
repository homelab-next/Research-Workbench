import { afterEach, expect, test } from "bun:test";
import { LocalProvider, DEFAULT_CONTEXT } from "../../src/agents/providers/local";
import type { TurnRequest, TurnResult } from "../../src/agents/providers";
import { Secrets } from "../../src/modules/secrets";
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
const provider = (url: string, o: { credential?: string | null; context?: number | null; efforts?: string[]; timeout_ms?: number; max_bytes?: number } = {}) =>
  new LocalProvider({
    id: "lm", base_url: url, where: "machine", credential: o.credential ?? null, secrets: new Secrets({ LM_KEY: KEY }, null),
    context: o.context ?? null, efforts: o.efforts ?? [], timeout_ms: o.timeout_ms ?? 5000, ...(o.max_bytes === undefined ? {} : { max_bytes: o.max_bytes }),
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
  expect(await provider(m.url).models()).toEqual([{ id: "qwen/qwen3.6-35b-a3b", context: 131072, efforts: [] }]);
});

test("without the details endpoint the manifest's context is used, else the default", async () => {
  const a = standin([], { details: false, models: [{ id: "m" }] });
  expect(await provider(a.url, { context: 4096, efforts: ["low"] }).models()).toEqual([{ id: "m", context: 4096, efforts: ["low"] }]);
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
  expect(plain).toEqual({ model: "qwen/qwen3.6-35b-a3b", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }], stream: false });
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
