import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { Server as NetServer } from "node:net";
import type { Marking, Where } from "../../src/core/types";
import { MARKINGS } from "../../src/core/types";
import { runAgent } from "../../src/agents/loop";
import { assemblePack } from "../../src/agents/pack";
import { LocalProvider } from "../../src/agents/providers/local";
import { DEFAULT_LOOP_GUARD, LoopGuard } from "../../src/agents/providers/loopguard";
import type { TurnRequest, TurnResult } from "../../src/agents/providers";
import { Secrets } from "../../src/modules/secrets";
import { agent, fixture } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";
import { startModelStandin } from "../helpers/model-standin";

const enc = new TextEncoder();
const dec = new TextDecoder();
const stops: (() => void)[] = [];
afterEach(() => { while (stops.length > 0) stops.pop()!(); });

/** What one chat request is answered with: a list of SSE chunk objects (each sent as one `data:` event), or a generator of them. */
type Reply = { chunks: Iterable<Record<string, unknown>>; done?: boolean; per_pull?: number };
interface SseStandin { url: string; bodies: Record<string, unknown>[]; sent: number[]; cancelled: boolean[]; stop(): void }

/** An OpenAI-compatible streaming chat endpoint on 127.0.0.1, port 0. Bytes are enqueued only as the reader pulls, and counted per request. */
function sseStandin(replies: (Reply | ((body: Record<string, unknown>) => Reply))[]): SseStandin {
  const queue = [...replies];
  const out: SseStandin = { url: "", bodies: [], sent: [], cancelled: [], stop: () => undefined };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (req.method !== "POST" || u.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
      const body = JSON.parse(await req.text()) as Record<string, unknown>;
      out.bodies.push(body);
      const next = queue.shift();
      if (next === undefined) return new Response("no reply left", { status: 500 });
      const reply = typeof next === "function" ? next(body) : next;
      const i = out.sent.length;
      out.sent.push(0);
      out.cancelled.push(false);
      const it = reply.chunks[Symbol.iterator]();
      let ended = false;
      const stream = new ReadableStream<Uint8Array>({
        async pull(c) {
          await Bun.sleep(0);
          let text = "";
          for (let k = 0; k < (reply.per_pull ?? 1); k++) {
            const n = it.next();
            if (n.done) { ended = true; break; }
            text += `data: ${JSON.stringify(n.value)}\n\n`;
          }
          if (ended && reply.done !== false) text += "data: [DONE]\n\n";
          if (text !== "") {
            const bytes = enc.encode(text);
            out.sent[i]! += bytes.length;
            c.enqueue(bytes);
          }
          if (ended) c.close();
        },
        cancel() { out.cancelled[i] = true; },
      }, { highWaterMark: 0 });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  out.url = `http://127.0.0.1:${server.port}/v1`;
  out.stop = () => { void server.stop(true); };
  stops.push(out.stop);
  return out;
}

const provider = (url: string, o: { efforts?: string[]; loop_guard?: { enabled?: boolean; window?: number; repeats?: number }; max_bytes?: number } = {}) =>
  new LocalProvider({
    id: "lm", base_url: url, where: "machine", credential: null, secrets: new Secrets({}, null), context: null, efforts: o.efforts ?? [], timeout_ms: 20000,
    ...(o.loop_guard === undefined ? {} : { loop_guard: o.loop_guard }),
    ...(o.max_bytes === undefined ? {} : { max_bytes: o.max_bytes }),
  });
const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({
  model: "qwen/qwen3.6-35b-a3b", effort: null, key: "a", ordinal: 0,
  messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }], tools: [], ...over,
});
const head = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "qwen/qwen3.6-35b-a3b" };
const delta = (d: Record<string, unknown>, finish: string | null = null): Record<string, unknown> => ({ ...head, choices: [{ index: 0, delta: d, finish_reason: finish }] });
/** `text` cut into pieces of `n` characters. */
const pieces = (text: string, n: number): string[] => Array.from({ length: Math.ceil(text.length / n) }, (_, i) => text.slice(i * n, i * n + n));
const asError = (r: TurnResult): Extract<TurnResult, { kind: "error" }> => { if (r.kind !== "error") throw new Error(`expected error, got ${r.kind}`); return r; };
const LOOP = "The answer is 42, so let me check that once more before I write it down. ";
function* looping(field: "reasoning_content" | "content", times: number, lead: Record<string, unknown>[] = []): Generator<Record<string, unknown>> {
  yield* lead;
  for (let i = 0; i < times; i++) for (const p of pieces(LOOP, 12)) yield delta({ [field]: p });
  yield delta({}, "length");
}

