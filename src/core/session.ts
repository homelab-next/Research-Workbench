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
    const inputs = build(this.current, new IdAllocator(this.current));
    const entries = this.ledger.appendMany(inputs);
    for (const entry of entries) {
      this.current = apply(this.current, entry);
      const state = this.current;
      for (const fn of [...this.listeners]) {
        try {
          fn(entry, state);
        } catch (err) {
          try {
            this.onError(err, entry);
          } catch {
            // an error handler that throws is ignored
          }
        }
      }
    }
    return entries;
  }

  entries(after = 0): Entry[] {
    return this.ledger.read(after);
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
