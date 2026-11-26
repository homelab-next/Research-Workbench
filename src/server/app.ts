import { isPlainObject } from "../core/canonical";
import { Refused } from "../core/refused";
import { isMarking, MARKINGS } from "../core/types";
import type { Actor, Observable } from "../core/types";
import { CaseNotFoundError } from "../core/workbench";
import type { NewCase, Workbench } from "../core/workbench";
import type { CommandResult, Me, Preview } from "../core/wire";
import type { Config } from "../modules/config";
import type { EngineDeps } from "../pipeline/engine";
import { previewBundle } from "../pipeline/publish";
import { MAX_BODY_BYTES, refusal, secure } from "./guard";
import { argProblems, COMMANDS } from "./commands";
import "./plan-commands";
import "./draft-commands";
import "./converse";
import "./seek";
import "./playbook-commands";
import "./statement-commands";
import "./overrule-commands";
import "./question-commands";
import type { CommandContext } from "./commands";
import { blobResponse, bundleFile, custodyOf } from "./evidence";
import { CaseHub } from "./hub";
import { mayDo, mayRead } from "./roles";
import type { Reading } from "./roles";
import { entryStream } from "./stream";
import { agentView } from "./converse";
import { routesFor } from "./seek";
import { difference } from "../modules/revalidate";
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
type Kind = "page" | "api" | "download";
interface Route {
  method: "GET" | "POST"; path: RegExp;
  /** What the route reads, or the command it does: the one thing the role check looks at. */
  needs: { read: Reading } | { command: string } | { commandInBody: true };
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
  // a case left running (a run, or a job with no run) by a process that stopped is recovered now, not at the next command: it reads interrupted at once. Nothing resumes it.
  try {
    for (const c of wb.listCases()) if (c.run_status === "running" || c.jobs_running > 0) hub.engine(c.id);
  } catch (error) {
    try { onError(error); } catch { /* a failing reporter must not stop the server */ }
  }
  const open = new Set<() => void>();
  const human = (): Actor => ({ kind: "human", id: config.user });
  /** A module problem as this role may see it: the analyst's with its path made relative to its module root, the others' with no path. */
  const roots = config.roots.map((r) => r.path.replace(/[\\/]+$/, "")).sort((a, b) => b.length - a.length);
  const problemView = (problem: string): string => {
    if (config.role !== "analyst") return "a module could not be loaded";
    for (const root of roots) {
      if (problem.startsWith(`${root}/`) || problem.startsWith(`${root}\\`)) return shown(deps, problem.slice(root.length + 1));
    }
    return shown(deps, problem);
  };
  const text = (body: string, type: string): Response => new Response(body, { headers: { "content-type": type } });