test("the request asks for a stream with usage in its last chunk", () => {
  const sent = JSON.parse(dec.decode(provider("http://127.0.0.1:9/v1").body(req()))) as Record<string, unknown>;
  expect(sent).toMatchObject({ stream: true, stream_options: { include_usage: true } });
});

test("a normal stream assembles exactly like the same reply not streamed", async () => {
  const reasoning = "First I read the question.\nThen I think about it for a while, line by line.\n";
  const content = "The address belongs to a resolver; nothing else is known.";
  const usage = { prompt_tokens: 120, completion_tokens: 48, total_tokens: 168, completion_tokens_details: { reasoning_tokens: 30 } };
  const plain = startModelStandin({ replies: [{ json: { ...head, object: "chat.completion", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, reasoning_content: reasoning } }], usage } }] });
  stops.push(plain.stop);
  const streamed = sseStandin([{ chunks: [
    delta({ role: "assistant", content: "" }),
    ...pieces(reasoning, 7).map((p) => delta({ reasoning_content: p })),
    ...pieces(content, 5).map((p) => delta({ content: p })),
    delta({}, "stop"),
    { ...head, choices: [], usage },
  ] }]);
  const a = await provider(plain.url).turn(req());
  const b = await provider(streamed.url).turn(req());
  expect(b.kind).toBe("answer");
  const { raw: rawA, ...restA } = a as Extract<TurnResult, { kind: "answer" }>;
  const { raw: rawB, ...restB } = b as Extract<TurnResult, { kind: "answer" }>;
  expect(restB).toEqual(restA);
  expect(restB).toMatchObject({ content, reasoning, stop: "end", usage: { input: 120, output: 48, reasoning: 30 }, served_by: "qwen/qwen3.6-35b-a3b" });
  const pa = JSON.parse(dec.decode(rawA)) as Record<string, unknown>;
  const pb = JSON.parse(dec.decode(rawB)) as Record<string, unknown>;
  expect(pb).toEqual(pa);
});

test("a server that answers a stream request with plain JSON is read as before", async () => {
  const plain = startModelStandin({ replies: [{ json: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] } }] });
  stops.push(plain.stop);
  expect(await provider(plain.url).turn(req())).toMatchObject({ kind: "answer", content: "ok", stop: "end" });
});

test("tool calls split across chunks are reassembled", async () => {
  const s = sseStandin([{ chunks: [
    delta({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "list_sources", arguments: "" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: "{\"wh" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: "y\": \"to see\"}" } }] }),
    delta({ tool_calls: [{ index: 1, id: "call-2", type: "function", function: { name: "list_cards", arguments: "{\"why\":" } }] }),
    delta({ tool_calls: [{ index: 1, function: { arguments: " \"and these\"}" } }] }),
    delta({}, "tool_calls"),
  ] }]);
  const r = await provider(s.url).turn(req());
  expect(r).toMatchObject({ kind: "answer", stop: "tool_calls", content: "", tool_calls: [
    { id: "call-1", name: "list_sources", arguments: "{\"why\": \"to see\"}" },
    { id: "call-2", name: "list_cards", arguments: "{\"why\": \"and these\"}" },
  ] });
});

test("tool calls sent with no index are told apart by their id; a piece with no id continues the call before it", async () => {
  const s = sseStandin([{ chunks: [
    delta({ role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "list_sources", arguments: "{\"why\": " } }] }),
    delta({ tool_calls: [{ function: { arguments: "\"to see\"}" } }] }),
    delta({ tool_calls: [{ id: "call-2", type: "function", function: { name: "list_cards", arguments: "{\"why\": \"and these\"}" } }] }),
    delta({}, "tool_calls"),
  ] }]);
  expect(await provider(s.url).turn(req())).toMatchObject({ kind: "answer", stop: "tool_calls", tool_calls: [
    { id: "call-1", name: "list_sources", arguments: "{\"why\": \"to see\"}" },
    { id: "call-2", name: "list_cards", arguments: "{\"why\": \"and these\"}" },
  ] });
});

