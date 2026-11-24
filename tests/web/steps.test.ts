import { afterEach, expect, test } from "bun:test";
import type { Actor, Entry, Plan } from "../../src/core/types";
import { runPivot } from "../../src/modules/pivots";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";

let p: Page;
afterEach(async () => {
  try { expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]); } finally { await p.close(); }
});

/** A page on the sample case with the run at the plan gate and the Steps lens open. */
async function atGate(): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("s");
  return p;
}
const state = () => p.s.app.hub.read("CASE-1").state;
const types = (): string[] => p.s.entries("CASE-1").map((e) => e.type);
const agent: Actor = { kind: "agent", id: "researcher-g2", stage: "research", profile: "investigation", model: "m", effort: null, where: "machine" };
/** A click sends a command that the server has not yet seen when the first settle looks, so wait twice: once for it, once for the run it starts. */
const settled = async (): Promise<void> => { await p.settle(); await p.settle(); await p.settle(); };
const accept = (): HTMLButtonElement => p.q("[data-action=accept_plan]") as HTMLButtonElement;

test("the plan is a dashed proposal with its goal, counts, sub-goals and steps", async () => {
  await atGate();
  expect(p.q(".lens .plan").classList.contains("proposed")).toBe(true);
  expect(p.q(".lens .counts").textContent).toBe("2 free steps · 1 costly steps");
  expect(p.q(".lens .goal").textContent).toBe(state().plan.current!.goal);
  expect(p.q(".lens .estimate-total").textContent).toBe("no estimate yet");
  expect(p.all(".lens .subgoal h3").map((e) => e.textContent)).toEqual(["Who is behind the traffic", "Is the address known to be bad"]);
  expect(p.all(".lens .subgoal .question").length).toBe(2);
  expect(p.all(".lens .subgoal .goal-state").map((e) => e.textContent)).toEqual(["open", "open"]);
  expect(p.all("[data-step]").map((e) => e.dataset.step)).toEqual(["s1", "s2", "s3"]);
  const s3 = p.q("[data-step=s3]");
  expect(s3.textContent).toContain("costly");
  expect(s3.textContent).toContain("from address 198.51.100.77");
  expect(s3.textContent).toContain("if empty: not seen");
  expect(p.q("[data-step=s2]").textContent).toContain("from an earlier step");
  expect(p.q("[data-step=s1]").textContent).toContain("free");
  expect(p.q("[data-step=s1]").textContent).toContain("if empty: proven negative");
  expect((p.q("[data-step=s1] input[type=checkbox]") as HTMLInputElement).checked).toBe(true);
  expect(p.q("[data-action=free]").textContent).toBe("Run the free steps now (2)");
});

test("Accept is disabled until every checked costly step has a budget, and says which", async () => {
  await atGate();
  expect(accept().disabled).toBe(true);
  expect(accept().title).toBe("s3 needs a budget");
  expect(accept().textContent).toBe("Accept: run 3 steps");
  p.fill("[aria-label='Budget for s3, in lookups']", "0");
  expect(accept().disabled).toBe(true);
  p.fill("[aria-label='Budget for s3, in lookups']", "abc");
  expect(accept().disabled).toBe(true);
  p.fill("[aria-label='Budget for s3, in lookups']", "2");
  expect(accept().disabled).toBe(false);
  // leaving the costly step out needs no budget for it
  p.fill("[aria-label='Budget for s3, in lookups']", "");
  p.click("[data-step=s3] input[type=checkbox]");
  expect(accept().disabled).toBe(false);
  expect(accept().textContent).toBe("Accept: run 2 steps");
});

