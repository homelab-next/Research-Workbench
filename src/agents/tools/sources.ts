import { pivotWeight } from "../../modules/manifests";
import type { Json } from "../../core/canonical";
import type { ToolContext, ToolDef, ToolResult } from "./index";
import { idArg, json, MAX_HAVE, MAX_ID, params, str, ToolError } from "./kit";

const ok = (summary: string, view: Json): ToolResult => ({ ok: true, summary, view, marking: null });

async function listSources(ctx: ToolContext): Promise<ToolResult> {
  const sources = ctx.deps.registry.sources().map((s) => ({
    id: s.id, title: s.title, connector: s.connector, marking: s.marking, where: s.where, confirmed: s.confirmed, adhoc: s.adhoc,
    free: s.cost.weight === 0, unit: s.cost.unit, quality: s.quality,
  }));
  return ok(`${sources.length} sources`, json({ sources }));
}

async function describeSource(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const id = str(args.source);
  const s = ctx.deps.registry.source(id);
  if (s === null) throw new ToolError(`unknown source: ${id}`);
  const pivots = ctx.deps.registry.pivots().filter((p) => p.source === s.id).map((p) => ({
    id: p.id, title: p.title, from: p.from, to: p.to, free: pivotWeight(p, s) === 0, needs_window: p.needs_window, empty_means: p.empty_means,
  }));
  const view = {
    id: s.id, title: s.title, marking: s.marking, confirmed: s.confirmed, adhoc: s.adhoc, cost: s.cost, limits: s.limits,
    quality: s.quality, quality_notes: s.quality_notes.map((n) => ({ id: n.id, text: n.text, from: n.from, to: n.to })),
    tables: s.tables.map((t) => ({ name: t.name, time_column: t.time_column, columns: t.columns.map((c) => ({ name: c.name, type: c.type })) })),
    pivots,
  };
  return ok(`${s.title}: ${view.tables.length} tables, ${pivots.length} pivots`, json(view));
}

async function findRoutes(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const have = (args.have as { type: string }[]).map((h) => h.type);
  const routes = ctx.seeker.routes(have, str(args.want), ctx.limits);
  return ok(`${routes.length} routes`, json({ routes: routes.map((r) => ({ weight: r.weight, hops: r.hops })) }));
}

export const SOURCE_TOOLS: ToolDef[] = [
  { name: "list_sources", description: "List the sources you may use, with their marking, whether they are free and how reliable they are.", parameters: params(), call: listSources },
  {
    name: "describe_source", description: "Describe one source: its tables, columns, limits, quality notes and the pivots that use it.",
    parameters: params({ source: idArg }, ["source"]), call: describeSource,
  },
  {
    name: "find_routes", description: "Find chains of pivots from observable types you have to a type you want. Contacts no source.",
    parameters: params({
      have: { type: "array", minItems: 1, maxItems: MAX_HAVE, items: { type: "object", additionalProperties: false, required: ["type", "value"], properties: { type: idArg, value: { type: "string", maxLength: MAX_ID } } } },
      want: idArg,
    }, ["have", "want"]),
    call: findRoutes,
  },
];
