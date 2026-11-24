import type { Json } from "../core/canonical";
import { Refused } from "../core/refused";
import { validate } from "../core/schema";
import { latestDraft } from "../core/state";
import type { Schema } from "../core/schema";
import type { CaseSession } from "../core/session";
import { MARKINGS } from "../core/types";
import type { Actor, Marking, ModelChoice, Product } from "../core/types";
import { THEN_ADVANCE } from "../pipeline/contract";
import type { EngineCommand } from "../pipeline/contract";
import type { Engine } from "../pipeline/engine";
import type { EngineDeps } from "../pipeline/engine";
import type { CaseHub } from "./hub";
import { addLane, discardCard, keepCard, moveCard, pinCard, removeLane, renameLane, restoreCard, sendBackCard, setTarget, undo } from "./triage";
import { modelsFor } from "./views";

export interface CommandContext { hub: CaseHub; case: string; session: CaseSession; engine: Engine; deps: EngineDeps; actor: Extract<Actor, { kind: "human" }> }
export interface CommandDef {
  /** JSON Schema (src/core/schema.ts) for the args object; additionalProperties is always false. */
  args: Schema;
  /** Whether the server calls engine.advance() in the background once perform has returned. */
  then: "advance" | "nothing";
  /** Slow checks, made before the case's queue is entered so nothing slow ever holds it. What it returns is perform's third argument; a Refused it throws refuses the command. */
  prepare?(ctx: { case: string; session: CaseSession; deps: EngineDeps }, args: Record<string, Json>): Promise<unknown>;
  perform(ctx: CommandContext, args: Record<string, Json>, prepared: unknown): void | Promise<void>;
}

export const COMMANDS: Record<string, CommandDef> = Object.create(null) as Record<string, CommandDef>;

/** Later tasks add their commands here, in their own files, and import those files from app.ts. A name defined twice throws. */
export function defineCommand(name: string, def: CommandDef): void {
  if (Object.hasOwn(COMMANDS, name)) throw new Error(`command ${name} is defined twice`);
  if (def.args.additionalProperties !== false) throw new Error(`command ${name}: args must set additionalProperties to false`);
  COMMANDS[name] = def;
}

/** A setting the case or the registry does not allow. */
export class SettingRefused extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "SettingRefused";
  }
}

// ---------- schema helpers ----------
const str: Schema = { type: "string" };
const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({ type: "object", properties, required, additionalProperties: false });
const NONE = obj({});
const markings: unknown[] = [...MARKINGS, null];
const then = (command: EngineCommand): "advance" | "nothing" => (THEN_ADVANCE[command] ? "advance" : "nothing");
const text = (a: Record<string, Json>, key: string): string => a[key] as string;

// ---------- the run and its gates ----------
defineCommand("start_run", { args: NONE, then: then("start"), perform: ({ engine, actor }) => { engine.start(actor); } });
defineCommand("pause", { args: NONE, then: then("pause"), perform: ({ engine, actor }) => { engine.pause(actor); } });
defineCommand("resume", {
  args: NONE, then: then("resume"),
  // resume drives by itself; the promise is the hub's to track
  perform: ({ hub, engine, actor }) => { hub.background(engine.resume(actor)); },
});
defineCommand("stop", { args: obj({ reason: str }), then: then("stop"), perform: ({ engine, actor }, a) => { engine.stop(actor, text(a, "reason")); } });
defineCommand("accept_plan", {
  args: obj({ plan: str, steps: { type: "array", items: str }, budgets: { type: "object", additionalProperties: { type: "number" } } }, ["plan"]),
  then: then("acceptPlan"),
  perform: ({ engine, session, actor }, a) => {
    // the plan the person saw: a plan proposed since is not the one they accepted
    if (session.state.plan.current !== null && session.state.plan.current.id !== a.plan) throw new SettingRefused("a newer plan arrived; review it before accepting");
    engine.acceptPlan({
      actor,
      ...(a.steps === undefined ? {} : { steps: a.steps as string[] }),
      ...(a.budgets === undefined ? {} : { budgets: a.budgets as Record<string, number> }),
    });
  },
});
defineCommand("deny_plan", { args: obj({ reason: str }), then: then("denyPlan"), perform: ({ engine, actor }, a) => { engine.denyPlan({ actor, reason: text(a, "reason") }); } });
defineCommand("replan", { args: obj({ note: str }), then: then("replan"), perform: ({ engine, actor }, a) => { engine.replan({ actor, note: text(a, "note") }); } });
defineCommand("revise", {
  args: obj({ product: { type: "object" }, reason: str }), then: then("revise"),
  perform: ({ engine, actor }, a) => { engine.revise({ actor, product: a.product as unknown as Product, reason: text(a, "reason") }); },
});
defineCommand("answer_challenge", {
  args: obj({ challenge: str, answer: str, action: { enum: ["revised", "rebutted"] } }), then: then("answerChallenge"),
  perform: ({ engine, session, actor }, a) => {
    const id = text(a, "challenge");
    const { state } = session;
    const c = Object.hasOwn(state.challenges, id) ? state.challenges[id]! : null;
    if (c !== null && c.run !== state.run.id) throw new SettingRefused(`challenge ${id} is from an earlier run`);
    engine.answerChallenge(actor, id, text(a, "answer"), a.action as "revised" | "rebutted");
  },
});
defineCommand("approve", {
  args: obj({ draft_hash: str }), then: then("approve"),
  perform: ({ engine, session, actor }, a) => {
    // the draft the person saw: a newer one is not what they approved
    if (latestDraft(session.state) !== null && latestDraft(session.state)!.hash !== a.draft_hash) throw new SettingRefused("a newer draft arrived; review it before approving");
    engine.approve({ actor });
  },
});
defineCommand("reject", {
  args: obj({ reason: str, stop: { type: "boolean" } }), then: then("reject"),
  perform: ({ engine, actor }, a) => { engine.reject({ actor, reason: text(a, "reason"), stop: a.stop as boolean }); },
});
defineCommand("feedback", {
  args: obj({ measure: str, value: { type: ["number", "string"] }, note: str }), then: then("feedback"),
  perform: ({ engine, actor }, a) => { engine.feedback({ actor, measure: text(a, "measure"), value: a.value as number | string, note: text(a, "note") }); },
});

