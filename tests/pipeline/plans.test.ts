import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../../src/core/types";
import { loadConfig } from "../../src/modules/config";
import { DEFAULT_LIMITS } from "../../src/modules/seeker";
import { acceptPlan, buildPlan, denyPlan, PlanRefused, requestReplan, spendPlanBudget } from "../../src/pipeline/plans";
import type { PlanOutput } from "../../src/pipeline/plans";
import { agent, fixture, PLAN, person, START, WINDOW } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
let dir: string;
beforeEach(() => { f = fixture(false); dir = mkdtempSync(join(tmpdir(), "plans-")); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
  rmSync(dir, { recursive: true, force: true });
});

const config = () => loadConfig({ env: {}, home: dir, repoRoot: dir });
const deps = () => ({ registry: f.sample.registry, seeker: f.sample.seeker, config: config(), runner: f.sample.deps });
const frame = { window: WINDOW, limits: DEFAULT_LIMITS };
const out: PlanOutput = {
  goal: "who is behind the address",
  subgoals: [
    { title: "Is it internal", question: "Which accounts use it?", have: [{ type: "address", value: START }], want: "account", route: ["address_to_asset", "asset_to_accounts"] },
    { title: "Reputation", question: "What is its reputation?", have: [{ type: "address", value: START }], want: "verdict", route: ["address_to_verdict"] },
  ],
};
const sub = (over: Partial<PlanOutput["subgoals"][number]>): PlanOutput => ({ ...out, subgoals: [{ ...out.subgoals[0]!, ...over }] });
const propose = (o: PlanOutput = out): Plan => {
  const built = buildPlan("", o, deps(), frame, null);
  if ("errors" in built) throw new Error(built.errors.join("; "));
  f.s.commit((_st, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: buildPlan(ids.next("plan"), o, deps(), frame, null) as Plan } }]);
  return f.s.state.plan.current!;
};
const count = (): number => f.s.entries().length;
const refused = (fn: () => void): void => {
  const before = count();
  expect(fn).toThrow(PlanRefused);
  expect(count()).toBe(before);
};

test("a route the seeker offers becomes numbered steps", () => {
  const plan = buildPlan("plan-1", out, deps(), frame, null) as Plan;
  expect(plan.steps.map((s) => [s.id, s.subgoal, s.pivot, s.from.value, s.free])).toEqual([
    ["s1", "g1", "address_to_asset", START, true], ["s2", "g1", "asset_to_accounts", "", true], ["s3", "g2", "address_to_verdict", START, false],
  ]);
  expect(plan.subgoals.map((g) => [g.id, g.steps])).toEqual([["g1", ["s1", "s2"]], ["g2", ["s3"]]]);
  expect(plan.steps[0]).toMatchObject({ from: { type: "address", value: START }, to: "asset", window: WINDOW, estimate: null, source: "assets", empty_means: "proven-negative", warnings: [] });
  expect(plan.steps[2]).toMatchObject({ weight: 5, needs_window: false, empty_means: "not-seen" });
  expect(plan.window).toEqual(WINDOW);
});

test("a route the seeker does not offer is an error naming it", () => {
  const r = buildPlan("", sub({ route: ["address_to_verdict", "asset_to_accounts"] }), deps(), frame, null);
  expect(r).toEqual({ errors: [`sub-goal "Is it internal": the route address_to_verdict, asset_to_accounts is not one the route finder offers from address to account`] });
});

test("a starting value of the wrong type is an error", () => {
  const r = buildPlan("", sub({ have: [{ type: "address", value: "not-an-address" }] }), deps(), frame, null);
  expect("errors" in r && r.errors.length > 0 && r.errors[0]!.includes("not-an-address")).toBe(true);
});

test("a step on a source the research model may not receive carries a warning", () => {
  const strict = { ...config(), marking_policy: { ...config().marking_policy, "TLP:GREEN": ["machine" as const] } };
  const plan = buildPlan("plan-1", out, { ...deps(), config: strict }, frame, { where: "hosted" }) as Plan;
  expect(plan.steps[0]!.warnings).toEqual(["this source is marked TLP:GREEN, which the Research stage's model may not receive"]);
  const open = buildPlan("plan-1", out, deps(), frame, { where: "hosted" }) as Plan;
  expect(open.steps.every((s) => s.warnings.length === 0)).toBe(true);
  const lease = buildPlan("plan-1", sub({ route: ["address_to_asset_by_lease", "asset_to_accounts"] }), deps(), { window: WINDOW, limits: { ...DEFAULT_LIMITS, allow_unconfirmed: true } }, null) as Plan;
  expect(lease.steps[0]!.warnings).toEqual(["unconfirmed source"]);
});

