// The improve loop's routes and case commands (slice 14). The two routes are in app.ts's route table behind the same guard (Host, Origin, JSON)
// and role check as every other; the four case commands go through COMMANDS as every case command does. The server names the actor, so no body
// may; every refusal is JSON.
import { isPlainObject } from "../core/canonical";
import { Refused } from "../core/refused";
import type { Schema } from "../core/schema";
import { MARKINGS, isMarking } from "../core/types";
import type { Actor, ExpectedFinding, Marking } from "../core/types";
import type { Workbench } from "../core/workbench";
import type { NewImproveInput } from "../core/wire";
import type { EngineDeps } from "../pipeline/engine";
import { answerScale, setKnownAnswer, withdrawKnownAnswer } from "../pipeline/improve/answers";
import { defineCommand, thenAfter } from "./commands";
import type { CommandContext } from "./commands";
import type { BuilderContext } from "./builder";
import type { CaseHub } from "./hub";
import { adoptDecide, createImprove, improveView } from "./improve";
import type { Reading } from "./roles";

export interface ImproveRouteDeps {
  wb: Workbench; hub: CaseHub; deps: EngineDeps; human: () => Extract<Actor, { kind: "human" }>;
  /** A reason as the person may see it. */
  shown: (text: string) => string;
  /** The value of every secret the workbench holds. */
  secrets: () => readonly string[];
}
/** What a handler is given, as app.ts gives it. */
export interface ImproveCall { req: Request; url: URL; params: string[]; body(): Promise<unknown> }
export interface ImproveRoute {
  method: "GET" | "POST"; path: RegExp; needs: { read: Reading } | { command: string }; kind: "api";
  handle(call: ImproveCall): Response | Promise<Response>;
}

const json = (status: number, body: unknown): Response => Response.json(body, { status });
const refused = (status: number, ...reasons: string[]): Response => json(status, { ok: false, refused: reasons });
const FIELDS = ["loop", "case_type", "tasks", "candidates", "marking"];

/** A new improve request from a body that is a NewImproveInput and nothing else, or why it is refused. */
function improveInputOf(body: unknown): NewImproveInput | string {
  if (!isPlainObject(body)) return "the body must be a JSON object";
  if (Object.hasOwn(body, "actor")) return "the server names the actor";
  const extra = Object.keys(body).find((k) => !FIELDS.includes(k));
  if (extra !== undefined) return `the body has a field it should not have: ${extra.slice(0, 40)}`;
  const { loop, case_type, tasks, candidates, marking } = body;
  if (typeof loop !== "string") return "loop must be a loop's id";
  if (typeof case_type !== "string") return "case_type must be a case type's id";
  if (typeof tasks !== "number" || !Number.isInteger(tasks)) return "tasks must be a whole number";
  if (typeof candidates !== "number" || !Number.isInteger(candidates)) return "candidates must be a whole number";
  if (!isMarking(marking)) return `unknown marking ${JSON.stringify(typeof marking === "string" ? marking.slice(0, 40) : null)}`;
  return { loop, case_type, tasks, candidates, marking };
}

/** The routes of the improve loop, for app.ts's table. */
export function improveRoutes(d: ImproveRouteDeps): ImproveRoute[] {
  return [
    {
      method: "POST", path: /^\/api\/improve$/, needs: { command: "create_improve" }, kind: "api",
      handle: async ({ body }) => {
        const input = improveInputOf(await body());
        if (typeof input === "string") return refused(400, input);
        try {
          return json(200, createImprove({ hub: d.hub, deps: d.deps, wb: d.wb }, input, d.human()));
        } catch (error) {
          if (error instanceof Refused) return refused(409, ...error.reasons.map(d.shown));
          throw error;
        }
      },
    },
    {
      method: "GET", path: /^\/api\/cases\/([^/]+)\/improve$/, needs: { read: "improve" }, kind: "api",
      handle: async ({ params }) => {
        const id = params[0]!;
        const session = d.hub.read(id);
        return json(200, await improveView(session, d.hub.depsFor(id), { secrets: d.secrets() }));
      },
    },
    {
      // the likelihood terms a known answer of this case is checked against: its own loop's standard's, as set_known_answer checks them
      method: "GET", path: /^\/api\/cases\/([^/]+)\/answer-scale$/, needs: { read: "improve" }, kind: "api",
      handle: ({ params }) => json(200, { likelihood: [...(answerScale(d.hub.depsFor(params[0]!)) ?? [])] }),
    },
  ];
}

// ---------- the case commands ----------

const str: Schema = { type: "string" };
const finding: Schema = {
  type: "object", additionalProperties: false, required: ["claim", "likelihood", "confidence"],
  properties: { claim: str, likelihood: str, confidence: { enum: ["low", "moderate", "high"] }, asks: { type: "boolean" } },
};
const product: Schema = { type: "integer", minimum: 1 };

/** The builder context of a case command: the case's session and bound deps, the person the server names, the workbench, its reload and secrets. */
const builderCtx = (ctx: CommandContext): BuilderContext => ({ session: ctx.session, deps: ctx.deps, hub: ctx.hub, actor: ctx.actor, reload: ctx.reload, wb: ctx.wb, secrets: ctx.secrets });

defineCommand("set_known_answer", {
  args: {
    type: "object", additionalProperties: false, required: ["product", "text", "findings", "marking"],
    properties: { product, text: str, findings: { type: "array", items: finding }, marking: { enum: [...MARKINGS] } },
  },
  then: thenAfter("setKnownAnswer"),
  perform: ({ session, deps, actor }, a) => {
    setKnownAnswer(session, deps, { product: a.product as number, text: a.text as string, findings: a.findings as unknown as ExpectedFinding[], marking: a.marking as Marking, actor }, answerScale(deps));
  },
});

defineCommand("withdraw_known_answer", {
  args: { type: "object", additionalProperties: false, required: ["product", "reason"], properties: { product, reason: str } },
  then: thenAfter("withdrawKnownAnswer"),
  perform: ({ session, deps, actor }, a) => { withdrawKnownAnswer(session, deps, { product: a.product as number, reason: a.reason as string, actor }); },
});

// Ruling: a candidate is adopted all or nothing, so the person accepts or rejects the whole chosen change; both pass the gate, and the run goes on
defineCommand("adopt_decide", {
  args: { type: "object", additionalProperties: false, required: ["change", "accept"], properties: { change: str, accept: { type: "boolean" } } },
  then: thenAfter("adoptDecide"),
  perform: (ctx, a) => { adoptDecide(builderCtx(ctx), a.change as string, a.accept as boolean); },
});
