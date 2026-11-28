import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { BlobStore, collectBlobRefs, isBlobRef } from "./blobs";
import { canonical, parseJson } from "./canonical";
import type { Json } from "./canonical";
import { GENESIS, sha256Hex } from "./hash";
import { checkRow } from "./ledger";
import { foldLessons, lessonHash } from "./lessons";
import type { LessonDraft } from "./lessons";
import { MEMORY_CHAIN } from "./memstore";
import { rescore } from "./score";
import { apply, fold, initial, probeOutputOf } from "./state";
import { isObj } from "./state/guards";
import { readAnswers, readProbeOutput, readScoreSheet } from "./state/improve";
import type { ProbeOutput } from "./state/improve";
import type { LedgerRow, RowFault } from "./ledger";
import type { CaseState } from "./state";
import { BLOB_FIELDS, blobFieldNullable } from "./types";
import type { Actor, Entry, EntryType } from "./types";
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

export interface LinkReport { ok: boolean; links: { key: string; child: string; status: "matches" | "not_loaded" | "head_differs" | "not_its_child" | "version_differs" }[] }

const CHILD_ID = /^CASE-[1-9][0-9]*$/;
/** Each row's seq, type, hash, run and parsed payload, in order, read-only. */
function rowsOf(ledgerPath: string): { case: string; rows: { seq: number; type: string; hash: string; run: string | null; payload: unknown }[] } {
  const db = new Database(ledgerPath, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const meta = db.query("SELECT value FROM meta WHERE key = 'case_id'").get() as { value: string } | null;
    const rows = (db.query("SELECT seq, type, hash, run, payload FROM entries ORDER BY seq ASC").all() as { seq: number; type: string; hash: string; run: string | null; payload: string }[])
      .map((r) => ({ seq: r.seq, type: r.type, hash: r.hash, run: r.run, payload: parseJson(r.payload)?.value ?? null }));
    return { case: meta?.value ?? "", rows };
  } finally {
    db.close();
  }
}

/**
 * For each subloop.finished of the case: the child's ledger holds an entry of that seq and hash, its subloop.child names this case, run, stage, attempt
 * and input hash, its first entry is the origin subloop.started recorded (when it recorded one), and the run it finished bound the loop version
 * subloop.started names (loop_hash). A child that is not in `casesDir` is not_loaded and does not fail the report. Reads only; it does not recompute
 * what came back.
 */
export function verifyLinks(caseDir: string, casesDir: string): LinkReport {
  const parent = rowsOf(join(caseDir, "ledger.sqlite"));
  const started = new Map<string, { child: string; input_hash: string; loop_hash: string | null; origin: string | null }>();
  const links: LinkReport["links"] = [];
  for (const r of parent.rows) {
    const p = r.payload;
    if ((r.type !== "subloop.started" && r.type !== "subloop.finished") || !isObj(p) || typeof p.stage !== "string" || typeof p.attempt !== "number" || typeof p.child !== "string") continue;
    const key = `${r.run ?? ""}/${p.stage}/${p.attempt}`;
    if (r.type === "subloop.started") {
      if (typeof p.input_hash === "string" && !started.has(key)) {
        started.set(key, { child: p.child, input_hash: p.input_hash, loop_hash: typeof p.loop_hash === "string" ? p.loop_hash : null, origin: typeof p.origin === "string" ? p.origin : null });
      }
      continue;
    }
    const out = (status: LinkReport["links"][number]["status"]): void => void links.push({ key, child: p.child as string, status });
    const opened = started.get(key);
    // a child id that is not a case id names no folder of casesDir, and a finish that names another child than the start is no link
    if (!CHILD_ID.test(p.child) || opened === undefined || opened.child !== p.child) { out("not_its_child"); continue; }
    const ledgerPath = join(casesDir, p.child, "ledger.sqlite");
    if (!existsSync(ledgerPath)) { out("not_loaded"); continue; }
    let child: ReturnType<typeof rowsOf>;
    try {
      child = rowsOf(ledgerPath);
    } catch {
      out("head_differs");
      continue;
    }
    const link = child.rows.find((x) => x.type === "subloop.child" && x.seq <= 3)?.payload;
    if (child.case !== p.child || !isObj(link) || link.parent !== parent.case || link.run !== r.run || link.stage !== p.stage || link.attempt !== p.attempt || link.input_hash !== opened.input_hash
      || (opened.origin !== null && child.rows[0]?.hash !== opened.origin)) {
      out("not_its_child");
      continue;
    }
    // the version the child's run bound: the loop.bound in the commit of that run's run.started
    const startedAt = child.rows.findIndex((x) => x.type === "run.started" && isObj(x.payload) && x.payload.run === p.child_run);
    const bound = startedAt > 0 && child.rows[startedAt - 1]!.type === "loop.bound" ? child.rows[startedAt - 1]!.payload : null;
    if (startedAt >= 0 && opened.loop_hash !== null && !(isObj(bound) && bound.hash === opened.loop_hash)) {
      out("version_differs");
      continue;
    }
    const head = isHead(p.head) ? p.head : null;
    const at = head === null ? undefined : child.rows.find((x) => x.seq === head.seq);
    out(at !== undefined && at.hash === head!.hash ? "matches" : "head_differs");
  }
  return { ok: links.every((l) => l.status === "matches" || l.status === "not_loaded"), links };
}

