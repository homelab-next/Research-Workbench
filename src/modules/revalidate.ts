import { canonical } from "../core/canonical";
import type { Json } from "../core/canonical";
import type { CaseSession } from "../core/session";
import type { Difference } from "../core/wire";
import { rowsOfBlob } from "./connectors/rows";
import type { Actor, Coverage, Payloads } from "../core/types";
import { PivotError, bindPivot } from "./pivots";
import type { RunnerDeps, RunQueryInput } from "./runner";
import { rowsHash, runQuery } from "./runner";

/** `proposal` is the costly_query proposal the re-run raised (an agent's re-run of a costly source), else null. */
export type Verdict = { outcome: "matches" | "differs" | "could_not_run"; detail: string; rerun: string | null; proposal: string | null };

/** Turns a stored `$name` text back into its `{name}` template. `$window_from` and `$window_to` map back to the dotted window names. */
function toTemplate(text: string, bound: Record<string, unknown>): string {
  const names = [...Object.keys(bound), "window.from", "window.to"];
  return text.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name: string) => {
    const hit = names.find((n) => n === name) ?? names.find((n) => n.replaceAll(".", "_") === name);
    return hit === undefined ? m : `{${hit}}`;
  });
}

/** What revalidateCard returns: a verdict (recorded as verify.run, except for a card with no query), or a refusal that writes nothing. */
export type Revalidation = Verdict | { outcome: "refused"; reasons: string[] };

/**
 * Re-runs the query behind a card as a logged query that verifies the original (no card is made), compares the result hashes
 * and records verify.run. An unknown card is refused and writes nothing; so does a card with no query.
 * A pivot query is re-run from its pivot's text and the stored values, and only if that renders to the stored text; a query
 * with no pivot is re-run from its stored text (sql and files map it back to its template, trino must render it unchanged).
 */
export async function revalidateCard(
  session: CaseSession, deps: RunnerDeps, input: { card: string; actor: Actor; why: string; budget?: number | null },
): Promise<Revalidation> {
  const card = Object.hasOwn(session.state.cards, input.card) ? session.state.cards[input.card]! : null;
  if (card === null) return { outcome: "refused", reasons: [`unknown card: ${input.card}`] };
  const original = card.query !== null && Object.hasOwn(session.state.queries, card.query) ? session.state.queries[card.query]! : null;
  if (card.query === null || original === null) return { outcome: "could_not_run", detail: "this card did not come from a query", rerun: null, proposal: null };
  const originalId = card.query;
  const entry = session.entries().find((e) => e.seq === original.issued_seq);
  const was = entry !== undefined && entry.type === "query.issued" ? (entry.payload as Payloads["query.issued"]) : null;

  const finish = (v: Verdict): Verdict => {
    session.commit(() => [{
      type: "verify.run", actor: input.actor,
      payload: { original: originalId, rerun: v.rerun, card: input.card, outcome: v.outcome, detail: v.detail },
    }]);
    return v;
  };
  const couldNot = (detail: string, rerun: string | null = null, proposal: string | null = null): Verdict => finish({ outcome: "could_not_run", detail, rerun, proposal });

  if (was === null) return couldNot("the original query entry could not be found");
  if (original.status !== "done" || original.rows_hash === null || original.rows === null) return couldNot("the original query has no result to compare with");
  const source = deps.registry.source(was.source);
  if (source === null) return couldNot(`unknown source: ${was.source}`);
  // "matches" or "differs" against a source whose manifest was edited would compare two different things
  if (source.hash !== was.source_hash) return couldNot("the source has changed since the original query");

  const run: RunQueryInput = {
    source: was.source, text: "", bound: {}, window: was.window, why: input.why, actor: input.actor,
    verifies: originalId, make_card: false, budget: input.budget ?? null,
  };
  /** The text a request renders to on this source now, or null if it cannot be rendered. */
  const rendersTo = (text: string, bound: RunQueryInput["bound"]): string | null => {
    try {
      return deps.pool.for(source).render({ text, bound, window: was.window, max_rows: source.limits.max_rows, timeout_ms: source.limits.timeout_ms, budget: null });
    } catch {
      return null;
    }
  };
  if (was.pivot !== null) {
    const pivot = deps.registry.pivot(was.pivot);
    if (pivot === null || pivot.hash !== was.pivot_hash) return couldNot("the pivot has changed since the original query");
    try {
      bindPivot(pivot, String(was.bound.value), deps.observables);
    } catch (err) {
      if (err instanceof PivotError) return couldNot(err.message);
      throw err;
    }
    // the pivot's own text keeps its weight and empty meaning on the re-run; it must render to what ran before
    const bound = was.bound as RunQueryInput["bound"]; // the stored values, which may carry more than the pivot's {value}
    if (rendersTo(pivot.query, bound) !== was.text) return couldNot("the stored text cannot be re-run unchanged");
    run.pivot = pivot;
    run.text = pivot.query;
    run.bound = bound;
  } else if (was.connector === "sql" || was.connector === "files") {
    run.text = toTemplate(was.text, was.bound);
    run.bound = was.bound as RunQueryInput["bound"];
  } else if (was.connector === "trino") {
    // the stored text is rendered SQL; a rendering pass must leave it unchanged or a re-run could execute different SQL
    if (rendersTo(was.text, {}) !== was.text) return couldNot("the stored text cannot be re-run unchanged");
    run.text = was.text;
  } else {
    return couldNot("only pivot queries can be re-run on this source");
  }

  const r = await runQuery(session, deps, run);
  switch (r.status) {
    case "refused": return couldNot(r.reasons.join("; "));
    case "needs_budget":
      return r.proposal !== null
        ? couldNot(`a budget is needed to re-run this query on a costly source (proposal ${r.proposal})`, null, r.proposal)
        : couldNot("a budget is needed to re-run this query on a costly source");
    case "failed": return couldNot(r.error, r.query);
    case "done": {
      const side = (c: Coverage): string | null => (c.kind === "partial" ? c.reason : null);
      const o = original.coverage !== null ? side(original.coverage) : null, n = side(r.coverage);
      const which = o !== null && n !== null ? "original and re-run" : o !== null ? "original" : "re-run";
      const note = o !== null || n !== null ? `the ${which} result is partial (${[o, n].filter((x) => x !== null).join(", ")})` : null;
      if (r.rows_hash === original.rows_hash) {
        if (note !== null) return finish({ outcome: "could_not_run", detail: `same ${r.rows} rows, but ${note}; it cannot be fully verified`, rerun: r.query, proposal: null });
        return finish({ outcome: "matches", detail: `same ${r.rows} rows`, rerun: r.query, proposal: null });
      }
      let detail = r.rows !== original.rows
        ? `was ${original.rows} rows, now ${r.rows} rows; the source may have changed since`
        : `same number of rows (${r.rows}) but different content; the source may have changed since`;
      if (note !== null) detail += `; ${note}`;
      return finish({ outcome: "differs", detail, rerun: r.query, proposal: null });
    }
  }
}

