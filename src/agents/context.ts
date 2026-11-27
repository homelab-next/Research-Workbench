import type { Json } from "../core/canonical";
import { isPlainObject } from "../core/canonical";
import type { Schema } from "../core/schema";
import type { CardState, CaseState } from "../core/state/types";
import { BASIS_TEXT, PERSON_SOURCE } from "../core/state/person";
import type { Entry, Marking, PersonStatement } from "../core/types";
import { isMarking, strictest } from "../core/types";
import type { LoadedManifest, Registry } from "../modules/registry";
import { scrub, scrubCoverage } from "./tools/kit";

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextError";
  }
}

export interface PackPart { kind: string; id: string; title: string; text: string; marking: Marking | null; fixed: boolean }
export interface ProfileStage { agent: string; persona: string; goal: string; procedure: string | null; skills: string[]; references: string[]; gates: string[] }
export interface Profile { id: string; title: string; hash: string; marking: Marking | null; rules: string; framework: string | null; standard: string | null; stages: Record<string, ProfileStage> }

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
    id, title: m.title, hash: m.hash, marking: markingOf(m), rules: b.rules as string, framework: (b.framework as string | null | undefined) ?? null,
    standard: (b.standard as string | null | undefined) ?? null, stages,
  };
}

/** A written marking is kept even when unknown, so the pack counts it as the most restrictive; none written is null. */
function markingOf(m: LoadedManifest): Marking | null {
  const x = m.body.marking;
  return isMarking(x) ? x : x === undefined || x === null ? null : (x as never);
}

/** A manifest as a part: Markdown after the front matter, or the body as JSON for a YAML file. */
export function partOf(registry: Registry, kind: string, id: string, fixed = false): PackPart {
  const m = trustedManifest(registry, kind, id);
  const text = m.text !== null ? m.text : JSON.stringify(m.body, null, 2);
  if (text.trim() === "") throw new ContextError(`${kind} "${id}" has no text`);
  return { kind, id, title: m.title, text, marking: markingOf(m), fixed };
}

export function stageParts(registry: Registry, profile: Profile, stage: string, opts: { schema: string | null; objective: string | null; narrow?: (s: Schema) => Schema }): PackPart[] {
  const s = profile.stages[stage];
  if (s === undefined) throw new ContextError(`profile "${profile.id}" has no stage "${stage}"`);
  // what the profile's own marking covers: its rules and its goals
  const rules = partOf(registry, "rules", profile.rules, true);
  if (profile.marking !== null) rules.marking = rules.marking === null ? profile.marking : strictest(rules.marking, profile.marking);
  const parts: PackPart[] = [rules, partOf(registry, "persona", s.persona)];
  parts.push({ kind: "goal", id: `${stage}-goal`, title: "Goal", text: s.goal, marking: profile.marking, fixed: false });
  if (s.procedure !== null) parts.push(partOf(registry, "procedure", s.procedure));
  for (const id of s.skills) parts.push(partOf(registry, "skill", id));
  if (opts.schema !== null) parts.push(schemaPart(registry, opts.schema, opts.narrow));
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

/** A card, or text a model (or a person) wrote, that is to become a pack part. */
export type PartFrom =
  | { card: CardState; registry: Registry }
  | {
    kind: string; id: string; title: string; text: string; fixed: boolean;
    /** The ledger the text was written into. */
    entries: readonly Entry[];
    /**
     * The entries that hold the text: a model request, or an entry an agent wrote while answering one (whose request is the agent's latest before
     * it). An entry by a person or the system adds no model's marking.
     */
    written_by: readonly Entry[];
    /** A marking the part has whatever wrote it (the product's own, for text about a draft); null for none. */
    floor: Marking | null;
  };

/** The model request an agent was answering when it wrote this entry: the entry itself when it is one, else its latest request before it. */
function requestBehind(entries: readonly Entry[], e: Entry): Extract<Entry, { type: "model.request" }> | null {
  if (e.type === "model.request") return e;
  const a = e.actor;
  if (a.kind !== "agent") return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const x = entries[i]!;
    if (x.seq < e.seq && x.type === "model.request" && x.actor.kind === "agent" && x.actor.id === a.id && x.actor.stage === a.stage) return x;
  }
  throw new ContextError(`what ${a.id} wrote at entry ${e.seq} has no model request before it, so its marking is not known`);
}

/** A statement by the person as a part: their word, how they know it, what it is about and the question it answers; no coverage, columns or rows. */
function statementPart(card: CardState, p: PersonStatement, registry: Registry): PackPart {
  const title = scrub(registry, card.title);
  const how = p.detail === "" ? BASIS_TEXT[p.basis] : `${BASIS_TEXT[p.basis]}: ${scrub(registry, p.detail)}`;
  const text = [
    `Card ${card.id}: ${title}`,
    scrub(registry, card.body),
    `Source: ${PERSON_SOURCE} (${how}). A statement by the person running the investigation, not data from a source.`,
    ...(p.about.length === 0 ? [] : [`About: ${p.about.map((o) => `${o.type} ${scrub(registry, o.value)}`).join(", ")}`]),
    ...(p.answers === null ? [] : [`Answers: ${p.answers}`]),
  ].join("\n");
  return { kind: "card", id: card.id, title: `Card ${card.id}: ${title}`, text, marking: card.marking, fixed: false };
}

