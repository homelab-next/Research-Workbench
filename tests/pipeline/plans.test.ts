import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import { stepPins } from "../../src/modules/pins";
import { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import { DEFAULT_LIMITS } from "../../src/modules/seeker";
import { acceptPlan, buildPlan, denyPlan, estimateStep, PlanRefused, PROBE_ACTOR, probeAcceptPlan, requestReplan, spendPlanBudget } from "../../src/pipeline/plans";
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
const STAGE = { id: "plan", title: "Plan", phase: null, runs: "agent" as const, gate: "plan" as const, reviews: false, model: null };
const system = { kind: "system" as const, id: "engine" };
/** A run whose plan stage is waiting at the plan gate. */
const startRun = (): void => {
  f.s.commit((_st, ids) => [{ type: "run.started", actor: person, payload: { run: ids.next("run"), pipeline: "default", pipeline_hash: "h", stages: [STAGE] } }]);
  f.s.commit((st) => [{ type: "gate.waiting", actor: system, run: st.run.id, payload: { gate: "plan" } }]);
};
const propose = (o: PlanOutput = out, withRun = true): Plan => {
  if (withRun && f.s.state.run.status === "none") startRun();
  const built = buildPlan("", o, deps(), frame, null);
  if ("errors" in built) throw new Error(built.errors.join("; "));
  f.s.commit((_st, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: buildPlan(ids.next("plan"), o, deps(), frame, null) as Plan } }]);
  return f.s.state.plan.current!;
};
/** A new proposal of the same plan in which s3 starts from an earlier step. */
const startRun2 = (plan: Plan): void => {
  f.s.commit((_st, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: { ...plan, id: ids.next("plan"), steps: plan.steps.map((x) => (x.id === "s3" ? { ...x, from: { ...x.from, value: "" } } : x)) } } }]);
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
  expect(added.map((e) => e.seq)).toEqual([before + 1, before + 2, before + 3, before + 4]);
  expect(added.every((e) => e.run === f.s.state.run.id)).toBe(true);
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
  refused(() => acceptPlan(f.s, { actor: person, budgets: { s3: -5 } }));
  refused(() => acceptPlan(f.s, { actor: person, budgets: { s3: Number.NaN } }));
  refused(() => acceptPlan(f.s, { actor: person, budgets: { s3: Number.POSITIVE_INFINITY } }));
  refused(() => acceptPlan(f.s, { actor: person, steps: ["s1"], budgets: { s3: 5 } }));
  refused(() => acceptPlan(f.s, { actor: person, steps: ["s9"] }));
  expect(f.s.state.plan.status).toBe("proposed");
});

test("an agent or the system cannot accept a plan", () => {
  propose();
  refused(() => acceptPlan(f.s, { actor: agent }));
  refused(() => acceptPlan(f.s, { actor: { kind: "system", id: "engine" } }));
  refused(() => denyPlan(f.s, { actor: agent, reason: "no" }, () => {}));
  refused(() => requestReplan(f.s, { actor: agent, note: "no" }));
});

test("a plan that was not proposed cannot be accepted, denied or re-planned", () => {
  refused(() => acceptPlan(f.s, { actor: person }));
  refused(() => denyPlan(f.s, { actor: person, reason: "no" }, () => {}));
  refused(() => requestReplan(f.s, { actor: person, note: "again" }));
  propose();
  acceptPlan(f.s, { actor: person });
  refused(() => acceptPlan(f.s, { actor: person }));
});