/** One line per link: `link <key>: <child> <status>`. */
export function linkLines(r: LinkReport): string[] {
  const said: Record<LinkReport["links"][number]["status"], string> = {
    matches: "matches", not_loaded: "not loaded here, not checked", head_differs: "BROKEN: its ledger does not hold the recorded head", not_its_child: "BROKEN: it does not name this case's stage as its parent",
    version_differs: "BROKEN: its run bound another version of its loop than this case recorded",
  };
  return r.links.map((l) => `link ${l.key}: ${l.child} ${said[l.status]}`);
}

// ---------- an improve case and its probe children (slice 14) ----------

export interface ProbeReport { ok: boolean; probes: { probe: string; child: string; status: "matches" | "not_loaded" | "head_differs" | "not_its_child" | "version_differs" | "output_differs" }[] }

/** The bytes of a blob of a case folder, read-only (a store that is not there is made by nothing here); null when it is missing or corrupt. */
function blobOf(caseDir: string, ref: unknown): Uint8Array | null {
  const dir = join(caseDir, "blobs");
  if (!isObj(ref) || typeof ref.blob !== "string" || !existsSync(dir)) return null;
  try {
    return new BlobStore(dir).get(ref.blob);
  } catch {
    return null;
  }
}

/**
 * For each probe.finished of an improve case: the version the probe ran under is the one the case recorded for it (the selected loop for `base`, the
 * staged candidate's otherwise); and, when the child is in `casesDir`, its ledger holds an entry of the recorded seq and hash, its probe.child and
 * subloop.child name this case, probe, candidate and task, its first entry is the origin probe.started recorded, the run it ran bound the loop version
 * probe.started names, no entry of improve-probe in it passes any gate but the plan gate, and the output the case recorded is the output of the
 * child's fold at that head (both the blob's bytes and output_hash); an output recorded without `asked` (before outputs carried the child's
 * questions to the person) is compared without it. A child that is not in `casesDir` is not_loaded and does not fail the report.
 * Reads only. The first failing check names the status.
 */
