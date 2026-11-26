import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { execTool, parseCall } from "../../src/agents/tools";
import type { Payloads, PlanStep } from "../../src/core/types";
import { stepPins } from "../../src/modules/pins";
import type { RunQueryResult } from "../../src/modules/runner";
import { agent, fixture, person, PLAN, START, WINDOW } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
beforeEach(() => { f = fixture(true); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});

const issued = (): Payloads["query.issued"][] => f.s.entries().filter((e) => e.type === "query.issued").map((e) => e.payload as Payloads["query.issued"]);
const view = (r: { view: Json }): Record<string, Json> => r.view as Record<string, Json>;

test("run_pivot runs a free pivot through the runner as the agent", async () => {
  f.ctx.subgoal = "g2";
  const r = await f.call("run_pivot", { why: "who talked to it", pivot: "address_to_internal_peers", value: START });
  expect(r.ok).toBe(true);
  expect(r.summary).toMatch(/^\d+ rows · /);
  expect(r.marking).toBe("TLP:GREEN");
  const q = f.s.entries().find((e) => e.type === "query.issued")!;
  expect(q.actor).toEqual(agent);
  expect((q.payload as Payloads["query.issued"]).why).toBe("who talked to it");
  expect((q.payload as Payloads["query.issued"]).pivot).toBe("address_to_internal_peers");
  const v = view(r);
  expect(v.status).toBe("done");
  const cards = v.card as { id: string; title: string }[];
  expect(cards).toHaveLength(1);
  expect(f.s.state.cards[cards[0]!.id]!.subgoal).toBe("g2");
  expect((v.found as string[]).length).toBeGreaterThan(0);
  expect((v.data as Json[]).length).toBeLessThanOrEqual(20);
  expect(v.proposal).toBeNull();
});

test("run_pivot refuses a costly pivot and one that leads away from the sub-goal", async () => {
  const head = f.s.head().seq;
  const costly = await f.call("run_pivot", { why: "w", pivot: "address_to_verdict", value: START });
  expect(costly).toMatchObject({ ok: false, summary: "address_to_verdict is costly; it must be a plan step" });
  // the reputation sub-goal (g3) can only be reached through a costly pivot, which the limits here rule out
  f.ctx.subgoal = "g3";
  f.ctx.limits = { ...f.ctx.limits, max_weight: 0 };
  const away = await f.call("run_pivot", { why: "w", pivot: "address_to_asset", value: START });
  expect(away).toMatchObject({ ok: false, summary: "address_to_asset does not lead to this sub-goal" });
  const unknown = await f.call("run_pivot", { why: "w", pivot: "nope", value: START });
  expect(unknown.ok).toBe(false);
  expect(f.s.head().seq).toBe(head);
  // a pivot that ends elsewhere still serves a sub-goal it can reach by further hops
  f.ctx.subgoal = "g1";
  expect((await f.call("run_pivot", { why: "w", pivot: "address_to_domains", value: START })).ok).toBe(true);
  f.ctx.subgoal = null;
  expect((await f.call("run_pivot", { why: "w", pivot: "address_to_domains", value: START })).ok).toBe(true);
});

test("run_pivot needs an accepted plan", async () => {
  f.close();
  f = fixture(false);
  const r = await f.call("run_pivot", { why: "w", pivot: "address_to_asset", value: START });
  expect(r).toMatchObject({ ok: false, summary: "the plan has not been accepted" });
});

test("run_pivot on a value of the wrong type is a refusal the model can read", async () => {
  const r = await f.call("run_pivot", { why: "w", pivot: "address_to_asset", value: "not-an-address" });
  expect(r.ok).toBe(false);
  expect(r.summary).toContain("takes a address");
  expect(view(r).status).toBe("refused");
  expect(issued()).toEqual([]);
});

test("run_step runs an accepted step and records its start and finish", async () => {
  const r = await f.call("run_step", { step: "s1", why: "is it internal" });
  expect(r.summary).toBe("no rows · proven negative");
  expect(r.ok).toBe(true);
  expect(f.s.state.plan.steps.s1).toMatchObject({ status: "empty", cards: ["c1"], note: "no rows · proven negative" });
  const types = f.s.entries().map((e) => e.type).filter((t) => t.startsWith("step.") || t.startsWith("query."));
  expect(types).toEqual(["step.started", "query.issued", "query.result", "step.finished"]);
  expect(f.s.state.cards.c1!.step).toBe("s1");
  expect(view(r).empty).toBe("proven-negative");
});

