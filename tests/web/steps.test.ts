import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

test("a proposal a budget did not cover says what the source now estimates, and can still be run", async () => {
  await atGate();
  const r = await runPivot(p.s.app.hub.read("CASE-1"), p.s.app.hub.deps.runner, { pivot: "address_to_verdict", value: "198.51.100.77", window: state().plan.current!.window, why: "w", actor: agent });
  if (r.status !== "needs_budget" || r.proposal === null || r.estimate === null) throw new Error("no proposal");
  const id = r.proposal;
  await p.settle();
  const amount = 900;
  const budget = 100;
  p.s.app.hub.read("CASE-1").commit(() => [{ type: "proposal.repriced", actor: { kind: "human", id: "analyst" }, cause: null, payload: { proposal: id, estimate: { amount, unit: r.estimate!.unit }, budget, query: null } }]);
  await p.settle();
  expect(state().proposals[id]).toMatchObject({ status: "open", refused_budget: budget });
  const row = p.q(`[data-proposal=${id}]`);
  expect(row.textContent).toContain(`The source now estimates ${amount} ${r.estimate.unit}; a budget of ${budget} did not cover it. Nothing ran.`);
  expect(row.querySelector("[data-action=run-proposal]")).not.toBeNull();
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

test("the plan gate arriving while Steps is open does not take focus from the Command field", async () => {
  p = await page();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("s");                                   // Steps open before the run
  await p.settle();
  const bar = p.q("[aria-label=Command]") as HTMLInputElement;
  bar.focus();
  await p.s.toPlanGate(id);
  await settled();
  expect(p.q("[data-step=s3]")).not.toBeNull();
  expect(p.doc.activeElement).toBe(bar);
});

test("with an all-free plan, a Space or Enter typed elsewhere does not accept it", async () => {
  p = await page({ before: (root) => {
    const f = join(root, "scripts", "sample-run.yaml");
    const y = readFileSync(f, "utf8");
    const cut = y.replace(/"route": \["address_to_asset", "asset_to_accounts"\]\},\n[\s\S]*?"route": \["address_to_verdict"\]\}/, '"route": ["address_to_asset", "asset_to_accounts"]}');
    if (cut === y) throw new Error("script not changed");
    writeFileSync(f, cut);
  } });
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("s");
  await p.settle();
  const bar = p.q("[aria-label=Command]") as HTMLInputElement;
  bar.focus();
  await p.s.command(id, "start_run");
  await settled(); await settled();
  expect(state().run.waiting).toBe("plan");
  expect(state().plan.current!.steps.every((x) => x.free)).toBe(true);
  expect(accept().disabled).toBe(false);
  const a = p.doc.activeElement as HTMLElement;
  expect(a).toBe(bar);
  a.click();                                      // what a browser does with Space or Enter on the focused element
  await settled();
  expect(types().filter((t) => t === "plan.accepted" || t === "gate.passed")).toEqual([]);
});

test("'accept plan' typed before there is a plan does not arm the gate that arrives later", async () => {
  p = await page({ before: (root) => {
    const f = join(root, "scripts", "sample-run.yaml");
    const y = readFileSync(f, "utf8");
    const cut = y.replace(/"route": \["address_to_asset", "asset_to_accounts"\]\},\n[\s\S]*?"route": \["address_to_verdict"\]\}/, '"route": ["address_to_asset", "asset_to_accounts"]}');
    if (cut === y) throw new Error("script not changed");
    writeFileSync(f, cut);
  } });
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  const bar = p.q("[aria-label=Command]") as HTMLInputElement;
  bar.focus();
  p.fill(bar, "accept plan");
  p.press("Enter");
  await p.settle();
  bar.focus();
  p.fill(bar, "what do we kn");
  await p.s.command(id, "start_run");
  await settled(); await settled();
  expect(state().run.waiting).toBe("plan");
  expect(accept().disabled).toBe(false);
  const a = p.doc.activeElement as HTMLElement;
  expect(a).toBe(bar);
  a.click();
  await settled();
  expect(types().filter((t) => t === "plan.accepted" || t === "gate.passed")).toEqual([]);
});

test("Shift+Enter from a column takes the person to the plan gate's control", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  const column = p.q("[data-area=incoming]");
  column.focus();
  expect(p.doc.activeElement).toBe(column);
  p.press("Enter", { shift: true });
  await settled();
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

test("a proposal whose query is running reads running…, found by its cause and not by its text", async () => {
  await atGate();
  let open = () => {};
  const gate = new Promise<void>((r) => { open = r; });
  const pool = p.s.app.hub.deps.runner.pool;
  const real = pool.for.bind(pool);
  (pool as { for: unknown }).for = (src: never) => {
    const c = real(src) as unknown as Record<string, unknown>;
    return new Proxy(c, { get(t, k) {
      const v = t[k as string];
      if (k === "run") return async (...a: unknown[]) => { await gate; return (v as (...x: unknown[]) => unknown).apply(t, a); };
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    } });
  };
  const r = await runPivot(p.s.app.hub.read("CASE-1"), p.s.app.hub.deps.runner, { pivot: "address_to_verdict", value: "198.51.100.77", window: state().plan.current!.window, why: "w", actor: agent });
  if (r.status !== "needs_budget" || r.proposal === null) throw new Error("no proposal");
  await p.settle();
  p.fill("[data-proposal] input", "50");
  p.click("[data-action=run-proposal]");
  while (!types().includes("query.issued") || Object.values(state().queries).every((q) => q.purpose !== "result")) await Bun.sleep(10);
  await Bun.sleep(50);   // the hub is not idle while the query is held, so settle would wait for it
  const row = p.q(`[data-proposal=${r.proposal}]`);
  expect(row.textContent).toContain("running…");
  expect(row.dataset.running).toBe("true");
  open();
  await settled();
  expect(p.all(`[data-proposal=${r.proposal}]`).length).toBe(0);
});

test("Accept and Run the free steps carry the id of the plan on screen", async () => {
  await atGate();
  const log: { command: string; args: Record<string, unknown> }[] = [];
  const real = p.ui.api.command.bind(p.ui.api);
  p.ui.api.command = (id, name, args) => { log.push({ command: name, args }); return real(id, name, args); };
  p.click("[data-action=free]");
  await settled();
  expect(log.filter((c) => c.command === "accept_plan").map((c) => c.args.plan)).toEqual([state().plan.current!.id]);
});
