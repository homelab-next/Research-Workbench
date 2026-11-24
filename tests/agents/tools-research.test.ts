import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import type { Payloads } from "../../src/core/types";
import type { RunQueryResult } from "../../src/modules/runner";
import { agent, fixture, START } from "../helpers/tools-fixture";
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
  expect((await f.call("run_step", { step: "nope", why: "w" })).summary).toBe("unknown step: nope");
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
  // an engine that declines leaves the step blocked
  f.ctx.onNeedsBudget = async () => null;
  const again = await f.call("run_step", { step: "s3", why: "again" });
  expect(again.summary).toBe("waiting for a person's budget (proposal p1)");
  expect(f.s.state.plan.steps.s3!.status).toBe("blocked");
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
