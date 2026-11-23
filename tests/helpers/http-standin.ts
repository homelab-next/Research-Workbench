export type Route = (req: Request) => Response | Promise<Response>;
export interface SeenRequest { method: string; path: string; headers: Record<string, string>; body: string }
export interface Standin { url: string; requests: SeenRequest[]; stop(): void }

/** A Bun.serve on 127.0.0.1, port 0. Route keys are "METHOD /path" (path without the query string); anything else is a 404. */
export function startStandin(routes: Record<string, Route>): Standin {
  const requests: SeenRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      requests.push({ method: req.method, path: u.pathname + u.search, headers, body: await req.clone().text() });
      const route = routes[`${req.method} ${u.pathname}`];
      return route === undefined ? new Response("not found", { status: 404 }) : route(req);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => { void server.stop(true); } };
}
