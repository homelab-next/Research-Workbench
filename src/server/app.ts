import { isPlainObject } from "../core/canonical";
import { Refused } from "../core/refused";
import { isMarking, MARKINGS } from "../core/types";
import type { Actor, Observable } from "../core/types";
import { CaseNotFoundError } from "../core/workbench";
import type { NewCase, Workbench } from "../core/workbench";
import type { Me } from "../core/wire";
import type { Config } from "../modules/config";
import type { EngineDeps } from "../pipeline/engine";
import { MAX_BODY_BYTES, refusal, secure } from "./guard";
import { CaseHub } from "./hub";
import { mayDo, mayRead } from "./roles";
import type { Reading } from "./roles";
import { entryStream } from "./stream";
import { modelsFor, referenceOf, shown } from "./views";

export interface Assets { html: string; js: string; css: string }
export interface AppOptions {
  config: Config; wb: Workbench; deps: EngineDeps; problems: string[]; assets: Assets;
  origin: string;
  onError?: (error: unknown) => void;
}
export interface App { readonly hub: CaseHub; handle(req: Request): Promise<Response>; close(): Promise<void> }
export interface Running { port: number; origin: string; app: App; stop(): Promise<void> }

/** What a handler is given. `body` reads and parses the request's JSON, refusing more than 1 MiB as it reads. */
interface Call { req: Request; url: URL; params: string[]; body(): Promise<unknown> }
type Kind = "page" | "api";
interface Route {
  method: "GET" | "POST"; path: RegExp;
  /** What the route reads, or the command it does: the one thing the role check looks at. */
  needs: { read: Reading } | { command: string };
  kind: Kind;
  handle(call: Call): Response | Promise<Response>;
}

class BodyTooLarge extends Error {}
/** A request the server will not carry out, with its status. */
class Declined extends Error {
  constructor(readonly status: number, readonly reasons: string[]) { super(reasons[0]); }
}

const json = (status: number, body: unknown): Response => Response.json(body, { status });
const refused = (status: number, ...reasons: string[]): Response => json(status, { ok: false, refused: reasons });
const firstLine = (text: string): string => text.split("\n")[0]!.slice(0, 300);

/** The text of a request body, or BodyTooLarge once it has more than the limit. */
async function readText(req: Request): Promise<string> {
  if (req.body === null) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return new TextDecoder().decode(all);
}

const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isUtcMs = (x: unknown): x is string => typeof x === "string" && UTC_MS.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;

/** A new case from a request body, or the reasons it is refused. The server names the actor, so a body that names one is refused. */
function newCaseFrom(deps: EngineDeps, body: unknown): NewCase | string[] {
  if (!isPlainObject(body)) return ["the body must be a JSON object"];
  if (Object.hasOwn(body, "actor")) return ["the server names the actor"];
  const reasons: string[] = [];
  for (const field of ["title", "asked", "why"] as const) if (typeof body[field] !== "string") reasons.push(`${field} must be text`);
  if (!isMarking(body.marking)) reasons.push(`unknown marking ${JSON.stringify(typeof body.marking === "string" ? body.marking.slice(0, 40) : null)}`);
  const starting: Observable[] = [];
  if (!Array.isArray(body.starting)) reasons.push("starting must be a list of values");
  else {
    for (const item of body.starting) {
      if (!isPlainObject(item) || typeof item.type !== "string" || typeof item.value !== "string") { reasons.push("each starting value needs a type and a value, both text"); continue; }
      if (!deps.runner.observables.matches(item.type, item.value)) reasons.push(`"${item.value.slice(0, 80)}" is not a ${item.type.slice(0, 40)}`);
      else starting.push({ type: item.type, value: item.value });
    }
  }
  const w = body.window;
  if (!isPlainObject(w) || !isUtcMs(w.from) || !isUtcMs(w.to) || !(Date.parse(w.from) < Date.parse(w.to))) {
    reasons.push("the window must be two UTC timestamps with milliseconds, the first before the second");
  }
  const objective = body.objective;
  if (objective !== null && (typeof objective !== "string" || deps.runner.registry.get("objective", objective) === null)) reasons.push("unknown objective");
  if (reasons.length > 0) return reasons;
  const window = w as { from: string; to: string };
  return {
    title: body.title as string, asked: body.asked as string, why: body.why as string, starting, window: { from: window.from, to: window.to },
    objective: objective as string | null, marking: body.marking as NewCase["marking"],
  };
}

