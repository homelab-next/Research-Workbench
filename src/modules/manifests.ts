import type { Json } from "../core/canonical";
import { canonical, CanonicalError, isPlainObject } from "../core/canonical";
import { validate } from "../core/schema";
import type { Schema } from "../core/schema";
import { EMPTY_MEANS, MARKINGS, WHERES } from "../core/types";
import type { Marking, Where } from "../core/types";
import type { ObservableType } from "./observables";
import { INVENTORY_SCHEMA } from "./inventories";
import { PLAYBOOK_SCHEMA } from "./playbooks";

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export interface LoadedManifest {
  kind: string; id: string; title: string; hash: string; root: string; path: string; dir: string;
  body: Record<string, Json>; text: string | null;
}
export interface QualityNote { id: string; text: string; from: string | null; to: string | null }
export interface TableManifest {
  name: string; time_column: string | null; guarded: boolean; large_columns: string[]; file: string | null;
  format: "csv" | "jsonl" | null; columns: { name: string; type: string | null }[];
}
export interface EndpointManifest { name: string; method: "GET" | "POST"; path: string; read: boolean; rows: string; columns: string[] }
export interface SourceManifest {
  id: string; title: string; hash: string; dir: string; root: string; connector: "sql" | "files" | "http" | "trino"; location: string;
  credential: string | null; user: string | null; tls_verify: boolean; marking: Marking; where: Where; confirmed: boolean; adhoc: boolean;
  cost: { weight: number; unit: string }; limits: { max_rows: number; timeout_ms: number };
  quality: string; quality_notes: QualityNote[]; tables: TableManifest[]; endpoints: EndpointManifest[];
}
export interface PivotManifest {
  id: string; title: string; hash: string; from: string; to: string; source: string; query: string; needs_window: boolean;
  weight: number | null; empty_means: "proven-negative" | "not-seen"; yields: Record<string, string>;
  /** The inventory the pivot looks the value up in, if any; its completeness decides what an empty answer means. */
  inventory: string | null;
}

const str: Schema = { type: "string" };
const name: Schema = { type: "string", minLength: 1 };
const nullableStr: Schema = { type: ["string", "null"] };
const strings: Schema = { type: "array", items: str };

export const SOURCE_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "title", "connector", "location", "marking", "where"],
  properties: {
    kind: { const: "source" },
    id: name,
    title: name,
    connector: { type: "string", enum: ["sql", "files", "http", "trino"] },
    location: name,
    credential: nullableStr,
    user: nullableStr,
    tls_verify: { type: "boolean" },
    marking: { type: "string", enum: [...MARKINGS] },
    where: { type: "string", enum: [...WHERES] },
    confirmed: { type: "boolean" },
    adhoc: { type: "boolean" },
    cost: {
      type: "object", additionalProperties: false, required: ["weight"],
      properties: { weight: { type: "number", minimum: 0 }, unit: name },
    },
    limits: {
      type: "object", additionalProperties: false,
      properties: { max_rows: { type: "integer", minimum: 1 }, timeout_ms: { type: "integer", minimum: 1 } },
    },
    quality: str,
    quality_notes: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "text"],
        properties: { id: name, text: str, from: nullableStr, to: nullableStr },
      },
    },
    tables: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["name"],
        properties: {
          name,
          time_column: nullableStr,
          guarded: { type: "boolean" },
          large_columns: strings,
          file: nullableStr,
          format: { type: ["string", "null"], enum: ["csv", "jsonl", null] },
          columns: {
            type: "array",
            items: { type: "object", additionalProperties: false, required: ["name"], properties: { name, type: nullableStr } },
          },
        },
      },
    },
    endpoints: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["name", "method", "path"],
        properties: { name, method: { type: "string", enum: ["GET", "POST"] }, path: str, read: { type: "boolean" }, rows: str, columns: strings },
      },
    },
  },
};

export const TYPES_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "types"],
  properties: {
    kind: { const: "types" },
    types: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["id", "pattern"], properties: { id: name, title: name, pattern: str } },
    },
  },
};

export const PIVOTS_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "pivots"],
  properties: {
    kind: { const: "pivots" },
    pivots: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "from", "to", "source", "query"],
        properties: {
          id: name, title: name, from: name, to: name, source: name, query: name,
          needs_window: { type: "boolean" },
          weight: { type: ["number", "null"], minimum: 0 },
          empty_means: { type: "string", enum: [...EMPTY_MEANS] },
          yields: { type: "object", additionalProperties: str },
          inventory: name,
        },
      },
    },
  },
};

const FRONT_MATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

