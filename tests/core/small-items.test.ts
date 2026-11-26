// Final review, finding 25: small items.
import { afterEach, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../src/core/blobs";
import { Ledger } from "../../src/core/ledger";
import { CaseSession } from "../../src/core/session";
import { apply, applyAnalysis, applyCards, applyCase, applyPlaybooks, applyRun, fold, initial, REDUCERS } from "../../src/core/state";
import type { Entry } from "../../src/core/types";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const human = { kind: "human", id: "analyst" } as const;
const phase = (p: string) => ({ type: "case.phase_changed", payload: { phase: p }, actor: human }) as const;

test("stateAt reads only the entries up to the seq it was asked for", () => {
  const dir = mkdtempSync(join(tmpdir(), "small-"));
  dirs.push(dir);
  const ledger = Ledger.open(join(dir, "ledger.sqlite"), "CASE-1");
  const s = new CaseSession({ id: "CASE-1", dir, ledger, blobs: new BlobStore(join(dir, "blobs")), onError: () => {} });
  for (const p of ["a", "b", "c", "d", "e"]) s.commit(() => [phase(p)]);
  const read = spyOn(ledger, "read");
  expect(s.stateAt(2).phase).toBe("b");
  expect(read.mock.calls).toEqual([[0, 2]]);
  expect(s.stateAt(2)).toEqual(fold(s.entries(), 2));
  read.mockRestore();
  ledger.close();
});

test("apply never throws, even for an entry that is not an entry", () => {
  const base = initial();
  for (const bad of [null, undefined, 5, "x", []]) {
    let out: unknown;
    expect(() => { out = apply(base, bad as unknown as Entry); }).not.toThrow();
    expect(out).toBe(base);
  }
});

test("a COMMIT that fails after SQLite rolled back reports the COMMIT error, not the ROLLBACK's", () => {
  const dir = mkdtempSync(join(tmpdir(), "small-"));
  dirs.push(dir);
  const ledger = Ledger.open(join(dir, "ledger.sqlite"), "CASE-1");
  const db = (ledger as unknown as { db: Database }).db;
  const exec = db.exec.bind(db);
  const spy = spyOn(db, "exec").mockImplementation(((sql: string) => {
    if (sql === "COMMIT") {
      exec("ROLLBACK"); // what SQLite does itself on, say, a full disk
      throw new Error("disk full");
    }
    return exec(sql);
  }) as typeof db.exec);
  expect(() => ledger.append(phase("a"))).toThrow("disk full");
  spy.mockRestore();
  expect(ledger.head().seq).toBe(0);
  expect(ledger.append(phase("b")).seq).toBe(1);
  ledger.close();
});

test("state/ exports every reducer, in the order apply runs them", () => {
  expect(REDUCERS).toEqual([applyCase, applyCards, applyRun, applyAnalysis, applyPlaybooks]);
});