export function verifyProbes(caseDir: string, casesDir: string): ProbeReport {
  const parent = rowsOf(join(caseDir, "ledger.sqlite"));
  const started = new Map<string, Record<string, unknown>>();
  let selected: string | null = null;
  let candidates = new Map<string, string | null>();
  const probes: ProbeReport["probes"] = [];
  for (const r of parent.rows) {
    const p = r.payload;
    if (!isObj(p)) continue;
    if (r.type === "improve.selected") { selected = typeof p.loop_hash === "string" ? p.loop_hash : null; candidates = new Map(); started.clear(); continue; }
    if (r.type === "improve.candidate" && typeof p.candidate === "string") { candidates.set(p.candidate, p.status === "staged" && typeof p.loop_hash === "string" ? p.loop_hash : null); continue; }
    if (r.type === "probe.started" && typeof p.probe === "string") { started.set(p.probe, p); continue; }
    if (r.type !== "probe.finished" || typeof p.probe !== "string" || typeof p.child !== "string") continue;
    const opened = started.get(p.probe) ?? null;
    const status = ((): ProbeReport["probes"][number]["status"] => {
      if (opened === null || opened.child !== p.child || !CHILD_ID.test(p.child) || typeof opened.candidate !== "string" || typeof opened.task !== "string" || typeof opened.loop_hash !== "string") return "not_its_child";
      const expected = opened.candidate === "base" ? selected : (candidates.get(opened.candidate) ?? null);
      if (expected === null || opened.loop_hash !== expected) return "version_differs";
      const ledgerPath = join(casesDir, p.child, "ledger.sqlite");
      if (!existsSync(ledgerPath)) return "not_loaded";
      let child: ReturnType<typeof rowsOf>;
      try {
        child = rowsOf(ledgerPath);
      } catch {
        return "head_differs";
      }
      const mark = child.rows.find((x) => x.type === "probe.child")?.payload;
      const link = child.rows.find((x) => x.type === "subloop.child" && x.seq <= 3)?.payload;
      const stray = child.rows.some((x) => x.type === "gate.passed" && isObj(x.payload) && x.payload.gate !== "plan" && isStrayActor(ledgerPath, x.seq));
      if (child.case !== p.child || !isObj(mark) || !isObj(link) || link.parent !== parent.case || mark.improve !== parent.case || mark.origin !== parent.rows[0]?.hash
        || mark.probe !== p.probe || mark.candidate !== opened.candidate || mark.task !== opened.task || child.rows[0]?.hash !== opened.origin || stray) return "not_its_child";
      if (typeof p.child_run === "string") {
        const at = child.rows.findIndex((x) => x.type === "run.started" && isObj(x.payload) && x.payload.run === p.child_run);
        const bound = at > 0 && child.rows[at - 1]!.type === "loop.bound" ? child.rows[at - 1]!.payload : null;
        if (!(isObj(bound) && bound.hash === opened.loop_hash)) return "version_differs";
      }
      const head = isHead(p.head) ? p.head : null;
      const there = head === null ? undefined : child.rows.find((x) => x.seq === head.seq);
      if (head === null || there === undefined || there.hash !== head.hash) return "head_differs";
      const bytes = blobOf(caseDir, p.output);
      if (bytes === null || typeof p.output_hash !== "string" || sha256Hex(bytes) !== p.output_hash) return "output_differs";
      let again: ProbeOutput;
      try {
        again = probeOutputOf(fold(entriesOf(ledgerPath), head.seq));
      } catch {
        return "output_differs";
      }
      if (sha256Hex(canonical(again as unknown as Json)) === p.output_hash) return "matches";
      // an output recorded before outputs carried the child's questions to the person is that output without them
      const recorded = readProbeOutput(bytes);
      if (again.asked === undefined || recorded === null || recorded.asked !== undefined) return "output_differs";
      const { asked: _later, ...older } = again;
      return sha256Hex(canonical(older as unknown as Json)) === p.output_hash ? "matches" : "output_differs";
    })();
    probes.push({ probe: p.probe, child: p.child, status });
  }
  return { ok: probes.every((x) => x.status === "matches" || x.status === "not_loaded"), probes };
}

