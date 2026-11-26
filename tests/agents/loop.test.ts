import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import type { Entry, EntryType, Marking, Where } from "../../src/core/types";
import { MARKINGS } from "../../src/core/types";
import type { Schema } from "../../src/core/schema";
import { IdAllocator } from "../../src/core/ids";
import { EMPTY_REASK, extractJson, MAX_TURNS, runAgent, turnLine } from "../../src/agents/loop";
import type { AgentEnd, AgentSpec } from "../../src/agents/loop";
import type { Pack } from "../../src/agents/pack";
import { assemblePack } from "../../src/agents/pack";
import { DraftWork, forcedProposal, REQUIRED_SECTIONS } from "../../src/agents/draft";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import type { ScriptReply } from "../../src/agents/providers/scripted";
import type { Provider, TurnRequest } from "../../src/agents/providers/types";
import type { ToolName } from "../../src/agents/tools";
import { agent, fixture } from "../helpers/tools-fixture";
import { LocalProvider } from "../../src/agents/providers/local";
import { Secrets } from "../../src/modules/secrets";
import { startModelStandin } from "../helpers/model-standin";
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
  expect(msgs[1]!.content).toBe("do it\n\nTurn 2 of 16.");
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
  // the cut-off reply is never parsed: its valid-looking JSON is not the answer; the same turn is asked once more
  expect(end.kind).toBe("done");
  expect(n).toBe(2);
  expect(inner.seen[1]!.messages).toEqual(inner.seen[0]!.messages);
  expect(ofType("model.response").map((e) => e.payload.stop)).toEqual(["length", "end"]);
});

/** A spy whose answers all stop at the output limit, holding a tool call; `limit` is the provider's max_output_tokens. */
const cutOff = (limit: number | undefined): Spy => {
  const inner = spy(Array.from({ length: 4 }, () => ({ content: '{"n":1}', tool_calls: [{ tool: "list_sources", args: { why: "w" } }] })));
  const turn = inner.turn;
  inner.turn = async (r) => {
    const t = await turn(r);
    return t.kind === "answer" ? { ...t, stop: "length" } : t;
  };
  if (limit !== undefined) Object.assign(inner, { max_output_tokens: limit });
  return inner;
};

