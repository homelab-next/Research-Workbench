import { expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import type { PivotManifest } from "../../src/modules/manifests";
import { Observables } from "../../src/modules/observables";
import { MAX_POINTS, MAX_SIGHTINGS, observe, readTime } from "../../src/modules/observe";

const observables = new Observables([
  { id: "address", title: "Address", pattern: "(?:\\d{1,3}\\.){3}\\d{1,3}" },
  { id: "domain", title: "Domain", pattern: "(?=.{1,253}$)(?:[a-z0-9-]{1,63}\\.)+[a-z]{2,63}" },
]);

const pivotOf = (over: Partial<PivotManifest>): PivotManifest => ({
  id: "p", title: "P", hash: "h", from: "address", to: "domain", source: "dns-logs", query: "q", needs_window: true, weight: null,
  empty_means: "not-seen", yields: { name: "domain" }, inventory: null, times: null, ...over,
});
const spanPivot = pivotOf({ id: "address_to_domains", times: { kind: "span", first: "first_seen", last: "last_seen", count: "events" } });
const spanNoCount = pivotOf({ times: { kind: "span", first: "first_seen", last: "last_seen", count: null } });
const pointsPivot = pivotOf({ id: "address_to_internal_peers", to: "address", yields: { peer: "address" }, times: { kind: "points", at: "ts", count: null } });
const noTimes = pivotOf({});
const ADDR = "198.51.100.77";

test("the limits are the design's", () => {
  expect(MAX_SIGHTINGS).toBe(100);
  expect(MAX_POINTS).toBe(24);
});

test("readTime reads the three forms into UTC with milliseconds", () => {
  for (const [given, want] of [
    ["2026-11-20T03:04:05.123Z", "2026-11-20T03:04:05.123Z"], ["2026-11-20T03:04:05Z", "2026-11-20T03:04:05.000Z"],
    ["2026-11-20T03:04:05+01:00", "2026-11-20T02:04:05.000Z"], ["2026-11-20 03:04:05.123 UTC", "2026-11-20T03:04:05.123Z"],
    ["2026-11-20 03:04:05", "2026-11-20T03:04:05.000Z"], ["2026-11-20 03:04:05.123456 +00:00", "2026-11-20T03:04:05.123Z"],
    ["2026-11-19", "2026-11-19T00:00:00.000Z"],
  ] as const) expect(readTime(given)).toBe(want);
});

test("readTime refuses what it cannot be sure of", () => {
  for (const v of [1763607845, "1763607845", "", "yesterday", "2026-02-30", "2026-11-20 03:04:05 America/Chicago", "2026-11-20T25:00:00Z", null, true, ["2026-11-19"]]) expect(readTime(v as never)).toBeNull();
});

test("a span pivot: rows for one value merge to the earliest first, the latest last and the summed count", () => {
  const o = observe(spanPivot, ADDR, ["name", "status", "first_seen", "last_seen", "events"], [
    ["a.example.com", "ok", "2026-11-18T00:00:00Z", "2026-11-19T05:00:00Z", 4],
    ["b.example.com", "ok", "2026-11-18 00:00:00", "2026-11-18 00:00:00", "1"],
    ["a.example.com", "nx", "2026-11-17 01:00:00 UTC", "2026-11-18T00:00:00Z", 3],
  ], observables);
  expect(o.found).toEqual([
    { type: "domain", value: "a.example.com", first: "2026-11-17T01:00:00.000Z", last: "2026-11-19T05:00:00.000Z", count: 7, points: [] },
    { type: "domain", value: "b.example.com", first: "2026-11-18T00:00:00.000Z", last: "2026-11-18T00:00:00.000Z", count: 1, points: [] },
  ]);
  expect(o).toMatchObject({ pivot: "address_to_domains", from: { type: "address", value: "198.51.100.77" }, span: { first: "2026-11-17T01:00:00.000Z", last: "2026-11-19T05:00:00.000Z", count: 8 }, more: 0, unread: 0 });
});

test("a span pivot without a count column has null counts", () => {
  const o = observe(spanNoCount, ADDR, ["name", "first_seen", "last_seen"], [["a.example.com", "2026-11-18", "2026-11-19"]], observables);
  expect(o.found[0]!.count).toBeNull();
  expect(o.span.count).toBeNull();
  expect(o.found[0]).toMatchObject({ first: "2026-11-18T00:00:00.000Z", last: "2026-11-19T00:00:00.000Z" });
});

test("a count that is not a whole non-negative number makes the count unknown", () => {
  const o = observe(spanPivot, ADDR, ["name", "first_seen", "last_seen", "events"], [
    ["a.example.com", "2026-11-18", "2026-11-19", 2], ["a.example.com", "2026-11-18", "2026-11-19", -1], ["b.example.com", "2026-11-18", "2026-11-19", "3"],
  ], observables);
  expect(o.found.map((f) => f.count)).toEqual([null, 3]);
  expect(o.span.count).toBeNull();
});

test("a points pivot: one point per distinct time, in time order; a row without a count column counts once", () => {
  const o = observe(pointsPivot, ADDR, ["peer", "ts"], [
    ["192.0.2.17", "2026-11-17T09:00:00Z"], ["192.0.2.17", "2026-11-17T08:00:00Z"], ["192.0.2.17", "2026-11-17 08:00:00"],
  ], observables);
  expect(o.found[0]).toMatchObject({ first: "2026-11-17T08:00:00.000Z", last: "2026-11-17T09:00:00.000Z", count: 3, points: [["2026-11-17T08:00:00.000Z", 2], ["2026-11-17T09:00:00.000Z", 1]] });
  expect(o.span).toEqual({ first: "2026-11-17T08:00:00.000Z", last: "2026-11-17T09:00:00.000Z", count: 3 });
});

test("more than 24 distinct times are merged into 24 slices of the value's own span, counts kept", () => {
  const rows: Json[][] = Array.from({ length: 48 }, (_, i) => ["192.0.2.17", `2026-11-17T08:${String(i).padStart(2, "0")}:00Z`]);
  const o = observe(pointsPivot, ADDR, ["peer", "ts"], rows, observables);
  expect(o.found[0]!.points.length).toBe(24);
  expect(o.found[0]!.points.reduce((n, p) => n + p[1], 0)).toBe(48);
  expect(o.found[0]!.points[0]).toEqual(["2026-11-17T08:00:00.000Z", 2]);
  const times = o.found[0]!.points.map((p) => p[0]);
  expect([...times].sort()).toEqual(times);
  expect(o.found[0]).toMatchObject({ first: "2026-11-17T08:00:00.000Z", last: "2026-11-17T08:47:00.000Z", count: 48 });
});

test("values past 100 are counted, not listed; the span still covers every row", () => {
  const rows: Json[][] = Array.from({ length: 130 }, (_, i) => [`h${i}.example.com`, "2026-11-18", i === 129 ? "2026-11-23" : "2026-11-19", 1]);
  const o = observe(spanPivot, ADDR, ["name", "first_seen", "last_seen", "events"], rows, observables);
  expect(o.found.length).toBe(100);
  expect(o.more).toBe(30);
  expect(o.span).toEqual({ first: "2026-11-18T00:00:00.000Z", last: "2026-11-23T00:00:00.000Z", count: 130 });
});

test("a time that cannot be read counts the row in unread, keeps the value, adds no time, and throws nothing", () => {
  const o = observe(spanPivot, ADDR, ["name", "first_seen", "last_seen", "events"], [
    ["a.example.com", 1763607845, "2026-11-19", 1],
    ["b.example.com", "", "2026-11-19", 1],
    ["c.example.com", "2026-11-20 03:04:05 America/Chicago", "2026-11-19", 1],
    ["d.example.com", "2026-11-20", "2026-11-19", 1],
  ], observables);
  expect(o.unread).toBe(4);
  expect(o.found.map((f) => f.first)).toEqual([null, null, null, null]);
  expect(o.found.map((f) => f.value)).toEqual(["a.example.com", "b.example.com", "c.example.com", "d.example.com"]);
  expect(o.span.first).toBeNull();
});

test("a declared time column the result does not have makes every row unread", () => {
  const o = observe(spanPivot, ADDR, ["name", "first_seen", "events"], [["a.example.com", "2026-11-18", 1], ["b.example.com", "2026-11-18", 1]], observables);
  expect(o.unread).toBe(2);
  expect(o.found.every((f) => f.first === null && f.last === null)).toBe(true);
});

test("a pivot without times, and an empty result", () => {
  expect(observe(noTimes, "198.51.100.77", ["name"], [["a.example.com"]], observables)).toEqual({ pivot: "p", from: { type: "address", value: "198.51.100.77" }, span: { first: null, last: null, count: null }, found: [{ type: "domain", value: "a.example.com", first: null, last: null, count: null, points: [] }], more: 0, unread: 0 });
  expect(observe(spanPivot, "198.51.100.77", ["name", "first_seen", "last_seen", "events"], [], observables).found).toEqual([]);
  expect(observe(spanPivot, "198.51.100.77", ["name", "first_seen", "last_seen", "events"], [], observables).span).toEqual({ first: null, last: null, count: null });
});

test("a value that fails its type's pattern, a null and a non-string are not found", () => {
  const o = observe(noTimes, ADDR, ["name"], [["NOT A DOMAIN"], [null], [42], [["a.example.com"]]], observables);
  expect(o.found).toEqual([]);
});

test("a value in two yielded columns of one row is one sighting counted once", () => {
  const p = pivotOf({ yields: { name: "domain", alias: "domain" }, times: { kind: "span", first: "first_seen", last: "last_seen", count: "events" } });
  const o = observe(p, ADDR, ["name", "alias", "first_seen", "last_seen", "events"], [["a.example.com", "a.example.com", "2026-11-18", "2026-11-19", 5]], observables);
  expect(o.found).toEqual([{ type: "domain", value: "a.example.com", first: "2026-11-18T00:00:00.000Z", last: "2026-11-19T00:00:00.000Z", count: 5, points: [] }]);
});