test("run_step on a later hop needs a value, and takes one", async () => {
  const none = await f.call("run_step", { step: "s4", why: "w" });
  expect(none).toMatchObject({ ok: false, summary: "this step needs a value from an earlier step" });
  expect(f.s.state.plan.steps.s4!.status).toBe("pending");
  const r = await f.call("run_step", { step: "s4", value: "192.0.2.17", why: "w" });
  expect(r.ok).toBe(true);
  expect(r.summary).toBe("1 row · full coverage");
  expect(view(r).found).toEqual(["ws-17.example.net"]);
  expect(f.s.state.plan.steps.s4).toMatchObject({ status: "answered" });
});

test("run_step refuses a step that was not accepted or belongs to another sub-goal", async () => {
  f.s.commit(() => [{ type: "plan.accepted", actor: agent, payload: { plan: "plan-1", steps: ["s1", "s2"], budgets: {} } }]);
  expect((await f.call("run_step", { step: "s4", value: "192.0.2.17", why: "w" })).summary).toBe("step s4 was not accepted");
  expect((await f.call("run_step", { step: "nope", why: "w" })).summary).toStartWith("unknown step: nope; the plan's steps are ");
  f.ctx.subgoal = "g2";
  expect((await f.call("run_step", { step: "s1", why: "w" })).summary).toBe("step s1 belongs to sub-goal g1, not g2");
  expect(issued()).toEqual([]);
  expect(f.s.state.plan.steps.s1!.status).toBe("pending");
});

test("a costly step becomes a proposal and the step is blocked", async () => {
  const r = await f.call("run_step", { step: "s3", why: "known bad?" });
  expect(r.ok).toBe(true);
  expect(r.summary).toBe("waiting for a person's budget (proposal p1)");
  expect(view(r)).toMatchObject({ status: "needs_budget", proposal: "p1", card: null, data: null });
  expect(f.s.state.proposals.p1).toMatchObject({ status: "open", kind: "costly_query", step: "s3", by: agent.id });
  expect(f.s.state.plan.steps.s3).toMatchObject({ status: "blocked", cards: [] });
  expect(r.marking).toBeNull();
});

test("a costly step the engine pays for comes back done", async () => {
  const calls: [string, string | null][] = [];
  const paid: RunQueryResult = { status: "done", query: "q9", card: null, outcome: "answered", rows: 1, rows_hash: "h", coverage: { kind: "full" }, columns: ["verdict"], data: [["suspicious"]] };
  f.ctx.onNeedsBudget = async (proposal, step) => { calls.push([proposal, step]); return paid; };
  const r = await f.call("run_step", { step: "s3", why: "known bad?" });
  expect(calls).toEqual([["p1", "s3"]]);
  expect(r.summary).toBe("1 row · full coverage");
  expect(view(r).found).toEqual(["suspicious"]);
  expect(f.s.state.plan.steps.s3).toMatchObject({ status: "answered" });
  expect(r.marking).toBe("TLP:GREEN");
});

test("run_query is refused on a source that does not allow agent queries", async () => {
  const head = f.s.head().seq;
  const r = await f.call("run_query", { why: "w", source: "flows", text: "select src from flows", bound: {} });
  expect(r).toMatchObject({ ok: false, summary: "this source does not allow agent-written queries" });
  expect(view(r).status).toBe("refused");
  expect(f.s.head().seq).toBe(head);
});

test("run_query runs on an adhoc source as the agent, with no pivot", async () => {
  f.close();
  f = fixture(true);
  const reg = f.sample.registry;
  const flows = reg.source("flows")!;
  Object.assign(flows, { adhoc: true });
  const r = await f.call("run_query", { why: "look", source: "flows", text: "select src from flows where dst = {value} limit 3", bound: { value: START } });
  expect(r.ok).toBe(true);
  expect(view(r).found).toBeNull();
  expect(issued()[0]).toMatchObject({ pivot: null, why: "look" });
  expect(f.s.entries().find((e) => e.type === "query.issued")!.actor).toEqual(agent);
});

