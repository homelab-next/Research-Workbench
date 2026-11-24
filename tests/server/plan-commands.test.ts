import { afterEach, expect, test } from "bun:test";
import type { Actor } from "../../src/core/types";
import { runPivot } from "../../src/modules/pivots";
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

test("run_proposal with a budget below the estimate is refused and leaves the proposal open", async () => {
  const { id, proposal } = await withProposal();
  const before = s.entries(id).length;
  const r = await s.command(id, "run_proposal", { proposal, budget: 0.5 });
  expect(r.status).toBe(409);
  expect(JSON.stringify(r.body)).toMatch(/the estimate is \d+ lookups; the budget does not cover it/);
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
