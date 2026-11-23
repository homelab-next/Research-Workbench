import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { GATES, MARKINGS, PARTIAL_REASONS, SECTIONS, STAGE_OUTCOMES, STEP_OUTCOMES } from "../../src/core/types";

const SRC = join(import.meta.dir, "../../src");
function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? sources(join(dir, d.name)) : d.name.endsWith(".ts") ? [join(dir, d.name)] : [],
  );
}
const files = sources().map((f) => ({ name: relative(SRC, f), text: readFileSync(f, "utf8") }));
const where = (re: RegExp) => files.filter((f) => re.test(f.text)).map((f) => f.name).sort();

test("the shape helpers are defined once, in state/guards.ts", () => {
  for (const name of ["isStr", "isNum", "isObj", "isStrList", "isOneOf", "has", "isObject", "isRecord"]) {
    expect(where(new RegExp(`(const|function)\\s+${name}\\b\\s*[=(<]`)), name).toEqual(name === "isObject" || name === "isRecord" ? [] : ["core/state/guards.ts"]);
  }
});

test("the marking list and the other enumerations live only in types.ts", () => {
  expect(where(/"TLP:CLEAR"/)).toEqual(["core/types.ts"]);
  expect(where(/\["summary",/)).toEqual([]);
  expect(where(/\["plan", "publish"\]/)).toEqual([]);
  expect(where(/\["pass", "fail"/)).toEqual([]);
});

test("the delivery loop and the default error handler are written once", () => {
  expect(where(/delivering = true/)).toEqual(["core/deliver.ts"]);
  expect(where(/console\.error/).filter((f) => f.startsWith("core/"))).toEqual(["core/deliver.ts"]);
});

test("the runtime lists hold every member of their types, in order", () => {
  expect(MARKINGS).toEqual(["TLP:CLEAR", "TLP:GREEN", "TLP:AMBER", "TLP:AMBER+STRICT", "TLP:RED"]);
  expect(SECTIONS).toEqual(["summary", "key_findings", "gaps_and_limits", "alternatives", "assessment"]);
  expect(GATES).toEqual(["plan", "publish"]);
  expect(STAGE_OUTCOMES).toEqual(["pass", "fail", "declined"]);
  expect(STEP_OUTCOMES).toEqual(["answered", "empty", "partial", "blocked", "failed"]);
  expect(PARTIAL_REASONS).toEqual(["row_limit", "timeout", "window_clipped", "source_error", "budget"]);
  expect(Object.isFrozen(SECTIONS)).toBe(true);
});
