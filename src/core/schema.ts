// A small JSON Schema validator shared by server and browser. No runtime imports.

import { has, isObj as isObject } from "./state/guards";

export type SchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface Schema {
  type?: SchemaType | SchemaType[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  anyOf?: Schema[];
  title?: string;
  description?: string;
}

export interface SchemaError {
  path: string;
  message: string;
}

export class UnsupportedSchemaError extends Error {
  constructor(keyword: string) {
    super(`unsupported schema keyword: ${keyword}`);
    this.name = "UnsupportedSchemaError";
  }
}

const SUPPORTED = new Set([
  "type", "enum", "const", "properties", "required", "additionalProperties", "items",
  "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "pattern", "anyOf",
]);
const IGNORED = new Set(["title", "description", "$schema", "$id", "default", "examples", "$comment"]);

const TYPES: ReadonlySet<string> = new Set<SchemaType>(["object", "array", "string", "number", "integer", "boolean", "null"]);
/** Counts must be non-negative integers; bounds any finite number. */
const COUNTS = ["minItems", "maxItems", "minLength", "maxLength"] as const;
const BOUNDS = ["minimum", "maximum"] as const;

/** Compiled patterns for one validate() call, keyed by schema node. Never cached across calls, so a changed schema is checked again. */
type Patterns = Map<object, RegExp>;

const bad = (what: string, path: string): UnsupportedSchemaError => new UnsupportedSchemaError(`${what} at ${path}`);

/** Walks the whole schema once so it is accepted or rejected regardless of the value. */
function precheck(schema: unknown, path: string, patterns: Patterns, inProgress: Set<object>): void {
  if (!isObject(schema)) throw new UnsupportedSchemaError(`schema at ${path} is not an object`);
  if (inProgress.has(schema)) throw bad("cyclic schema", path);
  inProgress.add(schema);
  const node = schema as Schema & Record<string, unknown>;
  for (const k of Object.keys(node)) {
    if (!SUPPORTED.has(k) && !IGNORED.has(k)) throw new UnsupportedSchemaError(`${k} at ${path}`);
  }
  const t = node.type;
  if (t !== undefined) {
    const names: unknown[] = Array.isArray(t) ? t : [t];
    if (names.length === 0 || !names.every((n) => typeof n === "string" && TYPES.has(n))) throw bad("type must be one or more known type names", path);
  }
  if (node.enum !== undefined && !Array.isArray(node.enum)) throw bad("enum must be an array", path);
  if (node.required !== undefined && !(Array.isArray(node.required) && node.required.every((n) => typeof n === "string"))) {
    throw bad("required must be an array of strings", path);
  }
  for (const k of COUNTS) {
    const v = node[k];
    if (v !== undefined && !(Number.isInteger(v) && (v as number) >= 0)) throw bad(`${k} must be a non-negative integer`, path);
  }
  for (const k of BOUNDS) {
    const v = node[k];
    if (v !== undefined && !(typeof v === "number" && Number.isFinite(v))) throw bad(`${k} must be a finite number`, path);
  }
  if (node.pattern !== undefined) {
    if (typeof node.pattern !== "string") throw bad("pattern must be a string", path);
    try {
      patterns.set(node, new RegExp(node.pattern));
    } catch {
      throw new UnsupportedSchemaError(`pattern at ${path} does not compile: ${node.pattern}`);
    }
  }
  if (node.properties !== undefined) {
    if (!isObject(node.properties)) throw bad("properties must be an object", path);
    for (const [name, sub] of Object.entries(node.properties)) precheck(sub, `${path}.properties.${name}`, patterns, inProgress);
  }
  if (node.items !== undefined) precheck(node.items, `${path}.items`, patterns, inProgress);
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
    precheck(node.additionalProperties, `${path}.additionalProperties`, patterns, inProgress);
  }
  if (node.anyOf !== undefined) {
    if (!Array.isArray(node.anyOf)) throw new UnsupportedSchemaError(`anyOf at ${path} is not an array`);
    node.anyOf.forEach((sub, i) => precheck(sub, `${path}.anyOf[${i}]`, patterns, inProgress));
  }
  inProgress.delete(schema);
}

function isJsonValue(v: unknown): boolean {
  switch (typeof v) {
    case "string": case "boolean": return true;
    case "number": return Number.isFinite(v);
    case "object": return true;
    default: return false;
  }
}


function typeOf(v: unknown): SchemaType | "other" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "string": return "string";
    case "boolean": return "boolean";
    case "number": return Number.isFinite(v) ? "number" : "other";
    case "object": return "object";
    default: return "other";
  }
}

function matchesType(t: SchemaType, v: unknown): boolean {
  const actual = typeOf(v);
  if (t === "integer") return actual === "number" && Number.isInteger(v);
  return actual === t;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b) || a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every(k => has(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function check(schema: Schema, value: unknown, path: string, errors: SchemaError[], patterns: Patterns): void {
  const fail = (message: string, at = path) => errors.push({ path: at, message });
  if (!isJsonValue(value)) {
    fail("not a JSON value");
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => matchesType(t, value))) fail(`expected ${types.join(" or ")}`);
  }
  if (schema.enum !== undefined && !schema.enum.some(e => deepEqual(e, value))) fail("not one of the allowed values");
  if (has(schema as Record<string, unknown>, "const") && !deepEqual(schema.const, value)) fail("does not match the required constant");

  if (schema.anyOf !== undefined) {
    const ok = schema.anyOf.some(s => {
      const sub: SchemaError[] = [];
      check(s, value, path, sub, patterns);
      return sub.length === 0;
    });
    if (!ok) fail("does not match any allowed schema");
  }

  if (typeof value === "string") {
    const length = schema.minLength !== undefined || schema.maxLength !== undefined ? [...value].length : 0;
    if (schema.minLength !== undefined && length < schema.minLength) fail(`shorter than ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(`longer than ${schema.maxLength} characters`);
    const re = patterns.get(schema);
    if (re !== undefined && !re.test(value)) fail(`does not match pattern ${schema.pattern}`);
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`less than ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`greater than ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`more than ${schema.maxItems} items`);
    const items = schema.items;
    if (items !== undefined) value.forEach((v, i) => check(items, v, `${path}[${i}]`, errors, patterns));
  }

  if (isObject(value)) {
    for (const name of schema.required ?? []) {
      if (!has(value, name)) fail(`missing required property: ${name}`);
    }
    const props = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      const at = `${path}.${key}`;
      if (has(props, key)) {
        check(props[key]!, value[key], at, errors, patterns);
      } else if (schema.additionalProperties === false) {
        fail("unexpected property", at);
      } else if (typeof schema.additionalProperties === "object") {
        check(schema.additionalProperties, value[key], at, errors, patterns);
      }
    }
  }
}

/** Returns every violation; an empty array means the value is valid. */
export function validate(schema: Schema, value: unknown): SchemaError[] {
  const patterns: Patterns = new Map();
  precheck(schema, "$", patterns, new Set());
  const errors: SchemaError[] = [];
  check(schema, value, "$", errors, patterns);
  return errors;
}
