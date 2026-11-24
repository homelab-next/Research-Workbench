import type { Json } from "../../src/core/canonical";
import { startStandin } from "./http-standin";
import type { SeenRequest } from "./http-standin";

export type { SeenRequest } from "./http-standin";
export interface StandinReply { status?: number; json?: Json; text?: string; delayMs?: number; redirect?: string }
export interface ModelStandinOptions {
  models?: { id: string; loaded_context_length?: number }[];
  /** False makes /api/v0/models answer 404, like an endpoint that is not LM Studio. */
  details?: boolean;
  replies: (StandinReply | ((body: Record<string, Json>) => StandinReply))[];
}

/** An OpenAI-compatible chat endpoint on 127.0.0.1, shaped like LM Studio. `url` ends in /v1. */
export function startModelStandin(opts: ModelStandinOptions): { url: string; requests: SeenRequest[]; stop(): void } {
  const models = opts.models ?? [];
  const queue = [...opts.replies];
  const s = startStandin({
    "GET /v1/models": () => Response.json({ data: models.map((m) => ({ id: m.id })) }),
    "GET /api/v0/models": () =>
      opts.details === false ? new Response("not found", { status: 404 }) : Response.json({ data: models }),
    "POST /v1/chat/completions": async (req) => {
      const next = queue.shift();
      if (next === undefined) return new Response("no reply left", { status: 500 });
      const reply = typeof next === "function" ? next(JSON.parse(await req.text()) as Record<string, Json>) : next;
      if (reply.delayMs !== undefined) await Bun.sleep(reply.delayMs);
      if (reply.redirect !== undefined) return new Response(null, { status: 302, headers: { location: reply.redirect } });
      const status = reply.status ?? 200;
      if (reply.text !== undefined) return new Response(reply.text, { status });
      return Response.json(reply.json ?? {}, { status });
    },
  });
  return { url: `${s.url}/v1`, requests: s.requests, stop: s.stop };
}
