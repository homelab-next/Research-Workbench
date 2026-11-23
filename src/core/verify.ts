import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { BlobStore, collectBlobRefs } from "./blobs";
import type { Json } from "./canonical";
import { GENESIS } from "./hash";
import { checkRow } from "./ledger";
import type { LedgerRow, RowFault } from "./ledger";

export interface VerifyReport {
  ok: boolean;
  case: string;
  entries: number;
  head: string;
  firstBad: null | { seq: number; reason: RowFault };
  blobs: { referenced: number; missing: string[]; corrupt: string[] };
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
    const refs = new Map<string, true>();
    for (const row of rows) {
      const payload = parse(row.payload);
      if (payload !== null) for (const r of collectBlobRefs(payload.value)) refs.set(r.blob, true);
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
    const missing: string[] = [];
    const corrupt: string[] = [];
    for (const hash of refs.keys()) {
      const state = store !== null ? store.check(hash) : blobDirKind === "absent" ? "missing" : "corrupt";
      if (state === "missing") missing.push(hash);
      else if (state === "corrupt") corrupt.push(hash);
    }

    return {
      ok: firstBad === null && missing.length === 0 && corrupt.length === 0,
      case: caseId,
      entries: rows.length,
      head: rows.length === 0 ? GENESIS : rows[rows.length - 1]!.hash,
      firstBad,
      blobs: { referenced: refs.size, missing, corrupt },
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

export function formatReport(r: VerifyReport): string {
  const first = r.firstBad
    ? `case ${r.case}: BROKEN at entry ${r.firstBad.seq} (${r.firstBad.reason})`
    : `case ${r.case}: chain intact · ${r.entries} entries · head ${r.head.slice(0, 8)}…`;
  const lines = [first, `blobs: ${r.blobs.referenced} referenced · ${r.blobs.missing.length} missing · ${r.blobs.corrupt.length} corrupt`];
  if (r.firstBad === null) lines.push(TRUNCATION_NOTE);
  return lines.join("\n");
}
