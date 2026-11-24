// A stand-in reputation service for the sample, on loopback only: GET /v1/reputation/<address>.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function startReputationFixture(dataDir: string, port = 4801): { url: string; stop(): void } {
  const table = new Map(Object.entries(JSON.parse(readFileSync(join(dataDir, "reputation.json"), "utf8")) as Record<string, { verdict: string; first_seen: string }>));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      const u = new URL(req.url);
      const m = /^\/v1\/reputation\/([^/]+)$/.exec(u.pathname);
      if (req.method !== "GET" || m === null) return new Response("not found", { status: 404 });
      const address = decodeURIComponent(m[1]!);
      const hit = table.get(address);
      const results = hit === undefined ? [] : [{ address, verdict: hit.verdict, first_seen: hit.first_seen }];
      return Response.json({ results });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => { void server.stop(true); } };
}

if (import.meta.main) {
  const f = startReputationFixture(resolve(import.meta.dir, "..", "data"));
  console.log(`reputation fixture listening on ${f.url}`);
}