  const routes: Route[] = [
    { method: "GET", path: /^\/$/, needs: { read: "page" }, kind: "page", handle: () => text(assets.html, "text/html; charset=utf-8") },
    { method: "GET", path: /^\/app\.js$/, needs: { read: "page" }, kind: "api", handle: () => text(assets.js, "text/javascript; charset=utf-8") },
    { method: "GET", path: /^\/app\.css$/, needs: { read: "page" }, kind: "api", handle: () => text(assets.css, "text/css; charset=utf-8") },
    {
      method: "GET", path: /^\/api\/me$/, needs: { read: "me" }, kind: "api",
      handle: () => json(200, {
        user: config.user, role: config.role, origin, markings: [...MARKINGS], policy: config.marking_policy,
        problems: opts.problems.map(problemView),
      } satisfies Me),
    },
    { method: "GET", path: /^\/api\/cases$/, needs: { read: "cases" }, kind: "api", handle: () => json(200, wb.listCases()) },
    { method: "GET", path: /^\/api\/reference$/, needs: { read: "reference" }, kind: "api", handle: () => json(200, referenceOf(deps)) },
    {
      method: "GET", path: /^\/api\/cases\/([^/]+)\/models$/, needs: { read: "models" }, kind: "api",
      handle: async ({ params }) => json(200, await modelsFor(deps, hub.read(params[0]!).state.meta?.marking ?? "TLP:RED")),
    },
    {
      method: "GET", path: /^\/api\/cases\/([^/]+)\/agent$/, needs: { read: "agent" }, kind: "api",
      handle: async ({ params }) => json(200, await agentView(hub.read(params[0]!), deps)),
    },
    {
      method: "GET", path: /^\/api\/routes$/, needs: { read: "routes" }, kind: "api",
      handle: ({ url }) => {
        const made = routesFor(deps, url.searchParams);
        return made.length > 0 && typeof made[0] === "string" ? refused(400, ...(made as string[])) : json(200, made);
      },
    },
    {
      method: "GET", path: /^\/api\/cases\/([^/]+)\/cards\/([^/]+)\/difference$/, needs: { read: "difference" }, kind: "api",
      handle: ({ params }) => {
        let card: string;
        try {
          card = decodeURIComponent(params[1]!);
        } catch {
          return refused(400, "the card name is not valid");
        }
        return json(200, difference(hub.read(params[0]!), deps.runner, card));
      },
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
        const session = hub.read(params[0]!);
        if (after > session.head().seq) throw new Declined(409, ["the stream position is ahead of this case; reload from 0"]);
        return entryStream(session, after, req.signal, (close) => { open.add(close); return () => { open.delete(close); }; });
      },
    },
    {
      method: "GET", path: /^\/api\/cases\/([^/]+)\/blobs\/([^/]+)$/, needs: { read: "blob" }, kind: "download",
      handle: ({ params }) => blobResponse(hub.read(params[0]!), params[1]!),
    },
    {
      method: "GET", path: /^\/api\/cases\/([^/]+)\/published\/([^/]+)\/([a-z.]+)$/, needs: { read: "bundle" }, kind: "download",
      handle: ({ params }) => bundleFile(hub.read(params[0]!), params[1]!, params[2]!),
    },
    {
      method: "GET", path: /^\/api\/cases\/([^/]+)\/preview$/, needs: { read: "preview" }, kind: "api",
      handle: ({ params }) => {
        const made = previewBundle(hub.read(params[0]!), deps);
        if ("reasons" in made) return json(200, { reasons: made.reasons.map((r) => shown(deps, r)) } satisfies Preview);
        const m = made.manifest;
        return json(200, { manifest: { n: m.n, draft: m.draft, draft_hash: m.draft_hash, marking: m.marking, title: m.title, note: m.note, files: m.files }, files: made.files } satisfies Preview);
      },
    },
    {
      method: "GET", path: /^\/api\/cases\/([^/]+)\/custody$/, needs: { read: "custody" }, kind: "api",
      handle: ({ params }) => json(200, custodyOf(hub.read(params[0]!))),
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
    {
      method: "POST", path: /^\/api\/cases\/([^/]+)\/commands$/, needs: { commandInBody: true }, kind: "api",
      handle: async ({ params, body }) => {
        const id = params[0]!;
        const asked = await body();
        const bad = (...reasons: string[]): Response => refused(400, ...reasons);
        if (!isPlainObject(asked)) return bad("the body must be a JSON object");
        if (Object.hasOwn(asked, "actor")) return bad("the server names the actor");
        const extra = Object.keys(asked).find((k) => k !== "command" && k !== "args");
        if (extra !== undefined) return bad(`the body has a field it should not have: ${extra.slice(0, 40)}`);
        const name = asked.command;
        if (typeof name !== "string") return bad("the body needs a command name");
        if (!Object.hasOwn(COMMANDS, name)) return bad(`unknown command ${JSON.stringify(name.slice(0, 40))}`);
        const def = COMMANDS[name]!;
        const args = asked.args === undefined ? {} : asked.args;
        if (!isPlainObject(args)) return bad("args must be a JSON object");
        if (Object.hasOwn(args, "actor")) return bad("the server names the actor");
        const problems = argProblems(def, args);
        if (problems.length > 0) return bad(...problems);
        const known = hub.read(id); // an unknown case is 404 before anything is recovered
        try {
          // slow checks happen here, outside the case's queue
          const prepared = def.prepare === undefined ? undefined : await def.prepare({ case: id, session: known, deps, hub }, args as Record<string, never>);
          // one at a time per case: a command never interleaves with another, and the drive it asks for starts after it has written
          const result = await hub.serial(id, async (): Promise<CommandResult> => {
            const engine = hub.engine(id);
            const session = hub.read(id);
            const ctx: CommandContext = { hub, case: id, session, engine, deps, actor: { kind: "human", id: config.user } };
            await def.perform(ctx, args as Record<string, never>, prepared);
            if (def.then === "advance") hub.drive(id);
            return { ok: true, seq: session.head().seq };
          });
          return json(200, result);
        } catch (error) {
          if (error instanceof Refused) return refused(409, ...error.reasons.map((r) => shown(deps, r)));
          throw error;
        }
      },
    },
  ];

  async function route(req: Request): Promise<{ res: Response; kind: Kind }> {
    const url = new URL(req.url);
    const matching = routes.filter((r) => r.path.test(url.pathname));
    if (matching.length === 0) return { res: refused(404, "there is nothing at this address"), kind: "api" };
    const found = matching.find((r) => r.method === req.method);
    if (found === undefined) return { res: refused(405, `${req.method} is not answered at this address`), kind: "api" };
    const params = (found.path.exec(url.pathname) ?? []).slice(1);
    let parsed: Promise<unknown> | undefined;
    const call: Call = {
      req, url, params,
      body: () => (parsed ??= readText(req).then((raw) => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          throw new Declined(400, ["the body is not JSON"]);
        }
      })),
    };
    // the one place the role is checked, before the handler, for reads and commands alike
    if ("read" in found.needs) {
      if (!mayRead(config.role, found.needs.read)) return { res: refused(403, `the ${config.role} view may not read ${found.needs.read}`), kind: "api" };
    } else {
      let command: string;
      if ("command" in found.needs) command = found.needs.command;
      else {
        // the command a body names; a body that names none is checked as "command" and left to the handler to refuse
        const asked = await call.body().catch(() => null);
        command = isPlainObject(asked) && typeof asked.command === "string" ? asked.command.slice(0, 40) : "command";
      }
      if (!mayDo(config.role, command)) return { res: refused(403, `the ${config.role} view may not do ${command.replace(/_/g, " ")}`), kind: "api" };
    }
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
