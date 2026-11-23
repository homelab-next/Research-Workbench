import type { CaseSession } from "../core/session";
import type { Actor, Payloads } from "../core/types";
import { PivotError, bindPivot } from "./pivots";
import type { RunnerDeps, RunQueryInput } from "./runner";
import { runQuery } from "./runner";

export type Verdict = { outcome: "matches" | "differs" | "could_not_run"; detail: string; rerun: string | null };

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
  if (card.query === null || original === null) return { outcome: "could_not_run", detail: "this card did not come from a query", rerun: null };
  const originalId = card.query;
  const entry = session.entries().find((e) => e.seq === original.issued_seq);
  const was = entry !== undefined && entry.type === "query.issued" ? (entry.payload as Payloads["query.issued"]) : null;

  const finish = (v: Verdict): Verdict => {
    session.commit(() => [{
      type: "verify.run", actor: input.actor,
      payload: { original: originalId, rerun: v.rerun ?? "", card: input.card, outcome: v.outcome, detail: v.detail },
    }]);
    return v;
  };
  const couldNot = (detail: string, rerun: string | null = null): Verdict => finish({ outcome: "could_not_run", detail, rerun });

  if (was === null) return couldNot("the original query entry could not be found");
  if (original.status !== "done" || original.rows_hash === null || original.rows === null) return couldNot("the original query has no result to compare with");

  const run: RunQueryInput = {
    source: was.source, text: "", bound: {}, window: was.window, why: input.why, actor: input.actor,
    verifies: originalId, make_card: false, budget: input.budget ?? null,
  };
  if (was.connector === "sql" || was.connector === "files") {
    run.text = toTemplate(was.text, was.bound);
    run.bound = was.bound as RunQueryInput["bound"];
  } else if (was.connector === "trino") {
    run.text = was.text;
  } else {
    if (was.pivot === null) return couldNot("only pivot queries can be re-run on this source");
    const pivot = deps.registry.pivot(was.pivot);
    if (pivot === null || pivot.hash !== was.pivot_hash) return couldNot("the pivot has changed since the original query");
    try {
      const bound = bindPivot(pivot, String(was.bound.value), deps.observables);
      run.text = bound.text;
      run.bound = was.bound as RunQueryInput["bound"]; // the stored values, which may carry more than the pivot's {value}
    } catch (err) {
      if (err instanceof PivotError) return couldNot(err.message);
      throw err;
    }
    run.pivot = pivot;
  }

  const r = await runQuery(session, deps, run);
  switch (r.status) {
    case "refused": return couldNot(r.reasons.join("; "));
    case "needs_budget": return couldNot("a budget is needed to re-run this query on a costly source");
    case "failed": return couldNot(r.error, r.query);
    case "done": {
      if (r.rows_hash === original.rows_hash) return finish({ outcome: "matches", detail: `same ${r.rows} rows`, rerun: r.query });
      const detail = r.rows !== original.rows
        ? `was ${original.rows} rows, now ${r.rows} rows; the source may have changed since`
        : `same number of rows (${r.rows}) but different content; the source may have changed since`;
      return finish({ outcome: "differs", detail, rerun: r.query });
    }
  }
}
