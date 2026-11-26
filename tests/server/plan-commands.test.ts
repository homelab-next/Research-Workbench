import { afterEach, expect, test } from "bun:test";
import type { Actor } from "../../src/core/types";
import { runPivot } from "../../src/modules/pivots";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startStandin } from "../helpers/http-standin";
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

const agent: Actor = { kind: "agent", id: "researcher-g2", stage: "research", profile: "investigation", model: "m", effort: null, where: "machine" };
const types = (id: string): string[] => s.entries(id).map((e) => e.type);
const state = (id: string) => s.app.hub.read(id).state;

/** A case at the plan gate with one open costly proposal, raised by an agent for the reputation lookup. */
async function withProposal(): Promise<{ id: string; proposal: string }> {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPlanGate(id);
  const r = await runPivot(s.app.hub.read(id), s.app.hub.deps.runner, { pivot: "address_to_verdict", value: "198.51.100.77", window: state(id).plan.current!.window, why: "the agent wants it", actor: agent });
  if (r.status !== "needs_budget" || r.proposal === null) throw new Error(`no proposal: ${JSON.stringify(r)}`);
  return { id, proposal: r.proposal };
}

test("estimate_step, run_proposal and reject_proposal never move the run", async () => {
  const { id, proposal } = await withProposal();
  const run = state(id).run;
  let before = s.entries(id).length;
  expect((await s.command(id, "estimate_step", { step: "s3" })).status).toBe(200);
  await s.app.hub.idle();
  expect(types(id).at(-1)).toBe("step.estimated");
  expect(state(id).plan.estimates.s3).toMatchObject({ unit: "lookups" });
  expect(state(id).run).toEqual(run);
  before = s.entries(id).length;
  expect((await s.command(id, "reject_proposal", { proposal, reason: "not worth it" })).status).toBe(200);
  await s.app.hub.idle();
  expect(types(id).slice(before)).toEqual(["proposal.rejected"]);
  expect(state(id).run).toEqual(run);
  const again = await withProposalOn(id);
  before = s.entries(id).length;
  expect((await s.command(id, "run_proposal", { proposal: again, budget: 10 })).status).toBe(200);
  await s.app.hub.idle();
  expect(types(id).slice(before)).toContain("proposal.accepted");
  expect(state(id).proposals[again]!.status).toBe("accepted");
  expect(state(id).run).toEqual(run);
});

async function withProposalOn(id: string): Promise<string> {
  const r = await runPivot(s.app.hub.read(id), s.app.hub.deps.runner, { pivot: "address_to_verdict", value: "198.51.100.77", window: state(id).plan.current!.window, why: "again", actor: agent });
  if (r.status !== "needs_budget" || r.proposal === null) throw new Error(`no proposal: ${JSON.stringify(r)}`);
  return r.proposal;
}

test("run_proposal with a budget below the estimate is refused in the queue and leaves the proposal open", async () => {
  const { id, proposal } = await withProposal();
  const before = s.entries(id).length;
  const r = await s.command(id, "run_proposal", { proposal, budget: 0.5 });
  expect(r.status).toBe(409);
  expect(JSON.stringify(r.body)).toMatch(/the estimate is \d+ lookups; the budget does not cover it/);
  await s.app.hub.idle();
  expect(s.entries(id).length).toBe(before);
  expect(types(id).filter((t) => t === "proposal.accepted")).toEqual([]);
  expect(state(id).proposals[proposal]!.status).toBe("open");
  expect(s.entries(id).slice(before).filter((e) => e.type === "query.result" && state(id).queries[e.payload.query]!.purpose === "result")).toEqual([]);
});

test("run_proposal for an unknown or closed proposal is refused with the runner's words", async () => {
  const { id, proposal } = await withProposal();
  expect((await s.command(id, "run_proposal", { proposal: "p99", budget: 10 })).status).toBe(409);
  expect((await s.command(id, "reject_proposal", { proposal, reason: "no" })).status).toBe(200);
  const r = await s.command(id, "run_proposal", { proposal, budget: 10 });
  expect(r.status).toBe(409);
  expect(JSON.stringify(r.body)).toContain("rejected, not open");
});