test("denying the plan stops the run", () => {
  propose();
  const before = count();
  denyPlan(f.s, { actor: person, reason: "wrong question" }, () => {});
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
  startRun();
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

test("the plan commands refuse unless the run is waiting at the plan gate", () => {
  propose(out, false);                                   // a plan with no run at all
  refused(() => acceptPlan(f.s, { actor: person }));
  refused(() => denyPlan(f.s, { actor: person, reason: "x" }, () => {}));
  refused(() => requestReplan(f.s, { actor: person, note: "x" }));
  f.s.commit((_st, ids) => [{ type: "run.started", actor: person, payload: { run: ids.next("run"), pipeline: "default", pipeline_hash: "h", stages: [STAGE] } }]);
  refused(() => acceptPlan(f.s, { actor: person }));      // mid-stage: not yet at the gate
  f.s.commit((st) => [{ type: "gate.waiting", actor: system, run: st.run.id, payload: { gate: "plan" } }]);
  f.s.commit((st) => [{ type: "run.paused", actor: person, run: st.run.id, payload: { reason: "p" } }]);
  acceptPlan(f.s, { actor: person });                     // a paused run waiting at the gate may be decided
  expect(f.s.state.plan.status).toBe("accepted");
});

test("a finished run refuses the plan commands", () => {
  propose();
  f.s.commit((st) => [{ type: "run.finished", actor: system, run: st.run.id, payload: { outcome: "stopped" } }]);
  refused(() => acceptPlan(f.s, { actor: person }));
  refused(() => requestReplan(f.s, { actor: person, note: "x" }));
});

test("an empty step selection is refused", () => {
  propose();
  refused(() => acceptPlan(f.s, { actor: person, steps: [] }));
});

test("denying the plan anchors through the callback it is given", () => {
  propose();
  let anchored = 0;
  denyPlan(f.s, { actor: person, reason: "no" }, () => { anchored++; });
  expect(anchored).toBe(1);
});

test("a re-accepted plan reuses the lanes of sub-goals it already has", () => {
  propose();
  acceptPlan(f.s, { actor: person });
  expect(f.s.state.lanes).toHaveLength(2);
  // research sent the run back to plan; a new plan with the same sub-goal ids is proposed and accepted
  f.s.commit((st) => [{ type: "gate.waiting", actor: system, run: st.run.id, payload: { gate: "plan" } }]);
  f.s.commit((_st, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: buildPlan(ids.next("plan"), out, deps(), frame, null) as Plan } }]);
  acceptPlan(f.s, { actor: person });
  expect(f.s.state.lanes.map((l) => l.subgoal)).toEqual(["g1", "g2"]);
  expect(f.s.entries().filter((e) => e.type === "lane.created")).toHaveLength(2);
});

test("a plan output that is not in the required shape is an error, not a throw", () => {
  for (const bad of [null, {}, { goal: "g" }, { goal: "g", subgoals: [{}] }, { goal: "g", subgoals: [{ title: "t", question: "q", have: "x", want: "w", route: [] }] }]) {
    const r = buildPlan("", bad as unknown as PlanOutput, deps(), frame, null);
    expect("errors" in r && r.errors.length > 0).toBe(true);
  }
});

test("a costly step paid under one plan is paid again under the next plan that budgets it", async () => {
  await costly({ s3: 1 });
  expect((await spendPlanBudget(f.s, f.sample.deps, "p1", "s3"))?.status).toBe("done");
  // Research sent the work back to Plan; the planner proposes again and the person budgets s3 once more
  f.s.commit((st) => [{ type: "gate.waiting", actor: system, run: st.run.id, payload: { gate: "plan" } }]);
  f.s.commit((_st, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: PLAN(ids.next("plan")) } }]);
  acceptPlan(f.s, { actor: person, budgets: { s3: 2 } });
  const second = f.s.entries().findLast((e) => e.type === "plan.accepted")!;
  // the first answer would be reused (same pivot, value and window); a person discarded it, so the step must run and be paid again
  const firstCard = Object.values(f.s.state.queries).find((q) => q.purpose === "result")!.card!;
  f.s.commit(() => [{ type: "card.discarded", actor: person, payload: { card: firstCard } }]);
  const r = await f.call("run_step", { step: "s3", why: "reputation again" });
  expect(r.view).toMatchObject({ status: "needs_budget", proposal: "p2" });
  expect((await spendPlanBudget(f.s, f.sample.deps, "p2", "s3"))?.status).toBe("done");
  const paid = f.s.entries().filter((e) => e.type === "proposal.accepted");
  expect(paid.map((e) => [e.payload.proposal, e.cause])).toEqual([["p1", f.s.entries().find((e) => e.type === "plan.accepted")!.seq], ["p2", second.seq]]);
  // and still only once under that plan
  const p2 = f.s.state.proposals.p2!;
  f.s.commit((_st, ids) => [{ type: "proposal.created", actor: agent, payload: { proposal: { ...p2, id: ids.next("proposal"), status: "open" } as never } }]);
  expect(await spendPlanBudget(f.s, f.sample.deps, "p3", "s3")).toBeNull();
});

