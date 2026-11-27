import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database, Statement } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../src/core/blobs";
import { GENESIS } from "../../src/core/hash";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { entryHash, InvalidEntryError, Ledger } from "../../src/core/ledger";
import { formatReport, linkLines, UnreadableLedgerError, verifyCase, verifyLedger, verifyLinks, verifyPublished } from "../../src/core/verify";
import { Workbench } from "../../src/core/workbench";
import type { CaseSession } from "../../src/core/session";
import type { BlobRef, Product } from "../../src/core/types";
import { cleanEnv } from "../helpers/clean-env";
import { card } from "../helpers/entries";

const human = { kind: "human", id: "analyst" } as const;
const phase = (p: string) => ({ type: "case.phase_changed", payload: { phase: p }, actor: human }) as const;

let root: string;
let dir: string;
let ledger: Ledger;
let blobs: BlobStore;
let ref: BlobRef;
let tick: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "verify-"));
  dir = join(root, "case");
  blobs = new BlobStore(join(dir, "blobs"));
  tick = 0;
  ledger = Ledger.open(join(dir, "ledger.sqlite"), "CASE-1", {
    now: () => new Date(Date.UTC(2026, 10, 23, 20, 0, tick++)).toISOString(),
  });
  ref = blobs.put("rows go here", "application/json");
  ledger.append(phase("collect"));
  ledger.append({ ...phase("analyse"), cause: 1, run: "run-1", stage: "plan", job: "job-1" });
  ledger.append(phase("review"));
  ledger.append({
    type: "query.result",
    payload: { query: "q1", result: ref, rows: 1, rows_hash: "a".repeat(64), coverage: { kind: "full" }, duration_ms: 5, cost: null },
    actor: { kind: "system", id: "runner" },
  });
  ledger.append(phase("publish"));
});
afterEach(() => {
  ledger.close();
  rmSync(root, { recursive: true, force: true });
});

function rawSql(d: string, sql: string): void {
  const db = new Database(join(d, "ledger.sqlite"));
  db.exec(sql);
  db.close();
}

test("a clean case verifies", () => {
  const r = verifyCase(dir);
  expect(r).toMatchObject({ ok: true, case: "CASE-1", entries: 5, firstBad: null, blobs: { referenced: 1, bad: [], lookalikes: 0 } });
  expect(r.head).toBe(ledger.head().hash);
});

test("an edited payload is caught at that entry", () => {
  rawSql(dir, `UPDATE entries SET payload = '{"phase":"edited"}' WHERE seq = 3`);
  expect(verifyCase(dir)).toMatchObject({ ok: false, firstBad: { seq: 3, reason: "hash_mismatch" } });
});

test("an edited timestamp is caught", () => {
  rawSql(dir, `UPDATE entries SET ts = '2030-01-01T00:00:00.000Z' WHERE seq = 2`);
  expect(verifyCase(dir)).toMatchObject({ ok: false, firstBad: { seq: 2, reason: "hash_mismatch" } });
});

test("a deleted entry is caught as a gap", () => {
  rawSql(dir, `DELETE FROM entries WHERE seq = 2`);
  expect(verifyCase(dir)).toMatchObject({ ok: false, firstBad: { seq: 3, reason: "seq_gap" } });
});

test("a re-linked chain is caught", () => {
  rawSql(dir, `UPDATE entries SET prev_hash = '${"1".repeat(64)}' WHERE seq = 4`);
  expect(verifyCase(dir)).toMatchObject({ ok: false, firstBad: { seq: 4, reason: "prev_hash_mismatch" } });
});

test("unparseable JSON is caught", () => {
  rawSql(dir, `UPDATE entries SET payload = '{' WHERE seq = 3`);
  expect(verifyCase(dir)).toMatchObject({ ok: false, firstBad: { seq: 3, reason: "bad_json" } });
});

test("a missing blob and a corrupt blob are reported", () => {
  const other = blobs.put("second blob");
  ledger.append({
    type: "query.result",
    payload: { query: "q2", result: other, rows: 1, rows_hash: "b".repeat(64), coverage: { kind: "full" }, duration_ms: 5, cost: null },
    actor: { kind: "system", id: "runner" },
  });
  rmSync(join(dir, "blobs", ref.blob));
  writeFileSync(join(dir, "blobs", other.blob), "tampered");
  const r = verifyCase(dir);
  expect(r.ok).toBe(false);
  expect(r.firstBad).toBeNull();
  expect(r.blobs).toEqual({
    referenced: 2,
    bad: [{ blob: ref.blob, state: "missing", seq: 4 }, { blob: other.blob, state: "corrupt", seq: 6 }],
    lookalikes: 0,
  });
});

test("verification works on a copy of the folder", () => {
  const copy = join(root, "copy");
  cpSync(dir, copy, { recursive: true });
  expect(verifyCase(copy).ok).toBe(true);
});

