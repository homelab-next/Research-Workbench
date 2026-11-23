import type { BlobStore } from "./blobs";
import { Delivery, logToStderr } from "./deliver";
import type { Ledger } from "./ledger";
import { IdAllocator } from "./ids";
import { apply, fold, initial } from "./state";
import type { CaseState } from "./state";
import type { Entry, EntryInput } from "./types";

type Listener = (entry: Entry, state: CaseState) => void;

export class CaseSession {
  readonly id: string;
  readonly dir: string;
  readonly blobs: BlobStore;
  private readonly ledger: Ledger;
  private readonly listeners = new Set<Listener>();
  private readonly delivery: Delivery<Listener, { entry: Entry; state: CaseState }>;
  private current: CaseState;
  private building = false;

  constructor(opts: { id: string; dir: string; ledger: Ledger; blobs: BlobStore; onError?: (error: unknown, entry: Entry) => void }) {
    this.id = opts.id;
    this.dir = opts.dir;
    this.ledger = opts.ledger;
    this.blobs = opts.blobs;
    const onError = opts.onError ?? logToStderr("session subscriber failed");
    this.delivery = new Delivery(this.listeners, (fn, item) => fn(item.entry, item.state), (error, item) => onError(error, item.entry));
    this.current = fold(opts.ledger.read());
  }

  get state(): CaseState {
    return this.current;
  }

  /** Builds entries from the current state, appends them in one transaction, then advances state. */
  commit(build: (state: CaseState, ids: IdAllocator) => EntryInput[]): Entry[] {
    if (this.building) throw new Error("commit called from inside a commit builder");
    let inputs: EntryInput[];
    this.building = true;
    try {
      inputs = build(this.current, new IdAllocator(this.current));
    } finally {
      this.building = false;
    }
    const entries = this.ledger.appendMany(inputs);
    // Advance state over the whole batch first, so state always equals the fold of the ledger,
    // then tell subscribers in seq order, each with the state as of its entry.
    let state = this.current;
    const items = entries.map((entry) => ({ entry, state: (state = apply(state, entry)) }));
    this.current = state;
    // A nested commit from a listener only queues; the outer loop delivers it.
    this.delivery.send(items);
    return entries;
  }

  entries(after = 0, limit = -1): Entry[] {
    return this.ledger.read(after, limit);
  }

  stateAt(seq: number): CaseState {
    return seq <= 0 ? initial() : fold(this.ledger.read(), seq);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  close(): void {
    this.ledger.close();
  }

  head(): { seq: number; hash: string } {
    return this.ledger.head();
  }
}
