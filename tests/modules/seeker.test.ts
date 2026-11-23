import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/modules/registry";
import { DEFAULT_LIMITS, SEEKERS, cheapestSeeker } from "../../src/modules/seeker";
import type { Seeker } from "../../src/modules/seeker";

let dir: string;
let registry: Registry;
let seeker: Seeker;

const src = (id: string, extra: string): string => `kind: source
id: ${id}
title: Source ${id}
connector: files
location: data
marking: "TLP:AMBER"
where: machine
${extra}
`;
const pivot = (id: string, from: string, to: string, source: string, weight: string): string =>
  `  - { id: ${id}, title: Pivot ${id}, from: ${from}, to: ${to}, source: ${source}, query: "select 1 from t where x = {value}"${weight}, empty_means: proven-negative }`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "seeker-"));
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "s1.yaml"), src("s1", ""));
  writeFileSync(join(dir, "s2.yaml"), src("s2", "cost: { weight: 5, unit: lookups }"));
  writeFileSync(join(dir, "s3.yaml"), src("s3", "confirmed: false"));
  writeFileSync(join(dir, "types.yaml"), `kind: types\ntypes:\n${["a", "b", "c", "d"].map((t) => `  - { id: ${t}, title: T${t}, pattern: '${t}.*' }`).join("\n")}\n`);
  writeFileSync(join(dir, "pivots.yaml"), `kind: pivots\npivots:\n${[
    pivot("ab", "a", "b", "s1", ", weight: 0"), pivot("bc", "b", "c", "s1", ", weight: 0"), pivot("ac", "a", "c", "s2", ""),
    pivot("bd", "b", "d", "s3", ", weight: 0"), pivot("cd", "c", "d", "s1", ", weight: 0"),
  ].join("\n")}\n`);
  registry = Registry.load([{ path: dir, trusted_scripts: false }]);
  expect(registry.problems).toEqual([]);
  seeker = cheapestSeeker(registry);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ids = (rs: { hops: { pivot: string }[] }[]): string[][] => rs.map((r) => r.hops.map((h) => h.pivot));

test("finds the cheapest route first, fewer hops breaking ties", () => {
  const rs = seeker.routes(["a"], "c", DEFAULT_LIMITS);
  expect(ids(rs)).toEqual([["ab", "bc"], ["ac"]]);
  expect(rs.map((r) => r.weight)).toEqual([0, 5]);
});

test("each hop says its source, whether it is free, and what empty means", () => {
  const [r] = seeker.routes(["a"], "c", DEFAULT_LIMITS);
  expect(r!.hops[0]).toEqual({
    pivot: "ab", title: "Pivot ab", source: "s1", from: "a", to: "b", free: true, weight: 0, needs_window: false,
    empty_means: "proven-negative", confirmed: true, marking: "TLP:AMBER", unit: "seconds",
  });
  const costly = seeker.routes(["a"], "c", DEFAULT_LIMITS)[1]!.hops[0]!;
  expect(costly).toMatchObject({ pivot: "ac", source: "s2", free: false, weight: 5, unit: "lookups" });
});

test("a weight ceiling drops routes above it", () => {
  expect(ids(seeker.routes(["a"], "c", { ...DEFAULT_LIMITS, max_weight: 0 }))).toEqual([["ab", "bc"]]);
});

test("unconfirmed sources are left out unless allowed", () => {
  expect(ids(seeker.routes(["a"], "d", DEFAULT_LIMITS))).toEqual([["ab", "bc", "cd"], ["ac", "cd"]]);
  expect(ids(seeker.routes(["a"], "d", { ...DEFAULT_LIMITS, allow_unconfirmed: true }))).toEqual([["ab", "bd"], ["ab", "bc", "cd"], ["ac", "cd"]]);
});

test("blocked pivots are routed around", () => {
  expect(ids(seeker.routes(["a"], "c", DEFAULT_LIMITS, new Set(["bc"])))).toEqual([["ac"]]);
});

test("already holding the goal type gives one empty route", () => {
  expect(seeker.routes(["c"], "c", DEFAULT_LIMITS)).toEqual([{ hops: [], weight: 0 }]);
});

test("no route gives an empty list", () => {
  expect(seeker.routes(["d"], "a", DEFAULT_LIMITS)).toEqual([]);
  expect(seeker.routes([], "a", DEFAULT_LIMITS)).toEqual([]);
  expect(seeker.routes(["a"], "unknown", DEFAULT_LIMITS)).toEqual([]);
});

test("max_hops limits the search and cycles are never followed", () => {
  expect(ids(seeker.routes(["a"], "d", { ...DEFAULT_LIMITS, max_hops: 1 }))).toEqual([]);
  expect(ids(seeker.routes(["a"], "d", { ...DEFAULT_LIMITS, max_hops: 2 }))).toEqual([["ac", "cd"]]);
  expect(ids(seeker.routes(["a"], "d", { ...DEFAULT_LIMITS, max_hops: 3 }))).toEqual([["ab", "bc", "cd"], ["ac", "cd"]]);
  expect(ids(seeker.routes(["a"], "d", { ...DEFAULT_LIMITS, max_hops: 0 }))).toEqual([]);
  // no route revisits a type
  for (const r of seeker.routes(["a"], "d", { ...DEFAULT_LIMITS, allow_unconfirmed: true, max_hops: 10 })) {
    const seen = ["a", ...r.hops.map((h) => h.to)];
    expect(new Set(seen).size).toBe(seen.length);
  }
});

test("several starting types are all considered", () => {
  expect(ids(seeker.routes(["a", "b"], "c", DEFAULT_LIMITS))).toEqual([["bc"], ["ab", "bc"], ["ac"]]);
});

test("at most five routes are returned", () => {
  const dir2 = mkdtempSync(join(tmpdir(), "seeker-many-"));
  try {
    mkdirSync(join(dir2, "data"));
    writeFileSync(join(dir2, "s.yaml"), src("s", ""));
    const mids = [1, 2, 3, 4, 5, 6, 7];
    writeFileSync(join(dir2, "types.yaml"), `kind: types\ntypes:\n${["x", "y", ...mids.map((m) => `m${m}`)].map((t) => `  - { id: ${t}, title: ${t}, pattern: '${t}' }`).join("\n")}\n`);
    writeFileSync(join(dir2, "pivots.yaml"), `kind: pivots\npivots:\n${mids.flatMap((m) => [pivot(`xm${m}`, "x", `m${m}`, "s", ", weight: 0"), pivot(`m${m}y`, `m${m}`, "y", "s", ", weight: 0")]).join("\n")}\n`);
    const r = Registry.load([{ path: dir2, trusted_scripts: false }]);
    expect(r.problems).toEqual([]);
    const rs = cheapestSeeker(r).routes(["x"], "y", DEFAULT_LIMITS);
    expect(rs).toHaveLength(5);
    expect(ids(rs)[0]).toEqual(["xm1", "m1y"]);
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("SEEKERS has cheapest", () => {
  expect(Object.keys(SEEKERS)).toEqual(["cheapest"]);
  expect(SEEKERS.cheapest!(registry).routes(["a"], "b", DEFAULT_LIMITS)).toHaveLength(1);
});
