// What a case file's case.json says, checked against what its own ledger says. Server-side core (like workbench.ts): never imported by src/web
// or src/core/state. case.json is what the store view, the search and the file's name are drawn from, so it may not say other than the ledger.
import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { canonical } from "./canonical";
import type { Json } from "./canonical";
import { CaseFileError, readCaseMember } from "./casefile";
import type { CaseManifest } from "./casefile";
import { ledgerSchemaProblem } from "./ledger";
import type { LedgerRow } from "./ledger";
import { fold } from "./state";
import type { StoreListing } from "./store";
import type { CaseStoreFolder } from "./store";
import type { Entry } from "./types";

/** Why case.json does not say what the ledger's entries say: the fields that differ, named; null when every one is the same. */
export function summaryProblem(m: CaseManifest, entries: Entry[]): string | null {
  const s = fold(entries);
  if (s.meta === null) return "its ledger has no case.created entry";
  const fields: [string, unknown, unknown][] = [
    ["title", s.meta.title, m.title],
    ["asked", s.meta.asked, m.asked],
    ["marking", s.meta.marking, m.marking],
    ["starting", s.meta.starting, m.starting],
    ["status", s.run.status, m.status],
    ["outcome", s.run.outcome, m.outcome],
    ["published", s.published.map((p) => ({ n: p.n, draft_hash: p.draft_hash })), m.published],
  ];
  const differ = fields.filter(([, a, b]) => canonical(a as Json) !== canonical(b as Json)).map(([k]) => k);
  return differ.length === 0 ? null : `case.json does not say what its ledger says (${differ.join(", ")})`;
}

/** The entries of a ledger opened read-only, as Ledger.read gives them (a row whose actor or payload is not JSON has a null payload). */
function entriesOf(db: Database): Entry[] {
  const caseId = (db.query("SELECT value FROM meta WHERE key = 'case_id'").get() as { value: string } | null)?.value ?? "";
  const json = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  return (db.query("SELECT * FROM entries ORDER BY seq ASC").all() as LedgerRow[]).map((row) => {
    const actor = json(row.actor);
    const payload = json(row.payload);
    return {
      seq: row.seq, ts: row.ts, case: caseId, actor: actor === undefined ? null : actor, type: row.type,
      payload: actor === undefined || payload === undefined ? null : payload,
      cause: row.cause, run: row.run, stage: row.stage, job: row.job, prev_hash: row.prev_hash, hash: row.hash,
    } as unknown as Entry;
  });
}

/** Why a case file's case.json is not to be trusted against its own ledger; null when it says what the ledger says. Reads the file; writes nothing. */
export async function storedCaseProblem(path: string, opts?: { max_bytes?: number }): Promise<string | null> {
  let got: Awaited<ReturnType<typeof readCaseMember>>;
  try {
    got = await readCaseMember(path, "ledger.sqlite", opts);
  } catch (err) {
    return err instanceof CaseFileError ? err.reasons[0]! : "the file is not a readable case file";
  }
  if (got.bytes === null) return "it holds no ledger";
  let db: Database;
  try {
    db = Database.deserialize(got.bytes, true);
  } catch {
    return "its ledger cannot be read";
  }
  try {
    const schema = ledgerSchemaProblem(db);
    if (schema !== null) return `its ledger is not one this workbench writes: ${schema}`;
    return summaryProblem(got.manifest, entriesOf(db));
  } catch {
    return "its ledger cannot be read";
  } finally {
    db.close();
  }
}

/** What was learned of a file, by its name, and the size, time and inode it had then. */
export type StoreChecks = Map<string, { key: string; problem: string | null }>;

/**
 * The store's listing with each case file also checked against its own ledger: one whose case.json says other than its ledger is listed as
 * unreadable with the reason. `checks` keeps what was learned, so a file that has not changed is not read again.
 */
export async function checkedListing(store: CaseStoreFolder, search: string | undefined, opts: { max_bytes?: number; checks?: StoreChecks } = {}): Promise<StoreListing> {
  const listing = await store.list(search);
  const checks = opts.checks ?? new Map();
  const out: StoreListing = { cases: [], unreadable: [...listing.unreadable], leftovers: listing.leftovers };
  for (const c of listing.cases) {
    const path = store.path(c.file);
    let key: string;
    try {
      const st = statSync(path);
      key = `${st.size}:${st.mtimeMs}:${st.ino}`;
    } catch {
      continue; // gone since it was listed
    }
    let known = checks.get(c.file);
    if (known === undefined || known.key !== key) {
      known = { key, problem: await storedCaseProblem(path, opts.max_bytes === undefined ? {} : { max_bytes: opts.max_bytes }) };
      checks.set(c.file, known);
    }
    if (known.problem === null) out.cases.push(c);
    else out.unreadable.push({ file: c.file, reason: known.problem });
  }
  out.unreadable.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return out;
}
