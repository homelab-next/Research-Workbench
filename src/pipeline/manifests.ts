import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { sha256Hex } from "../core/hash";
import type { Schema } from "../core/schema";
import { validate } from "../core/schema";
import { GATES, STAGE_RUNS } from "../core/types";
import type { StageDef } from "../core/types";
import { describeErrors, parseManifestFile } from "../modules/manifests";
import type { LoadedManifest } from "../modules/manifests";
import type { Registry } from "../modules/registry";
import { staysInside } from "../modules/registry";
import { TOOL_NAMES } from "../agents/tools";
import type { ToolName } from "../agents/tools";
import { SAMPLING_SCHEMA } from "../agents/providers/sampling";
import type { Sampling } from "../agents/providers/types";
import { requestExtraProblem } from "../agents/providers/extra";
import type { RequestExtra } from "../agents/providers/extra";

export const ROLES = ["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"] as const;
export type Role = (typeof ROLES)[number];

export interface StageManifest extends StageDef { hash: string; order: number; role: Role; tools: ToolName[]; schema: string | null; on_pass: string | null; on_fail: string | null;
  /** This stage's own sampling and output limit; each wins over the model manifest's. */
  sampling?: Sampling | null; max_output_tokens?: number | null;
  /** Extra fields this stage's requests add to the chat body; each wins over the model manifest's, key by key. */
  request_extra?: RequestExtra | null;
  /** The most turns this stage's agent has (the loop's MAX_TURNS when null). */
  max_turns?: number | null;
  /** An optional fast model for this stage's tool-choosing turns; null (the default) means the stage's model takes every turn. */
  fast_model?: { provider: string; model: string; effort: string | null } | null }
export interface Pipeline { id: string; hash: string; stages: StageManifest[] }

const nullableString: Schema = { type: ["string", "null"] };
const MODEL_CHOICE_SCHEMA: Schema = {
  type: "object", additionalProperties: false, required: ["provider", "model"],
  properties: { provider: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, effort: nullableString },
};
const STAGE_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "order", "runs", "role"],
  properties: {
    kind: { type: "string", enum: ["stage"] },
    id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    order: { type: "number" },
    phase: nullableString,
    runs: { type: "string", enum: [...STAGE_RUNS] },
    role: { type: "string" },
    gate: { anyOf: [{ type: "null" }, { type: "string", enum: [...GATES] }] },
    reviews: { type: "boolean" },
    tools: { type: ["array", "null"], items: { type: "string" } },
    schema: nullableString,
    model: {
      anyOf: [
        { type: "null" },
        {
          type: "object", additionalProperties: false, required: ["provider", "model"],
          properties: { provider: { type: "string", minLength: 1 }, model: { type: "string", minLength: 1 }, effort: nullableString },
        },
      ],
    },
    fast_model: { anyOf: [{ type: "null" }, MODEL_CHOICE_SCHEMA] },
    on_pass: nullableString,
    on_fail: nullableString,
    sampling: { anyOf: [{ type: "null" }, SAMPLING_SCHEMA] },
    max_output_tokens: { anyOf: [{ type: "null" }, { type: "integer", minimum: 1 }] },
    max_turns: { anyOf: [{ type: "null" }, { type: "integer", minimum: 1 }] },
    request_extra: { anyOf: [{ type: "null" }, { type: "object" }] },
  },
};

type Body = {
  id: string; title?: string; order: number; phase?: string | null; runs: StageDef["runs"]; role: string; gate?: StageDef["gate"]; reviews?: boolean;
  tools?: string[] | null; schema?: string | null; model?: { provider: string; model: string; effort?: string | null } | null; on_pass?: string | null; on_fail?: string | null;
  sampling?: Sampling | null; max_output_tokens?: number | null; max_turns?: number | null; request_extra?: RequestExtra | null;
  fast_model?: { provider: string; model: string; effort?: string | null } | null;
};

