import type { Json } from "../../core/canonical";
import { isPlainObject, parseJson } from "../../core/canonical";
import type { Schema } from "../../core/schema";
import { validate } from "../../core/schema";
import type { CaseSession } from "../../core/session";
import type { Actor, Marking, TimeWindow } from "../../core/types";
import type { RunnerDeps, RunQueryResult } from "../../modules/runner";
import type { Seeker, SeekLimits } from "../../modules/seeker";
import type { DraftWork } from "../draft";
import type { ToolSpec } from "../providers/types";
import { ANALYSIS_TOOLS } from "./analysis";
import { BUILDER_TOOLS } from "./builder";
import { CARD_TOOLS } from "./cards";
import { params, scrub, TOOL_VIEW_CHARS, ToolError, VIEW_ROWS } from "./kit";
import { PERSON_TOOLS } from "./person";
import { RESEARCH_TOOLS } from "./research";
import { SOURCE_TOOLS } from "./sources";

export { TOOL_VIEW_CHARS, ToolError, VIEW_ROWS };

const STAGE_TOOLS = ["list_sources", "describe_source", "find_routes", "list_playbooks", "run_step", "run_pivot", "run_query", "list_cards", "read_card", "verify_card",
  "propose_assessment", "propose_narrative", "request_research", "raise_challenge", "answer_challenge", "ask_person"] as const;
/** The loop builder's tools (slice 12, part B). In the fixed list so the agent loop runs them unchanged; a stage manifest may not list one. */
export const BUILDER_TOOL_NAMES = ["loop_catalogue", "adapter_catalogue", "list_connectors", "list_roots", "validate_manifest", "propose_change", "request_probe"] as const;
/** Every tool the agent loop knows: a stage's, then the builder's. */
export const TOOL_NAMES = [...STAGE_TOOLS, ...BUILDER_TOOL_NAMES] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
/** The sixteen tools a stage manifest may list. */
export const STAGE_TOOL_NAMES: readonly ToolName[] = STAGE_TOOLS;

/** A file the builder proposes: `path` relative to the write root, `/` separated. The shape of loop-write's ManifestFile, which src/agents may not import. */
export interface ManifestFile { path: string; text: string }
/** What a save's check says of a set of files: the shape of loop-write's ChangeCheck. */
export interface ChangeCheck { ok: boolean; problems: string[]; files: { path: string; kind: string; id: string; hash: string; before: string | null }[] }
/** A loop as the builder's catalogue shows it. */
export interface BuilderLoop {
  id: string; title: string; about: string; version: number | null; hash: string | null; usable: boolean; problems: string[];
  stages: { id: string; title: string; runs: string; gate: string | null; on_pass: string | null; on_fail: string | null; loop: string | null }[];
}
/** A root as the builder sees it: by its last path segment, never its path. */
export interface BuilderRoot { name: string; trusted: boolean; writable: boolean; credentials: string[]; imported: boolean }
/**
 * What the builder's tools read and check through. Set only by the builder's server code; every tool refuses without it ("this tool is the
 * loop builder's"). The functions read; `check` is checkChange and writes nothing in a root.
 */
export interface BuilderTools {
  loops(): BuilderLoop[];
  roots(): BuilderRoot[];
  /** The write root's name, as roots() names it. */
  root: string;
  /** A manifest file of the write root, scrubbed; null when there is none or it is not a manifest. */
  read(path: string): string | null;
  check(files: ManifestFile[]): ChangeCheck;
  /** The value of every secret the workbench holds: a file or a question that holds one is refused, and no view shows one. */
  secrets: readonly string[];
}