/** True when the entry at `seq` of the ledger was written by the system actor improve-probe. */
function isStrayActor(ledgerPath: string, seq: number): boolean {
  const db = new Database(ledgerPath, { readonly: true });
  try {
    const row = db.query("SELECT actor FROM entries WHERE seq = ?").get(seq) as { actor: string } | null;
    const actor = row === null ? null : parseJson(row.actor)?.value;
    return isObj(actor) && actor.kind === "system" && actor.id === "improve-probe";
  } finally {
    db.close();
  }
}

/** One line per probe: `probe <probe>: <child> <status>`. */
export function probeLines(r: ProbeReport): string[] {
  const said: Record<ProbeReport["probes"][number]["status"], string> = {
    matches: "matches", not_loaded: "not loaded here, not checked", head_differs: "BROKEN: its ledger does not hold the recorded head",
    not_its_child: "BROKEN: it is not the child this case recorded for the probe", version_differs: "BROKEN: the version it ran is not the one this case recorded for the probe",
    output_differs: "BROKEN: its output at the recorded head is not the output this case recorded",
  };
  return r.probes.map((x) => `probe ${x.probe}: ${x.child} ${said[x.status]}`);
}

export interface ScoreReport { ok: boolean; scored: boolean; problem: string | null }

/**
 * Recomputes the sheet of an improve case's last judge.scored from the case's own blobs (the answers, each probe's recorded output) and the matches the
 * sheet records, and compares it with the one recorded; the entry's summary must be the sheet's. Reads no other case. A case never judged is ok and not scored.
 */
export function verifyScores(caseDir: string): ScoreReport {
  const rows = rowsOf(join(caseDir, "ledger.sqlite")).rows;
  const judged = rows.findLast((r) => r.type === "judge.scored" && isObj(r.payload));
  if (judged === undefined) return { ok: true, scored: false, problem: null };
  const bad = (problem: string): ScoreReport => ({ ok: false, scored: true, problem });
  const p = judged.payload as Record<string, unknown>;
  const answersBytes = blobOf(caseDir, p.answers);
  const answers = answersBytes === null ? null : readAnswers(answersBytes);
  if (answers === null) return bad("the answers blob is missing or is not a list of known answers");
  const sheetBytes = blobOf(caseDir, p.scores);
  const sheet = sheetBytes === null ? null : readScoreSheet(sheetBytes);
  if (sheet === null) return bad("the scores blob is missing or is not a score sheet");
  const outputs: Record<string, NonNullable<ReturnType<typeof readProbeOutput>>> = {};
  for (const r of rows) {
    if (r.seq >= judged.seq) break;
    if (r.type !== "probe.finished" || !isObj(r.payload) || typeof r.payload.probe !== "string") continue;
    const bytes = blobOf(caseDir, r.payload.output);
    const output = bytes === null ? null : readProbeOutput(bytes);
    if (output === null) delete outputs[r.payload.probe];
    else outputs[r.payload.probe] = output;
  }
  const again = rescore(sheet, outputs, answers);
  for (const o of sheet.outputs) {
    const now = again.outputs.find((x) => x.probe === o.probe);
    if (now === undefined) return bad(`${o.probe}: its output or its known answer is not in this case`);
    if (canonical(now as unknown as Json) !== canonical(o as unknown as Json)) {
      return bad(`${o.probe}: the recorded score is ${o.score === null ? "none" : o.score}, recomputed ${now.score === null ? "none" : now.score}${o.score === now.score ? " (its matches differ)" : ""}`);
    }
  }
  for (const row of again.summary) {
    const was = sheet.summary.find((x) => x.candidate === row.candidate);
    if (was === undefined || canonical(was as unknown as Json) !== canonical(row as unknown as Json)) return bad(`summary of ${row.candidate}: the sheet records ${was === undefined ? "none" : was.score}, recomputed ${row.score}`);
  }
  if (!Array.isArray(p.summary) || canonical(p.summary as Json) !== canonical(sheet.summary as unknown as Json)) return bad("the summary judge.scored records is not the sheet's");
  return { ok: true, scored: true, problem: null };
}

