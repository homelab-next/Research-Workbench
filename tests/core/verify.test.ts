import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../src/core/blobs";
import { GENESIS } from "../../src/core/hash";
import { Ledger } from "../../src/core/ledger";
import { formatReport, verifyCase } from "../../src/core/verify";
import type { BlobRef } from "../../src/core/types";

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
  ledger.append(phase("analyse"));
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
  expect(r).toMatchObject({ ok: true, case: "CASE-1", entries: 5, firstBad: null, blobs: { referenced: 1, missing: [], corrupt: [] } });
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
  expect(r.blobs).toEqual({ referenced: 2, missing: [ref.blob], corrupt: [other.blob] });
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

function run(...args: string[]) {
  return Bun.spawnSync(["bun", "run", "src/cli/verify.ts", ...args], { cwd: join(import.meta.dir, "../..") });
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
  rawSql(dir, `UPDATE entries SET payload = '{"phase":"edited"}' WHERE seq = 3`);
  expect(run(dir).stdout.toString()).toContain("BROKEN at entry 3 (hash_mismatch)");
});

test("formatReport shows a shortened head", () => {
  const text = formatReport(verifyCase(dir));
  expect(text).toBe(`case CASE-1: chain intact · 5 entries · head ${ledger.head().hash.slice(0, 8)}…\nblobs: 1 referenced · 0 missing · 0 corrupt`);
});
