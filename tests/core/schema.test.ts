import { expect, test } from "bun:test";
import { validate, UnsupportedSchemaError, type Schema } from "../../src/core/schema";

const finding: Schema = {
  type: "object", additionalProperties: false, required: ["statement", "likelihood", "cites"],
  properties: {
    statement: { type: "string", minLength: 1 },
    likelihood: { enum: ["likely", "unlikely"] },
    cites: { type: "array", minItems: 1, items: { type: "string", pattern: "^c[0-9]+$" } },
    weight: { type: ["number", "null"], minimum: 0, maximum: 1 },
  },
};
test("a valid value has no errors", () => {
  expect(validate(finding, { statement: "x", likelihood: "likely", cites: ["c1"] })).toEqual([]);
});
test("reports every problem with its path", () => {
  const errs = validate(finding, { statement: "", likelihood: "maybe", cites: ["c1", "zz"], extra: 1, weight: 2 });
  expect(errs.map(e => e.path).sort()).toEqual(["$.cites[1]", "$.extra", "$.likelihood", "$.statement", "$.weight"]);
});
test("reports a missing required property at the parent path", () => {
  expect(validate(finding, { statement: "x", likelihood: "likely" })).toEqual([{ path: "$", message: "missing required property: cites" }]);
});
test("integer rejects 1.5 and accepts 2", () => {
  expect(validate({ type: "integer" }, 2)).toEqual([]);
  expect(validate({ type: "integer" }, 1.5).length).toBe(1);
});
test("null is its own type, not an object", () => {
  expect(validate({ type: "object" }, null).length).toBe(1);
  expect(validate({ type: "null" }, null)).toEqual([]);
  expect(validate({ type: "null" }, {}).length).toBe(1);
});
test("arrays are not objects", () => {
  expect(validate({ type: "object" }, []).length).toBe(1);
  expect(validate({ type: "array" }, [])).toEqual([]);
  expect(validate({ type: "array" }, {}).length).toBe(1);
});
test("const and anyOf work", () => {
  expect(validate({ const: { a: [1] } }, { a: [1] })).toEqual([]);
  expect(validate({ const: { a: [1] } }, { a: [2] }).length).toBe(1);
  const s: Schema = { anyOf: [{ type: "string" }, { type: "integer", minimum: 5 }] };
  expect(validate(s, "x")).toEqual([]);
  expect(validate(s, 7)).toEqual([]);
  expect(validate(s, 1).length).toBe(1);
  expect(validate(s, true).length).toBe(1);
});
test("additionalProperties as a schema validates the extra values", () => {
  const s: Schema = { type: "object", properties: { a: { type: "string" } }, additionalProperties: { type: "number" } };
  expect(validate(s, { a: "x", b: 1 })).toEqual([]);
  expect(validate(s, { a: "x", b: "no" }).map(e => e.path)).toEqual(["$.b"]);
});
test("unsupported keywords throw UnsupportedSchemaError", () => {
  expect(() => validate({ $ref: "#/x" } as never, 1)).toThrow(UnsupportedSchemaError);
  for (const k of ["allOf", "oneOf", "not", "if"]) {
    expect(() => validate({ [k]: [] } as never, 1)).toThrow(UnsupportedSchemaError);
  }
  expect(() => validate({ properties: { a: { oneOf: [] } } } as never, { a: 1 })).toThrow(UnsupportedSchemaError);
});
test("length limits, array limits and bounds", () => {
  expect(validate({ minLength: 2, maxLength: 3 }, "a").length).toBe(1);
  expect(validate({ minLength: 2, maxLength: 3 }, "abcd").length).toBe(1);
  expect(validate({ minLength: 2, maxLength: 3 }, "abc")).toEqual([]);
  expect(validate({ maxItems: 1 }, [1, 2]).length).toBe(1);
  expect(validate({ minimum: 1 }, 0).length).toBe(1);
  expect(validate({ maximum: 1 }, 2).length).toBe(1);
});
test("nested paths use dots and indexes", () => {
  const s: Schema = { properties: { a: { items: { properties: { b: { type: "string" } } } } } };
  expect(validate(s, { a: [{ b: 1 }] }).map(e => e.path)).toEqual(["$.a[0].b"]);
});
test("patterns valid in ordinary JSON Schema use compile", () => {
  expect(validate({ pattern: "^a\\-b$" }, "a-b")).toEqual([]);
  expect(validate({ pattern: "[a-z\\d-_]+" }, "ab_1")).toEqual([]);
  expect(validate({ pattern: "^\\_$" }, "_")).toEqual([]);
});
test("a pattern that cannot compile throws UnsupportedSchemaError naming it", () => {
  expect(() => validate({ pattern: "^(" }, "x")).toThrow(UnsupportedSchemaError);
  expect(() => validate({ pattern: "^(" }, "x")).toThrow(/\^\(/);
});
test("unknown keywords fail closed and name keyword and path", () => {
  for (const k of ["exclusiveMinimum", "multipleOf", "uniqueItems", "format", "patternProperties", "$defs"]) {
    expect(() => validate({ [k]: 1 } as never, 1)).toThrow(UnsupportedSchemaError);
  }
  expect(() => validate({ properties: { a: { format: "email" } } } as never, {})).toThrow(/format at \$\.properties\.a/);
  expect(() => validate({ items: [{ type: "string" }] } as never, [])).toThrow(UnsupportedSchemaError);
});
test("ignored annotation keywords are accepted", () => {
  const s = { title: "t", description: "d", $schema: "x", $id: "y", default: 1, examples: [1], $comment: "c", type: "number" } as Schema;
  expect(validate(s, 1)).toEqual([]);
});
test("schema nodes that are not plain objects throw", () => {
  for (const bad of [null, true, [], 5]) {
    expect(() => validate(bad as never, 1)).toThrow(UnsupportedSchemaError);
    expect(() => validate({ properties: { a: bad } } as never, {})).toThrow(UnsupportedSchemaError);
  }
  expect(() => validate({ additionalProperties: null } as never, {})).toThrow(UnsupportedSchemaError);
});
test("rejection does not depend on the value", () => {
  expect(() => validate({ properties: { a: { $ref: "#/x" } } } as never, {})).toThrow(UnsupportedSchemaError);
  expect(() => validate({ items: { $ref: "#/x" } } as never, [])).toThrow(UnsupportedSchemaError);
  expect(() => validate({ additionalProperties: { not: {} } } as never, {})).toThrow(UnsupportedSchemaError);
  const s = { anyOf: [{ type: "string" }, { oneOf: [] }] } as never;
  expect(() => validate(s, "x")).toThrow(UnsupportedSchemaError);
  expect(() => validate(s, "x")).toThrow(UnsupportedSchemaError);
});
test("non-JSON values are errors whatever the schema", () => {
  for (const v of [NaN, Infinity, -Infinity, undefined, 1n, () => 1, Symbol("s")]) {
    expect(validate({}, v)).toEqual([{ path: "$", message: "not a JSON value" }]);
  }
  expect(validate({}, { a: [undefined] }).map(e => e.path)).toEqual([]);
  expect(validate({ properties: { a: {} } }, { a: NaN }).map(e => e.path)).toEqual(["$.a"]);
  expect(validate({ items: {} }, [1, NaN]).map(e => e.path)).toEqual(["$[1]"]);
});
test("length limits count code points", () => {
  expect(validate({ maxLength: 1 }, "\u{1F600}")).toEqual([]);
  expect(validate({ minLength: 2 }, "\u{1F600}").length).toBe(1);
  expect(validate({ minLength: 2, maxLength: 2 }, "\u{1F600}\u{1F600}")).toEqual([]);
});
test("a parsed __proto__ key is an unexpected property", () => {
  const v = JSON.parse('{"__proto__": 1}');
  expect(validate({ type: "object", additionalProperties: false }, v).map(e => e.path)).toEqual(["$.__proto__"]);
});
test("enum of objects", () => {
  const s: Schema = { enum: [{ a: 1 }, [1, 2]] };
  expect(validate(s, { a: 1 })).toEqual([]);
  expect(validate(s, [1, 2])).toEqual([]);
  expect(validate(s, { a: 2 }).length).toBe(1);
});
test("required and additionalProperties false at a nested path", () => {
  const s: Schema = { properties: { o: { required: ["x"], additionalProperties: false, properties: { x: {} } } } };
  expect(validate(s, { o: {} })).toEqual([{ path: "$.o", message: "missing required property: x" }]);
  expect(validate(s, { o: { x: 1, y: 2 } }).map(e => e.path)).toEqual(["$.o.y"]);
});
test("an unsupported keyword in a later anyOf branch throws even if an earlier branch matches", () => {
  expect(() => validate({ anyOf: [{ type: "string" }, { $ref: "#/x" }] } as never, "x")).toThrow(UnsupportedSchemaError);
});
