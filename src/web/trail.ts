import { isAnswerPurpose } from "../core/types";
import type { Entry, Payloads } from "../core/types";

export interface Lookup {
  query: string; pivot: string | null; value: string; status: "running" | "answered" | "empty" | "partial" | "failed";
  rows: number | null; detail: string; card: string | null;
}

/**
 * What one route did, read from the entries alone: each lookup the job issued (the estimate and verify queries are not lookups), how it ended,
 * and the route's own ending when it has one. A lookup that was partial is never `empty`, whatever the rows say.
 */
export function routeTrail(entries: readonly Entry[], job: string): { lookups: Lookup[]; finished: Payloads["route.finished"] | null } {
  const results = new Map<string, Payloads["query.result"]>();
  const failures = new Map<string, string>();
  const cards = new Map<string, { id: string; empty: string | null }>();
  let finished: Payloads["route.finished"] | null = null;
  for (const e of entries) {
    switch (e.type) {
      case "query.result": results.set(e.payload.query, e.payload); break;
      case "query.failed": failures.set(e.payload.query, e.payload.error); break;
      case "card.created": if (e.payload.card.query !== null) cards.set(e.payload.card.query, { id: e.payload.card.id, empty: e.payload.card.empty }); break;
      case "route.finished": if (e.payload.job === job) finished = e.payload; break;
      default: break;
    }
  }
  const lookups: Lookup[] = [];
  for (const e of entries) {
    if (e.type !== "query.issued" || e.job !== job || !isAnswerPurpose(e.payload.purpose)) continue;
    const q = e.payload.query;
    const bound = e.payload.bound.value;
    const base = { query: q, pivot: e.payload.pivot, value: typeof bound === "string" ? bound : bound === undefined || bound === null ? "" : String(bound) };
    const card = cards.get(q) ?? null;
    const r = results.get(q);
    if (failures.has(q)) lookups.push({ ...base, status: "failed", rows: null, detail: failures.get(q)!, card: null });
    else if (r === undefined) lookups.push({ ...base, status: "running", rows: null, detail: "", card: null });
    else if (r.coverage.kind === "partial") {
      lookups.push({ ...base, status: "partial", rows: r.rows, detail: `${r.coverage.reason}${r.coverage.detail === undefined || r.coverage.detail === "" ? "" : ` (${r.coverage.detail})`}`, card: card?.id ?? null });
    } else if (r.rows === 0) {
      lookups.push({ ...base, status: "empty", rows: 0, detail: card?.empty === "proven-negative" ? "proven negative" : "not seen", card: card?.id ?? null });
    } else lookups.push({ ...base, status: "answered", rows: r.rows, detail: "", card: card?.id ?? null });
  }
  return { lookups, finished };
}
