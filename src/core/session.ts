import type { BlobStore } from "./blobs";
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
  private readonly onError: (error: unknown, entry: Entry) => void;
  private readonly listeners = new Set<Listener>();
  private current: CaseState;
  private building = false;
  private delivering = false;
  private readonly queue: { entry: Entry; state: CaseState }[] = [];

  constructor(opts: { id: string; dir: string; ledger: Ledger; blobs: BlobStore; onError?: (error: unknown, entry: Entry) => void }) {
    this.id = opts.id;
    this.dir = opts.dir;
    this.ledger = opts.ledger;
    this.blobs = opts.blobs;
    this.onError =
      opts.onError ??
      ((error, entry) => {
        console.error(`session subscriber failed on entry ${entry.seq}: ${error instanceof Error ? error.message : String(error)}`);
      });
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
    for (const entry of entries) {
      state = apply(state, entry);
      this.queue.push({ entry, state });
    }
    this.current = state;
    this.deliver();
    return entries;
  }

  /** A nested commit only queues; the outer loop delivers it. */
  private deliver(): void {
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (let item = this.queue.shift(); item !== undefined; item = this.queue.shift()) {
        for (const fn of [...this.listeners]) {
          try {
            fn(item.entry, item.state);
          } catch (err) {
            try {
              this.onError(err, item.entry);
            } catch {
              // an error handler that throws is ignored
            }
          }
        }
      }
    } finally {
      this.delivering = false;
    }
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
