import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Each of these helpers has one home, now in pivot (its own tests/single-helpers.test.ts holds pivot to it). The workbench reaches
// them through its re-exports and writes no second copy, so its connectors, guard and agents cannot drift from pivot's.
const SRC = join(import.meta.dir, "..", "..", "src");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}
const sources = files(SRC).map((f) => ({ file: relative(SRC, f), text: readFileSync(f, "utf8") }));
const where = (re: RegExp): string[] => sources.flatMap(({ file, text }) => [...text.matchAll(re)].map(() => file));

test.each([
  ["the placeholder pattern", /\\\{\(\[A-Za-z_\]\[A-Za-z0-9_\.\]\*\)\\\}/g],
  ["the loopback host list", /"127\.0\.0\.1", "localhost"/g],
  ["base URL parsing", /new URL\(this\.source\.location\)|function parseBase/g],
  ["capped body reading", /function readCapped/g],
  ["scrubbing", /\bscrub\(text: string/g],
  ["the guarded-table pattern", /\.split\("\."\)\.map\(/g],
  ["the regex escape", /\.replace\(\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g/g],
  ["the weight rule", /\.weight \?\? [\w.]*cost\.weight/g],
])("%s is pivot's alone: the workbench's src/ has no copy", (_name, re) => {
  expect(where(re as RegExp)).toEqual([]);
});

test("the helpers are reached through the re-exports", () => {
  // the regex escape the agents and the pipeline use is the guard's, re-exported
  for (const f of ["agents/draft.ts", "pipeline/conflict.ts"]) expect(sources.find((s) => s.file === f)!.text).toMatch(/import \{ escapeRe \} from "\.\.\/modules\/sqlguard";/);
});
