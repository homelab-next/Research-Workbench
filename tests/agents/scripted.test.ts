import { expect, test } from "bun:test";
import { ScriptedProvider, toScript } from "../../src/agents/providers/scripted";
import type { Script } from "../../src/agents/providers/scripted";
import type { ChatMessage, TurnRequest } from "../../src/agents/providers/types";

const base: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "go" }];
const req: TurnRequest = { model: "s", effort: null, messages: base, tools: [], key: "planner", ordinal: 0 };
const make = (turns: Script["turns"]): ScriptedProvider => new ScriptedProvider({ id: "scripted", scripts: [{ id: "s", turns }] });
const text = (b: Uint8Array | null): string => new TextDecoder().decode(b ?? new Uint8Array());

test("replays the turn at the caller's ordinal for the caller's key", async () => {
  const p = make([
    { actor: "planner", reply: { content: "one" } }, { actor: "analyst", reply: { content: "A" } }, { actor: "planner", reply: { content: "two" } },
  ]);
  const r = await p.turn({ ...req, key: "planner", ordinal: 1 });
  expect(r).toMatchObject({ kind: "answer", content: "two", stop: "end", served_by: "s" });
});

test("tool calls carry ids and their arguments as JSON text", async () => {
  const p = make([{ actor: "planner", reply: { tool_calls: [{ tool: "a", args: { x: 1 } }, { tool: "b", args: {} }] } }]);
  const r = await p.turn(req);
  expect(r.kind === "answer" && r.stop).toBe("tool_calls");
  expect(r.kind === "answer" && r.tool_calls).toEqual([
    { id: "call-0-0", name: "a", arguments: '{"x":1}' }, { id: "call-0-1", name: "b", arguments: "{}" },
  ]);
});

test("reasoning is returned beside the answer", async () => {
  const p = make([{ actor: "planner", reply: { content: "c", reasoning: "because" } }]);
  expect(await p.turn(req)).toMatchObject({ kind: "answer", content: "c", reasoning: "because" });
});

test("a declined reply and an error reply are returned as themselves", async () => {
  const p = make([{ actor: "planner", reply: { declined: "no" } }, { actor: "planner", reply: { error: "boom" } }]);
  expect(await p.turn(req)).toMatchObject({ kind: "declined", reason: "no", served_by: "s" });
  expect(await p.turn({ ...req, ordinal: 1 })).toMatchObject({ kind: "error", message: "boom" });
});

test("running past the script is an error naming the turn", async () => {
  const p = make([{ actor: "planner", reply: { content: "x" } }, { actor: "planner", reply: { content: "y" } }]);
  expect(await p.turn({ ...req, ordinal: 2 })).toMatchObject({ kind: "error", message: "script s has no turn 3 for planner" });
  expect(await p.turn({ ...req, model: "nope" })).toMatchObject({ kind: "error", message: "script nope has no turn 1 for planner" });
});

test("a card placeholder is resolved from the tool results in the conversation", async () => {
  const p = make([{ actor: "analyst", reply: { content: "see {{card:Asset: 192.0.2.17}}", tool_calls: [{ tool: "propose", args: { cites: ["{{card:Asset: 192.0.2.17}}"] } }] } }]);
  const messages: ChatMessage[] = [...base, { role: "tool", tool_call_id: "x", content: JSON.stringify({ cards: [{ id: "c7", title: "Asset: 192.0.2.17" }] }) }];
  const r = await p.turn({ ...req, messages, key: "analyst", ordinal: 0 });
  expect(r.kind === "answer" && JSON.parse(r.tool_calls[0]!.arguments).cites).toEqual(["c7"]);
  expect(r.kind === "answer" && r.content).toBe("see c7");
});

test("an unresolved card placeholder is an error, not a guess", async () => {
  const p = make([{ actor: "analyst", reply: { tool_calls: [{ tool: "propose", args: { cites: ["{{card:Nope}}"] } }] } }]);
  const r = await p.turn({ ...req, key: "analyst" });
  expect(r).toMatchObject({ kind: "error", message: 'script s refers to a card titled "Nope" that this conversation has not shown' });
});

