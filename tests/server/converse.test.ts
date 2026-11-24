import { afterEach, expect, test } from "bun:test";
import { latestDraft, runUsage } from "../../src/core/state";
import type { Actor, Entry } from "../../src/core/types";
import type { AgentView } from "../../src/core/wire";
import { recoverSession } from "../../src/pipeline/recover";
import { agentParts } from "../../src/server/converse";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served;
const cases: string[] = [];
afterEach(async () => {
  try {
    for (const id of cases) expect(s.app.hub.read(id).state.skipped).toEqual([]);
  } finally {
    cases.length = 0;
    await s?.close();
  }
});

const state = (id: string) => s.app.hub.read(id).state;
const ask = (id: string, text = "What do we know?", left_out: string[] = [], added: string[] = []) => s.command(id, "ask", { text, left_out, added });
/** A case at the publish gate. */
async function atGate(): Promise<string> {
  s = s ?? (await served());
  const id = await s.newCase();
  cases.push(id);
  await s.toPublishGate(id);
  return id;
}
const types = (id: string): string[] => s.entries(id).map((e) => e.type);
const agentActor: Actor = { kind: "agent", id: "assistant", stage: "agent", profile: "investigation", model: "sample-run", effort: null, where: "machine" };

test("a question is recorded, answered by a model with no tools, and the answer cites cards of the case", async () => {
  s = await served();
  const id = await atGate();
  expect((await ask(id)).status).toBe(200);
  await s.app.hub.idle();
  const st = state(id);
  expect(st.conversation.at(-1)).toMatchObject({ asked: "What do we know?", answer: expect.stringContaining("[c1]"), cites: ["c1"] });
  const req = s.entries(id).findLast((e) => e.type === "model.request")!;
  if (req.type !== "model.request") throw new Error("not a request");
  expect(req.payload.tools).toEqual([]);
  expect(req.actor).toMatchObject({ kind: "agent", id: "assistant", stage: "agent" });
  expect(st.conversation.at(-1)!.request).toBe(req.payload.request);
  expect(s.entries(id).filter((e) => e.seq > req.seq && e.type === "tool.called")).toEqual([]);
  const asked = s.entries(id).findLast((e) => e.type === "agent.asked")!;
  expect(asked.actor).toEqual({ kind: "human", id: s.config.user });
  expect(req.cause).toBe(asked.seq);
  const answered = s.entries(id).findLast((e) => e.type === "agent.answered")!;
  expect(answered.actor).toMatchObject({ kind: "agent", id: "assistant" });
});

test("ask returns before the model has answered, and a slow model does not hold stop", async () => {
  s = await served();
  const id = await atGate();
  const provider = s.app.hub.deps.providers.get("scripted")!;
  const real = provider.turn.bind(provider);
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  provider.turn = async (r) => { await gate; return real(r); };
  try {
    expect((await ask(id)).status).toBe(200);
    expect(state(id).conversation.at(-1)).toMatchObject({ asked: "What do we know?", answer: null });
    const stopped = await s.command(id, "stop", { reason: "enough" });
    expect(stopped.status).toBe(200);
    expect(state(id).run.status).toBe("finished");
    expect(state(id).conversation.at(-1)!.answer).toBeNull();
  } finally {
    open();
    provider.turn = real;
  }
  await s.app.hub.idle();
  expect(state(id).conversation.at(-1)!.answer).toContain("[c1]");
});

test("the answer is the same whether the run is waiting, paused or finished", async () => {
  s = await served();
  const waiting = await atGate();
  expect(state(waiting).run.status).toBe("waiting");
  const paused = await atGate();
  expect((await s.command(paused, "pause")).status).toBe(200);
  expect(state(paused).run.status).toBe("paused");
  const done = await atGate();
  expect((await s.command(done, "stop", { reason: "x" })).status).toBe(200);
  expect(state(done).run.status).toBe("finished");
  for (const id of [waiting, paused, done]) {
    expect((await ask(id)).status).toBe(200);
    await s.app.hub.idle();
  }
  const answers = [waiting, paused, done].map((id) => state(id).conversation.at(-1)!.answer);
  expect(answers[0]).toContain("[c1]");
  expect(new Set(answers).size).toBe(1);
  expect(state(paused).run.status).toBe("paused");
  expect(state(done).run.status).toBe("finished");
});

