import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { Schema } from "../core/schema";
import { ManifestError } from "./manifests";
import { DEFAULT_STEP_VALUES } from "./playbooks";
import type { PlaybookManifest, PlaybookStep } from "./playbooks";
import type { Registry } from "./registry";

/**
 * A list of things of one type that a source keeps, and whether it is declared complete for its scope. Only a complete list
 * makes an empty answer a proven negative; a list derived from something else (leases, logs) can never be complete.
 */
export interface InventoryManifest { id: string; title: string; hash: string; holds: string; scope: string; complete: boolean; basis: string; derived: boolean }

const name: Schema = { type: "string", minLength: 1 };

export const INVENTORY_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "title", "holds", "scope", "complete"],
  properties: {
    kind: { const: "inventory" },
    id: name, title: name, holds: name, scope: name,
    complete: { type: "boolean" },
    basis: { type: "string" },
    derived: { type: "boolean" },
  },
};

/** Builds an inventory from a validated body. A complete inventory must say why (its basis) and may not be derived. */
export function toInventory(body: Record<string, Json>, hash: string): InventoryManifest {
  const b = body as Record<string, any>; // validated against INVENTORY_SCHEMA by the caller
  const basis: string = (b.basis ?? "").trim();
  const derived: boolean = b.derived ?? false;
  if (b.complete === true && basis === "") throw new ManifestError(`inventory "${b.id}": a complete inventory needs a basis (why the list holds every ${b.holds} in its scope)`);
  if (b.complete === true && derived) throw new ManifestError(`inventory "${b.id}": it is derived, and a derived list cannot be complete`);
  return { id: b.id, title: b.title, hash, holds: b.holds, scope: b.scope, complete: b.complete, basis, derived };
}

export const BELONGS_ID = "does-it-belong";

/**
 * A playbook made on the spot: one step per inventory pivot that takes `type`, in pivot-id order, steps named i1, i2, …; end is every step.
 * Null when no inventory pivot takes the type. Its hash is sha256 of the canonical list of [pivot id, pivot hash, inventory id, inventory hash].
 */
export function belongsPlaybook(registry: Registry, type: string): PlaybookManifest | null {
  const asked = registry.pivots()
    .filter((p) => p.from === type && p.inventory !== null && registry.inventory(p.inventory) !== null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (asked.length === 0) return null;
  const steps: PlaybookStep[] = asked.map((p, i) => ({ id: `i${i + 1}`, pivot: p.id, from: { input: type }, when: null, max_values: DEFAULT_STEP_VALUES }));
  const hash = sha256Hex(canonical(asked.map((p) => {
    const inv = registry.inventory(p.inventory!)!;
    return [p.id, p.hash, inv.id, inv.hash];
  })));
  return {
    id: BELONGS_ID, title: "Does it belong?", hash, about: `Asks every inventory a ${type} can be looked up in whether it lists the value.`,
    inputs: [{ name: type, type }], steps, end: steps.map((s) => s.id),
  };
}