test("reject_proposal closes an open proposal and is refused for one already closed", async () => {
  const { id, proposal } = await withProposal();
  const r = await s.command(id, "reject_proposal", { proposal, reason: "not worth it" });
  expect(r.status).toBe(200);
  expect(state(id).proposals[proposal]).toMatchObject({ status: "rejected", reason: "not worth it" });
  const e = s.entries(id).at(-1)!;
  expect(e).toMatchObject({ type: "proposal.rejected", actor: { kind: "human", id: s.config.user }, payload: { proposal, reason: "not worth it" } });
  const before = s.entries(id).length;
  expect((await s.command(id, "reject_proposal", { proposal, reason: "again" })).status).toBe(409);
  expect((await s.command(id, "reject_proposal", { proposal: "p99", reason: "x" })).status).toBe(409);
  expect(s.entries(id).length).toBe(before);
});

test("estimate_step refuses a free step and a step that is not there, writing nothing", async () => {
  const { id } = await withProposal();
  const before = s.entries(id).length;
  const free = await s.command(id, "estimate_step", { step: "s1" });
  expect(free.status).toBe(409);
  expect(JSON.stringify(free.body)).toContain("step s1 is free and needs no estimate");
  expect((await s.command(id, "estimate_step", { step: "s9" })).status).toBe(409);
  expect(s.entries(id).length).toBe(before);
});

test("the three commands are for the analyst only", async () => {
  s = await served({ role: "requester" });
  const id = "CASE-1";
  for (const [name, args] of [["estimate_step", { step: "s1" }], ["run_proposal", { proposal: "p1", budget: 1 }], ["reject_proposal", { proposal: "p1", reason: "r" }]] as const) {
    expect([name, (await s.command(id, name, args)).status]).toEqual([name, 403]);
  }
});