test("a partial result says partial and is never called a negative", async () => {
  f.close();
  f = fixture(true);
  Object.assign(f.sample.registry.source("flows")!.limits, { max_rows: 1 });
  f.ctx.subgoal = "g2";
  const r = await f.call("run_pivot", { why: "w", pivot: "address_to_internal_peers", value: START });
  expect(r.summary).toBe("1 row · partial: row_limit");
  expect(view(r).coverage).toMatchObject({ kind: "partial", reason: "row_limit" });
  expect(r.summary).not.toContain("negative");
});

test("an engine that declines leaves the step blocked, and a finished step does not run again", async () => {
  f.ctx.onNeedsBudget = async () => null;
  const first = await f.call("run_step", { step: "s3", why: "known bad?" });
  expect(first.summary).toBe("waiting for a person's budget (proposal p1)");
  expect(f.s.state.plan.steps.s3!.status).toBe("blocked");
  const head = f.s.head().seq;
  const again = await f.call("run_step", { step: "s3", why: "again" });
  expect(again).toMatchObject({ ok: true, summary: "this step has already run: waiting for a person's budget (proposal p1)", view: { status: "already_run", outcome: "blocked" } });
  expect(f.s.head().seq).toBe(head);
  for (const step of ["s1"]) {
    await f.call("run_step", { step, why: "w" });
    expect((await f.call("run_step", { step, why: "w" })).summary).toBe("this step has already run: no rows · proven negative");
  }
  expect(issued().filter((q) => q.step === "s1")).toHaveLength(1);
});

test("a failed finish write is retried once as failed so the step is never left running", async () => {
  const real = f.s.commit.bind(f.s);
  let refused = 0;
  f.s.commit = ((build: Parameters<typeof real>[0]) => {
    let kind = "";
    try { kind = build(f.s.state, { next: () => "x" } as never)[0]?.type ?? ""; } catch { kind = ""; }
    if (kind === "step.finished" && refused === 0) { refused++; throw new Error("commit refused\nsecond line"); }
    return real(build);
  }) as typeof f.s.commit;
  const r = await f.call("run_step", { step: "s1", why: "w" });
  f.s.commit = real;
  expect(refused).toBe(1);
  expect(r).toMatchObject({ ok: false, summary: "commit refused" });
  expect(f.s.state.plan.steps.s1!.status).toBe("failed");
  // and if the retry is refused too, nothing else is thrown past the tool
  f.s.commit = ((build: Parameters<typeof real>[0]) => {
    let kind = "";
    try { kind = build(f.s.state, { next: () => "x" } as never)[0]?.type ?? ""; } catch { kind = ""; }
    if (kind === "step.finished") throw new Error("still refused");
    return real(build);
  }) as typeof f.s.commit;
  const r2 = await f.call("run_step", { step: "s2", why: "w" });
  f.s.commit = real;
  expect(r2).toMatchObject({ ok: false, summary: "still refused" });
});

test("the marking is the source of the pivot that ran, not the step's named source", async () => {
  f.sample.registry.source("assets")!.marking = "TLP:AMBER";
  f.sample.registry.source("reputation")!.marking = "TLP:CLEAR";
  f.s.commit((_st, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: { ...PLAN(ids.next("plan")), steps: PLAN("x").steps.map((x) => (x.id === "s1" ? { ...x, source: "reputation" } : x)) } } }]);
  f.s.commit(() => [{ type: "plan.accepted", actor: person, payload: { plan: "plan-2", steps: ["s1"], budgets: {} } }]);
  const r = await f.call("run_step", { step: "s1", why: "w" });
  expect(r.marking).toBe("TLP:AMBER");
});

test("a missing database does not give away where it was", async () => {
  rmSync(join(f.sample.root, "data", "flows.sqlite"));
  f.ctx.subgoal = "g2";
  const r = await f.call("run_pivot", { why: "w", pivot: "address_to_internal_peers", value: START });
  expect(r.ok).toBe(false);
  expect(r.summary).toStartWith("the query failed: ");
  const text = JSON.stringify([r.summary, r.view]);
  for (const part of ["flows.sqlite", "../data", f.sample.root, "/tmp/"]) expect(text).not.toContain(part);
  // the full text stays in the ledger
  expect(JSON.stringify(f.s.entries().filter((e) => e.type === "query.failed"))).toContain("flows.sqlite");
  const viaStep = await f.call("run_step", { step: "s2", why: "w" });
  expect(JSON.stringify([viaStep.summary, viaStep.view])).not.toContain("flows.sqlite");
  expect(JSON.stringify(f.s.state.plan.steps.s2)).not.toContain("flows.sqlite");
});

