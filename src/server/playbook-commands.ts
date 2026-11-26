import { canonical } from "../core/canonical";
import type { Json } from "../core/canonical";
import { Refused } from "../core/refused";
import type { Schema } from "../core/schema";
import type { Observable } from "../core/types";
import { belongsPlaybook } from "../modules/belongs";
import { beginPlaybook, runPlaybook } from "../modules/playbook-run";
import type { PlaybookStart } from "../modules/playbook-run";
import type { PlaybookManifest } from "../modules/playbooks";
import { defineCommand } from "./commands";
import type { CommandContext } from "./commands";
import { whyOf, windowOf } from "./seek";

const str: Schema = { type: "string" };
const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({ type: "object", properties, required, additionalProperties: false });
const windowSchema: Schema = obj({ from: { type: ["string", "null"] }, to: { type: ["string", "null"] } });

/** Checks what can be checked in the queue, writes the job's first entries and starts the lookups in the background. Shared by run_playbook and check_belongs. */
function startPlaybook(ctx: CommandContext, playbook: PlaybookManifest, inputs: Observable[], a: Record<string, Json>): void {
  const { hub, session, deps, actor, case: caseId } = ctx;
  // everything that can be checked from the record and the registry is checked here, in the queue; the sources are asked afterwards
  const why = whyOf(a);
  const window = windowOf(a.window as Json);
  const sorted = [...inputs].sort((x, y) => (x.type < y.type ? -1 : x.type > y.type ? 1 : 0));
  const key = `${caseId}:playbook:${playbook.id}:${canonical(sorted as unknown as Json)}:${window.from}:${window.to}`;
  if (hub.running.has(key)) throw new Refused("this playbook is already running on this value");
  const start: PlaybookStart = { playbook, inputs, window, why, actor, ...(a.subgoal === undefined ? {} : { subgoal: a.subgoal as string }) };
  const job = beginPlaybook(session, deps.runner, start);   // refuses, writing nothing, if the inputs or window do not fit
  hub.running.add(key);
  // runPlaybook ends the job failed if it throws; the error itself goes to the hub's reporter, as a route's does
  hub.background(runPlaybook(session, deps.runner, job, start).finally(() => hub.running.delete(key)));
}

defineCommand("run_playbook", {
  args: obj({
    playbook: str, inputs: { type: "array", items: obj({ type: str, value: str }), minItems: 1 }, window: windowSchema, why: str, subgoal: str,
  }, ["playbook", "inputs", "window", "why"]),
  then: "nothing",
  perform: (ctx, a) => {
    const id = a.playbook as string;
    const playbook = ctx.deps.runner.registry.playbook(id);
    if (playbook === null) throw new Refused(`unknown playbook: ${id.slice(0, 40)}`);
    const inputs = (a.inputs as { type: string; value: string }[]).map((o): Observable => ({ type: o.type, value: o.value }));
    startPlaybook(ctx, playbook, inputs, a);
  },
});

/** "Does it belong?": the value looked up in every inventory that holds what its type points to, as a playbook made on the spot. */
defineCommand("check_belongs", {
  args: obj({ type: str, value: str, window: windowSchema, why: str }),
  then: "nothing",
  perform: (ctx, a) => {
    const type = a.type as string;
    const playbook = belongsPlaybook(ctx.deps.runner.registry, type);
    if (playbook === null) throw new Refused(`no inventory takes a ${type.slice(0, 40)}`);
    startPlaybook(ctx, playbook, [{ type, value: a.value as string }], a);
  },
});