test("an empty ledger verifies with zero entries", () => {
  const empty = join(root, "empty");
  mkdirSync(empty);
  Ledger.open(join(empty, "ledger.sqlite"), "CASE-2").close();
  const r = verifyCase(empty);
  expect(r).toMatchObject({ ok: true, case: "CASE-2", entries: 0, head: GENESIS, firstBad: null });
});

test("whitespace or key-order edits to the stored text are caught", () => {
  rawSql(dir, `UPDATE entries SET payload = '{ "phase": "review" }' WHERE seq = 3`);
  expect(verifyCase(dir)).toMatchObject({ ok: false, firstBad: { seq: 3, reason: "hash_mismatch" } });
});

test("a large integer rewritten to a nearby value is caught", () => {
  rawSql(dir, `UPDATE entries SET payload = '{"phase":9007199254740993}' WHERE seq = 3`);
  expect(verifyCase(dir)).toMatchObject({ ok: false, firstBad: { seq: 3, reason: "hash_mismatch" } });
});

test("an edit to the actor text is caught even when it parses the same", () => {
  rawSql(dir, `UPDATE entries SET actor = '{ "kind": "human", "id": "analyst" }' WHERE seq = 3`);
  expect(verifyCase(dir)).toMatchObject({ ok: false, firstBad: { seq: 3, reason: "hash_mismatch" } });
});

const columnEdits: [string, string][] = [
  ["actor", `actor = '{"id":"someone-else","kind":"human"}'`],
  ["type", `type = 'case.created'`],
  ["cause", `cause = 3`],
  ["run", `run = 'run-2'`],
  ["stage", `stage = 'other'`],
  ["job", `job = 'job-2'`],
  ["hash", `hash = '${"2".repeat(64)}'`],
  ["cause cleared", `cause = NULL`],
];
for (const [name, set] of columnEdits) {
  test(`an edit to ${name} is caught`, () => {
    rawSql(dir, `UPDATE entries SET ${set} WHERE seq = 2`);
    const r = verifyCase(dir);
    expect(r.ok).toBe(false);
    // Editing the hash column breaks the next link as well; the first failure is at entry 2 either way.
    expect(r.firstBad).toMatchObject({ seq: 2, reason: "hash_mismatch" });
  });
}

test("an edit to meta.case_id is caught at entry 1", () => {
  rawSql(dir, `UPDATE meta SET value = 'CASE-9' WHERE key = 'case_id'`);
  expect(verifyCase(dir)).toMatchObject({ ok: false, case: "CASE-9", firstBad: { seq: 1, reason: "hash_mismatch" } });
});

function badLedger(name: string, sql: string | null): string {
  const d = join(root, name);
  mkdirSync(d);
  if (sql === null) writeFileSync(join(d, "ledger.sqlite"), "this is not a database, just text padding".repeat(20));
  else rawSql(d, sql);
  return d;
}

test("a file that is not SQLite is unreadable", () => {
  expect(() => verifyCase(badLedger("notdb", null))).toThrow(UnreadableLedgerError);
});
test("a database missing the meta or entries table is unreadable", () => {
  expect(() => verifyCase(badLedger("nometa", "CREATE TABLE entries (seq INTEGER)"))).toThrow(UnreadableLedgerError);
  expect(() => verifyCase(badLedger("noentries", "CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('case_id','C')"))).toThrow(UnreadableLedgerError);
});
test("a missing case id is unreadable, even with no entries", () => {
  const d = badLedger("nocase", `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE entries (seq INTEGER PRIMARY KEY, ts TEXT, actor TEXT, type TEXT, payload TEXT, cause INTEGER, run TEXT, stage TEXT, job TEXT, prev_hash TEXT, hash TEXT)`);
  expect(() => verifyCase(d)).toThrow(/case id/);
});
test("a blob path that is a directory is reported corrupt", () => {
  rmSync(join(dir, "blobs", ref.blob));
  mkdirSync(join(dir, "blobs", ref.blob));
  expect(verifyCase(dir).blobs.bad).toEqual([{ blob: ref.blob, state: "corrupt", seq: 4 }]);
});
test("a blob directory that is a regular file reports its blobs corrupt", () => {
  rmSync(join(dir, "blobs"), { recursive: true });
  writeFileSync(join(dir, "blobs"), "not a directory");
  expect(verifyLedger(join(dir, "ledger.sqlite"), join(dir, "blobs"))).toMatchObject({ ok: false, blobs: { bad: [{ blob: ref.blob, state: "corrupt", seq: 4 }] } });
});
test("the command reports an unreadable ledger on stdout and exits 1", () => {
  const r = run(badLedger("cli-notdb", null));
  expect(r.exitCode).toBe(1);
  expect(r.stdout.toString()).toContain("UNREADABLE (");
});