test("a costly step answered under one plan is reused under the next: nothing is asked for or paid", async () => {
  await costly({ s3: 1 });
  expect((await spendPlanBudget(f.s, f.sample.deps, "p1", "s3"))?.status).toBe("done");
  f.s.commit((st) => [{ type: "gate.waiting", actor: system, run: st.run.id, payload: { gate: "plan" } }]);
  f.s.commit((_st, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: PLAN(ids.next("plan")) } }]);
  acceptPlan(f.s, { actor: person, budgets: { s3: 2 } });
  const issuedBefore = f.s.entries().filter((e) => e.type === "query.issued").length;
  const r = await f.call("run_step", { step: "s3", why: "reputation again" });
  expect(r.view).toMatchObject({ status: "done", reused: { query: Object.values(f.s.state.queries).find((q) => q.purpose === "result")!.id } });
  expect(f.s.entries().filter((e) => e.type === "query.issued")).toHaveLength(issuedBefore);
  expect(Object.keys(f.s.state.proposals)).toEqual(["p1"]);
  expect(f.s.state.plan.steps.s3).toMatchObject({ status: "answered" });
});

// ---------- estimateStep ----------
test("a costly step with a starting value can be priced; the estimate is recorded and nothing else runs", async () => {
  propose();
  const before = count();
  const cardsBefore = Object.keys(f.s.state.cards).length;
  const cost = await estimateStep(f.s, f.sample.deps, { step: "s3", actor: person });
  expect(cost).toMatchObject({ unit: "lookups" });
  expect(f.s.state.plan.estimates).toEqual({ s3: cost });
  const added = f.s.entries().slice(before);
  expect(added.at(-1)!.type).toBe("step.estimated");
  expect(added.filter((e) => e.type === "query.result" && f.s.state.queries[e.payload.query]!.purpose === "result")).toEqual([]);
  expect(Object.values(f.s.state.queries).filter((q) => q.purpose === "result")).toEqual([]);
  expect(Object.keys(f.s.state.cards).length).toBe(cardsBefore);
  const e = added.at(-1)!;
  if (e.type !== "step.estimated") throw new Error("not an estimate");
  expect(e.actor).toEqual(person);
  if (e.payload.query !== null) expect(f.s.state.queries[e.payload.query]).toMatchObject({ purpose: "estimate", step: "s3" });
});

test("a free step, a step fed by an earlier step, an unknown step, an agent and an accepted plan are each refused", async () => {
  propose();
  const refusal = async (input: { step: string; actor: typeof person }, message: string): Promise<void> => {
    const before = count();
    await expect(estimateStep(f.s, f.sample.deps, input)).rejects.toThrow(message);
    await expect(estimateStep(f.s, f.sample.deps, input)).rejects.toBeInstanceOf(PlanRefused);
    expect(count()).toBe(before);
  };
  await refusal({ step: "s1", actor: person }, "step s1 is free and needs no estimate");
  await refusal({ step: "s2", actor: person }, "step s2 is free and needs no estimate");
  await refusal({ step: "s9", actor: person }, "there is no step s9");
  await refusal({ step: "s3", actor: agent as never }, "only a person may ask for an estimate");
  acceptPlan(f.s, { actor: person });
  await refusal({ step: "s3", actor: person }, "the run is not waiting at the plan gate");
});

test("a costly step that starts from an earlier step cannot be priced before that step has run", async () => {
  const plan = propose();
  startRun2(plan);
  const before = count();
  await expect(estimateStep(f.s, f.sample.deps, { step: "s3", actor: person })).rejects.toThrow("step s3 starts from what an earlier step finds; it can be priced only after that step has run");
  expect(count()).toBe(before);
});

test("a step the registry no longer prices as costly is refused with the plan's own words, and asked of nothing further", async () => {
  propose();
  const real = f.sample.deps.registry;
  const free = { ...f.sample.deps, registry: { pivot: (id: string) => { const p = real.pivot(id); return p === null ? p : { ...p, weight: 0 }; }, source: (id: string) => { const x = real.source(id); return x === null ? x : { ...x, cost: { ...x.cost, weight: 0 } }; }, rootOf: real.rootOf.bind(real) } };
  const before = count();
  await expect(estimateStep(f.s, free as never, { step: "s3", actor: person })).rejects.toThrow("this step is no longer priced as the plan says");
  expect(f.s.state.plan.estimates).toEqual({});
  expect(f.s.entries().slice(before).some((e) => e.type === "step.estimated")).toBe(false);
});

// ---------- a playbook sub-goal ----------