/** The most rows of each list a Difference carries. */
export const DIFFERENCE_ROWS = 200;
const NONE = "this card has no difference to show";
const UNREADABLE = "the stored result cannot be read back row by row";

/**
 * The row-level difference behind the newest verify.run of a card that differs: both recorded results are read back from the case's
 * blobs (by the connector's own reader) and compared as multisets of canonical JSON rows. Reads the ledger and its blobs and writes nothing;
 * it contacts no source. A result that does not read back to the rows hash it was recorded with is not trusted.
 */
export function difference(session: CaseSession, deps: RunnerDeps, card: string): Difference | { reason: string } {
  let run: Payloads["verify.run"] | null = null;
  for (const e of session.entries()) if (e.type === "verify.run" && (e.payload as Payloads["verify.run"]).card === card) run = e.payload as Payloads["verify.run"];
  if (run === null || run.outcome !== "differs" || run.rerun === null) return { reason: NONE };
  const side = (id: string): { columns: string[]; rows: Json[][] } | null => {
    const q = Object.hasOwn(session.state.queries, id) ? session.state.queries[id]! : null;
    if (q === null || q.status !== "done" || q.result === null || q.rows_hash === null) return null;
    const issued = session.entries().find((e) => e.seq === q.issued_seq);
    if (issued === undefined || issued.type !== "query.issued") return null;
    const was = issued.payload as Payloads["query.issued"];
    const source = deps.registry.source(was.source);
    if (source === null) return null;
    let bytes: Uint8Array;
    try {
      bytes = session.blobs.get(q.result.blob);
    } catch {
      return null;
    }
    const back = rowsOfBlob(source, was, bytes, q.rows);
    return back !== null && rowsHash(back.columns, back.rows) === q.rows_hash ? back : null;
  };
  let a: ReturnType<typeof side>, b: ReturnType<typeof side>;
  try {
    a = side(run.original); b = side(run.rerun);
  } catch {
    return { reason: UNREADABLE };
  }
  if (a === null || b === null) return { reason: UNREADABLE };
  if (canonical(a.columns) !== canonical(b.columns)) return { reason: UNREADABLE };
  const count = (rows: Json[][]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows) { const k = canonical(r); m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  };
  const leftOver = (from: Json[][], other: Map<string, number>): Json[][] => {
    const left = new Map(other);
    const out: Json[][] = [];
    for (const r of from) {
      const k = canonical(r);
      const n = left.get(k) ?? 0;
      if (n > 0) left.set(k, n - 1); else out.push(r);
    }
    return out;
  };
  const removed = leftOver(a.rows, count(b.rows));
  const added = leftOver(b.rows, count(a.rows));
  return {
    original: run.original, rerun: run.rerun, columns: a.columns, removed: removed.slice(0, DIFFERENCE_ROWS), added: added.slice(0, DIFFERENCE_ROWS),
    same: a.rows.length - removed.length, cut: removed.length > DIFFERENCE_ROWS || added.length > DIFFERENCE_ROWS,
  };
}