function run(...args: string[]) {
  return Bun.spawnSync(["bun", "run", "src/cli/verify.ts", ...args], { cwd: join(import.meta.dir, "../.."), env: cleanEnv(root) });
}

test("the command exits 0 for intact, 1 for broken, 2 with no argument", () => {
  expect(run(dir).exitCode).toBe(0);
  rawSql(dir, `UPDATE entries SET payload = '{"phase":"edited"}' WHERE seq = 3`);
  expect(run(dir).exitCode).toBe(1);
  expect(run().exitCode).toBe(2);
  expect(run(join(root, "nowhere")).exitCode).toBe(2);
});

test("the command prints the entry count and the failing entry", () => {
  expect(run(dir).stdout.toString()).toContain("chain intact · 5 entries");
  expect(run(dir).stdout.toString()).toContain("compare the head with one recorded elsewhere");
  rawSql(dir, `UPDATE entries SET payload = '{"phase":"edited"}' WHERE seq = 3`);
  const broken = run(dir).stdout.toString();
  expect(broken).not.toContain("compare the head");
  expect(broken).toContain("BROKEN at entry 3 (hash_mismatch)");
});

test("formatReport shows the full 64-character head, so it can be compared with one recorded elsewhere", () => {
  const text = formatReport(verifyCase(dir));
  expect(text).toBe(`case CASE-1: chain intact · 5 entries · head ${ledger.head().hash}\nblobs: 1 referenced · 0 missing · 0 corrupt\ncompare the head with one recorded elsewhere: removing the newest entries cannot be detected from this file alone`);
});

// ---------- final review, finding 4: verify rechecks draft hashes ----------
const product: Product = {
  objective: "o", question: "q", marking: "TLP:AMBER", summary: "s", key_findings: [], gaps_and_limits: "", alternatives: "",
  assessment: "", sources: [], assumptions: [], change: "",
};

test("a draft whose hash is not the hash of its product is reported as draft_hash_mismatch", () => {
  const good = sha256Hex(canonical(product as never));
  ledger.append({ type: "draft.revised", payload: { draft: { n: 1, hash: good, author: human, product, reason: "r" } }, actor: human });
  expect(verifyCase(dir).ok).toBe(true);
  // A writer other than Ledger appends a correctly chained row whose draft hash does not match its product.
  const head = ledger.head();
  const payload = { draft: { n: 2, hash: good, author: human, product: { ...product, summary: "changed" }, reason: "r" } };
  const row = { seq: head.seq + 1, ts: "2026-11-23T21:00:00.000Z", case: "CASE-1", actor: human, type: "draft.revised", payload, cause: null, run: null, stage: null, job: null, prev_hash: head.hash };
  const hash = entryHash(row as never);
  const db = new Database(join(dir, "ledger.sqlite"));
  db.query("INSERT INTO entries VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)").run(row.seq, row.ts, canonical(human), row.type, canonical(payload as never), row.prev_hash, hash);
  db.close();
  expect(verifyCase(dir)).toMatchObject({ ok: false, firstBad: { seq: row.seq, reason: "draft_hash_mismatch" } });
});

test("the ledger itself refuses such a draft", () => {
  const before = ledger.head();
  const payload = { draft: { n: 1, hash: "h1", author: human, product, reason: "r" } };
  expect(() => ledger.append({ type: "draft.revised", payload, actor: human })).toThrow(InvalidEntryError);
  expect(() => ledger.append({ type: "draft.revised", payload, actor: human })).toThrow(/draft_hash_mismatch/);
  expect(ledger.head()).toEqual(before);
});

// ---------- final review, finding 8: the report names each bad blob and its entry, and the head in full ----------
test("a bad blob makes the first line say BROKEN and names the blob and the entry that references it", () => {
  const other = blobs.put("second blob");
  ledger.append({ type: "tool.returned", payload: { call: "t1", ok: true, summary: "s", result: other }, actor: { kind: "system", id: "runner" } });
  rmSync(join(dir, "blobs", ref.blob));
  writeFileSync(join(dir, "blobs", other.blob), "tampered");
  const text = formatReport(verifyCase(dir));
  const lines = text.split("\n");
  expect(lines[0]).toBe(`case CASE-1: BROKEN · 2 blobs missing or corrupt · chain intact · 6 entries · head ${ledger.head().hash}`);
  expect(lines[1]).toBe("blobs: 2 referenced · 1 missing · 1 corrupt");
  expect(lines).toContain(`  missing blob ${ref.blob}, referenced by entry 4`);
  expect(lines).toContain(`  corrupt blob ${other.blob}, referenced by entry 6`);
  const cli = run(dir);
  expect(cli.exitCode).toBe(1);
  expect(cli.stdout.toString().split("\n")[0]).toStartWith("case CASE-1: BROKEN");
});

