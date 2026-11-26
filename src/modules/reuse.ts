import { canonical } from "../core/canonical";
import type { CaseSession } from "../core/session";
import { isAnswerPurpose } from "../core/types";
import type { Payloads, TimeWindow } from "../core/types";
import type { Bound } from "./connectors";
import { rowsOfBlob } from "./connectors/rows";
import type { PivotManifest } from "./registry";
import { rowsHash } from "./runner";
import type { RunnerDeps, RunQueryResult } from "./runner";

/** A query already answered in this case, read back from the record: nothing was sent to the source for it. */
export type Reused = Extract<RunQueryResult, { status: "done" }> & { reused: { query: string; at: string; card_seq: number } };

/** What a reused step's record says: the query it took its answer from, when that was issued, and why it is the same. */
export const reuseNote = (r: Reused): string => `reused ${r.reused.query} from ${r.reused.at}; same pivot, value and window`;

/**
 * The newest query in this case that answered the same pivot on the same bound values over the same window, when it can stand for running it
 * again: the same pivot and source manifests (their hashes), the pivot's own text, an answer (a result or a playbook lookup, from a researcher, a person or a playbook alike; not an estimate or a verify re-run) that is done
 * with full coverage, and a card that was made for it and is not discarded. A partial or failed result, another window, value or manifest is
 * never reused. Its rows are read back from the stored result by the connector's own reader and must match the rows hash it was recorded
 * with; a result that does not read back is not reused. For a pivot that asks an inventory, the earlier query must have read the same inventory
 * (id and hash), since an edit to it can change what an empty answer proves; a pivot with no inventory reuses only a query that named none.
 * Writes nothing and contacts no source.
 */
export function answeredBefore(session: CaseSession, deps: RunnerDeps, pivot: PivotManifest, bound: Bound, window: TimeWindow): Reused | null {
  const source = deps.registry.source(pivot.source);
  if (source === null) return null;
  const state = session.state;
  const key = canonical(bound);
  const inv = pivot.inventory === null ? null : deps.registry.inventory(pivot.inventory);
  if (pivot.inventory !== null && inv === null) return null;
  const candidates = Object.values(state.queries)
    .filter((q) => q.status === "done" && isAnswerPurpose(q.purpose) && q.source === source.id && q.window.from === window.from && q.window.to === window.to
      && q.coverage?.kind === "full" && q.card !== null && Object.hasOwn(state.cards, q.card) && !state.discarded.includes(q.card)
      && q.result !== null && q.rows !== null && q.rows_hash !== null)
    .sort((a, b) => b.issued_seq - a.issued_seq);
  for (const q of candidates) {
    const entry = session.entries(q.issued_seq - 1, 1)[0];
    if (entry === undefined || entry.seq !== q.issued_seq || entry.type !== "query.issued") continue;
    const was = entry.payload as Payloads["query.issued"];
    if (was.pivot !== pivot.id || was.pivot_hash !== pivot.hash || was.source_hash !== source.hash || canonical(was.bound) !== key) continue;
    const wasInv = was.inventory ?? null;
    if (inv === null ? wasInv !== null : wasInv === null || wasInv.id !== inv.id || wasInv.hash !== inv.hash) continue;
    let back: ReturnType<typeof rowsOfBlob>;
    try {
      back = rowsOfBlob(source, was, session.blobs.get(q.result!.blob), q.rows);
    } catch {
      continue;
    }
    if (back === null || rowsHash(back.columns, back.rows) !== q.rows_hash) continue;
    const card = state.cards[q.card!]!;
    return {
      status: "done", query: q.id, card: card.id, outcome: q.rows === 0 ? "empty" : "answered", rows: q.rows!, rows_hash: q.rows_hash!,
      coverage: q.coverage!, columns: back.columns, data: back.rows,
      reused: { query: q.id, at: q.issued_ts, card_seq: card.created_seq },
    };
  }
  return null;
}
