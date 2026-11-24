import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BlobStore, collectBlobRefs, isBlobRef } from "./blobs";
import { canonical, parseJson } from "./canonical";
import type { Json } from "./canonical";
import { GENESIS, sha256Hex } from "./hash";
import { checkRow } from "./ledger";
import { isObj } from "./state/guards";
import type { LedgerRow, RowFault } from "./ledger";
import { BLOB_FIELDS, blobFieldNullable } from "./types";
import type { PublishedReport } from "./wire";

export interface VerifyReport {
  ok: boolean;
  case: string;
  entries: number;
  head: string;
  firstBad: null | { seq: number; reason: RowFault };
  blobs: {
    /** Distinct blobs referenced at the positions BLOB_FIELDS defines. */
    referenced: number;
    /** Each missing or corrupt blob, with the first entry that references it, and each malformed reference (its value as compact JSON, cut to 80 characters, or `<field>: absent` for a required position that is missing) with its entry. In entry order. */
    bad: { blob: string; state: "missing" | "corrupt" | "malformed"; seq: number }[];
    /** Values shaped like a blob reference anywhere else (source rows, tool arguments...). Counted, never checked, never a failure. */
    lookalikes: number;
  };
  /** Present when the report was made for a case folder (`verifyCase`). */
  published?: PublishedReport;
}

export type { PublishedReport };

/** The payload fields of an entry type that hold blob references. */
function blobFieldsOf(type: string): readonly string[] {
  return Object.hasOwn(BLOB_FIELDS, type) ? BLOB_FIELDS[type as keyof typeof BLOB_FIELDS] : [];
}

/** The blob references at the defined positions of a payload, and how many look-alikes sit anywhere else in it. */
function scanPayload(type: string, payload: Json): { refs: string[]; malformed: string[]; lookalikes: number } {
  const fields = blobFieldsOf(type);
  const refs: string[] = [];
  const malformed: string[] = [];
  let lookalikes = 0;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { refs, malformed, lookalikes: collectBlobRefs(payload).length };
  // A position that may not hold null and is missing is a result with nothing behind it.
  for (const field of fields) if (!Object.hasOwn(payload, field) && !blobFieldNullable(type, field)) malformed.push(`${field}: absent`);
  for (const [key, value] of Object.entries(payload)) {
    if (fields.includes(key)) {
      if (value === null && blobFieldNullable(type, key)) continue;
      if (isBlobRef(value)) refs.push(value.blob);
      else malformed.push(JSON.stringify(value).slice(0, 80));
    } else {
      lookalikes += collectBlobRefs(value).length;
    }
  }
  return { refs, malformed, lookalikes };
}

/** The ledger file cannot be read as a ledger at all (not SQLite, tables missing, no case id). */
export class UnreadableLedgerError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "UnreadableLedgerError";
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
    let rows: Iterable<LedgerRow>;
    try {
      // Wait for a writer holding the file instead of reporting it unreadable (SQLite's default wait is zero).
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const meta = db.query("SELECT value FROM meta WHERE key = 'case_id'").get() as { value: string } | null;
      if (meta === null) throw new UnreadableLedgerError("no case id in the ledger");
      caseId = meta.value;
      // One row at a time, so a long chain is never held in memory at once.
      rows = db.query("SELECT * FROM entries ORDER BY seq ASC").iterate() as Iterable<LedgerRow>;
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
    const malformed: VerifyReport["blobs"]["bad"] = [];
    let lookalikes = 0;
    let entries = 0;
    for (const row of readRows(rows)) {
      entries += 1;
      const payload = parseJson(row.payload);
      if (payload !== null) {
        const scan = scanPayload(row.type, payload.value);
        for (const blob of scan.refs) if (!firstRef.has(blob)) firstRef.set(blob, row.seq);
        for (const blob of scan.malformed) malformed.push({ blob, state: "malformed", seq: row.seq });
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
    bad.push(...malformed);
    bad.sort((a, b) => a.seq - b.seq);

    return {
      ok: firstBad === null && bad.length === 0,
      case: caseId,
      entries,
      head: entries === 0 ? GENESIS : prevHash,
      firstBad,
      blobs: { referenced: firstRef.size, bad, lookalikes },
    };
  } finally {
    db.close();
  }
}

const BUSY_TIMEOUT_MS = 10000;

/** Rows from SQLite; a failure while reading them means the file cannot be read as a ledger. */
function* readRows(rows: Iterable<LedgerRow>): Generator<LedgerRow> {
  const it = rows[Symbol.iterator]();
  for (;;) {
    let next: IteratorResult<LedgerRow>;
    try {
      next = it.next();
    } catch (err) {
      throw new UnreadableLedgerError(reasonOf(err));
    }
    if (next.done) return;
    yield next.value;
  }
}

function reasonOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
}

