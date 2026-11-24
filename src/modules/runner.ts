import type { Json } from "../core/canonical";
import { canonical, isPlainObject } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import { isCoverage } from "../core/state/shapes";
import type { CaseSession } from "../core/session";
import type { Actor, Card, Coverage, Cost, EmptyMeans, EntryInput, TimeWindow } from "../core/types";
import { isUtcTimestamp } from "./connectors";
import type { Bound, ConnectorPool, QueryOutcome, QueryRequest } from "./connectors";
import type { Observables } from "./observables";
import { pivotWeight } from "./manifests";
import type { PivotManifest, Registry, SourceManifest } from "./registry";
import { GuardError } from "./sqlguard";

export const CARD_PREVIEW_ROWS = 50;

export interface RunnerDeps { registry: Registry; pool: ConnectorPool; observables: Observables }

export interface RunQueryInput {
  source: string; text: string; bound: Bound; window: TimeWindow; why: string; actor: Actor;
  pivot?: PivotManifest | null; title?: string; step?: string | null; subgoal?: string | null; verifies?: string | null;
  budget?: number | null; run?: string | null; stage?: string | null; job?: string | null; make_card?: boolean;
}

export type RunQueryResult =
  | { status: "done"; query: string; card: string | null; outcome: "answered" | "empty" | "partial"; rows: number; rows_hash: string; coverage: Coverage; columns: string[]; data: Json[][] }
  | { status: "failed"; query: string; error: string }
  | { status: "needs_budget"; proposal: string | null; estimate: Cost | null }
  | { status: "refused"; reasons: string[] };

const RUNNER: Actor = { kind: "system", id: "runner" };

export function rowsHash(columns: string[], rows: Json[][]): string {
  return sha256Hex(canonical({ columns, rows }));
}

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;

/** True when a quality note's range overlaps the window. An open end overlaps everything; an unreadable date is treated as overlapping. */
function overlaps(note: { from: string | null; to: string | null }, w: TimeWindow): boolean {
  const before = (a: string | null, b: string | null): boolean => {
    if (a === null || b === null) return true;
    const x = Date.parse(a), y = Date.parse(b);
    return Number.isNaN(x) || Number.isNaN(y) || x < y;
  };
  return before(w.from, note.to) && before(note.from, w.to);
}

function titleOf(input: RunQueryInput, source: SourceManifest, pivot: PivotManifest | null, bound: Bound): string {
  if (input.title !== undefined) return input.title;
  if (pivot !== null) return `${pivot.title}: ${String(bound.value)}`;
  return `Query on ${source.title}`;
}

/** A refusal for anything thrown while rendering or estimating: a guard's violations, else the error's first line. */
function refusedBy(err: unknown): RunQueryResult {
  if (err instanceof GuardError) return { status: "refused", reasons: [...err.violations] };
  return { status: "refused", reasons: [firstLine(err)] };
}

/** A copy of the bound values taken once, so the caller cannot change them while the query runs; or why they are refused. */
function checkBound(bound: unknown): Bound | string {
  if (!isPlainObject(bound)) return "the bound values must be a mapping of name to value";
  const out: Bound = {};
  for (const [name, v] of Object.entries(bound)) {
    if (v === null || typeof v === "string") out[name] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[name] = v;
    else return `the value for {${name}} is ${typeof v === "number" ? "not a finite number" : `a ${Array.isArray(v) ? "list" : typeof v}`}; only strings, finite numbers and null can be bound`;
  }
  return out;
}

/** A copy of the window, or why it is refused: each end null or a UTC timestamp with milliseconds, and from no later than to. */
function checkWindow(w: unknown): TimeWindow | string {
  if (!isPlainObject(w) || !Object.hasOwn(w, "from") || !Object.hasOwn(w, "to")) return "the window must have a from and a to (each a timestamp or null)";
  const { from, to } = w as { from: unknown; to: unknown };
  for (const [end, v] of [["from", from], ["to", to]] as const) {
    if (v !== null && !isUtcTimestamp(v)) return `the window's ${end} must be null or a UTC timestamp like 2026-11-20T00:00:00.000Z`;
  }
  if (typeof from === "string" && typeof to === "string" && Date.parse(from) > Date.parse(to)) return "the window's from is later than its to";
  return { from: from as string | null, to: to as string | null };
}