test("a reply cut off at the output limit is recorded as a length stop, and neither its text nor its tool calls are used", async () => {
  for (const schema of [null, SCHEMA]) {
    const p = cutOff(8192);
    const end = await runAgent(f.s, spec(p, { schema }));
    expect(end.kind).toBe("error");
    expect(end.kind === "error" && end.message).toContain("ran past 8192 output tokens");
  }
  expect(ofType("model.response").every((e) => e.payload.stop === "length")).toBe(true);
  expect(ofType("tool.called").length).toBe(0);
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

test("a run paused while the model is asked runs none of the reply's calls, the first included", async () => {
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
  expect(ofType("model.response").length).toBe(1);
  expect(ofType("tool.called").length).toBe(0);
  expect(ofType("tool.returned").length).toBe(0);
});

test("a run paused after a reply's first call runs none of the rest", async () => {
  startRun();
  const p = spy([{ tool_calls: [{ tool: "list_sources", args: { why: "w" } }, { tool: "list_sources", args: { why: "v" } }] }, { content: "x" }]);
  const off = f.s.subscribe((e) => {
    if (e.type === "tool.returned" && f.s.state.run.status !== "paused") f.s.commit(() => [{ type: "run.paused", actor: human, payload: { reason: "person asked" } }]);
  });
  try {
    expect(await runAgent(f.s, spec(p))).toEqual({ kind: "stopped", why: "paused" });
  } finally { off(); }
  expect(ofType("tool.called").length).toBe(1);
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

test("with outside_run the loop answers while the run is paused or finished, and still checks the marking", async () => {
  startRun();
  f.s.commit(() => [{ type: "run.paused", actor: human, payload: { reason: "r" } }]);
  f.s.commit(() => [{ type: "budget.set", actor: human, payload: { tokens: 1 } }]);
  const a = spy([{ content: "answered", usage: { input: 50, output: 50 } }]);
  expect(await runAgent(f.s, spec(a, { outside_run: true, tools: [] }))).toEqual({ kind: "done", content: "answered", output: null, calls: [] });
  expect(a.turns).toBe(1);
  f.s.commit(() => [{ type: "run.finished", actor: human, payload: { outcome: "stopped" } }]);
  expect(f.s.state.run.status).toBe("finished");
  const b = spy([{ content: "skipped: the first turn was a.s" }, { content: "again" }]);
  expect((await runAgent(f.s, spec(b, { outside_run: true, tools: [] }))).kind).toBe("done");
  const c = spy([{ content: "never" }], "hosted");
  expect(await runAgent(f.s, spec(c, { outside_run: true, tools: [], pack: pack("TLP:AMBER") }))).toEqual({ kind: "blocked", marking: "TLP:AMBER" });
  expect(c.turns).toBe(0);
  expect(ofType("model.blocked").length).toBe(1);
});

test("an agent with no tools has any tool call in a reply recorded as skipped and never run", async () => {
  const p = spy([{ content: "plain words", tool_calls: [{ tool: "list_sources", args: { why: "w" } }, { tool: "run_step", args: { step: "s1", why: "w" } }] }]);
  const end = await runAgent(f.s, spec(p, { tools: [], outside_run: true }));
  expect(end).toEqual({ kind: "done", content: "plain words", output: null, calls: [] });
  expect(ofType("tool.called").length).toBe(0);
  expect(ofType("query.issued").length).toBe(0);
  expect(ofType("tool.skipped").map((e) => e.payload.count)).toEqual([2]);
  expect(p.seen[0]!.tools).toEqual([]);
});

test("only an outside_run agent with no tools has its tool calls skipped; a pipeline stage with no tools keeps its old behaviour", async () => {
  const p = spy([{ tool_calls: [{ tool: "list_sources", args: { why: "w" } }] }, { content: "done" }]);
  const end = await runAgent(f.s, spec(p, { tools: [] }));
  expect(end.kind).toBe("done");
  expect(ofType("tool.skipped")).toEqual([]);
  expect(ofType("tool.called").length).toBe(1);
  expect(ofType("tool.returned")[0]!.payload.ok).toBe(false);
});

test("a cause given to the loop is on its request and its block", async () => {
  const cause = f.s.head().seq;
  const a = spy([{ content: "x" }]);
  await runAgent(f.s, spec(a, { cause }));
  expect(ofType("model.request")[0]!.cause).toBe(cause);
  const b = spy([{ content: "y" }], "hosted");
  await runAgent(f.s, spec(b, { cause, pack: pack("TLP:AMBER") }));
  expect(ofType("model.blocked")[0]!.cause).toBe(cause);
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

test("extractJson on open braces grows with the input, not with its square", () => {
  const best = (n: number): number => {
    let ms = Infinity;
    for (let i = 0; i < 3; i++) { const t0 = performance.now(); expect(extractJson("{".repeat(n))).toBeNull(); ms = Math.min(ms, performance.now() - t0); }
    return Math.max(ms, 0.25);
  };
  expect(best(1024 * 1024) / best(128 * 1024)).toBeLessThan(24);   // linear is about 8; quadratic is about 64
  expect(extractJson("```\n".repeat(200_000))).toBeNull();
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

test("at most 16 tool calls run per reply; the rest are one entry, run nothing and do not reach the next request", async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ tool: "list_cards", args: { why: `w${i}` } }));
  const p = spy([{ tool_calls: many }, { content: "ok" }]);
  const end = await runAgent(f.s, spec(p));
  expect(end.kind).toBe("done");
  expect(ofType("tool.called").length).toBe(16);
  const returns = ofType("tool.returned");
  expect(returns.length).toBe(16);
  expect(returns.every((e) => e.payload.ok)).toBe(true);
  const skipped = ofType("tool.skipped");
  expect(skipped.map((e) => e.payload)).toEqual([{ request: ofType("model.request")[0]!.payload.request, count: 24, note: "24 further tool calls were not run" }]);
  expect(skipped[0]!.cause).toBe(ofType("model.request")[0]!.seq);
  // the next request answers the sixteen that ran and says the rest did not
  const next = p.seen[1]!.messages;
  expect(next.filter((m) => m.role === "tool").length).toBe(16);
  expect(next.find((m) => m.role === "assistant")!.tool_calls).toHaveLength(16);
  expect(next.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("24 further tool calls were not run") });
  expect(f.s.state.skipped).toEqual([]);
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

/** A spy whose turns, in order, are replaced by these failures (null keeps the scripted reply). */
type Fail = "timeout" | "transport" | "length" | "plain" | null;
// a scripted reply is chosen by the actor's request ordinal, which continues across runs in one case: enough replies for several runs
const failing = (fails: Fail[], replies: ScriptReply[] = Array.from({ length: 12 }, () => ({ content: "ok" }))): Spy => {
  const inner = spy(replies);
  const turn = inner.turn;
  let i = 0;
  Object.assign(inner, { max_output_tokens: 8192 });
  inner.turn = async (r) => {
    const t = await turn(r);
    const fail = fails[i++] ?? null;
    if (fail === "timeout") return { kind: "error", message: "no answer within 300000 ms", raw: null, transient: { kind: "timeout", ms: 300000 } };
    if (fail === "transport") return { kind: "error", message: "the endpoint could not be reached: reset", raw: null, transient: { kind: "transport" } };
    if (fail === "plain") return { kind: "error", message: "the reply is not JSON", raw: null };
    if (fail === "length" && t.kind === "answer") return { ...t, stop: "length" };
    return t;
  };
  return inner;
};

test("a call that times out, cannot reach the endpoint or runs past the output limit is made once more for the same turn", async () => {
  for (const fail of ["timeout", "transport", "length"] as const) {
    const head = f.s.head().seq;
    const p = failing([fail]);
    const end = await runAgent(f.s, spec(p));
    expect(end).toEqual({ kind: "done", content: "ok", output: null, calls: [] });
    const mine = f.s.entries().filter((e) => e.seq > head);
    expect(mine.map((e) => e.type)).toEqual(["model.request", "model.response", "model.request", "model.response"]);
    // the retry is caused by the failed response, and asks exactly what the failed request asked
    expect(mine[2]!.cause).toBe(mine[1]!.seq);
    expect(p.seen[1]!.messages).toEqual(p.seen[0]!.messages);
    expect((mine[1]!.payload as { stop: string }).stop).toBe(fail === "length" ? "length" : "error");
  }
});

test("a second failure ends the agent, saying plainly what happened twice", async () => {
  const cases: [Fail[], string][] = [
    [["timeout", "timeout"], "the model did not answer within 300 s twice"],
    [["length", "length"], "the model ran past 8192 output tokens twice"],
    [["timeout", "length"], "the model did not answer within 300 s, then ran past 8192 output tokens"],
    [["transport", "transport"], "the model endpoint could not be reached twice"],
  ];
  for (const [fails, said] of cases) {
    const p = failing(fails);
    const end = await runAgent(f.s, spec(p));
    expect(end).toMatchObject({ kind: "error", retried: true });
    expect(end.kind === "error" && end.message).toStartWith(said);
    expect(p.turns).toBe(2);
  }
});

test("a failure of another kind is not retried, and each turn has its own one retry", async () => {
  // turn one fails once then calls a tool; turn two fails once then answers
  const p = failing(["timeout", null, "length", null], [{ content: "x" }, { tool_calls: [{ tool: "list_sources", args: { why: "w" } }] }, { content: "y" }, { content: "done" }, { content: "z" }]);
  expect(await runAgent(f.s, spec(p))).toMatchObject({ kind: "done", content: "done" });
  expect(p.turns).toBe(4);
  const plain = failing(["plain"], Array.from({ length: 6 }, () => ({ content: "ok" })));
  expect(await runAgent(f.s, spec(plain))).toEqual({ kind: "error", message: "the reply is not JSON" });
  expect(plain.turns).toBe(1);
});

test("a stop or pause during the failed wait wins: no retry is made", async () => {
  startRun();
  const p = failing(["timeout"]);
  const turn = p.turn;
  p.turn = async (r) => {
    const out = await turn(r);
    f.s.commit(() => [{ type: "run.paused", actor: human, payload: { reason: "person asked" } }]);
    return out;
  };
  expect(await runAgent(f.s, spec(p))).toEqual({ kind: "stopped", why: "paused" });
  expect(p.turns).toBe(1);
  expect(ofType("model.request").length).toBe(1);
  expect(ofType("model.response").map((e) => e.payload.stop)).toEqual(["error"]);
});

test("the conversational agent, which works beside the run, is not retried", async () => {
  const p = failing(["timeout"]);
  const end = await runAgent(f.s, spec(p, { outside_run: true, tools: [] }));
  expect(end).toEqual({ kind: "error", message: "no answer within 300000 ms" });
  expect(p.turns).toBe(1);
});

/** A local provider on a stand-in endpoint answering these contents in turn; `bodies` are the request bodies it received. */
function onStandin(contents: string[], structured?: boolean, request_extra?: Record<string, never>) {
  const m = startModelStandin({ replies: contents.map((content) => ({ json: { choices: [{ finish_reason: "stop", message: { content } }] } })) });
  const p = new LocalProvider({
    id: "lm", base_url: m.url, where: "machine", credential: null, secrets: new Secrets({}, null), context: null, efforts: [], timeout_ms: 5000,
    ...(structured === undefined ? {} : { structured_output: structured }),
    ...(request_extra === undefined ? {} : { request_extra }),
  });
  const bodies = (): Record<string, unknown>[] => m.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.body) as Record<string, unknown>);
  return { p, bodies, stop: m.stop };
}

test("the re-ask after a schema failure asks a local model for structured output, and the ledger records it", async () => {
  const sa = onStandin(['{"n":"x"}', '{"n":2}']);
  try {
    const end = await runAgent(f.s, spec(sa.p, { schema: SCHEMA, schema_id: "research-output" }));
    expect(end).toMatchObject({ kind: "done", output: { n: 2 } });
    const [first, second] = sa.bodies();
    expect(first).not.toHaveProperty("response_format");
    expect(second!.response_format).toEqual({ type: "json_schema", json_schema: { name: "research-output", schema: SCHEMA, strict: true } });
    const recorded = ofType("model.request").map((e) => JSON.parse(text(e.payload.messages)) as Record<string, unknown>);
    expect(recorded).toEqual([first!, second!]);
  } finally { sa.stop(); }
});

test("a model whose manifest turns structured output off is re-asked without it", async () => {
  const sa = onStandin(['{"n":"x"}', '{"n":2}'], false);
  try {
    expect(await runAgent(f.s, spec(sa.p, { schema: SCHEMA }))).toMatchObject({ kind: "done" });
    expect(sa.bodies().map((b) => "response_format" in b)).toEqual([false, false]);
  } finally { sa.stop(); }
});

test("an empty reply with the answer in its reasoning is re-asked once, as the stage's one corrective re-ask", async () => {
  expect(EMPTY_REASK).toBe("Your reply was empty; your answer went into your reasoning. Put the JSON answer in the reply itself.");
  const p = spy([{ content: "  \n", reasoning: '{"n":1}' }, { content: '{"n":1}' }]);
  expect(await runAgent(f.s, spec(p, { schema: SCHEMA }))).toMatchObject({ kind: "done", output: { n: 1 } });
  expect(p.seen[1]!.messages.slice(-2)).toEqual([{ role: "assistant", content: "  \n" }, { role: "user", content: EMPTY_REASK }]);
});

test("after the empty-reply re-ask, a reply that fails its schema ends the agent: there is no second re-ask", async () => {
  // one script: the scripted provider's ordinal continues across the two runs
  const p = spy([{ content: "", reasoning: "thinking" }, { content: "" }, { content: "", reasoning: "thinking" }, { content: '{"n":"x"}' }]);
  for (const turns of [2, 4]) {
    const end = await runAgent(f.s, spec(p, { schema: SCHEMA }));
    expect(end.kind).toBe("invalid");
    expect(p.turns).toBe(turns);
  }
});

test("the empty-reply re-ask asks a local model for structured output", async () => {
  const sa = onStandin(["", '{"n":2}']);
  try {
    expect(await runAgent(f.s, spec(sa.p, { schema: SCHEMA }))).toMatchObject({ kind: "done", output: { n: 2 } });
    expect(sa.bodies().map((b) => "response_format" in b)).toEqual([false, true]);
  } finally { sa.stop(); }
});

test("an invalid end says what the model returned: nothing, the schema itself, no JSON, or an object that does not match", async () => {
  const p = spy([
    { content: "" }, { content: "" },
    { content: "x" }, { content: JSON.stringify({ kind: "schema", id: "s", title: "S", schema: SCHEMA }) },
    { content: "x" }, { content: JSON.stringify(SCHEMA) },
    { content: "" }, { content: "no json here" },
    { content: "" }, { content: '{"n":"x"}' },
  ]);
  const said: string[] = [];
  for (let i = 0; i < 5; i++) {
    const end = await runAgent(f.s, spec(p, { schema: SCHEMA }));
    said.push(end.kind === "invalid" ? end.returned : end.kind);
  }
  expect(said).toEqual([
    "the model returned nothing", "the model returned the schema itself", "the model returned the schema itself",
    "the model returned no JSON object", "the model returned an object that does not match its schema",
  ]);
});

test("an agent's own sampling and output limit go on every request, and the length message names the limit in force", async () => {
  const p = cutOff(8192);
  const end = await runAgent(f.s, spec(p, { sampling: { temperature: 0.4, top_k: 10 }, max_output_tokens: 65536 }));
  expect(end.kind === "error" && end.message).toContain("ran past 65536 output tokens");
  expect(p.seen.length).toBeGreaterThan(0);
  for (const r of p.seen) expect(r).toMatchObject({ sampling: { temperature: 0.4, top_k: 10 }, max_output_tokens: 65536 });
});

test("without its own settings an agent's request carries none, so the provider's apply", async () => {
  const p = spy([{ content: "done" }]);
  await runAgent(f.s, spec(p));
  expect(p.seen[0]).not.toHaveProperty("sampling");
  expect(p.seen[0]).not.toHaveProperty("max_output_tokens");
});

test("what a stage's sampling and limit make the local provider send is what model.request records", async () => {
  const sa = onStandin(['{"n":1}']);
  try {
    await runAgent(f.s, spec(sa.p, { schema: SCHEMA, sampling: { temperature: 0.3 }, max_output_tokens: 4096 }));
    const [sent] = sa.bodies();
    expect(sent).toMatchObject({ temperature: 0.3, max_tokens: 4096 });
    const recorded = ofType("model.request").map((e) => JSON.parse(text(e.payload.messages)) as Record<string, unknown>);
    expect(recorded).toEqual([sent!]);
  } finally { sa.stop(); }
});

test("the model's and the stage's request_extra go in the local provider's body, the stage's winning, and model.request records it", async () => {
  const sa = onStandin(['{"n":1}'], undefined, { chat_template_kwargs: { enable_thinking: true }, seed: 1 } as never);
  try {
    await runAgent(f.s, spec(sa.p, { schema: SCHEMA, request_extra: { chat_template_kwargs: { enable_thinking: false } } }));
    const [sent] = sa.bodies();
    expect(sent).toMatchObject({ chat_template_kwargs: { enable_thinking: false }, seed: 1 });
    const recorded = ofType("model.request").map((e) => JSON.parse(text(e.payload.messages)) as Record<string, unknown>);
    expect(recorded).toEqual([sent!]);
  } finally { sa.stop(); }
});

test("each request's task text states the turn; two turns before the end it says to finish; the last turn may not call tools", async () => {
  const call: ScriptReply = { tool_calls: [{ tool: "list_sources", args: { why: "w" } }] };
  const p = spy([call, call, call, { content: '{"n":1}', tool_calls: [{ tool: "list_sources", args: { why: "again" } }] }]);
  const end = await runAgent(f.s, spec(p, { max_turns: 4, schema: SCHEMA }));
  expect(end).toMatchObject({ kind: "done", output: { n: 1 } });
  const tasks = p.seen.map((r) => r.messages[1]!);
  expect(tasks.map((m) => m.role)).toEqual(["user", "user", "user", "user"]);
  expect(tasks[0]!.content).toBe("do it\n\nTurn 1 of 4.");
  expect(tasks[1]!.content).toBe("do it\n\nTurn 2 of 4.");
  expect(tasks[2]!.content).toBe("do it\n\nTurn 3 of 4. Two turns left: finish your proposals and give your final answer next turn.");
  expect(tasks[3]!.content).toBe("do it\n\nTurn 4 of 4. This is the last turn: give your final answer now; no tool will be run.");
  expect(p.seen.slice(0, 3).map((r) => r.tool_choice)).toEqual([undefined, undefined, undefined]);
  expect(p.seen[3]!.tool_choice).toBe("none");
  // the tool call in the last reply is not run: it is recorded as skipped
  expect(ofType("tool.called").length).toBe(3);
  const skipped = ofType("tool.skipped");
  expect(skipped.length).toBe(1);
  expect(skipped[0]!.payload).toMatchObject({ count: 1, note: "1 tool calls were not run: this was the last turn" });
});

test("a last-turn reply that only calls tools is no answer: the agent ran out of turns", async () => {
  const call: ScriptReply = { tool_calls: [{ tool: "list_sources", args: { why: "w" } }] };
  const end = await runAgent(f.s, spec(spy([call, call]), { max_turns: 2 }));
  expect(end).toEqual({ kind: "stopped", why: "turns" });
  expect(ofType("tool.called").length).toBe(1);
  expect(ofType("tool.skipped").length).toBe(1);
});

test("on the last turn a local model is sent tool_choice none and structured output, and model.request records it", async () => {
  const m = startModelStandin({ replies: [
    { json: { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "list_sources", arguments: '{"why":"w"}' } }] } }] } },
    { json: { choices: [{ finish_reason: "stop", message: { content: '{"n":3}' } }] } },
  ] });
  const p = new LocalProvider({ id: "lm", base_url: m.url, where: "machine", credential: null, secrets: new Secrets({}, null), context: null, efforts: [], timeout_ms: 5000 });
  try {
    const end = await runAgent(f.s, spec(p, { max_turns: 2, schema: SCHEMA, schema_id: "assemble-output" }));
    expect(end).toMatchObject({ kind: "done", output: { n: 3 } });
    const bodies = m.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.body) as Record<string, unknown>);
    expect(bodies[0]).not.toHaveProperty("tool_choice");
    expect(bodies[0]).not.toHaveProperty("response_format");
    expect(bodies[1]!.tool_choice).toBe("none");
    expect(bodies[1]!.response_format).toEqual({ type: "json_schema", json_schema: { name: "assemble-output", schema: SCHEMA, strict: true } });
    const recorded = ofType("model.request").map((e) => JSON.parse(text(e.payload.messages)) as Record<string, unknown>);
    expect(recorded).toEqual(bodies);
  } finally { m.stop(); }
});