test("a looping reasoning stream is cut early, with the repeated text and what was received", async () => {
  // 40000 repeats: about 6 MB if it were read to the end
  const s = sseStandin([{ chunks: looping("reasoning_content", 40000, [delta({ role: "assistant", content: "" })]), per_pull: 20 }]);
  const r = asError(await provider(s.url).turn(req()));
  expect(r.message).toStartWith("the model repeated itself in its reasoning: ");
  expect(r.message).toContain("let me check that once more");
  expect(r.message.length).toBeLessThanOrEqual("the model repeated itself in its reasoning: ".length + 124);
  expect(r.cause).toBe("loop");
  expect(r.transient).toBeUndefined();
  expect(r.reasoning).toContain(LOOP);
  expect(r.reasoning!.length).toBeLessThan(20000);
  const recorded = JSON.parse(dec.decode(r.raw!)) as { choices: { finish_reason: string; message: Record<string, unknown> }[]; error: string };
  expect(recorded.choices[0]!.finish_reason).toBe("loop");
  expect(recorded.error).toBe(r.message);
  // the full stream is megabytes; far less than that was ever sent
  expect(s.sent[0]!).toBeLessThan(200_000);
  await Bun.sleep(20);
  expect(s.cancelled[0]).toBe(true);
}, 30000);

test("a looping content stream is cut too", async () => {
  const s = sseStandin([{ chunks: looping("content", 40000), per_pull: 20 }]);
  const r = asError(await provider(s.url).turn(req()));
  expect(r.message).toStartWith("the model repeated itself in its reply: ");
  expect(s.sent[0]!).toBeLessThan(200_000);
}, 30000);

test("with the guard off a loop runs to the output limit as before", async () => {
  const s = sseStandin([{ chunks: looping("reasoning_content", 200), per_pull: 20 }]);
  const r = await provider(s.url, { loop_guard: { enabled: false } }).turn(req());
  expect(r).toMatchObject({ kind: "answer", stop: "length" });
});

test("a loop with a thinking switch offers to retry without thinking; without one it does not", async () => {
  const a = sseStandin([{ chunks: looping("reasoning_content", 2000), per_pull: 20 }, { chunks: looping("reasoning_content", 2000), per_pull: 20 }, { chunks: looping("reasoning_content", 2000), per_pull: 20 }]);
  expect(asError(await provider(a.url, { efforts: ["low", "none"] }).turn(req({ effort: "low" }))).retry_effort).toBe("none");
  expect(asError(await provider(a.url, { efforts: ["low"] }).turn(req({ effort: "low" }))).retry_effort).toBeUndefined();
  // thinking already off: nothing left to switch
  expect(asError(await provider(a.url, { efforts: ["low", "none"] }).turn(req({ effort: "none" }))).retry_effort).toBeUndefined();
}, 30000);

test("a stream that drops mid-way cannot be reached, as before", async () => {
  const net: NetServer = createServer((sock) => {
    sock.once("data", () => {
      const event = `data: ${JSON.stringify(delta({ reasoning_content: "thinking about " }))}\n\n`;
      sock.write(`HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n${event.length.toString(16)}\r\n${event}\r\n`);
      setTimeout(() => sock.destroy(), 20);
    });
  });
  await new Promise<void>((res) => net.listen(0, "127.0.0.1", () => res()));
  stops.push(() => { net.close(); });
  const port = (net.address() as { port: number }).port;
  const r = asError(await provider(`http://127.0.0.1:${port}/v1`).turn(req()));
  expect(r.message).toStartWith("the endpoint could not be reached");
  expect(r.transient).toEqual({ kind: "transport" });
});

test("a stream that ends with no finish reason and no [DONE] cannot be reached", async () => {
  const s = sseStandin([{ chunks: [delta({ content: "half a rep" })], done: false }]);
  const r = asError(await provider(s.url).turn(req()));
  expect(r.message).toStartWith("the endpoint could not be reached");
  expect(r.transient).toEqual({ kind: "transport" });
});

test("a stream larger than the byte limit is refused", async () => {
  const s = sseStandin([{ chunks: Array.from({ length: 400 }, (_, i) => delta({ content: `line ${i} of a long and honest reply\n` })) }]);
  expect(asError(await provider(s.url, { max_bytes: 4096 }).turn(req())).message).toBe("the reply was larger than 4096 bytes; refused");
});