test("each blob is reported against the first entry that references it", () => {
  ledger.append({
    type: "query.result",
    payload: { query: "q2", result: ref, rows: 1, rows_hash: "a".repeat(64), coverage: { kind: "full" }, duration_ms: 5, cost: null },
    actor: { kind: "system", id: "runner" },
  });
  rmSync(join(dir, "blobs", ref.blob));
  expect(verifyCase(dir).blobs).toEqual({ referenced: 1, bad: [{ blob: ref.blob, state: "missing", seq: 4 }], lookalikes: 0 });
});

test("a broken chain with bad blobs reports both, BROKEN first", () => {
  rmSync(join(dir, "blobs", ref.blob));
  rawSql(dir, `UPDATE entries SET payload = '{"phase":"edited"}' WHERE seq = 3`);
  const lines = formatReport(verifyCase(dir)).split("\n");
  expect(lines[0]).toBe("case CASE-1: BROKEN at entry 3 (hash_mismatch)");
  expect(lines).toContain(`  missing blob ${ref.blob}, referenced by entry 4`);
  expect(lines).not.toContain("compare the head with one recorded elsewhere: removing the newest entries cannot be detected from this file alone");
});

// ---------- final review, finding 9: only the positions the types define are references ----------
test("data shaped like a blob reference in a card row or a tool argument is a look-alike, not a failure", () => {
  const lookalike = { blob: "ab".repeat(32), bytes: 1 };
  ledger.append({ type: "tool.called", payload: { request: "r1", call: "t1", tool: "lookup", args: { target: lookalike }, why: "w" }, actor: { kind: "system", id: "s" } });
  ledger.append({ type: "card.created", payload: { card: card("c1", { rows: [[lookalike, { nested: lookalike }]] }) }, actor: { kind: "system", id: "s" } });
  const r = verifyCase(dir);
  expect(r.ok).toBe(true);
  expect(r.blobs).toEqual({ referenced: 1, bad: [], lookalikes: 3 });
  expect(formatReport(r).split("\n")[1]).toBe("blobs: 1 referenced · 0 missing · 0 corrupt · 3 look-alikes outside reference fields, not checked");
});

test("every reference position the types define is checked, and a null one is skipped", () => {
  const a = blobs.put("messages"), b = blobs.put("response"), c = blobs.put("reasoning");
  const sys = { kind: "system", id: "s" } as const;
  ledger.append({
    type: "model.request",
    payload: { request: "r1", provider: "p", model: "m", effort: null, where: "machine", marking: "TLP:AMBER", pack: [], left_out: [], messages: a, tools: [] },
    actor: sys,
  });
  ledger.append({ type: "model.response", payload: { request: "r1", response: b, stop: "end", usage: { input: 1, output: 1, reasoning: 1 }, served_by: "m", reasoning: c }, actor: sys });
  ledger.append({ type: "model.response", payload: { request: "r2", response: b, stop: "end", usage: { input: 1, output: 1, reasoning: 1 }, served_by: "m", reasoning: null }, actor: sys });
  ledger.append({ type: "stage.finished", payload: { stage: "s", attempt: 1, outcome: "pass", draft_hash: null, output: null, reason: null }, actor: sys });
  expect(verifyCase(dir).blobs).toEqual({ referenced: 4, bad: [], lookalikes: 0 });
  rmSync(join(dir, "blobs", c.blob));
  expect(verifyCase(dir).blobs.bad).toEqual([{ blob: c.blob, state: "missing", seq: 7 }]);
});

// ---------- final review, finding 22: the verifier under load, and what the command can reach ----------
test("a check that coincides with a write waits for it instead of reporting the ledger unreadable", async () => {
  const script = join(import.meta.dir, "..", "helpers", "ledger-locker.ts");
  const child = Bun.spawn([process.execPath, script, join(dir, "ledger.sqlite"), "400"], { stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let said = "";
  while (!said.includes("locked")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`locker exited early: ${await new Response(child.stderr).text()}`);
    said += new TextDecoder().decode(value);
  }
  const r = verifyCase(dir); // blocks until the lock is released
  expect(r.ok).toBe(true);
  expect(r.entries).toBe(5);
  reader.releaseLock();
  expect(await child.exited).toBe(0);
});

test("rows are iterated, not loaded all at once", () => {
  // bun:sqlite puts all() and iterate() on each statement, so wrap the statements query() returns.
  const calls: string[] = [];
  const query = Database.prototype.query;
  const spy = spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql: string) {
    const st = query.call(this, sql) as Statement;
    for (const method of ["all", "iterate"] as const) {
      const real = st[method].bind(st) as (...args: unknown[]) => unknown;
      (st as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        calls.push(`${method} ${sql}`);
        return real(...args);
      };
    }
    return st;
  } as typeof Database.prototype.query);
  try {
    expect(verifyCase(dir).ok).toBe(true);
  } finally {
    spy.mockRestore();
  }
  // the chain check, then the published-bundle check: each walks the entries one at a time
  expect(calls.filter((c) => c.includes("FROM entries"))).toEqual(["iterate SELECT * FROM entries ORDER BY seq ASC", "iterate SELECT seq, type, hash, payload FROM entries ORDER BY seq ASC"]);
});

