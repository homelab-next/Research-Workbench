import { subgoalAnswered } from "../../core/state";
import type { CaseState } from "../../core/state";
import type { Cost, PlanStep } from "../../core/types";
import type { Open } from "../app";
import { tag } from "../chips";
import { AT_GATE } from "../ui";
import { cardChip } from "../chips";
import type { Child } from "../dom";
import { clear } from "../dom";
import { timeEl } from "../time";
import type { Ui, View } from "../ui";

const PLAN_WORDS = { none: "no plan", proposed: "proposed", accepted: "accepted", denied: "denied", replanning: "re-planning" } as const;
const STEP_WORDS = { pending: "waiting to run", running: "running", answered: "answered", empty: "empty", partial: "partial", blocked: "blocked", failed: "failed" } as const;

const cost = (c: Cost): string => `${c.amount} ${c.unit}`;
/** A budget as typed: a number above zero, else null. */
export function budgetOf(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const joinWords = (ids: string[]): string => (ids.length <= 1 ? (ids[0] ?? "") : `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}`);

/** A question the person answers in a line before something is sent: its text lives in `texts` so a repaint never loses it. */
interface Ask { key: string; label: string; confirm: string; action: string; send(text: string): Promise<boolean> }

/** The Steps lens (guide §7): the plan, the gate and its buttons, and the costly queries waiting for a budget. Everything shown comes from the fold. */
export function makeSteps(ui: Ui, open: Open, arg: string | null = null): View {
  const { h } = ui;
  const { store, nav } = open;
  const el = h("div", { class: "lens lens-steps", name: "Steps" });

  // what the person has typed or chosen; kept across repaints, dropped when the plan changes
  const unchecked = new Set<string>();
  const budgets = new Map<string, string>();
  const texts = new Map<string, string>();
  let asking: string | null = null;
  let planId: string | null = null;
  let focusAsk = false;
  let focusedAtGate = false;
  // a one-shot: the person asked to be taken to the gate (Shift+Enter, the brief's button, the command bar), from where focus was then
  let armed = arg === AT_GATE;
  const armedFrom = armed ? ui.doc.activeElement : null;
  let last: unknown[] | null = null;
  let acceptBtn: HTMLButtonElement | null = null;
  let freeBtn: HTMLButtonElement | null = null;

  const state = (): CaseState => store.shown;
  const ro = (): boolean => store.at !== null;
  const atGate = (s: CaseState): boolean => s.plan.status === "proposed" && s.plan.current !== null && s.run.waiting === "plan";
  const pivotTitle = (id: string): string => ui.ref.pivots.find((p) => p.id === id)?.title ?? id;
  const sourceView = (id: string) => ui.ref.sources.find((x) => x.id === id);
  const sourceTitle = (id: string): string => sourceView(id)?.title ?? id;
  /** The figure on record for a step: the person's asked-for estimate, else the plan's own. */
  const estimateOf = (s: CaseState, step: PlanStep): Cost | null => (Object.hasOwn(s.plan.estimates, step.id) ? s.plan.estimates[step.id]! : step.estimate);
  const unitOf = (s: CaseState, step: PlanStep): string => estimateOf(s, step)?.unit ?? sourceView(step.source)?.cost.unit ?? "units";
  /** Whether an estimate query for the step is running: read from the queries the stream has brought, not from a flag of this screen. */
  const estimating = (s: CaseState, id: string): boolean => Object.values(s.queries).some((q) => q.purpose === "estimate" && q.step === id && q.status === "running");
  const canPrice = (step: PlanStep): boolean => !step.free && step.from.value !== "";

  // ---------- the buttons at the gate, kept in step with what is typed ----------
  const missing = (s: CaseState): string[] =>
    (s.plan.current?.steps ?? []).filter((x) => !x.free && !unchecked.has(x.id) && budgetOf(budgets.get(x.id) ?? "") === null).map((x) => x.id);
  const syncButtons = (): void => {
    const s = state();
    const plan = s.plan.current;
    if (plan === null || acceptBtn === null) return;
    const chosen = plan.steps.filter((x) => !unchecked.has(x.id));
    const lacking = missing(s);
    acceptBtn.textContent = `Accept: run ${chosen.length} steps`;
    acceptBtn.disabled = ro() || chosen.length === 0 || lacking.length > 0;
    acceptBtn.title = ro() ? "Return to live to change the case"
      : chosen.length === 0 ? "Choose at least one step, or deny the plan"
        : lacking.length > 0 ? `${joinWords(lacking)} ${lacking.length === 1 ? "needs" : "need"} a budget` : "Accept the chosen steps with the budgets given";
  };

  const accept = (s: CaseState): void => {
    const plan = s.plan.current!;
    const steps = plan.steps.filter((x) => !unchecked.has(x.id));
    const given: Record<string, number> = {};
    for (const x of steps) if (!x.free) given[x.id] = budgetOf(budgets.get(x.id) ?? "")!;
    void ui.act("accept_plan", { plan: plan.id, steps: steps.map((x) => x.id), budgets: given });
  };

  // ---------- one line a person answers before something is sent ----------
  const askLine = (a: Ask): HTMLElement => {
    const box = h("input", {
      type: "text", class: "ask-text", name: a.label, value: texts.get(a.key) ?? "",
      on: {
        input: (e) => { texts.set(a.key, (e.target as HTMLInputElement).value); confirm.disabled = ro() || (texts.get(a.key) ?? "").trim() === ""; },
        keydown: (e) => {
          const k = e as KeyboardEvent;
          if (k.key === "Escape") { k.stopPropagation(); cancel(); }
          else if (k.key === "Enter" && !confirm.disabled) go();
        },
      },
    }) as HTMLInputElement;
    const go = (): void => {
      const text = (texts.get(a.key) ?? "").trim();
      if (text === "") return;
      void a.send(text).then((ok) => { if (ok) { texts.delete(a.key); if (asking === a.key) asking = null; render(); } });
    };
    const cancel = (): void => { texts.delete(a.key); if (asking === a.key) asking = null; render(); };
    const confirm = h("button", { type: "button", class: "primary", data: { action: a.action }, disabled: ro() || (texts.get(a.key) ?? "").trim() === "", on: { click: go } }, a.confirm) as HTMLButtonElement;
    return h("div", { class: "ask" }, box, confirm, h("button", { type: "button", data: { action: "cancel-ask" }, on: { click: cancel } }, "Cancel"));
  };

  // ---------- the plan ----------
  const stepRow = (s: CaseState, step: PlanStep, gate: boolean): HTMLElement => {
    const est = estimateOf(s, step);
    const accepted = s.plan.status === "accepted";
    const left = accepted && !s.plan.accepted_steps.includes(step.id);
    const run = Object.hasOwn(s.plan.steps, step.id) ? s.plan.steps[step.id]! : null;
    const kids: Child[] = [];
    if (gate) {
      kids.push(h("input", {
        type: "checkbox", checked: !unchecked.has(step.id), disabled: ro(), name: `Run ${step.id}: ${pivotTitle(step.pivot)}`,
        on: { change: (e) => { if ((e.target as HTMLInputElement).checked) unchecked.delete(step.id); else unchecked.add(step.id); syncButtons(); } },
      }));
    }
    kids.push(h("span", { class: "step-id" }, step.id), h("span", { class: "pivot" }, pivotTitle(step.pivot)), h("span", { class: "source" }, sourceTitle(step.source)));
    kids.push(h("span", { class: "from" }, step.from.value === "" ? "from an earlier step" : `from ${step.from.type} ${step.from.value}`));
    if (step.free) kids.push(tag(ui, "done", "free"));
    else {
      kids.push(tag(ui, "attention", "costly"));
      if (est !== null) kids.push(h("span", { class: "estimate", title: "The price the source gave, as recorded" }, cost(est)));
      else if (!canPrice(step)) kids.push(h("span", { class: "estimate-note" }, "can be priced after the earlier step has run"));
      else if (gate) {
        kids.push(h("button", {
          type: "button", data: { action: "estimate" }, disabled: ro() || estimating(s, step.id), title: "Ask the source what this step would cost; nothing else runs",
          on: { click: () => { void ui.act("estimate_step", { step: step.id }); } },
        }, estimating(s, step.id) ? "Estimating…" : "Estimate"));
      }
      if (Object.hasOwn(s.plan.estimates, step.id) && est === null) kids.push(h("span", { class: "estimate-note" }, "no estimate could be given"));
      if (gate) {
        kids.push(h("input", {
          type: "text", class: "budget", name: `Budget for ${step.id}, in ${unitOf(s, step)}`, placeholder: "Budget", value: budgets.get(step.id) ?? "", disabled: ro(),
          on: { input: (e) => { budgets.set(step.id, (e.target as HTMLInputElement).value); syncButtons(); } },
        }));
      } else if (accepted && Object.hasOwn(s.plan.budgets, step.id)) kids.push(h("span", { class: "budget-given" }, `budget ${s.plan.budgets[step.id]} ${unitOf(s, step)}`));
    }
    if (step.needs_window) kids.push(tag(ui, "human", "needs a window"));
    kids.push(h("span", { class: "empty-means" }, step.empty_means === "proven-negative" ? "if empty: proven negative" : "if empty: not seen"));
    for (const w of step.warnings) kids.push(h("span", { class: "warning tag tag-attention" }, w));
    if (left) kids.push(h("span", { class: "step-status" }, "not accepted"));
    else if (accepted && run !== null) {
      kids.push(h("span", { class: "step-status", title: run.note }, STEP_WORDS[run.status]));
      for (const c of run.cards) kids.push(cardChip(ui, c, (card) => nav.focusCard(card)));
    }
    return h("div", { class: `step${left ? " muted" : ""}`, data: { step: step.id } }, kids);
  };

  const planView = (s: CaseState): HTMLElement => {
    const plan = s.plan.current!;
    const gate = atGate(s);
    const steps = plan.steps;
    const free = steps.filter((x) => x.free).length;
    const known = new Map<string, number>();
    for (const x of steps) {
      const e = x.free ? null : estimateOf(s, x);
      if (e !== null) known.set(e.unit, (known.get(e.unit) ?? 0) + e.amount);
    }
    const total = known.size === 0 ? "no estimate yet" : `estimate so far: ${[...known].map(([unit, amount]) => `${amount} ${unit}`).join(", ")}`;
    const win = plan.window;
    const part = (ts: string | null, none: string): Child => (ts === null ? none : timeEl(ui, ts, "local"));
    const head = h("div", { class: "plan-head" },
      h("p", { class: "goal" }, plan.goal),
      h("p", { class: "window" }, "Window: ", part(win.from, "no start"), " to ", part(win.to, "no end")),
      h("p", { class: "counts" }, `${free} free steps · ${steps.length - free} costly steps`),
      h("p", { class: "estimate-total" }, total),
      gate ? null : h("p", { class: "plan-state" }, PLAN_WORDS[s.plan.status]));
    const goals = plan.subgoals.map((g) => {
      const answered = subgoalAnswered(s, g);
      return h("section", { class: "subgoal", data: { subgoal: g.id } },
        h("h3", null, g.title), h("p", { class: "question" }, g.question),
        h("span", { class: `goal-state tag ${answered ? "tag-done" : "tag-attention"}` }, answered ? "answered" : "open"),
        h("div", { class: "steps" }, g.steps.flatMap((id) => { const x = steps.find((y) => y.id === id); return x === undefined ? [] : [stepRow(s, x, gate)]; })));
    });
    const out: Child[] = [head, goals];
    if (gate) {
      const chosen = steps.filter((x) => !unchecked.has(x.id));
      acceptBtn = h("button", { type: "button", class: "primary", data: { action: "accept_plan" }, on: { click: () => accept(state()) } }, `Accept: run ${chosen.length} steps`) as HTMLButtonElement;
      freeBtn = h("button", {
        type: "button", data: { action: "free" }, disabled: ro() || free === 0, title: "Accept only the steps that cost nothing",
        on: { click: () => { void ui.act("accept_plan", { plan: plan.id, steps: steps.filter((x) => x.free).map((x) => x.id) }); } },
      }, `Run the free steps now (${free})`) as HTMLButtonElement;
      const decide = (key: "deny" | "replan", label: string, tip: string): HTMLElement =>
        h("button", { type: "button", data: { action: key }, disabled: ro(), title: tip, on: { click: () => { asking = key; focusAsk = true; render(); } } }, label);
      out.push(h("div", { class: "gate-buttons" }, freeBtn, acceptBtn, decide("deny", "Deny", "Deny the plan and end the run"), decide("replan", "Re-plan", "Ask for a different plan")));
      if (asking === "deny") out.push(askLine({ key: "deny", label: "Reason for denying the plan", confirm: "Deny the plan", action: "confirm-deny", send: (reason) => ui.act("deny_plan", { reason }) }));
      if (asking === "replan") out.push(askLine({ key: "replan", label: "Note for the new plan", confirm: "Re-plan with this note", action: "confirm-replan", send: (note) => ui.act("replan", { note }) }));
      syncButtons();
    } else { acceptBtn = null; freeBtn = null; }
    return h("div", { class: `plan${s.plan.status === "accepted" ? "" : " proposed"}` }, out);
  };

  // ---------- costly queries an agent asked for ----------
  const waiting = (s: CaseState): HTMLElement | null => {
    const open = Object.values(s.proposals).filter((p) => p.kind === "costly_query" && p.status === "open"
      && !(s.plan.status === "accepted" && p.step !== null && Object.hasOwn(s.plan.budgets, p.step)));
    // A proposal that was accepted and whose query has not finished reads as running. The query is the one its acceptance caused (the cause on the
    // entries), not one with matching text: the text on the screen is what the source was sent, not what the proposal stored.
    const entries = store.entries.slice(0, s.seq);
    const underway = Object.values(s.proposals).filter((p) => {
      if (p.kind !== "costly_query" || p.status !== "accepted") return false;
      const accepted = entries.find((e) => e.type === "proposal.accepted" && e.payload.proposal === p.id);
      if (accepted === undefined) return false;
      const issued = entries.find((e) => e.type === "query.issued" && e.cause === accepted.seq);
      if (issued === undefined || issued.type !== "query.issued") return true;
      return Object.hasOwn(s.queries, issued.payload.query) && s.queries[issued.payload.query]!.status === "running";
    });
    if (open.length === 0 && underway.length === 0) return null;
    return h("section", { class: "waiting-budget" }, h("h3", null, "Waiting for a budget"), underway.map((p) =>
      h("div", { class: "proposal", data: { proposal: p.id, running: "true" } }, h("span", { class: "title" }, p.title), " ", h("span", { class: "tag tag-attention" }, "running…"))), open.map((p) => {
      if (p.kind !== "costly_query") return h("div");
      const unit = p.estimate?.unit ?? sourceView(p.source)?.cost.unit ?? "units";
      const key = `budget:${p.id}`;
      const n = budgetOf(budgets.get(key) ?? "");
      const run = h("button", {
        type: "button", class: "primary", data: { action: "run-proposal" }, disabled: ro() || n === null,
        title: "Run this query, spending no more than the budget",
        on: { click: () => { const v = budgetOf(budgets.get(key) ?? ""); if (v !== null) void ui.act("run_proposal", { proposal: p.id, budget: v }); } },
      }, n === null ? "Run: enter a budget" : `Run: spend up to ${n} ${unit}`) as HTMLButtonElement;
      const box = h("input", {
        type: "text", class: "budget", name: `Budget for ${p.id}, in ${unit}`, placeholder: "Budget", value: budgets.get(key) ?? "", disabled: ro(),
        on: { input: (e) => {
          budgets.set(key, (e.target as HTMLInputElement).value);
          const v = budgetOf(budgets.get(key)!);
          run.disabled = ro() || v === null;
          run.textContent = v === null ? "Run: enter a budget" : `Run: spend up to ${v} ${unit}`;
        } },
      });
      return h("div", { class: "proposal proposed", data: { proposal: p.id } },
        h("span", { class: "title" }, p.title), " ", tag(ui, "agent", `proposed by ${p.by}`),
        h("p", { class: "why" }, `the agent's own account: ${p.why}`),
        h("span", { class: "estimate" }, p.estimate === null ? "no estimate" : cost(p.estimate)),
        box, run,
        asking === `reject:${p.id}`
          ? askLine({ key: `reject:${p.id}`, label: `Reason for rejecting ${p.id}`, confirm: "Reject the proposal", action: "confirm-reject", send: (reason) => ui.act("reject_proposal", { proposal: p.id, reason }) })
          : h("button", { type: "button", data: { action: "reject-proposal" }, disabled: ro(), on: { click: () => { asking = `reject:${p.id}`; focusAsk = true; render(); } } }, "Reject"));
    }));
  };

  // ---------- painting ----------
  const keyOf = (n: Element | null): string | null =>
    n === null ? null : [n.tagName, n.getAttribute("aria-label") ?? "", n.getAttribute("data-action") ?? "", n.closest("[data-step]")?.getAttribute("data-step") ?? "", n.closest("[data-proposal]")?.getAttribute("data-proposal") ?? ""].join("|");

  const render = (): void => {
    const s = state();
    const plan = s.plan.current;
    if ((plan?.id ?? null) !== planId) { planId = plan?.id ?? null; unchecked.clear(); budgets.clear(); texts.clear(); asking = null; focusedAtGate = false; }
    const sig = [plan, s.plan.status, s.plan.estimates, s.plan.steps, s.plan.accepted_steps, s.plan.budgets, s.run.waiting, s.cards, s.proposals, s.queries, store.at, asking, ui.ref];
    if (last !== null && sig.length === last.length && sig.every((x, i) => x === last![i])) return;
    last = sig;
    const active = keyOf(el.contains(ui.doc.activeElement) ? ui.doc.activeElement : null);
    clear(el);
    el.appendChild(plan === null || s.plan.status === "none" ? h("p", { class: "empty" }, "No plan yet.") : planView(s));
    const w = waiting(s);
    if (w !== null) el.appendChild(w);
    if (focusAsk) {
      focusAsk = false;
      (el.querySelector(".ask-text") as HTMLElement | null)?.focus();
    } else if (active !== null) {
      const again = [...el.querySelectorAll("input, button")].find((n) => keyOf(n) === active) as HTMLElement | undefined;
      again?.focus();
    }
    if (!focusedAtGate && atGate(s) && el.isConnected && !ro()) {
      focusedAtGate = true;
      // a gate that arrives while the person is elsewhere does not take their focus: only one asked for, or focus on the page or in this lens
      const at = ui.doc.activeElement;
      const asked = armed && at === armedFrom;
      armed = false;
      if (!(asked || at === null || at === ui.doc.body || el.contains(at))) return;
      // the Accept button when it can be pressed; else the first field that still needs a budget
      const need = el.querySelector("[data-action=accept_plan]:not([disabled])") as HTMLElement | null
        ?? [...el.querySelectorAll<HTMLInputElement>(".step input.budget")].find((i) => budgetOf(i.value) === null)
        ?? (el.querySelector("[data-action=free]:not([disabled])") as HTMLElement | null);
      need?.focus();
    }
  };

  return { el, update: render };
}
