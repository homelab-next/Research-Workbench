import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import type { Entry, EntryType, Marking, Where } from "../../src/core/types";
import { MARKINGS } from "../../src/core/types";
import type { Schema } from "../../src/core/schema";
import { IdAllocator } from "../../src/core/ids";
import { extractJson, MAX_TURNS, runAgent } from "../../src/agents/loop";
import type { AgentEnd, AgentSpec } from "../../src/agents/loop";
import type { Pack } from "../../src/agents/pack";
import { assemblePack } from "../../src/agents/pack";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import type { ScriptReply } from "../../src/agents/providers/scripted";
import type { Provider, TurnRequest } from "../../src/agents/providers/types";
import type { ToolName } from "../../src/agents/tools";
import { agent, fixture } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

const POLICY = Object.fromEntries(MARKINGS.map((m, i): [Marking, Where[]] => [m, i < 2 ? ["machine", "network", "hosted"] : i < 4 ? ["machine", "network"] : ["machine"]])) as Record<Marking, Where[]>;
const dec = new TextDecoder();
const ALL: readonly ToolName[] = ["list_sources", "list_cards", "run_step", "run_pivot"];

let f: Fixture;
beforeEach(() => { f = fixture(true); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});

const pack = (marking: Marking = "TLP:GREEN"): Pack => {
  const p = assemblePack(
    [{ kind: "rules", id: "r", title: "Rules", text: "be careful", marking: null, fixed: true }, { kind: "goal", id: "g", title: "Goal", text: "find out", marking: null, fixed: false }],
    { budget: 10000, case_marking: marking, max_marking: null },
  );
  if ("too_big" in p) throw new Error("pack too big");
  return p;
};

interface Spy extends Provider { turns: number; seen: TurnRequest[]; atTurn: string[][] }
function spy(replies: ScriptReply[], where: Where = "machine"): Spy {
  const inner = new ScriptedProvider({ id: "p", scripts: [{ id: "m", turns: replies.map((reply) => ({ actor: agent.id, reply })) }] });
  const s: Spy = {
    id: "p", kind: "scripted", where, turns: 0, seen: [], atTurn: [],
    models: () => inner.models(), body: (r) => inner.body(r),
    turn: async (r) => {
      s.turns++;
      s.seen.push(r);
      s.atTurn.push(f.s.entries().map((e) => e.type));
      return inner.turn(r);
    },
  };
  return s;
}

function spec(provider: Provider, over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    actor: agent, provider, model: "m", effort: null, pack: pack(), task: "do it", tools: ALL, ctx: f.ctx, schema: null,
    policy: POLICY, max_marking: null, ...over,
  };
}
const go = (replies: ScriptReply[], over: Partial<AgentSpec> = {}, where: Where = "machine"): Promise<AgentEnd> & { p: Spy } => {
  const p = spy(replies, where);
  return Object.assign(runAgent(f.s, spec(p, over)), { p });
};
const types = (): string[] => f.s.entries().map((e) => e.type);
const ofType = <T extends EntryType>(t: T): Extract<Entry, { type: T }>[] => f.s.entries().filter((e): e is Extract<Entry, { type: T }> => e.type === t);
const text = (ref: { blob: string }): string => f.s.blobs.text(ref.blob);
const SCHEMA: Schema = { type: "object", required: ["n"], properties: { n: { type: "number" } }, additionalProperties: false };

test("MAX_TURNS is 16", () => { expect(MAX_TURNS).toBe(16); });

test("a request is in the ledger before the provider is contacted, and its response after", async () => {
  const p = spy([{ content: "hi" }]);
  const end = await runAgent(f.s, spec(p));
  expect(end).toEqual({ kind: "done", content: "hi", output: null, calls: [] });
  expect(p.atTurn[0]!.at(-1)).toBe("model.request");
  expect(types()).toEqual(["case.created", "plan.proposed", "plan.accepted", "model.request", "model.response"]);
});