test("left-out items are not in the pack, and are recorded on the question and the request", async () => {
  s = await served();
  const id = await atGate();
  expect((await s.command(id, "keep", { card: "c1" })).status).toBe(200);
  expect((await ask(id)).status).toBe(200);
  await s.app.hub.idle();
  const first = s.entries(id).findLast((e) => e.type === "model.request")!;
  if (first.type !== "model.request") throw new Error();
  expect(first.payload.pack.map((i) => `${i.kind}:${i.id}`)).toEqual(expect.arrayContaining(["card:c1", "persona:assistant", "case:CASE-1"]));
  expect((await ask(id, "And now?", ["card:c1", "persona:assistant"])).status).toBe(200);
  await s.app.hub.idle();
  const second = s.entries(id).findLast((e) => e.type === "model.request")!;
  if (second.type !== "model.request") throw new Error();
  const kinds = second.payload.pack.map((i) => `${i.kind}:${i.id}`);
  expect(kinds).not.toContain("card:c1");
  expect(kinds).not.toContain("persona:assistant");
  const asked = s.entries(id).findLast((e) => e.type === "agent.asked")!;
  if (asked.type !== "agent.asked") throw new Error();
  expect(asked.payload.left_out).toEqual(["card:c1", "persona:assistant"]);
  expect(second.payload.left_out).toEqual([]);                // what the person left out is not built, so it is not "left out" by the pack either
});

test("an item added for a turn is in the pack; one of another kind is refused", async () => {
  s = await served();
  const id = await atGate();
  const view = (await (await s.get(`/api/cases/${id}/agent`)).json()) as AgentView;
  const pick = view.addable[0];
  expect(pick).toBeDefined();
  expect((await ask(id, "Use it.", [], [pick!.key])).status).toBe(200);
  await s.app.hub.idle();
  const req = s.entries(id).findLast((e) => e.type === "model.request")!;
  if (req.type !== "model.request") throw new Error();
  expect(req.payload.pack.map((i) => `${i.kind}:${i.id}`)).toContain(pick!.key);
  const before = s.entries(id).length;
  const r = await ask(id, "Again.", [], ["persona:orchestrator"]);
  expect(r).toEqual({ status: 409, body: { ok: false, refused: ["unknown context item persona:orchestrator"] } });
  expect(s.entries(id).length).toBe(before);
});

test("the base rules and the case cannot be left out", async () => {
  s = await served();
  const id = await atGate();
  const before = s.entries(id).length;
  expect(await ask(id, "q", ["rules:base-rules"])).toEqual({ status: 409, body: { ok: false, refused: ["the base rules and the case cannot be left out"] } });
  expect(await ask(id, "q", [`case:${id}`])).toEqual({ status: 409, body: { ok: false, refused: ["the base rules and the case cannot be left out"] } });
  expect(await ask(id, "q", ["card:zz"])).toEqual({ status: 409, body: { ok: false, refused: ["unknown context item card:zz"] } });
  expect(s.entries(id).length).toBe(before);
});

test("a question must be 1 to 4,000 characters and nothing is written when it is not", async () => {
  s = await served();
  const id = await atGate();
  const before = s.entries(id).length;
  expect((await ask(id, "   ")).status).toBe(409);
  expect((await ask(id, "x".repeat(4001))).status).toBe(409);
  expect(s.entries(id).length).toBe(before);
  expect((await ask(id, `  ${"x".repeat(4000)}  `)).status).toBe(200);
  await s.app.hub.idle();
});

