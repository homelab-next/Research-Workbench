import type { Json } from "../core/canonical";
import { canonical, isPlainObject } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import { isCard, isCoverage } from "../core/state/shapes";
import type { CaseSession } from "../core/session";
import type { ProposalState } from "../core/state";
import type { Actor, Card, Coverage, Cost, EmptyMeans, EntryInput, QueryPurpose, TimeWindow } from "../core/types";
import { isUtcTimestamp } from "./connectors";
import type { Bound, Connector, ConnectorPool, QueryOutcome, QueryRequest } from "./connectors";
import type { Observables } from "./observables";
import { pivotWeight } from "./manifests";
import type { PivotManifest, Registry, SourceManifest } from "./registry";
import { GuardError } from "./sqlguard";

export const CARD_PREVIEW_ROWS = 50;
/** The longest a previewed card cell may be, in characters. The blob keeps every value whole. */
export const CARD_CELL_CHARS = 4096;

/** A cell as the card previews it: a string longer than CARD_CELL_CHARS is cut (ending in …); so is a list or object, as its JSON text. */
export function previewCell(v: Json): Json {
  if (typeof v === "string") return v.length > CARD_CELL_CHARS ? `${v.slice(0, CARD_CELL_CHARS - 1)}…` : v;
  if (v === null || typeof v !== "object") return v;
  const text = JSON.stringify(v);
  return text.length > CARD_CELL_CHARS ? `${text.slice(0, CARD_CELL_CHARS - 1)}…` : v;
}

export interface RunnerDeps { registry: Registry; pool: ConnectorPool; observables: Observables }

export interface RunQueryInput {
  source: string; text: string; bound: Bound; window: TimeWindow; why: string; actor: Actor;
  pivot?: PivotManifest | null; title?: string; step?: string | null; subgoal?: string | null; verifies?: string | null;
  budget?: number | null; run?: string | null; stage?: string | null; job?: string | null; make_card?: boolean;
  /** An earlier entry this query follows from, recorded as the query.issued cause. */
  cause?: number | null;
  /**
   * Set by runProposal: the proposal this query carries out. Honoured only for a person. The proposal.accepted entry is
   * written when the result query is about to be issued (so a refusal or needs_budget leaves the proposal open) and is that query's cause.
   */
  accept?: { proposal: string; cause?: number; guard?: () => string | null } | null;
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
 * (and a card) or query.failed. Refusals write nothing. A costly query (weight above zero) is first priced: locally, or
 * by an estimate query the source answers, recorded like any other (purpose "estimate"). It runs only on a budget that
 * covers the estimate, or, with no estimate, on a person's budget. An agent's budget is ignored: its costly query becomes
 * a costly_query proposal (an open one for the same request is reused), which a person runs with runProposal.
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
  // Agents run free things only: a budget comes from a person (directly, or by accepting a proposal), never from an agent.
  const given = input.actor.kind === "agent" ? null : input.budget ?? null;
  const budget = typeof given === "number" && Number.isFinite(given) && given > 0 ? given : null;
  const req: QueryRequest = {
    text: input.text, bound, window,
    max_rows: source.limits.max_rows, timeout_ms: source.limits.timeout_ms, budget,
  };

  let connector: Connector;
  let rendered: string;
  try {
    connector = deps.pool.for(source);
    rendered = connector.render(req);
  } catch (err) {
    return refusedBy(err);
  }
  const title = titleOf(input, source, pivot, bound);
  const base = { source, connector, actor: input.actor, step: input.step ?? null, subgoal: input.subgoal ?? null, link };

