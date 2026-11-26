// The seam with pivot (pivot docs/design.md §4): the workbench plans with pivot and keeps its own custody of every query.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { canonical as pivotCanonical } from "pivot/base/canonical";
import { sha256Hex as pivotSha } from "pivot/base/hash";
import { validate as pivotValidate } from "pivot/base/schema";
import type { Schema as PivotSchema } from "pivot/base/schema";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { validate } from "../../src/core/schema";
import type { Schema } from "../../src/core/schema";

const REPO = join(import.meta.dir, "..", "..");
const SELF = "tests/repo/pivot-seam.test.ts";
const PIVOT = join(REPO, "node_modules", "pivot");

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx|js)$/.test(e.name) ? [join(dir, e.name)] : []));
}
const OURS = ["src", "tests", "scripts", "sample"].flatMap((d) => files(join(REPO, d))).filter((f) => relative(REPO, f) !== SELF);

/** Every line of the workbench's own code that matches, as "path:line". */
function where(re: RegExp): string[] {
  const out: string[] = [];
  for (const f of OURS) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (new RegExp(re.source, re.flags.replace("g", "")).test(line)) out.push(`${relative(REPO, f)}:${i + 1}`);
    });
  }
  return out;
}

/** The modules that moved to pivot; each is now a one-line re-export. */
const SHIMS = [
  ...["manifests", "registry", "observables", "playbooks", "inventories", "sqlguard", "secrets", "seeker", "observe"].map((m) => `src/modules/${m}.ts`),
  ...["files", "http", "index", "local-child", "local-host", "placeholders", "rows", "shared", "sqlite", "trino", "types"].map((m) => `src/modules/connectors/${m}.ts`),
  ...["graphlayout", "dom", "svg"].map((m) => `src/web/${m}.ts`),
];