export function verifyCase(caseDir: string): VerifyReport & { published: PublishedReport } {
  const report = verifyLedger(join(caseDir, "ledger.sqlite"), join(caseDir, "blobs"));
  const published = verifyPublished(caseDir);
  return { ...report, ok: report.ok && published.ok, published };
}

/** The manifest a bundle carries; declared here because src/core/ does not import src/pipeline/. */
interface BundleManifestShape { head: { seq: number; hash: string }; files: { name: string; sha256: string }[] }

const isHead = (x: unknown): x is { seq: number; hash: string } => isObj(x) && typeof x.seq === "number" && typeof x.hash === "string";

/** Why a head is not an entry of the ledger; null when it is, and its hash is the one the entry has. */
function headProblem(head: unknown, hashes: ReadonlyMap<number, string>): string | null {
  if (!isHead(head)) return "the manifest names no head";
  const actual = hashes.get(head.seq);
  if (actual === undefined) return `the head the manifest names, entry ${head.seq}, is not an entry of this ledger`;
  if (actual !== head.hash) return `the head hash the manifest names is not the hash of entry ${head.seq}`;
  return null;
}

/**
 * Compares each `published/<n>/` folder with the bundle blob the ledger's product.published entry names. A bundle is ok when the folder holds
 * exactly manifest.json and the files its manifest lists, each file hashes to the manifest's sha256, manifest.json is the blob's manifest,
 * product.json hashes to the entry's draft_hash, and the head the manifest names is an entry of this ledger with the hash the manifest and
 * the entry give. Reads only; a folder no entry records is listed, so a stray or half-made one is seen.
 */
export function verifyPublished(caseDir: string): PublishedReport {
  const db = new Database(join(caseDir, "ledger.sqlite"), { readonly: true });
  const hashes = new Map<number, string>();
  const recorded: { seq: number; n: number; draft_hash: string; head_hash: string; blob: string }[] = [];
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    for (const row of db.query("SELECT seq, type, hash, payload FROM entries ORDER BY seq ASC").iterate() as Iterable<{ seq: number; type: string; hash: string; payload: string }>) {
      hashes.set(row.seq, row.hash);
      if (row.type !== "product.published") continue;
      const p = parseJson(row.payload)?.value;
      if (!isObj(p) || typeof p.n !== "number" || typeof p.draft_hash !== "string" || typeof p.head_hash !== "string" || !isObj(p.bundle) || typeof p.bundle.blob !== "string") continue;
      recorded.push({ seq: row.seq, n: p.n, draft_hash: p.draft_hash, head_hash: p.head_hash, blob: p.bundle.blob });
    }
  } finally {
    db.close();
  }
  const store = new BlobStore(join(caseDir, "blobs"));
  const root = join(caseDir, "published");
  const bundles: PublishedReport["bundles"] = recorded.map((r) => {
    const out = (state: PublishedReport["bundles"][number]["state"], detail: string): PublishedReport["bundles"][number] => ({ n: r.n, seq: r.seq, state, detail });
    // the bundle blob: canonical { manifest, files }
    let manifest: BundleManifestShape;
    let manifestBytes: string;
    try {
      const body = parseJson(new TextDecoder().decode(store.get(r.blob)))?.value;
      if (!isObj(body) || !isObj(body.manifest) || !Array.isArray(body.manifest.files)) return out("bad_blob", "the bundle blob is not a bundle");
      if (!body.manifest.files.every((f) => isObj(f) && typeof f.name === "string" && typeof f.sha256 === "string")) return out("bad_blob", "the bundle's manifest lists a file that is not a name and a hash");
      manifest = body.manifest as unknown as BundleManifestShape;
      manifestBytes = canonical(body.manifest as Json);
    } catch (err) {
      return out("bad_blob", `the bundle blob is ${err instanceof Error && err.name === "BlobMissingError" ? "missing" : "corrupt or unreadable"}`);
    }
    const folder = join(root, String(r.n));
    let names: string[];
    try {
      if (!statSync(folder).isDirectory()) return out("missing", `published/${r.n} is not a folder`);
      names = readdirSync(folder);
    } catch {
      return out("missing", `there is no folder published/${r.n}; the bundle is still in the ledger's blob`);
    }
    const head = headProblem(manifest.head, hashes) ?? (isHead(manifest.head) && manifest.head.hash !== r.head_hash ? "the head hash the manifest names is not the one the entry records" : null);
    if (head !== null) return out("bad_head", head);
    let onDisk: string | null = null;
    try { onDisk = readFileSync(join(folder, "manifest.json"), "utf8"); } catch { /* reported below */ }
    if (onDisk === null) return out("differs", "manifest.json is missing");
    const shown = parseJson(onDisk)?.value;
    if (isObj(shown) && isObj(shown.head)) {
      const shownHead = headProblem(shown.head, hashes) ?? (isHead(shown.head) && shown.head.hash !== r.head_hash ? "the head hash the folder's manifest names is not the one the entry records" : null);
      if (shownHead !== null) return out("bad_head", `manifest.json: ${shownHead}`);
    }
    if (onDisk !== manifestBytes) return out("differs", "manifest.json is not the bundle's manifest");
    const listed = manifest.files.map((f) => f.name);
    for (const name of names) if (name !== "manifest.json" && !listed.includes(name)) return out("differs", `${name} is not a file of the bundle`);
    for (const f of manifest.files) {
      if (typeof f.name !== "string" || f.name !== f.name.split(/[\\/]/).pop() || f.name === "") return out("differs", "the manifest lists a file name that is not a plain name");
      if (!names.includes(f.name)) return out("differs", `${f.name} is missing`);
      let bytes: Buffer;
      try { bytes = readFileSync(join(folder, f.name)); } catch { return out("differs", `${f.name} cannot be read`); }
      if (sha256Hex(bytes) !== f.sha256) return out("differs", `${f.name} is not what the manifest lists`);
    }
    if (!listed.includes("product.json")) return out("differs", "the bundle has no product.json");
    if (sha256Hex(readFileSync(join(folder, "product.json"))) !== r.draft_hash) return out("differs", "product.json is not the draft the entry names");
    return out("ok", "");
  });
  let unrecorded: string[] = [];
  try {
    const known = new Set(recorded.map((r) => String(r.n)));
    unrecorded = readdirSync(root).filter((name) => !known.has(name)).sort();
  } catch { /* nothing was published */ }
  return { ok: bundles.every((b) => b.state === "ok") && unrecorded.length === 0, bundles, unrecorded };
}

