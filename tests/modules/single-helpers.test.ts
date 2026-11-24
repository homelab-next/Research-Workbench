import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Final review minor 11: each of these helpers is written once, so the connectors cannot drift apart.
const SRC = join(import.meta.dir, "..", "..", "src");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}
const sources = files(SRC).map((f) => ({ file: relative(SRC, f), text: readFileSync(f, "utf8") }));
const where = (re: RegExp): string[] => sources.flatMap(({ file, text }) => [...text.matchAll(re)].map(() => file));

test.each([
  ["the placeholder pattern", /\\\{\(\[A-Za-z_\]\[A-Za-z0-9_\.\]\*\)\\\}/g, "modules/connectors/placeholders.ts"],
  ["the loopback host list", /"127\.0\.0\.1", "localhost"/g, "modules/connectors/shared.ts"],
  ["base URL parsing", /new URL\(this\.source\.location\)|function parseBase/g, "modules/connectors/shared.ts"],
  ["capped body reading", /function readCapped/g, "modules/connectors/shared.ts"],
  ["scrubbing", /\bscrub\(text: string/g, "modules/connectors/shared.ts"],
  ["the guarded-table pattern", /\.split\("\."\)\.map\(/g, "modules/sqlguard.ts"],
  ["the regex escape", /\.replace\(\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g/g, "modules/sqlguard.ts"],
  ["the weight rule", /\.weight \?\? [\w.]*cost\.weight/g, "modules/manifests.ts"],
])("%s is defined in one place", (_name, re, home) => {
  expect(where(re as RegExp)).toEqual([home as string]);
});