test("a thrown message is scrubbed too", async () => {
  const { execTool, parseCall, TOOLS } = await import("../../src/agents/tools");
  const p = parseCall(["list_sources"], "list_sources", '{"why":"w"}');
  p.tool = { ...TOOLS.list_sources, call: async () => { throw new Error(`cannot open ${f.sample.root}/data/flows.sqlite`); } };
  const r = await execTool(f.ctx, p);
  expect(JSON.stringify(r)).not.toContain(f.sample.root);
  expect(JSON.stringify(r)).not.toContain("flows.sqlite");
});

test("argument sizes are capped", async () => {
  const big = "x".repeat(1_000_000);
  const bad = async (name: Parameters<typeof f.call>[0], args: Record<string, Json>): Promise<string> => {
    const r = await f.call(name, args);
    expect(r.ok).toBe(false);
    expect(r.summary.length).toBeLessThan(300);
    return r.summary;
  };
  expect(await bad("run_pivot", { why: big, pivot: "address_to_asset", value: START })).toContain("why longer than 500");
  expect(await bad("run_query", { why: "w", source: "flows", text: "x".repeat(4001) })).toContain("text longer than 4000");
  expect(await bad("run_step", { why: "w", step: "s".repeat(201) })).toContain("step longer than 200");
  expect(await bad("run_pivot", { why: "w", pivot: "p", value: "v".repeat(201) })).toContain("value longer than 200");
  expect(await bad("find_routes", { why: "w", want: "w".repeat(201), have: [{ type: "address", value: START }] })).toContain("want longer");
  const have = Array.from({ length: 11 }, () => ({ type: "address", value: START }));
  expect(await bad("find_routes", { why: "w", want: "asset", have })).toContain("more than 10 items");
  expect(await bad("read_card", { why: "w", card: "c".repeat(201) })).toContain("card longer than 200");
  expect(await bad("propose_narrative", { why: big, section: "summary", text: "t", cites: [] })).toContain("why longer than 500");
  expect(await bad("request_research", { why: big, question: "q" })).toContain("why longer than 500");
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, "v"]));
  expect(await bad("run_query", { why: "w", source: "flows", text: "select 1", bound: many })).toContain("at most 20");
  expect(await bad("run_query", { why: "w", source: "flows", text: "select 1", bound: { a: "v".repeat(1001) } })).toContain("1000 characters");
  const ok = await f.call("find_routes", { why: "w".repeat(500), want: "asset", have: [{ type: "address", value: START }] });
  expect(ok.ok).toBe(true);
});

test("hostile arguments are refused as results", async () => {
  const head = f.s.head().seq;
  const proto = parseCall(["run_pivot"], "run_pivot", '{"why":"w","pivot":"address_to_asset","value":"x","__proto__":{"admin":true}}');
  expect(proto.error).toContain("__proto__ unexpected property");
  expect(({} as Record<string, unknown>).admin).toBeUndefined();
  for (const bound of [["a"], "a", { a: true }, { a: { b: 1 } }, { a: [1] }]) {
    const r = await f.call("run_query", { why: "w", source: "flows", text: "select 1", bound: bound as Json });
    expect(r.ok).toBe(false);
    expect(r.summary).toStartWith("invalid arguments: ");
  }
  expect((await f.call("run_step", { why: "w", step: "constructor" })).summary).toStartWith("unknown step: constructor; ");
  expect((await f.call("run_step", { why: "w", step: "__proto__" })).summary).toStartWith("unknown step: __proto__; ");
  expect((await f.call("read_card", { why: "w", card: "constructor" })).summary).toBe("unknown card: constructor");
  expect((await f.call("verify_card", { why: "w", card: "__proto__" })).summary).toBe("unknown card: __proto__");
  expect((await f.call("describe_source", { why: "w", source: "constructor" })).summary).toBe("unknown source: constructor");
  expect((await f.call("run_pivot", { why: "w", pivot: "constructor", value: START })).summary).toBe("unknown pivot: constructor");
  expect(f.s.head().seq).toBe(head);
  // a bound with a __proto__ key is an own key in JSON and must not reach anything as a prototype
  Object.assign(f.sample.registry.source("flows")!, { adhoc: true });
  const text = '{"why":"w","source":"flows","text":"select src from flows limit 1","bound":{"__proto__":"x"}}';
  const r = await execTool(f.ctx, parseCall(["run_query"], "run_query", text));
  expect(typeof r.summary).toBe("string");
  expect(({} as Record<string, unknown>).x).toBeUndefined();
});

