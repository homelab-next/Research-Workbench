import { pivotWeight } from "../../modules/manifests";
import { maxLookups } from "../../modules/playbooks";
import type { Json } from "../../core/canonical";
import type { ToolContext, ToolDef, ToolResult } from "./index";
import { idArg, json, MAX_HAVE, MAX_ID, params, str, ToolError } from "./kit";

/** A name from an untrusted root that is safe to show a model: a plain identifier, nothing a sentence could hide in. */
const PLAIN_NAME = /^[A-Za-z_][\w$.]{0,127}$/;
const plain = (x: string): boolean => PLAIN_NAME.test(x);

/** Whether the source's manifest came from a trusted root; only then is its free text shown to a model. */
const trusted = (ctx: ToolContext, dir: string): boolean => ctx.deps.registry.rootOf(dir)?.trusted === true;

const ok = (summary: string, view: Json): ToolResult => ({ ok: true, summary, view, marking: null });

async function listSources(ctx: ToolContext): Promise<ToolResult> {
  const sources = ctx.deps.registry.sources().map((s) => {
    const t = trusted(ctx, s.dir);
    return {
      id: s.id, title: t ? s.title : s.id, connector: s.connector, marking: s.marking, where: s.where, confirmed: s.confirmed, adhoc: s.adhoc,
      free: s.cost.weight === 0, unit: t || plain(s.cost.unit) ? s.cost.unit : "", quality: t ? s.quality : "", text_withheld: !t,
    };
  });
  return ok(`${sources.length} sources`, json({ sources }));
}

async function describeSource(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const id = str(args.source);
  const s = ctx.deps.registry.source(id);
  if (s === null) throw new ToolError(`unknown source: ${id}`);
  const t = trusted(ctx, s.dir);
  // a pivot may use only its own root's source unless both roots are trusted, so the source's root is the pivot's
  const pivots = ctx.deps.registry.pivots().filter((p) => p.source === s.id).map((p) => ({
    id: p.id, title: t ? p.title : p.id, from: p.from, to: p.to, free: pivotWeight(p, s) === 0, needs_window: p.needs_window, empty_means: p.empty_means,
  }));
  const view = {
    id: s.id, title: t ? s.title : s.id, marking: s.marking, confirmed: s.confirmed, adhoc: s.adhoc,
    cost: t ? s.cost : { weight: s.cost.weight, unit: plain(s.cost.unit) ? s.cost.unit : "" }, limits: s.limits,
    quality: t ? s.quality : "", quality_notes: t ? s.quality_notes.map((n) => ({ id: n.id, text: n.text, from: n.from, to: n.to })) : [],
    tables: s.tables.filter((x) => t || plain(x.name)).map((x) => ({
      name: x.name, time_column: t || x.time_column === null || plain(x.time_column) ? x.time_column : null,
      columns: x.columns.filter((c) => t || plain(c.name)).map((c) => ({ name: c.name, type: c.type })),
    })),
    pivots, text_withheld: !t,
  };
  return ok(`${s.title}: ${view.tables.length} tables, ${pivots.length} pivots`, json(view));
}

async function findRoutes(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const have = (args.have as { type: string }[]).map((h) => h.type);
  const routes = ctx.seeker.routes(have, str(args.want), ctx.limits);
  return ok(`${routes.length} routes`, json({ routes: routes.map((r) => ({ weight: r.weight, hops: r.hops })) }));
}

/** The playbooks a planner may name: playbooks come from trusted roots only, so their text is shown. May be planned when every lookup is free. */
async function listPlaybooks(ctx: ToolContext): Promise<ToolResult> {
  const { registry } = ctx.deps;
  const playbooks = registry.playbooks().map((p) => {
    const end = p.steps.find((s) => s.id === p.end[0]);
    return {
      id: p.id, title: p.title, about: p.about, inputs: p.inputs.map((i) => ({ name: i.name, type: i.type })),
      finds: end === undefined ? "" : registry.pivot(end.pivot)?.to ?? "", max_lookups: maxLookups(p), may_plan: registry.costlyPivots(p).length === 0,
    };
  });
  return ok(`${playbooks.length} playbooks`, json({ playbooks }));
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
  {
    name: "list_playbooks", description: "List the playbooks: fixed chains of lookups code runs with no model. Each says what it takes, the type it finds, and whether it may be planned.",
    parameters: params(), call: listPlaybooks,
  },
];