// ---- the fast decision model: tool-choosing turns only, never the answer ----
function named(id: string, model: string, replies: ScriptReply[], where: Where = "machine"): Spy {
  const inner = new ScriptedProvider({ id, scripts: [{ id: model, turns: replies.map((reply) => ({ actor: agent.id, reply })) }] });
  const s: Spy = {
    id, kind: "scripted", where, turns: 0, seen: [], atTurn: [],
    models: () => inner.models(), body: (r) => inner.body(r),
    turn: async (r) => { s.turns++; s.seen.push(r); return inner.turn(r); },
  };
  return s;
}
const BIG = { ...agent, model: "big" };
const PIVOT = { tool: "list_sources", args: { why: "look" } };
const requests = () => ofType("model.request");

test("with a fast model, tool turns go to it and the answer comes from the stage's model", async () => {
  const fast = named("fast", "small", [{ tool_calls: [PIVOT] }, { tool_calls: [PIVOT] }, { content: "done" }]);
  const main = named("main", "big", [{ content: '{"n":1}' }]);
  const end = await runAgent(f.s, spec(main, { model: "big", actor: BIG, schema: SCHEMA, fast: { provider: fast, model: "small", effort: null } }));
  expect(end.kind).toBe("done");
  const reqs = requests();
  expect(reqs.map((e) => [e.payload.provider, e.payload.model, (e.actor as { model: string }).model])).toEqual([["fast", "small", "small"], ["fast", "small", "small"], ["fast", "small", "small"], ["main", "big", "big"]]);
  expect(JSON.parse(text(reqs[3]!.payload.messages)).tool_choice).toBe("none");
  expect((end as { content: string }).content).not.toContain("done");
  expect(fast.turns).toBe(3);
  expect(main.turns).toBe(1);
});