export function createApp(opts: AppOptions): App {
  const { config, wb, deps, assets, origin } = opts;
  const onError = opts.onError ?? ((error: unknown) => { console.error("workbench server:", error); });
  const hub = new CaseHub(wb, deps, onError);
  const open = new Set<() => void>();
  const human = (): Actor => ({ kind: "human", id: config.user });
  const text = (body: string, type: string): Response => new Response(body, { headers: { "content-type": type } });

  const routes: Route[] = [
    { method: "GET", path: /^\/$/, needs: { read: "page" }, kind: "page", handle: () => text(assets.html, "text/html; charset=utf-8") },
    { method: "GET", path: /^\/app\.js$/, needs: { read: "page" }, kind: "api", handle: () => text(assets.js, "text/javascript; charset=utf-8") },
    { method: "GET", path: /^\/app\.css$/, needs: { read: "page" }, kind: "api", handle: () => text(assets.css, "text/css; charset=utf-8") },
    {
      method: "GET", path: /^\/api\/me$/, needs: { read: "me" }, kind: "api",
      handle: () => json(200, {
        user: config.user, role: config.role, origin, markings: [...MARKINGS], policy: config.marking_policy,
        problems: opts.problems.map((p) => shown(deps, p)),
      } satisfies Me),
    },
    { method: "GET", path: /^\/api\/cases$/, needs: { read: "cases" }, kind: "api", handle: () => json(200, wb.listCases()) },
    { method: "GET", path: /^\/api\/reference$/, needs: { read: "reference" }, kind: "api", handle: () => json(200, referenceOf(deps)) },
    {
      method: "GET", path: /^\/api\/cases\/([^/]+)\/models$/, needs: { read: "models" }, kind: "api",
      handle: async ({ params }) => json(200, await modelsFor(deps, hub.read(params[0]!).state.meta?.marking ?? "TLP:RED")),
    },
    {
      method: "GET", path: /^\/api\/cases\/([^/]+)\/entries$/, needs: { read: "entries" }, kind: "api",
      handle: ({ req, url, params }) => {
        const given = req.headers.get("last-event-id") ?? url.searchParams.get("after");
        let after = 0;
        if (given !== null) {
          after = /^\d{1,15}$/.test(given) ? Number(given) : -1;
          if (after < 0) throw new Declined(400, ["after must be a whole number, zero or more"]);
        }
        return entryStream(hub.read(params[0]!), after, req.signal, (close) => { open.add(close); return () => { open.delete(close); }; });
      },
    },
    {
      method: "POST", path: /^\/api\/cases$/, needs: { command: "create_case" }, kind: "api",
      handle: async ({ body }) => {
        const input = newCaseFrom(deps, await body());
        if (Array.isArray(input)) return refused(400, ...input);
        const session = hub.create(input, human());
        return json(200, { id: session.id });
      },
    },
  ];

  async function route(req: Request): Promise<{ res: Response; kind: Kind }> {
    const url = new URL(req.url);
    const matching = routes.filter((r) => r.path.test(url.pathname));
    if (matching.length === 0) return { res: refused(404, "there is nothing at this address"), kind: "api" };
    const found = matching.find((r) => r.method === req.method);
    if (found === undefined) return { res: refused(405, `${req.method} is not answered at this address`), kind: "api" };
    // the one place the role is checked, before the handler, for reads and commands alike
    if ("read" in found.needs) {
      if (!mayRead(config.role, found.needs.read)) return { res: refused(403, `the ${config.role} view may not read ${found.needs.read}`), kind: "api" };
    } else if (!mayDo(config.role, found.needs.command)) {
      return { res: refused(403, `the ${config.role} view may not do ${found.needs.command.replace(/_/g, " ")}`), kind: "api" };
    }
    const params = (found.path.exec(url.pathname) ?? []).slice(1);
    const call: Call = {
      req, url, params,
      body: async () => {
        const raw = await readText(req);
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          throw new Declined(400, ["the body is not JSON"]);
        }
      },
    };
    return { res: await found.handle(call), kind: found.kind };
  }

  return {
    hub,
    async handle(req: Request): Promise<Response> {
      const refusedAt = refusal(req, origin);
      if (refusedAt !== null) return secure(refusedAt, "api");
      try {
        const { res, kind } = await route(req);
        return secure(res, kind);
      } catch (error) {
        if (error instanceof BodyTooLarge) return secure(refused(413, "the body is larger than 1 MiB"), "api");
        if (error instanceof Declined) return secure(refused(error.status, ...error.reasons), "api");
        if (error instanceof CaseNotFoundError) return secure(refused(404, "there is no such case"), "api");
        if (error instanceof Refused) return secure(refused(400, ...error.reasons.map((r) => shown(deps, r))), "api");
        try { onError(error); } catch { /* the reporter failing must not change the answer */ }
        const message = error instanceof Error ? error.message : String(error);
        return secure(refused(500, `the server failed: ${shown(deps, firstLine(message))}`), "api");
      }
    },
    async close(): Promise<void> {
      for (const end of [...open]) end();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([hub.idle(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
    },
  };
}

/** Binds 127.0.0.1 only. Port 0 picks a free one. */
export function startServer(opts: Omit<AppOptions, "origin">, port: number): Running {
  let app: App | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    // a stream that is quiet for a while must not be cut
    idleTimeout: 0,
    fetch: (req) => app!.handle(req),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  app = createApp({ ...opts, origin });
  const made = app;
  return {
    port: server.port!, origin, app: made,
    async stop(): Promise<void> {
      try {
        await made.close();
      } finally {
        await server.stop(true);
      }
    },
  };
}