test("run_step given a pivot id runs the step when the pivot is unique in the sub-goal, and names the steps when it is not", async () => {
  f.ctx.subgoal = "g2";
  const r = await f.call("run_step", { step: "address_to_internal_peers", why: "w" });
  expect(r.ok).toBe(true);
  expect(f.s.state.plan.steps.s2!.status).not.toBe("pending");
  f.ctx.subgoal = null;
  expect((await f.call("run_step", { step: "address_to_asset", why: "w" })).summary)
    .toBe("address_to_asset is a pivot of more than one step; the plan's steps are s1 (address_to_asset), s2 (address_to_internal_peers), s3 (address_to_verdict), s4 (address_to_asset)");
  expect((await f.call("run_step", { step: "nope", why: "w" })).summary)
    .toBe("unknown step: nope; the plan's steps are s1 (address_to_asset), s2 (address_to_internal_peers), s3 (address_to_verdict), s4 (address_to_asset)");
  expect(issued().map((q) => q.step)).toEqual(["s2"]);
});

test("run_step takes a step's description line in place of its id", async () => {
  f.ctx.subgoal = "g1";
  const line = `address_to_asset on assets, from address ${START} to asset`;
  const r = await f.call("run_step", { step: line, why: "w" });
  expect(r.summary).toBe("no rows · proven negative");
  expect(f.s.state.plan.steps.s1).toMatchObject({ status: "empty" });
  // the line as the researcher's part lists it, with its id and dash, is the same step
  f.ctx.subgoal = "g3";
  const costly = await f.call("run_step", { step: `- s3: address_to_verdict on reputation, from address ${START} to verdict (costly)`, why: "w" });
  expect(costly.summary).toBe("waiting for a person's budget (proposal p1)");
  expect(issued().map((q) => q.step)).toEqual(["s1"]);
});

// ---------- reuse of an answered query (task 9 item 1) ----------
const finishedSteps = (): Payloads["step.finished"][] => f.s.entries().filter((e) => e.type === "step.finished").map((e) => e.payload as Payloads["step.finished"]);

test("a step whose query was already answered reuses it: nothing is issued, and the step cites its card", async () => {
  await f.call("run_step", { step: "s1", why: "is it internal" });
  expect(issued()).toHaveLength(1);
  const q1 = f.s.state.queries.q1!;
  const r = await f.call("run_step", { step: "s4", value: START, why: "same lookup again" });
  expect(issued()).toHaveLength(1);
  const note = `reused q1 from ${q1.issued_ts}; same pivot, value and window`;
  expect(r.ok).toBe(true);
  expect(r.summary).toBe(`${note} · no rows · proven negative`);
  expect(view(r)).toMatchObject({ status: "done", reused: { query: "q1", at: q1.issued_ts }, empty: "proven-negative" });
  expect((view(r).card as { id: string }[])[0]!.id).toBe("c1");
  expect(f.s.state.plan.steps.s4).toEqual({ status: "empty", cards: ["c1"], note });
  expect(finishedSteps().at(-1)).toEqual({ step: "s4", outcome: "empty", cards: ["c1"], note, reused: "q1" });
  const fin = f.s.entries().filter((e) => e.type === "step.finished").at(-1)!;
  expect(fin.cause).toBe(f.s.state.cards.c1!.created_seq);
  expect(Object.keys(f.s.state.cards)).toEqual(["c1"]);
});

