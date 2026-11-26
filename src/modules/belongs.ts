import { canonical } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { PlaybookManifest } from "./playbooks";
import type { Registry } from "./registry";
import { belongsPlaybook as pivotBelongs } from "pivot/catalogue/inventories";

/**
 * pivot's "does it belong?" playbook for `type`, with its hash computed by the workbench: sha256Hex(canonical(...)) of
 * [pivot id, pivot hash, inventory id, inventory hash] for each step, in step order. playbook.started records this hash.
 */
export function belongsPlaybook(registry: Registry, type: string): PlaybookManifest | null {
  const p = pivotBelongs(registry, type);
  if (p === null) return null;
  const hash = sha256Hex(canonical(p.steps.map((s) => {
    const pivot = registry.pivot(s.pivot);
    const inv = pivot?.inventory == null ? null : registry.inventory(pivot.inventory);
    if (pivot === null || inv === null) throw new Error(`does-it-belong step ${s.id} names pivot "${s.pivot}", which has no inventory`);
    return [pivot.id, pivot.hash, inv.id, inv.hash];
  })));
  return { ...p, hash };
}