export function hasLedger(caseDir: string): boolean {
  return existsSync(join(caseDir, "ledger.sqlite"));
}

/** One line per published bundle that is not ok, and one per folder no entry records. */
export function publishedLines(p: PublishedReport): string[] {
  return [
    ...p.bundles.filter((b) => b.state !== "ok").map((b) => `published/${b.n}: ${b.state} (entry ${b.seq}): ${b.detail}`),
    ...p.unrecorded.map((name) => `published/${name}: no entry records this folder`),
  ];
}

const TRUNCATION_NOTE = "compare the head with one recorded elsewhere: removing the newest entries cannot be detected from this file alone";

/**
 * The command's output. The first line is the verdict: BROKEN whenever the report is not ok. The head
 * is printed in full, since comparing it with one recorded elsewhere is the only way to notice the
 * newest entries were removed. Each bad blob gets a line naming its hash and the entry that references it.
 */
export function formatReport(r: VerifyReport): string {
  const missing = r.blobs.bad.filter((b) => b.state === "missing").length;
  const corrupt = r.blobs.bad.filter((b) => b.state === "corrupt").length;
  const malformed = r.blobs.bad.length - missing - corrupt;
  const intact = `chain intact · ${r.entries} entries · head ${r.head}`;
  const first = r.firstBad
    ? `case ${r.case}: BROKEN at entry ${r.firstBad.seq} (${r.firstBad.reason})`
    : r.published !== undefined && !r.published.ok && r.blobs.bad.length === 0
      ? `case ${r.case}: BROKEN · ${r.published.bundles.filter((b) => b.state !== "ok").length + r.published.unrecorded.length} published item${r.published.bundles.filter((b) => b.state !== "ok").length + r.published.unrecorded.length === 1 ? "" : "s"} not as recorded · ${intact}`
    : r.blobs.bad.length > 0
      ? `case ${r.case}: BROKEN · ${r.blobs.bad.length} blob${r.blobs.bad.length === 1 ? "" : "s"} ${malformed > 0 ? "missing, corrupt or malformed" : "missing or corrupt"} · ${intact}`
      : `case ${r.case}: ${intact}`;
  let blobLine = `blobs: ${r.blobs.referenced} referenced · ${missing} missing · ${corrupt} corrupt`;
  if (malformed > 0) blobLine += ` · ${malformed} malformed reference${malformed === 1 ? "" : "s"}`;
  if (r.blobs.lookalikes > 0) blobLine += ` · ${r.blobs.lookalikes} look-alike${r.blobs.lookalikes === 1 ? "" : "s"} outside reference fields, not checked`;
  const lines = [first, blobLine, ...r.blobs.bad.map((b) => `  ${b.state} blob ${b.blob}, referenced by entry ${b.seq}`)];
  if (r.published !== undefined) lines.push(...publishedLines(r.published));
  if (r.firstBad === null) lines.push(TRUNCATION_NOTE);
  return lines.join("\n");
}