test("the command verifies any ledger file and blob folder with --ledger and --blobs", () => {
  ledger.close();
  ledger = Ledger.open(join(root, "workbench.sqlite"), "workbench");
  ledger.append({ type: "setting.changed", payload: { key: "k", value: 1 }, actor: human });
  const ok = run("--ledger", join(root, "workbench.sqlite"), "--blobs", join(root, "blobs"));
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString()).toStartWith("case workbench: chain intact · 1 entries · head ");
  expect(run("--blobs", join(dir, "blobs"), "--ledger", join(dir, "ledger.sqlite")).exitCode).toBe(0);
  for (const args of [["--ledger", join(root, "workbench.sqlite")], ["--ledger", join(root, "nowhere.sqlite"), "--blobs", root], ["--ledger"], ["--bogus", "x"], [dir, "extra"]]) {
    const r = run(...args);
    expect(r.exitCode, args.join(" ")).toBe(2);
    expect(r.stderr.toString(), args.join(" ")).toContain("usage:");
  }
  writeFileSync(join(root, "junk.sqlite"), "this is not a database, just text padding".repeat(20));
  const unreadable = run("--ledger", join(root, "junk.sqlite"), "--blobs", root);
  expect(unreadable.exitCode).toBe(1);
  expect(unreadable.stdout.toString()).toContain("UNREADABLE (");
});

// ---------- close-out: a malformed reference at a typed position ----------
function insertMalformed(): void {
  const head = ledger.head();
  const body = {
    seq: head.seq + 1, ts: "2026-11-23T20:10:00.000Z", case: "CASE-1", actor: { kind: "system", id: "runner" }, type: "query.result",
    payload: { query: "q2", result: { blob: "zz", bytes: 1 }, rows: 1, rows_hash: "b".repeat(64), coverage: { kind: "full" }, duration_ms: 5, cost: null },
    cause: null, run: null, stage: null, job: null, prev_hash: head.hash,
  };
  const hash = entryHash(body as never);
  const db = new Database(join(dir, "ledger.sqlite"));
  db.query("INSERT INTO entries (seq, ts, actor, type, payload, cause, run, stage, job, prev_hash, hash) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)")
    .run(body.seq, body.ts, canonical(body.actor), body.type, canonical(body.payload), body.prev_hash, hash);
  db.close();
}

test("a malformed reference at a typed position is reported as bad", () => {
  insertMalformed();
  const r = verifyCase(dir);
  expect(r.ok).toBe(false);
  expect(r.firstBad).toBeNull();
  expect(r.blobs.bad).toEqual([{ blob: '{"blob":"zz","bytes":1}', state: "malformed", seq: 6 }]);
});

test("the command prints a malformed reference with its entry", () => {
  insertMalformed();
  const lines = formatReport(verifyCase(dir)).split("\n");
  expect(lines[0]).toStartWith("case CASE-1: BROKEN");
  expect(lines).toContain('  malformed blob {"blob":"zz","bytes":1}, referenced by entry 6');
  expect(run(dir).exitCode).toBe(1);
});

// ---------- final review: a required blob position that is absent ----------
test("a query.result with no result reference is reported as malformed", () => {
  const head = ledger.head();
  const body = {
    seq: head.seq + 1, ts: "2026-11-23T20:10:00.000Z", case: "CASE-1", actor: { kind: "system", id: "runner" }, type: "query.result",
    payload: { query: "q2", rows: 1, rows_hash: "b".repeat(64), coverage: { kind: "full" }, duration_ms: 5, cost: null },
    cause: null, run: null, stage: null, job: null, prev_hash: head.hash,
  };
  const hash = entryHash(body as never);
  const db = new Database(join(dir, "ledger.sqlite"));
  db.query("INSERT INTO entries (seq, ts, actor, type, payload, cause, run, stage, job, prev_hash, hash) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?)")
    .run(body.seq, body.ts, canonical(body.actor), body.type, canonical(body.payload), body.prev_hash, hash);
  db.close();
  const r = verifyCase(dir);
  expect(r.ok).toBe(false);
  expect(r.firstBad).toBeNull();
  expect(r.blobs.bad).toEqual([{ blob: "result: absent", state: "malformed", seq: 6 }]);
});

