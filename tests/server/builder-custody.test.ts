import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import type { CaseState } from "../../src/core/state";
import { fold } from "../../src/core/state";
import type { Entry, EntryType, Marking, Where } from "../../src/core/types";
import { MARKINGS } from "../../src/core/types";
import { verifyCase } from "../../src/core/verify";
import type { BuilderView } from "../../src/core/wire";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

const SCRIPT = "builder-test";
const CHOICE = { provider: "scripted", model: SCRIPT, effort: null };
const ADDRESS = "198.51.100.77";
type Reply = { content?: string; tool_calls?: { tool: string; args: Record<string, Json> }[] };
const probe = (args: Record<string, Json>): Reply => ({ tool_calls: [{ tool: "request_probe", args: { why: "to see what it holds", ...args } }] });
const WAITING: Reply = { content: "I have asked for a probe; it waits for your approval." };

let s: Served;
const sessions: string[] = [];
afterEach(async () => {
  try {
    for (const id of sessions) expect(s.wb.builder(id).state.skipped).toEqual([]);
  } finally {
    sessions.length = 0;
    await s?.close();
  }
});

async function start(turns: Reply[], opts: { before?: (root: string) => void; policy?: Record<Marking, Where[]> } = {}): Promise<void> {
  s = await served({
    ...(opts.policy === undefined ? {} : { config: { marking_policy: opts.policy } }),
    before: (root) => {
      writeFileSync(join(root, "scripts", `${SCRIPT}.yaml`), JSON.stringify({ kind: "script", id: SCRIPT, title: "Builder test", turns: turns.map((reply) => ({ actor: "builder", reply })) }));
      opts.before?.(root);
    },
  });
}
async function newBuilder(): Promise<string> {
  const res = await s.post("/api/builders", { loop: "investigation", marking: "TLP:GREEN" });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  sessions.push(id);
  expect((await s.post(`/api/builders/${id}/model`, { choice: CHOICE })).status).toBe(200);
  return id;
}
const entries = (id: string): Entry[] => s.wb.builder(id).entries();
const ofType = <T extends EntryType>(id: string, t: T): Extract<Entry, { type: T }>[] => entries(id).filter((e): e is Extract<Entry, { type: T }> => e.type === t);
const queryTypes = (id: string): string[] => entries(id).filter((e) => e.type.startsWith("query.")).map((e) => e.type);
const ask = async (id: string, text = "What does the source hold?"): Promise<void> => {
  expect((await s.post(`/api/builders/${id}/ask`, { text })).status).toBe(200);
  await s.app.hub.idle();
};
const decideProbe = (id: string, p: string, approve: boolean, budget?: number | null): Promise<Response> =>
  s.post(`/api/builders/${id}/probe`, budget === undefined ? { probe: p, approve } : { probe: p, approve, budget });
const view = async (id: string): Promise<BuilderView> => (await (await s.get(`/api/builders/${id}/view`)).json()) as BuilderView;
const person = (): { kind: "human"; id: string } => ({ kind: "human", id: s.config.user });

test("an approved pivot probe runs through runQuery in the builder session: query.issued, query.result and card.created are in the builder's ledger, by the person, and in no case's", async () => {
  await start([probe({ kind: "pivot", source: "assets", pivot: "address_to_asset", value: ADDRESS }), WAITING]);
  const kase = await s.newCase();
  const id = await newBuilder();
  await ask(id);
  expect(ofType(id, "builder.probe_asked").map((e) => e.payload.probe)).toEqual(["probe-1"]);
  const res = await decideProbe(id, "probe-1", true);
  expect(res.status).toBe(200);
  const issued = ofType(id, "query.issued");
  expect(issued.length).toBe(1);
  expect(issued[0]!.actor).toEqual(person());
  expect(issued[0]!.payload).toMatchObject({ source: "assets", pivot: "address_to_asset" });
  const result = ofType(id, "query.result");
  expect(result.length).toBe(1);
  // the runner records the result of the query the person issued
  expect(result[0]!.actor).toEqual({ kind: "system", id: "runner" });
  expect(result[0]!.cause).toBe(issued[0]!.seq);
  const cards = ofType(id, "card.created");
  expect(cards.length).toBe(1);
  const decided = ofType(id, "builder.probe_decided");
  expect(decided.map((e) => [e.actor, e.payload.approved, e.payload.outcome, e.payload.query])).toEqual([[person(), true, "ran", issued[0]!.payload.query]]);
  expect((await view(id)).probes[0]!.decided).toMatchObject({ approved: true, outcome: "ran", card: cards[0]!.payload.card.id });
  // no case holds a query entry
  expect(s.entries(kase).filter((e) => e.type.startsWith("query.") || e.type === "card.created")).toEqual([]);
  expect(s.wb.listCases().map((c) => c.id)).toEqual([kase]);
  // the next turn's pack holds the card
  await ask(id, "And now?");
  const req = ofType(id, "model.request").at(-1)!;
  expect(req.payload.pack.some((p) => p.kind === "card" && p.id === cards[0]!.payload.card.id)).toBe(true);
});