/** A card's extracted values are shown to a model at most this many at a time (in the pack, read_card and a lookup's result); the rest are counted. */
export const EXTRACTED_SHOWN = 20;

/** What the workbench extracted from a card's cells, as the pack lists it: code-derived values a model may pivot from; none when there are none. */
export function extractedLines(card: CardState): string[] {
  if (card.extracted === undefined || card.extracted.length === 0) return [];
  const more = card.extracted.length - EXTRACTED_SHOWN;
  return [
    "Extracted by the workbench (code-derived, from the field notes):",
    ...card.extracted.slice(0, EXTRACTED_SHOWN).map((x) => `- ${x.type} ${x.value} (rule ${x.rule} on column ${x.column}, row ${x.row + 1})`),
    ...(more > 0 ? [`and ${more} more extracted values, not listed`] : []),
  ];
}

/** A card's extracted values as a tool's view holds them: at most EXTRACTED_SHOWN, and how many more; nothing when there are none. */
export function extractedView(card: CardState): { extracted?: Json; extracted_more?: number } {
  if (card.extracted === undefined) return {};
  const more = card.extracted.length - EXTRACTED_SHOWN;
  return { extracted: card.extracted.slice(0, EXTRACTED_SHOWN).map((x) => ({ ...x })) as unknown as Json, ...(more > 0 ? { extracted_more: more } : {}) };
}

/**
 * The only way a card or text a model wrote becomes a pack part. A card's title, body and coverage detail are scrubbed as the tools scrub them
 * (a location, user or credential never reaches a model) and it carries the card's marking. Text a model wrote carries the marking of the model
 * request it answered, which covers everything that model had seen: text written after reading a stricter card is as strict as that card.
 */
export function packPart(from: PartFrom): PackPart {
  if ("card" in from) {
    const { card, registry } = from;
    if (card.person !== undefined) return statementPart(card, card.person, registry);
    const coverage = scrubCoverage(registry, card.coverage);
    const cov = coverage === null ? "unknown" : coverage.kind === "full" ? "full" : `partial (${coverage.reason}${coverage.detail ? `: ${coverage.detail}` : ""})`;
    const title = scrub(registry, card.title);
    const rows = card.rows.slice(0, PREVIEW_ROWS).map((r) => JSON.stringify(r));
    const text = [
      `Card ${card.id}: ${title}`,
      scrub(registry, card.body),
      `Source: ${card.source ?? "none"}`,
      `Coverage: ${cov}`,
      `Empty means: ${card.empty ?? "not stated"}`,
      `Columns: ${card.columns.join(", ")}`,
      `Rows (${Math.min(PREVIEW_ROWS, card.rows.length)} of ${card.row_count}):`,
      ...rows,
      ...extractedLines(card),
    ].join("\n");
    return { kind: "card", id: card.id, title: `Card ${card.id}: ${title}`, text, marking: card.marking, fixed: false };
  }
  const markings: Marking[] = from.floor === null ? [] : [from.floor];
  for (const e of from.written_by) {
    const req = requestBehind(from.entries, e);
    if (req !== null) markings.push(req.payload.marking);
  }
  return { kind: from.kind, id: from.id, title: from.title, text: from.text, marking: markings.length === 0 ? null : strictest(...markings), fixed: from.fixed };
}

export function schemaOf(registry: Registry, id: string): Schema {
  const m = trustedManifest(registry, "schema", id);
  if (!isPlainObject(m.body.schema)) throw new ContextError(`schema "${id}" has no schema`);
  return m.body.schema as unknown as Schema;
}

/** The line before a stage's output schema: the model is to reply with an instance, not copy the schema. */
export const SCHEMA_LEAD = "Reply with one JSON object that matches this schema — not the schema itself.";

/**
 * A small instance of the schema to show its shape: an object's required fields only, the first enum or const value, the first
 * anyOf branch, the first listed type, arrays at their fewest items, strings at their least length, numbers at their minimum.
 * A `pattern` is not generated for, so an example of a schema with one may not match it.
 */
export function exampleOf(schema: Schema): Json {
  if (schema.const !== undefined) return schema.const as Json;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0] as Json;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) return exampleOf(schema.anyOf[0]!);
  const t = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (t ?? (schema.properties !== undefined ? "object" : schema.items !== undefined ? "array" : null)) {
    case "object": {
      const out: Record<string, Json> = {};
      for (const k of schema.required ?? []) out[k] = exampleOf(schema.properties?.[k] ?? {});
      return out;
    }
    case "array": return Array.from({ length: schema.minItems ?? 0 }, () => exampleOf(schema.items ?? {}));
    case "string": return "x".repeat(schema.minLength ?? 0);
    case "number":
    case "integer": return schema.minimum ?? 0;
    case "boolean": return false;
    default: return null;
  }
}

/** A stage's output schema as a part: the lead line, the JSON Schema body alone (never the manifest's kind, id and title), and an example. */
export function schemaPart(registry: Registry, id: string, narrow?: (s: Schema) => Schema): PackPart {
  const m = trustedManifest(registry, "schema", id);
  const schema = narrow === undefined ? schemaOf(registry, id) : narrow(schemaOf(registry, id));
  const text = `${SCHEMA_LEAD}\n${JSON.stringify(schema, null, 2)}\nExample:\n${JSON.stringify(exampleOf(schema))}`;
  return { kind: "schema", id, title: m.title, text, marking: markingOf(m), fixed: true };
}