test("the request blob is the exact body and the response blob the exact reply", async () => {
  const p = spy([{ content: "hi" }]);
  await runAgent(f.s, spec(p));
  const req = ofType("model.request")[0]!;
  const res = ofType("model.response")[0]!;
  expect(text(req.payload.messages)).toBe(dec.decode(p.body(p.seen[0]!)));
  expect(JSON.parse(text(res.payload.response))).toEqual({ content: "hi" });
  expect(res.cause).toBe(req.seq);
  expect(res.payload.request).toBe(req.payload.request);
  expect(res.payload.stop).toBe("end");
});

test("the request records the pack, what was left out, the marking and the tools", async () => {
  const pk = pack("TLP:AMBER");
  pk.left_out = [{ kind: "card", id: "c9", title: "x", hash: "h", chars: 3, fixed: false }];
  await runAgent(f.s, spec(spy([{ content: "hi" }]), { pack: pk }));
  const req = ofType("model.request")[0]!;
  expect(req.payload).toMatchObject({ provider: "p", model: "m", effort: null, where: "machine", marking: "TLP:AMBER", pack: pk.items, left_out: pk.left_out, tools: [...ALL] });
  expect(req.actor).toEqual(agent);
});

test("reasoning text is stored as its own blob", async () => {
  await runAgent(f.s, spec(spy([{ content: "hi", reasoning: "because" }])));
  const res = ofType("model.response")[0]!;
  expect(text(res.payload.reasoning!)).toBe("because");
});

test("a tool call is recorded before it runs and its return after", async () => {
  const p = spy([{ tool_calls: [{ tool: "list_sources", args: { why: "see what there is" } }] }, { content: "done" }]);
  const end = await runAgent(f.s, spec(p));
  expect(end.kind).toBe("done");
  expect(types().slice(3)).toEqual(["model.request", "model.response", "tool.called", "tool.returned", "model.request", "model.response"]);
  const called = ofType("tool.called")[0]!;
  const returned = ofType("tool.returned")[0]!;
  expect(called.payload).toMatchObject({ tool: "list_sources", why: "see what there is" });
  expect(called.payload.request).toBe(ofType("model.request")[0]!.payload.request);
  expect(returned.cause).toBe(called.seq);
  expect(returned.payload.call).toBe(called.payload.call);
  const toolMsg = p.seen[1]!.messages.at(-1)!;
  expect(toolMsg.role).toBe("tool");
  expect(text(returned.payload.result!)).toBe(toolMsg.content);
  expect(end.kind === "done" && end.calls).toEqual([{ call: called.payload.call, tool: "list_sources", args: { why: "see what there is" }, ok: true }]);
});

test("the model is given the tool's view and answers from it", async () => {
  const p = spy([{ tool_calls: [{ tool: "list_sources", args: { why: "w" } }] }, { content: "done" }]);
  await runAgent(f.s, spec(p));
  const msgs = p.seen[1]!.messages;
  expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  expect(msgs[0]!.content).toContain("be careful");
  expect(msgs[1]!.content).toBe("do it");
  expect(msgs[2]!.tool_calls![0]!.name).toBe("list_sources");
  expect(msgs[3]!.tool_call_id).toBe(msgs[2]!.tool_calls![0]!.id);
  expect(msgs[3]!.content).toContain("assets");
});

test("arguments that are not JSON, an unknown tool, a missing why and a budget argument are tool results, and the loop goes on", async () => {
  const p = spy([{ tool_calls: [{ tool: "list_sources", args: {} }, { tool: "nope", args: { why: "w" } }, { tool: "run_pivot", args: { pivot: "address_to_asset", value: "x", budget: 100, why: "w" } }, { tool: "list_cards", args: { why: "w", extra: 1 } }] }, { content: "ok" }]);
  const end = await runAgent(f.s, spec(p));
  expect(end.kind).toBe("done");
  expect(ofType("tool.returned").map((e) => e.payload.ok)).toEqual([false, false, false, false]);
  expect(ofType("query.issued").length).toBe(0);
  expect(p.seen[1]!.messages.filter((m) => m.role === "tool").length).toBe(4);
});