function parseYaml(text: string): unknown {
  try {
    return Bun.YAML.parse(text);
  } catch (err) {
    throw new ManifestError(`not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
}

/** Reads a manifest file: YAML, or Markdown whose front matter is the manifest and whose remainder is the text. */
export function parseManifestFile(path: string, bytes: Uint8Array): { kind: string; body: Record<string, Json>; text: string | null } {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ManifestError("not valid UTF-8 text");
  }
  let yaml = source;
  let text: string | null = null;
  if (/\.md$/i.test(path)) {
    const m = FRONT_MATTER.exec(source.replace(/^﻿/, ""));
    if (m === null) throw new ManifestError("a markdown manifest must start with YAML front matter between --- lines");
    yaml = m[1] ?? "";
    text = source.replace(/^﻿/, "").slice(m[0].length);
  }
  const parsed = parseYaml(yaml);
  if (!isPlainObject(parsed)) throw new ManifestError("must be a mapping with a kind");
  if (typeof parsed.kind !== "string" || parsed.kind === "") throw new ManifestError("missing or invalid kind");
  try {
    canonical(parsed as Json);
  } catch (err) {
    throw new ManifestError(`not plain JSON data: ${err instanceof CanonicalError ? err.message : "unsupported value"}`);
  }
  return { kind: parsed.kind, body: parsed as Record<string, Json>, text };
}

/** A schema error list as one line, naming each field. */
export function describeErrors(errors: { path: string; message: string }[]): string {
  return errors.slice(0, 3).map(e => `${e.path.replace(/^\$\.?/, "") || "manifest"}: ${e.message}`).join("; ");
}

/** Checks a whole file's body against the schema for its kind. Returns null for kinds that are not validated here. */
export function schemaFor(kind: string): Schema | null {
  return kind === "source" ? SOURCE_SCHEMA : kind === "types" ? TYPES_SCHEMA : kind === "pivots" ? PIVOTS_SCHEMA : kind === "playbook" ? PLAYBOOK_SCHEMA
    : kind === "inventory" ? INVENTORY_SCHEMA : null;
}

/** Drops object keys that were written with nothing after them, at any depth, so they take their defaults. */
export function withoutNulls(value: Json): Json {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value as Record<string, Json>).filter(([, v]) => v !== null).map(([k, v]) => [k, withoutNulls(v)]));
  }
  return value;
}

export function validateBody(kind: string, body: Record<string, Json>): Record<string, Json> {
  const schema = schemaFor(kind);
  if (schema === null) return body;
  const cleaned = withoutNulls(body) as Record<string, Json>;
  const errors = validate(schema, cleaned);
  if (errors.length > 0) throw new ManifestError(describeErrors(errors));
  return cleaned;
}

/** Builds a source from a validated body, filling the defaults. */
export function toSource(body: Record<string, Json>, hash: string, dir: string, root: string): SourceManifest {
  const b = body as Record<string, any>; // validated against SOURCE_SCHEMA by the caller
  return {
    id: b.id, title: b.title, hash, dir, root, connector: b.connector, location: b.location,
    credential: b.credential ?? null, user: b.user ?? null, tls_verify: b.tls_verify ?? true,
    marking: b.marking, where: b.where, confirmed: b.confirmed ?? true, adhoc: b.adhoc ?? false,
    cost: { weight: b.cost?.weight ?? 0, unit: b.cost?.unit ?? "seconds" },
    limits: { max_rows: b.limits?.max_rows ?? 500, timeout_ms: b.limits?.timeout_ms ?? 10000 },
    quality: b.quality ?? "",
    quality_notes: (b.quality_notes ?? []).map((n: any): QualityNote => ({ id: n.id, text: n.text, from: n.from ?? null, to: n.to ?? null })),
    tables: (b.tables ?? []).map((t: any): TableManifest => ({
      name: t.name, time_column: t.time_column ?? null, guarded: t.guarded ?? false, large_columns: t.large_columns ?? [],
      file: t.file ?? null, format: t.format ?? null,
      columns: (t.columns ?? []).map((c: any) => ({ name: c.name, type: c.type ?? null })),
    })),
    endpoints: (b.endpoints ?? []).map((e: any): EndpointManifest => ({
      name: e.name, method: e.method, path: e.path, read: e.read ?? false, rows: e.rows ?? "", columns: e.columns ?? [],
    })),
  };
}

/** What a query by this pivot weighs: the pivot's own weight if it sets one, else its source's. Zero is free. */
export function pivotWeight(pivot: Pick<PivotManifest, "weight">, source: Pick<SourceManifest, "cost">): number {
  return pivot.weight ?? source.cost.weight;
}

export function toType(item: Record<string, Json>): ObservableType {
  return { id: item.id as string, title: (item.title as string | undefined) ?? (item.id as string), pattern: item.pattern as string };
}

/**
 * Builds a pivot from a validated item. An unstated empty_means reads not-seen here; for a pivot that names an inventory the registry
 * then decides it from the inventory (the item, which the registry keeps, still shows whether it was stated).
 */
export function toPivot(item: Record<string, Json>, hash: string): PivotManifest {
  const i = item as Record<string, any>;
  return {
    id: i.id, title: i.title ?? i.id, hash, from: i.from, to: i.to, source: i.source, query: i.query,
    needs_window: i.needs_window ?? false, weight: i.weight ?? null, empty_means: i.empty_means ?? "not-seen", yields: i.yields ?? {},
    inventory: i.inventory ?? null,
  };
}
