// The loop builder's routes (slice 12, part B): builder sessions beside the Loops page. Each is in app.ts's route table behind the same guard
// (Host, Origin, JSON) and role check as every other; the server names the actor, so no body may. Every refusal is JSON.
import { isPlainObject } from "../core/canonical";
import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import { isMarking } from "../core/types";
import type { Actor } from "../core/types";
import { BUILD_ID, CaseNotFoundError } from "../core/workbench";
import type { Workbench } from "../core/workbench";
import type { Config } from "../modules/config";
import type { EngineDeps } from "../pipeline/engine";
import { builderAsk, builderDecide, builderModel, builderProbe, builderView, choiceFrom } from "./builder";
import type { BuilderContext } from "./builder";
import { blobResponse } from "./evidence";
import type { CaseHub } from "./hub";
import type { Reading } from "./roles";
import { entryStream } from "./stream";

export interface BuilderRouteDeps {
  config: Config; wb: Workbench; hub: CaseHub; deps: EngineDeps; human: () => Extract<Actor, { kind: "human" }>;
  /** A reason as the person may see it. */
  shown: (text: string) => string;
  /** Loads the roots again in place (compose's reload) after an accept; returns the new problems. */
  reload: () => string[];
  /** The value of every secret the workbench holds. */
  secrets: () => readonly string[];
  /** Keeps an open entry stream so the app can end it when it closes; returns what forgets it. */
  track: (close: (why?: "unloaded") => void) => () => void;
}

/** What a handler is given, as app.ts gives it. */
export interface BuilderCall { req: Request; url: URL; params: string[]; body(): Promise<unknown> }
export interface BuilderRoute {
  method: "GET" | "POST"; path: RegExp; needs: { read: Reading } | { command: string }; kind: "api" | "download";
  handle(call: BuilderCall): Response | Promise<Response>;
}

const json = (status: number, body: unknown): Response => Response.json(body, { status });
const refused = (status: number, ...reasons: string[]): Response => json(status, { ok: false, refused: reasons });

/** The body as an object with only the given fields, or why it is refused. */
function fieldsOf(body: unknown, allowed: string[]): Record<string, unknown> | string {
  if (!isPlainObject(body)) return "the body must be a JSON object";
  if (Object.hasOwn(body, "actor")) return "the server names the actor";
  const extra = Object.keys(body).find((k) => !allowed.includes(k));
  if (extra !== undefined) return `the body has a field it should not have: ${extra.slice(0, 40)}`;
  return body;
}