test("a call whose marking the model may not receive is not made", async () => {
  const p = spy([{ content: "x" }], "hosted");
  const end = await runAgent(f.s, spec(p, { pack: pack("TLP:AMBER") }));
  expect(end).toEqual({ kind: "blocked", marking: "TLP:AMBER" });
  expect(p.turns).toBe(0);
  expect(types().slice(3)).toEqual(["model.blocked"]);
  expect(ofType("model.blocked")[0]!.payload).toEqual({ stage: "research", marking: "TLP:AMBER", model: "m", where: "hosted" });
});

test("stricter data from a tool blocks the next call", async () => {
  f.sample.registry.source("assets")!.marking = "TLP:AMBER";
  const p = spy([{ tool_calls: [{ tool: "run_step", args: { step: "s1", why: "w" } }] }, { content: "never" }], "hosted");
  const end = await runAgent(f.s, spec(p, { pack: pack("TLP:GREEN") }));
  expect(p.turns).toBe(1);
  expect(end).toEqual({ kind: "blocked", marking: "TLP:AMBER" });
  expect(types().at(-1)).toBe("model.blocked");
  expect(ofType("tool.returned").length).toBe(1);
});

test("with a limit, a stricter tool result is withheld and the conversation goes on", async () => {
  f.sample.registry.source("assets")!.marking = "TLP:AMBER";
  const p = spy([{ tool_calls: [{ tool: "run_step", args: { step: "s1", why: "w" } }] }, { content: "fine" }], "hosted");
  const end = await runAgent(f.s, spec(p, { max_marking: "TLP:GREEN" }));
  expect(end.kind).toBe("done");
  expect(p.turns).toBe(2);
  const msg = p.seen[1]!.messages.at(-1)!;
  expect(JSON.parse(msg.content)).toEqual({ ok: false, summary: "withheld: marked TLP:AMBER, which this model may not receive" });
});

test("output that fails its schema gets one retry carrying the errors", async () => {
  const p = spy([{ content: '{"n":"x"}' }, { content: '{"n":2}' }]);
  const end = await runAgent(f.s, spec(p, { schema: SCHEMA }));
  expect(end).toMatchObject({ kind: "done", output: { n: 2 } });
  const last = p.seen[1]!.messages.at(-1)!;
  expect(last.role).toBe("user");
  expect(last.content).toStartWith("Your reply did not match the required output: ");
  expect(last.content).toEndWith("Reply again with the corrected JSON only.");
  expect(p.seen[1]!.messages.at(-2)).toMatchObject({ role: "assistant", content: '{"n":"x"}' });
});

test("output that fails twice is invalid, with the errors", async () => {
  const end = await runAgent(f.s, spec(spy([{ content: "no json" }, { content: '{"n":"x"}' }]), { schema: SCHEMA }));
  expect(end.kind).toBe("invalid");
  expect(end.kind === "invalid" && end.errors.length).toBeGreaterThan(0);
});

test("a reply that is cut off counts as a failure", async () => {
  // a scripted provider never says length; a stand-in that does
  const inner = spy([{ content: '{"n":1}' }, { content: '{"n":1}' }]);
  let n = 0;
  const p: Provider = { ...inner, body: (r) => inner.body(r), models: () => inner.models(), turn: async (r) => {
    const t = await inner.turn(r);
    return n++ === 0 && t.kind === "answer" ? { ...t, stop: "length" } : t;
  } };
  const end = await runAgent(f.s, spec(p, { schema: SCHEMA }));
  expect(end.kind).toBe("done");
  expect(n).toBe(2);
  expect(inner.seen[1]!.messages.at(-1)!.content).toContain("the reply was cut off");
});