// ---------- settings ----------
defineCommand("set_model", {
  args: obj({ stage: str, provider: str, model: str, effort: { type: ["string", "null"] } }), then: then("setModel"),
  async prepare({ session, deps }, a): Promise<ModelChoice> {
    const stage = text(a, "stage");
    if (stage !== "agent" && !deps.pipeline.stages.some((s) => s.id === stage)) throw new SettingRefused(`there is no stage ${stage}`);
    const marking: Marking = session.state.meta?.marking ?? "TLP:RED";
    let slow = false;
    const view = (await modelsFor(deps, marking, () => { slow = true; })).find((m) => m.provider === a.provider && m.model === a.model);
    if (view === undefined) throw new SettingRefused(slow ? "the model list could not be read" : `no provider lists the model ${text(a, "model")} for ${text(a, "provider")}`);
    const effort = a.effort as string | null;
    if (effort !== null && !view.efforts.includes(effort)) throw new SettingRefused(`the model ${view.model} has no effort ${effort}`);
    if (!view.allowed) throw new SettingRefused(view.reason ?? `${marking} may not go to this model`);
    return { provider: view.provider, model: view.model, effort };
  },
  perform: ({ engine, actor }, a, choice) => { engine.setModel(text(a, "stage"), choice as ModelChoice, actor); },
});
defineCommand("set_budget", {
  args: obj({ tokens: { type: ["integer", "null"], minimum: 1 } }), then: then("setBudget"),
  perform: ({ engine, actor }, a) => { engine.setBudget(a.tokens as number | null, actor); },
});
defineCommand("set_pack_limit", {
  args: obj({ stage: str, max_marking: { enum: markings } }), then: then("setPackLimit"),
  perform: ({ engine, deps, actor }, a) => {
    const stage = text(a, "stage");
    if (stage !== "agent" && !deps.pipeline.stages.some((s) => s.id === stage)) throw new SettingRefused(`there is no stage ${stage}`);
    engine.setPackLimit(stage, a.max_marking as Marking | null, actor);
  },
});

// ---------- triage ----------
const card = obj({ card: str });
const index: Schema = { type: "integer", minimum: 0 };
const triage = (name: string, args: Schema, perform: (ctx: CommandContext, a: Record<string, Json>) => void): void => defineCommand(name, { args, then: "nothing", perform });
triage("keep", obj({ card: str, lane: str, index: { type: ["integer", "null"], minimum: 0 } }, ["card"]), ({ session, actor }, a) => {
  keepCard(session, actor, { card: text(a, "card"), ...(a.lane === undefined ? {} : { lane: text(a, "lane") }), ...(a.index === undefined ? {} : { index: a.index as number | null }) });
});
triage("move", obj({ card: str, lane: str, index }), ({ session, actor }, a) => { moveCard(session, actor, { card: text(a, "card"), lane: text(a, "lane"), index: a.index as number }); });
triage("discard", card, ({ session, actor }, a) => { discardCard(session, actor, text(a, "card")); });
triage("restore", card, ({ session, actor }, a) => { restoreCard(session, actor, text(a, "card")); });
triage("send_back", card, ({ session, actor }, a) => { sendBackCard(session, actor, text(a, "card")); });
triage("pin", obj({ card: str, pinned: { type: "boolean" } }), ({ session, actor }, a) => { pinCard(session, actor, text(a, "card"), a.pinned as boolean); });
triage("add_lane", obj({ title: str }), ({ session, actor }, a) => { addLane(session, actor, text(a, "title")); });
triage("rename_lane", obj({ lane: str, title: str }), ({ session, actor }, a) => { renameLane(session, actor, text(a, "lane"), text(a, "title")); });
triage("remove_lane", obj({ lane: str }), ({ session, actor }, a) => { removeLane(session, actor, text(a, "lane")); });
triage("set_target", obj({ lane: str }), ({ session, actor }, a) => { setTarget(session, actor, text(a, "lane")); });
triage("undo", obj({ target: { type: "integer", minimum: 0 } }, []), ({ session, actor }, a) => { undo(session, actor, a.target === undefined ? undefined : (a.target as number)); });

/** Why `args` is not what the command takes: one line per violation, empty when it is valid. */
export function argProblems(def: CommandDef, args: unknown): string[] {
  return validate(def.args, args).map((e) => `${e.path === "$" ? "args" : `args${e.path.slice(1)}`}: ${e.message}`);
}