export interface ToolContext {
  session: CaseSession; deps: RunnerDeps; seeker: Seeker; actor: Extract<Actor, { kind: "agent" }>;
  link: { run: string | null; stage: string | null; job: string | null };
  /** The draft being assembled in an analysis stage, and the hash of the one under review in a review stage; null elsewhere. */
  draft: DraftWork | null; draft_hash: string | null;
  subgoal: string | null; window: TimeWindow; limits: SeekLimits;
  /** Set by the engine. Called when a costly step raised a proposal; returns the result if the person's plan budget ran it, else null. */
  onNeedsBudget?: (proposal: string, step: string | null) => Promise<RunQueryResult | null>;
  /** Set by Research when the workbench runs a step itself: the step is recorded as started by the workbench. */
  in_code?: boolean;
  /** At most this many unanswered questions to the person in a run (the config's questions.max_open); DEFAULT_MAX_OPEN when absent. */
  max_open_questions?: number;
  /** The loop builder's reader and check (slice 12, part B); absent everywhere but a builder session. */
  builder?: BuilderTools;
}
/** `view` is what the model is given; `marking` is the marking of any source data in it. */
export interface ToolResult { ok: boolean; summary: string; view: Json; marking: Marking | null }
export interface ToolDef {
  name: ToolName; description: string; parameters: Schema;
  /** The parameters in this context, when they depend on it (an enum read from the profile's standard); `parameters` otherwise. */
  parametersFor?(ctx: ToolContext): Schema;
  call(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult>;
  /** The text a refusal of this tool gives the model, from the reason (scrubbed): a drafting tool adds the draft's state. The reason alone when absent. */
  refused?(ctx: ToolContext, reason: string): string;
}
const parametersOf = (tool: ToolDef, ctx: ToolContext | undefined): Schema => (ctx !== undefined && tool.parametersFor !== undefined ? tool.parametersFor(ctx) : tool.parameters);

const unavailable = (name: ToolName): ToolDef => ({
  name, description: "Not available yet.", parameters: params(),
  call: async () => ({ ok: false, summary: "not available", view: { error: "not available" }, marking: null }),
});

const defs = new Map<string, ToolDef>([...SOURCE_TOOLS, ...RESEARCH_TOOLS, ...CARD_TOOLS, ...ANALYSIS_TOOLS, ...PERSON_TOOLS, ...BUILDER_TOOLS].map((t) => [t.name, t]));
export const TOOLS = Object.fromEntries(TOOL_NAMES.map((n) => [n, defs.get(n) ?? unavailable(n)])) as Record<ToolName, ToolDef>;

/** The specs a model is given; with the agent's context, each tool's parameters as they are in it. */
export function toolSpecs(names: readonly ToolName[], ctx?: ToolContext): ToolSpec[] {
  return names.map((n) => ({ name: n, description: TOOLS[n].description, parameters: parametersOf(TOOLS[n], ctx) }));
}

export interface ParsedCall { tool: ToolDef | null; name: string; args: Json; why: string; error: string | null }

export function parseCall(allowed: readonly ToolName[], name: string, argumentsText: string, ctx?: ToolContext): ParsedCall {
  const parsed = parseJson(argumentsText);
  const args: Json = parsed === null ? { _raw: argumentsText.slice(0, 2000) } : parsed.value;
  const why = isPlainObject(args) && typeof args.why === "string" && args.why !== "" ? args.why : "";
  const fail = (tool: ToolDef | null, error: string): ParsedCall => ({ tool, name, args, why, error });
  const known = (TOOL_NAMES as readonly string[]).includes(name);
  if (!known) return fail(null, `unknown tool: ${name}`);
  const tool = TOOLS[name as ToolName];
  if (!(allowed as readonly string[]).includes(name)) return fail(tool, `this stage may not use ${name}`);
  if (parsed === null) return fail(tool, "the arguments were not valid JSON");
  const errors = validate(parametersOf(tool, ctx), args);
  if (errors.length > 0) {
    const text = errors.slice(0, 3).map((e) => `${e.path.replace(/^\$\.?/, "") || "arguments"} ${e.message}`).join("; ");
    return fail(tool, `invalid arguments: ${text}`);
  }
  return { tool, name, args, why, error: null };
}

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;

/** Runs a parsed call. Never throws: an error, from the parse or from the tool, is a result the model can read. */
export async function execTool(ctx: ToolContext, parsed: ParsedCall): Promise<ToolResult> {
  const refuse = (reason: string): ToolResult => {
    const scrubbed = scrub(ctx.deps.registry, reason);
    const error = parsed.tool?.refused === undefined ? scrubbed : parsed.tool.refused(ctx, scrubbed);
    return { ok: false, summary: error, view: { error }, marking: null };
  };
  if (parsed.error !== null || parsed.tool === null) return refuse(parsed.error ?? `unknown tool: ${parsed.name}`);
  try {
    return await parsed.tool.call(ctx, parsed.args as Record<string, Json>);
  } catch (err) {
    return refuse(firstLine(err));
  }
}

const ROW_KEYS = ["rows", "data", "cards", "sources", "routes", "found", "kept", "incoming", "discarded"];

/** The view as JSON text, at most TOOL_VIEW_CHARS. The row list is halved until it fits; the record around it is never trimmed. */
export function viewText(result: ToolResult): string {
  const whole = JSON.stringify(result.view);
  if (whole.length <= TOOL_VIEW_CHARS) return whole;
  const tooBig = JSON.stringify({ truncated: true, error: "the result is too large to show" });
  if (!isPlainObject(result.view)) return tooBig;
  const view: Record<string, Json> = { ...(result.view as Record<string, Json>), truncated: true };
  for (;;) {
    const text = JSON.stringify(view);
    if (text.length <= TOOL_VIEW_CHARS) return text;
    const lists = Object.keys(view).filter((k) => Array.isArray(view[k]) && (view[k] as Json[]).length > 0);
    const rowLists = lists.filter((k) => ROW_KEYS.includes(k));
    const pool = rowLists.length > 0 ? rowLists : lists;
    if (pool.length === 0) return tooBig;
    const key = pool.reduce((a, b) => (JSON.stringify(view[b]).length > JSON.stringify(view[a]).length ? b : a));
    const list = view[key] as Json[];
    view[key] = list.slice(0, Math.floor(list.length / 2));
  }
}