// --- every reply that reaches the ledger passed the credential echo check, whichever way the stream ended

const KEY = "sk-stream-secret-0123456789abcdef";
const keyed = (url: string) => new LocalProvider({ id: "lm", base_url: url, where: "machine", credential: "LM_KEY", secrets: new Secrets({ LM_KEY: KEY }, null), context: null, efforts: [], timeout_ms: 20000 });
/** A stream standin that sends the given raw SSE events, as written. */
function rawStandin(events: string[]): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    let i = 0;
    return new Response(new ReadableStream<Uint8Array>({ async pull(c) { await Bun.sleep(0); const n = events[i++]; if (n === undefined) { c.close(); return; } c.enqueue(enc.encode(n)); } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  } });
  stops.push(() => { void server.stop(true); });
  return `http://127.0.0.1:${server.port}/v1`;
}
const ev = (o: unknown): string => `data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`;

test("a stream that echoed the credential and then sent a chunk that is not JSON is refused, with nothing recorded", async () => {
  const r = asError(await keyed(rawStandin([ev(delta({ content: `the key is ${KEY} ` })), ev("{not json")])).turn(req()));
  expect(r.message).toBe("the endpoint echoed the credential; response refused");
  expect(r.raw).toBeNull();
});

test("an error event that echoes the credential is refused, with nothing recorded", async () => {
  const r = asError(await keyed(rawStandin([ev(delta({ content: "abc" })), ev({ error: { message: `bad auth ${KEY}` } })])).turn(req()));
  expect(r.message).toBe("the endpoint echoed the credential; response refused");
  expect(r.raw).toBeNull();
});

test("an error event or a broken chunk with no echo is still recorded as received", async () => {
  const a = asError(await keyed(rawStandin([ev(delta({ content: "abc" })), ev({ error: { message: "Model unloaded" } })])).turn(req()));
  expect(a.message).toBe("the endpoint broke off the reply: Model unloaded");
  expect(dec.decode(a.raw!)).toContain("Model unloaded");
  const b = asError(await keyed(rawStandin([ev(delta({ content: "abc" })), ev("{not json")])).turn(req()));
  expect(b.message).toBe("a streamed chunk of the reply is not JSON");
  expect(dec.decode(b.raw!)).toContain("abc");
});

// --- the detector itself

const feedAll = (g: LoopGuard, text: string, step = 13): string | null => {
  for (const p of pieces(text, step)) { const hit = g.feed(p); if (hit !== null) return hit; }
  return null;
};

test("the defaults are a 400-character window seen 3 times, on", () => {
  expect(DEFAULT_LOOP_GUARD).toEqual({ enabled: true, window: 400, repeats: 3 });
});

test("a short unit is a loop in the reasoning only at 40 repeats spanning 4000 characters; varied text of any length is not", () => {
  // a window too long to fire, so the short-unit check is seen alone
  const alone = { enabled: true, window: 20000, repeats: 1 };
  const unit = `${LOOP}Then I look at the lease table again for it.`.padEnd(120, "!"); // 120 characters, no shorter period
  expect(unit.length).toBe(120);
  expect(feedAll(new LoopGuard(alone, { short: true }), unit.repeat(39))).toBeNull();
  expect(feedAll(new LoopGuard(alone, { short: true }), unit.repeat(45))).not.toBeNull();
  // a 74-character unit needs 55 repeats to span 4000 characters
  expect(feedAll(new LoopGuard(alone, { short: true }), LOOP.repeat(54))).toBeNull();
  expect(feedAll(new LoopGuard(alone, { short: true }), LOOP.repeat(60))).not.toBeNull();
  // a 20-character unit needs 200 repeats to span 4000 characters
  const small = `${"a".repeat(19)}b`;
  expect(feedAll(new LoopGuard(alone, { short: true }), small.repeat(199))).toBeNull();
  expect(feedAll(new LoopGuard(alone, { short: true }), small.repeat(210))).not.toBeNull();
  // the reply is never read for short units
  expect(feedAll(new LoopGuard(alone, { short: false }), unit.repeat(300))).toBeNull();
  const honest = Array.from({ length: 3000 }, (_, i) => `Step ${i}: the count of rows for host-${i % 97} is ${(i * 7919) % 1000}.\n`).join("");
  expect(feedAll(new LoopGuard(DEFAULT_LOOP_GUARD, { short: true }), honest)).toBeNull();
  // a long rule of one character is not a short unit: only the window check can catch it
  expect(feedAll(new LoopGuard(DEFAULT_LOOP_GUARD, { short: true }), `intro\n${"-".repeat(600)}\nafter`)).toBeNull();
});