test("without a listed model ask is refused before anything is written", async () => {
  s = await served();
  const id = await atGate();
  s.app.hub.read(id).commit(() => [{ type: "stage.model_set", actor: { kind: "human", id: "a" }, payload: { stage: "agent", choice: { provider: "scripted", model: "ghost", effort: null } } }]);
  const before = s.entries(id).length;
  expect(await ask(id)).toEqual({ status: 409, body: { ok: false, refused: ["Your agent has no model. Choose one in the Agent lens."] } });
  expect(s.entries(id).length).toBe(before);
});

test("a model the case's marking may not go to is not called: model.blocked is written and the turn has no answer", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  s.config.marking_policy["TLP:GREEN"] = [];
  expect((await ask(id)).status).toBe(200);
  await s.app.hub.idle();
  expect(types(id)).toContain("model.blocked");
  expect(types(id)).not.toContain("model.request");
  expect(types(id)).not.toContain("agent.answered");
  expect(state(id).conversation.at(-1)).toMatchObject({ asked: "What do we know?", answer: null });
});

test("a turn the loop ended as blocked records its own end, and recovery then writes nothing", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  s.config.marking_policy["TLP:GREEN"] = [];
  expect((await ask(id)).status).toBe(200);
  await s.app.hub.idle();
  const asked = s.entries(id).find((e) => e.type === "agent.asked")!;
  const ended = s.entries(id).filter((e) => e.type === "agent.ended");
  expect(ended.map((e) => ({ payload: e.payload, cause: e.cause, actor: e.actor.kind }))).toEqual([{ payload: { asked: asked.seq, reason: "blocked" }, cause: asked.seq, actor: "system" }]);
  expect(state(id).conversation.at(-1)).toMatchObject({ answer: null, ended: "blocked" });
  // what Engine.open does for this case the next time the server starts
  const session = s.app.hub.read(id);
  const head = session.state.seq;
  expect(recoverSession(session).asks).toEqual([]);
  expect(session.state.seq).toBe(head);
});

test("an earlier answer made under a stricter marking makes the next pack as strict", async () => {
  s = await served();
  const id = await atGate();
  const session = s.app.hub.read(id);
  let turn = "";
  session.commit((_st, ids) => {
    turn = ids.next("turn");
    return [{ type: "agent.asked", actor: { kind: "human", id: "a" }, payload: { turn, text: "Earlier?", left_out: [], added: [] } }];
  });
  let request = "";
  session.commit((_st, ids) => {
    request = ids.next("request");
    return [{ type: "model.request", actor: agentActor, payload: { request, provider: "scripted", model: "sample-run", effort: null, where: "machine", marking: "TLP:AMBER", pack: [], left_out: [], messages: session.blobs.put("{}"), tools: [] } }];
  });
  session.commit(() => [{ type: "agent.answered", actor: agentActor, payload: { turn, request, text: "Earlier answer [c1].", cites: ["c1"] } }]);
  const parts = agentParts(session, s.app.hub.deps, []);
  const earlier = parts.find((p) => p.kind === "turn")!;
  expect(earlier.id).toBe(turn);
  expect(earlier.title).toBe("Earlier: Earlier?");
  expect(earlier.text).toBe("Asked: Earlier?\nAnswered: Earlier answer [c1].");
  expect(earlier.marking).toBe("TLP:AMBER");
  expect((await ask(id, "Now?")).status).toBe(200);
  await s.app.hub.idle();
  const req = s.entries(id).findLast((e) => e.type === "model.request")!;
  if (req.type !== "model.request") throw new Error();
  expect(req.payload.marking).toBe("TLP:AMBER");
  expect(req.payload.pack.map((i) => i.kind)).toContain("turn");
});