/** No line for a case never judged; else one line: `scores: ok` or `scores: BROKEN: <the first score that differs>`. */
export function scoreLines(r: ScoreReport): string[] {
  if (!r.scored) return [];
  return [r.ok ? "scores: ok, recomputed from the case's own blobs" : `scores: BROKEN: ${r.problem ?? "they differ"}`];
}

export interface GateReport { ok: boolean; checked: boolean; problems: { seq: number; status: "code_passed_gate" | "adopted_unprobed"; detail: string }[] }

/** The actor of each entry of a ledger file, by seq, read-only; null where it is not JSON. */
function actorsOf(ledgerPath: string): Map<number, unknown> {
  const db = new Database(ledgerPath, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return new Map((db.query("SELECT seq, actor FROM entries ORDER BY seq ASC").all() as { seq: number; actor: string }[]).map((r) => [r.seq, parseJson(r.actor)?.value ?? null]));
  } finally {
    db.close();
  }
}

/** The hashes a staged lock names (its loop file and every item): what the version that was probed covers. Null when the blob is not a lock. */
function lockHashes(bytes: Uint8Array | null): Set<string> | null {
  if (bytes === null) return null;
  const x = parseJson(new TextDecoder().decode(bytes))?.value;
  if (!isObj(x) || !isObj(x.manifest) || !Array.isArray(x.items)) return null;
  const out = new Set<string>();
  if (typeof x.manifest.hash === "string") out.add(x.manifest.hash);
  for (const i of x.items) if (isObj(i) && typeof i.hash === "string") out.add(i.hash);
  return out;
}

/**
 * Two rules of the improve loop that hold in any case's ledger. (a) A gate is passed by a person; the exceptions are the plan gate of a probe child,
 * passed by improve-probe, and a probe child's run held for the person's answer to a question, which improve-probe resumes without it (passedQuestions).
 * Any other gate.passed, or resume past a question, by an actor that is not a person is code_passed_gate. (b) In an improve case, every file a person's
 * accept wrote (builder.decided accepted, its written hash) is of the change Compose chose in that run, and its hash is one the staged lock of that
 * candidate names: what was probed. Anything else accepted there is adopted_unprobed. Reads only. `checked` is true for an improve case or a probe
 * child, and for any case where a problem is found.
 */
export function verifyGates(caseDir: string): GateReport {
  const ledgerPath = join(caseDir, "ledger.sqlite");
  const { rows } = rowsOf(ledgerPath);
  const actors = actorsOf(ledgerPath);
  const problems: GateReport["problems"] = [];
  // a probe child as the fold reads one: probe.child in the commit of case.created, nowhere else
  const resumes = passedQuestions(ledgerPath);
  const probeChild = rows.some((r) => r.type === "probe.child") && resumes.state.improve.probe_of !== null;
  const improveCase = rows.some((r) => r.type === "improve.requested");
  for (const r of rows) {
    if (r.type !== "gate.passed" || !isObj(r.payload)) continue;
    const a = actors.get(r.seq);
    if (isObj(a) && a.kind === "human") continue;
    const byProbe = isObj(a) && a.kind === "system" && a.id === "improve-probe";
    if (byProbe && probeChild && r.payload.gate === "plan") continue;
    const who = isObj(a) && typeof a.kind === "string" ? `${a.kind}${typeof a.id === "string" ? ` ${a.id}` : ""}` : "an unreadable actor";
    problems.push({ seq: r.seq, status: "code_passed_gate", detail: `the ${String(r.payload.gate)} gate was passed by ${who}` });
  }
  problems.push(...resumes.problems);
  problems.sort((a, b) => a.seq - b.seq);
  if (improveCase) {
    let candidates = new Map<string, { change: string; lock: unknown }>();
    let chosen: string | null = null;
    for (const r of rows) {
      const p = r.payload;
      if (!isObj(p)) continue;
      if (r.type === "improve.selected") { candidates = new Map(); chosen = null; continue; }
      if (r.type === "improve.candidate" && typeof p.candidate === "string" && typeof p.change === "string") { candidates.set(p.candidate, { change: p.change, lock: p.status === "staged" ? p.lock : null }); continue; }
      if (r.type === "compose.chosen") { chosen = typeof p.candidate === "string" ? p.candidate : null; continue; }
      if (r.type !== "builder.decided" || p.accepted !== true) continue;
      const c = chosen === null ? undefined : candidates.get(chosen);
      if (c === undefined || c.change !== p.change) {
        problems.push({ seq: r.seq, status: "adopted_unprobed", detail: `change ${String(p.change)} was accepted, and it is not the candidate Compose chose` });
        continue;
      }
      const covered = lockHashes(blobOf(caseDir, c.lock));
      if (covered === null || typeof p.written !== "string" || !covered.has(p.written)) {
        problems.push({ seq: r.seq, status: "adopted_unprobed", detail: `file ${String(p.file)} of change ${c.change} was written as bytes the probed version of ${chosen} does not name` });
      }
    }
  }
  return { ok: problems.length === 0, checked: improveCase || probeChild || problems.length > 0, problems };
}

