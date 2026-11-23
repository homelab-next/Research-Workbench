import { Database } from "bun:sqlite";
import { canonical } from "./canonical";
import type { Json } from "./canonical";
import { Delivery, logToStderr } from "./deliver";
import { GENESIS, sha256Hex } from "./hash";
import type { Actor, Entry, EntryInput } from "./types";

export class LedgerCaseMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerCaseMismatchError";
  }
}

export class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

/** Largest allowed payload: UTF-8 bytes of its canonical JSON text. */
const MAX_PAYLOAD_BYTES = 262144;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries (
  seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
  cause INTEGER, run TEXT, stage TEXT, job TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);`;

/** sha256Hex(prev_hash + "\n" + canonical({ seq, ts, case, actor, type, payload, cause, run, stage, job })). */
export function entryHash(e: Omit<Entry, "hash">): string {
  const body = {
    seq: e.seq,
    ts: e.ts,
    case: e.case,
    actor: e.actor,
    type: e.type,
    payload: e.payload,
    cause: e.cause ?? null,
    run: e.run ?? null,
    stage: e.stage ?? null,
    job: e.job ?? null,
  };
  return sha256Hex(e.prev_hash + "\n" + canonical(body as unknown as Json));
}

interface Prepared {
  input: EntryInput;
  actorText: string;
  payloadText: string;
}

interface Row {
  seq: number;
  ts: string;
  actor: string;
  type: string;
  payload: string;
  cause: number | null;
  run: string | null;
  stage: string | null;
  job: string | null;
  prev_hash: string;
  hash: string;
}

export class Ledger {
  readonly caseId: string;
  private readonly db: Database;
  private readonly now: () => string;
  private readonly subscribers = new Set<(entry: Entry) => void>();
  private readonly delivery: Delivery<(entry: Entry) => void, Entry>;

  private constructor(db: Database, caseId: string, now: () => string, onError: (error: unknown, entry: Entry) => void) {
    this.db = db;
    this.caseId = caseId;
    this.now = now;
    // The entry is already committed when subscribers hear of it; a failing subscriber must not fail the append or starve others.
    this.delivery = new Delivery(this.subscribers, (fn, entry) => fn(entry), onError);
  }

  static open(path: string, caseId: string, opts: { now?: () => string; onError?: (error: unknown, entry: Entry) => void } = {}): Ledger {
    const db = new Database(path, { create: true });
    try {
      // Wait for other writers on the same file instead of failing.
      db.exec("PRAGMA busy_timeout = 10000");
      // One file per case: force the rollback journal even if the file was switched to WAL elsewhere.
      db.exec("PRAGMA journal_mode = DELETE");
      db.exec("PRAGMA synchronous = FULL");
      db.exec(SCHEMA);
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.query("SELECT value FROM meta WHERE key = 'case_id'").get() as { value: string } | null;
        if (row === null) {
          db.query("INSERT INTO meta (key, value) VALUES ('case_id', ?)").run(caseId);
        } else if (row.value !== caseId) {
          throw new LedgerCaseMismatchError(`ledger belongs to case ${row.value}, not ${caseId}`);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    } catch (err) {
      db.close();
      throw err;
    }
    return new Ledger(db, caseId, opts.now ?? (() => new Date().toISOString()), opts.onError ?? logToStderr("ledger subscriber failed"));
  }

  append(input: EntryInput): Entry {
    return this.appendMany([input])[0]!;
  }

  appendMany(inputs: EntryInput[]): Entry[] {
    // Canonicalise everything first so a bad payload throws before anything is written.
    const prepared: Prepared[] = inputs.map((input) => {
      if (input.cause != null && !(Number.isInteger(input.cause) && input.cause >= 1)) {
        throw new TypeError("cause must be an integer >= 1 or null");
      }
      for (const field of ["run", "stage", "job"] as const) {
        const v = input[field];
        if (v != null && typeof v !== "string") throw new TypeError(`${field} must be a string or null`);
      }
      const payloadText = canonical(input.payload as unknown as Json);
      if (Buffer.byteLength(payloadText, "utf8") > MAX_PAYLOAD_BYTES) {
        throw new PayloadTooLargeError(`payload of ${input.type} exceeds ${MAX_PAYLOAD_BYTES} bytes`);
      }
      return { input, payloadText, actorText: canonical(input.actor as unknown as Json) };
    });
    if (prepared.length === 0) return [];

    const insert = this.db.query(
      "INSERT INTO entries (seq, ts, actor, type, payload, cause, run, stage, job, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const entries: Entry[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let { seq, hash: prev } = this.head();
      for (const p of prepared) {
        seq += 1;
        const { input } = p;
        const ts = this.now();
        if (typeof ts !== "string") throw new TypeError("clock must return a string");
        const body = {
          seq,
          ts,
          case: this.caseId,
          actor: JSON.parse(p.actorText) as Actor,
          type: input.type,
          payload: JSON.parse(p.payloadText),
          cause: input.cause ?? null,
          run: input.run ?? null,
          stage: input.stage ?? null,
          job: input.job ?? null,
          prev_hash: prev,
        };
        const hash = entryHash(body as unknown as Omit<Entry, "hash">);
        insert.run(seq, body.ts, p.actorText, body.type, p.payloadText, body.cause, body.run, body.stage, body.job, prev, hash);
        entries.push({ ...body, hash } as unknown as Entry);
        prev = hash;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.delivery.send(entries);
    return entries;
  }

  read(after = 0, limit = -1): Entry[] {
    const rows = this.db.query("SELECT * FROM entries WHERE seq > ? ORDER BY seq ASC LIMIT ?").all(after, limit) as Row[];
    return rows.map(toEntry(this.caseId));
  }

  get(seq: number): Entry | null {
    const row = this.db.query("SELECT * FROM entries WHERE seq = ?").get(seq) as Row | null;
    return row === null ? null : toEntry(this.caseId)(row);
  }

  head(): { seq: number; hash: string } {
    const row = this.db.query("SELECT seq, hash FROM entries ORDER BY seq DESC LIMIT 1").get() as { seq: number; hash: string } | null;
    return row === null ? { seq: 0, hash: GENESIS } : { seq: row.seq, hash: row.hash };
  }

  subscribe(fn: (entry: Entry) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  close(): void {
    this.db.close();
  }
}

function toEntry(caseId: string): (row: Row) => Entry {
  return (row) =>
    ({
      seq: row.seq,
      ts: row.ts,
      case: caseId,
      actor: JSON.parse(row.actor),
      type: row.type,
      payload: JSON.parse(row.payload),
      cause: row.cause,
      run: row.run,
      stage: row.stage,
      job: row.job,
      prev_hash: row.prev_hash,
      hash: row.hash,
    }) as unknown as Entry;
}
