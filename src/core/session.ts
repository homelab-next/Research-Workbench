import type { BlobStore } from "./blobs";
import { Delivery, logToStderr } from "./deliver";
import { draftHashMatches, InvalidEntryError } from "./ledger";
import type { Ledger } from "./ledger";
import { IdAllocator } from "./ids";
import { apply, countedKind, fold, initial, isNext } from "./state";
import type { CaseState, IdKind } from "./state";
import type { Entry, EntryInput } from "./types";

/** A commit whose builder took ids it did not use for creating entries, or created entries with ids it did not take. */
export class IdAllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdAllocationError";
  }
}

/** Throws unless, for every id kind, the ids taken equal the creating entries in the commit (the rule on IdAllocator). */
function checkIds(inputs: readonly EntryInput[], ids: IdAllocator): void {
  const taken = ids.taken();
  const created: Partial<Record<IdKind, number>> = {};
  for (const input of inputs) {
    const kind = countedKind(input?.type);
    if (kind !== undefined) created[kind] = (created[kind] ?? 0) + 1;
  }
  const kinds = [...new Set([...Object.keys(taken), ...Object.keys(created)] as IdKind[])].sort();
  const wrong = kinds.filter((k) => (taken[k] ?? 0) !== (created[k] ?? 0));
  if (wrong.length > 0) {
    const detail = wrong.map((k) => `${k}: ${taken[k] ?? 0} taken, ${created[k] ?? 0} created`).join("; ");
    throw new IdAllocationError(`every id taken must be used by one creating entry of the same commit (${detail})`);
  }
}

type Listener = (entry: Entry, state: Readonly<CaseState>) => void;

export class CaseSession {
  readonly id: string;
  readonly dir: string;
  readonly blobs: BlobStore;
  private readonly ledger: Ledger;
  private readonly listeners = new Set<Listener>();
  private readonly delivery: Delivery<Listener, { entry: Entry; state: CaseState }>;
  private current: CaseState;
  private building = false;

  private readonly onClose: (() => void) | undefined;

  constructor(opts: { id: string; dir: string; ledger: Ledger; blobs: BlobStore; onError?: (error: unknown, entry: Entry) => void; onClose?: () => void }) {
    this.onClose = opts.onClose;
    this.id = opts.id;
    this.dir = opts.dir;
    this.ledger = opts.ledger;
    this.blobs = opts.blobs;
    const onError = opts.onError ?? logToStderr("session subscriber failed");
    this.delivery = new Delivery(this.listeners, (fn, item) => fn(item.entry, item.state), (error, item) => onError(error, item.entry));
    this.current = fold(opts.ledger.read());
  }

  /**
   * The state as of the newest entry. It is read-only: it is shared with every subscriber and builder,
   * parts of it are the (frozen) entry payloads, and the next commit builds on it. Copy before changing.
   */
  get state(): Readonly<CaseState> {
    return this.current;
  }

  /**
   * Builds entries from the current state, appends them in one transaction, then advances state.
   * State always equals the fold of the ledger: entries another writer appended are applied (and told
   * to subscribers) before the builder runs, and again if one slips in between the build and the append.
   */
  commit(build: (state: Readonly<CaseState>, ids: IdAllocator) => EntryInput[]): Entry[] {
    if (this.building) throw new Error("commit called from inside a commit builder");
    this.catchUp();
    let inputs: EntryInput[];
    const ids = new IdAllocator(this.current);
    this.building = true;
    try {
      inputs = build(this.current, ids);
    } finally {
      this.building = false;
    }
    checkIds(inputs, ids);
    for (const input of inputs) {
      if (input?.type === "draft.revised" && !draftHashMatches(input.payload?.draft)) {
        throw new InvalidEntryError(`draft ${String(input.payload?.draft?.n)}: hash is not the hash of its product`);
      }
    }
    const entries = this.ledger.appendMany(inputs);
    if (entries.length > 0 && !isNext(this.current, entries[0]!)) {
      // Another writer appended between catching up and appending: read everything since, ours included.
      this.catchUp();
    } else {
      this.advance(entries);
    }
    return entries;
  }

  /** Applies entries the ledger has beyond the current state, and tells subscribers. */
  private catchUp(): void {
    if (this.ledger.head().seq > this.current.seq) this.advance(this.ledger.read(this.current.seq));
  }

  /**
   * Advances state over the whole batch first, so state always equals the fold of the ledger, then
   * tells subscribers in seq order, each with the state as of its entry. A nested commit from a
   * listener only queues; the outer loop delivers it.
   */
  private advance(entries: readonly Entry[]): void {
    let state = this.current;
    const items = entries.map((entry) => ({ entry, state: (state = apply(state, entry)) }));
    this.current = state;
    this.delivery.send(items);
  }

  entries(after = 0, limit = -1): Entry[] {
    return this.ledger.read(after, limit);
  }

  stateAt(seq: number): Readonly<CaseState> {
    return seq <= 0 ? initial() : fold(this.ledger.read(0, seq), seq);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Closes the ledger. The owner (the workbench) is told, so it stops handing out this session. */
  close(): void {
    try {
      this.ledger.close();
    } finally {
      this.onClose?.();
    }
  }

  head(): { seq: number; hash: string } {
    return this.ledger.head();
  }
}