test("an approved query probe that lists a sqlite source's tables records its rows as a card of the session", async () => {
  await start([probe({ kind: "query", source: "flows", text: "SELECT name FROM sqlite_master WHERE type = 'table'" }), WAITING]);
  const id = await newBuilder();
  await ask(id);
  expect((await decideProbe(id, "probe-1", true)).status).toBe(200);
  const decided = ofType(id, "builder.probe_decided")[0]!;
  expect(decided.payload).toMatchObject({ approved: true, outcome: "ran" });
  const card = s.wb.builder(id).state.cards[ofType(id, "card.created")[0]!.payload.card.id]!;
  expect(card.query).toBe(decided.payload.query);
  expect(card.rows.flat()).toContain("flows");
});

test("a probe the guard refuses is recorded as refused with the guard's reasons, and no query entry is written", async () => {
  await start([probe({ kind: "query", source: "flows", text: "DELETE FROM flows" }), WAITING]);
  const id = await newBuilder();
  await ask(id);
  const seq = s.wb.builder(id).head().seq;
  expect((await decideProbe(id, "probe-1", true)).status).toBe(200);
  expect(entries(id).filter((e) => e.seq > seq).map((e) => e.type)).toEqual(["builder.probe_decided"]);
  const decided = ofType(id, "builder.probe_decided")[0]!;
  expect(decided.payload).toMatchObject({ approved: true, outcome: "refused", query: null });
  expect(decided.payload.detail.length).toBeGreaterThan(0);
  expect(queryTypes(id)).toEqual([]);
  expect((await view(id)).probes[0]!.decided).toMatchObject({ approved: true, outcome: "refused", card: null });
});

test("a costly probe approved with no budget is refused with its estimate; approved with a budget that covers it, it runs", async () => {
  const verdict = probe({ kind: "pivot", source: "reputation", pivot: "address_to_verdict", value: ADDRESS });
  await start([verdict, WAITING, verdict, WAITING]);
  const id = await newBuilder();
  await ask(id);
  expect((await view(id)).probes[0]!.costly).toBe(true);
  expect((await decideProbe(id, "probe-1", true)).status).toBe(200);
  const first = ofType(id, "builder.probe_decided")[0]!;
  expect(first.payload).toMatchObject({ approved: true, outcome: "refused", query: null });
  expect(first.payload.detail).toContain("it would cost 1 lookups");
  expect(ofType(id, "query.result")).toEqual([]);
  await ask(id, "Ask again; I will give it a budget.");
  expect((await decideProbe(id, "probe-2", true, 1)).status).toBe(200);
  const second = ofType(id, "builder.probe_decided")[1]!;
  expect(second.payload).toMatchObject({ probe: "probe-2", approved: true, outcome: "ran" });
  expect(ofType(id, "query.result").length).toBe(1);
});

test("a rejected probe writes builder.probe_decided and nothing else", async () => {
  await start([probe({ kind: "pivot", source: "assets", pivot: "address_to_asset", value: ADDRESS }), WAITING]);
  const id = await newBuilder();
  await ask(id);
  const seq = s.wb.builder(id).head().seq;
  const chain = s.wb.chain.read().length;
  expect((await decideProbe(id, "probe-1", false)).status).toBe(200);
  expect(entries(id).filter((e) => e.seq > seq).map((e) => [e.type, e.actor, e.payload])).toEqual([
    ["builder.probe_decided", person(), { probe: "probe-1", approved: false, query: null, outcome: "rejected", detail: "" }],
  ]);
  expect(s.wb.chain.read().length).toBe(chain);
  // decided once: an approve after the rejection is refused
  expect((await decideProbe(id, "probe-1", true)).status).toBe(409);
  expect(queryTypes(id)).toEqual([]);
});

test("before the person approves, no query entry exists; the agent's request alone never sends a query", async () => {
  await start([probe({ kind: "pivot", source: "assets", pivot: "address_to_asset", value: ADDRESS }), WAITING]);
  const id = await newBuilder();
  await ask(id);
  expect(ofType(id, "builder.probe_asked").length).toBe(1);
  expect(ofType(id, "builder.probe_asked")[0]!.actor.kind).toBe("agent");
  expect(queryTypes(id)).toEqual([]);
  expect(ofType(id, "card.created")).toEqual([]);
  expect((await view(id)).probes).toMatchObject([{ id: "probe-1", kind: "pivot", source: "assets", pivot: "address_to_asset", value: { type: "address", value: ADDRESS }, costly: false, decided: null }]);
  // an unknown probe, or a body without the decision, is refused and writes nothing
  const seq = s.wb.builder(id).head().seq;
  expect((await decideProbe(id, "probe-9", true)).status).toBe(409);
  expect((await s.post(`/api/builders/${id}/probe`, { probe: "probe-1" })).status).toBe(400);
  expect((await decideProbe(id, "probe-1", true, -1)).status).toBe(400);
  expect(s.wb.builder(id).head().seq).toBe(seq);
});

