import { canonical } from "../core/canonical";
import type { Json } from "../core/canonical";
import { Refused } from "../core/refused";
import type { Schema } from "../core/schema";
import type { Observable } from "../core/types";
import { beginPlaybook, runPlaybook } from "../modules/playbook-run";
import type { PlaybookStart } from "../modules/playbook-run";
import { defineCommand } from "./commands";
import { whyOf, windowOf } from "./seek";

const str: Schema = { type: "string" };
const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({ type: "object", properties, required, additionalProperties: false });
const windowSchema: Schema = obj({ from: { type: ["string", "null"] }, to: { type: ["string", "null"] } });

defineCommand("run_playbook", {
  args: obj({
    playbook: str, inputs: { type: "array", items: obj({ type: str, value: str }), minItems: 1 }, window: windowSchema, why: str, subgoal: str,
  }, ["playbook", "inputs", "window", "why"]),
  then: "nothing",
  perform: ({ hub, session, deps, actor, case: caseId }, a) => {
    // everything that can be checked from the record and the registry is checked here, in the queue; the sources are asked afterwards
    const why = whyOf(a);
    const id = a.playbook as string;
    const playbook = deps.runner.registry.playbook(id);
    if (playbook === null) throw new Refused(`unknown playbook: ${id.slice(0, 40)}`);
    const inputs = (a.inputs as { type: string; value: string }[]).map((o): Observable => ({ type: o.type, value: o.value }));
    const window = windowOf(a.window as Json);
    const sorted = [...inputs].sort((x, y) => (x.type < y.type ? -1 : x.type > y.type ? 1 : 0));
    const key = `${caseId}:playbook:${id}:${canonical(sorted as unknown as Json)}:${window.from}:${window.to}`;
    if (hub.running.has(key)) throw new Refused("this playbook is already running on this value");
    const start: PlaybookStart = { playbook, inputs, window, why, actor, ...(a.subgoal === undefined ? {} : { subgoal: a.subgoal as string }) };
    const job = beginPlaybook(session, deps.runner, start);   // refuses, writing nothing, if the inputs or window do not fit
    hub.running.add(key);
    hub.background(runPlaybook(session, deps.runner, job, start).then(() => undefined, () => undefined).finally(() => hub.running.delete(key)));
  },
});