  const weight = pivot !== null ? pivotWeight(pivot, source) : source.cost.weight;
  let estimate: Cost | null = null;
  let cause: number | null = null;
  if (weight > 0) {
    // An agent asking again for the same costly query is pointed at the proposal already waiting for a person.
    if (input.actor.kind === "agent") {
      const open = openProposalFor(session, source.id, source.hash, input.text, bound, window);
      if (open !== null) return { status: "needs_budget", proposal: open.id, estimate: open.estimate };
    }
    let estimateReq: QueryRequest | null;
    try {
      estimate = await connector.estimate(req);
      estimateReq = connector.estimateRequest(req);
    } catch (err) {
      return refusedBy(err);
    }
    if (estimateReq !== null) {
      // An estimate that asks the source is a query like any other: issued, run and kept in the record before it is read.
      let estimateText: string;
      try {
        estimateText = connector.render(estimateReq);
      } catch (err) {
        return refusedBy(err);
      }
      const priced = await issueAndRun(session, deps, {
        ...base, req: estimateReq, rendered: estimateText, pivot: null, why: `estimate for: ${input.why}`, verifies: null,
        purpose: "estimate", estimate: null, cause: input.cause ?? null, makeCard: false, title,
      });
      if (priced.out !== null && priced.result.status === "done") {
        try {
          estimate = connector.readEstimate(priced.out);
        } catch {
          estimate = null;
        }
      }
      cause = priced.resultSeq;
    }
    // An estimate the runner cannot compare with a budget in the source's unit is no estimate.
    if (estimate !== null && !isEstimate(estimate, source.cost.unit)) estimate = null;
    // With no estimate, only a person may decide that a budget is enough.
    const funded = budget !== null && (estimate !== null ? estimate.amount <= budget : input.actor.kind === "human");
    if (!funded) {
      if (input.actor.kind !== "agent") return { status: "needs_budget", proposal: null, estimate };
      const entries = session.commit((_state, ids) => {
        const id = ids.next("proposal");
        return [{
          type: "proposal.created", actor: input.actor, cause, ...link,
          payload: {
            proposal: {
              id, kind: "costly_query", title, by: input.actor.id, step: input.step ?? null, subgoal: input.subgoal ?? null, source: source.id,
              pivot: pivot?.id ?? null, pivot_hash: pivot?.hash ?? null, source_hash: source.hash, text: input.text, bound: { ...bound }, window: { ...window }, estimate, why: input.why,
            },
          },
        }];
      });
      const made = entries[0]!.payload as { proposal: { id: string } };
      return { status: "needs_budget", proposal: made.proposal.id, estimate };
    }
  }

  let resultCause = cause ?? input.cause ?? null;
  if (input.actor.kind === "human" && input.accept != null && budget !== null) {
    const id = input.accept.proposal;
    const acceptCause = input.accept.cause;
    const p = Object.hasOwn(session.state.proposals, id) ? session.state.proposals[id]! : null;
    if (p === null || p.kind !== "costly_query" || p.status !== "open") return { status: "refused", reasons: [`proposal ${id} is not open`] };
    // the case may have moved on while the query was priced: then nothing is accepted and nothing runs
    const moved = input.accept.guard?.() ?? null;
    if (moved !== null) return { status: "refused", reasons: [moved] };
    resultCause = session.commit(() => [{
      type: "proposal.accepted", actor: input.actor, cause: acceptCause ?? p.seq, ...link, payload: { proposal: id, budget },
    }])[0]!.seq;
  }
  const ran = await issueAndRun(session, deps, {
    ...base, req, rendered, pivot, why: input.why, verifies: input.verifies ?? null,
    purpose: input.verifies != null ? "verify" : "result", estimate, cause: resultCause, makeCard: input.make_card !== false, title,
  });
  return ran.result;
}

/** An open costly_query proposal for the same source, text, bound values and window, if there is one. */
function openProposalFor(session: CaseSession, source: string, sourceHash: string, text: string, bound: Bound, window: TimeWindow): Extract<ProposalState, { kind: "costly_query" }> | null {
  const key = canonical(bound);
  for (const p of Object.values(session.state.proposals)) {
    if (p.kind !== "costly_query" || p.status !== "open") continue;
    if (p.source === source && p.source_hash === sourceHash && p.text === text && p.window.from === window.from && p.window.to === window.to && canonical(p.bound) === key) return p;
  }
  return null;
}

/** A cost in the given unit with a finite amount of zero or more. */
function isEstimate(c: unknown, unit: string): c is Cost {
  return isPlainObject(c) && typeof c.amount === "number" && Number.isFinite(c.amount) && c.amount >= 0 && c.unit === unit;
}

const isCost = (c: unknown): c is Cost => isPlainObject(c) && typeof c.amount === "number" && Number.isFinite(c.amount) && c.amount >= 0 && typeof c.unit === "string";

