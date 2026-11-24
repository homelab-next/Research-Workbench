import type { Json } from "../../core/canonical";
import type { CardState } from "../../core/state/types";
import { strictest } from "../../core/types";
import type { Payloads } from "../../core/types";
import { revalidateCard } from "../../modules/revalidate";
import { previewCell } from "../../modules/runner";
import type { ToolContext, ToolDef, ToolResult } from "./index";
import { json, params, str, ToolError, VIEW_ROWS } from "./kit";

/** A card as a list entry: what a model needs to choose it, with no rows. */
export function cardBrief(c: CardState): Json {
  return json({
    id: c.id, title: c.title, body: c.body, source: c.source, marking: c.marking, coverage: c.coverage, empty: c.empty,
    row_count: c.row_count, place: c.place, subgoal: c.subgoal, validated: c.validated === null ? null : c.validated.outcome,
  });
}

async function listCards(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const want = typeof args.subgoal === "string" ? args.subgoal : null;
  const cards = Object.values(ctx.session.state.cards)
    .filter((c) => c.place !== "discarded" && (want === null || c.subgoal === want))
    .sort((a, b) => a.created_seq - b.created_seq);
  return { ok: true, summary: `${cards.length} cards`, view: json({ cards: cards.map(cardBrief) }), marking: cards.length === 0 ? null : strictest(...cards.map((c) => c.marking)) };
}

/** `GET http://host:port/path?q body` shown as `GET /path?q body`. */
function withoutOrigin(text: string): string {
  return text.replace(/^([A-Z]+ )[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*/i, "$1");
}

async function readCard(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const id = str(args.card);
  const c = Object.hasOwn(ctx.session.state.cards, id) ? ctx.session.state.cards[id]! : null;
  if (c === null) throw new ToolError(`unknown card: ${id}`);
  const source = c.source === null ? null : ctx.deps.registry.source(c.source);
  const notes = source === null ? [] : source.quality_notes.filter((n) => c.quality_notes.includes(n.id)).map((n) => n.text);
  let provenance: Json = null;
  const q = c.query !== null && Object.hasOwn(ctx.session.state.queries, c.query) ? ctx.session.state.queries[c.query]! : null;
  if (q !== null) {
    const entry = ctx.session.entries().find((e) => e.seq === q.issued_seq);
    if (entry !== undefined && entry.type === "query.issued") {
      const p = entry.payload as Payloads["query.issued"];
      provenance = json({
        query: p.query, source: p.source, source_hash: p.source_hash, text: p.connector === "http" ? withoutOrigin(p.text) : p.text, bound: p.bound,
        window: p.window, why: p.why, by: entry.actor.id, issued: entry.ts, result_sha256: q.result === null ? null : q.result.blob, rows_hash: q.rows_hash,
      });
    }
  }
  const view = {
    id: c.id, title: c.title, body: c.body, columns: c.columns, rows: c.rows.slice(0, VIEW_ROWS).map((r) => r.map(previewCell)),
    row_count: c.row_count, coverage: c.coverage, empty: c.empty, marking: c.marking, quality_notes: notes, provenance,
    // the title again under `card`, so a script's {{card:<title>}} can name this card
    card: [{ id: c.id, title: c.title }],
  };
  return { ok: true, summary: `${c.title}: ${c.body}`, view: json(view), marking: c.marking };
}

async function verifyCard(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const id = str(args.card);
  const r = await revalidateCard(ctx.session, ctx.deps, { card: id, actor: ctx.actor, why: str(args.why) });
  if (r.outcome === "refused") throw new ToolError(r.reasons.join("; "));
  const c = ctx.session.state.cards[id];
  return {
    ok: true, summary: `${r.outcome}: ${r.detail}`, view: json({ outcome: r.outcome, detail: r.detail, rerun: r.rerun, proposal: r.proposal }),
    marking: c === undefined ? null : c.marking,
  };
}

const card = { type: "string", minLength: 1 } as const;
export const CARD_TOOLS: ToolDef[] = [
  { name: "list_cards", description: "List the cards in the case (not discarded ones), optionally for one sub-goal.", parameters: params({ subgoal: { type: "string", minLength: 1 } }), call: listCards },
  { name: "read_card", description: "Read one card: its rows, coverage, quality notes and the exact query behind it.", parameters: params({ card }, ["card"]), call: readCard },
  { name: "verify_card", description: "Re-run the query behind a card and say whether the result matches.", parameters: params({ card }, ["card"]), call: verifyCard },
];