/** One manifest as a stage, or the reason it cannot be used. */
function toStage(m: LoadedManifest, registry: Registry): StageManifest | string {
  if (registry.rootOf(m.path)?.trusted !== true) return "a stage manifest is accepted only from a trusted root";
  const errors = validate(STAGE_SCHEMA, m.body as Json);
  if (errors.length > 0) return describeErrors(errors);
  const b = m.body as unknown as Body;
  if (!(ROLES as readonly string[]).includes(b.role)) return `role "${b.role}" is not one of ${ROLES.join(", ")}`;
  const tools = b.tools ?? [];
  const unknown = tools.find((t) => !(TOOL_NAMES as readonly string[]).includes(t));
  if (unknown !== undefined) return `tool "${unknown}" is not in the fixed tool list`;
  const model = b.model == null ? null : { provider: b.model.provider, model: b.model.model, effort: b.model.effort ?? null };
  if (b.runs === "agent" && model === null) return "a stage that runs an agent needs a model";
  if (b.request_extra !== undefined && b.request_extra !== null) {
    const problem = requestExtraProblem(b.request_extra);
    if (problem !== null) return problem;
  }
  return {
    id: b.id, title: b.title ?? m.title, phase: b.phase ?? null, runs: b.runs, gate: b.gate ?? null, reviews: b.reviews ?? false, model,
    hash: m.hash, order: b.order, role: b.role as Role, tools: tools as ToolName[], schema: b.schema ?? null, on_pass: b.on_pass ?? null, on_fail: b.on_fail ?? null,
    sampling: b.sampling ?? null, max_output_tokens: b.max_output_tokens ?? null, max_turns: b.max_turns ?? null,
    request_extra: b.request_extra ?? null,
    fast_model: b.fast_model == null ? null : { provider: b.fast_model.provider, model: b.fast_model.model, effort: b.fast_model.effort ?? null },
  };
}

/**
 * The pipeline from every `stage` manifest of the registry. A manifest that cannot be used is left out with a problem; the pipeline is
 * null, with a problem saying why, when what is left does not make a whole pipeline.
 */
export function loadPipeline(registry: Registry): { pipeline: Pipeline | null; problems: string[] } {
  const problems: string[] = [];
  const stages: StageManifest[] = [];
  for (const m of registry.all("stage")) {
    const made = toStage(m, registry);
    if (typeof made === "string") problems.push(`stage "${m.id}" (${m.path}): ${made}`);
    else stages.push(made);
  }
  stages.sort((a, b) => a.order - b.order);
  const refuse = (why: string): { pipeline: null; problems: string[] } => ({ pipeline: null, problems: [...problems, why] });

  if (stages.length === 0) return refuse("no stage manifest could be used: there is no stage");
  for (let i = 1; i < stages.length; i++) {
    if (stages[i]!.order === stages[i - 1]!.order) return refuse(`stages "${stages[i - 1]!.id}" and "${stages[i]!.id}" share order ${stages[i]!.order}`);
  }
  const ids = new Set(stages.map((s) => s.id));
  for (const s of stages) {
    for (const edge of ["on_pass", "on_fail"] as const) {
      if (s[edge] !== null && !ids.has(s[edge]!)) return refuse(`stage "${s.id}": ${edge} names "${s[edge]}", which is not a stage`);
    }
  }
  for (const start of stages) {
    const walked = [start.id];
    for (let at = start.on_pass; at !== null; at = stages.find((x) => x.id === at)!.on_pass) {
      walked.push(at);
      if (at === start.id) return refuse(`on_pass cycle: ${walked.join(" > ")}`);
      if (walked.indexOf(at) !== walked.length - 1) break; // a cycle that does not return to start is reported from its own members
    }
  }
  for (const gate of GATES) {
    const n = stages.filter((s) => s.gate === gate).length;
    if (n !== 1) return refuse(`there must be exactly one stage for gate ${gate}; there are ${n}`);
  }
  const reviewing = stages.filter((s) => s.reviews);
  if (reviewing.length === 0) return refuse("no stage has reviews: true; there must be at least one review stage");
  const publish = stages.find((s) => s.gate === "publish")!;
  const late = reviewing.find((s) => s.order > publish.order);
  if (late !== undefined) return refuse(`the publish stage "${publish.id}" comes before the review stage "${late.id}"`);

  const hash = sha256Hex(canonical(stages.map((s): Json => [s.id, s.hash])));
  return { pipeline: { id: "default", hash, stages }, problems };
}

export interface CheckManifest {
  id: string; title: string; order: number; hash: string; path: string; script: string; runner: "bun" | "exec"; timeout_ms: number;
  /** False for a check whose failure is noted rather than sent back; true unless the manifest says `blocking: false`. */
  blocking: boolean;
}