test("what the person typed survives other entries arriving", async () => {
  await atGate();
  p.fill("[aria-label='Budget for s3, in lookups']", "7");
  p.click("[data-step=s1] input[type=checkbox]");
  p.s.app.hub.read("CASE-1").commit(() => [{ type: "run.paused", actor: { kind: "system", id: "t" }, payload: { reason: "test" } }]);
  await p.settle();
  expect((p.q("[aria-label='Budget for s3, in lookups']") as HTMLInputElement).value).toBe("7");
  expect((p.q("[data-step=s1] input[type=checkbox]") as HTMLInputElement).checked).toBe(false);
  expect(accept().textContent).toBe("Accept: run 2 steps");
});

test("Estimate prices a costly step and the figure appears from the ledger", async () => {
  await atGate();
  expect(p.all("[data-action=estimate]").length).toBe(1);
  p.click("[data-step=s3] [data-action=estimate]");
  await settled();
  expect(p.q("[data-step=s3] .estimate").textContent).toMatch(/^\d+ lookups$/);
  expect(state().plan.estimates.s3).toMatchObject({ unit: "lookups" });
  expect(p.all("[data-action=estimate]").length).toBe(0);
  expect(p.q(".lens .estimate-total").textContent).toMatch(/^estimate so far: \d+ lookups$/);
  expect(types()).toContain("step.estimated");
});

test("a costly step fed by an earlier step has no Estimate button", async () => {
  await atGate();
  const plan = state().plan.current!;
  p.s.app.hub.read("CASE-1").commit((_s, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: { ...plan, id: ids.next("plan"), steps: plan.steps.map((x) => (x.id === "s3" ? { ...x, from: { ...x.from, value: "" } } : x)) } as Plan } }]);
  await p.settle();
  expect(p.all("[data-action=estimate]").length).toBe(0);
  expect(p.q("[data-step=s3]").textContent).toContain("from an earlier step");
  expect(p.q("[data-step=s3] .estimate-note").textContent).toBe("can be priced after the earlier step has run");
});

test("Run the free steps accepts only the free ones", async () => {
  await atGate();
  p.click("[data-action=free]");
  await settled();
  const accepted = p.s.entries("CASE-1").find((e) => e.type === "plan.accepted") as Extract<Entry, { type: "plan.accepted" }>;
  expect(accepted.payload).toMatchObject({ steps: ["s1", "s2"], budgets: {} });
  expect(p.q("[data-step=s3]").textContent).toContain("not accepted");
  expect(p.q(".lens .plan").classList.contains("proposed")).toBe(false);
  expect(p.all("[data-action=accept_plan]").length).toBe(0);
  expect(p.q(".lens .plan-state").textContent).toBe("accepted");
});

test("Accept sends the checked steps and their budgets, and the run goes on to the publish gate", async () => {
  await atGate();
  p.fill("[aria-label='Budget for s3, in lookups']", "1");
  expect(p.q("[data-action=accept_plan]").textContent).toBe("Accept: run 3 steps");
  p.click("[data-action=accept_plan]");
  await settled();
  expect(state().run.waiting).toBe("publish");
  expect(p.q(".lens .plan").classList.contains("proposed")).toBe(false);
  expect(p.all(".lane").length).toBe(2);
  const accepted = p.s.entries("CASE-1").find((e) => e.type === "plan.accepted") as Extract<Entry, { type: "plan.accepted" }>;
  expect(accepted.payload).toMatchObject({ steps: ["s1", "s2", "s3"], budgets: { s3: 1 } });
  // each step now reads its outcome, with its cards as chips
  expect(p.q("[data-step=s1]").textContent).toMatch(/answered|empty|partial/);
  expect(p.all("[data-step] .card-chip").length).toBeGreaterThan(0);
  expect(p.all(".lens .subgoal .goal-state").map((e) => e.textContent)).toContain("answered");
});

