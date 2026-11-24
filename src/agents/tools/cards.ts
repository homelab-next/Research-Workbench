import type { Json } from "../../core/canonical";
import type { CardState } from "../../core/state/types";
import { strictest } from "../../core/types";
import type { Payloads } from "../../core/types";
import type { Registry } from "../../modules/registry";
import { revalidateCard } from "../../modules/revalidate";
import { previewCell } from "../../modules/runner";
import type { ToolContext, ToolDef, ToolResult } from "./index";
import { idArg, json, params, scrub, scrubCoverage, str, ToolError, VIEW_ROWS } from "./kit";

export { scrubCoverage };

/** A card as a list entry: what a model needs to choose it, with no rows. */
export function cardBrief(registry: Registry, c: CardState): Json {
  return json({
    id: c.id, title: scrub(registry, c.title), body: scrub(registry, c.body), source: c.source, marking: c.marking, coverage: scrubCoverage(registry, c.coverage), empty: c.empty,
    row_count: c.row_count, place: c.place, subgoal: c.subgoal, validated: c.validated === null ? null : c.validated.outcome,
  });
}

async function listCards(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const want = typeof args.subgoal === "string" ? args.subgoal : null;
  const cards = Object.values(ctx.session.state.cards)
    .filter((c) => c.place !== "discarded" && (want === null || c.subgoal === want))
    .sort((a, b) => a.created_seq - b.created_seq);
  return { ok: true, summary: `${cards.length} cards`, view: json({ cards: cards.map((c) => cardBrief(ctx.deps.registry, c)) }), marking: cards.length === 0 ? null : strictest(...cards.map((c) => c.marking)) };
}

/** `GET <location>/path?q body` shown as `GET /path?q body`: the source's whole location comes off, base path included, and any origin left. */
function withoutLocation(text: string, location: string | null): string {
  let out = text;
  const base = location === null ? "" : location.replace(/\/+$/, "");
  if (base !== "") out = out.split(base).join("");
  return out.replace(/^([A-Z]+ )[a-z][a-z0-9+.-]*:\/\/[^/\s?#]*/i, "$1");
}

async function readCard(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const id = str(args.card);
  const c = Object.hasOwn(ctx.session.state.cards, id) ? ctx.session.state.cards[id]! : null;
  if (c === null) throw new ToolError(`unknown card: ${id}`);
  const source = c.source === null ? null : ctx.deps.registry.source(c.source);
  const title = scrub(ctx.deps.registry, c.title), body = scrub(ctx.deps.registry, c.body);
  const notes = source === null ? [] : source.quality_notes.filter((n) => c.quality_notes.includes(n.id)).map((n) => scrub(ctx.deps.registry, n.text));
  let provenance: Json = null;
  const q = c.query !== null && Object.hasOwn(ctx.session.state.queries, c.query) ? ctx.session.state.queries[c.query]! : null;
  if (q !== null) {
    const entry = ctx.session.entries().find((e) => e.seq === q.issued_seq);
    if (entry !== undefined && entry.type === "query.issued") {
      const p = entry.payload as Payloads["query.issued"];
      provenance = json({
        query: p.query, source: p.source, source_hash: p.source_hash, text: scrub(ctx.deps.registry, p.connector === "http" ? withoutLocation(p.text, ctx.deps.registry.source(p.source)?.location ?? null) : p.text, { backstop: false }), bound: p.bound,
        window: p.window, why: p.why, by: entry.actor.id, issued: entry.ts, result_sha256: q.result === null ? null : q.result.blob, rows_hash: q.rows_hash,
      });
    }
  }
  const view = {
    id: c.id, title, body, columns: c.columns, rows: c.rows.slice(0, VIEW_ROWS).map((r) => r.map(previewCell)),
    row_count: c.row_count, coverage: scrubCoverage(ctx.deps.registry, c.coverage), empty: c.empty, marking: c.marking, quality_notes: notes, provenance,
    // the title again under `card`, so a script's {{card:<title>}} can name this card
    card: [{ id: c.id, title }],
  };
  return { ok: true, summary: `${title}: ${body}`, view: json(view), marking: c.marking };
}

async function verifyCard(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const id = str(args.card);
  const r = await revalidateCard(ctx.session, ctx.deps, { card: id, actor: ctx.actor, why: str(args.why) });
  if (r.outcome === "refused") throw new ToolError(scrub(ctx.deps.registry, r.reasons.join("; ")));
  const c = Object.hasOwn(ctx.session.state.cards, id) ? ctx.session.state.cards[id] : undefined;
  const detail = scrub(ctx.deps.registry, r.detail);
  return {
    ok: true, summary: `${r.outcome}: ${detail}`, view: json({ outcome: r.outcome, detail, rerun: r.rerun, proposal: r.proposal }),
    marking: c === undefined ? null : c.marking,
  };
}

const card = idArg;
export const CARD_TOOLS: ToolDef[] = [
  { name: "list_cards", description: "List the cards in the case (not discarded ones), optionally for one sub-goal.", parameters: params({ subgoal: idArg }), call: listCards },
  { name: "read_card", description: "Read one card: its rows, coverage, quality notes and the exact query behind it.", parameters: params({ card }, ["card"]), call: readCard },
  { name: "verify_card", description: "Re-run the query behind a card and say whether the result matches.", parameters: params({ card }, ["card"]), call: verifyCard },
];