test("accepting makes one lane per sub-goal and passes the gate, in one commit", () => {
  propose();
  const before = count();
  acceptPlan(f.s, { actor: person });
  const added = f.s.entries().slice(before);
  expect(added.map((e) => e.type)).toEqual(["plan.accepted", "lane.created", "lane.created", "gate.passed"]);
  expect(new Set(added.map((e) => e.ts)).size).toBeGreaterThanOrEqual(1);
  expect(added.every((e) => e.actor.kind === "human")).toBe(true);
  expect(added[0]!.payload).toEqual({ plan: "plan-1", steps: ["s1", "s2", "s3"], budgets: {} });
  expect(added[1]!.payload).toMatchObject({ title: "Is it internal", subgoal: "g1" });
  expect(f.s.state.plan.status).toBe("accepted");
  expect(f.s.state.lanes.map((l) => l.subgoal)).toEqual(["g1", "g2"]);
});

test("accepting only the free steps leaves the costly one out", () => {
  propose();
  acceptPlan(f.s, { actor: person, steps: ["s1", "s2"] });
  expect(f.s.state.plan.accepted_steps).toEqual(["s1", "s2"]);
  expect(f.s.state.lanes.map((l) => l.subgoal)).toEqual(["g1"]);
});

test("a budget for a free step, an unknown step, or a budget of zero is refused and nothing is written", () => {
  propose();
  refused(() => acceptPlan(f.s, { actor: person, budgets: { s1: 5 } }));
  refused(() => acceptPlan(f.s, { actor: person, budgets: { s9: 5 } }));
  refused(() => acceptPlan(f.s, { actor: person, budgets: { s3: 0 } }));
  refused(() => acceptPlan(f.s, { actor: person, budgets: { s3: Number.POSITIVE_INFINITY } }));
  refused(() => acceptPlan(f.s, { actor: person, steps: ["s1"], budgets: { s3: 5 } }));
  refused(() => acceptPlan(f.s, { actor: person, steps: ["s9"] }));
  expect(f.s.state.plan.status).toBe("proposed");
});

test("an agent or the system cannot accept a plan", () => {
  propose();
  refused(() => acceptPlan(f.s, { actor: agent }));
  refused(() => acceptPlan(f.s, { actor: { kind: "system", id: "engine" } }));
  refused(() => denyPlan(f.s, { actor: agent, reason: "no" }));
  refused(() => requestReplan(f.s, { actor: agent, note: "no" }));
});

test("a plan that was not proposed cannot be accepted, denied or re-planned", () => {
  refused(() => acceptPlan(f.s, { actor: person }));
  refused(() => denyPlan(f.s, { actor: person, reason: "no" }));
  refused(() => requestReplan(f.s, { actor: person, note: "again" }));
  propose();
  acceptPlan(f.s, { actor: person });
  refused(() => acceptPlan(f.s, { actor: person }));
});

test("denying the plan stops the run", () => {
  propose();
  const before = count();
  denyPlan(f.s, { actor: person, reason: "wrong question" });
  expect(f.s.entries().slice(before).map((e) => [e.type, e.payload])).toEqual([
    ["plan.denied", { plan: "plan-1", reason: "wrong question" }], ["run.finished", { outcome: "stopped" }],
  ]);
  expect(f.s.state.plan.status).toBe("denied");
});

test("a re-plan request is recorded with its note", () => {
  propose();
  requestReplan(f.s, { actor: person, note: "include accounts" });
  expect(f.s.entries().find((e) => e.type === "plan.replan_requested")!.payload).toEqual({ plan: "plan-1", note: "include accounts" });
  expect(f.s.state.plan.status).toBe("replanning");
});

/** The hand-built plan, accepted with a budget on its costly step, and the proposal the researcher's run_step on it raised. */
async function costly(budgets: Record<string, number>): Promise<void> {
  f.s.commit((_st, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: PLAN(ids.next("plan")) } }]);
  acceptPlan(f.s, { actor: person, budgets });
  const r = await f.call("run_step", { step: "s3", why: "reputation" });
  expect(r.view).toMatchObject({ status: "needs_budget", proposal: "p1" });
}