test("the body is canonical and the same for the same request", () => {
  const p = make([]);
  const a = p.body({ ...req, messages: [{ role: "user", content: "hi" }] });
  const b = p.body({ ordinal: 0, key: "planner", tools: [], effort: null, model: "s", messages: [{ content: "hi", role: "user" }] });
  expect(text(a)).toBe(text(b));
  expect(text(a)).toBe('{"effort":null,"key":"planner","messages":[{"content":"hi","role":"user"}],"model":"s","ordinal":0,"tools":[]}');
});

test("usage is deterministic", async () => {
  const p = make([{ actor: "planner", reply: { content: "12345678", reasoning: "123" } }, { actor: "planner", reply: { content: "x", usage: { output: 99 } } }]);
  const a = await p.turn(req);
  const b = await p.turn(req);
  expect(a).toEqual(b);
  expect(a.kind === "answer" && a.usage).toEqual({ input: Math.ceil(text(p.body(req)).length / 4), output: 2, reasoning: 1 });
  const c = await p.turn({ ...req, ordinal: 1 });
  expect(c.kind === "answer" && c.usage.output).toBe(99);
});

const cardsMsg = (payload: unknown): ChatMessage => ({ role: "tool", tool_call_id: "x", content: JSON.stringify(payload) });
const citing = (title: string) => make([{ actor: "analyst", reply: { tool_calls: [{ tool: "p", args: { c: `{{card:${title}}}` } }] } }]);
const ask = (p: ScriptedProvider, ...tool: ChatMessage[]) => p.turn({ ...req, key: "analyst", messages: [...base, ...tool] });
const cited = (r: Awaited<ReturnType<typeof ask>>): unknown => (r.kind === "answer" ? JSON.parse(r.tool_calls[0]!.arguments).c : r);

test("a title shown for two different cards is ambiguous, not resolved to the first", async () => {
  const r = await ask(citing("Asset: x"), cardsMsg({ kept: [{ id: "c1", title: "Asset: x" }], discarded: [{ id: "c2", title: "Asset: x" }] }));
  expect(r).toMatchObject({ kind: "error", message: "ambiguous card title: Asset: x" });
});

test("the same card shown twice under one title resolves", async () => {
  const r = await ask(citing("Asset: x"), cardsMsg({ cards: [{ id: "c1", title: "Asset: x" }] }), cardsMsg({ card: { id: "c1", title: "Asset: x" } }));
  expect(cited(r)).toBe("c1");
});

test("a title matches exactly, not as a prefix of another", async () => {
  const m = cardsMsg({ cards: [{ id: "c17", title: "Asset: 192.0.2.17" }] });
  expect(await ask(citing("Asset: 192.0.2.1"), m)).toMatchObject({ kind: "error" });
  expect(cited(await ask(citing("Asset: 192.0.2.17"), m))).toBe("c17");
});

test("a card shown only as discarded resolves to its own id", async () => {
  expect(cited(await ask(citing("Gone"), cardsMsg({ discarded: [{ id: "c9", title: "Gone" }] })))).toBe("c9");
});

test("an object that is not a card does not resolve", async () => {
  const r = await ask(citing("Plan"), cardsMsg({ proposal: { id: "p1", title: "Plan" }, plans: [{ id: "p2", title: "Plan" }] }));
  expect(r).toMatchObject({ kind: "error", message: 'script s refers to a card titled "Plan" that this conversation has not shown' });
});

test("a script whose args are not plain JSON is refused at load, and turn never throws", async () => {
  const manifest = { kind: "script", id: "s", title: "s", hash: "h", root: "r", path: "p", dir: "d", text: null,
    body: { turns: [{ actor: "planner", reply: { tool_calls: [{ tool: "t", args: { x: NaN } }] } }] } };
  expect(() => toScript(manifest)).toThrow(/turns\[0\]: tool_calls\[0\] args are not plain JSON/);
  const p = make([{ actor: "planner", reply: { tool_calls: [{ tool: "t", args: { x: Infinity } }] } }]);
  const r = await p.turn(req);
  expect(r.kind).toBe("error");
});

test("a placeholder left unresolved (a title with a newline) is an error", async () => {
  const r = await ask(citing("two\nlines"), cardsMsg({ cards: [{ id: "c1", title: "two\nlines" }] }));
  expect(r).toMatchObject({ kind: "error", message: "script s has a card placeholder that could not be resolved" });
});

test("every model a script provider lists counts as loaded", async () => {
  expect(await make([{ actor: "planner", reply: { content: "x" } }]).models()).toEqual([{ id: "s", context: null, efforts: [], loaded: true, parallel: null }]);
});