test("JSON inside a fenced block is read", async () => {
  const end = await runAgent(f.s, spec(spy([{ content: 'Here:\n```json\n{"n":3}\n```\nbye' }]), { schema: SCHEMA }));
  expect(end).toMatchObject({ kind: "done", output: { n: 3 } });
  expect(extractJson('x {"a":1} y')).toEqual({ value: { a: 1 } });
  expect(extractJson("nothing")).toBeNull();
  expect(extractJson("[1,2]")).toBeNull();
});

test("a declined model is recorded as declined, never as an empty answer", async () => {
  const end = await runAgent(f.s, spec(spy([{ declined: "no" }])));
  expect(end).toEqual({ kind: "declined", reason: "no" });
  expect(types().slice(3)).toEqual(["model.request", "model.declined"]);
  expect(ofType("model.declined")[0]!.payload.reason).toBe("no");
});

test("a provider error is recorded with stop error and ends the loop", async () => {
  const end = await runAgent(f.s, spec(spy([{ error: "boom" }])));
  expect(end).toEqual({ kind: "error", message: "boom" });
  const res = ofType("model.response")[0]!;
  expect(res.payload).toMatchObject({ stop: "error", usage: { input: 0, output: 0, reasoning: 0 }, served_by: "m" });
  expect(JSON.parse(text(res.payload.response))).toEqual({ error: "boom" });
});

const human = { kind: "human", id: "analyst" } as const;
const startRun = (): void => {
  f.s.commit((_s, ids) => [{ type: "run.started", actor: human, payload: { run: ids.next("run"), pipeline: "p", pipeline_hash: "h", stages: [] } }]);
};

test("a paused run stops the loop before the next call", async () => {
  startRun();
  const p = spy([{ tool_calls: [{ tool: "list_sources", args: { why: "w" } }] }, { content: "x" }]);
  const inner = p.turn;
  p.turn = async (r) => {
    const out = await inner(r);
    f.s.commit(() => [{ type: "run.paused", actor: human, payload: { reason: "person asked" } }]);
    return out;
  };
  const end = await runAgent(f.s, spec(p));
  expect(end).toEqual({ kind: "stopped", why: "paused" });
  expect(p.turns).toBe(1);
  expect(ofType("tool.returned").length).toBe(1);
});

test("a run that is paused before the first call makes none", async () => {
  startRun();
  f.s.commit(() => [{ type: "run.paused", actor: human, payload: { reason: "r" } }]);
  const p = spy([{ content: "x" }]);
  expect(await runAgent(f.s, spec(p))).toEqual({ kind: "stopped", why: "paused" });
  expect(p.turns).toBe(0);
  expect(ofType("model.request").length).toBe(0);
});

test("at the run's token budget the loop stops before the next call", async () => {
  startRun();
  f.s.commit(() => [{ type: "budget.set", actor: human, payload: { tokens: 100 } }]);
  const p = spy([{ tool_calls: [{ tool: "list_sources", args: { why: "w" } }], usage: { input: 60, output: 50 } }, { content: "x" }]);
  const end = await runAgent(f.s, spec(p));
  expect(end).toEqual({ kind: "stopped", why: "budget" });
  expect(p.turns).toBe(1);
});

test("the loop gives up after max_turns", async () => {
  const call: ScriptReply = { tool_calls: [{ tool: "list_sources", args: { why: "w" } }] };
  const p = spy([call, call, call]);
  const end = await runAgent(f.s, spec(p, { max_turns: 2 }));
  expect(end).toEqual({ kind: "stopped", why: "turns" });
  expect(p.turns).toBe(2);
});