test("a routing turn's request and response carry the agent's actor with the fast model's model and where", async () => {
  const fast = named("fast", "small", [{ content: "go" }], "network");
  const main = named("main", "big", [{ content: "ok" }]);
  await runAgent(f.s, spec(main, { model: "big", actor: BIG, fast: { provider: fast, model: "small", effort: "low" } }));
  for (const e of [requests()[0]!, ofType("model.response")[0]!]) expect(e.actor).toEqual({ ...BIG, model: "small", where: "network", effort: "low" });
  expect(requests()[0]!.payload).toMatchObject({ provider: "fast", model: "small", where: "network", effort: "low" });
  expect(requests()[1]!.actor).toEqual(BIG);
  expect(requests()[1]!.payload).toMatchObject({ provider: "main", model: "big", where: "machine" });
});

test("without a fast model nothing changes", async () => {
  const main = named("main", "big", [{ tool_calls: [PIVOT] }, { content: "done" }]);
  const end = await runAgent(f.s, spec(main, { model: "big", actor: BIG }));
  expect(end).toMatchObject({ kind: "done", content: "done" });
  expect(requests().map((e) => [e.payload.provider, e.payload.model])).toEqual([["main", "big"], ["main", "big"]]);
  expect(requests().every((e) => (e.actor as { model: string }).model === "big")).toBe(true);
});

