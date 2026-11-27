import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { toYaml } from "../../src/modules/yaml-write";

const SAMPLE_LOOP = join(import.meta.dir, "..", "..", "sample", "loops", "investigation.yaml");
const back = (v: Json): unknown => Bun.YAML.parse(toYaml(v));

test("toYaml of the sample's investigation loop parses back to the same value", () => {
  const value = Bun.YAML.parse(readFileSync(SAMPLE_LOOP, "utf8")) as Json;
  expect(back(value)).toEqual(value as never);
  // keys keep the order given
  expect(Object.keys(back(value) as object)).toEqual(Object.keys(value as object));
  // block style: no flow mapping or sequence but the empty ones
  expect(toYaml(value)).not.toMatch(/[{[](?![\]}])/);
});

test("strings that look like numbers, booleans, null, dates, anchors, comments, multi-line text and text with quotes parse back as the same strings", () => {
  // "1", "true", "null", "2026-11-27", "&a", "# x", "a\nb", "say \"hi\"", "", " lead", "- item", "key: value"
  const strings = ["1", "true", "null", "2026-11-27", "&a", "# x", "a\nb", "say \"hi\"", "", " lead", "- item", "key: value",
    "~", "no", "yes", "0x10", "1e3", "*ref", "!tag", "%x", "@x", "`x", "tab\there", "back\\slash", "\u2028line", "\u007fdel", "\u0085nel", "\ufeffbom", "é ünïcode"];
  for (const s of strings) {
    expect(back(s)).toBe(s);
    expect(back([s])).toEqual([s]);
    expect(back({ v: s })).toEqual({ v: s });
    // a string as a key, too
    expect(back({ [s]: 1 })).toEqual({ [s]: 1 });
  }
  const nested = { a: [{ b: "1", c: ["true", { d: "null" }] }, [["x", "y"], []]], "*": { "persona:researcher": "root", "k": { pinned: "a".repeat(64) } } } as Json;
  expect(back(nested)).toEqual(nested as never);
  expect(back({ n: 1, f: 1.5, neg: -2, t: true, z: null })).toEqual({ n: 1, f: 1.5, neg: -2, t: true, z: null });
});

test("empty lists and empty mappings are written as [] and {}", () => {
  expect(toYaml({ a: [], b: {} })).toBe("a: []\nb: {}\n");
  expect(toYaml([])).toBe("[]\n");
  expect(toYaml({})).toBe("{}\n");
  expect(back({ a: [[], {}], b: { c: [] } })).toEqual({ a: [[], {}], b: { c: [] } });
});
