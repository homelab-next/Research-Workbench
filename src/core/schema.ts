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

const checked = new WeakSet<object>();
const patterns = new WeakMap<object, RegExp>();

/** Walks the whole schema once so it is accepted or rejected regardless of the value. */
function precheck(schema: unknown, path: string): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new UnsupportedSchemaError(`schema at ${path} is not an object`);
  }
  if (checked.has(schema)) return;
  const node = schema as Schema;
  for (const k of Object.keys(node)) {
    if (!SUPPORTED.has(k) && !IGNORED.has(k)) throw new UnsupportedSchemaError(`${k} at ${path}`);
  }
  if (node.pattern !== undefined) {
    try {
      patterns.set(node, new RegExp(node.pattern));
    } catch {
      throw new UnsupportedSchemaError(`pattern at ${path} does not compile: ${String(node.pattern)}`);
    }
  }
  if (node.properties !== undefined) {
    for (const [name, sub] of Object.entries(node.properties)) precheck(sub, `${path}.properties.${name}`);
  }
  if (node.items !== undefined) precheck(node.items, `${path}.items`);
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
    precheck(node.additionalProperties, `${path}.additionalProperties`);
  }
  if (node.anyOf !== undefined) {
    if (!Array.isArray(node.anyOf)) throw new UnsupportedSchemaError(`anyOf at ${path} is not an array`);
    node.anyOf.forEach((sub, i) => precheck(sub, `${path}.anyOf[${i}]`));
  }
  checked.add(schema);
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

function check(schema: Schema, value: unknown, path: string, errors: SchemaError[]): void {
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
      check(s, value, path, sub);
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
    if (items !== undefined) value.forEach((v, i) => check(items, v, `${path}[${i}]`, errors));
  }

  if (isObject(value)) {
    for (const name of schema.required ?? []) {
      if (!has(value, name)) fail(`missing required property: ${name}`);
    }
    const props = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      const at = `${path}.${key}`;
      if (has(props, key)) {
        check(props[key]!, value[key], at, errors);
      } else if (schema.additionalProperties === false) {
        fail("unexpected property", at);
      } else if (typeof schema.additionalProperties === "object") {
        check(schema.additionalProperties, value[key], at, errors);
      }
    }
  }
}

/** Returns every violation; an empty array means the value is valid. */
export function validate(schema: Schema, value: unknown): SchemaError[] {
  precheck(schema, "$");
  const errors: SchemaError[] = [];
  check(schema, value, "$", errors);
  return errors;
}
