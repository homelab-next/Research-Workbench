import { canonical } from "../core/canonical";
import type { Json } from "../core/canonical";
import type { CaseSession } from "../core/session";
import type { Entry } from "../core/types";

/** How many entries of the backlog go out before the stream gives the event loop a turn. */
export const PAGE = 100;
export const KEEPALIVE_MS = 15_000;
const enc = new TextEncoder();

/**
 * The entry stream: subscribe first and hold what arrives, send every entry after `after` from the ledger (in pages, so commits can
 * land between them), then release the held entries and go on live. Each seq goes out once and in order. Entries are sent exactly as
 * recorded: one event each, `id:` the seq and `data:` the canonical JSON.
 * `track` is given the function that ends this stream and returns one that forgets it, so the app can end every open stream when it closes.
 * The stream also ends when the request is aborted or the response cancelled; either way the subscription is removed.
 */
export function entryStream(session: CaseSession, after: number, signal: AbortSignal, track: (close: () => void) => () => void): Response {
  let end: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let last = after;
      let live = false;
      let ended = false;
      const held: Entry[] = [];
      const send = (entry: Entry): void => {
        if (ended || entry.seq <= last) return;
        last = entry.seq;
        controller.enqueue(enc.encode(`id: ${entry.seq}\ndata: ${canonical(entry as unknown as Json)}\n\n`));
      };
      const unsubscribe = session.subscribe((entry) => { if (live) send(entry); else held.push(entry); });
      let timer: ReturnType<typeof setInterval> | undefined;
      let untrack: () => void = () => {};
      end = (): void => {
        if (ended) return;
        ended = true;
        unsubscribe();
        untrack();
        if (timer !== undefined) clearInterval(timer);
        signal.removeEventListener("abort", end);
        try { controller.close(); } catch { /* already closed or cancelled */ }
      };
      untrack = track(end);
      signal.addEventListener("abort", end);
      timer = setInterval(() => { if (!ended) controller.enqueue(enc.encode(": keep\n\n")); }, KEEPALIVE_MS);
      timer.unref?.();
      if (signal.aborted) return end();
      for (;;) {
        const page = session.entries(last, PAGE);
        for (const entry of page) send(entry);
        if (page.length < PAGE) break;
        await Bun.sleep(0);
        if (ended) return;
      }
      // from here to `live = true` nothing yields: whatever was appended is in the ledger, and the held entries are the same ones
      for (const entry of session.entries(last)) send(entry);
      for (const entry of held.splice(0)) send(entry);
      live = true;
    },
    cancel() { end(); },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
