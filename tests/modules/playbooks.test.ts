import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/modules/registry";
import { fromText, maxLookups, whenText } from "../../src/modules/playbooks";
import { copySample } from "../helpers/sample-root";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function load(extra: string | null, trusted = true): Registry {
  const dir = mkdtempSync(join(tmpdir(), "rw-playbooks-"));
  dirs.push(dir);
  copySample(dir);
  if (extra !== null) {
    mkdirSync(join(dir, "playbooks"), { recursive: true });
    writeFileSync(join(dir, "playbooks", "extra.yaml"), extra);
  }
  return Registry.load([{ path: dir, trusted, credentials: [] }]);
}

const GOOD = (over: { id?: string; steps?: string; inputs?: string; end?: string; pivot?: string; from?: string; when?: string; max?: string } = {}): string => `kind: playbook
id: ${over.id ?? "extra"}
title: Extra
inputs: ${over.inputs ?? "[{ name: address, type: address }]"}
steps:
${over.steps ?? `  - { id: asset, pivot: ${over.pivot ?? "address_to_asset"}, from: ${over.from ?? "input.address"}${over.when ? `, when: ${over.when}` : ""}${over.max ? `, max_values: ${over.max}` : ""} }`}
${over.end ? `end: ${over.end}` : ""}
`;

test("the sample playbook loads with its steps parsed", () => {
  const registry = load(null);
  const p = registry.playbook("address-triage")!;
  expect(registry.problems).toEqual([]);
  expect(p.inputs).toEqual([{ name: "address", type: "address" }]);
  expect(p.steps.map((s) => [s.id, s.pivot, fromText(s), whenText(s), s.max_values])).toEqual([
    ["asset", "address_to_asset", "input.address", null, 5], ["lease", "address_to_asset_by_lease", "input.address", "asset.empty", 5],
    ["names", "address_to_domains", "input.address", null, 5], ["clients", "domain_to_clients", "names", "names.rows", 5]]);
  expect(p.end).toEqual(["asset"]);
  expect(maxLookups(p)).toBe(8);
  expect(registry.costlyPivots(p)).toEqual([]);
  expect(registry.playbooks().map((x) => x.id)).toEqual(["address-triage"]);
});

test("end defaults to the last step", () => {
  const registry = load(GOOD());
  expect(registry.problems).toEqual([]);
  expect(registry.playbook("extra")!.end).toEqual(["asset"]);
});

const thirteen = Array.from({ length: 13 }, (_, i) => `  - { id: s${i}, pivot: address_to_asset, from: input.address }`).join("\n");
const REFUSED: [string, string, string][] = [
  ["an unknown pivot", GOOD({ pivot: "nope" }), 'pivot "nope" is not loaded'],
  ["a step from a step that comes later", GOOD({ from: "later" }), '"later" is not an input or an earlier step'],
  ["a from of the wrong type", GOOD({ steps: "  - { id: a, pivot: domain_to_clients, from: input.address }" }), "takes a domain"],
  ["a when on an unknown step", GOOD({ when: "ghost.rows" }), '"ghost" is not an earlier step'],
  ["a when that is not rows or empty", GOOD({ steps: "  - { id: asset, pivot: address_to_asset, from: input.address }\n  - { id: b, pivot: address_to_asset, from: input.address, when: asset.partial }" }), "rows or empty"],
  ["two inputs of one type", GOOD({ inputs: "[{ name: a, type: address }, { name: b, type: address }]", from: "input.a" }), "two inputs of type address"],
  ["a step named input", GOOD({ steps: "  - { id: input, pivot: address_to_asset, from: input.address }" }), "may not be named input"],
  ["a duplicate step id", GOOD({ steps: "  - { id: asset, pivot: address_to_asset, from: input.address }\n  - { id: asset, pivot: address_to_asset, from: input.address }" }), 'duplicate step id "asset"'],
  ["thirteen steps", GOOD({ steps: thirteen }), "at most 12 steps"],
  ["max_values of 21", GOOD({ steps: "  - { id: n, pivot: address_to_domains, from: input.address }\n  - { id: c, pivot: domain_to_clients, from: n, max_values: 21 }" }), "max_values"],
  ["an end naming no step", GOOD({ end: "[ghost]" }), '"ghost" is not a step'],
];
for (const [name, yaml, fragment] of REFUSED) test(`a playbook with ${name} is rejected with the reason and nothing else is disturbed`, () => {
  const registry = load(yaml);
  expect(registry.playbook("extra")).toBeNull();
  const mine = registry.problems.filter((p) => p.path.endsWith("extra.yaml"));
  expect(mine.length).toBe(1);
  expect(mine[0]!.error).toContain(fragment);
  expect(registry.problems.length).toBe(1);
  expect(registry.playbook("address-triage")).not.toBeNull();
});

test("a playbook manifest may not take the id of the workbench's own does-it-belong playbook", () => {
  // final review M7: a root's playbook with that id would have its runs given a verdict
  const registry = load(GOOD({ id: "does-it-belong" }));
  expect(registry.playbook("does-it-belong")).toBeNull();
  const mine = registry.problems.filter((p) => p.path.endsWith("extra.yaml"));
  expect(mine.length).toBe(1);
  expect(mine[0]!.error).toContain('the id "does-it-belong" is the workbench\'s own');
  expect(registry.playbook("address-triage")).not.toBeNull();
});

test("a playbook in a root that is not trusted is refused", () => {
  const registry = load(GOOD(), false);
  expect(registry.playbook("extra")).toBeNull();
  expect(registry.problems.some((p) => p.error.includes("a playbook manifest is accepted only from a trusted root"))).toBe(true);
});

test("a costly pivot is named by costlyPivots", () => {
  const registry = load(GOOD({ pivot: "address_to_verdict" }));
  expect(registry.problems).toEqual([]);
  expect(registry.costlyPivots(registry.playbook("extra")!)).toEqual(["address_to_verdict"]);
});
