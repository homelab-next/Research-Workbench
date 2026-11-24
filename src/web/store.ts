import { apply, initial, isNext } from "../core/state";
import type { CaseState } from "../core/state";
import type { Entry } from "../core/types";
import type { EntrySource } from "./api";

export const SNAPSHOT_EVERY = 200;

/** Every entry of one case as it arrived, and the state they fold to: live, or as of a replay position. */
export class CaseStore {
  readonly id: string;
  readonly entries: Entry[] = [];
  connection: "live" | "reconnecting" = "live";
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

  /** Tells watchers the connection changed. */
  setConnection(c: "live" | "reconnecting"): void {
    if (this.connection === c) return;
    this.connection = c;
    this.notify();
  }
}

const BACKOFF_MS = [1000, 2000, 5000];

/** Keeps a store fed: opens the source after the store's head; on "gap" or a drop, closes and reopens after the head (after 1 s, 2 s, then every 5 s), setting `connection`. Returns the stop function. */
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
    const lost = (): void => {
      if (stopped || mine !== generation) return;
      generation++;
      if (closer === null) lostEarly = true; else { closer(); closeStream = null; }
      store.setConnection("reconnecting");
      const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!;
      failures++;
      timer = win.setTimeout(open, delay);
    };
    closer = source.open(store.id, store.live.seq, (entry) => {
      if (stopped || mine !== generation) return;
      const result = store.push(entry);
      if (result === "gap") lost();
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
