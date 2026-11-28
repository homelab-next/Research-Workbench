// The seam with pivot (pivot docs/design.md §4): the workbench plans with pivot and keeps its own custody of every query.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { canonical as pivotCanonical } from "pivot/base/canonical";
import { sha256Hex as pivotSha } from "pivot/base/hash";
import { validate as pivotValidate } from "pivot/base/schema";
import { belongsPlaybook as pivotBelongs } from "pivot/catalogue/inventories";
import { rowsHash as pivotRowsHash } from "pivot/plan/render";
import type { Schema as PivotSchema } from "pivot/base/schema";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { validate } from "../../src/core/schema";
import type { Schema } from "../../src/core/schema";
import { belongsPlaybook } from "../../src/modules/belongs";
import { loadRegistry } from "../../src/modules/registry-record";
import { rowsHash } from "../../src/modules/runner";
import { copySample } from "../helpers/sample-root";


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
    // the evasions the line scan above cannot see: c["run"](…), and a method taken off its connector, then called
    if (/\[\s*["'`](?:estimateRequest|estimate|run)["'`]\s*\]\s*\(/.test(code)) out.push(`${i + 1}: ${line.trim()}`);
    else if (/\b(?:estimateRequest|estimate|run)\s*\.\s*(?:call|apply|bind)\s*\(/.test(code)) out.push(`${i + 1}: ${line.trim()}`);
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

/** Each file of `src` (path relative to src/, text) other than the runner that calls a connector's run, estimate or estimateRequest, with the lines. */
function callsOutsideRunner(src: { file: string; text: string }[]): { file: string; calls: string[] }[] {
  return src
    .map(({ file, text }) => ({ file, calls: connectorCalls(text) }))
    .filter(({ file, calls }) => file !== "modules/runner.ts" && calls.length > 0);
}

test("a connector's run is still called only by the runner", () => {
  const SRC = join(REPO, "src");
  // no exception: the pool a query holds while it runs is leased by runQuery itself (final review I5), not by a view that forwards its call
  expect(callsOutsideRunner(files(SRC).map((f) => ({ file: relative(SRC, f), text: readFileSync(f, "utf8") })))).toEqual([]);
  expect(connectorCalls(readFileSync(join(SRC, "modules", "runner.ts"), "utf8")).length).toBeGreaterThanOrEqual(3);
  // and nothing the workbench loads from pivot is its run code or its service
  const loaded = pivotModulesLoaded();
  expect(loaded.length).toBeGreaterThan(0);
  expect(loaded.filter((f) => /^(run|service|cli)\//.test(f) || f === "index.ts")).toEqual([]);
});

test("the seam test refuses a connector's run called outside the runner, compose's forwarding of it included", () => {
  const forwarding = [
    "      const forward = connector.run.bind(connector);",
    "      seen.run = async (req) => await forward(req);",
  ].join("\n");
  expect(callsOutsideRunner([{ file: "cli/compose.ts", text: forwarding }])).toEqual([
    { file: "cli/compose.ts", calls: ["1: const forward = connector.run.bind(connector);"] },
  ]);
  expect(callsOutsideRunner([{ file: "cli/compose.ts", text: "await connector.run(req);" }])).toHaveLength(1);
  expect(callsOutsideRunner([{ file: "modules/runner.ts", text: "await connector.run(req);" }])).toEqual([]);
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

test("the installed pivot is the tag the lock file pins (by the tag object's hash)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  expect(pkg.dependencies).toEqual({ pivot: "github:homelab-next/pivot#v0.3.2" });
  const installed = JSON.parse(readFileSync(join(PIVOT, "package.json"), "utf8")) as { name: string; version: string };
  expect(installed).toMatchObject({ name: "pivot", version: "0.3.2" });
  const lock = readFileSync(join(REPO, "bun.lock"), "utf8");
  const pinned = lock.match(/"pivot": \["pivot@github:homelab-next\/pivot#([0-9a-f]{7,40})"/);
  expect(pinned).not.toBeNull();
  // what is in node_modules is what the lock file names, and nothing points at a local copy
  expect(readFileSync(join(PIVOT, ".bun-tag"), "utf8").trim()).toBe(`homelab-next-pivot-${pinned![1]}`);
  expect(lock).not.toMatch(/pivot@(file|link|workspace):/);
});

/** What pivot computes that the workbench records or compares with a recorded value: these come from the workbench's own copies. */
const DIGESTS = ["canonical", "sha256Hex", "rowsHash", "entryHash", "GENESIS", "belongsPlaybook"];
/** The one file allowed to call pivot's belongsPlaybook: it takes the steps and hashes them itself. */
const BELONGS = "src/modules/belongs.ts";

/** Every value import or re-export, from pivot or from a shim of it, of a name in DIGESTS, as "path: name from spec". */
function digestImports(): string[] {
  const SRC = join(REPO, "src");
  const shims = new Set(SHIMS.map((f) => join(REPO, f)));
  const fromPivot = (spec: string, file: string): boolean => {
    if (spec === "pivot" || spec.startsWith("pivot/")) return true;
    if (!spec.startsWith(".")) return false;
    const base = resolve(dirname(file), spec);
    return [base, `${base}.ts`, join(base, "index.ts")].some((c) => shims.has(c));
  };
  const out: string[] = [];
  for (const f of files(SRC)) {
    const rel = relative(REPO, f);
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\b(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
      if (m[1] !== undefined || !fromPivot(m[3]!, f)) continue;
      for (const part of m[2]!.split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!;
        if (part.trim().startsWith("type ") || !DIGESTS.includes(name)) continue;
        if (name === "belongsPlaybook" && rel === BELONGS) continue;
        out.push(`${rel}: ${name} from ${m[3]}`);
      }
    }
    for (const m of text.matchAll(/\bimport\s+\*\s+as\s+\w+\s+from\s*"([^"]+)"/g)) if (fromPivot(m[1]!, f)) out.push(`${rel}: * from ${m[1]}`);
  }
  return out;
}

test("every digest the ledger records or compares is the workbench's own, not pivot's", () => {
  expect(digestImports()).toEqual([]);
  // nor reached another way: pivot's base copies by any path, or a registry loaded without the workbench's own hash check
  expect(where(/["']pivot\/base\//g).filter((w) => w.startsWith("src/"))).toEqual([]);
  expect(where(/\bRegistry\.load\(/g).filter((w) => w.startsWith("src/"))).toEqual([expect.stringMatching(/^src\/modules\/registry-record\.ts:\d+$/)]);
});

const ROWS: [string[], Json[][]][] = [
  [[], []],
  [["a"], [[null]]],
  [["a", "b"], [[1, "x"], [2.5, "y"], [-0.25, null]]],
  [["n", "t", "o"], [[1e21, "unicode é ✓ 𝄞", { b: 1, a: [2, { d: null, c: true }] }], [Number.MAX_SAFE_INTEGER, "quote \" \\ \u0001", []]]],
  [["dup", "dup"], [["same", "same"]]],
  [["at"], [["2026-11-20T00:00:00.000Z"], ["2026-11-20T00:00:00.000Z"]]],
];

test("the workbench's rowsHash gives pivot's bytes on varied rows", () => {
  for (const [columns, rows] of ROWS) {
    expect(rowsHash(columns, rows)).toBe(pivotRowsHash(columns, rows));
    expect(rowsHash(columns, rows)).toBe(sha256Hex(canonical({ columns, rows })));
  }
  // and over every vector, as one column
  expect(rowsHash(["v"], VECTORS.map((v) => [v]))).toBe(pivotRowsHash(["v"], VECTORS.map((v) => [v])));
});

test("the workbench's does-it-belong playbook is pivot's, hashed by the workbench", () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-seam-"));
  try {
    copySample(join(dir, "sample"));
    const registry = loadRegistry([{ path: join(dir, "sample"), trusted: true, credentials: [] }]);
    const types = [...new Set(registry.pivots().filter((p) => p.inventory !== null).map((p) => p.from))];
    expect(types.length).toBeGreaterThan(0);
    for (const type of [...types, "no-such-type"]) {
      const theirs = pivotBelongs(registry, type);
      const ours = belongsPlaybook(registry, type);
      expect(ours).toEqual(theirs);
      if (ours === null) continue;
      expect(ours.hash).toBe(sha256Hex(canonical(ours.steps.map((s) => {
        const p = registry.pivot(s.pivot)!;
        const inv = registry.inventory(p.inventory!)!;
        return [p.id, p.hash, inv.id, inv.hash];
      }))));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
