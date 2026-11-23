import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { BlobStore, collectBlobRefs, isBlobRef } from "./blobs";
import type { Json } from "./canonical";
import { GENESIS } from "./hash";
import { checkRow } from "./ledger";
import type { LedgerRow, RowFault } from "./ledger";
import { BLOB_FIELDS } from "./types";

export interface VerifyReport {
  ok: boolean;
  case: string;
  entries: number;
  head: string;
  firstBad: null | { seq: number; reason: RowFault };
  blobs: {
    /** Distinct blobs referenced at the positions BLOB_FIELDS defines. */
    referenced: number;
    /** Each missing or corrupt blob, with the first entry that references it. */
    bad: { blob: string; state: "missing" | "corrupt"; seq: number }[];
    /** Values shaped like a blob reference anywhere else (source rows, tool arguments...). Counted, never checked, never a failure. */
    lookalikes: number;
  };
}

/** The payload fields of an entry type that hold blob references. */
function blobFieldsOf(type: string): readonly string[] {
  return Object.hasOwn(BLOB_FIELDS, type) ? BLOB_FIELDS[type as keyof typeof BLOB_FIELDS] : [];
}

/** The blob references at the defined positions of a payload, and how many look-alikes sit anywhere else in it. */
function scanPayload(type: string, payload: Json): { refs: string[]; lookalikes: number } {
  const fields = blobFieldsOf(type);
  const refs: string[] = [];
  let lookalikes = 0;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { refs, lookalikes: collectBlobRefs(payload).length };
  for (const [key, value] of Object.entries(payload)) {
    if (fields.includes(key) && (value === null || isBlobRef(value))) {
      if (value !== null) refs.push(value.blob);
    } else {
      lookalikes += collectBlobRefs(value).length;
    }
  }
  return { refs, lookalikes };
}

/** The ledger file cannot be read as a ledger at all (not SQLite, tables missing, no case id). */
export class UnreadableLedgerError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UnreadableLedgerError";
  }
}

function parse(text: string): { value: Json } | null {
  try {
    return { value: JSON.parse(text) as Json };
  } catch {
    return null;
  }
}

/** Checks a ledger file and its blobs without going through `Ledger`, so it can inspect a file `Ledger` would refuse. */
export function verifyLedger(ledgerPath: string, blobDir: string): VerifyReport {
  let db: Database;
  try {
    db = new Database(ledgerPath, { readonly: true });
  } catch (err) {
    throw new UnreadableLedgerError(reasonOf(err));
  }
  try {
    let caseId: string;
    let rows: LedgerRow[];
    try {
      const meta = db.query("SELECT value FROM meta WHERE key = 'case_id'").get() as { value: string } | null;
      if (meta === null) throw new UnreadableLedgerError("no case id in the ledger");
      caseId = meta.value;
      rows = db.query("SELECT * FROM entries ORDER BY seq ASC").all() as LedgerRow[];
    } catch (err) {
      if (err instanceof UnreadableLedgerError) throw err;
      throw new UnreadableLedgerError(reasonOf(err));
    }

    let firstBad: VerifyReport["firstBad"] = null;
    const fail = (seq: number, reason: NonNullable<VerifyReport["firstBad"]>["reason"]): void => {
      firstBad ??= { seq, reason };
    };

    let prevSeq = 0;
    let prevHash = GENESIS;
    /** Each referenced blob and the first entry that references it, in order of first reference. */
    const firstRef = new Map<string, number>();
    let lookalikes = 0;
    for (const row of rows) {
      const payload = parse(row.payload);
      if (payload !== null) {
        const scan = scanPayload(row.type, payload.value);
        for (const blob of scan.refs) if (!firstRef.has(blob)) firstRef.set(blob, row.seq);
        lookalikes += scan.lookalikes;
      }
      if (firstBad === null) {
        // The same row check the ledger runs before it commits.
        const fault = checkRow(row, caseId, prevSeq, prevHash);
        if (fault !== null) fail(row.seq, fault);
      }
      prevSeq = row.seq;
      prevHash = row.hash;
    }

    // Do not create the directory: verification must not touch the case.
    const blobDirKind = !existsSync(blobDir) ? "absent" : statSync(blobDir).isDirectory() ? "dir" : "not_a_dir";
    const store = blobDirKind === "dir" ? new BlobStore(blobDir) : null;
    const bad: VerifyReport["blobs"]["bad"] = [];
    for (const [blob, seq] of firstRef) {
      const state = store !== null ? store.check(blob) : blobDirKind === "absent" ? "missing" : "corrupt";
      if (state !== "ok") bad.push({ blob, state, seq });
    }

    return {
      ok: firstBad === null && bad.length === 0,
      case: caseId,
      entries: rows.length,
      head: rows.length === 0 ? GENESIS : rows[rows.length - 1]!.hash,
      firstBad,
      blobs: { referenced: firstRef.size, bad, lookalikes },
    };
  } finally {
    db.close();
  }
}

function reasonOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
}

export function verifyCase(caseDir: string): VerifyReport {
  return verifyLedger(join(caseDir, "ledger.sqlite"), join(caseDir, "blobs"));
}

export function hasLedger(caseDir: string): boolean {
  return existsSync(join(caseDir, "ledger.sqlite"));
}

const TRUNCATION_NOTE = "compare the head with one recorded elsewhere: removing the newest entries cannot be detected from this file alone";

/**
 * The command's output. The first line is the verdict: BROKEN whenever the report is not ok. The head
 * is printed in full, since comparing it with one recorded elsewhere is the only way to notice the
 * newest entries were removed. Each bad blob gets a line naming its hash and the entry that references it.
 */
export function formatReport(r: VerifyReport): string {
  const missing = r.blobs.bad.filter((b) => b.state === "missing").length;
  const corrupt = r.blobs.bad.length - missing;
  const intact = `chain intact · ${r.entries} entries · head ${r.head}`;
  const first = r.firstBad
    ? `case ${r.case}: BROKEN at entry ${r.firstBad.seq} (${r.firstBad.reason})`
    : r.blobs.bad.length > 0
      ? `case ${r.case}: BROKEN · ${r.blobs.bad.length} blob${r.blobs.bad.length === 1 ? "" : "s"} missing or corrupt · ${intact}`
      : `case ${r.case}: ${intact}`;
  let blobLine = `blobs: ${r.blobs.referenced} referenced · ${missing} missing · ${corrupt} corrupt`;
  if (r.blobs.lookalikes > 0) blobLine += ` · ${r.blobs.lookalikes} look-alike${r.blobs.lookalikes === 1 ? "" : "s"} outside reference fields, not checked`;
  const lines = [first, blobLine, ...r.blobs.bad.map((b) => `  ${b.state} blob ${b.blob}, referenced by entry ${b.seq}`)];
  if (r.firstBad === null) lines.push(TRUNCATION_NOTE);
  return lines.join("\n");
}