// ---------- a slow source never holds the case's queue ----------
test("a source that never answers does not hold stop, and a late answer writes no proposal entry", async () => {
  let release: (r: Response) => void = () => {};
  const hung = startStandin({ "GET /v1/reputation/198.51.100.77": () => new Promise<Response>((resolve) => { release = resolve; }) });
  s = await served({ before: (root) => { const f = join(root, "sources", "reputation.yaml"); writeFileSync(f, readFileSync(f, "utf8").replace(/location: .*/, `location: ${hung.url}`)); } });
  try {
    const id = await s.newCase();
    cases.push(id);
    await s.toPlanGate(id);
    const r = await runPivot(s.app.hub.read(id), s.app.hub.deps.runner, { pivot: "address_to_verdict", value: "198.51.100.77", window: state(id).plan.current!.window, why: "x", actor: agent });
    if (r.status !== "needs_budget" || r.proposal === null) throw new Error("no proposal");
    const t0 = Date.now();
    const run = await s.command(id, "run_proposal", { proposal: r.proposal, budget: 10 });
    expect(run.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
    while (hung.requests.length === 0) await Bun.sleep(20);
    const t1 = Date.now();
    expect((await s.command(id, "stop", { reason: "enough" })).status).toBe(200);
    expect(Date.now() - t1).toBeLessThan(1000);
    expect(state(id).run).toMatchObject({ status: "finished", outcome: "stopped" });
    const at = s.entries(id).length;
    release(new Response(JSON.stringify({ results: [] }), { headers: { "content-type": "application/json" } }));
    await s.app.hub.idle();
    expect(s.entries(id).slice(at).filter((e) => e.type.startsWith("proposal."))).toEqual([]);
  } finally {
    release(new Response("{}"));
    hung.stop();
  }
});

test("run_proposal still refuses at once what can be seen without the source", async () => {
  const { id } = await withProposal();
  const before = s.entries(id).length;
  expect((await s.command(id, "run_proposal", { proposal: "p99", budget: 10 })).status).toBe(409);
  expect((await s.command(id, "run_proposal", { proposal: "p1", budget: -1 })).status).toBe(409);
  expect(s.entries(id).length).toBe(before);
});

// ---------- a command that is still pricing when the case moves on ----------
/** Holds every connector's `method` until `gate` opens. */
function hold(method: "estimate" | "run", gate: Promise<void>): void {
  const pool = s.app.hub.deps.runner.pool;
  const real = pool.for.bind(pool);
  (pool as { for: unknown }).for = (src: never) => {
    const c = real(src) as unknown as Record<string, unknown>;
    return new Proxy(c, { get(t, k) {
      const v = t[k as string];
      if (k === method) return async (...a: unknown[]) => { await gate; return (v as (...x: unknown[]) => unknown).apply(t, a); };
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    } });
  };
}
const gateOf = (): { gate: Promise<void>; open: () => void } => { let open = () => {}; const gate = new Promise<void>((r) => { open = r; }); return { gate, open }; };
const after = (id: string, at: number): string[] => s.entries(id).slice(at).map((e) => e.type);

for (const [how, args] of [["stop", { reason: "enough" }], ["deny_plan", { reason: "no" }], ["replan", { note: "again" }]] as const) {
  test(`a proposal still being priced when the case is ${how === "stop" ? "stopped" : how === "deny_plan" ? "denied" : "re-planned"} is not accepted or run`, async () => {
    const { id, proposal } = await withProposal();
    const g = gateOf();
    hold("estimate", g.gate);
    expect((await s.command(id, "run_proposal", { proposal, budget: 10 })).status).toBe(200);
    expect((await s.command(id, how, args)).status).toBe(200);
    const at = s.entries(id).length;
    g.open();
    await s.app.hub.idle();
    await Bun.sleep(50);
    await s.app.hub.idle();
    expect(after(id, at).filter((t) => t.startsWith("proposal.") || t.startsWith("query.") || t === "card.created")).toEqual([]);
    expect(state(id).proposals[proposal]!.status).toBe("open");
  });
}

test("a query that was issued before the case was stopped still writes its result and card", async () => {
  const { id, proposal } = await withProposal();
  const g = gateOf();
  hold("run", g.gate);
  expect((await s.command(id, "run_proposal", { proposal, budget: 10 })).status).toBe(200);
  while (!types(id).includes("proposal.accepted")) await Bun.sleep(10);
  expect((await s.command(id, "stop", { reason: "enough" })).status).toBe(200);
  const at = s.entries(id).length;
  g.open();
  await s.app.hub.idle();
  expect(after(id, at)).toContain("query.result");
});

test("an estimate still being made when the run is stopped writes no step.estimated", async () => {
  const { id } = await withProposal();
  const g = gateOf();
  hold("estimate", g.gate);
  expect((await s.command(id, "estimate_step", { step: "s3" })).status).toBe(200);
  expect((await s.command(id, "stop", { reason: "enough" })).status).toBe(200);
  const at = s.entries(id).length;
  g.open();
  await s.app.hub.idle();
  await Bun.sleep(50);
  await s.app.hub.idle();
  expect(after(id, at)).not.toContain("step.estimated");
  expect(state(id).plan.estimates).toEqual({});
});

test("the set of proposals being run belongs to the hub and is empty once they are done", async () => {
  const { id, proposal } = await withProposal();
  expect(s.app.hub.running.size).toBe(0);
  await s.command(id, "run_proposal", { proposal, budget: 10 });
  await s.app.hub.idle();
  expect(s.app.hub.running.size).toBe(0);
});

test("nothing runs after a person's stop that lands while a researcher's model turn is in flight", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPlanGate(id);
  const session = s.app.hub.read(id);
  let stopped = false;
  const off = session.subscribe((e) => {
    if (!stopped && e.type === "model.request" && e.actor.kind === "agent" && e.actor.stage === "research") {
      stopped = true;
      // the person's stop arrives while the provider is being asked
      queueMicrotask(() => { s.app.hub.engine(id).stop({ kind: "human", id: "analyst" }, "stop now"); });
    }
  });
  try {
    const plan = session.state.plan.current!;
    expect((await s.command(id, "accept_plan", { plan: plan.id, steps: plan.steps.map((x) => x.id), budgets: { s3: 5 } })).status).toBe(200);
    await s.app.hub.idle();
  } finally { off(); }
  expect(stopped).toBe(true);
  const all = s.entries(id);
  const at = all.findIndex((e) => e.type === "run.finished" && e.payload.outcome === "stopped");
  expect(at).toBeGreaterThan(-1);
  // a query already issued may still record its result (and the card that holds it); nothing new starts
  const issuedBefore = new Set(all.slice(0, at).flatMap((e) => (e.type === "query.issued" ? [e.payload.query] : [])));
  const after = all.slice(at + 1).filter((e) => !(e.type === "card.created" && e.payload.card.query !== null && issuedBefore.has(e.payload.card.query)))
    .map((e) => `${e.seq} ${e.type} ${e.actor.kind}:${e.actor.id}`);
  expect(after.filter((x) => /tool\.called|query\.issued|proposal\.accepted|card\.created/.test(x))).toEqual([]);
});