test("a pack the fast model may not receive blocks the stage and makes no call", async () => {
  const fast = named("fast", "small", [{ content: "x" }], "hosted");
  const main = named("main", "big", [{ content: "ok" }]);
  const end = await runAgent(f.s, spec(main, { model: "big", actor: BIG, pack: pack("TLP:AMBER"), fast: { provider: fast, model: "small", effort: null } }));
  expect(end).toEqual({ kind: "blocked", marking: "TLP:AMBER" });
  expect(ofType("model.blocked").length).toBe(1);
  expect(ofType("model.blocked")[0]!.payload.where).toBe("hosted");
  expect(requests().length).toBe(0);
  expect(fast.turns + main.turns).toBe(0);
});

test("a re-ask and the last turn go to the stage's model", async () => {
  const fast = named("fast", "small", [{ tool_calls: [PIVOT] }, { content: "" }]);
  const main = named("main", "big", [{ content: "" }, { content: '{"n":1}' }]);
  // the fast model's second reply holds no call: answer now; the stage's model answers empty once and is re-asked, still on the stage's model
  const end = await runAgent(f.s, spec(main, { model: "big", actor: BIG, schema: SCHEMA, fast: { provider: fast, model: "small", effort: null } }));
  expect(end).toMatchObject({ kind: "done", output: { n: 1 } });
  expect(requests().map((e) => e.payload.provider)).toEqual(["fast", "fast", "main", "main"]);
  // the last turn
  const fast2 = named("fast", "small", [{ tool_calls: [PIVOT] }]);
  const main2 = named("main", "big", [{ content: "final" }]);
  f.close(); f = fixture(true);
  const end2 = await runAgent(f.s, spec(main2, { model: "big", actor: BIG, max_turns: 2, fast: { provider: fast2, model: "small", effort: null } }));
  expect(end2).toMatchObject({ kind: "done", content: "final" });
  expect(requests().map((e) => e.payload.provider)).toEqual(["fast", "main"]);
});