function bodyOf(rows: number, coverage: Coverage, empty: EmptyMeans | null): string {
  let body = rows === 0 ? (empty === "proven-negative" ? "No rows · proven negative" : "No rows · not seen (not proof of absence)") : `${rows} rows`;
  if (coverage.kind === "partial") body += ` · partial: ${coverage.reason}${coverage.detail ? ` (${coverage.detail})` : ""}`;
  return body;
}

/**
 * The one way a query reaches a source. Writes query.issued before the source is contacted, then query.result
 * (and a card) or query.failed. Refusals and unfunded costly queries write nothing (an agent's become a proposal).
 */
export async function runQuery(session: CaseSession, deps: RunnerDeps, input: RunQueryInput): Promise<RunQueryResult> {
  // Everything that decides what runs, and whether an empty answer proves anything, is checked here before a write.
  const bound = checkBound(input.bound);
  if (typeof bound === "string") return { status: "refused", reasons: [bound] };
  const window = checkWindow(input.window);
  if (typeof window === "string") return { status: "refused", reasons: [window] };
  const source = deps.registry.source(input.source);
  if (source === null) return { status: "refused", reasons: [`unknown source: ${input.source}`] };
  let pivot: PivotManifest | null = null;
  if (input.pivot) {
    // the registry's pivot decides weight, empty meaning and the agent gate; the caller's object is only a name and a hash
    pivot = deps.registry.pivot(input.pivot.id);
    if (pivot === null || pivot.hash !== input.pivot.hash) return { status: "refused", reasons: [`unknown or changed pivot: ${input.pivot.id}`] };
  }
  if (pivot !== null && pivot.source !== source.id) return { status: "refused", reasons: [`pivot ${pivot.id} is for source ${pivot.source}`] };
  // A pivot lends its weight, its empty meaning and its yields only to its own text; any other text is a query with no pivot.
  if (pivot !== null && input.text !== pivot.query) pivot = null;
  if (input.actor.kind === "agent" && pivot === null && !source.adhoc) {
    return { status: "refused", reasons: ["this source does not allow agent-written queries"] };
  }
  if (pivot !== null && pivot.needs_window && (window.from === null || window.to === null)) {
    return { status: "refused", reasons: [`pivot ${pivot.id} needs a window with both ends set`] };
  }
  const link = { run: input.run ?? null, stage: input.stage ?? null, job: input.job ?? null };
  const given = input.budget ?? null;
  const budget = typeof given === "number" && Number.isFinite(given) && given > 0 ? given : null;
  const req: QueryRequest = {
    text: input.text, bound, window,
    max_rows: source.limits.max_rows, timeout_ms: source.limits.timeout_ms, budget,
  };

  let connector;
  let rendered: string;
  try {
    connector = deps.pool.for(source);
    rendered = connector.render(req);
  } catch (err) {
    return refusedBy(err);
  }

  const weight = pivot !== null ? pivotWeight(pivot, source) : source.cost.weight;
  let estimate: Cost | null = null;
  if (weight > 0) {
    try {
      estimate = await connector.estimate(req);
    } catch (err) {
      return refusedBy(err);
    }
    const priced: Cost = estimate ?? { amount: weight, unit: source.cost.unit };
    if (budget === null || (estimate !== null && estimate.amount > budget)) {
      if (input.actor.kind !== "agent") return { status: "needs_budget", proposal: null, estimate };
      const entries = session.commit((_state, ids) => {
        const id = ids.next("proposal");
        return [{
          type: "proposal.created", actor: input.actor, ...link,
          payload: { proposal: { id, kind: "costly_query", title: titleOf(input, source, pivot, bound), by: input.actor.id, step: input.step ?? null, source: source.id, text: rendered, estimate: priced, why: input.why } },
        }];
      });
      const made = entries[0]!.payload as { proposal: { id: string } };
      return { status: "needs_budget", proposal: made.proposal.id, estimate: priced };
    }
  }

  const issuedAt = session.commit((_state, ids) => {
    const query = ids.next("query");
    return [{
      type: "query.issued", actor: input.actor, ...link,
      payload: {
        query, source: source.id, source_hash: source.hash, pivot: pivot?.id ?? null, pivot_hash: pivot?.hash ?? null,
        connector: source.connector, text: rendered, bound: { ...bound }, window, why: input.why,
        estimate, step: input.step ?? null, verifies: input.verifies ?? null,
      },
    }];
  })[0]!;
  const query = (issuedAt.payload as { query: string }).query;
  const fail = (error: string): RunQueryResult => {
    session.commit(() => [{ type: "query.failed", actor: RUNNER, cause: issuedAt.seq, ...link, payload: { query, error } }]);
    return { status: "failed", query, error };
  };

  const started = Date.now();
  let out: QueryOutcome;
  try {
    out = await connector.run(req);
  } catch (err) {
    return fail(firstLine(err));
  }

  try {
    if (!isCoverage(out.coverage)) return fail("the source returned an invalid result: coverage is malformed");
    if (!Array.isArray(out.columns) || !out.columns.every((c) => typeof c === "string") || !Array.isArray(out.rows)) {
      return fail("the source returned an invalid result: columns are not a list of strings");
    }
    const blob = session.blobs.put(out.raw, out.media);
    const hash = rowsHash(out.columns, out.rows);
    const rows = out.rows.length;
    const empty: EmptyMeans | null = rows > 0 ? null : pivot?.empty_means === "proven-negative" && out.coverage.kind === "full" ? "proven-negative" : "not-seen";
    const hints: Record<string, string | null> = {};
    for (const t of source.tables) for (const c of t.columns) if (c.type !== null && !Object.hasOwn(hints, c.name)) hints[c.name] = c.type;
    Object.assign(hints, pivot?.yields ?? {});
    const columnTypes = deps.observables.columnTypes(out.columns, hints, out.rows);
    const notes = source.quality_notes.filter((n) => overlaps(n, window)).map((n) => n.id);
    const outcome = out.coverage.kind === "partial" ? "partial" : rows === 0 ? "empty" : "answered";
    const makeCard = input.make_card !== false;
    let cardId: string | null = null;
    session.commit((_state, ids) => {
      const entries: EntryInput[] = [{
        type: "query.result", actor: RUNNER, cause: issuedAt.seq, ...link,
        payload: { query, result: blob, rows, rows_hash: hash, coverage: out.coverage, duration_ms: Date.now() - started, cost: out.cost },
      }];
      if (makeCard) {
        cardId = ids.next("card");
        const card: Card = {
          id: cardId, title: titleOf(input, source, pivot, bound), body: bodyOf(rows, out.coverage, empty), kind: "result",
          made_by: input.actor.kind, query, columns: out.columns, column_types: columnTypes,
          rows: out.rows.slice(0, CARD_PREVIEW_ROWS), row_count: rows, coverage: out.coverage, empty, marking: source.marking,
          source: source.id, step: input.step ?? null, subgoal: input.subgoal ?? null, why: input.why, event_time: null, quality_notes: notes,
        };
        entries.push({ type: "card.created", actor: input.actor, cause: issuedAt.seq, ...link, payload: { card } });
      }
      return entries;
    });
    const now = session.state.queries[query];
    if (now?.status !== "done" || (makeCard && (cardId === null || !Object.hasOwn(session.state.cards, cardId)))) {
      return fail("the result was not accepted into the case record");
    }
    return { status: "done", query, card: cardId, outcome, rows, rows_hash: hash, coverage: out.coverage, columns: out.columns, data: out.rows };
  } catch (err) {
    return fail(firstLine(err));
  }
}