/** The sample playbook steps a lease lookup (an unconfirmed source), so these frames allow one unless a test says otherwise. */
const pbFrame = { window: WINDOW, limits: { ...DEFAULT_LIMITS, allow_unconfirmed: true } };
const pbOut = (over: Partial<PlanOutput["subgoals"][number]> = {}): PlanOutput => ({
  goal: "g", subgoals: [{ title: "Triage", question: "What is it?", have: [{ type: "address", value: START }], want: "asset", route: [], playbook: "address-triage", ...over }],
});
/** The sample root with one more playbook file, loaded as a fresh registry. */
const withPlaybook = (id: string, body: string) => {
  writeFileSync(join(f.sample.root, "playbooks", `${id}.yaml`), `kind: playbook\nid: ${id}\ntitle: ${id}\n${body}`);
  const registry = loadRegistry([{ path: f.sample.root, trusted: true, credentials: [] }]);
  expect(registry.playbook(id)).not.toBeNull();
  return { ...deps(), registry, runner: { ...f.sample.deps, registry } };
};

test("a playbook sub-goal becomes one free plan step that names the playbook and its hash", () => {
  const registry = f.sample.registry;
  const plan = buildPlan("plan-1", pbOut(), deps(), pbFrame, null) as Plan;
  expect(plan.steps).toEqual([expect.objectContaining({
    id: "s1", subgoal: "g1", pivot: "", source: "", to: "asset", free: true, weight: 0,
    playbook: { id: "address-triage", hash: registry.playbook("address-triage")!.hash, inputs: [{ type: "address", value: START }] },
  })]);
  expect(plan.steps[0]).toMatchObject({ from: { type: "address", value: START }, window: WINDOW, needs_window: true, estimate: null, empty_means: "proven-negative" });
  // final review M2: the gate says which unconfirmed source a playbook uses, as it does for a route step
  expect(plan.steps[0]!.warnings).toEqual(["uses the unconfirmed source leases"]);
  expect(plan.subgoals).toEqual([{ id: "g1", title: "Triage", question: "What is it?", steps: ["s1"] }]);
});

test("each way a playbook sub-goal can be wrong is refused with its reason", () => {
  const name = 'sub-goal "Triage"';
  expect(buildPlan("", pbOut({ playbook: "nope" }), deps(), pbFrame, null)).toEqual({ errors: [`${name}: there is no playbook nope`] });
  const costly = withPlaybook("rep-check", "inputs:\n  - { name: address, type: address }\nsteps:\n  - { id: asset, pivot: address_to_asset, from: input.address }\n  - { id: rep, pivot: address_to_verdict, from: input.address }\nend: [asset]\n");
  expect(buildPlan("", pbOut({ playbook: "rep-check" }), costly, pbFrame, null)).toEqual({
    errors: [`${name}: the playbook rep-check has costly lookups (address_to_verdict); a person can start it from the Pivot panel`],
  });
  expect(buildPlan("", pbOut({ have: [{ type: "domain", value: "cdn-update.example.org" }] }), deps(), pbFrame, null)).toEqual({
    errors: [`${name}: the playbook needs a address for address`],
  });
  expect(buildPlan("", pbOut({ want: "account" }), deps(), pbFrame, null)).toEqual({
    errors: [`${name}: the playbook address-triage ends on steps that find asset; a plan step needs every end step to find account`],
  });
  expect(buildPlan("", pbOut(), deps(), frame, null)).toEqual({ errors: [`${name}: the playbook address-triage uses the unconfirmed source leases`] });
  const shape = "the plan output is not in the required shape: each sub-goal needs a route of pivot ids, or a playbook and an empty route";
  expect(buildPlan("", pbOut({ route: ["address_to_asset"] }), deps(), pbFrame, null)).toEqual({ errors: [shape] });
  const neither = pbOut();
  delete neither.subgoals[0]!.playbook;
  expect(buildPlan("", neither, deps(), pbFrame, null)).toEqual({ errors: [shape] });
});

test("every step of a built plan carries pins, and a playbook step's pins change when one of its pivots changes", () => {
  const route = { title: "Reputation", question: "What is known?", have: [{ type: "address", value: START }], want: "verdict", route: ["address_to_verdict"] };
  const both: PlanOutput = { goal: "g", subgoals: [route, pbOut().subgoals[0]!] };
  const plan = buildPlan("plan-1", both, deps(), pbFrame, null) as Plan;
  expect(plan.steps).toHaveLength(2);
  for (const st of plan.steps) expect(st.pins).toMatch(/^[0-9a-f]{64}$/);
  expect(plan.steps[0]!.pins).toBe(stepPins(f.sample.registry, plan.steps[0]!)!);
  // a copy of the root with one line appended to pivots.yaml: every pivot's hash is the file's, so each changes
  const root = join(dir, "changed");
  cpSync(f.sample.root, root, { recursive: true });
  appendFileSync(join(root, "pivots.yaml"), "# changed\n");
  const changed = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
  const pb = plan.steps.find((s) => s.playbook !== undefined)!;
  expect(changed.playbook("address-triage")!.hash).toBe(pb.playbook!.hash);
  expect(stepPins(changed, pb)).not.toBe(pb.pins);
});