const CHECK_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "order", "script", "runner", "timeout_ms"],
  properties: {
    kind: { type: "string", enum: ["check"] },
    id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    order: { type: "number" },
    script: { type: "string", minLength: 1 },
    runner: { type: "string", enum: ["bun", "exec"] },
    timeout_ms: { type: "number" },
    blocking: { type: "boolean" },
  },
};

/** The checks a registry holds that may run: from trusted roots only, each with a script that is a plain file inside its own folder. Others are left out with a problem. */
export function loadChecks(registry: Registry): { checks: CheckManifest[]; problems: string[]; broken: { id: string; problem: string }[] } {
  const problems: string[] = [];
  const checks: CheckManifest[] = [];
  /** Checks a trusted root declares that cannot run: the Checks stage does not pass while any is here. No absolute path is named. */
  const broken: { id: string; problem: string }[] = [];
  for (const m of registry.all("check")) {
    const root = registry.rootOf(m.path);
    if (root?.trusted !== true) { problems.push(`check ${m.id} is in a root that is not trusted for scripts; it will not run`); continue; }
    const bad = (problem: string): void => { problems.push(`check ${m.id}: ${problem}`); broken.push({ id: m.id, problem }); };
    const errors = validate(CHECK_SCHEMA, m.body as Json);
    if (errors.length > 0) { problems.push(`check ${m.id} (${m.path}): ${describeErrors(errors)}`); broken.push({ id: m.id, problem: describeErrors(errors) }); continue; }
    const b = m.body as unknown as { script: string; order: number; runner: "bun" | "exec"; timeout_ms: number; title?: string; blocking?: boolean };
    if (!(b.timeout_ms > 0) || !Number.isFinite(b.timeout_ms)) { bad("timeout_ms must be a positive number"); continue; }
    const plain = b.script === basename(b.script) && b.script !== "." && b.script !== ".." && !isAbsolute(b.script) && !/[\\/]/.test(b.script);
    if (!plain) { bad(`script "${b.script}" must be a plain file name in the manifest's folder`); continue; }
    const file = join(dirname(m.path), b.script);
    if (!staysInside(root.path, file)) { bad(`script "${b.script}" is outside the module root`); continue; }
    if (!existsSync(file) || !statSync(file).isFile()) { bad(`script "${b.script}" is missing`); continue; }
    checks.push({ id: m.id, title: b.title ?? m.title, order: b.order, hash: m.hash, path: m.path, script: b.script, runner: b.runner, timeout_ms: b.timeout_ms, blocking: b.blocking !== false });
  }
  // a check manifest in a trusted root that the registry itself refused (its id is taken, its body is invalid) is broken too, recognised by its
  // parsed kind. A file that cannot be parsed at all counts when its folder holds another check manifest, so an unreadable check cannot drop out.
  const checkDirs = new Set(registry.all("check").map((m) => dirname(m.path)));
  const unparsed: { p: (typeof registry.problems)[number]; text: string | null }[] = [];
  const idsBroken = new Set(broken.map((x) => x.id));
  for (const p of registry.problems) {
    if (registry.rootOf(p.path)?.trusted !== true) continue;
    let bytes: Uint8Array;
    try { bytes = readFileSync(p.path); } catch { continue; }
    const what = `${relative(p.root, p.path)}: ${p.error.split(p.root).join("")}`;
    let parsed: ReturnType<typeof parseManifestFile>;
    try {
      parsed = parseManifestFile(p.path, bytes);
    } catch {
      unparsed.push({ p, text: new TextDecoder().decode(bytes) });
      continue;
    }
    if (parsed.kind !== "check") continue;
    checkDirs.add(dirname(p.path));
    const id = typeof parsed.body.id === "string" && parsed.body.id !== "" ? parsed.body.id : basename(p.path).replace(/\.[^.]*$/, "");
    if (idsBroken.has(id)) continue;
    idsBroken.add(id);
    broken.push({ id, problem: what });
  }
  for (const { p, text } of unparsed) {
    if (!checkDirs.has(dirname(p.path))) continue;
    const id = /^id:\s*["']?([^"'\s]+)/m.exec(text ?? "")?.[1] ?? basename(p.path).replace(/\.[^.]*$/, "");
    if (idsBroken.has(id)) continue;
    idsBroken.add(id);
    broken.push({ id, problem: `${relative(p.root, p.path)}: ${p.error.split(p.root).join("")}` });
  }
  checks.sort((a, b) => a.order - b.order);
  return { checks, problems, broken };
}