test("a plan budget runs the step's proposal once, in the name of the person who accepted", async () => {
  await costly({ s3: 1 });
  const r = await spendPlanBudget(f.s, f.sample.deps, "p1", "s3");
  expect(r?.status).toBe("done");
  const accepted = f.s.entries().find((e) => e.type === "proposal.accepted")!;
  expect(accepted.actor).toEqual(person);
  expect(accepted.payload).toEqual({ proposal: "p1", budget: 1 });
  const p1 = f.s.state.proposals.p1!;
  f.s.commit((_st, ids) => [{ type: "proposal.created", actor: agent, payload: { proposal: { ...p1, id: ids.next("proposal") } as never } }]);
  expect(f.s.state.proposals.p2!.status).toBe("open");
  expect(await spendPlanBudget(f.s, f.sample.deps, "p2", "s3")).toBeNull();      // the step's budget is spent
});

test("a step with no budget is not paid for", async () => {
  await costly({});
  expect(await spendPlanBudget(f.s, f.sample.deps, "p1", "s3")).toBeNull();
  expect(await spendPlanBudget(f.s, f.sample.deps, "p1", null)).toBeNull();
  expect(await spendPlanBudget(f.s, f.sample.deps, "p1", "s1")).toBeNull();
  expect(f.s.state.proposals.p1!.status).toBe("open");
  expect(f.s.entries().some((e) => e.type === "proposal.accepted")).toBe(false);
});

const plain = (): void => {
  f.s.commit((_st, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: PLAN(ids.next("plan")) } }]);
};
const proposalFor = async (): Promise<void> => {
  const r = await f.call("run_step", { step: "s3", why: "reputation" });
  expect(r.view).toMatchObject({ status: "needs_budget", proposal: "p1" });
};

test("a plan budget is spent with the plan.accepted entry as the cause of proposal.accepted", async () => {
  await costly({ s3: 1 });
  const accepted = f.s.entries().find((e) => e.type === "plan.accepted")!;
  await spendPlanBudget(f.s, f.sample.deps, "p1", "s3");
  expect(f.s.entries().find((e) => e.type === "proposal.accepted")!.cause).toBe(accepted.seq);
  expect(await spendPlanBudget(f.s, f.sample.deps, "p1", "s3")).toBeNull();      // the proposal is no longer open
});

test("a plan.accepted by anything but a person pays for nothing", async () => {
  plain();
  f.s.commit(() => [{ type: "plan.accepted", actor: person, payload: { plan: "plan-1", steps: ["s1", "s2", "s3", "s4"], budgets: {} } }]);
  await proposalFor();
  f.s.commit(() => [{ type: "plan.accepted", actor: agent, payload: { plan: "plan-1", steps: ["s1", "s2", "s3", "s4"], budgets: { s3: 1 } } }]);
  expect(await spendPlanBudget(f.s, f.sample.deps, "p1", "s3")).toBeNull();
  expect(f.s.state.proposals.p1!.status).toBe("open");
});

test("a budget for a step that was not accepted pays for nothing", async () => {
  plain();
  f.s.commit(() => [{ type: "plan.accepted", actor: person, payload: { plan: "plan-1", steps: ["s1", "s2", "s3", "s4"], budgets: {} } }]);
  await proposalFor();
  f.s.commit(() => [{ type: "plan.accepted", actor: person, payload: { plan: "plan-1", steps: ["s1", "s2"], budgets: { s3: 1 } } }]);
  expect(await spendPlanBudget(f.s, f.sample.deps, "p1", "s3")).toBeNull();
  expect(f.s.state.proposals.p1!.status).toBe("open");
});

test("a proposal for another step is not paid with this step's budget", async () => {
  plain();
  f.s.commit(() => [{ type: "plan.accepted", actor: person, payload: { plan: "plan-1", steps: ["s1", "s2", "s3", "s4"], budgets: { s1: 1, s3: 1 } } }]);
  await proposalFor();
  expect(await spendPlanBudget(f.s, f.sample.deps, "p1", "s1")).toBeNull();
  expect(f.s.state.proposals.p1!.status).toBe("open");
});