test("Deny needs a reason and ends the run", async () => {
  await atGate();
  p.click("[data-action=deny]");
  const confirm = p.q("[data-action=confirm-deny]") as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  p.fill("[aria-label='Reason for denying the plan']", "wrong question");
  expect(confirm.disabled).toBe(false);
  p.click(confirm);
  await settled();
  expect(state().plan.status).toBe("denied");
  expect(state().run).toMatchObject({ status: "finished", outcome: "stopped" });
  const denied = p.s.entries("CASE-1").find((e) => e.type === "plan.denied") as Extract<Entry, { type: "plan.denied" }>;
  expect(denied.payload.reason).toBe("wrong question");
  expect(p.q(".lens .plan-state").textContent).toBe("denied");
  expect(p.all("[data-action=deny]").length).toBe(0);
});

test("Re-plan needs a note, sends it, and a new plan from the planner replaces the old one on screen", async () => {
  await atGate();
  const first = state().plan.current!;
  p.fill("[aria-label='Budget for s3, in lookups']", "4");
  p.click("[data-action=replan]");
  const confirm = p.q("[data-action=confirm-replan]") as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  p.fill("[aria-label='Note for the new plan']", "look at the account side");
  p.click(confirm);
  await settled();
  const asked = p.s.entries("CASE-1").find((e) => e.type === "plan.replan_requested") as Extract<Entry, { type: "plan.replan_requested" }>;
  expect(asked.payload).toEqual({ plan: first.id, note: "look at the account side" });
  expect(state().plan.status).toBe("replanning");
  expect(p.q(".lens .plan-state").textContent).toBe("re-planning");
  expect(p.all("[data-action=accept_plan]").length).toBe(0);
  // the planner proposes again (the sample's script has no second plan turn, so this stands in for it)
  p.s.app.hub.read("CASE-1").commit((_s, ids) => [
    { type: "plan.proposed", actor: agent, payload: { plan: { ...first, id: ids.next("plan"), goal: "a second plan" } as Plan } },
    { type: "gate.waiting", actor: { kind: "system", id: "engine" }, run: state().run.id, payload: { gate: "plan" } },
  ]);
  await p.settle();
  expect(p.q(".lens .goal").textContent).toBe("a second plan");
  expect(p.q(".lens .plan").classList.contains("proposed")).toBe(true);
  expect(p.all("[data-action=accept_plan]").length).toBe(1);
  expect((p.q("[aria-label='Budget for s3, in lookups']") as HTMLInputElement).value).toBe("");
});

test("Cancel closes the reason box and sends nothing", async () => {
  await atGate();
  const before = p.s.entries("CASE-1").length;
  p.click("[data-action=deny]");
  p.click("[data-action=cancel-ask]");
  expect(p.all("[aria-label='Reason for denying the plan']").length).toBe(0);
  expect(p.s.entries("CASE-1").length).toBe(before);
});

test("nothing has run before acceptance", async () => {
  await atGate();
  const entries = p.s.entries("CASE-1");
  const at = entries.findIndex((e) => e.type === "plan.accepted");
  expect(at).toBe(-1);
  expect(types()).not.toContain("step.started");
  for (const q of Object.values(state().queries)) expect(!(q.purpose === "result" && q.step !== null)).toBe(true);
  p.click("[data-step=s3] [data-action=estimate]");
  await settled();
  for (const q of Object.values(state().queries)) expect(!(q.purpose === "result" && q.step !== null)).toBe(true);
  expect(types()).not.toContain("step.started");
});

