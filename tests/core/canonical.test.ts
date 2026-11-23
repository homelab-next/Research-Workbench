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

const sparse = [, 1];
test("refuses a sparse array, naming the hole", () => {
  expect(() => canonical(sparse as never)).toThrow(CanonicalError);
  expect(() => canonical({ a: [1, , 3] } as never)).toThrow("hole at $.a[1]");
  expect(() => canonical(new Array(2) as never)).toThrow(CanonicalError);
});
test("refuses symbol-keyed properties instead of dropping them", () => {
  expect(() => canonical({ a: 1, [Symbol("s")]: 2 } as never)).toThrow("symbol-keyed property at $");
  expect(() => canonical({ a: { [Symbol.iterator]: 1 } } as never)).toThrow(CanonicalError);
});
test("a null-prototype object and non-ASCII key order are handled", () => {
  const o = Object.assign(Object.create(null) as object, { b: 1, a: 2 });
  expect(canonical(o as never)).toBe('{"a":2,"b":1}');
  // UTF-16 code unit order, as Array.prototype.sort orders strings
  expect(canonical({ "é": 1, z: 2, "Z": 3 })).toBe('{"Z":3,"z":2,"é":1}');
});
