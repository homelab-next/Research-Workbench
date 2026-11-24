import type { Json } from "../core/canonical";
import { isPlainObject } from "../core/canonical";
import type { Schema } from "../core/schema";
import type { CardState, CaseState } from "../core/state/types";
import type { Marking } from "../core/types";
import { isMarking } from "../core/types";
import type { LoadedManifest, Registry } from "../modules/registry";

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextError";
  }
}

export interface PackPart { kind: string; id: string; title: string; text: string; marking: Marking | null; fixed: boolean }
export interface ProfileStage { agent: string; persona: string; goal: string; procedure: string | null; skills: string[]; references: string[]; gates: string[] }
export interface Profile { id: string; title: string; hash: string; rules: string; framework: string | null; standard: string | null; stages: Record<string, ProfileStage> }

const PREVIEW_ROWS = 10;

/** The manifest, from a trusted root only (the registry refuses these kinds elsewhere; this is the second lock). */
function trustedManifest(registry: Registry, kind: string, id: string): LoadedManifest {
  const m = registry.get(kind, id);
  if (m === null) throw new ContextError(`${kind} "${id}" was not found`);
  if (registry.rootOf(m.path)?.trusted !== true) throw new ContextError(`${kind} "${id}" comes from an untrusted root`);
  return m;
}

const str = (x: unknown): x is string => typeof x === "string" && x !== "";
const strList = (x: unknown): x is string[] => Array.isArray(x) && x.every(str);

export function loadProfile(registry: Registry, id: string): Profile {
  const m = trustedManifest(registry, "profile", id);
  const b = m.body;
  const bad = (why: string): never => { throw new ContextError(`profile "${id}": ${why}`); };
  if (!str(b.rules)) bad("rules must name a rules manifest");
  for (const k of ["framework", "standard"]) if (b[k] !== undefined && b[k] !== null && !str(b[k])) bad(`${k} must be an id or empty`);
  if (!isPlainObject(b.stages)) bad("stages must be a mapping");
  const stages: Record<string, ProfileStage> = {};
  for (const [name, raw] of Object.entries(b.stages as Record<string, Json>)) {
    if (!isPlainObject(raw)) return bad(`stage "${name}" must be a mapping`);
    const s = raw as Record<string, Json | undefined>;
    if (!str(s.agent) || !str(s.persona) || !str(s.goal)) return bad(`stage "${name}" needs agent, persona and goal`);
    if (s.procedure !== undefined && s.procedure !== null && !str(s.procedure)) return bad(`stage "${name}": procedure must be an id or empty`);
    for (const k of ["skills", "references", "gates"]) if (s[k] !== undefined && s[k] !== null && !strList(s[k])) return bad(`stage "${name}": ${k} must be a list of ids`);
    stages[name] = {
      agent: s.agent, persona: s.persona, goal: s.goal, procedure: (s.procedure as string | null | undefined) ?? null,
      skills: (s.skills as string[] | null | undefined) ?? [], references: (s.references as string[] | null | undefined) ?? [], gates: (s.gates as string[] | null | undefined) ?? [],
    };
  }
  return {
    id, title: m.title, hash: m.hash, rules: b.rules as string, framework: (b.framework as string | null | undefined) ?? null,
    standard: (b.standard as string | null | undefined) ?? null, stages,
  };
}

/** A manifest as a part: Markdown after the front matter, or the body as JSON for a YAML file. */
export function partOf(registry: Registry, kind: string, id: string, fixed = false): PackPart {
  const m = trustedManifest(registry, kind, id);
  const text = m.text !== null ? m.text : JSON.stringify(m.body, null, 2);
  if (text.trim() === "") throw new ContextError(`${kind} "${id}" has no text`);
  // a marking that is written but is not a known one is kept, so the pack counts it as the most restrictive
  const marking = isMarking(m.body.marking) ? m.body.marking : m.body.marking === undefined || m.body.marking === null ? null : (m.body.marking as never);
  return { kind, id, title: m.title, text, marking, fixed };
}

export function stageParts(registry: Registry, profile: Profile, stage: string, opts: { schema: string | null; objective: string | null }): PackPart[] {
  const s = profile.stages[stage];
  if (s === undefined) throw new ContextError(`profile "${profile.id}" has no stage "${stage}"`);
  const parts: PackPart[] = [partOf(registry, "rules", profile.rules, true), partOf(registry, "persona", s.persona)];
  parts.push({ kind: "goal", id: `${stage}-goal`, title: "Goal", text: s.goal, marking: null, fixed: false });
  if (s.procedure !== null) parts.push(partOf(registry, "procedure", s.procedure));
  for (const id of s.skills) parts.push(partOf(registry, "skill", id));
  if (opts.schema !== null) parts.push(partOf(registry, "schema", opts.schema, true));
  for (const id of s.references) parts.push(partOf(registry, "reference", id));
  for (const id of s.gates) parts.push(partOf(registry, "gate", id));
  if (opts.objective !== null) parts.push(partOf(registry, "objective", opts.objective));
  if (profile.framework !== null) parts.push(partOf(registry, "framework", profile.framework));
  if (profile.standard !== null) parts.push(partOf(registry, "standard", profile.standard));
  return parts;
}

export function casePart(state: Readonly<CaseState>): PackPart {
  const m = state.meta;
  if (m === null) throw new ContextError("the case has no record yet");
  const text = [
    `Case ${m.id}: ${m.title}`,
    `Asked: ${m.asked}`,
    `Why: ${m.why}`,
    `Starting from: ${m.starting.length === 0 ? "nothing" : m.starting.map((o) => `${o.type} ${o.value}`).join("; ")}`,
    `Window: ${m.window.from ?? "open"} to ${m.window.to ?? "open"}`,
  ].join("\n");
  return { kind: "case", id: m.id, title: "The case", text, marking: m.marking, fixed: true };
}

export function cardPart(card: CardState): PackPart {
  const cov = card.coverage === null ? "unknown" : card.coverage.kind === "full" ? "full" : `partial (${card.coverage.reason}${card.coverage.detail ? `: ${card.coverage.detail}` : ""})`;
  const rows = card.rows.slice(0, PREVIEW_ROWS).map((r) => JSON.stringify(r));
  const text = [
    `Card ${card.id}: ${card.title}`,
    card.body,
    `Source: ${card.source ?? "none"}`,
    `Coverage: ${cov}`,
    `Empty means: ${card.empty ?? "not stated"}`,
    `Columns: ${card.columns.join(", ")}`,
    `Rows (${Math.min(PREVIEW_ROWS, card.rows.length)} of ${card.row_count}):`,
    ...rows,
  ].join("\n");
  return { kind: "card", id: card.id, title: `Card ${card.id}: ${card.title}`, text, marking: card.marking, fixed: false };
}

export function schemaOf(registry: Registry, id: string): Schema {
  const m = trustedManifest(registry, "schema", id);
  if (!isPlainObject(m.body.schema)) throw new ContextError(`schema "${id}" has no schema`);
  return m.body.schema as unknown as Schema;
}
