import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

// The browser-shared modules (bundled for the browser in plan 4) and everything they import.
const CORE = resolve(import.meta.dir, "../../src/core");
const WEB = resolve(import.meta.dir, "../../src/web");
const ENTRY_POINTS = [...["state/index.ts", "canonical.ts", "schema.ts", "types.ts", "wire.ts"].map((f) => join(CORE, f)), join(WEB, "main.ts")];   // build.ts is not reachable from main.ts

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Strips comments so a word in a doc comment is not mistaken for code. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** pivot's sources, which a browser-shared module may import by their package path (`pivot/types`, `pivot/web/dom`). */
const PIVOT_SRC = resolve(import.meta.dir, "../../node_modules/pivot/src");
const pivotFile = (spec: string): string | null => {
  if (!/^pivot\/[\w/-]+$/.test(spec)) return null;
  const f = join(PIVOT_SRC, `${spec.slice("pivot/".length)}.ts`);
  return existsSync(f) ? f : null;
};

// a keyword right after a quote is a string's text (the value "import" of manifest.written's why), not an import
const IMPORT = /(?<!["'])\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|(?<!["'])\bimport\s*\(?\s*["']([^"']+)["']/g;

/** Every file reachable from `entries` through relative imports. */
function closure(entries: string[]): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of code(readFileSync(file, "utf8")).matchAll(IMPORT)) {
      const spec = m[1] ?? m[2]!;
      const fromPivot = pivotFile(spec);
      if (fromPivot !== null) { visit(fromPivot); continue; }
      if (!spec.startsWith(".")) continue;
      const base = resolve(dirname(file), spec);
      const target = [base, `${base}.ts`, join(base, "index.ts")].find((p) => existsSync(p) && p.endsWith(".ts"));
      if (target) visit(target);
    }
  };
  entries.forEach(visit);
  return [...seen];
}

/** Imports of `bun:*` or `node:*` (or any bare module), and uses of the Bun, process and Buffer globals. */
function violations(files: string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const text = code(readFileSync(file, "utf8"));
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] ?? m[2]!;
      // a pivot module is followed by the closure and checked like any other file
      if (!spec.startsWith(".") && pivotFile(spec) === null) out.push(`${file}: imports ${spec}`);
    }
    for (const g of ["Bun", "process", "Buffer"]) {
      if (new RegExp(`(?<![.\\w$])${g}\\b`).test(text)) out.push(`${file}: uses ${g}`);
    }
  }
  return out;
}

test("the browser-shared modules bundle for the browser", async () => {
  const result = await Bun.build({ entrypoints: ENTRY_POINTS, target: "browser", throw: false });
  expect(result.logs.map((l) => l.message)).toEqual([]);
  expect(result.success).toBe(true);
});

test("the browser-shared modules import no runtime module and use no Bun, process or Buffer global", () => {
  const files = closure(ENTRY_POINTS);
  expect(files.length).toBeGreaterThanOrEqual(ENTRY_POINTS.length);
  // pivot's shared vocabulary and browser builders are in the closure, checked like the workbench's own files
  expect(files).toContain(join(PIVOT_SRC, "types.ts"));
  expect(files).toContain(join(PIVOT_SRC, "web", "dom.ts"));
  expect(violations(files)).toEqual([]);
});

test("the check itself catches each kind of violation", () => {
  const d = mkdtempSync(join(tmpdir(), "browser-safety-"));
  dirs.push(d);
  const bad = join(d, "bad.ts");
  const ok = join(d, "ok.ts");
  writeFileSync(ok, `// process and Bun in a comment are fine\n/* so is Buffer */\nexport const x = globalThis.navigator.process + 1;\n`);
  writeFileSync(bad, `import { readFileSync } from "node:fs";\nimport "./ok";\nexport const a = process.env, b = Bun.version, c = Buffer.from("x"), d = readFileSync;\n`);
  const found = violations(closure([bad]));
  expect(found).toEqual([`${bad}: imports node:fs`, `${bad}: uses Bun`, `${bad}: uses process`, `${bad}: uses Buffer`]);
  expect(closure([bad])).toEqual([bad, ok]);
});

test("src/web and src/core/state import none of lessons.ts, memstore.ts, memfile.ts", () => {
  const SERVER_SIDE = ["lessons.ts", "memstore.ts", "memfile.ts"].map((f) => join(CORE, f));
  for (const f of SERVER_SIDE) expect(existsSync(f)).toBe(true);
  // nothing the browser bundles, and nothing the fold is made of, reaches them by any chain of imports (build.ts, which bundles the
  // interface on the server and is never bundled itself, aside)
  const reached = closure([...ENTRY_POINTS, ...listTs(WEB).filter((f) => f !== join(WEB, "build.ts")), ...listTs(join(CORE, "state"))]);
  expect(reached.length).toBeGreaterThan(ENTRY_POINTS.length);
  for (const f of SERVER_SIDE) expect(`${f}: ${reached.includes(f)}`).toBe(`${f}: false`);
  // the check sees such an import
  const d = mkdtempSync(join(tmpdir(), "browser-safety-"));
  dirs.push(d);
  const planted = join(d, "planted.ts");
  writeFileSync(planted, `import { foldLessons } from "${join(CORE, "lessons")}";\nexport const x = foldLessons;\n`.replace(`"${join(CORE, "lessons")}"`, JSON.stringify(`./${relativeTo(d, join(CORE, "lessons"))}`)));
  expect(closure([planted])).toContain(join(CORE, "lessons.ts"));
});

/** Every .ts file under a folder. */
function listTs(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? listTs(p) : n.endsWith(".ts") ? [p] : [];
  });
}
const relativeTo = (from: string, to: string): string => relative(from, to).split("\\").join("/");

test("src/core/state/improve.ts and src/core/score.ts are browser-safe", async () => {
  const IMPROVE = join(CORE, "state", "improve.ts");
  const SCORE = join(CORE, "score.ts");
  for (const f of [IMPROVE, SCORE]) expect(existsSync(f)).toBe(true);
  const files = closure([IMPROVE, SCORE]);
  expect(files).toContain(IMPROVE);
  expect(files).toContain(SCORE);
  expect(violations(files)).toEqual([]);
  // nothing they reach is outside src/core, but pivot's shared vocabulary that core/types.ts takes
  for (const f of files) expect(`${f}: ${f.startsWith(`${CORE}/`) || f.startsWith(`${PIVOT_SRC}/`)}`).toBe(`${f}: true`);
  expect(files.some((f) => f.startsWith(`${WEB}/`))).toBe(false);
  // the fold reaches the improve reducer, so it is in what the browser bundles
  expect(closure(ENTRY_POINTS)).toContain(IMPROVE);
  const result = await Bun.build({ entrypoints: [IMPROVE, SCORE], target: "browser", throw: false });
  expect(result.logs.map((l) => l.message)).toEqual([]);
  expect(result.success).toBe(true);
});