/** Ordinary replies that repeat a row or an object: a table, a JSON array, a plan. None is a loop. */
const ROW = "| ws-17.example.net | connected | ap-9 |";
const OBJECT = { address: "192.0.2.61", device: "ws-17.example.net", status: "connected", ap: "ap-9" };
const ORDINARY: Record<string, string> = {
  "7 identical rows": ["| device | status | ap |", "|---|---|---|", ...Array.from({ length: 7 }, () => ROW)].join("\n"),
  "12 identical table rows": ["| device | status | ap |", "|---|---|---|", ...Array.from({ length: 12 }, () => ROW), "That is all."].join("\n"),
  "10 identical pretty-printed objects": JSON.stringify(Array.from({ length: 10 }, () => OBJECT), null, 2),
  "12 sub-goals from one pivot in a plan": JSON.stringify({ goal: "who", subgoals: Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, title: "Who uses the device", have: [{ type: "address", value: `192.0.2.${i}` }], want: "account", route: ["address_to_asset_by_lease", "asset_to_accounts"], playbook: null })) }, null, 2),
  "300 varied rows": Array.from({ length: 300 }, (_, i) => `| 2026-01-03T10:${String(i % 60).padStart(2, "0")}:00Z | 192.0.2.${i % 250} | ws-${i}.example.net | ap-${i % 7} |`).join("\n"),
  "80 rows differing in one late cell": Array.from({ length: 80 }, (_, i) => `| ws-17.example.net | connected to the corporate wireless network | ap-9 | band=5GHz | ${i} |`).join("\n"),
};

test.each(Object.keys(ORDINARY))("an ordinary reply with %s is not a loop, in the reply or in the reasoning", (name) => {
  for (const step of [3, 13, 100]) {
    expect({ name, step, hit: feedAll(new LoopGuard(DEFAULT_LOOP_GUARD, { short: false }), ORDINARY[name]!, step) }).toEqual({ name, step, hit: null });
    expect({ name, step, hit: feedAll(new LoopGuard(DEFAULT_LOOP_GUARD, { short: true }), ORDINARY[name]!, step) }).toEqual({ name, step, hit: null });
  }
});

test("the provider runs the short-unit check on the reasoning and not on the reply", async () => {
  // a window too long to fire: only the short-unit check could cut these
  const guard = { window: 20000, repeats: 1 };
  const reasoning = sseStandin([{ chunks: looping("reasoning_content", 60), per_pull: 20 }]);
  expect(asError(await provider(reasoning.url, { loop_guard: guard }).turn(req())).message).toStartWith("the model repeated itself in its reasoning: ");
  const content = sseStandin([{ chunks: looping("content", 60), per_pull: 20 }]);
  expect(await provider(content.url, { loop_guard: guard }).turn(req())).toMatchObject({ kind: "answer", stop: "length", content: LOOP.repeat(60) });
});

test("a streamed reply of 12 identical table rows is answered whole, not cut", async () => {
  const text = ORDINARY["12 identical table rows"]!;
  const s = sseStandin([{ chunks: [...pieces(text, 3).map((p) => delta({ content: p })), delta({}, "stop")], per_pull: 20 }]);
  expect(await provider(s.url).turn(req())).toMatchObject({ kind: "answer", stop: "end", content: text });
});

test("a long passage seen again and again is a loop once its window has been seen K times before", () => {
  const passage = Array.from({ length: 12 }, (_, i) => `sentence ${i} says something new about the address; `).join("");
  expect(passage.length).toBeGreaterThan(400);
  const g = new LoopGuard({ enabled: true, window: 400, repeats: 3 }, { short: true });
  expect(feedAll(g, passage.repeat(3))).toBeNull();
  const hit = feedAll(g, passage.repeat(3));
  expect(hit).not.toBeNull();
  expect(hit!.length).toBeLessThanOrEqual(120);
});