/**
 * The resumes that went on past what only a person may: a run held for the person's answer to a question resumed by an actor that is not a person,
 * but for improve-probe in a probe child (no person is there to answer; the question stays asked); and any run.resumed by improve-probe but that one
 * and the resume of an interrupted probe child. Each is judged against the fold just before it; the fold at the end is returned with them.
 */
function passedQuestions(ledgerPath: string): { problems: GateReport["problems"]; state: CaseState } {
  const out: GateReport["problems"] = [];
  let s = initial();
  for (const e of entriesOf(ledgerPath)) {
    if (e.type === "run.resumed") {
      const a = e.actor as unknown;
      const human = isObj(a) && a.kind === "human";
      const byProbe = isObj(a) && a.kind === "system" && a.id === "improve-probe";
      const onQuestion = s.run.status === "paused" && s.run.hold?.kind === "question";
      const child = s.improve.probe_of !== null;
      const who = isObj(a) && typeof a.kind === "string" ? `${a.kind}${typeof a.id === "string" ? ` ${a.id}` : ""}` : "an unreadable actor";
      if (byProbe && !child) {
        out.push({ seq: e.seq, status: "code_passed_gate", detail: onQuestion ? `the person's question was passed over by ${who}, outside a probe child` : `a run was resumed by ${who}, outside a probe child` });
      } else if (byProbe && !onQuestion && s.run.status !== "interrupted") {
        out.push({ seq: e.seq, status: "code_passed_gate", detail: `a run ${s.run.status === "paused" ? `held on ${s.run.pause_reason ?? "a pause"}` : `that was ${s.run.status}`} was resumed by ${who}` });
      } else if (!human && !byProbe && onQuestion) {
        out.push({ seq: e.seq, status: "code_passed_gate", detail: `the person's question was passed over by ${who}` });
      }
    }
    s = apply(s, e);
  }
  return { problems: out, state: s };
}

/** No line for a case that is neither an improve case nor a probe child and holds no problem; else `gates: ok` or one BROKEN line per problem. */
export function gateLines(r: GateReport): string[] {
  if (!r.checked) return [];
  if (r.ok) return ["gates: ok, every gate a person's but a probe child's plan gate and its questions passed over, and every adopted file the probed version's"];
  return r.problems.map((x) => `gates: BROKEN at seq ${x.seq}: ${x.detail}`);
}

// ---------- the memory store (slice 13) ----------

