import { Database } from "bun:sqlite";
import { isBlobRef } from "./blobs";
import { canonical, isPlainObject, parseJson } from "./canonical";
import type { Json } from "./canonical";
import { Delivery, ignoreThrow, logToStderr } from "./deliver";
import { GENESIS, sha256Hex } from "./hash";
import { BLOB_FIELDS, blobFieldNullable, isActor, isEntryType } from "./types";
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

/** An entry the ledger will not commit: not a valid entry, or one the verifier would reject. Nothing is written. */
export class InvalidEntryError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEntryError";
  }
}

/** A stored row whose actor or payload is not JSON. Reported through onError; the row reads back with a null payload. */
export class UnreadableEntryError extends Error {
  readonly seq: number;
  constructor(seq: number, column: "actor" | "payload") {
    super(`entry ${seq} cannot be read: its ${column} is not JSON`);
    this.name = "UnreadableEntryError";
    this.seq = seq;
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

/** One stored row of the entries table, as SQLite returns it. */
export interface LedgerRow {
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

/** Why a stored row fails verification. */
export type RowFault = "seq_gap" | "prev_hash_mismatch" | "bad_json" | "hash_mismatch" | "draft_hash_mismatch";

/** True when `draft` carries a product and its `hash` is sha256Hex(canonical(product)), the rule types.ts states for Draft. */
export function draftHashMatches(draft: unknown): boolean {
  if (typeof draft !== "object" || draft === null || !("product" in draft) || !("hash" in draft) || typeof draft.hash !== "string") return false;
  try {
    return sha256Hex(canonical(draft.product as Json)) === draft.hash;
  } catch {
    return false;
  }
}

/**
 * The verifier's check of one stored row, given the case id and the row before it. Shared by the
 * verifier and by the ledger's read-back before COMMIT, so the ledger cannot commit a row the
 * verifier would reject. Returns null when the row is sound.
 */
export function checkRow(row: LedgerRow, caseId: string, prevSeq: number, prevHash: string): RowFault | null {
  if (row.seq !== prevSeq + 1) return "seq_gap";
  if (row.prev_hash !== prevHash) return "prev_hash_mismatch";
  const actor = parseJson(row.actor);
  const payload = parseJson(row.payload);
  if (actor === null || payload === null) return "bad_json";
  try {
    // The ledger stores canonical text, so any other spelling of the same value is an edit.
    if (row.actor !== canonical(actor.value) || row.payload !== canonical(payload.value)) return "hash_mismatch";
    const recomputed = entryHash({
      seq: row.seq, ts: row.ts, case: caseId, actor: actor.value, type: row.type, payload: payload.value,
      cause: row.cause, run: row.run, stage: row.stage, job: row.job, prev_hash: row.prev_hash,
    } as unknown as Omit<Entry, "hash">);
    if (recomputed !== row.hash) return "hash_mismatch";
  } catch {
    // A value the canonical form rejects cannot have been written by the ledger.
    return "hash_mismatch";
  }
  // A draft's hash names its product; one that does not would let unreviewed text pass as reviewed.
  if (row.type === "draft.revised") {
    const p = payload.value;
    const draft = typeof p === "object" && p !== null && !Array.isArray(p) ? p.draft : undefined;
    if (!draftHashMatches(draft)) return "draft_hash_mismatch";
  }
  return null;
}

const isWellFormed = (s: string): boolean => s.isWellFormed();

/** Freezes an entry and everything in it. Entries are shared by the ledger, state and every subscriber, so none may change one. */
function deepFreeze<T>(x: T): T {
  if (typeof x === "object" && x !== null && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

/** Checks everything about an input that does not depend on where it lands in the chain. */
function checkInput(input: EntryInput): void {
  if (typeof input !== "object" || input === null) throw new InvalidEntryError("an entry must be an object");
  if (!isEntryType(input.type)) throw new InvalidEntryError(`type must be a known entry type, not ${JSON.stringify(String(input.type))}`);
  if (!isActor(input.actor)) throw new InvalidEntryError(`actor of ${input.type} must be a well-formed human, system or agent actor`);
  if (!isPlainObject(input.payload)) throw new InvalidEntryError(`payload of ${input.type} must be a plain object`);
  // A typed blob position holds null or a well-formed reference, or the bytes behind it could not be traced.
  if (Object.hasOwn(BLOB_FIELDS, input.type)) {
    for (const field of BLOB_FIELDS[input.type as keyof typeof BLOB_FIELDS] as readonly string[]) {
      const nullable = blobFieldNullable(input.type, field);
      if (!Object.hasOwn(input.payload, field)) {
        if (nullable) continue;
        throw new InvalidEntryError(`${input.type}: ${field} is required and must be a blob reference ({ blob: <sha256 hex>, bytes })`);
      }
      const v = (input.payload as unknown as Record<string, unknown>)[field];
      if (v === null && nullable) continue;
      if (!isBlobRef(v)) throw new InvalidEntryError(`${input.type}: ${field} must be ${nullable ? "null or " : ""}a blob reference ({ blob: <sha256 hex>, bytes })`);
    }
  }
  if (input.cause != null && !(Number.isSafeInteger(input.cause) && input.cause >= 1)) {
    throw new InvalidEntryError("cause must be a safe integer >= 1 naming an earlier entry, or null");
  }
  for (const field of ["run", "stage", "job"] as const) {
    const v = input[field];
    if (v != null && typeof v !== "string") throw new InvalidEntryError(`${field} must be a string or null`);
    if (typeof v === "string" && !isWellFormed(v)) throw new InvalidEntryError(`${field} must be a well-formed string`);
  }
}

/** An append-only, hash-chained ledger in one SQLite file. Every entry it returns or delivers is deep-frozen. */
export class Ledger {
  readonly caseId: string;
  private readonly db: Database;
  private readonly now: () => string;
  private readonly subscribers = new Set<(entry: Entry) => void>();
  private readonly delivery: Delivery<(entry: Entry) => void, Entry>;
  private readonly onError: (error: unknown, entry: Entry) => void;
  /** The seqs of damaged rows already reported, so a row is reported once however often it is read. */
  private readonly reported = new Set<number>();

  private constructor(db: Database, caseId: string, now: () => string, onError: (error: unknown, entry: Entry) => void) {
    this.db = db;
    this.caseId = caseId;
    this.now = now;
    // The entry is already committed when subscribers hear of it; a failing subscriber must not fail the append or starve others.
    this.delivery = new Delivery(this.subscribers, (fn, entry) => fn(entry), onError);
    this.onError = onError;
  }

  static open(path: string, caseId: string, opts: { now?: () => string; onError?: (error: unknown, entry: Entry) => void } = {}): Ledger {
    if (typeof caseId !== "string" || !isWellFormed(caseId)) throw new InvalidEntryError("the case id must be a well-formed string");
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
        if (db.inTransaction) db.exec("ROLLBACK");
        throw err;
      }
    } catch (err) {
      db.close();
      throw err;
    }
    return new Ledger(db, caseId, opts.now ?? (() => new Date().toISOString()), opts.onError ?? logToStderr("ledger"));
  }

  append(input: EntryInput): Entry {
    return this.appendMany([input])[0]!;
  }

  /**
   * Appends `inputs` as one transaction: all of them or none. Each must be a valid entry (a known type,
   * a well-formed actor, a plain-object payload, a cause naming an earlier entry, well-formed strings),
   * and before COMMIT every inserted row is read back and must pass the verifier's row check.
   * Anything else throws InvalidEntryError (or CanonicalError, PayloadTooLargeError) and writes nothing.
   */
  appendMany(inputs: EntryInput[]): Entry[] {
    // Check and canonicalise everything first so a bad input throws before anything is written.
    const prepared: Prepared[] = inputs.map((input) => {
      checkInput(input);
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
      const start = this.head();
      let { seq, hash: prev } = start;
      for (const p of prepared) {
        seq += 1;
        const { input } = p;
        const cause = input.cause ?? null;
        if (cause !== null && cause >= seq) throw new InvalidEntryError(`cause ${cause} of entry ${seq} does not name an earlier entry`);
        const ts = this.now();
        if (typeof ts !== "string" || !isWellFormed(ts)) throw new InvalidEntryError("clock must return a well-formed string");
        const body = {
          seq,
          ts,
          case: this.caseId,
          actor: JSON.parse(p.actorText) as Actor,
          type: input.type,
          payload: JSON.parse(p.payloadText),
          cause,
          run: input.run ?? null,
          stage: input.stage ?? null,
          job: input.job ?? null,
          prev_hash: prev,
        };
        const hash = entryHash(body as unknown as Omit<Entry, "hash">);
        insert.run(seq, body.ts, p.actorText, body.type, p.payloadText, body.cause, body.run, body.stage, body.job, prev, hash);
        entries.push(deepFreeze({ ...body, hash }) as unknown as Entry);
        prev = hash;
      }
      this.readBack(start, entries);
      this.db.exec("COMMIT");
    } catch (err) {
      // SQLite may already have rolled back (a COMMIT that fails on a full disk does); a ROLLBACK then
      // would throw "no transaction is active" and hide the real error.
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
    this.delivery.send(entries);
    return entries;
  }

  /** Inside the transaction: the rows just inserted must be exactly these entries and pass the verifier's row check. */
  private readBack(start: { seq: number; hash: string }, entries: Entry[]): void {
    const rows = this.db.query("SELECT * FROM entries WHERE seq > ? ORDER BY seq ASC").all(start.seq) as LedgerRow[];
    let prevSeq = start.seq;
    let prevHash = start.hash;
    for (const [i, row] of rows.entries()) {
      const fault = checkRow(row, this.caseId, prevSeq, prevHash) ?? (row.hash === entries[i]?.hash ? null : "hash_mismatch");
      if (fault !== null) throw new InvalidEntryError(`entry ${row.seq} would not verify (${fault})`);
      prevSeq = row.seq;
      prevHash = row.hash;
    }
    if (rows.length !== entries.length) throw new InvalidEntryError(`expected ${entries.length} new rows, read back ${rows.length}`);
  }

  read(after = 0, limit = -1): Entry[] {
    const rows = this.db.query("SELECT * FROM entries WHERE seq > ? ORDER BY seq ASC LIMIT ?").all(after, limit) as LedgerRow[];
    return rows.map((row) => this.toEntry(row));
  }

  get(seq: number): Entry | null {
    const row = this.db.query("SELECT * FROM entries WHERE seq = ?").get(seq) as LedgerRow | null;
    return row === null ? null : this.toEntry(row);
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

  /**
   * A stored row as an entry. A row whose actor or payload is not JSON comes back with a null payload
   * (and a null actor if that is the unreadable part), so the fold skips and records it and a damaged
   * case can still be opened; the damage is reported through onError.
   */
  private toEntry(row: LedgerRow): Entry {
    const actor = parseJson(row.actor);
    const payload = parseJson(row.payload);
    const entry = {
      seq: row.seq,
      ts: row.ts,
      case: this.caseId,
      actor: actor === null ? null : actor.value,
      type: row.type,
      payload: actor === null || payload === null ? null : payload.value,
      cause: row.cause,
      run: row.run,
      stage: row.stage,
      job: row.job,
      prev_hash: row.prev_hash,
      hash: row.hash,
    } as unknown as Entry;
    deepFreeze(entry);
    if ((actor === null || payload === null) && !this.reported.has(row.seq)) {
      this.reported.add(row.seq);
      const error = new UnreadableEntryError(row.seq, actor === null ? "actor" : "payload");
      ignoreThrow(() => this.onError(error, entry));
    }
    return entry;
  }
}
