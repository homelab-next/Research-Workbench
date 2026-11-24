// A form check: JSON on standard input, one JSON object on standard output. It judges form only and calls nothing.
const input = JSON.parse(await Bun.stdin.text());
const product = input.draft.product;
const findings: { where: string; message: string }[] = [];
const fail = (where: string, message: string): void => { findings.push({ where, message }); };

type Schema = Record<string, any>;
const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v: unknown, t: string): boolean => (t === "number" ? typeof v === "number" : t === "integer" ? Number.isInteger(v) : typeOf(v) === t);
/** The keywords the product schema uses: type, required, properties, additionalProperties, items, enum, minLength, minItems. */
function check(schema: Schema, v: unknown, path: string): void {
  if (schema.type !== undefined) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(v, t))) { fail(path === "" ? "product" : path, `${path === "" ? "the product" : path} must be ${types.join(" or ")}, not ${typeOf(v)}`); return; }
  }
  if (schema.enum !== undefined && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(v))) fail(path === "" ? "product" : path, `${path || "the product"} must be one of ${schema.enum.join(", ")}`);
  if (typeof v === "string" && schema.minLength !== undefined && v.length < schema.minLength) fail(path, `${path} must not be empty`);
  if (Array.isArray(v)) {
    if (schema.minItems !== undefined && v.length < schema.minItems) fail(path, `${path} needs at least ${schema.minItems} items`);
    if (schema.items !== undefined) v.forEach((x, i) => check(schema.items, x, `${path}[${i}]`));
  }
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!Object.hasOwn(o, k)) fail(path === "" ? "product" : path, `${path ? path + "." : ""}${k} is missing`);
    for (const k of Object.keys(o)) {
      const sub = schema.properties?.[k];
      if (sub !== undefined) check(sub, o[k], path === "" ? k : `${path}.${k}`);
      else if (schema.additionalProperties === false) fail(path === "" ? "product" : path, `${path ? path + "." : ""}${k} is not allowed`);
    }
  }
}
check(input.schema, product, "");
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
