import type { Json } from "../core/canonical";
import { Refused } from "../core/refused";
import type { Schema } from "../core/schema";
import { latestDraft } from "../core/state";
import type { Product } from "../core/types";
import { defineCommand } from "./commands";

const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({ type: "object", properties, required, additionalProperties: false });
const text = (a: Record<string, Json>, key: string): string => a[key] as string;

/**
 * Accepting a narrative proposal is an edit (decision 9): the latest product with that section replaced, made by the person through `revise`, so it goes back
 * through checks, evaluation and challenge like any edit. A revision the engine refuses leaves the proposal open; once it is made, the proposal is recorded accepted.
 */
defineCommand("accept_proposal", {
  args: obj({ proposal: { type: "string" }, text: { type: "string" } }, ["proposal"]), then: "advance",
  perform: ({ engine, session, actor }, a) => {
    const id = text(a, "proposal");
    const p = Object.hasOwn(session.state.proposals, id) ? session.state.proposals[id]! : null;
    if (p === null) throw new Refused(`unknown proposal: ${id}`);
    if (p.kind !== "narrative") throw new Refused(`proposal ${id} is not a narrative one`);
    if (p.status !== "open") throw new Refused(`proposal ${id} is ${p.status}, not open`);
    if (p.section === "key_findings") throw new Refused("key findings are edited as findings, not as text");
    const latest = latestDraft(session.state);
    if (latest === null) throw new Refused("there is no draft yet to put this in");
    const words = a.text === undefined ? p.text : text(a, "text");
    const product: Product = { ...latest.product, [p.section]: words };
    engine.revise({ actor, product, reason: `accepted proposal ${id}` });
    const run = session.state.run.id;
    session.commit(() => [{ type: "proposal.accepted", actor, ...(run === null ? {} : { run }), payload: { proposal: id, budget: null } }]);
  },
});