test("an earlier unrelated quote of the window does not count as a loop", () => {
  const passage = Array.from({ length: 12 }, (_, i) => `sentence ${i} says something new about the address; `).join("");
  const fresh = Array.from({ length: 40 }, (_, i) => `and then point ${i} follows. `).join("");
  expect(feedAll(new LoopGuard(DEFAULT_LOOP_GUARD, { short: true }), passage + fresh + passage + fresh + passage)).toBeNull();
});

// --- the loop asks again without thinking, and the ledger shows both

const POLICY = Object.fromEntries(MARKINGS.map((m, i): [Marking, Where[]] => [m, i < 2 ? ["machine", "network", "hosted"] : i < 4 ? ["machine", "network"] : ["machine"]])) as Record<Marking, Where[]>;
let f: Fixture | null = null;
beforeEach(() => { f = null; });
afterEach(() => {
  if (f === null) return;
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});
const runOn = (p: LocalProvider, effort: string | null) => {
  f = fixture(true);
  const pk = assemblePack([{ kind: "rules", id: "r", title: "Rules", text: "be careful", marking: null, fixed: true }], { budget: 10000, case_marking: "TLP:GREEN", max_marking: null });
  if ("too_big" in pk) throw new Error("pack too big");
  return runAgent(f.s, { actor: { ...agent, effort }, provider: p, model: "qwen/qwen3.6-35b-a3b", effort, pack: pk, task: "do it", tools: [], ctx: f.ctx, schema: null, policy: POLICY, max_marking: null });
};
const answer = (content: string): Reply => ({ chunks: [delta({ role: "assistant", content }), delta({}, "stop")] });

test("a loop is recorded with what was received, then asked once more with reasoning_effort none", async () => {
  const s = sseStandin([{ chunks: looping("reasoning_content", 40000), per_pull: 20 }, answer("done")]);
  const end = await runOn(provider(s.url, { efforts: ["low", "none"] }), "low");
  expect(end).toMatchObject({ kind: "done", content: "done" });
  expect(s.bodies.map((b) => b.reasoning_effort)).toEqual(["low", "none"]);
  const mine = f!.s.entries().filter((e) => e.type === "model.request" || e.type === "model.response");
  expect(mine.map((e) => e.type)).toEqual(["model.request", "model.response", "model.request", "model.response"]);
  const [, failed, again] = mine as [never, Extract<typeof mine[number], { type: "model.response" }>, Extract<typeof mine[number], { type: "model.request" }>];
  expect(failed.payload.stop).toBe("error");
  expect(failed.payload.reasoning).not.toBeNull();
  expect(f!.s.blobs.text(failed.payload.reasoning!.blob)).toContain(LOOP);
  expect((JSON.parse(f!.s.blobs.text(failed.payload.response.blob)) as { choices: { finish_reason: string }[] }).choices[0]!.finish_reason).toBe("loop");
  expect(again.cause).toBe(failed.seq);
  expect(again.payload.effort).toBe("none");
  expect(again.payload.note).toStartWith("asked again with reasoning_effort none: the model repeated itself in its reasoning");
  expect((JSON.parse(f!.s.blobs.text(again.payload.messages.blob)) as Record<string, unknown>).reasoning_effort).toBe("none");
}, 30000);

test("a loop without a thinking switch fails as a model failure, asked once", async () => {
  const s = sseStandin([{ chunks: looping("reasoning_content", 40000), per_pull: 20 }, answer("never asked")]);
  const end = await runOn(provider(s.url, { efforts: ["low"] }), "low");
  expect(end.kind).toBe("error");
  expect(end.kind === "error" && end.message).toStartWith("the model repeated itself in its reasoning: ");
  expect(s.bodies.length).toBe(1);
}, 30000);

test("a loop again without thinking ends the agent, saying what happened twice", async () => {
  const s = sseStandin([{ chunks: looping("reasoning_content", 40000), per_pull: 20 }, { chunks: looping("content", 40000), per_pull: 20 }]);
  const end = await runOn(provider(s.url, { efforts: ["low", "none"] }), "low");
  expect(end).toMatchObject({ kind: "error", retried: true });
  expect(end.kind === "error" && end.message).toStartWith("the model repeated itself twice");
  expect(s.bodies.length).toBe(2);
}, 30000);
