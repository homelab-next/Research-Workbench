import { ID_PREFIX } from "./state";
import type { CaseState, IdKind } from "./state";

/** Hands out ids of each kind: the first is one past the state's counter, then it counts up locally. */
export class IdAllocator {
  private readonly counters: Record<IdKind, number>;

  constructor(state: CaseState) {
    this.counters = { ...state.counters };
  }

  next(kind: IdKind): string {
    this.counters[kind] += 1;
    return ID_PREFIX[kind] + this.counters[kind];
  }
}
