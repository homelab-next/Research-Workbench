import { ID_PREFIX } from "./state";
import type { CaseState, IdKind } from "./state";

/**
 * Hands out ids of each kind: the first is one past the state's counter, then it counts up locally.
 *
 * The rule: within one commit, every `next(kind)` must be matched by exactly one creating entry of that
 * kind (card.created for "card", lane.created for "lane", and so on; see `countedKind`), and every
 * creating entry must take its id from here. The state's counters count creating entries, not ids
 * handed out, so an id taken and not used would be handed out again by the next commit, and a literal
 * id would collide with one the allocator gives later. `CaseSession.commit` enforces the rule and
 * refuses the whole commit before appending when the counts differ for any kind.
 */
export class IdAllocator {
  private readonly counters: Record<IdKind, number>;
  private readonly handedOut: Partial<Record<IdKind, number>> = {};

  constructor(state: Readonly<CaseState>) {
    this.counters = { ...state.counters };
  }

  next(kind: IdKind): string {
    this.counters[kind] += 1;
    this.handedOut[kind] = (this.handedOut[kind] ?? 0) + 1;
    return ID_PREFIX[kind] + this.counters[kind];
  }

  /** How many ids of each kind this allocator has handed out. */
  taken(): Partial<Record<IdKind, number>> {
    return { ...this.handedOut };
  }
}