test("a second agent run on the same actor continues from the ledger, not from hidden state", async () => {
  const replies: ScriptReply[] = [{ content: "one" }, { content: "two" }];
  await runAgent(f.s, spec(spy(replies)));
  const p2 = spy(replies);
  const end = await runAgent(f.s, spec(p2));
  expect(p2.seen[0]!.ordinal).toBe(1);
  expect(end).toMatchObject({ kind: "done", content: "two" });
});

test("every request has one response and every call one return", async () => {
  const p = spy([{ tool_calls: [{ tool: "list_sources", args: { why: "a" } }, { tool: "list_cards", args: { why: "b" } }] }, { content: "ok" }]);
  await runAgent(f.s, spec(p));
  const reqs = ofType("model.request").map((e) => e.payload.request);
  expect(ofType("model.response").map((e) => e.payload.request)).toEqual(reqs);
  expect(ofType("tool.returned").map((e) => e.payload.call)).toEqual(ofType("tool.called").map((e) => e.payload.call));
  expect(ofType("tool.called").length).toBe(2);
});

test("entries carry the link's run, stage and job", async () => {
  f.ctx.link = { run: null, stage: "research", job: null };
  await runAgent(f.s, spec(spy([{ content: "hi" }])));
  expect(ofType("model.request")[0]!.stage).toBe("research");
  expect(ofType("model.response")[0]!.stage).toBe("research");
});

// ---- review fixes ----
const huge = "x".repeat(300_000);
/** Makes the next commit whose first entry has this type throw once, as a refused entry would. */
function refuseOnce(type: string): void {
  const real = f.s.commit.bind(f.s);
  let done = false;
  f.s.commit = ((build: Parameters<typeof real>[0]) => {
    if (!done) {
      const first = build(f.s.state, new IdAllocator(f.s.state))[0];
      if (first?.type === type) { done = true; throw new Error("refused: payload too large"); }
    }
    return real(build);
  }) as typeof f.s.commit;
}

test("a 300k-character tool name and 300k-character arguments are recorded small and the loop goes on", async () => {
  const p = spy([{ tool_calls: [{ tool: huge, args: { why: "w" } }, { tool: "list_cards", args: { why: "w", note: huge } }] }, { content: "ok" }]);
  const end = await runAgent(f.s, spec(p));
  expect(end.kind).toBe("done");
  const called = ofType("tool.called");
  expect(called[0]!.payload.tool.length).toBeLessThanOrEqual(200);
  expect(JSON.stringify(called[1]!.payload.args).length).toBeLessThan(1000);
  expect(ofType("tool.returned").length).toBe(2);
});

test("a long why is clipped to 500 in the entry", async () => {
  await runAgent(f.s, spec(spy([{ tool_calls: [{ tool: "list_cards", args: { why: huge } }] }, { content: "ok" }])));
  expect(ofType("tool.called")[0]!.payload.why.length).toBe(500);
});

test("a refused model.response is replaced by a small error response, and the loop ends with error", async () => {
  refuseOnce("model.response");
  const end = await runAgent(f.s, spec(spy([{ content: "hi" }])));
  expect(end.kind).toBe("error");
  const res = ofType("model.response");
  expect(res.length).toBe(1);
  expect(res[0]!.payload.stop).toBe("error");
});

test("a refused tool.returned is replaced by a small failed return, and the loop ends with error", async () => {
  refuseOnce("tool.returned");
  const end = await runAgent(f.s, spec(spy([{ tool_calls: [{ tool: "list_cards", args: { why: "w" } }] }, { content: "ok" }])));
  expect(end.kind).toBe("error");
  expect(ofType("tool.returned").map((e) => e.payload.ok)).toEqual([false]);
  const reqs = ofType("model.request");
  for (const r of reqs) expect(ofType("model.response").filter((e) => e.cause === r.seq).length).toBe(1);
  for (const c of ofType("tool.called")) expect(ofType("tool.returned").filter((e) => e.cause === c.seq).length).toBe(1);
});