test("an error or a decline on a routing turn ends the agent as on any turn, recorded as the fast model's", async () => {
  for (const [reply, kind] of [[{ error: "boom" }, "error"], [{ declined: "no" }, "declined"]] as const) {
    f.close(); f = fixture(true);
    const fast = named("fast", "small", [reply]);
    const main = named("main", "big", [{ content: "ok" }]);
    const end = await runAgent(f.s, spec(main, { model: "big", actor: BIG, fast: { provider: fast, model: "small", effort: null } }));
    expect(end.kind).toBe(kind);
    expect(requests().map((e) => e.payload.provider)).toEqual(["fast"]);
    expect(main.turns).toBe(0);
  }
});

test("the turn line names what the draft still lacks on the last two turns only", () => {
  expect(turnLine(3, 16, ["alternatives"])).toBe("Turn 3 of 16.");
  expect(turnLine(15, 16, ["alternatives", "findings"])).toBe("Turn 15 of 16. Two turns left: finish your proposals and give your final answer next turn. The draft still has no alternatives, findings.");
  expect(turnLine(16, 16, ["alternatives"])).toContain("The draft still has no alternatives.");
  expect(turnLine(16, 16, [])).not.toContain("still has no");
});

// ---- Task 13: a missing section is forced, not requested ----
type Body = Record<string, Json>;
const narrativeEnum = (b: Body): string[] => {
  const tools = b.tools as { function: { name: string; parameters: { properties: { section: { enum: string[] } } } } }[];
  return tools.find((t) => t.function.name === "propose_narrative")!.function.parameters.properties.section.enum;
};
const forcedCall = (b: Body) => ({ json: { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: `c-${narrativeEnum(b)[0]}`, type: "function", function: { name: "propose_narrative", arguments: JSON.stringify({ why: "it is missing", section: narrativeEnum(b)[0], text: "stated", cites: [] }) } }] } }] } });
const answer = (n: number) => ({ json: { choices: [{ finish_reason: "stop", message: { content: `{"n":${n}}` } }] } });
const NAMED = { type: "function", function: { name: "propose_narrative" } };