test("the workbench never imports pivot's run code or service", () => {
  expect(where(/from "pivot\/(run|service)\//g)).toEqual([]);
  expect(where(/\b(runLogged|RunLog|startService)\b/g)).toEqual([]);
  // nor names pivot's run or follow endpoints
  expect(where(/\/v1\/(run|follow|log)\b/g)).toEqual([]);
});

/** `.run(` on a SQLite handle or statement is not a connector call: db.run, insert.run, stmt.run, db.query(...).run. */
const SQLITE_RUN = /(?:\b(?:db|insert|stmt)|\.query\([^\n]*\))\s*$/;
function connectorCalls(text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    for (const m of code.matchAll(/\.\s*(estimateRequest|estimate|run)\s*\(/g)) {
      if (m[1] === "run" && SQLITE_RUN.test(code.slice(0, m.index))) continue;
      out.push(`${i + 1}: ${line.trim()}`);
    }
  });
  return out;
}

/** Every pivot module the workbench's src/ loads, followed through pivot's own imports. */
function pivotModulesLoaded(): string[] {
  const t = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const queue: string[] = [];
  const toFile = (spec: string, from: string | null): string | null => {
    let base: string;
    if (spec === "pivot") base = join(PIVOT, "src", "index");
    else if (spec === "pivot/web") base = join(PIVOT, "src", "web", "index");
    else if (spec.startsWith("pivot/")) base = join(PIVOT, "src", spec.slice("pivot/".length));
    else if (from !== null && spec.startsWith(".")) base = resolve(dirname(from), spec);
    else return null;
    for (const c of [base, `${base}.ts`, join(base, "index.ts")]) if (existsSync(c) && !c.endsWith("/") && /\.ts$/.test(c)) return c;
    return null;
  };
  for (const f of files(join(REPO, "src"))) {
    for (const imp of t.scanImports(readFileSync(f, "utf8"))) {
      const p = imp.path.startsWith("pivot") ? toFile(imp.path, null) : null;
      if (p !== null && !seen.has(p)) { seen.add(p); queue.push(p); }
    }
  }
  while (queue.length > 0) {
    const f = queue.pop()!;
    for (const imp of t.scanImports(readFileSync(f, "utf8"))) {
      const p = toFile(imp.path, f);
      if (p !== null && !seen.has(p)) { seen.add(p); queue.push(p); }
    }
  }
  return [...seen].map((f) => relative(join(PIVOT, "src"), f)).sort();
}

test("a connector's run is still called only by the runner", () => {
  const SRC = join(REPO, "src");
  const found = files(SRC)
    .map((f) => ({ file: relative(SRC, f), calls: connectorCalls(readFileSync(f, "utf8")) }))
    .filter(({ file, calls }) => file !== "modules/runner.ts" && calls.length > 0);
  expect(found).toEqual([]);
  expect(connectorCalls(readFileSync(join(SRC, "modules", "runner.ts"), "utf8")).length).toBeGreaterThanOrEqual(3);
  // and nothing the workbench loads from pivot is its run code or its service
  const loaded = pivotModulesLoaded();
  expect(loaded.length).toBeGreaterThan(0);
  expect(loaded.filter((f) => /^(run|service|cli)\//.test(f) || f === "index.ts")).toEqual([]);
});

test("each moved module is a re-export and nothing else", () => {
  for (const f of SHIMS) {
    expect(readFileSync(join(REPO, f), "utf8").trim().split("\n").filter((l) => !l.startsWith("//"))).toEqual([expect.stringMatching(/^export \* from "pivot\/[\w\/-]+";$/)]);
  }
});

const VECTORS: Json[] = [
  null, true, false, 0, 1, -1, 1.5, -0.25, 1e21, 1e-7, 123456789012, Number.MAX_SAFE_INTEGER,
  "", "plain", "quote \" and back\\slash", "control \u0001\u001f and tab\t", "unicode é ✓ 𝄞", "  ",
  [], [1, [2, [3]]], {}, { b: 1, a: 2 }, { "": null, z: [], é: { y: true, x: "x" } },
  { nested: [{ k: "v", n: 0 }, { n: -0.5, k: "w" }], at: "2026-11-20T00:00:00.000Z" },
];

test("the workbench's canonical, hash and schema agree with pivot's on the vectors", () => {
  for (const v of VECTORS) {
    expect(canonical(v)).toBe(pivotCanonical(v));
    expect(sha256Hex(canonical(v))).toBe(pivotSha(pivotCanonical(v)));
  }
  const bytes = new TextEncoder().encode("kind: source\nid: s\n");
  expect(sha256Hex(bytes)).toBe(pivotSha(bytes));
  // a value canonical refuses, both refuse
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, { u: undefined }] as unknown as Json[]) {
    expect(() => canonical(bad)).toThrow();
    expect(() => pivotCanonical(bad)).toThrow();
  }
  const PAIRS: [Schema, unknown][] = [
    [{ type: "string", maxLength: 3 }, "four"],
    [{ type: "integer", minimum: 0 }, -1.5],
    [{ type: "object", required: ["a"], additionalProperties: false, properties: { a: { type: "string" } } }, { b: 1 }],
    [{ type: "array", maxItems: 2, items: { type: "number" } }, [1, "x", 3]],
    [{ type: "string", enum: ["a", "b"] }, "c"],
    [{ type: "string", pattern: "^[a-z]+$" }, "ABC"],
    [{ anyOf: [{ type: "string" }, { type: "number" }] }, true],
    [{ type: ["string", "null"] }, 1],
    [{ type: "object", properties: { n: { type: "object", required: ["x"], properties: { x: { type: "boolean" } } } } }, { n: { x: "no" } }],
    [{ type: "object", additionalProperties: { type: "string" } }, { ok: "s", bad: 2 }],
  ];
  for (const [schema, value] of PAIRS) {
    const ours = validate(schema, value);
    expect(ours.length).toBeGreaterThan(0);
    expect(ours).toEqual(pivotValidate(schema as PivotSchema, value));
  }
});

test("the installed pivot is the tagged commit the lock file names", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  expect(pkg.dependencies).toEqual({ pivot: "github:homelab-next/pivot#v0.1.0" });
  const installed = JSON.parse(readFileSync(join(PIVOT, "package.json"), "utf8")) as { name: string; version: string };
  expect(installed).toMatchObject({ name: "pivot", version: "0.1.0" });
  const lock = readFileSync(join(REPO, "bun.lock"), "utf8");
  const pinned = lock.match(/"pivot": \["pivot@github:homelab-next\/pivot#([0-9a-f]{7,40})"/);
  expect(pinned).not.toBeNull();
  // what is in node_modules is what the lock file names, and nothing points at a local copy
  expect(readFileSync(join(PIVOT, ".bun-tag"), "utf8").trim()).toBe(`homelab-next-pivot-${pinned![1]}`);
  expect(lock).not.toMatch(/pivot@(file|link|workspace):/);
});
