import { apply, initial, isNext } from "../core/state";
import type { CaseState } from "../core/state";
import type { Entry } from "../core/types";
import type { EntrySource } from "./api";

export const SNAPSHOT_EVERY = 200;

/** Every entry of one case as it arrived, and the state they fold to: live, or as of a replay position. */
export class CaseStore {
  readonly id: string;
  readonly entries: Entry[] = [];
  /** "gone": the server says the case is not loaded (it was unloaded while open), so nothing follows it any more. */
  connection: "live" | "reconnecting" | "gone" = "live";
  private head: CaseState = initial();
  private pos: number | null = null;
  /** snapshots[i] is the state after entry i * SNAPSHOT_EVERY (snapshots[0] is the empty case). */
  private readonly snapshots: CaseState[] = [initial()];
  private readonly listeners = new Set<() => void>();
  private shownCache: { at: number; state: CaseState } | null = null;

  constructor(id: string) { this.id = id; }

  get live(): CaseState { return this.head; }
  get at(): number | null { return this.pos; }
  get shown(): CaseState {
    if (this.pos === null) return this.head;
    if (this.shownCache?.at !== this.pos) this.shownCache = { at: this.pos, state: this.stateAt(this.pos) };
    return this.shownCache.state;
  }

  push(entry: Entry): "applied" | "duplicate" | "gap" {
    // Anything that is not this case's own next entry on this chain is a reason to reload, never a silent fold.
    if (entry.case !== this.id) return "gap";
    if (entry.seq <= this.head.seq) return this.entries[entry.seq - 1]?.hash === entry.hash ? "duplicate" : "gap";
    if (!isNext(this.head, entry)) return "gap";
    const last = this.entries[this.entries.length - 1];
    if (last !== undefined && entry.prev_hash !== last.hash) return "gap";
    this.head = apply(this.head, entry);
    this.entries.push(entry);
    if (entry.seq % SNAPSHOT_EVERY === 0) this.snapshots[entry.seq / SNAPSHOT_EVERY] = this.head;
    this.notify();
    return "applied";
  }

  goTo(seq: number | null): void {
    this.pos = seq === null ? null : Math.max(0, Math.min(seq, this.head.seq));
    this.shownCache = null;
    this.notify();
  }

  /** The fold to `seq`, from the nearest snapshot at or before it. */
  stateAt(seq: number): CaseState {
    const upTo = Math.max(0, Math.min(seq, this.head.seq));
    let s = this.snapshots[Math.floor(upTo / SNAPSHOT_EVERY)] ?? initial();
    for (let i = s.seq; i < upTo; i++) s = apply(s, this.entries[i]!);
    return s;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn();
  }

  /** Drops every entry and the state they fold to, so the case is read again from 0: what it held is not the server's record. */
  reset(): void {
    this.entries.length = 0;
    this.head = initial();
    this.snapshots.length = 0;
    this.snapshots.push(initial());
    this.pos = null;
    this.shownCache = null;
    this.notify();
  }

  /** Tells watchers the connection changed. */
  setConnection(c: "live" | "reconnecting" | "gone"): void {
    if (this.connection === c) return;
    this.connection = c;
    this.notify();
  }
}

const BACKOFF_MS = [1000, 2000, 5000];

/**
 * Keeps a store fed: opens the source after the store's head; on "gap" or a drop, closes and reopens after the head (after 1 s, 2 s, then every 5 s), setting `connection`.
 * An entry off the store's chain, or a server that says the head is ahead of the case, empties the store first, so it reopens from 0. A server that says
 * the case is gone (not loaded) sets the connection to "gone" and opens nothing more; what was read is kept. Returns the stop function.
 */
export function follow(store: CaseStore, source: EntrySource, win: Window): () => void {
  let stopped = false;
  let closeStream: (() => void) | null = null;
  let timer: number | null = null;
  let failures = 0;
  let generation = 0;
  const open = (): void => {
    timer = null;
    const mine = ++generation;
    let closer: (() => void) | null = null;
    let lostEarly = false;
    const lost = (why?: "ahead" | "fork" | "gone"): void => {
      if (stopped || mine !== generation) return;
      generation++;
      if (why === "gone") {
        stopped = true;
        if (closer === null) lostEarly = true; else { closer(); closeStream = null; }
        store.setConnection("gone");
        return;
      }
      // ahead of the server, or off its chain: what is held is not this case's record, so it is dropped and read again from 0
      if (why !== undefined) store.reset();
      if (closer === null) lostEarly = true; else { closer(); closeStream = null; }
      store.setConnection("reconnecting");
      const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
      failures++;
      timer = win.setTimeout(open, delay);
    };
    closer = source.open(store.id, store.live.seq, (entry) => {
      if (stopped || mine !== generation) return;
      const result = store.push(entry);
      // a skipped seq is reopened after the head; anything else that does not follow on is off the chain
      if (result === "gap") lost(entry.case === store.id && entry.seq > store.live.seq + 1 ? undefined : "fork");
      else if (result === "applied") { failures = 0; store.setConnection("live"); }
    }, lost);
    if (lostEarly) closer(); else closeStream = closer;
  };
  open();
  return () => {
    stopped = true;
    if (timer !== null) win.clearTimeout(timer);
    closeStream?.();
    closeStream = null;
  };
}
