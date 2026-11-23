import type { Actor, Card, Entry, EntryType, Payloads } from "../../src/core/types";

const BASE_MS = Date.parse("2026-11-23T20:00:00.000Z");
const ZERO = "0".repeat(64);

type Extra = Partial<Pick<Entry, "actor" | "cause" | "run" | "stage" | "job" | "ts">>;

export class EntryBuilder {
  readonly entries: Entry[] = [];
  constructor(private readonly caseId = "case-1") {}

  add<T extends EntryType>(type: T, payload: Payloads[T], extra: Extra = {}): Entry {
    const seq = this.entries.length + 1;
    const actor: Actor = { kind: "system", id: "test" };
    const entry = {
      seq,
      ts: new Date(BASE_MS + seq * 1000).toISOString(),
      case: this.caseId,
      actor,
      type,
      payload,
      cause: null,
      run: null,
      stage: null,
      job: null,
      prev_hash: ZERO,
      hash: ZERO,
      ...extra,
    } as Entry;
    this.entries.push(entry);
    return entry;
  }

  also(fn: (b: this) => unknown): this {
    fn(this);
    return this;
  }
}

export function card(id: string, over: Partial<Card> = {}): Card {
  return {
    id,
    title: `Card ${id}`,
    body: "",
    kind: "result",
    made_by: "agent",
    query: null,
    columns: ["a"],
    column_types: [null],
    rows: [["x"]],
    row_count: 1,
    coverage: { kind: "full" },
    empty: null,
    marking: "TLP:AMBER",
    source: null,
    step: null,
    subgoal: null,
    why: "test",
    event_time: null,
    quality_notes: [],
    ...over,
  };
}