test("run_pivot reuses an answered query with the same pivot, value and window, and says so", async () => {
  f.ctx.subgoal = "g1";
  const asset = { why: "which asset", pivot: "address_to_asset", value: "192.0.2.17" };
  const first = await f.call("run_pivot", asset);
  expect(first.summary).toBe("1 row · full coverage");
  const again = await f.call("run_pivot", asset);
  expect(issued()).toHaveLength(1);
  expect(again.summary).toBe(`reused q1 from ${f.s.state.queries.q1!.issued_ts}; same pivot, value and window · 1 row · full coverage`);
  expect(view(again).found).toEqual(["ws-17.example.net"]);
  expect(view(again).data).toEqual(view(first).data);
  expect(view(again).card).toEqual(view(first).card);
  expect(view(first).reused).toBeUndefined();
  expect(again.marking).toBe(first.marking);
  // a step on the same pivot, value and window is answered by the same query
  f.ctx.subgoal = "g2";
  const step = await f.call("run_step", { step: "s4", value: "192.0.2.17", why: "the plan's step" });
  expect(issued()).toHaveLength(1);
  expect(view(step).reused).toMatchObject({ query: "q1" });
  expect(f.s.state.plan.steps.s4).toMatchObject({ status: "answered", cards: ["c1"] });
});

test("a different value or window, a failed result, or a changed pivot or source runs again", async () => {
  f.ctx.subgoal = "g1";
  const asset = { why: "w", pivot: "address_to_asset", value: "192.0.2.17" };
  await f.call("run_pivot", asset);
  await f.call("run_pivot", { ...asset, value: START });
  expect(issued()).toHaveLength(2);
  f.ctx.window = { from: "2026-11-18T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" };
  await f.call("run_pivot", asset);
  expect(issued()).toHaveLength(3);
  f.ctx.window = WINDOW;
  const pivot = f.sample.registry.pivot("address_to_asset")!;
  const pivotHash = pivot.hash;
  pivot.hash = "a-changed-pivot";
  await f.call("run_pivot", asset);
  expect(issued()).toHaveLength(4);
  pivot.hash = pivotHash;
  const source = f.sample.registry.source("assets")!;
  const sourceHash = source.hash;
  source.hash = "a-changed-source";
  await f.call("run_pivot", asset);
  expect(issued()).toHaveLength(5);
  source.hash = sourceHash;
  // the unchanged manifests find their first answer again
  expect((await f.call("run_pivot", asset)).summary).toStartWith("reused q1 ");
  expect(issued()).toHaveLength(5);
});

test("a partial result is not reused", async () => {
  Object.assign(f.sample.registry.source("flows")!.limits, { max_rows: 1 });
  f.ctx.subgoal = "g2";
  const peers = { why: "w", pivot: "address_to_internal_peers", value: START };
  expect((await f.call("run_pivot", peers)).summary).toBe("1 row · partial: row_limit");
  expect((await f.call("run_pivot", peers)).summary).toBe("1 row · partial: row_limit");
  expect(issued()).toHaveLength(2);
});

test("a failed query is not reused", async () => {
  const db = join(f.sample.root, "data", "flows.sqlite");
  const saved = Bun.file(db);
  const bytes = new Uint8Array(await saved.arrayBuffer());
  rmSync(db);
  f.ctx.subgoal = "g2";
  const peers = { why: "w", pivot: "address_to_internal_peers", value: START };
  expect((await f.call("run_pivot", peers)).ok).toBe(false);
  await Bun.write(db, bytes);
  const r = await f.call("run_pivot", peers);
  expect(r.ok).toBe(true);
  expect(view(r).reused).toBeUndefined();
  expect(issued()).toHaveLength(2);
});

test("a person's lookup always runs fresh", async () => {
  const { runPivot } = await import("../../src/modules/pivots");
  const ask = { pivot: "address_to_asset", value: START, window: WINDOW, why: "w", actor: person };
  await runPivot(f.s, f.sample.deps, ask);
  await runPivot(f.s, f.sample.deps, ask);
  expect(issued()).toHaveLength(2);
});

test("an answer whose card a person discarded is not reused", async () => {
  f.ctx.subgoal = "g1";
  const asset = { why: "w", pivot: "address_to_asset", value: "192.0.2.17" };
  await f.call("run_pivot", asset);
  f.s.commit(() => [{ type: "card.discarded", actor: person, payload: { card: "c1" } }]);
  expect(f.s.state.discarded).toEqual(["c1"]);
  const r = await f.call("run_pivot", asset);
  expect(view(r).reused).toBeUndefined();
  expect(issued()).toHaveLength(2);
});

