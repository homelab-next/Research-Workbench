import { expect, test } from "bun:test";
import { canonical, CanonicalError } from "../../src/core/canonical";

test("sorts keys at every depth and keeps array order", () => {
  expect(canonical({ b: 1, a: [true, null, "x", { z: 1, y: 2 }] })).toBe('{"a":[true,null,"x",{"y":2,"z":1}],"b":1}');
});
test("key order does not change the result", () => {
  expect(canonical({ a: 1, b: { d: 4, c: 3 } })).toBe(canonical({ b: { c: 3, d: 4 }, a: 1 }));
});
test("escapes strings as JSON does and keeps unicode", () => {
  expect(canonical({ s: 'a"b\né' })).toBe('{"s":"a\\"b\\né"}');
});
test("writes negative zero as 0", () => {
  expect(canonical(-0)).toBe("0");
});
test.each([
  ["undefined in object", { a: undefined }],
  ["undefined in array", [undefined]],
  ["NaN", { a: NaN }],
  ["Infinity", { a: Infinity }],
  ["Date", { a: new Date(0) }],
  ["bigint", { a: 1n }],
  ["function", { a: () => 1 }],
  ["Map", { a: new Map() }],
])("refuses %s", (_name, value) => {
  expect(() => canonical(value as never)).toThrow(CanonicalError);
});