test("propose_answer makes a narrative proposal and changes no draft", async () => {
  s = await served();
  const id = await atGate();
  await ask(id);
  await s.app.hub.idle();
  const turn = state(id).conversation.at(-1)!.turn;
  const before = latestDraft(state(id))!;
  const drafts = state(id).drafts.length;
  expect((await s.command(id, "propose_answer", { turn, section: "summary" })).status).toBe(200);
  const p = Object.values(state(id).proposals).at(-1)!;
  expect(p).toMatchObject({ kind: "narrative", title: "Your agent's answer as Summary", by: "assistant", section: "summary", text: state(id).conversation.at(-1)!.answer, cites: ["c1"], status: "open" });
  expect(state(id).drafts.length).toBe(drafts);
  expect(latestDraft(state(id))!.hash).toBe(before.hash);
  const made = s.entries(id).findLast((e) => e.type === "proposal.created")!;
  const answeredAt = s.entries(id).findLast((e) => e.type === "agent.answered")!;
  expect(made.actor).toEqual({ kind: "human", id: s.config.user });
  expect(made.cause).toBe(answeredAt.seq);
  expect((await s.command(id, "propose_answer", { turn, section: "key_findings" })).status).toBe(400);
  expect(await s.command(id, "propose_answer", { turn: "t99", section: "summary" })).toEqual({ status: 409, body: { ok: false, refused: ["there is no answered turn t99"] } });
});

test("keep_answer makes a note card in Incoming carrying the request's marking", async () => {
  s = await served();
  const id = await atGate();
  await ask(id, "What do we know about the asset?");
  await s.app.hub.idle();
  const turn = state(id).conversation.at(-1)!.turn;
  const incoming = state(id).incoming.length;
  expect((await s.command(id, "keep_answer", { turn })).status).toBe(200);
  expect(state(id).incoming.length).toBe(incoming + 1);
  const card = state(id).cards[state(id).incoming.at(-1)!]!;
  const req = s.entries(id).findLast((e) => e.type === "model.request")!;
  if (req.type !== "model.request") throw new Error();
  expect(card).toMatchObject({
    kind: "note", made_by: "agent", title: "Note: What do we know about the asset?", body: state(id).conversation.at(-1)!.answer, why: "What do we know about the asset?",
    query: null, rows: [], row_count: 0, marking: req.payload.marking, place: "incoming",
  });
  const made = s.entries(id).findLast((e) => e.type === "card.created")!;
  expect(made.actor).toEqual({ kind: "human", id: s.config.user });
  expect(made.cause).toBe(s.entries(id).findLast((e) => e.type === "agent.answered")!.seq);
});

test("the agent view lists the parts with the fixed ones marked, and writes nothing", async () => {
  s = await served();
  const id = await atGate();
  const before = s.entries(id).length;
  const res = await s.get(`/api/cases/${id}/agent`);
  expect(res.status).toBe(200);
  const view = (await res.json()) as AgentView;
  expect(s.entries(id).length).toBe(before);
  expect(view).toMatchObject({ agent: "assistant", profile: "Investigation", model: { provider: "scripted", model: "sample-run" } });
  const by = new Map(view.parts.map((p) => [p.key, p]));
  expect(by.get("rules:base-rules")).toMatchObject({ fixed: true, kind: "rules" });
  expect(by.get(`case:${id}`)).toMatchObject({ fixed: true, kind: "case" });
  expect(by.get("persona:assistant")).toMatchObject({ fixed: false });
  expect(by.get("persona:assistant")!.excerpt).toContain("You are the assistant");
  expect(view.parts.every((p) => p.excerpt.length <= 600 && p.chars > 0)).toBe(true);
  expect(view.addable.every((a) => !by.has(a.key))).toBe(true);
  expect(view.budget_chars).toBeGreaterThan(0);
  const requester = await served({ role: "requester" });
  try {
    const rid = "CASE-1";
    expect((await requester.get(`/api/cases/${rid}/agent`)).status).toBe(403);
  } finally {
    await requester.close();
  }
});