test("a playbook plan step checks every end step: each must find the wanted type, and empty means proven negative only when each says so", () => {
  const name = 'sub-goal "Triage"';
  const triage = readFileSync(join(f.sample.root, "playbooks", "address-triage.yaml"), "utf8").replace(/^kind: playbook\nid: address-triage\ntitle: [^\n]*\n/, "");
  const twoTypes = withPlaybook("triage-names", triage.replace("end: [asset]", "end: [asset, names]"));
  expect(buildPlan("", pbOut({ playbook: "triage-names" }), twoTypes, pbFrame, null)).toEqual({
    errors: [`${name}: the playbook triage-names ends on steps that find asset and domain; a plan step needs every end step to find asset`],
  });
  const twoAssets = withPlaybook("triage-lease", triage.replace("end: [asset]", "end: [asset, lease]"));
  const plan = buildPlan("", pbOut({ playbook: "triage-lease" }), twoAssets, pbFrame, null) as Plan;
  expect(plan.steps).toHaveLength(1);
  expect(plan.steps[0]!.empty_means).toBe("not-seen");
});

// ---------- slice 14: the one plan gate code passes ----------

/** A probe child, in a workbench of its own under `dir`, whose run waits at the plan gate with `o` proposed (or nothing proposed). */
function probeChild(o: PlanOutput | null = out): { s: import("../../src/core/session").CaseSession; close(): void } {
  const wb = Workbench.open(join(dir, "wb-probe"), { onError: () => {} });
  const link = { parent: "CASE-99", run: "run-1", stage: "probe", attempt: 1, loop: "investigation", input_hash: "a".repeat(64), depth: 1, floor: "TLP:GREEN" as const };
  const mark = { improve: "CASE-99", origin: "b".repeat(64), probe: "base/T1", candidate: "base", task: "T1", plan_gate: "accept" as const, max_lookups: 4, max_tokens: 100000 };
  const s = wb.createCase({ title: "p", asked: "a", why: "w", starting: [{ type: "address", value: START }], window: WINDOW, objective: null, marking: "TLP:GREEN" }, system, { loop: "investigation", link, probe: mark });
  s.commit((_st, ids) => [{ type: "run.started", actor: system, payload: { run: ids.next("run"), pipeline: "investigation", pipeline_hash: "h", stages: [STAGE] } }]);
  s.commit((st) => [{ type: "gate.waiting", actor: system, run: st.run.id, payload: { gate: "plan" } }]);
  if (o !== null) s.commit((st, ids) => [{ type: "plan.proposed", actor: agent, run: st.run.id, payload: { plan: buildPlan(ids.next("plan"), o, deps(), frame, null) as Plan } }]);
  return {
    s,
    close(): void {
      expect(s.state.skipped).toEqual([]);
      wb.close();
    },
  };
}

test("probeAcceptPlan accepts every free step with no budget, makes the lanes, and passes the plan gate as improve-probe; the run goes on", () => {
  const c = probeChild();
  try {
    const before = c.s.entries().length;
    expect(probeAcceptPlan(c.s)).toBe(true);
    const added = c.s.entries().slice(before);
    // the entries are plan.accepted { budgets: {} }, lane.created…, gate.passed { gate: "plan" }, each by { kind: "system", id: "improve-probe" }
    expect(added.map((e) => e.type)).toEqual(["plan.accepted", "lane.created", "gate.passed"]);
    expect(added.every((e) => e.actor.kind === "system" && e.actor.id === "improve-probe")).toBe(true);
    expect(PROBE_ACTOR).toEqual({ kind: "system", id: "improve-probe" });
    expect(added.every((e) => e.run === c.s.state.run.id)).toBe(true);
    expect(added[0]!.payload).toEqual({ plan: "plan-1", steps: ["s1", "s2"], budgets: {} });
    expect(added[1]!.payload).toMatchObject({ title: "Is it internal", subgoal: "g1" });
    expect(added[2]!.payload).toEqual({ gate: "plan" });
    expect(c.s.state.plan.status).toBe("accepted");
    expect(c.s.state.plan.accepted_steps).toEqual(["s1", "s2"]);
    expect(c.s.state.lanes.map((l) => l.subgoal)).toEqual(["g1"]);
    expect(c.s.state.run.waiting).toBeNull();
    expect(c.s.state.run.status).not.toBe("finished");
    // a second call has no plan waiting to accept
    expect(() => probeAcceptPlan(c.s)).toThrow(PlanRefused);
  } finally {
    c.close();
  }
});