// ---------- published bundles ----------
const PRODUCT_JSON = canonical({ summary: "s" } as never);
interface Made { seq: number; folder: string; manifest: Record<string, unknown>; files: Record<string, string> }
/** A bundle as the Publish step makes one: files, a manifest that lists them, the bundle blob, the entry that records it, and the folder. */
function publishByHand(n: number, over: { head?: { seq: number; hash: string }; draftHash?: string; headHash?: string } = {}): Made {
  const files: Record<string, string> = { "product.json": PRODUCT_JSON, "product.md": "# Product\n\nsummary\n" };
  const head = over.head ?? { seq: 2, hash: ledger.get(2)!.hash };
  const draft_hash = over.draftHash ?? sha256Hex(PRODUCT_JSON);
  const manifest = {
    case: "CASE-1", n, draft: 1, draft_hash, head, marking: "TLP:GREEN", title: "T", note: "N",
    files: Object.entries(files).map(([name, text]) => ({ name, sha256: sha256Hex(text), bytes: new TextEncoder().encode(text).byteLength })),
  };
  const bundle = blobs.put(canonical({ manifest, files } as never));
  const entry = ledger.append({ type: "product.published", payload: { n, draft_hash, head_hash: over.headHash ?? head.hash, dir: `published/${n}`, bundle }, actor: human });
  const folder = join(dir, "published", String(n));
  mkdirSync(folder, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  writeFileSync(join(folder, "manifest.json"), canonical(manifest as never));
  return { seq: entry.seq, folder, manifest, files };
}

test("an untouched published folder is ok", () => {
  const m = publishByHand(1);
  expect(verifyPublished(dir)).toEqual({ ok: true, bundles: [{ n: 1, seq: m.seq, state: "ok", detail: "" }], unrecorded: [] });
  expect(verifyCase(dir).published.ok).toBe(true);
  expect(verifyCase(dir).ok).toBe(true);
});

test("a case that published nothing has nothing to report", () => {
  expect(verifyPublished(dir)).toEqual({ ok: true, bundles: [], unrecorded: [] });
});

test("an edited product.md is reported as differs", () => {
  const m = publishByHand(1);
  writeFileSync(join(m.folder, "product.md"), "# Product\n\nsummary, but better\n");
  const r = verifyPublished(dir);
  expect(r.ok).toBe(false);
  expect(r.bundles[0]).toMatchObject({ n: 1, state: "differs" });
  expect(r.bundles[0]!.detail).toContain("product.md");
});

test("a product.json that is not the draft's is reported as differs", () => {
  const first = publishByHand(1);
  // the entry names another draft than the product.json the bundle holds
  publishByHand(2, { draftHash: sha256Hex(canonical({ summary: "not the draft" } as never)) });
  const r = verifyPublished(dir);
  expect(first.seq).toBeGreaterThan(0);
  expect(r.bundles.map((b) => b.state)).toEqual(["ok", "differs"]);
  expect(r.bundles[1]!.detail).toContain("product.json");
});

test("an extra file, a missing file and an edited manifest are each reported as differs", () => {
  const a = publishByHand(1);
  writeFileSync(join(a.folder, "notes.txt"), "extra");
  const b = publishByHand(2);
  rmSync(join(b.folder, "product.md"));
  const c = publishByHand(3);
  writeFileSync(join(c.folder, "manifest.json"), canonical({ ...c.manifest, note: "changed" } as never));
  const r = verifyPublished(dir);
  expect(r.bundles.map((x) => x.state)).toEqual(["differs", "differs", "differs"]);
  expect(r.bundles[0]!.detail).toContain("notes.txt");
  expect(r.bundles[1]!.detail).toContain("product.md");
  expect(r.bundles[2]!.detail).toContain("manifest.json");
});

test("a deleted folder is reported as missing", () => {
  const m = publishByHand(1);
  rmSync(m.folder, { recursive: true });
  expect(verifyPublished(dir)).toMatchObject({ ok: false, bundles: [{ n: 1, state: "missing" }] });
});

test("a manifest head that is not an entry is reported as bad_head", () => {
  publishByHand(1, { head: { seq: 999, hash: "f".repeat(64) }, headHash: "f".repeat(64) });
  const r = verifyPublished(dir);
  expect(r.ok).toBe(false);
  expect(r.bundles[0]).toMatchObject({ n: 1, state: "bad_head" });
});

test("a head whose hash is not the entry's, or not the one the entry records, is reported as bad_head", () => {
  publishByHand(1, { head: { seq: 2, hash: "e".repeat(64) }, headHash: "e".repeat(64) });
  publishByHand(2, { headHash: "d".repeat(64) });
  expect(verifyPublished(dir).bundles.map((b) => b.state)).toEqual(["bad_head", "bad_head"]);
});

test("a bundle blob that is gone or corrupt is reported as bad_blob", () => {
  const m = publishByHand(1);
  const entry = ledger.get(m.seq)!;
  const hash = (entry.payload as { bundle: { blob: string } }).bundle.blob;
  rmSync(join(dir, "blobs", hash), { force: true });
  const r = verifyPublished(dir);
  expect(r.bundles[0]).toMatchObject({ n: 1, state: "bad_blob" });
});

test("a folder no entry records is listed as unrecorded", () => {
  publishByHand(1);
  mkdirSync(join(dir, "published", "7"), { recursive: true });
  mkdirSync(join(dir, "published", ".tmp-2-abc"), { recursive: true });
  const r = verifyPublished(dir);
  expect(r.unrecorded).toEqual([".tmp-2-abc", "7"]);
  expect(r.ok).toBe(false);
});

test("verifyCase is not ok when a bundle differs, and the command exits 1", () => {
  const m = publishByHand(1);
  expect(run(dir).exitCode).toBe(0);
  writeFileSync(join(m.folder, "product.md"), "edited");
  const r = verifyCase(dir);
  expect(r.ok).toBe(false);
  expect(r.published.ok).toBe(false);
  const out = run(dir);
  expect(out.exitCode).toBe(1);
  expect(out.stdout.toString()).toContain("published/1: differs");
  expect(out.stdout.toString()).toContain("BROKEN");
  mkdirSync(join(dir, "published", "9"), { recursive: true });
  expect(run(dir).stdout.toString()).toContain("published/9: no entry records this folder");
});

test("a manifest whose files list holds something that is not a file entry is bad_blob, not a throw", () => {
  for (const bad of [null, 7, "x", [], { name: 3, sha256: "a" }]) {
    const t = ledger.get(2)!;
    const manifest = { case: "CASE-1", n: 1, draft: 1, draft_hash: "a".repeat(64), head: { seq: 2, hash: t.hash }, marking: "TLP:GREEN", title: "T", note: "N", files: [bad] };
    const bundle = blobs.put(canonical({ manifest, files: {} } as never));
    ledger.append({ type: "product.published", payload: { n: 1 + ledger.head().seq, draft_hash: "a".repeat(64), head_hash: t.hash, dir: "published/x", bundle }, actor: human });
  }
  const r = verifyPublished(dir);
  expect(r.bundles.map((b) => b.state)).toEqual(["bad_blob", "bad_blob", "bad_blob", "bad_blob", "bad_blob"]);
});

// ---- links between a parent and its children (slice 12)

const LINK_HASH = "e".repeat(64);
const linkCase = { title: "T", asked: "Who?", why: "test", starting: [{ type: "address", value: "198.51.100.77" }], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN" as const };
const engineActor = { kind: "system", id: "engine" } as const;
const linkStages = [{ id: "investigate", title: "Investigate", phase: null, runs: "loop" as const, gate: null, reviews: false, model: null }];
/** A parent whose run started a child at "investigate" and recorded it finished at `head` (the child's own head when not given). */
function linkedParent(wb: Workbench, child: (parent: string) => CaseSession, head?: (c: CaseSession) => { seq: number; hash: string }, over: (c: CaseSession) => Record<string, unknown> = () => ({})): { parent: CaseSession; child: CaseSession } {
  const parent = wb.createCase(linkCase, human, { loop: "triage" });
  parent.commit((_s, ids) => [{ type: "run.started", actor: human, payload: { run: ids.next("run"), pipeline: "triage", pipeline_hash: "a".repeat(64), stages: linkStages } }]);
  parent.commit((st) => [{ type: "stage.started", actor: engineActor, run: st.run.id, stage: "investigate", payload: { stage: "investigate", attempt: 1 } }]);
  const c = child(parent.id);
  c.commit(() => [{ type: "case.phase_changed", actor: human, payload: { phase: "direction" } }]);
  const at = head === undefined ? c.head() : head(c);
  parent.commit((st) => [
    { type: "subloop.started", actor: engineActor, run: st.run.id, stage: "investigate", payload: { stage: "investigate", attempt: 1, child: c.id, loop: "investigation", loop_hash: "b".repeat(64), input_hash: LINK_HASH, inputs: parent.blobs.put("{}"), depth: 1, ...over(c) } },
  ]);
  parent.commit((st) => [
    { type: "subloop.finished", actor: engineActor, run: st.run.id, stage: "investigate", payload: { stage: "investigate", attempt: 1, child: c.id, child_run: "run-1", head: at, outcome: "completed", output_hash: "f".repeat(64), output: parent.blobs.put("{}"), cards: [] } },
  ]);
  expect(parent.state.skipped).toEqual([]);
  return { parent, child: c };
}
const childOf = (wb: Workbench, over: Record<string, unknown> = {}) => (parent: string): CaseSession =>
  wb.createCase(linkCase, engineActor, { loop: "investigation", link: { parent, run: "run-1", stage: "investigate", attempt: 1, loop: "investigation", input_hash: LINK_HASH, depth: 1, floor: "TLP:GREEN", ...over } });

test("verifyLinks: a child whose first entry is not the origin recorded is not_its_child; a child whose run bound another loop version than loop_hash is version_differs", () => {
  const wb = Workbench.open(join(root, "wb"), { onError: () => {} });
  try {
    const cases = join(root, "wb", "cases");
    const same = linkedParent(wb, childOf(wb), undefined, (c) => ({ origin: c.entries(0, 1)[0]!.hash }));
    expect(verifyLinks(same.parent.dir, cases).links[0]!.status).toBe("matches");
    const other = linkedParent(wb, childOf(wb), undefined, () => ({ origin: "7".repeat(64) }));
    expect(verifyLinks(other.parent.dir, cases)).toMatchObject({ ok: false, links: [{ status: "not_its_child" }] });
    // the child's run-1 bound version "c…", and the parent recorded "b…"
    const ran = (hash: string) => (parent: string): CaseSession => {
      const c = childOf(wb)(parent);
      c.commit((_s, ids) => [
        { type: "loop.bound", actor: engineActor, payload: { loop: "investigation", version: 1, hash, lock: c.blobs.put("{}") } },
        { type: "run.started", actor: engineActor, payload: { run: ids.next("run"), pipeline: "investigation", pipeline_hash: hash, stages: linkStages } },
      ]);
      return c;
    };
    expect(verifyLinks(linkedParent(wb, ran("b".repeat(64))).parent.dir, cases).links[0]!.status).toBe("matches");
    const drifted = linkedParent(wb, ran("c".repeat(64)));
    expect(verifyLinks(drifted.parent.dir, cases)).toEqual({ ok: false, links: [{ key: "run-1/investigate/1", child: drifted.child.id, status: "version_differs" }] });
    expect(linkLines(verifyLinks(drifted.parent.dir, cases))[0]).toContain("another version of its loop");
  } finally {
    wb.close();
  }
});

test("verifyLinks: a finished child whose ledger holds the recorded head matches; a child folder removed is not_loaded and the report is ok; a child whose entry at that seq has another hash is head_differs and the report is not ok", () => {
  const wb = Workbench.open(join(root, "wb"), { onError: () => {} });
  try {
    const cases = join(root, "wb", "cases");
    const good = linkedParent(wb, childOf(wb));
    expect(verifyLinks(good.parent.dir, cases)).toEqual({ ok: true, links: [{ key: "run-1/investigate/1", child: good.child.id, status: "matches" }] });

    const differs = linkedParent(wb, childOf(wb), (c) => ({ seq: c.head().seq, hash: "0".repeat(64) }));
    expect(verifyLinks(differs.parent.dir, cases)).toEqual({ ok: false, links: [{ key: "run-1/investigate/1", child: differs.child.id, status: "head_differs" }] });
    // a head past the child's last entry differs too
    const past = linkedParent(wb, childOf(wb), (c) => ({ seq: c.head().seq + 5, hash: c.head().hash }));
    expect(verifyLinks(past.parent.dir, cases).links[0]!.status).toBe("head_differs");

    // a child whose subloop.child names another input hash is not this parent's child
    const stranger = linkedParent(wb, childOf(wb, { input_hash: "9".repeat(64) }));
    expect(verifyLinks(stranger.parent.dir, cases)).toEqual({ ok: false, links: [{ key: "run-1/investigate/1", child: stranger.child.id, status: "not_its_child" }] });

    good.child.close();
    rmSync(good.child.dir, { recursive: true, force: true });
    expect(verifyLinks(good.parent.dir, cases)).toEqual({ ok: true, links: [{ key: "run-1/investigate/1", child: good.child.id, status: "not_loaded" }] });
    // a case with no sub-loops has nothing to report
    expect(verifyLinks(dir, cases)).toEqual({ ok: true, links: [] });
  } finally {
    wb.close();
  }
});

test("the verify command prints one line per link after the case's own report", async () => {
  const wb = Workbench.open(join(root, "wb"), { onError: () => {} });
  let parentDir: string;
  let childDir: string;
  try {
    const { parent, child } = linkedParent(wb, childOf(wb));
    parentDir = parent.dir;
    childDir = child.dir;
  } finally {
    wb.close();
  }
  const out = run(parentDir).stdout.toString().split("\n").filter((l) => l !== "");
  expect(out.at(-1)).toBe("link run-1/investigate/1: CASE-2 matches");
  expect(out[0]).toMatch(/^case CASE-1: chain intact/);
  expect(run(parentDir).exitCode).toBe(0);
  rmSync(childDir, { recursive: true, force: true });
  expect(run(parentDir).stdout.toString()).toContain("link run-1/investigate/1: CASE-2 not loaded here, not checked");
  expect(run(parentDir).exitCode).toBe(0);
  // the plain case of this file has no links, and prints no link line
  expect(run(dir).stdout.toString()).not.toContain("link ");
});
