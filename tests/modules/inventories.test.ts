import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { belongsPlaybook } from "../../src/modules/inventories";
import { Registry } from "../../src/modules/registry";
import { copySample, sampleRoot } from "../helpers/sample-root";
import type { CaseSession } from "../../src/core/session";
import type { PlaybookLookup } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { beginPlaybook, runPlaybook } from "../../src/modules/playbook-run";
import type { PlaybookStart } from "../../src/modules/playbook-run";
import type { RunnerDeps } from "../../src/modules/runner";
import { person, START, WINDOW } from "../helpers/tools-fixture";

let dir: string;
let root: string;
let registry: Registry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inventories-"));
  root = join(dir, "sample");
  copySample(root);
  registry = Registry.load([{ path: root, trusted: true, credentials: [] }]);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The sample again after `change` edits a file under it, read by a fresh registry. */
function edited(file: string, change: (text: string) => string): Registry {
  const path = join(root, file);
  writeFileSync(path, change(readFileSync(path, "utf8")));
  return Registry.load([{ path: root, trusted: true, credentials: [] }]);
}
/** The pivot block for `id` in the sample's pivots.yaml, changed by `change`. */
const pivotBlock = (id: string, change: (block: string) => string) => (text: string): string =>
  text.replace(new RegExp(`(  - id: ${id}\\n(?:    .*\\n)*)`), (b) => change(b));

test("the sample's two inventories load and their pivots name them", () => {
  expect(registry.problems).toEqual([]);
  expect(registry.inventories().map((i) => [i.id, i.complete, i.derived])).toEqual([["assets", true, false], ["leases", false, true]]);
  expect(registry.pivot("address_to_asset")!.inventory).toBe("assets");
  expect(registry.pivot("address_to_asset_by_lease")!.inventory).toBe("leases");
  expect(registry.pivot("address_to_domains")!.inventory).toBeNull();
  expect(registry.inventory("leases")!.title).toBe("Lease records");
  expect(registry.inventory("nope")).toBeNull();
});

test("an inventory decides what an empty answer means for a pivot that states none", () => {
  const r = edited("pivots.yaml", (t) => pivotBlock("address_to_asset_by_lease", (b) => b.replace(/    empty_means: .*\n/, ""))(
    pivotBlock("address_to_asset", (b) => b.replace(/    empty_means: .*\n/, ""))(t)));
  expect(r.problems).toEqual([]);
  expect(r.pivot("address_to_asset")!.empty_means).toBe("proven-negative");
  expect(r.pivot("address_to_asset_by_lease")!.empty_means).toBe("not-seen");
});

const REFUSED: [string, string][] = [
  ["a complete inventory with no basis", "needs a basis"], ["a complete inventory that is derived", "a derived list cannot be complete"],
  ["a pivot naming an inventory that is not loaded", "is not loaded"], ["a pivot whose target is not what the inventory holds", "but inventory"],
  ["a pivot stating proven-negative on an inventory that is not complete", "contradicts inventory"],
  ["a pivot stating not-seen on a complete inventory", "contradicts inventory"], ["an inventory in a root that is not trusted", "only from a trusted root"],
];
/** Each case: the change to make, and the kind and id of the manifest that must then be missing. */
const MAKE: Record<string, () => { registry: Registry; kind: "inventory" | "pivot"; id: string }> = {
  "a complete inventory with no basis": () => ({ registry: edited("inventories/assets.yaml", (t) => t.replace(/basis: .*\n/, "")), kind: "inventory", id: "assets" }),
  "a complete inventory that is derived": () => ({ registry: edited("inventories/assets.yaml", (t) => t.replace("derived: false", "derived: true")), kind: "inventory", id: "assets" }),
  "a pivot naming an inventory that is not loaded": () => ({
    registry: edited("pivots.yaml", pivotBlock("address_to_asset", (b) => b.replace("inventory: assets", "inventory: nothing"))), kind: "pivot", id: "address_to_asset",
  }),
  "a pivot whose target is not what the inventory holds": () => ({
    registry: edited("pivots.yaml", pivotBlock("address_to_domains", (b) => `${b}    inventory: assets\n`)), kind: "pivot", id: "address_to_domains",
  }),
  "a pivot stating proven-negative on an inventory that is not complete": () => ({
    registry: edited("pivots.yaml", pivotBlock("address_to_asset_by_lease", (b) => b.replace("empty_means: not-seen", "empty_means: proven-negative"))),
    kind: "pivot", id: "address_to_asset_by_lease",
  }),
  "a pivot stating not-seen on a complete inventory": () => ({
    registry: edited("pivots.yaml", pivotBlock("address_to_asset", (b) => b.replace("empty_means: proven-negative", "empty_means: not-seen"))), kind: "pivot", id: "address_to_asset",
  }),
  "an inventory in a root that is not trusted": () => {
    const other = join(dir, "other");
    mkdirSync(other);
    writeFileSync(join(other, "hosts.yaml"), "kind: inventory\nid: hosts\ntitle: Hosts\nholds: asset\nscope: everything\ncomplete: false\n");
    return {
      registry: Registry.load([{ path: root, trusted: true, credentials: [] }, { path: other, trusted: false, credentials: [] }]), kind: "inventory", id: "hosts",
    };
  },
};
for (const [name, fragment] of REFUSED) {
  test(`${name} is rejected with the reason`, () => {
    const { registry: r, kind, id } = MAKE[name]!();
    if (kind === "inventory") expect(r.inventory(id)).toBeNull();
    else expect(r.pivot(id)).toBeNull();
    expect(r.get(kind, id)).toBeNull();
    // a playbook that used a rejected pivot is rejected after it, so the reason is looked for, not counted
    expect(r.problems.some((p) => p.error.includes(fragment))).toBe(true);
  });
}

