import { canonical } from "../core/canonical";
import type { Json } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { PlanStep } from "../core/types";
import type { Registry } from "./registry";

/** [pivot id, pivot hash, inventory id | null, inventory hash | null]; null when the pivot, or the inventory it names, is not loaded. */
function pivotPin(registry: Registry, id: string): Json[] | null {
  const p = registry.pivot(id);
  if (p === null) return null;
  if (p.inventory === null) return [id, p.hash, null, null];
  const inv = registry.inventory(p.inventory);
  return inv === null ? null : [id, p.hash, inv.id, inv.hash];
}

/** sha256Hex(canonical(x)). Playbook step: x = [playbook hash, ...steps.map(s => [s.pivot, pivot hash, inventory id | null, inventory hash | null])].
 *  Route step: x = [pivot id, pivot hash, inventory id | null, inventory hash | null]. Null when the playbook or a pivot is not loaded. */
export function stepPins(registry: Registry, step: Pick<PlanStep, "pivot" | "playbook">): string | null {
  if (step.playbook !== undefined) {
    const p = registry.playbook(step.playbook.id);
    if (p === null) return null;
    const pins: Json[] = [p.hash];
    for (const s of p.steps) {
      const pin = pivotPin(registry, s.pivot);
      if (pin === null) return null;
      pins.push(pin);
    }
    return sha256Hex(canonical(pins));
  }
  const pin = pivotPin(registry, step.pivot);
  return pin === null ? null : sha256Hex(canonical(pin));
}