function drafting(): { work: DraftWork; over: Partial<AgentSpec> } {
  const work = new DraftWork(null);
  work.setSection("summary", "s", []);
  work.setSection("gaps_and_limits", "g", []);
  f.ctx.draft = work;
  const lacking = (): string[] => REQUIRED_SECTIONS.filter((k) => work.sections[k].trim() === "");
  return { work, over: { tools: [...ALL, "propose_narrative"], schema: SCHEMA, schema_id: "assemble-output", lacking, force: forcedProposal } };
}

test("an answer over missing sections forces propose_narrative, narrowed to what is missing, one at a time; then the answer turn is normal", async () => {
  const { work, over } = drafting();
  const m = startModelStandin({ replies: [answer(1), forcedCall, forcedCall, answer(2)] });
  const p = new LocalProvider({ id: "lm", base_url: m.url, where: "machine", credential: null, secrets: new Secrets({}, null), context: null, efforts: [], timeout_ms: 5000 });
  try {
    const end = await runAgent(f.s, spec(p, over));
    expect(end).toMatchObject({ kind: "done", output: { n: 2 } });
    const bodies = m.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.body) as Body);
    expect(bodies).toHaveLength(4);
    expect(bodies[1]!.tool_choice).toEqual(NAMED);
    expect(narrativeEnum(bodies[1]!)).toEqual(["alternatives", "assessment"]);
    expect(bodies[1]).not.toHaveProperty("response_format");
    expect(bodies[2]!.tool_choice).toEqual(NAMED);
    expect(narrativeEnum(bodies[2]!)).toEqual(["assessment"]);
    expect(bodies[3]!.tool_choice).toBe("none");
    expect(bodies[3]!.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "assemble-output" } });
    expect(narrativeEnum(bodies[3]!)).toEqual(["summary", "gaps_and_limits", "alternatives", "assessment"]);
    expect(work.sections).toMatchObject({ alternatives: "stated", assessment: "stated" });
    const recorded = ofType("model.request").map((e) => JSON.parse(text(e.payload.messages)) as Body);
    expect(recorded).toEqual(bodies);
  } finally { m.stop(); f.ctx.draft = null; }
});