test("the session's marking is the strictest of what it probed: after a probe of a TLP:AMBER source the view says TLP:AMBER, and the next turn is blocked for a model that may not receive it", async () => {
  // this machine's model may take TLP:GREEN, not TLP:AMBER
  const policy = Object.fromEntries(MARKINGS.map((m, i) => [m, i < 2 ? ["machine", "network", "hosted"] : ["hosted"]])) as Record<Marking, Where[]>;
  await start([probe({ kind: "query", source: "flows-amber", text: "SELECT name FROM sqlite_master WHERE type = 'table'" }), WAITING, { content: "never sent" }], {
    policy,
    before: (root) => {
      const flows = readFileSync(join(root, "sources", "flows.yaml"), "utf8");
      writeFileSync(join(root, "sources", "flows-amber.yaml"), flows.replace("id: flows", "id: flows-amber").replace('marking: "TLP:GREEN"', 'marking: "TLP:AMBER"'));
    },
  });
  const id = await newBuilder();
  await ask(id);
  expect((await view(id)).marking).toBe("TLP:GREEN");
  expect((await decideProbe(id, "probe-1", true)).status).toBe(200);
  expect(ofType(id, "builder.probe_decided")[0]!.payload.outcome).toBe("ran");
  expect((await view(id)).marking).toBe("TLP:AMBER");
  const requests = ofType(id, "model.request").length;
  await ask(id, "What did it hold?");
  const blocked = ofType(id, "model.blocked");
  expect(blocked.length).toBe(1);
  expect(blocked[0]!.payload).toMatchObject({ marking: "TLP:AMBER", where: "machine" });
  expect(ofType(id, "model.request").length).toBe(requests);
  expect(s.wb.builder(id).state.conversation.at(-1)).toMatchObject({ asked: "What did it hold?", answer: null });
});

test("the builder's ledger verifies, and replays exactly at every entry", async () => {
  const SKILL = "---\nkind: skill\nid: extra-notes\ntitle: Extra notes\n---\nRead the field notes before you pivot.\n";
  await start([
    { tool_calls: [{ tool: "propose_change", args: { why: "w", title: "A skill", files: [{ path: "context/skills/extra-notes.md", text: SKILL }] } }] },
    probe({ kind: "pivot", source: "assets", pivot: "address_to_asset", value: ADDRESS }),
    WAITING,
    { content: "Thank you." },
  ]);
  const id = await newBuilder();
  const session = s.wb.builder(id);
  const live: CaseState[] = [];
  for (let n = 1; n <= session.head().seq; n++) live[n] = fold(session.entries(), n);
  session.subscribe((_e, st) => { live[st.seq] = structuredClone(st); });
  await ask(id);
  expect((await s.post(`/api/builders/${id}/decide`, { change: "chg-1", file: 0, accept: true })).status).toBe(200);
  expect((await decideProbe(id, "probe-1", true)).status).toBe(200);
  await ask(id, "Anything else?");
  const all = session.entries();
  let compared = 0;
  for (let n = 1; n <= all.length; n++) {
    if (live[n] === undefined) continue;
    expect(fold(all, n), `entry ${n} (${all[n - 1]!.type})`).toEqual(live[n]!);
    compared++;
  }
  expect(live[all.length]).toBeDefined();
  expect(compared).toBeGreaterThan(all.length / 2);
  expect(fold(all)).toEqual(session.state);
  expect(session.state.skipped).toEqual([]);
  const report = verifyCase(session.dir);
  expect(report).toMatchObject({ ok: true, entries: all.length, firstBad: null });
});

test("an approve sent twice runs one query", async () => {
  await start([probe({ kind: "pivot", source: "assets", pivot: "address_to_asset", value: ADDRESS }), WAITING]);
  const id = await newBuilder();
  await ask(id);
  const [a, b] = await Promise.all([decideProbe(id, "probe-1", true), decideProbe(id, "probe-1", true)]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  expect(ofType(id, "query.issued").length).toBe(1);
  expect(ofType(id, "builder.probe_decided").length).toBe(1);
});

test("the probe a person approves goes through runQuery only: the server's builder code names no connector and no other runner", () => {
  const text = readFileSync(join(import.meta.dir, "..", "..", "src", "server", "builder.ts"), "utf8");
  expect(text).toContain("runQuery(");
  for (const other of ["runPivot(", "runPlaybook(", "runProposal(", "ConnectorPool", "pool.for(", ".run("]) expect(text).not.toContain(other);
});
