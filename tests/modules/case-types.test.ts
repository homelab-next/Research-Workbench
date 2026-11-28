import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadCaseTypes } from "../../src/modules/case-types";
import type { RootConfig } from "../../src/modules/config";
import { loadRegistry } from "../../src/modules/registry-record";
import { WORKBENCH_VERSION } from "../../src/core/casefile";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function root(files: Record<string, string>, trusted = true): RootConfig {
  const dir = mkdtempSync(join(tmpdir(), "rw-case-types-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return { path: dir, trusted, credentials: [] };
}

test("case types are read from every case-types manifest of a trusted root, sorted by id", () => {
  const r = root({
    "case-types/b.yaml": "kind: case-types\nid: b\ntypes:\n  - { id: phishing, title: Phishing, about: Mail that asks for a login }\n  - { id: malware, title: Malware }\n",
    "case-types/a.yaml": "kind: case-types\nid: a\ntitle: A\ntypes:\n  - { id: access-abuse, title: Access abuse, about: Use of an account beyond its role }\n",
  });
  const { types, problems } = loadCaseTypes(loadRegistry([r]));
  expect(problems).toEqual([]);
  expect(types).toEqual([
    { id: "access-abuse", title: "Access abuse", about: "Use of an account beyond its role" },
    { id: "malware", title: "Malware", about: "" },
    { id: "phishing", title: "Phishing", about: "Mail that asks for a login" },
  ]);
});

test("a type with an id that is not lower-case letters, digits and hyphens, with no title, or given twice is a problem, and the others are still read", () => {
  const r = root({
    "case-types/a.yaml": "kind: case-types\nid: a\ntypes:\n  - { id: Bad_Id, title: Bad }\n  - { id: no-title }\n  - { id: good, title: Good }\n  - { id: dup, title: First }\n  - { id: long, title: T, about: " + JSON.stringify("x".repeat(301)) + " }\n",
    "case-types/b.yaml": "kind: case-types\nid: b\ntypes:\n  - { id: dup, title: Second }\n  - { id: other, title: Other }\n",
  });
  const { types, problems } = loadCaseTypes(loadRegistry([r]));
  expect(types.map((t) => [t.id, t.title])).toEqual([["dup", "First"], ["good", "Good"], ["other", "Other"]]);
  expect(problems).toHaveLength(4);
  expect(problems.some((p) => p.includes("Bad_Id"))).toBe(true);
  expect(problems.some((p) => p.includes("no-title"))).toBe(true);
  expect(problems.some((p) => p.includes("long"))).toBe(true);
  expect(problems.some((p) => p.includes("dup"))).toBe(true);
});

test("a case-types manifest in a root that is not trusted is refused by the registry: a case-types manifest is accepted only from a trusted root", () => {
  const r = root({ "case-types/a.yaml": "kind: case-types\nid: a\ntypes:\n  - { id: x, title: X }\n" }, false);
  const reg = loadRegistry([r]);
  expect(reg.problems.map((p) => p.error)).toEqual(["a case-types manifest is accepted only from a trusted root"]);
  expect(loadCaseTypes(reg).types).toEqual([]);
});

test("a lesson-seeds manifest in a root that is not trusted is refused by the registry", () => {
  const r = root({ "lesson-seeds/a.yaml": "kind: lesson-seeds\nid: a\n" }, false);
  expect(loadRegistry([r]).problems.map((p) => p.error)).toEqual(["a lesson-seeds manifest is accepted only from a trusted root"]);
});

test("the workbench version is 0.14.0, in casefile.ts and package.json alike", () => {
  expect(WORKBENCH_VERSION).toBe("0.14.0");
  expect(JSON.parse(readFileSync(join(import.meta.dir, "../../package.json"), "utf8")).version).toBe("0.14.0");
});
