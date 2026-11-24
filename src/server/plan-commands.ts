import type { Json } from "../core/canonical";
import { Refused } from "../core/refused";
import type { Schema } from "../core/schema";
import { runProposal } from "../modules/proposals";
import { estimateStep } from "../pipeline/plans";
import { defineCommand } from "./commands";

const obj = (properties: Record<string, Schema>): Schema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const text = (a: Record<string, Json>, key: string): string => a[key] as string;

// None of these moves the run, so none asks for an advance. Each one waits for its own work: what a source answered is in the ledger when it returns.

defineCommand("estimate_step", {
  args: obj({ step: { type: "string" } }), then: "nothing",
  perform: async ({ session, deps, actor }, a) => { await estimateStep(session, deps.runner, { step: text(a, "step"), actor }); },
});

defineCommand("run_proposal", {
  args: obj({ proposal: { type: "string" }, budget: { type: "number" } }), then: "nothing",
  perform: async ({ session, deps, actor }, a) => {
    const result = await runProposal(session, deps.runner, { proposal: text(a, "proposal"), budget: a.budget as number, actor });
    if (result.status === "refused") throw new Refused(result.reasons.join("; "), result.reasons);
    if (result.status === "needs_budget") {
      throw new Refused(result.estimate === null ? "this query needs a budget" : `the estimate is ${result.estimate.amount} ${result.estimate.unit}; the budget does not cover it`);
    }
    // done and failed are both done: the outcome is in the ledger
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
