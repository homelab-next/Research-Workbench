import type { CaseSession } from "../core/session";
import type { Actor, Coverage, Payloads } from "../core/types";
import { PivotError, bindPivot } from "./pivots";
import type { RunnerDeps, RunQueryInput } from "./runner";
import { runQuery } from "./runner";

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

/**
 * Re-runs the query behind a card as a logged query that verifies the original (no card is made), compares the result hashes
 * and records verify.run. Throws for an unknown card. A card with no query writes nothing.
 */
export async function revalidateCard(
  session: CaseSession, deps: RunnerDeps, input: { card: string; actor: Actor; why: string; budget?: number | null },
): Promise<Verdict> {
  const card = Object.hasOwn(session.state.cards, input.card) ? session.state.cards[input.card]! : null;
  if (card === null) throw new Error(`unknown card: ${input.card}`);
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

  const run: RunQueryInput = {
    source: was.source, text: "", bound: {}, window: was.window, why: input.why, actor: input.actor,
    verifies: originalId, make_card: false, budget: input.budget ?? null,
  };
  if (was.pivot !== null) {
    const pivot = deps.registry.pivot(was.pivot);
    if (pivot === null || pivot.hash !== was.pivot_hash) return couldNot("the pivot has changed since the original query");
    run.pivot = pivot;
  }
  if (was.connector === "sql" || was.connector === "files") {
    run.text = toTemplate(was.text, was.bound);
    run.bound = was.bound as RunQueryInput["bound"];
  } else if (was.connector === "trino") {
    // the stored text is rendered SQL; a rendering pass must leave it unchanged or a re-run could execute different SQL
    const source = deps.registry.source(was.source);
    if (source === null) return couldNot(`unknown source: ${was.source}`);
    let again: string | null = null;
    try {
      again = deps.pool.for(source).render({ text: was.text, bound: {}, window: was.window, max_rows: source.limits.max_rows, timeout_ms: source.limits.timeout_ms, budget: null });
    } catch { again = null; }
    if (again !== was.text) return couldNot("the stored text cannot be re-run unchanged");
    run.text = was.text;
  } else {
    if (run.pivot === undefined || run.pivot === null) return couldNot("only pivot queries can be re-run on this source");
    try {
      bindPivot(run.pivot, String(was.bound.value), deps.observables);
    } catch (err) {
      if (err instanceof PivotError) return couldNot(err.message);
      throw err;
    }
    run.text = run.pivot.query;
    run.bound = was.bound as RunQueryInput["bound"]; // the stored values, which may carry more than the pivot's {value}
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
