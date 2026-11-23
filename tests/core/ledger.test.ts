import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, CanonicalError } from "../../src/core/canonical";
import { GENESIS, sha256Hex } from "../../src/core/hash";
import { entryHash, Ledger, LedgerCaseMismatchError, PayloadTooLargeError } from "../../src/core/ledger";
import { strictest } from "../../src/core/types";
import type { Entry } from "../../src/core/types";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ledger-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const human = { kind: "human", id: "analyst" } as const;
const now = () => "2026-11-23T20:00:00.000Z";
const phase = (p: string) => ({ type: "case.phase_changed", payload: { phase: p }, actor: human }) as const;

function open(dir: string, opts: { now?: () => string } = { now }) {
  return Ledger.open(join(dir, "ledger.sqlite"), "CASE-1", opts);
}

test("first entry chains from genesis and seq starts at 1", () => {
  const dir = tmp();
  const l = Ledger.open(join(dir, "ledger.sqlite"), "CASE-1", { now });
  const e = l.append({ type: "case.phase_changed", payload: { phase: "collect" }, actor: human });
  expect(e.seq).toBe(1);
  expect(e.prev_hash).toBe(GENESIS);
  expect(e.case).toBe("CASE-1");
  expect(e.ts).toBe("2026-11-23T20:00:00.000Z");
  expect(e.cause).toBeNull();
  expect(e.hash).toBe(entryHash({ ...e, hash: undefined } as never));
  l.close();
});
test("each entry's prev_hash is the previous entry's hash", () => {
  const l = open(tmp());
  const e1 = l.append(phase("a"));
  const e2 = l.append(phase("b"));
  const e3 = l.append(phase("c"));
  expect(e2.prev_hash).toBe(e1.hash);
  expect(e3.prev_hash).toBe(e2.hash);
  l.close();
});
test("entryHash is sha256 of prev_hash, newline, canonical body", () => {
  const body = { seq: 1, ts: "t", case: "C", actor: human, type: "run.resumed", payload: {}, cause: null, run: null, stage: null, job: null };
  expect(entryHash({ ...body, prev_hash: GENESIS } as never)).toBe(sha256Hex(GENESIS + "\n" + canonical(body as never)));
});
test("read returns entries after a seq, ascending, and get returns one", () => {
  const l = open(tmp());
  const es = [l.append(phase("a")), l.append(phase("b")), l.append(phase("c")), l.append(phase("d"))];
  expect(l.read().map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  expect(l.read(2).map((e) => e.seq)).toEqual([3, 4]);
  expect(l.read(0, 2).map((e) => e.seq)).toEqual([1, 2]);
  expect(l.read(4)).toEqual([]);
  expect(l.get(3)).toEqual(es[2]!);
  expect(l.get(99)).toBeNull();
  l.close();
});
test("reopening the file continues the chain", () => {
  const dir = tmp();
  const l = open(dir);
  l.append(phase("a"));
  l.append(phase("b"));
  const e3 = l.append(phase("c"));
  l.close();
  const l2 = open(dir);
  expect(l2.head()).toEqual({ seq: 3, hash: e3.hash });
  const e4 = l2.append(phase("d"));
  expect(e4.seq).toBe(4);
  expect(e4.prev_hash).toBe(e3.hash);
  l2.close();
});
test("stored entries read back deep-equal to what append returned", () => {
  const l = open(tmp());
  const agent = { kind: "agent", id: "a1", stage: "s", profile: "p", model: "m", effort: null, where: "machine" } as const;
  const appended = [
    l.append({ type: "run.resumed", payload: {}, actor: human, cause: null, run: "R1", stage: "S1", job: "J1" }),
    l.append({ type: "tool.called", payload: { request: "r", call: "c", tool: "t", args: { x: [1, { y: null }], z: "é" }, why: "w" }, actor: agent, cause: 1 }),
    l.append({ type: "setting.changed", payload: { key: "k", value: { b: 1, a: 2 } }, actor: human }),
  ];
  expect(l.read()).toEqual(appended);
  appended.forEach((e) => expect(l.get(e.seq)).toEqual(e));
  l.close();
});
test("appendMany is all or nothing", () => {
  const l = open(tmp());
  l.append(phase("a"));
  const bad = { type: "setting.changed", payload: { key: "k", value: NaN }, actor: human } as const;
  expect(() => l.appendMany([phase("b"), bad])).toThrow(CanonicalError);
  expect(l.head().seq).toBe(1);
  const ok = l.appendMany([phase("b"), phase("c")]);
  expect(ok.map((e) => e.seq)).toEqual([2, 3]);
  expect(ok[1]!.prev_hash).toBe(ok[0]!.hash);
  expect(l.head()).toEqual({ seq: 3, hash: ok[1]!.hash });
  l.close();
});
test("appendMany rolls back earlier rows when a later write fails inside the transaction", () => {
  const dir = tmp();
  const l = open(dir);
  const seen: number[] = [];
  l.subscribe((e) => seen.push(e.seq));
  expect(() => l.appendMany([phase("b"), { type: "setting.changed", payload: { key: "k", value: "x".repeat(262145) }, actor: human }])).toThrow(PayloadTooLargeError);
  expect(l.head().seq).toBe(0);
  expect(seen).toEqual([]);
  l.close();
});
test("a payload JSON cannot hold is refused and nothing is written", () => {
  const l = open(tmp());
  for (const value of [undefined, new Date(), 10n]) {
    expect(() => l.append({ type: "setting.changed", payload: { key: "k", value: value as never }, actor: human })).toThrow(CanonicalError);
  }
  expect(l.head().seq).toBe(0);
  l.close();
});
test("a payload over 262144 bytes is refused", () => {
  const l = open(tmp());
  // canonical text is {"key":"k","value":"..."} so measure the whole payload text
  const overhead = Buffer.byteLength(canonical({ key: "k", value: "" }));
  const atCap = "x".repeat(262144 - overhead);
  const e = l.append({ type: "setting.changed", payload: { key: "k", value: atCap }, actor: human });
  expect(e.seq).toBe(1);
  expect(() => l.append({ type: "setting.changed", payload: { key: "k", value: atCap + "x" }, actor: human })).toThrow(PayloadTooLargeError);
  // multi-byte characters count as bytes, not characters
  expect(() => l.append({ type: "setting.changed", payload: { key: "k", value: "é".repeat(131072) }, actor: human })).toThrow(PayloadTooLargeError);
  expect(l.head().seq).toBe(1);
  l.close();
});
test("opening under a different case id is refused", () => {
  const dir = tmp();
  open(dir).close();
  expect(() => Ledger.open(join(dir, "ledger.sqlite"), "CASE-2")).toThrow(LedgerCaseMismatchError);
});
test("subscribers see committed entries in order and can unsubscribe", () => {
  const l = open(tmp());
  const seen: number[] = [];
  const headsSeen: number[] = [];
  const off = l.subscribe((e: Entry) => {
    seen.push(e.seq);
    headsSeen.push(l.head().seq); // already committed when we are told
  });
  l.append(phase("a"));
  l.appendMany([phase("b"), phase("c")]);
  expect(seen).toEqual([1, 2, 3]);
  expect(headsSeen.every((h, i) => h >= seen[i]!)).toBe(true);
  off();
  l.append(phase("d"));
  expect(seen).toEqual([1, 2, 3]);
  l.close();
});
test("two ledgers on one file never fork the chain", () => {
  const path = join(tmp(), "ledger.sqlite");
  const a = Ledger.open(path, "CASE-1"), b = Ledger.open(path, "CASE-1");
  for (let i = 0; i < 20; i++) (i % 2 ? a : b).append({ type: "run.resumed", payload: {}, actor: human });
  const all = a.read();
  expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  for (let i = 1; i < all.length; i++) expect(all[i]!.prev_hash).toBe(all[i - 1]!.hash);
  a.close();
  b.close();
});
test("a clock that moves backwards does not stop an append", () => {
  const times = ["2026-11-23T20:00:05.000Z", "2026-11-23T20:00:01.000Z"];
  let i = 0;
  const l = open(tmp(), { now: () => times[i++]! });
  const e1 = l.append(phase("a"));
  const e2 = l.append(phase("b"));
  expect(e2.seq).toBe(e1.seq + 1);
  expect(e2.ts).toBe("2026-11-23T20:00:01.000Z");
  l.close();
});
test("the file uses a rollback journal, not WAL", () => {
  const dir = tmp();
  const l = open(dir);
  l.append(phase("a"));
  const db = new Database(join(dir, "ledger.sqlite"), { readonly: true });
  expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).not.toBe("wal");
  db.close();
  l.close();
});
test("strictest picks the most restrictive marking", () => {
  expect(strictest("TLP:GREEN", "TLP:RED", "TLP:AMBER")).toBe("TLP:RED");
  expect(strictest()).toBe("TLP:CLEAR");
});