test("an endpoint that refuses a named tool_choice (400) is sent required, and the request says so", async () => {
  const { over } = drafting();
  const m = startModelStandin({ replies: [answer(1), { status: 400, json: { error: { message: "tool_choice must be none, auto or required" } } }, forcedCall, forcedCall, answer(2)] });
  const p = new LocalProvider({ id: "lm", base_url: m.url, where: "machine", credential: null, secrets: new Secrets({}, null), context: null, efforts: [], timeout_ms: 5000 });
  try {
    const end = await runAgent(f.s, spec(p, over));
    expect(end).toMatchObject({ kind: "done", output: { n: 2 } });
    const bodies = m.requests.filter((r) => r.method === "POST").map((r) => JSON.parse(r.body) as Body);
    expect(bodies.map((b) => b.tool_choice ?? null)).toEqual([null, NAMED, "required", "required", "none"]);
    expect(narrativeEnum(bodies[2]!)).toEqual(["alternatives", "assessment"]);
    const reqs = ofType("model.request");
    expect(reqs[1]!.payload.note).toBeUndefined();
    expect(reqs[2]!.payload.note).toBe("the endpoint refused a tool_choice naming propose_narrative (400); \"required\" was sent instead");
    expect(reqs[2]!.cause).toBe(ofType("model.response")[1]!.seq);
  } finally { m.stop(); f.ctx.draft = null; }
});