test("a refused tool.called ends with error and the tool is not run", async () => {
  refuseOnce("tool.called");
  const end = await runAgent(f.s, spec(spy([{ tool_calls: [{ tool: "run_step", args: { step: "s1", why: "w" } }] }, { content: "ok" }])));
  expect(end.kind).toBe("error");
  expect(ofType("step.started").length).toBe(0);
  const reqs = ofType("model.request");
  for (const r of reqs) expect(ofType("model.response").filter((e) => e.cause === r.seq).length).toBe(1);
  for (const c of ofType("tool.called")) expect(ofType("tool.returned").filter((e) => e.cause === c.seq).length).toBe(1);
});

test("extractJson on 1 MiB of open braces is linear", () => {
  const t0 = performance.now();
  expect(extractJson("{".repeat(1024 * 1024))).toBeNull();
  expect(extractJson("```\n".repeat(200_000))).toBeNull();
  expect(performance.now() - t0).toBeLessThan(200);
});

test("negative, fractional and non-finite usage is clamped to non-negative integers", async () => {
  const inner = spy([{ content: "hi" }]);
  const p: Provider = { ...inner, body: (r) => inner.body(r), models: () => inner.models(), turn: async (r) => {
    const t = await inner.turn(r);
    return t.kind === "answer" ? { ...t, usage: { input: -50, output: Number.NaN, reasoning: 2.7 } } : t;
  } };
  const end = await runAgent(f.s, spec(p));
  expect(end.kind).toBe("done");
  expect(ofType("model.response")[0]!.payload.usage).toEqual({ input: 0, output: 0, reasoning: 2 });
});

test("at most 16 tool calls run per reply; the rest are returned as failed without running", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ tool: "list_cards", args: { why: `w${i}` } }));
  const p = spy([{ tool_calls: many }, { content: "ok" }]);
  const end = await runAgent(f.s, spec(p));
  expect(end.kind).toBe("done");
  const returns = ofType("tool.returned");
  expect(returns.length).toBe(40);
  expect(returns.slice(16).every((e) => !e.payload.ok && e.payload.summary === "too many tool calls in one reply")).toBe(true);
  expect(returns.slice(0, 16).every((e) => e.payload.ok)).toBe(true);
  expect(p.seen[1]!.messages.filter((m) => m.role === "tool").length).toBe(40);
});

test("a pause between calls stops the remaining calls of the turn", async () => {
  startRun();
  const p = spy([{ tool_calls: [{ tool: "list_cards", args: { why: "a" } }, { tool: "list_cards", args: { why: "b" } }] }, { content: "x" }]);
  const unsub = f.s.subscribe((e) => {
    if (e.type === "tool.returned") f.s.commit(() => [{ type: "run.paused", actor: human, payload: { reason: "r" } }]);
  });
  const end = await runAgent(f.s, spec(p));
  unsub();
  expect(end).toEqual({ kind: "stopped", why: "paused" });
  expect(ofType("tool.called").length).toBe(1);
});

test("a withheld result leaves the marking unchanged", async () => {
  f.sample.registry.source("assets")!.marking = "TLP:AMBER";
  const p = spy([{ tool_calls: [{ tool: "run_step", args: { step: "s1", why: "w" } }] }, { content: "a" }], "hosted");
  await runAgent(f.s, spec(p, { max_marking: "TLP:GREEN" }));
  expect(ofType("model.request").map((e) => e.payload.marking)).toEqual(["TLP:GREEN", "TLP:GREEN"]);
});

test("a card read raises the marking when there is no limit", async () => {
  await f.call("run_step", { step: "s1", why: "w" });
  f.s.state.cards.c1!.marking = "TLP:RED";
  const p = spy([{ tool_calls: [{ tool: "list_cards", args: { why: "w" } }] }, { content: "a" }], "hosted");
  const end = await runAgent(f.s, spec(p));
  expect(end).toEqual({ kind: "blocked", marking: "TLP:RED" });
  expect(p.turns).toBe(1);
});