test("ask keeps, moves and discards nothing", async () => {
  s = await served();
  const id = await atGate();
  const head = s.entries(id).length;
  await ask(id);
  await s.app.hub.idle();
  const after: Entry[] = s.entries(id).slice(head);
  for (const t of ["card.kept", "card.moved", "card.discarded", "plan.accepted", "product.published", "draft.revised", "proposal.created"]) {
    expect(after.map((e) => e.type)).not.toContain(t as Entry["type"]);
  }
  expect(state(id).run.waiting).toBe("publish");
});

test("the conversation's model use is counted apart and does not spend the run's budget", async () => {
  s = await served();
  const id = await atGate();
  const run = runUsage(state(id));
  expect((await s.command(id, "set_budget", { tokens: 1 })).status).toBe(200);
  expect((await ask(id)).status).toBe(200);
  await s.app.hub.idle();
  expect(state(id).conversation.at(-1)!.answer).not.toBeNull();
  expect(runUsage(state(id))).toEqual(run);
  expect(state(id).agent_usage.calls).toBe(1);
  expect(state(id).agent_usage.usage.output).toBeGreaterThan(0);
});

test("a turn whose pack cannot be made ends with agent.ended, and the next turn is its own", async () => {
  s = await served();
  const id = await atGate();
  expect((await s.command(id, "keep", { card: "c1" })).status).toBe(200);
  const provider = s.app.hub.deps.providers.get("scripted")!;
  const real = provider.turn.bind(provider);
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  provider.turn = async (r) => { await gate; return real(r); };
  try {
    expect((await ask(id, "First?")).status).toBe(200);
    expect((await ask(id, "Second?", ["card:c1"])).status).toBe(200);
    expect((await s.command(id, "discard", { card: "c1" })).status).toBe(200);
  } finally {
    open();
    provider.turn = real;
  }
  await s.app.hub.idle();
  const [one, two] = state(id).conversation.slice(-2);
  expect(one!.answer).toContain("[c1]");
  expect(two).toMatchObject({ asked: "Second?", answer: null, ended: "unknown context item card:c1" });
  const ended = s.entries(id).findLast((e) => e.type === "agent.ended")!;
  expect(ended.payload).toEqual({ asked: two!.asked_seq, reason: "unknown context item card:c1" });
  expect(s.entries(id).filter((e) => e.type === "model.request" && e.actor.id === "assistant").map((e) => e.cause)).toEqual([one!.asked_seq]);
});

test("a question left open by a stopped process is ended as interrupted at the first command after", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  s.app.hub.read(id).commit((_st, ids) => [{ type: "agent.asked", actor: { kind: "human", id: s.config.user }, payload: { turn: ids.next("turn"), text: "Left open", left_out: [], added: [] } }]);
  expect(state(id).conversation[0]!.ended).toBeNull();
  expect((await s.command(id, "add_lane", { title: "x" })).status).toBe(200);
  expect(state(id).conversation[0]!.ended).toBe("interrupted");
});

test("the view skips an earlier turn whose request cannot be found", async () => {
  s = await served();
  const id = await atGate();
  const session = s.app.hub.read(id);
  let turn = "";
  session.commit((_st, ids) => { turn = ids.next("turn"); return [{ type: "agent.asked", actor: { kind: "human", id: "a" }, payload: { turn, text: "Odd", left_out: [], added: [] } }]; });
  session.commit(() => [{ type: "agent.answered", actor: agentActor, payload: { turn, request: "r404", text: "Hm", cites: [] } }]);
  const res = await s.get(`/api/cases/${id}/agent`);
  expect(res.status).toBe(200);
  expect(((await res.json()) as AgentView).parts.some((p) => p.kind === "turn")).toBe(false);
  expect((await ask(id)).status).toBe(200);
  await s.app.hub.idle();
  expect(state(id).conversation.at(-1)!.answer).not.toBeNull();
  expect((await s.command(id, "keep_answer", { turn })).status).toBe(409);
});