test("a pivot from an untrusted root may not name an inventory", () => {
  const other = join(dir, "other");
  mkdirSync(join(other, "sources"), { recursive: true });
  writeFileSync(join(other, "sources", "hosts.yaml"), "kind: source\nid: hosts\ntitle: Hosts\nconnector: files\nlocation: ../data\nmarking: \"TLP:GREEN\"\nwhere: machine\ntables:\n  - { name: hosts, file: hosts.csv, format: csv, time_column: null, columns: [] }\n");
  writeFileSync(join(other, "pivots.yaml"), "kind: pivots\npivots:\n  - { id: host_of, from: address, to: asset, source: hosts, query: \"select asset from hosts where address = {value}\", inventory: assets, yields: { asset: asset } }\n");
  const r = Registry.load([{ path: root, trusted: true, credentials: [] }, { path: other, trusted: false, credentials: [] }]);
  expect(r.pivot("host_of")).toBeNull();
  expect(r.problems.map((p) => p.error)).toContain(`pivot "host_of": only a pivot from a trusted root may name an inventory`);
});

test("does-it-belong is one step per inventory pivot that takes the type, and none for a type no inventory takes", () => {
  const p = belongsPlaybook(registry, "address")!;
  expect(p.id).toBe("does-it-belong");
  expect(p.steps.map((s) => [s.id, s.pivot, s.when])).toEqual([["i1", "address_to_asset", null], ["i2", "address_to_asset_by_lease", null]]);
  expect(p.steps.every((s) => "input" in s.from && s.from.input === "address")).toBe(true);
  expect(p.inputs).toEqual([{ name: "address", type: "address" }]);
  expect(p.end).toEqual(["i1", "i2"]);
  expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(belongsPlaybook(registry, "address")!.hash).toBe(p.hash);
  expect(belongsPlaybook(registry, "domain")).toBeNull();
  // a change to an inventory is a different playbook
  const changed = edited("inventories/leases.yaml", (t) => `${t}# edited\n`);
  expect(belongsPlaybook(changed, "address")!.hash).not.toBe(p.hash);
});

// ---------- a reused answer is only as good as the inventory it was read under ----------
async function belongsTwice(change: ((sampleRoot: string) => void) | null): Promise<{ first: PlaybookLookup; second: PlaybookLookup; body: string; s: CaseSession }> {
  const sample = sampleRoot(join(dir, "run"));
  const wb = Workbench.open(join(dir, "wb"), { onError: () => {} });
  try {
    const s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [{ type: "address", value: START }], window: WINDOW, objective: null, marking: "TLP:GREEN" }, person);
    // the pivot states no empty_means, so the inventory alone decides it
    const pivots = join(sample.root, "pivots.yaml");
    writeFileSync(pivots, pivotBlock("address_to_asset", (b) => b.replace(/    empty_means: .*\n/, ""))(readFileSync(pivots, "utf8")));
    const once = async (deps: RunnerDeps): Promise<PlaybookLookup> => {
      const start: PlaybookStart = { playbook: belongsPlaybook(deps.registry, "address")!, inputs: [{ type: "address", value: START }], window: WINDOW, why: "is it ours", actor: person };
      const job = beginPlaybook(s, deps, start);
      await runPlaybook(s, deps, job, start);
      return s.state.playbooks[job]!.steps.i1!.lookups[0]!;
    };
    const load = () => Registry.load([{ path: sample.root, trusted: true, credentials: [] }]);
    const firstRegistry = load();
    const first = await once({ ...sample.deps, registry: firstRegistry });
    change?.(sample.root);
    const second = await once({ ...sample.deps, registry: load() });
    const body = s.state.cards[second.card!]!.body;
    expect(s.state.skipped).toEqual([]);
    return { first, second, body, s };
  } finally {
    wb.close();
    sample.close();
  }
}

test("a proven negative is not reused once its inventory is no longer complete: the lookup runs again and reads not seen", async () => {
  const { first, second, body } = await belongsTwice((r) => {
    const f = join(r, "inventories", "assets.yaml");
    writeFileSync(f, readFileSync(f, "utf8").replace("complete: true", "complete: false"));
  });
  expect(first).toMatchObject({ outcome: "empty", reused: false, detail: "proven negative" });
  expect(second).toMatchObject({ outcome: "empty", reused: false, detail: "not seen" });
  expect(second.query).not.toBe(first.query);
  expect(body).toBe("No rows · not seen (not proof of absence) · Asset list is not declared complete");
});

test("a reused lookup says what the answer it reuses means", async () => {
  const { first, second } = await belongsTwice(null);
  expect(second.reused).toBe(true);
  expect(second.query).toBe(first.query);
  expect(second.detail).toEndWith("; same pivot, value and window · proven negative");
});
