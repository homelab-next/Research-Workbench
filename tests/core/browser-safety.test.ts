import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

const IMPORT = /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g;

/** Every file reachable from `entries` through relative imports. */
function closure(entries: string[]): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of code(readFileSync(file, "utf8")).matchAll(IMPORT)) {
      const spec = m[1] ?? m[2]!;
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
      if (!spec.startsWith(".")) out.push(`${file}: imports ${spec}`);
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
