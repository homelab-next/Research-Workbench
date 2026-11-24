import type { Json } from "../core/canonical";
import { Refused } from "../core/refused";
import type { Schema } from "../core/schema";
import { runProposal } from "../modules/proposals";
import { checkEstimate, estimateStep } from "../pipeline/plans";
import { defineCommand } from "./commands";

const obj = (properties: Record<string, Schema>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const text = (a: Record<string, Json>, key: string): string => a[key] as string;

// None of these moves the run, so none asks for an advance. Each one waits for its own work: what a source answered is in the ledger when it returns.

/** Work that waits on a source runs here, outside the case's queue, so a slow source never holds `stop` or anything else. A refusal found late (the plan was decided, the proposal closed) writes nothing; anything else goes to the hub's error report. */
const later = (hub: { background(work: Promise<unknown>): void }, work: Promise<unknown>): void => {
  hub.background(work.catch((error: unknown) => { if (!(error instanceof Refused)) throw error; }));
};

defineCommand("estimate_step", {
  args: obj({ step: { type: "string" } }), then: "nothing",
  perform: ({ hub, session, deps, actor }, a) => {
    // everything that can be checked from the record is checked here, in the queue; the source is asked afterwards
    checkEstimate(session, { step: text(a, "step"), actor });
    later(hub, estimateStep(session, deps.runner, { step: text(a, "step"), actor }));
  },
});

defineCommand("run_proposal", {
  args: obj({ proposal: { type: "string" }, budget: { type: "number" } }), then: "nothing",
  perform: ({ hub, case: caseId, session, deps, actor }, a) => {
    const running = hub.running;
    const id = text(a, "proposal");
    const p = Object.hasOwn(session.state.proposals, id) ? session.state.proposals[id]! : null;
    if (p === null) throw new Refused(`unknown proposal: ${id}`);
    if (p.kind !== "costly_query") throw new Refused(`proposal ${id} is not a costly query`);
    if (p.status !== "open") throw new Refused(`proposal ${id} is ${p.status}, not open`);
    const budget = a.budget as number;
    if (!Number.isFinite(budget) || budget <= 0) throw new Refused("the budget must be a number above zero");
    if (p.estimate !== null && p.estimate.amount > budget) throw new Refused(`the estimate is ${p.estimate.amount} ${p.estimate.unit}; the budget does not cover it`);
    const key = `${caseId}:${id}`;
    if (running.has(key)) throw new Refused(`proposal ${id} is already being run`);
    running.add(key);
    // what the case looked like at the click: if the run ends or pauses, or the plan is decided or replaced, before the query is priced, nothing is accepted
    const { run, plan } = session.state;
    const run0 = run.id, plan0 = plan.current?.id ?? null;
    const moved = (): string | null => {
      const now = session.state;
      if (now.run.id !== run0) return "the run changed while the query was being priced";
      if (run0 !== null && (now.run.status === "finished" || now.run.status === "paused")) return `the run is ${now.run.status}`;
      if ((now.plan.current?.id ?? null) !== plan0 || (plan0 !== null && (now.plan.status === "denied" || now.plan.status === "replanning"))) return "the plan was decided while the query was being priced";
      return null;
    };
    // The runner prices it, runs it if the budget covers the estimate, and writes its own entries as they happen. A budget that does not cover the
    // estimate runs nothing and leaves the proposal open: the screen shows that from the entries.
    later(hub, runProposal(session, deps.runner, { proposal: id, budget, actor, guard: moved }).finally(() => { running.delete(key); }));
  },
});

defineCommand("reject_proposal", {
  args: obj({ proposal: { type: "string" }, reason: { type: "string" } }), then: "nothing",
  perform: ({ session, actor }, a) => {
    const id = text(a, "proposal");
    const p = Object.hasOwn(session.state.proposals, id) ? session.state.proposals[id]! : null;
    if (p === null) throw new Refused(`unknown proposal: ${id}`);
    if (p.status !== "open") throw new Refused(`proposal ${id} is ${p.status}, not open`);
    const run = session.state.run.id;
    session.commit(() => [{ type: "proposal.rejected", actor, ...(run === null ? {} : { run }), payload: { proposal: id, reason: text(a, "reason") } }]);
  },
});
