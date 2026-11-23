import { expect, test } from "bun:test";
import { Observables } from "../../src/modules/observables";

const obs = new Observables([
  { id: "address", title: "Address", pattern: "^(?:\\d{1,3}\\.){3}\\d{1,3}$" },
  { id: "domain", title: "Domain", pattern: "^(?=.{1,253}$)(?:[a-z0-9-]{1,63}\\.)+[a-z]{2,63}$" },
]);

test("recognises the first matching type", () => {
  expect(obs.recognise("192.0.2.7")).toBe("address");
  expect(obs.recognise("cdn.example.org")).toBe("domain");
  expect(obs.recognise("hello")).toBeNull();
  expect(obs.recognise(42)).toBeNull();
});

test("matches checks one type and rejects injection text", () => {
  expect(obs.matches("address", "192.0.2.7")).toBe(true);
  expect(obs.matches("address", "192.0.2.7' OR '1'='1")).toBe(false);
  expect(obs.matches("address", "192.0.2.7\n")).toBe(false);
  expect(obs.matches("nope", "x")).toBe(false);
});

test("a pattern written without anchors still has to match the whole string", () => {
  const o = new Observables([{ id: "digits", title: "Digits", pattern: "\\d+" }]);
  expect(o.matches("digits", "123")).toBe(true);
  expect(o.matches("digits", "123abc")).toBe(false);
  expect(o.matches("digits", "x123")).toBe(false);
});

test("columnTypes uses hints first, then what most values look like", () => {
  expect(obs.columnTypes(["a", "b", "c"], { a: "domain" }, [["x", "192.0.2.1", 5], ["y", "192.0.2.2", 6]])).toEqual(["domain", "address", null]);
});

test("columnTypes needs more than half of the non-null strings, and a null hint does not count", () => {
  const rows = [["192.0.2.1"], ["192.0.2.2"], ["x"], ["y"], [null]];
  expect(obs.columnTypes(["a"], {}, rows)).toEqual([null]);
  expect(obs.columnTypes(["a"], { a: null }, [["192.0.2.1"], ["192.0.2.2"], ["x"], [null]])).toEqual(["address"]);
  expect(obs.columnTypes(["a"], {}, [])).toEqual([null]);
});

test("a very long value matches no type, quickly", () => {
  const start = performance.now();
  expect(obs.recognise("a".repeat(10000))).toBeNull();
  expect(obs.matches("domain", "a".repeat(10000) + ".org")).toBe(false);
  expect(obs.columnTypes(["a"], {}, [["a".repeat(10000)]])).toEqual([null]);
  expect(performance.now() - start).toBeLessThan(100);
  expect(obs.recognise("a".repeat(500) + ".org")).toBeNull(); // label too long for the pattern, but it was tested
});

test("compiling a catastrophic pattern is refused", () => {
  expect(() => new Observables([{ id: "x", title: "X", pattern: "(a+)+" }])).toThrow();
});