/** The routes of the loop builder, for app.ts's table. */
export function builderRoutes(d: BuilderRouteDeps): BuilderRoute[] {
  /** The builder session a path names, or the refusal. */
  const sessionOf = (raw: string): CaseSession | Response => {
    let id: string;
    try { id = decodeURIComponent(raw); } catch { return refused(404, "there is no such builder session"); }
    if (!BUILD_ID.test(id)) return refused(404, "there is no such builder session");
    try {
      return d.wb.builder(id);
    } catch (error) {
      if (error instanceof CaseNotFoundError) return refused(404, `there is no builder session ${id}`);
      throw error;
    }
  };
  const ctxOf = (session: CaseSession): BuilderContext => ({ session, deps: d.deps, hub: d.hub, actor: d.human(), reload: d.reload, wb: d.wb, secrets: d.secrets });
  /** A builder act, one at a time per session; a refusal is 409 with its reasons, and the answer names the head it left. */
  const act = async (session: CaseSession, work: (ctx: BuilderContext) => Promise<void> | void, seqOf?: () => number): Promise<Response> => {
    try {
      await d.hub.serial(session.state.meta!.id, () => work(ctxOf(session)));
      return json(200, { ok: true, seq: seqOf?.() ?? session.head().seq });
    } catch (error) {
      if (error instanceof Refused) return refused(409, ...error.reasons.map(d.shown));
      throw error;
    }
  };
  const withSession = (raw: string, then: (s: CaseSession) => Response | Promise<Response>): Response | Promise<Response> => {
    const s = sessionOf(raw);
    return s instanceof Response ? s : then(s);
  };

  return [
    { method: "GET", path: /^\/api\/builders$/, needs: { read: "builders" }, kind: "api", handle: () => json(200, d.wb.listBuilders()) },
    {
      method: "POST", path: /^\/api\/builders$/, needs: { command: "create_builder" }, kind: "api",
      handle: async ({ body }) => {
        const fields = fieldsOf(await body(), ["loop", "marking"]);
        if (typeof fields === "string") return refused(400, fields);
        const loop = fields.loop;
        if (!(loop === null || typeof loop === "string")) return refused(400, "loop is a loop's id, or null for a new loop");
        if (typeof loop === "string" && !(d.deps.loops?.list() ?? []).some((x) => x.id === loop)) return refused(400, `there is no loop "${loop.slice(0, 64)}"`);
        if (!isMarking(fields.marking)) return refused(400, `unknown marking ${JSON.stringify(typeof fields.marking === "string" ? fields.marking.slice(0, 40) : null)}`);
        const session = d.wb.createBuilder({ loop, marking: fields.marking }, d.human());
        return json(200, { id: session.state.meta!.id });
      },
    },
    {
      method: "GET", path: /^\/api\/builders\/([^/]+)\/entries$/, needs: { read: "builders" }, kind: "api",
      handle: ({ req, url, params }) => withSession(params[0]!, (session) => {
        const given = req.headers.get("last-event-id") ?? url.searchParams.get("after");
        let after = 0;
        if (given !== null) {
          if (!/^\d{1,15}$/.test(given)) return refused(400, "after must be a whole number, zero or more");
          after = Number(given);
        }
        if (after > session.head().seq) return refused(409, "the stream position is ahead of this session; reload from 0");
        return entryStream(session, after, req.signal, (close) => d.track(close));
      }),
    },
    {
      method: "GET", path: /^\/api\/builders\/([^/]+)\/view$/, needs: { read: "builders" }, kind: "api",
      handle: ({ params }) => withSession(params[0]!, async (session) => json(200, await builderView(session, d.deps, { secrets: d.secrets() }))),
    },
    {
      method: "GET", path: /^\/api\/builders\/([^/]+)\/blobs\/([^/]+)$/, needs: { read: "builders" }, kind: "download",
      handle: ({ params }) => withSession(params[0]!, (session) => blobResponse(session, params[1]!)),
    },
    {
      method: "POST", path: /^\/api\/builders\/([^/]+)\/ask$/, needs: { command: "builder_ask" }, kind: "api",
      handle: async ({ params, body }) => {
        const fields = fieldsOf(await body(), ["text"]);
        if (typeof fields === "string") return refused(400, fields);
        if (typeof fields.text !== "string") return refused(400, "text must be text");
        const text = fields.text;
        return withSession(params[0]!, (session) => act(session, (ctx) => builderAsk(ctx, text), () => session.entries().findLast((e) => e.type === "agent.asked")?.seq ?? session.head().seq));
      },
    },
    {
      method: "POST", path: /^\/api\/builders\/([^/]+)\/decide$/, needs: { command: "builder_decide" }, kind: "api",
      handle: async ({ params, body }) => {
        const fields = fieldsOf(await body(), ["change", "file", "accept"]);
        if (typeof fields === "string") return refused(400, fields);
        const { change, file, accept } = fields;
        if (typeof change !== "string" || typeof file !== "number" || !Number.isInteger(file) || typeof accept !== "boolean") return refused(400, "a decision names a change, a file's index and whether it is accepted");
        return withSession(params[0]!, (session) => act(session, (ctx) => builderDecide(ctx, change, file, accept)));
      },
    },
    {
      method: "POST", path: /^\/api\/builders\/([^/]+)\/probe$/, needs: { command: "builder_probe" }, kind: "api",
      handle: async ({ params, body }) => {
        const fields = fieldsOf(await body(), ["probe", "approve", "budget"]);
        if (typeof fields === "string") return refused(400, fields);
        const { probe, approve } = fields;
        const budget = fields.budget ?? null;
        if (typeof probe !== "string" || typeof approve !== "boolean") return refused(400, "a decision names a probe and whether it is approved");
        if (!(budget === null || (typeof budget === "number" && Number.isFinite(budget) && budget > 0))) return refused(400, "a budget is a number above zero, or null");
        return withSession(params[0]!, (session) => act(session, (ctx) => builderProbe(ctx, probe, approve, budget as number | null)));
      },
    },
    {
      method: "POST", path: /^\/api\/builders\/([^/]+)\/model$/, needs: { command: "builder_model" }, kind: "api",
      handle: async ({ params, body }) => {
        const fields = fieldsOf(await body(), ["choice"]);
        if (typeof fields === "string") return refused(400, fields);
        const choice = choiceFrom(fields.choice);
        if (choice === null) return refused(400, "choice is a provider, a model and an effort (or null)");
        return withSession(params[0]!, (session) => act(session, (ctx) => builderModel(ctx, choice)));
      },
    },
  ];
}
