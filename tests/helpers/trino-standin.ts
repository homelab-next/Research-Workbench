import type { Json } from "../../src/core/canonical";

export interface TrinoReply { columns?: string[]; pages?: Json[][][]; error?: string; delayMs?: number }
export interface TrinoStandin {
  url: string;
  statements: { sql: string; headers: Record<string, string> }[];
  cancelled: string[];
  on(match: RegExp, reply: TrinoReply): void;
  stop(): void;
}

/**
 * A Bun.serve on 127.0.0.1, port 0 that speaks the Trino statement protocol.
 * The most recently registered reply whose pattern matches the statement wins;
 * a statement nothing matches gets an error page. delayMs delays every page after the first reply.
 */
export function startTrino(): TrinoStandin {
  const statements: TrinoStandin["statements"] = [];
  const cancelled: string[] = [];
  const replies: { match: RegExp; reply: TrinoReply }[] = [];
  const queries = new Map<string, TrinoReply>();
  let seq = 0;

  const json = (v: unknown): Response => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req): Promise<Response> {
      const u = new URL(req.url);
      const base: string = `http://127.0.0.1:${server.port}`;
      if (req.method === "POST" && u.pathname === "/v1/statement") {
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        const sql = await req.text();
        statements.push({ sql, headers });
        const id = `q${++seq}`;
        const hit = [...replies].reverse().find(r => r.match.test(sql));
        queries.set(id, hit?.reply ?? { error: "stand-in has no reply for this statement" });
        return json({ id, nextUri: `${base}/v1/statement/${id}/1`, stats: { state: "QUEUED" } });
      }
      const m = /^\/v1\/statement\/(q\d+)\/(\d+)$/.exec(u.pathname);
      if (m === null) return new Response("not found", { status: 404 });
      const id = m[1]!;
      const k = Number(m[2]);
      if (req.method === "DELETE") {
        cancelled.push(id);
        return new Response(null, { status: 204 });
      }
      const reply = queries.get(id);
      if (req.method !== "GET" || reply === undefined) return new Response("not found", { status: 404 });
      if (reply.delayMs !== undefined) await Bun.sleep(reply.delayMs);
      if (reply.error !== undefined) return json({ id, error: { message: reply.error }, stats: { state: "FAILED" } });
      const pages = reply.pages ?? [[]];
      const page: Record<string, unknown> = { id, stats: { state: k < pages.length ? "RUNNING" : "FINISHED" } };
      if (k === 1 && reply.columns !== undefined) page.columns = reply.columns.map(name => ({ name }));
      if (k <= pages.length && pages[k - 1]!.length > 0) page.data = pages[k - 1];
      if (k < pages.length) page.nextUri = `${base}/v1/statement/${id}/${k + 1}`;
      return json(page);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    statements,
    cancelled,
    on(match, reply) { replies.push({ match, reply }); },
    stop() { void server.stop(true); },
  };
}