test("a costly step is left out of the acceptance, and spendPlanBudget gives it nothing", async () => {
  const c = probeChild();
  try {
    probeAcceptPlan(c.s);
    const plan = c.s.state.plan.current!;
    const costlyStep = plan.steps.find((x) => !x.free)!;
    expect(costlyStep.id).toBe("s3");
    expect(c.s.state.plan.accepted_steps).not.toContain("s3");
    // a costly_query proposal for that step, as the researcher's run_step would raise it, is never paid for by the acceptance
    c.s.commit((st, ids) => [{ type: "proposal.created", actor: agent, run: st.run.id, payload: { proposal: {
      id: ids.next("proposal"), kind: "costly_query", title: "reputation", by: agent.id, step: "s3", subgoal: "g2", source: costlyStep.source, pivot: costlyStep.pivot,
      pivot_hash: null, source_hash: "h", text: "reputation", bound: { value: START }, window: WINDOW, estimate: null, why: "reputation",
    } } }]);
    expect(c.s.state.proposals.p1!.status).toBe("open");
    expect(await spendPlanBudget(c.s, f.sample.deps, "p1", "s3")).toBeNull();
    expect(c.s.state.proposals.p1!.status).toBe("open");
    expect(c.s.entries().some((e) => e.type === "proposal.accepted" || e.type === "query.issued")).toBe(false);
  } finally {
    c.close();
  }
});

test("a plan with no free step is not accepted: probeAcceptPlan is false and nothing is written", () => {
  const c = probeChild(sub({ title: "Reputation", have: [{ type: "address", value: START }], want: "verdict", route: ["address_to_verdict"] }));
  try {
    expect(c.s.state.plan.current!.steps.every((x) => !x.free)).toBe(true);
    const before = c.s.entries().length;
    expect(probeAcceptPlan(c.s)).toBe(false);
    expect(c.s.entries().length).toBe(before);
    expect(c.s.state.plan.status).toBe("proposed");
    expect(c.s.state.run.waiting).toBe("plan");
  } finally {
    c.close();
  }
});

test("probeAcceptPlan in a case that is not a probe child throws and writes nothing", () => {
  propose();
  const sentence = "only a probe child whose improve loop says so has its plan accepted by code";
  refused(() => probeAcceptPlan(f.s));
  expect(() => probeAcceptPlan(f.s)).toThrow(sentence);
  expect(f.s.state.plan.status).toBe("proposed");
  // in a probe child, the plan must be one waiting at the gate
  const c = probeChild(null);
  try {
    const before = c.s.entries().length;
    expect(() => probeAcceptPlan(c.s)).toThrow("there is no proposed plan");
    expect(c.s.entries().length).toBe(before);
  } finally {
    c.close();
  }
});

test("acceptPlan by improve-probe is refused as any actor but a person is", () => {
  propose();
  refused(() => acceptPlan(f.s, { actor: PROBE_ACTOR }));
  refused(() => denyPlan(f.s, { actor: PROBE_ACTOR, reason: "no" }, () => {}));
  refused(() => requestReplan(f.s, { actor: PROBE_ACTOR, note: "no" }));
  // and in a probe child too: code passes its plan gate only through probeAcceptPlan
  const c = probeChild();
  try {
    const before = c.s.entries().length;
    expect(() => acceptPlan(c.s, { actor: PROBE_ACTOR })).toThrow(PlanRefused);
    expect(() => denyPlan(c.s, { actor: PROBE_ACTOR, reason: "no" }, () => {})).toThrow(PlanRefused);
    expect(() => requestReplan(c.s, { actor: PROBE_ACTOR, note: "no" })).toThrow(PlanRefused);
    expect(c.s.entries().length).toBe(before);
  } finally {
    c.close();
  }
});
