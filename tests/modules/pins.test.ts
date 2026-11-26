import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { stepPins } from "../../src/modules/pins";
import { sampleRoot } from "../helpers/sample-root";

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pins-")); sample = sampleRoot(dir); });
afterEach(() => { sample.close(); rmSync(dir, { recursive: true, force: true }); });

test("stepPins is a hash of the pivot and its inventory for a route step, of the playbook and every step's pivot for a playbook step, and null for what is not loaded", () => {
  const { registry } = sample;
  const pivot = registry.pivot("address_to_asset")!;
  const inventory = registry.inventory("assets")!;
  const domains = registry.pivot("address_to_domains")!;
  expect(stepPins(registry, { pivot: "address_to_asset" })).toBe(sha256Hex(canonical(["address_to_asset", pivot.hash, "assets", inventory.hash])));
  expect(stepPins(registry, { pivot: "address_to_domains" })).toBe(sha256Hex(canonical(["address_to_domains", domains.hash, null, null])));
  expect(stepPins(registry, { pivot: "", playbook: { id: "address-triage", hash: "x", inputs: [] } })).toMatch(/^[0-9a-f]{64}$/);
  expect(stepPins(registry, { pivot: "no_such_pivot" })).toBeNull();
  // the playbook's pins are its hash and each step's pivot, in step order
  const pb = registry.playbook("address-triage")!;
  const pin = (id: string): unknown[] => {
    const p = registry.pivot(id)!;
    const inv = p.inventory === null ? null : registry.inventory(p.inventory)!;
    return [id, p.hash, inv?.id ?? null, inv?.hash ?? null];
  };
  expect(stepPins(registry, { pivot: "", playbook: { id: pb.id, hash: "x", inputs: [] } })).toBe(sha256Hex(canonical([pb.hash, ...pb.steps.map((s) => pin(s.pivot))] as never)));
  expect(stepPins(registry, { pivot: "", playbook: { id: "no-such-playbook", hash: "x", inputs: [] } })).toBeNull();
});