test("an open costly proposal can be run with a budget or rejected with a reason", async () => {
  await atGate();
  const propose = async (why: string): Promise<string> => {
    const r = await runPivot(p.s.app.hub.read("CASE-1"), p.s.app.hub.deps.runner, { pivot: "address_to_verdict", value: "198.51.100.77", window: state().plan.current!.window, why, actor: agent });
    if (r.status !== "needs_budget" || r.proposal === null) throw new Error("no proposal");
    return r.proposal;
  };
  const first = await propose("the agent thinks it matters");
  await p.settle();
  const box = p.q(".lens .waiting-budget");
  expect(box.querySelector("h3")!.textContent).toBe("Waiting for a budget");
  const row = p.q(`[data-proposal=${first}]`);
  expect(row.textContent).toContain("proposed by researcher-g2");
  expect(row.textContent).toContain("the agent's own account: the agent thinks it matters");
  expect(row.querySelector(".estimate")!.textContent).toMatch(/^\d+ lookups$/);
  const run = row.querySelector("[data-action=run-proposal]") as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  p.fill(row.querySelector("input")!, "50");
  expect(run.textContent).toBe("Run: spend up to 50 lookups");
  p.click(run);
  await settled();
  expect(state().proposals[first]!.status).toBe("accepted");
  expect(p.all(`[data-proposal=${first}]`).length).toBe(0);

  const second = await propose("a second one");
  await p.settle();
  p.click(`[data-proposal=${second}] [data-action=reject-proposal]`);
  const confirm = p.q(`[data-proposal=${second}] [data-action=confirm-reject]`) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  p.fill(`[data-proposal=${second}] [aria-label='Reason for rejecting ${second}']`, "too dear");
  p.click(confirm);
  await settled();
  expect(state().proposals[second]).toMatchObject({ status: "rejected", reason: "too dear" });
  expect(p.all(".lens .waiting-budget").length).toBe(0);
});

test("a source's own words are shown as text", async () => {
  await atGate();
  const evil = "<img src=x onerror=alert(1)>";
  const plan = state().plan.current!;
  p.s.app.hub.read("CASE-1").commit((_s, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: { ...plan, id: ids.next("plan"), goal: evil, steps: plan.steps.map((x) => ({ ...x, warnings: [evil] })) } as Plan } }]);
  await p.settle();
  expect(p.q(".lens .goal").textContent).toContain(evil);
  expect(p.all(".lens img").length).toBe(0);
  expect(p.all("[data-step] .warning").map((e) => e.textContent)).toEqual([evil, evil, evil]);
});

test("while replaying every gate control is disabled and nothing is sent", async () => {
  await atGate();
  const store = p.store()!;
  store.goTo(store.live.seq);
  await p.settle();
  const before = p.s.entries("CASE-1").length;
  for (const sel of ["free", "deny", "replan", "accept_plan"]) expect([sel, (p.q(`[data-action=${sel}]`) as HTMLButtonElement).disabled]).toEqual([sel, true]);
  expect((p.q("[data-step=s3] [data-action=estimate]") as HTMLButtonElement).disabled).toBe(true);
  p.click("[data-action=free]");
  await settled();
  expect(p.s.entries("CASE-1").length).toBe(before);
});

test("opening Steps at the gate puts focus on a control that moves the gate forward", async () => {
  await atGate();
  // Accept is disabled until s3 has a budget, so focus goes to the field that needs one
  expect(p.doc.activeElement?.getAttribute("aria-label")).toBe("Budget for s3, in lookups");
});

test("with no plan the lens says so", async () => {
  p = await page();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("s");
  expect(p.q(".lens").textContent).toContain("No plan yet.");
});

test("a step is shown as being estimated while an estimate query for it is running, from the stream", async () => {
  await atGate();
  const sys: Actor = { kind: "system", id: "runner" };
  const hub = p.s.app.hub.read("CASE-1");
  hub.commit((_s, ids) => [{ type: "query.issued", actor: sys, payload: { query: ids.next("query"), source: "reputation", source_hash: "h", pivot: null, pivot_hash: null, connector: "http", text: "t", bound: {}, window: { from: null, to: null }, why: "estimate for plan step s3", estimate: null, step: "s3", verifies: null, purpose: "estimate" } }]);
  await p.settle();
  const b = p.q("[data-step=s3] [data-action=estimate]") as HTMLButtonElement;
  expect([b.textContent, b.disabled]).toEqual(["Estimating…", true]);
  hub.commit(() => [{ type: "query.failed", actor: sys, payload: { query: "q1", error: "down" } }]);
  await p.settle();
  expect(p.q("[data-step=s3] [data-action=estimate]").textContent).toBe("Estimate");
});