test("run_step on a playbook step is refused and writes nothing: the engine runs it", async () => {
  const pb = f.sample.registry.playbook("address-triage")!;
  f.s.commit((_st, ids) => [{
    type: "plan.proposed", actor: agent,
    payload: {
      plan: {
        id: ids.next("plan"), goal: "g", window: WINDOW, subgoals: [{ id: "g1", title: "Triage", question: "What is it?", steps: ["s1"] }],
        steps: [{
          id: "s1", subgoal: "g1", pivot: "", source: "", from: { type: "address", value: START }, to: "asset", window: WINDOW, needs_window: true, free: true, weight: 0,
          estimate: null, empty_means: "proven-negative", warnings: [], playbook: { id: pb.id, hash: pb.hash, inputs: [{ type: "address", value: START }] },
        }],
      },
    },
  }]);
  f.s.commit(() => [{ type: "plan.accepted", actor: person, payload: { plan: "plan-2", steps: ["s1"], budgets: {} } }]);
  const head = f.s.head().seq;
  const r = await f.call("run_step", { why: "w", step: "s1" });
  expect(r).toMatchObject({ ok: false, summary: "step s1 is a playbook; the engine runs it" });
  expect(f.s.head().seq).toBe(head);
});

test("a finished step read back with no card carries its source's marking", async () => {
  // final review M1: the failure note is the source's words; reading it back must not drop the source's marking
  f.s.commit(() => [
    { type: "step.started", actor: agent, payload: { step: "s1" } },
    { type: "step.finished", actor: agent, payload: { step: "s1", outcome: "failed", cards: [], note: "the query failed: the source's own error line" } },
  ]);
  (f.sample.registry.source("assets") as { marking: string }).marking = "TLP:AMBER";
  const r = await f.call("run_step", { step: "s1", why: "w" });
  expect(r).toMatchObject({ ok: true, view: { status: "already_run", outcome: "failed" } });
  expect(r.marking).toBe("TLP:AMBER");
});

test("run_step on a route step whose pivot changed since acceptance finishes it blocked and sends nothing", async () => {
  const st: PlanStep = {
    id: "s1", subgoal: "g1", pivot: "address_to_domains", source: "dns-logs", from: { type: "address", value: START }, to: "domain", window: WINDOW,
    needs_window: true, free: true, weight: 0, estimate: null, empty_means: "not-seen", warnings: [],
  };
  st.pins = stepPins(f.sample.registry, st)!;
  f.s.commit((_st, ids) => [{
    type: "plan.proposed", actor: agent,
    payload: { plan: { id: ids.next("plan"), goal: "g", window: WINDOW, subgoals: [{ id: "g1", title: "Names", question: "Which names?", steps: ["s1"] }], steps: [st] } },
  }]);
  f.s.commit(() => [{ type: "plan.accepted", actor: person, payload: { plan: "plan-2", steps: ["s1"], budgets: {} } }]);
  const pivot = f.sample.registry.pivot("address_to_domains")!;
  const hash = pivot.hash;
  pivot.hash = "a-changed-pivot";
  try {
    const result = await f.call("run_step", { why: "w", step: "s1" });
    expect(result).toMatchObject({ ok: true, view: { status: "blocked", step: "s1" } });
    expect(f.s.state.plan.steps.s1).toMatchObject({ status: "blocked", note: "the pivot address_to_domains changed since the plan was accepted; re-plan to use it" });
    expect(issued()).toEqual([]);
  } finally { pivot.hash = hash; }
});

test("a step recorded without pins runs as before", async () => {
  // PLAN() from the fixture has no pins: a changed pivot does not stop the lookup
  expect(f.s.state.plan.current!.steps[0]!.pins).toBeUndefined();
  const pivot = f.sample.registry.pivot("address_to_asset")!;
  const hash = pivot.hash;
  pivot.hash = "a-changed-pivot";
  try {
    const r = await f.call("run_step", { why: "w", step: "s1" });
    expect(r.ok).toBe(true);
    expect(issued()).toHaveLength(1);
  } finally { pivot.hash = hash; }
});