interface Issue {
  source: SourceManifest; connector: Connector; req: QueryRequest; rendered: string; pivot: PivotManifest | null; actor: Actor;
  why: string; step: string | null; subgoal: string | null; verifies: string | null; purpose: QueryPurpose; estimate: Cost | null;
  cause: number | null; link: { run: string | null; stage: string | null; job: string | null }; makeCard: boolean; title: string;
}

/**
 * The custody line for one request: query.issued before the source is contacted, then query.result (and a card) or
 * query.failed. Returns the result, the connector's outcome when it is done, and the seq of the entry that closed it.
 */
async function issueAndRun(session: CaseSession, deps: RunnerDeps, q: Issue): Promise<{ result: RunQueryResult; out: QueryOutcome | null; resultSeq: number | null }> {
  const { source, connector, req, pivot, link } = q;
  const issuedAt = session.commit((_state, ids) => {
    const query = ids.next("query");
    return [{
      type: "query.issued", actor: q.actor, cause: q.cause, ...link,
      payload: {
        query, source: source.id, source_hash: source.hash, pivot: pivot?.id ?? null, pivot_hash: pivot?.hash ?? null,
        connector: source.connector, text: q.rendered, bound: { ...req.bound }, window: req.window, why: q.why,
        estimate: q.estimate, step: q.step, verifies: q.verifies, purpose: q.purpose,
      },
    }];
  })[0]!;
  const query = (issuedAt.payload as { query: string }).query;
  const fail = (error: string): { result: RunQueryResult; out: null; resultSeq: number | null } => {
    const e = session.commit(() => [{ type: "query.failed", actor: RUNNER, cause: issuedAt.seq, ...link, payload: { query, error } }]);
    return { result: { status: "failed", query, error }, out: null, resultSeq: e[0]?.seq ?? null };
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
    if (out.cost !== null && !isCost(out.cost)) return fail("the source returned an invalid result: cost is malformed");
    const blob = session.blobs.put(out.raw, out.media);
    const hash = rowsHash(out.columns, out.rows);
    const rows = out.rows.length;
    const empty: EmptyMeans | null = rows > 0 ? null : pivot?.empty_means === "proven-negative" && out.coverage.kind === "full" ? "proven-negative" : "not-seen";
    const outcome = out.coverage.kind === "partial" ? "partial" : rows === 0 ? "empty" : "answered";
    let cardId: string | null = null;
    const committed = session.commit((_state, ids) => {
      const entries: EntryInput[] = [{
        type: "query.result", actor: RUNNER, cause: issuedAt.seq, ...link,
        payload: { query, result: blob, rows, rows_hash: hash, coverage: out.coverage, duration_ms: Date.now() - started, cost: out.cost },
      }];
      if (q.makeCard) {
        const hints: Record<string, string | null> = {};
        for (const t of source.tables) for (const c of t.columns) if (c.type !== null && !Object.hasOwn(hints, c.name)) hints[c.name] = c.type;
        Object.assign(hints, pivot?.yields ?? {});
        cardId = ids.next("card");
        const card: Card = {
          id: cardId, title: q.title, body: bodyOf(rows, out.coverage, empty), kind: "result",
          made_by: q.actor.kind, query, columns: out.columns, column_types: deps.observables.columnTypes(out.columns, hints, out.rows),
          rows: out.rows.slice(0, CARD_PREVIEW_ROWS).map((row) => row.map(previewCell)), row_count: rows, coverage: out.coverage, empty, marking: source.marking,
          source: source.id, step: q.step, subgoal: q.subgoal, why: q.why, event_time: null,
          quality_notes: source.quality_notes.filter((n) => overlaps(n, req.window)).map((n) => n.id),
        };
        // a card the fold would refuse must not leave a done query with no card: refuse the whole commit instead
        if (!isCard(card)) throw new Error("the card built from the result is malformed");
        entries.push({ type: "card.created", actor: q.actor, cause: issuedAt.seq, ...link, payload: { card } });
      }
      return entries;
    });
    const now = session.state.queries[query];
    if (now?.status !== "done" || (q.makeCard && (cardId === null || !Object.hasOwn(session.state.cards, cardId)))) {
      return fail("the result was not accepted into the case record");
    }
    return {
      result: { status: "done", query, card: cardId, outcome, rows, rows_hash: hash, coverage: out.coverage, columns: out.columns, data: out.rows },
      out, resultSeq: committed[0]!.seq,
    };
  } catch (err) {
    return fail(firstLine(err));
  }
}
