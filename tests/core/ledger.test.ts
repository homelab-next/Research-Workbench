import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, CanonicalError } from "../../src/core/canonical";
import { GENESIS, sha256Hex } from "../../src/core/hash";
import { entryHash, InvalidEntryError, Ledger, LedgerCaseMismatchError, PayloadTooLargeError, UnreadableEntryError } from "../../src/core/ledger";
import { ENTRY_TYPES, isActor, strictest } from "../../src/core/types";
import { verifyLedger } from "../../src/core/verify";
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

function open(dir: string, opts: { now?: () => string; onError?: (error: unknown, entry: Entry) => void } = { now }) {
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
test("appendMany refuses an oversize payload up front and writes nothing", () => {
  const dir = tmp();
  const l = open(dir);
  const seen: number[] = [];
  l.subscribe((e) => seen.push(e.seq));
  expect(() => l.appendMany([phase("b"), { type: "setting.changed", payload: { key: "k", value: "x".repeat(262145) }, actor: human }])).toThrow(PayloadTooLargeError);
  expect(l.head().seq).toBe(0);
  expect(seen).toEqual([]);
  l.close();
});
test("a failure inside the transaction rolls back every row of the batch", () => {
  const dir = tmp();
  let calls = 0;
  const l = open(dir, {
    now: () => {
      calls += 1;
      if (calls === 3) throw new Error("clock broke");
      return now();
    },
  });
  const e1 = l.append(phase("a")); // clock call 1
  const seen: number[] = [];
  l.subscribe((e) => seen.push(e.seq));
  // clock call 2 succeeds (first row inserted), call 3 throws (second row)
  expect(() => l.appendMany([phase("b"), phase("c"), phase("d")])).toThrow("clock broke");
  expect(l.head()).toEqual({ seq: 1, hash: e1.hash });
  expect(l.read()).toEqual([e1]);
  expect(seen).toEqual([]);
  const next = l.append(phase("e"));
  expect(next.seq).toBe(2);
  expect(next.prev_hash).toBe(e1.hash);
  l.close();
});
test.each([
  ["cause", { cause: 1.5 }],
  ["cause", { cause: 0 }],
  ["cause", { cause: "1" }],
  ["run", { run: 7 }],
  ["stage", { stage: 7 }],
  ["job", { job: {} }],
])("a wrongly typed %s is refused and nothing is written", (field, extra) => {
  const l = open(tmp());
  expect(() => l.append({ ...phase("a"), ...extra } as never)).toThrow(new RegExp(`${field} must be`));
  expect(() => l.append({ ...phase("a"), ...extra } as never)).toThrow(TypeError);
  expect(l.head().seq).toBe(0);
  l.close();
});
test("a clock that returns a non-string is refused and nothing is written", () => {
  const l = open(tmp(), { now: (() => 5) as never });
  expect(() => l.append(phase("a"))).toThrow(TypeError);
  expect(l.head().seq).toBe(0);
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
test("two writer processes appending at once never fork the chain", async () => {
  const path = join(tmp(), "ledger.sqlite");
  Ledger.open(path, "CASE-1").close();
  const script = join(import.meta.dir, "..", "helpers", "ledger-writer.ts");
  const procs = [0, 1].map((i) =>
    Bun.spawn([process.execPath, script, path, "CASE-1", String(i), "50"], { stdout: "pipe", stderr: "pipe" }),
  );
  const codes = await Promise.all(procs.map((p) => p.exited));
  if (codes.some((c) => c !== 0)) {
    const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    throw new Error(`writer failed: ${errs.join("\n")}`);
  }
  const l = Ledger.open(path, "CASE-1");
  const all = l.read();
  expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
  expect(all[0]!.prev_hash).toBe(GENESIS);
  for (let i = 1; i < all.length; i++) expect(all[i]!.prev_hash).toBe(all[i - 1]!.hash);
  for (const e of all) expect(e.hash).toBe(entryHash(e));
  l.close();
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
test("a throwing subscriber reaches onError and does not fail the append or starve others", () => {
  const errors: { message: string; seq: number }[] = [];
  const l = open(tmp(), { now, onError: (err, e) => errors.push({ message: (err as Error).message, seq: e.seq }) });
  const seen: number[] = [];
  l.subscribe(() => {
    throw new Error("boom");
  });
  l.subscribe((e) => seen.push(e.seq));
  const e = l.append(phase("a"));
  expect(e.seq).toBe(1);
  expect(seen).toEqual([1]);
  expect(errors).toEqual([{ message: "boom", seq: 1 }]);
  expect(l.head().seq).toBe(1);
  l.close();
});
test("entries are delivered in seq order even when a subscriber appends", () => {
  const l = open(tmp());
  const seen: number[] = [];
  l.subscribe((e) => {
    seen.push(e.seq);
    if (e.seq === 1) l.append(phase("nested"));
  });
  l.appendMany([phase("a"), phase("b")]);
  expect(seen).toEqual([1, 2, 3]);
  l.close();
});
test("the file uses a rollback journal, and open switches a WAL file back", () => {
  const dir = tmp();
  const path = join(dir, "ledger.sqlite");
  const l = open(dir);
  l.append(phase("a"));
  l.close();
  const raw = new Database(path);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.close();
  const l2 = open(dir);
  l2.append(phase("b"));
  const db = new Database(path, { readonly: true });
  expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("delete");
  db.close();
  l2.close();
});
test("strictest picks the most restrictive marking", () => {
  expect(strictest("TLP:GREEN", "TLP:RED", "TLP:AMBER")).toBe("TLP:RED");
  expect(strictest()).toBe("TLP:CLEAR");
});

// ---------- final review, finding 1: the ledger only commits valid entries ----------

function refuses(l: Ledger, input: unknown, message?: RegExp): void {
  const before = l.head();
  expect(() => l.append(input as never)).toThrow(InvalidEntryError);
  if (message) expect(() => l.append(input as never)).toThrow(message);
  expect(l.head()).toEqual(before);
}

test("an entry type that is not a known entry type is refused", () => {
  const l = open(tmp());
  for (const type of [5, true, null, undefined, "", "nope", "case.created ", "toString", "__proto__"]) refuses(l, { ...phase("a"), type }, /type/);
  l.close();
});

test("ENTRY_TYPES lists every entry type once", () => {
  expect(new Set(ENTRY_TYPES).size).toBe(ENTRY_TYPES.length);
  expect(ENTRY_TYPES).toContain("case.created");
  expect(ENTRY_TYPES).toContain("setting.changed");
  expect(ENTRY_TYPES.length).toBe(115);
  expect(ENTRY_TYPES).toContain("review.conflict");
  expect(ENTRY_TYPES).toContain("review.ruled");
  expect(ENTRY_TYPES).toContain("route.finished");
  expect(ENTRY_TYPES).toContain("agent.ended");
  for (const t of ["case.unloaded", "case.unload_failed", "case.loaded"] as const) expect(ENTRY_TYPES).toContain(t);
  for (const t of ["case.type_set", "case.type_proposed", "memory.noted", "memory.revised", "memory.dropped", "memory.bound", "lesson.proposed", "lesson.accepted", "lesson.rejected", "lesson.retired", "memory.exported", "memory.loaded"] as const) expect(ENTRY_TYPES).toContain(t);
  for (const t of ["answer.known", "answer.withdrawn", "improve.requested", "improve.selected", "improve.task", "improve.candidate", "probe.child", "probe.started", "probe.finished", "compose.chosen", "judge.scored"] as const) expect(ENTRY_TYPES).toContain(t);
});

const agent = { kind: "agent", id: "a1", stage: "plan", profile: "p", model: "m", effort: null, where: "machine" } as const;
test("an actor that is not a well-formed Actor is refused", () => {
  const l = open(tmp());
  const bad: unknown[] = [
    null, undefined, "analyst", 5, [], {}, { kind: "root", id: "x" }, { kind: "human" }, { kind: "human", id: 5 }, { kind: "system", id: null },
    { kind: "human", id: "a", extra: 1 }, { ...agent, where: "moon" }, { ...agent, effort: 5 }, { ...agent, model: undefined },
    { kind: "agent", id: "a1" }, { ...agent, stage: 1 },
  ];
  for (const actor of bad) {
    expect(isActor(actor), JSON.stringify(actor)).toBe(false);
    refuses(l, { ...phase("a"), actor }, /actor/);
  }
  for (const actor of [human, { kind: "system", id: "s" }, agent, { ...agent, effort: "high", where: "hosted" }]) expect(isActor(actor)).toBe(true);
  l.close();
});

test("a payload that is not a plain object is refused", () => {
  const l = open(tmp());
  class Thing { phase = "a"; }
  for (const payload of ["text", [], [1], null, undefined, 5, new Date(0), new Thing()]) refuses(l, { ...phase("a"), payload }, /payload/);
  l.close();
});

test("cause must name an entry before this one, in the ledger or earlier in the batch", () => {
  const l = open(tmp());
  l.append(phase("a"));
  refuses(l, { ...phase("b"), cause: 2 }, /cause/); // would be this entry itself
  refuses(l, { ...phase("b"), cause: 9 }, /cause/);
  refuses(l, { ...phase("b"), cause: 2 ** 53 }, /cause/);
  const before = l.head();
  expect(() => l.appendMany([phase("b"), { ...phase("c"), cause: 4 }])).toThrow(InvalidEntryError);
  expect(l.head()).toEqual(before);
  const ok = l.appendMany([{ ...phase("b"), cause: 1 }, { ...phase("c"), cause: 2 }]);
  expect(ok.map((e) => e.cause)).toEqual([1, 2]);
  l.close();
});

test("ill-formed strings in ts, type, run, stage, job and the case id are refused", () => {
  const dir = tmp();
  const lone = "a\ud800";
  const l = open(dir);
  for (const field of ["run", "stage", "job"]) refuses(l, { ...phase("a"), [field]: lone }, new RegExp(field));
  refuses(l, { ...phase("a"), type: "case.phase_changed\udc00" }, /type/);
  l.close();
  const clocked = open(tmp(), { now: () => `2026-11-23T20:00:00.000Z${lone}` });
  refuses(clocked, phase("a"), /clock/);
  clocked.close();
  expect(() => Ledger.open(join(dir, "other.sqlite"), `CASE-${lone}`)).toThrow(InvalidEntryError);
});

test("everything the ledger accepted verifies", () => {
  const dir = tmp();
  const l = open(dir);
  l.append({ type: "tool.called", payload: { request: "r", call: "c", tool: "t", args: { s: "lone \ud800 in a payload is escaped", n: [1, 2.5, -0] }, why: "w" }, actor: agent, cause: null, run: "run-1", stage: "plan", job: "j1" });
  l.append({ type: "setting.changed", payload: { key: "é", value: { z: null, a: [true] } }, actor: { kind: "system", id: "s" }, cause: 1 });
  l.close();
  expect(verifyLedger(join(dir, "ledger.sqlite"), join(dir, "blobs")).ok).toBe(true);
});

test("a row that does not read back to the same hash is rolled back before commit", () => {
  const dir = tmp();
  const l = open(dir);
  const e1 = l.append(phase("a"));
  // A trigger stands in for storage that alters a value on write.
  const raw = new Database(join(dir, "ledger.sqlite"));
  raw.exec(`CREATE TRIGGER alter_payload AFTER INSERT ON entries WHEN NEW.seq = 2 BEGIN UPDATE entries SET payload = '{"phase":"x"}' WHERE seq = NEW.seq; END`);
  raw.close();
  const seen: number[] = [];
  l.subscribe((e) => seen.push(e.seq));
  expect(() => l.appendMany([phase("b"), phase("c")])).toThrow(/entry 2 would not verify \(hash_mismatch\)/);
  expect(l.head()).toEqual({ seq: 1, hash: e1.hash });
  expect(l.read()).toEqual([e1]);
  expect(seen).toEqual([]);
  l.close();
});

// ---------- final review, finding 19: a damaged row does not stop the ledger being read ----------
test("a row that cannot be parsed reads back with a null payload and is reported through onError", () => {
  const dir = tmp();
  const errors: { error: unknown; seq: number }[] = [];
  const l = open(dir, { now, onError: (error, e) => errors.push({ error, seq: e.seq }) });
  l.append(phase("a"));
  l.append(phase("b"));
  l.append(phase("c"));
  const raw = new Database(join(dir, "ledger.sqlite"));
  raw.exec(`UPDATE entries SET payload = '{' WHERE seq = 2`);
  raw.exec(`UPDATE entries SET actor = 'not json' WHERE seq = 3`);
  raw.close();
  const all = l.read();
  expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(all.map((e) => e.payload as unknown)).toEqual([{ phase: "a" }, null, null]);
  expect(all[2]!.actor).toBeNull();
  expect(errors.map((x) => x.seq)).toEqual([2, 3]);
  expect(errors[0]!.error).toBeInstanceOf(UnreadableEntryError);
  expect((errors[0]!.error as Error).message).toContain("entry 2");
  expect(l.get(2)!.payload).toBeNull();
  l.close();
});

// ---------- close-out: blob references at typed positions, and damaged rows reported once ----------
const validResult = { query: "q1", result: { blob: "a".repeat(64), bytes: 1 }, rows: 1, rows_hash: "a".repeat(64), coverage: { kind: "full" }, duration_ms: 5, cost: null } as const;
const runner = { kind: "system", id: "runner" } as const;
test("a malformed blob reference at a typed position is refused", () => {
  const l = open(tmp());
  l.append(phase("a"));
  const before = l.head().seq;
  for (const bad of [{ blob: "zz", bytes: 1 }, "text", 5, {}, [], { blob: "a".repeat(64) }]) {
    expect(() => l.append({ type: "query.result", actor: runner, payload: { ...validResult, result: bad as never } })).toThrow(TypeError);
  }
  expect(() => l.append({ type: "query.result", actor: runner, payload: { ...validResult, result: { blob: "zz", bytes: 1 } as never } })).toThrow(/query\.result.*result/);
  expect(l.head().seq).toBe(before);
  l.append({ type: "query.result", actor: runner, payload: validResult });
  expect(l.head().seq).toBe(before + 1);
  l.close();
});

test("null is allowed where the type allows it", () => {
  const l = open(tmp());
  const e = l.append({ type: "stage.finished", actor: human, payload: { stage: "plan", attempt: 1, outcome: "pass", draft_hash: "h1", output: null, reason: null } });
  expect(e.seq).toBe(1);
  l.close();
});

test("a damaged row is reported once however often it is read", () => {
  const dir = tmp();
  const errors: number[] = [];
  const l = open(dir, { now, onError: (_error, e) => errors.push(e.seq) });
  l.append(phase("a"));
  l.append(phase("b"));
  const raw = new Database(join(dir, "ledger.sqlite"));
  raw.exec(`UPDATE entries SET payload = '{' WHERE seq = 2`);
  raw.close();
  l.read();
  l.read();
  l.get(2);
  l.read();
  expect(errors).toEqual([2]);
  l.close();
});

// ---------- final review: a required blob position must hold a reference ----------
test("a required blob position that is absent or null is refused; a nullable one may be absent", () => {
  const l = open(tmp());
  const { result: _result, ...noResult } = validResult;
  expect(() => l.append({ type: "query.result", actor: runner, payload: noResult as never })).toThrow(/query\.result: result is required/);
  expect(() => l.append({ type: "query.result", actor: runner, payload: { ...validResult, result: null as never } })).toThrow(/query\.result: result must be a blob reference/);
  expect(l.head().seq).toBe(0);
  const { output: _output, ...noOutput } = { stage: "plan", attempt: 1, outcome: "pass" as const, draft_hash: "h1", output: null, reason: null };
  expect(l.append({ type: "stage.finished", actor: human, payload: noOutput as never }).seq).toBe(1);
  l.close();
});

test("check.run with no output is refused at append", () => {
  const l = open(tmp());
  const ref = { blob: "a".repeat(64), bytes: 1 };
  const payload = { check: "c", script_hash: "x", input: ref, draft_hash: "h", pass: true, findings: [] };
  expect(() => l.append({ type: "check.run", actor: runner, payload: payload as never })).toThrow(TypeError);
  expect(() => l.append({ type: "check.run", actor: runner, payload: payload as never })).toThrow(/check\.run.*output/);
  expect(() => l.append({ type: "check.run", actor: runner, payload: { ...payload, output: null } as never })).toThrow(/check\.run.*output/);
  expect(l.head().seq).toBe(0);
  l.append({ type: "check.run", actor: runner, payload: { ...payload, output: ref } });
  expect(l.head().seq).toBe(1);
  l.close();
});