/** Every entry of a ledger file, read-only, as Ledger reads them: a row whose actor or payload is not JSON has them null, so the fold skips it. */
function entriesOf(ledgerPath: string): Entry[] {
  const db = new Database(ledgerPath, { readonly: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const meta = db.query("SELECT value FROM meta WHERE key = 'case_id'").get() as { value: string } | null;
    return (db.query("SELECT * FROM entries ORDER BY seq ASC").all() as LedgerRow[]).map((row): Entry => {
      const actor = parseJson(row.actor);
      const payload = parseJson(row.payload);
      return {
        seq: row.seq, ts: row.ts, case: meta?.value ?? "", actor: (actor?.value ?? null) as unknown as Actor, type: row.type as EntryType,
        payload: (actor === null || payload === null ? null : payload.value) as unknown as Entry["payload"],
        cause: row.cause, run: row.run, stage: row.stage, job: row.job, prev_hash: row.prev_hash, hash: row.hash,
      } as Entry;
    });
  } finally {
    db.close();
  }
}

const NOT_ITS_HASH = "its recorded hash is not the hash of what it says";

/** The store's chain and blobs (verifyLedger), and each lesson: its recorded hash is lessonHash of what was proposed, and nothing was skipped by the fold. */
export function verifyMemory(storeDir: string): VerifyReport & { lessons: { ok: boolean; bad: { lesson: string; reason: string }[]; skipped: number } } {
  const ledgerPath = join(storeDir, "ledger.sqlite");
  const report = verifyLedger(ledgerPath, join(storeDir, "blobs"));
  const entries = entriesOf(ledgerPath);
  const bad: { lesson: string; reason: string }[] = [];
  for (const e of entries) {
    if (e.type !== "lesson.proposed" || !isObj(e.payload)) continue;
    const p = e.payload as unknown as LessonDraft & { lesson: unknown; hash: unknown };
    let hash: string | null;
    try {
      hash = lessonHash({ case_type: p.case_type, title: p.title, text: p.text, triggers: p.triggers, marking: p.marking, supersedes: p.supersedes });
    } catch {
      hash = null;
    }
    if (hash !== p.hash) bad.push({ lesson: typeof p.lesson === "string" ? p.lesson : `entry ${e.seq}`, reason: NOT_ITS_HASH });
  }
  const skipped = foldLessons(entries).skipped.length;
  const lessons = { ok: bad.length === 0 && skipped === 0, bad, skipped };
  return { ...report, ok: report.ok && report.case === MEMORY_CHAIN && lessons.ok, lessons };
}

export interface MemoryLinkReport { ok: boolean; links: { seq: number; lesson: string; status: "matches" | "store_differs" | "not_this_store" | "not_in_store" }[] }

/** For each memory.bound of the case, each locked lesson against the store here. A lock from another store (another origin) is `not_this_store` and does not fail the report. */
export function verifyMemoryLinks(caseDir: string, storeDir: string): MemoryLinkReport {
  const bound = rowsOf(join(caseDir, "ledger.sqlite")).rows.filter((r) => r.type === "memory.bound");
  const storeLedger = join(storeDir, "ledger.sqlite");
  // read-only: a store that is not there is made by nothing here, and every lock is then another store's
  const entries = existsSync(storeLedger) ? entriesOf(storeLedger) : [];
  const origin = entries[0]?.hash ?? null;
  const state = foldLessons(entries);
  const links: MemoryLinkReport["links"] = [];
  for (const r of bound) {
    const p = r.payload;
    if (!isObj(p) || !isObj(p.store) || !Array.isArray(p.lessons)) continue;
    const ours = origin !== null && p.store.origin === origin;
    for (const l of p.lessons) {
      if (!isObj(l) || typeof l.lesson !== "string" || typeof l.hash !== "string") continue;
      const held = Object.hasOwn(state.lessons, l.lesson) ? state.lessons[l.lesson]! : null;
      const status = !ours ? "not_this_store" : held === null ? "not_in_store" : held.hash === l.hash ? "matches" : "store_differs";
      links.push({ seq: r.seq, lesson: l.lesson, status });
    }
  }
  return { ok: links.every((l) => l.status === "matches" || l.status === "not_this_store"), links };
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
