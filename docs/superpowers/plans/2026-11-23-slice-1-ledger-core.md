# Ledger Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the append-only, hash-chained ledger and everything that reads it: blob store, chain verification, the shared state fold, and the per-case session that the rest of the workbench writes through.

**Architecture:** One SQLite file per case holds a chain of entries; raw bytes live beside it in a content-addressed blob directory. Screen state is a pure fold over entries, written so the same code runs on the server and in the browser. A `CaseSession` is the only way to write: it builds entries from current state and appends them atomically.

**Tech Stack:** Bun 1.3.14, TypeScript 7 (strict), `bun:sqlite`, `bun test`. No runtime npm dependencies. Dev dependencies: `typescript`, `@types/bun`.

**Spec:** [`docs/superpowers/specs/2026-11-23-investigation-slice-design.md`](../specs/2026-11-23-investigation-slice-design.md), sections 6 and 11. Roadmap: [`2026-11-23-slice-roadmap.md`](2026-11-23-slice-roadmap.md). This is plan 1 of 5.

## Global Constraints

- **Browser-shared code:** `src/core/canonical.ts`, `src/core/types.ts` and everything under `src/core/state/` must not import `bun:*`, `node:*`, or any file that does. They are bundled for the browser in plan 4.
- **Append-only:** no code path may issue `UPDATE` or `DELETE` against the `entries` table. Tests that tamper do so with their own raw SQL.
- **Timestamps:** UTC, ISO 8601 with milliseconds, e.g. `2026-11-23T20:02:11.482Z`.
- **Hashes:** SHA-256, lowercase hex, 64 characters.
- **The fold never throws.** An entry it does not understand, or one that refers to something missing, changes nothing but `seq` and `head_ts`.
- **The fold never mutates its input.** It returns a new state, copying only what changed.
- **No secrets** in entries or blobs. **No real names:** tests use RFC 5737 addresses (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`) and `example.*` domains only.
- **TypeScript:** `strict: true`. No `any` in exported signatures.
- **Tests:** `bun test`. Every test creates its files under a fresh `mkdtempSync` directory and removes it afterwards.
- **Commits:** one per task, on the current branch, never pushed. Every commit message ends with these two lines:

  ```
  Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01D8GtDHHT7t7xiiX8BzcgNi
  ```

## Review Focus

Conditions the spec implies that are most likely to bite a real user. Each has a test in the task that owns the code.

1. **Two writers on one case file.** Two processes (or two `Ledger` objects) append to the same file. The chain must not fork: every entry gets a unique `seq`, and verification passes afterwards. (Task 2)
2. **A value JSON cannot hold.** A payload containing `undefined`, `NaN`, a `Date` or a `bigint` is refused before anything is written, and the ledger is unchanged. (Tasks 1, 2)
3. **An entry the fold does not know.** A newer writer, a damaged file or a hand-edited ledger produces an unknown entry type, or an entry naming a card or lane that does not exist. The fold does not throw. (Task 5)
4. **A failure half-way through a write.** A builder throws, or the third of five entries is invalid. Nothing is written, and the in-memory state still matches the file. (Tasks 2, 8)
5. **A case folder that has been copied or mislabelled.** Verification works on a copy with no server running; opening a ledger under the wrong case id is refused. (Tasks 2, 3)

---

### Task 1: Scaffold, canonical JSON, hashing

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `src/core/canonical.ts`, `src/core/hash.ts`
- Test: `tests/core/canonical.test.ts`, `tests/core/hash.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Json = null | boolean | number | string | Json[] | { [key: string]: Json }`
  - `class CanonicalError extends Error`
  - `canonical(value: Json): string`
  - `sha256Hex(data: string | Uint8Array): string`
  - `const GENESIS: string` (64 zeros)

- [ ] **Step 1: Create the project files**

`package.json`:

```json
{
  "name": "research-workbench",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "verify": "bun run src/cli/verify.ts"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": ["bun"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src", "tests"]
}
```

`.gitignore`:

```
node_modules/
dist/
data/
*.sqlite
*.sqlite-journal
.env*
```

Run: `bun add -d typescript @types/bun`
Expected: both installed; `bun.lock` created.

- [ ] **Step 2: Write the failing tests**

`tests/core/canonical.test.ts`:

```ts
import { expect, test } from "bun:test";
import { canonical, CanonicalError } from "../../src/core/canonical";

test("sorts keys at every depth and keeps array order", () => {
  expect(canonical({ b: 1, a: [true, null, "x", { z: 1, y: 2 }] })).toBe('{"a":[true,null,"x",{"y":2,"z":1}],"b":1}');
});
test("key order does not change the result", () => {
  expect(canonical({ a: 1, b: { d: 4, c: 3 } })).toBe(canonical({ b: { c: 3, d: 4 }, a: 1 }));
});
test("escapes strings as JSON does and keeps unicode", () => {
  expect(canonical({ s: 'a"b\né' })).toBe('{"s":"a\\"b\\né"}');
});
test("writes negative zero as 0", () => {
  expect(canonical(-0)).toBe("0");
});
test.each([
  ["undefined in object", { a: undefined }],
  ["undefined in array", [undefined]],
  ["NaN", { a: NaN }],
  ["Infinity", { a: Infinity }],
  ["Date", { a: new Date(0) }],
  ["bigint", { a: 1n }],
  ["function", { a: () => 1 }],
  ["Map", { a: new Map() }],
])("refuses %s", (_name, value) => {
  expect(() => canonical(value as never)).toThrow(CanonicalError);
});
```

`tests/core/hash.test.ts`:

```ts
import { expect, test } from "bun:test";
import { GENESIS, sha256Hex } from "../../src/core/hash";

test("hashes a known vector", () => {
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
test("hashes bytes and text the same", () => {
  expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
});
test("genesis is 64 zeros", () => {
  expect(GENESIS).toBe("0".repeat(64));
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `bun test tests/core/canonical.test.ts tests/core/hash.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 4: Implement `canonical` in `src/core/canonical.ts`**

Sort keys with the default `Array.prototype.sort()`. Emit strings with `JSON.stringify`. Accept only `null`, booleans, finite numbers, strings, arrays, and objects whose prototype is `Object.prototype` or `null`; throw `CanonicalError` naming the path (for example `$.a[0]`) for anything else. No imports.

- [ ] **Step 5: Implement `sha256Hex` and `GENESIS` in `src/core/hash.ts`**

Use `Bun.CryptoHasher("sha256")`.

- [ ] **Step 6: Run the tests and the type check**

Run: `bun test tests/core && bun run typecheck`
Expected: all pass; no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock tsconfig.json .gitignore src/core/canonical.ts src/core/hash.ts tests/core
git commit -m "feat(core): canonical JSON and hashing"
```

---

### Task 2: Shared types and the ledger

**Files:**
- Create: `src/core/types.ts`, `src/core/ledger.ts`
- Test: `tests/core/ledger.test.ts`

**Interfaces:**
- Consumes: `Json`, `canonical`, `CanonicalError` (Task 1); `sha256Hex`, `GENESIS` (Task 1).
- Produces: every type in the block below, plus:
  - `strictest(...markings: Marking[]): Marking` (returns `"TLP:CLEAR"` for no arguments)
  - `entryHash(e: Omit<Entry, "hash">): string`
  - `class Ledger` with:
    - `static open(path: string, caseId: string, opts?: { now?: () => string }): Ledger`
    - `readonly caseId: string`
    - `append(input: EntryInput): Entry`
    - `appendMany(inputs: EntryInput[]): Entry[]` (one transaction, all or nothing)
    - `read(after?: number, limit?: number): Entry[]` (entries with `seq > after`, ascending)
    - `get(seq: number): Entry | null`
    - `head(): { seq: number; hash: string }` (`{ seq: 0, hash: GENESIS }` when empty)
    - `subscribe(fn: (entry: Entry) => void): () => void` (called after commit, in order; returns unsubscribe)
    - `close(): void`
  - `class LedgerCaseMismatchError extends Error`, `class PayloadTooLargeError extends Error`

- [ ] **Step 1: Write `src/core/types.ts`**

This file is the contract for every later plan. Write it exactly as given. It has no imports except the `Json` type.

```ts
import type { Json } from "./canonical";

// ---------- primitives ----------
export type Marking = "TLP:CLEAR" | "TLP:GREEN" | "TLP:AMBER" | "TLP:AMBER+STRICT" | "TLP:RED";
/** Least to most restrictive. */
export const MARKINGS: readonly Marking[] = ["TLP:CLEAR", "TLP:GREEN", "TLP:AMBER", "TLP:AMBER+STRICT", "TLP:RED"];
export type Where = "machine" | "network" | "hosted";

export type Actor =
  | { kind: "human"; id: string }
  | { kind: "system"; id: string }
  | { kind: "agent"; id: string; stage: string; profile: string; model: string; effort: string | null; where: Where };

export interface BlobRef { blob: string; bytes: number; media?: string }
export interface Window { from: string | null; to: string | null }
export interface Observable { type: string; value: string }
export type Coverage =
  | { kind: "full" }
  | { kind: "partial"; reason: "row_limit" | "timeout" | "window_clipped" | "source_error" | "budget"; detail?: string };
export interface Cost { amount: number; unit: string }
export type EmptyMeans = "proven-negative" | "not-seen";
export type Place = "incoming" | "lane" | "discarded";
export interface ModelChoice { provider: string; model: string; effort: string | null }

// ---------- cards ----------
export interface Card {
  id: string;
  title: string;
  body: string;
  kind: "result" | "assessment" | "note";
  made_by: "agent" | "human" | "system";
  query: string | null;
  columns: string[];
  column_types: (string | null)[];
  rows: Json[][];
  row_count: number;
  coverage: Coverage | null;
  empty: EmptyMeans | null;
  marking: Marking;
  source: string | null;
  step: string | null;
  subgoal: string | null;
  why: string;
  event_time: string | null;
  quality_notes: string[];
}

// ---------- plans ----------
export type StepOutcome = "answered" | "empty" | "partial" | "blocked" | "failed";
export interface PlanStep {
  id: string; subgoal: string; pivot: string; source: string;
  from: Observable; to: string; window: Window; needs_window: boolean;
  free: boolean; weight: number; estimate: Cost | null; empty_means: EmptyMeans; warnings: string[];
}
export interface SubGoal { id: string; title: string; question: string; steps: string[] }
export interface Plan { id: string; goal: string; window: Window; subgoals: SubGoal[]; steps: PlanStep[] }

// ---------- pipeline ----------
export interface StageDef {
  id: string; title: string; phase: string | null;
  runs: "agent" | "script" | "human";
  gate: "plan" | "publish" | null;
  /** True when this stage reviews the draft and must pass before publishing. */
  reviews: boolean;
  model: ModelChoice | null;
}
export interface PackItem { kind: string; id: string; title: string; hash: string; chars: number; fixed: boolean }

// ---------- analysis ----------
export type Section = "summary" | "key_findings" | "gaps_and_limits" | "alternatives" | "assessment";
export interface Finding {
  id: string; statement: string; likelihood: string;
  confidence: "low" | "moderate" | "high"; confidence_basis: string;
  cites: string[]; assumptions: string[]; reasoning: string;
}
export interface Product {
  objective: string; question: string; marking: Marking;
  summary: string; key_findings: Finding[]; gaps_and_limits: string; alternatives: string; assessment: string;
  sources: { source: string; quality: string }[]; assumptions: string[]; change: string;
}
/** `hash` is sha256Hex(canonical(product)). */
export interface Draft { n: number; hash: string; author: Actor; product: Product; reason: string }
export interface CheckFinding { check: string; where: string; message: string }
export interface Challenge { id: string; draft_hash: string; severity: "must_address" | "consider"; text: string; cites: string[] }
export type Proposal =
  | { id: string; kind: "costly_query"; title: string; by: string; step: string | null; source: string; text: string; estimate: Cost; why: string }
  | { id: string; kind: "narrative"; title: string; by: string; section: Section; text: string; cites: string[] };

// ---------- entries ----------
export interface Payloads {
  // case and run
  "case.created": { id: string; title: string; asked: string; why: string; starting: Observable[]; window: Window; objective: string | null; marking: Marking };
  "case.phase_changed": { phase: string };
  "run.started": { run: string; pipeline: string; pipeline_hash: string; stages: StageDef[] };
  "run.paused": { reason: string };
  "run.resumed": Record<string, never>;
  "run.interrupted": Record<string, never>;
  "run.finished": { outcome: "published" | "stopped" };
  "stage.model_set": { stage: string; choice: ModelChoice };
  "stage.started": { stage: string; attempt: number };
  "stage.finished": { stage: string; attempt: number; outcome: "pass" | "fail" | "declined"; draft_hash: string | null; output: BlobRef | null; reason: string | null };
  "stage.sent_back": { from: string; to: string; reason: string; count: number };
  "gate.waiting": { gate: "plan" | "publish" };
  "gate.passed": { gate: "plan" | "publish" };
  "budget.set": { tokens: number | null };
  "job.started": { job: string; title: string; kind: "research" | "query" | "model" | "check"; source: string | null };
  "job.finished": { job: string; outcome: "done" | "failed" };
  // plans
  "plan.proposed": { plan: Plan };
  "plan.accepted": { plan: string; steps: string[]; budgets: Record<string, number> };
  "plan.denied": { plan: string; reason: string };
  "plan.replan_requested": { plan: string; note: string };
  "step.started": { step: string };
  "step.finished": { step: string; outcome: StepOutcome; cards: string[]; note: string };
  // queries
  "query.issued": { query: string; source: string; source_hash: string; pivot: string | null; pivot_hash: string | null; connector: string; text: string; bound: Record<string, Json>; window: Window; why: string; estimate: Cost | null; step: string | null; verifies: string | null };
  "query.result": { query: string; result: BlobRef; rows: number; rows_hash: string; coverage: Coverage; duration_ms: number; cost: Cost | null };
  "query.failed": { query: string; error: string };
  "verify.run": { original: string; rerun: string; card: string; outcome: "matches" | "differs" | "could_not_run"; detail: string };
  // models
  "model.request": { request: string; provider: string; model: string; effort: string | null; where: Where; marking: Marking; pack: PackItem[]; left_out: PackItem[]; messages: BlobRef; tools: string[] };
  "model.response": { request: string; response: BlobRef; stop: "end" | "tool_calls" | "length" | "error"; usage: { input: number; output: number; reasoning: number }; served_by: string; reasoning: BlobRef | null };
  "model.declined": { request: string; reason: string };
  "model.blocked": { stage: string; marking: Marking; model: string; where: Where };
  "tool.called": { request: string; call: string; tool: string; args: Json; why: string };
  "tool.returned": { call: string; ok: boolean; summary: string; result: BlobRef | null };
  // cards and lanes
  "card.created": { card: Card };
  "card.kept": { card: string; lane: string; index: number | null };
  "card.moved": { card: string; lane: string; index: number };
  "card.discarded": { card: string };
  "card.restored": { card: string };
  "card.sent_back": { card: string };
  "card.pinned": { card: string; pinned: boolean };
  "lane.created": { lane: string; title: string; subgoal: string | null };
  "lane.renamed": { lane: string; title: string };
  "lane.removed": { lane: string };
  "lane.target_set": { lane: string };
  "undo": { target: number; card: string; place: Place; lane: string | null; index: number | null };
  // proposals
  "proposal.created": { proposal: Proposal };
  "proposal.accepted": { proposal: string; budget: number | null };
  "proposal.rejected": { proposal: string; reason: string };
  // analysis
  "assessment.made": { finding: Finding; draft_hash: string };
  "research.requested": { question: string; why: string };
  "draft.revised": { draft: Draft };
  "check.run": { check: string; script_hash: string; input: BlobRef; draft_hash: string; pass: boolean; findings: CheckFinding[] };
  "evaluation.made": { draft_hash: string; pass: boolean; findings: CheckFinding[] };
  "challenge.raised": { challenge: Challenge };
  "challenge.answered": { challenge: string; answer: string; action: "revised" | "rebutted" };
  // product and feedback
  "publish.rejected": { draft_hash: string; reason: string; stop: boolean };
  "product.published": { n: number; draft_hash: string; head_hash: string; dir: string; bundle: BlobRef };
  "feedback.recorded": { measure: string; kind: "mop" | "moe"; value: number | string; note: string };
  // your agent (the Agent lens)
  "agent.asked": { turn: string; text: string; left_out: string[]; added: string[] };
  "agent.answered": { turn: string; request: string; text: string; cites: string[] };
  // workbench chain
  "module.loaded": { kind: string; id: string; hash: string; root: string; path: string };
  "module.rejected": { root: string; path: string; error: string };
  "setting.changed": { key: string; value: Json };
}
export type EntryType = keyof Payloads;

export type EntryInput = {
  [T in EntryType]: { type: T; payload: Payloads[T]; actor: Actor; cause?: number | null; run?: string | null; stage?: string | null; job?: string | null };
}[EntryType];

export type Entry = {
  [T in EntryType]: {
    seq: number; ts: string; case: string; actor: Actor; type: T; payload: Payloads[T];
    cause: number | null; run: string | null; stage: string | null; job: string | null;
    prev_hash: string; hash: string;
  };
}[EntryType];
```

Then add the one runtime export at the end of the file:

```ts
export function strictest(...markings: Marking[]): Marking
```

It returns the argument that appears latest in `MARKINGS`, or `"TLP:CLEAR"` when called with none.

- [ ] **Step 2: Write the failing tests**

`tests/core/ledger.test.ts`. Use a helper `tmp()` that returns a fresh temp directory and registers cleanup in `afterEach`. Use `const human = { kind: "human", id: "analyst" } as const` and a fixed clock `now: () => "2026-11-23T20:00:00.000Z"` unless a test says otherwise.

```ts
test("first entry chains from genesis and seq starts at 1", () => {
  const l = Ledger.open(join(dir, "ledger.sqlite"), "CASE-1", { now });
  const e = l.append({ type: "case.phase_changed", payload: { phase: "collect" }, actor: human });
  expect(e.seq).toBe(1);
  expect(e.prev_hash).toBe(GENESIS);
  expect(e.case).toBe("CASE-1");
  expect(e.ts).toBe("2026-11-23T20:00:00.000Z");
  expect(e.cause).toBeNull();
  expect(e.hash).toBe(entryHash({ ...e, hash: undefined } as never));
});
test("each entry's prev_hash is the previous entry's hash", ...);          // append 3; e2.prev_hash === e1.hash; e3.prev_hash === e2.hash
test("entryHash is sha256 of prev_hash, newline, canonical body", () => {
  const body = { seq: 1, ts: "t", case: "C", actor: human, type: "run.resumed", payload: {}, cause: null, run: null, stage: null, job: null };
  expect(entryHash({ ...body, prev_hash: GENESIS } as never)).toBe(sha256Hex(GENESIS + "\n" + canonical(body as never)));
});
test("read returns entries after a seq, ascending, and get returns one", ...);
test("reopening the file continues the chain", ...);                        // close, open again, append: seq is 4, prev_hash is e3.hash
test("stored entries read back deep-equal to what append returned", ...);
test("appendMany is all or nothing", () => {
  // second input has a payload with NaN: expect CanonicalError, and head().seq unchanged
});
test("a payload JSON cannot hold is refused and nothing is written", ...);  // undefined, Date, bigint each throw CanonicalError; head().seq === 0
test("a payload over 262144 bytes is refused", ...);                        // PayloadTooLargeError
test("opening under a different case id is refused", ...);                  // LedgerCaseMismatchError
test("subscribers see committed entries in order and can unsubscribe", ...);
test("two ledgers on one file never fork the chain", () => {
  const a = Ledger.open(path, "CASE-1"), b = Ledger.open(path, "CASE-1");
  for (let i = 0; i < 20; i++) (i % 2 ? a : b).append({ type: "run.resumed", payload: {}, actor: human });
  const all = a.read();
  expect(all.map(e => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  for (let i = 1; i < all.length; i++) expect(all[i].prev_hash).toBe(all[i - 1].hash);
});
test("a clock that moves backwards does not stop an append", ...);          // seq still increases
test("strictest picks the most restrictive marking", () => {
  expect(strictest("TLP:GREEN", "TLP:RED", "TLP:AMBER")).toBe("TLP:RED");
  expect(strictest()).toBe("TLP:CLEAR");
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `bun test tests/core/ledger.test.ts`
Expected: FAIL, `Ledger` not found.

- [ ] **Step 4: Implement `Ledger` in `src/core/ledger.ts`**

Schema:

```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries (
  seq INTEGER PRIMARY KEY, ts TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
  cause INTEGER, run TEXT, stage TEXT, job TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
```

- `meta` holds `case_id`. `open` writes it on first use and throws `LedgerCaseMismatchError` if it differs.
- `actor` and `payload` are stored as canonical JSON text.
- `entryHash` is `sha256Hex(prev_hash + "\n" + canonical({ seq, ts, case, actor, type, payload, cause, run, stage, job }))`. Missing optional fields are `null`.
- Every append runs inside `BEGIN IMMEDIATE`, and reads the head inside that transaction. This is what keeps two writers from forking the chain.
- Canonicalise every input before the transaction starts, so a bad payload throws before anything is written.
- Use the default rollback journal (not WAL), and `PRAGMA synchronous = FULL`, so a case is one file.
- The default clock is `() => new Date().toISOString()`.
- Notify subscribers after the transaction commits.

- [ ] **Step 5: Run the tests and the type check**

Run: `bun test tests/core && bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/ledger.ts tests/core/ledger.test.ts
git commit -m "feat(core): shared types and the append-only ledger"
```

---

### Task 3: Blob store, chain verification, `verify` command

**Files:**
- Create: `src/core/blobs.ts`, `src/core/verify.ts`, `src/cli/verify.ts`
- Test: `tests/core/blobs.test.ts`, `tests/core/verify.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `entryHash` (Task 2); `BlobRef`, `Json` types; `sha256Hex`, `GENESIS`, `canonical`.
- Produces:
  - `class BlobStore` with:
    - `constructor(dir: string)` (creates the directory)
    - `put(data: Uint8Array | string, media?: string): BlobRef`
    - `get(hash: string): Uint8Array` (throws `BlobMissingError`)
    - `text(hash: string): string`
    - `has(hash: string): boolean`
    - `check(hash: string): "ok" | "missing" | "corrupt"`
  - `class BlobMissingError extends Error`
  - `isBlobRef(v: unknown): v is BlobRef` (an object with `blob` matching `/^[0-9a-f]{64}$/` and a numeric `bytes`)
  - `collectBlobRefs(v: Json): BlobRef[]` (deep scan)
  - `interface VerifyReport { ok: boolean; case: string; entries: number; head: string; firstBad: null | { seq: number; reason: "seq_gap" | "prev_hash_mismatch" | "bad_json" | "hash_mismatch" }; blobs: { referenced: number; missing: string[]; corrupt: string[] } }`
  - `verifyLedger(ledgerPath: string, blobDir: string): VerifyReport`
  - `verifyCase(caseDir: string): VerifyReport` (uses `<caseDir>/ledger.sqlite` and `<caseDir>/blobs`)
  - `formatReport(r: VerifyReport): string`
  - Command: `bun run src/cli/verify.ts <case-dir>`; exit 0 intact, 1 broken, 2 usage error.

- [ ] **Step 1: Write the failing tests**

`tests/core/blobs.test.ts`:

```ts
test("put names a blob by its sha256 and records its size", () => {
  const ref = store.put("abc", "text/plain");
  expect(ref).toEqual({ blob: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", bytes: 3, media: "text/plain" });
  expect(store.text(ref.blob)).toBe("abc");
});
test("putting the same bytes twice is harmless", ...);              // same ref, one file
test("get of an unknown hash throws BlobMissingError", ...);
test("check reports ok, missing and corrupt", ...);                 // overwrite the file on disk to get "corrupt"
test("collectBlobRefs finds refs at any depth and ignores look-alikes", () => {
  const ref = store.put("x");
  expect(collectBlobRefs({ a: [{ b: ref }], c: { blob: "nope", bytes: 1 } })).toEqual([ref]);
});
```

`tests/core/verify.test.ts`. Build a case directory by hand: a `Ledger` at `<dir>/ledger.sqlite`, a `BlobStore` at `<dir>/blobs`, five entries, one of them a `query.result` whose `result` is a real blob ref.

```ts
test("a clean case verifies", () => {
  const r = verifyCase(dir);
  expect(r).toMatchObject({ ok: true, case: "CASE-1", entries: 5, firstBad: null, blobs: { referenced: 1, missing: [], corrupt: [] } });
  expect(r.head).toBe(ledger.head().hash);
});
test("an edited payload is caught at that entry", () => {
  rawSql(dir, `UPDATE entries SET payload = '{"phase":"edited"}' WHERE seq = 3`);
  expect(verifyCase(dir)).toMatchObject({ ok: false, firstBad: { seq: 3, reason: "hash_mismatch" } });
});
test("an edited timestamp is caught", ...);                          // UPDATE ts WHERE seq = 2 -> { seq: 2, reason: "hash_mismatch" }
test("a deleted entry is caught as a gap", ...);                     // DELETE seq = 2 -> { seq: 3, reason: "seq_gap" }
test("a re-linked chain is caught", ...);                            // UPDATE prev_hash WHERE seq = 4 -> { seq: 4, reason: "prev_hash_mismatch" }
test("unparseable JSON is caught", ...);                             // payload = '{' -> reason "bad_json"
test("a missing blob and a corrupt blob are reported", ...);         // ok false, lists the hashes
test("verification works on a copy of the folder", () => {
  cpSync(dir, copy, { recursive: true });
  expect(verifyCase(copy).ok).toBe(true);
});
test("an empty ledger verifies with zero entries", ...);             // head is GENESIS
test("the command exits 0 for intact, 1 for broken, 2 with no argument", ...);  // Bun.spawnSync(["bun", "run", "src/cli/verify.ts", dir])
test("the command prints the entry count and the failing entry", ...);          // stdout contains "chain intact · 5 entries" / "BROKEN at entry 3 (hash_mismatch)"
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/core/blobs.test.ts tests/core/verify.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `BlobStore` in `src/core/blobs.ts`**

Files are `<dir>/<hash>`. Write to a temporary name in the same directory, then rename, so a crash never leaves a half-written blob under its final name.

- [ ] **Step 4: Implement `verifyLedger`, `verifyCase`, `formatReport` in `src/core/verify.ts`**

Open the SQLite file read-only and read the raw columns; do not go through `Ledger`. Walk rows in `seq` order and stop at the first failure, checking in this order: `seq` is previous + 1 (`seq_gap`); `prev_hash` equals the previous row's `hash`, or `GENESIS` for the first (`prev_hash_mismatch`); `actor` and `payload` parse (`bad_json`); the recomputed `entryHash` equals `hash` (`hash_mismatch`). Take the case id from `meta`. Then check every blob ref found in every payload. `ok` is true only when `firstBad` is null and no blob is missing or corrupt.

`formatReport` output, two lines:

```
case CASE-1: chain intact · 5 entries · head 9f3c2a1b…
blobs: 1 referenced · 0 missing · 0 corrupt
```

or, when broken, the first line is `case CASE-1: BROKEN at entry 3 (hash_mismatch)`. The head is shown as its first 8 characters followed by `…`.

- [ ] **Step 5: Implement the command in `src/cli/verify.ts`**

Print `formatReport` to stdout. With no argument, or a directory with no `ledger.sqlite`, print a usage line to stderr and exit 2.

- [ ] **Step 6: Run the tests and the type check**

Run: `bun test tests/core && bun run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/blobs.ts src/core/verify.ts src/cli/verify.ts tests/core/blobs.test.ts tests/core/verify.test.ts
git commit -m "feat(core): blob store, chain verification and verify command"
```

---

### Task 4: JSON Schema validator

Stage outputs, the product, tool inputs and manifests are all checked against schemas. This is the one validator they share.

**Files:**
- Create: `src/core/schema.ts`
- Test: `tests/core/schema.test.ts`

**Interfaces:**
- Consumes: nothing. This file must stay browser-safe (no `bun:*` or `node:*` imports).
- Produces:
  - `interface Schema` with optional keys: `type` (one of `"object" | "array" | "string" | "number" | "integer" | "boolean" | "null"`, or an array of them), `enum`, `const`, `properties`, `required`, `additionalProperties` (boolean or `Schema`), `items`, `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, `pattern`, `anyOf`, plus `title` and `description` (ignored)
  - `interface SchemaError { path: string; message: string }`
  - `validate(schema: Schema, value: unknown): SchemaError[]` (empty means valid)
  - `class UnsupportedSchemaError extends Error` (thrown for `$ref`, `allOf`, `oneOf`, `not`, `if`)

- [ ] **Step 1: Write the failing tests**

`tests/core/schema.test.ts`:

```ts
const finding: Schema = {
  type: "object", additionalProperties: false, required: ["statement", "likelihood", "cites"],
  properties: {
    statement: { type: "string", minLength: 1 },
    likelihood: { enum: ["likely", "unlikely"] },
    cites: { type: "array", minItems: 1, items: { type: "string", pattern: "^c[0-9]+$" } },
    weight: { type: ["number", "null"], minimum: 0, maximum: 1 },
  },
};
test("a valid value has no errors", () => {
  expect(validate(finding, { statement: "x", likelihood: "likely", cites: ["c1"] })).toEqual([]);
});
test("reports every problem with its path", () => {
  const errs = validate(finding, { statement: "", likelihood: "maybe", cites: ["c1", "zz"], extra: 1, weight: 2 });
  expect(errs.map(e => e.path).sort()).toEqual(["$.cites[1]", "$.extra", "$.likelihood", "$.statement", "$.weight"]);
});
test("reports a missing required property at the parent path", () => {
  expect(validate(finding, { statement: "x", likelihood: "likely" })).toEqual([{ path: "$", message: "missing required property: cites" }]);
});
test("integer rejects 1.5 and accepts 2", ...);
test("null is its own type, not an object", ...);
test("arrays are not objects", ...);
test("const and anyOf work", ...);
test("additionalProperties as a schema validates the extra values", ...);
test("unsupported keywords throw UnsupportedSchemaError", () => {
  expect(() => validate({ $ref: "#/x" } as never, 1)).toThrow(UnsupportedSchemaError);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/core/schema.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `validate` in `src/core/schema.ts`**

Paths start at `$`, use `.name` for properties and `[i]` for items. Collect all errors; do not stop at the first. Messages are short plain sentences; only the "missing required property: <name>" wording is fixed by the tests.

- [ ] **Step 4: Run the tests and the type check**

Run: `bun test tests/core && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/schema.ts tests/core/schema.test.ts
git commit -m "feat(core): JSON Schema validator"
```

---

### Task 5: State fold: case, cards, lanes, undo

**Files:**
- Create: `src/core/state/types.ts`, `src/core/state/cards.ts`, `src/core/state/apply.ts`, `src/core/state/index.ts`
- Create: `tests/helpers/entries.ts`
- Test: `tests/core/state-cards.test.ts`

**Interfaces:**
- Consumes: `Entry`, `Payloads`, `Card`, `Place` and the other types from `src/core/types.ts`.
- Produces (from `src/core/state/index.ts`):
  - `initial(): CaseState`
  - `apply(state: CaseState, entry: Entry): CaseState`
  - `fold(entries: Entry[], upTo?: number): CaseState` (applies entries with `seq <= upTo`; all when omitted)
  - `cardLocation(state: CaseState, card: string): { place: Place; lane: string | null; index: number } | null`
  - the `CaseState` type and its parts, below
  - `type IdKind` and `const ID_PREFIX: Record<IdKind, string>`
- Produces (test helper, `tests/helpers/entries.ts`):
  - `class EntryBuilder { constructor(caseId?: string); add<T extends EntryType>(type: T, payload: Payloads[T], extra?: Partial<Pick<Entry, "actor" | "cause" | "run" | "stage" | "job" | "ts">>): Entry; readonly entries: Entry[] }` — numbers entries from 1, fills `ts` with `2026-11-23T20:00:00.000Z` plus one second per entry, and uses placeholder hashes.
  - `card(id: string, over?: Partial<Card>): Card` — a complete card with sensible defaults.

- [ ] **Step 1: Write `src/core/state/types.ts`**

The whole `CaseState` is defined here, including the parts Tasks 6 and 7 fill in, so the shape is fixed once.

```ts
import type {
  Actor, BlobRef, Card, Challenge, CheckFinding, Coverage, Draft, ModelChoice, Payloads,
  Place, Plan, Proposal, StageDef, StepOutcome, Window,
} from "../types";

export type IdKind = "card" | "lane" | "query" | "job" | "proposal" | "challenge" | "request" | "call" | "turn" | "run" | "plan";
export const ID_PREFIX: Record<IdKind, string> = {
  card: "c", lane: "l", query: "q", job: "j", proposal: "p", challenge: "x",
  request: "r", call: "t", turn: "u", run: "run-", plan: "plan-",
};

export interface CardState extends Card {
  place: Place;
  lane: string | null;
  pinned: boolean;
  created_seq: number;
  created_ts: string;
  validated: null | { outcome: "matches" | "differs" | "could_not_run"; detail: string; seq: number; ts: string };
}
export interface LaneState { id: string; title: string; subgoal: string | null; cards: string[] }
export interface UndoItem { seq: number; card: string; place: Place; lane: string | null; index: number | null }

export interface StageState extends StageDef {
  status: "idle" | "running" | "passed" | "failed" | "waiting" | "declined" | "blocked";
  attempts: number;
  last_reason: string | null;
}
export interface RunState {
  id: string | null;
  status: "none" | "running" | "paused" | "waiting" | "interrupted" | "finished";
  outcome: "published" | "stopped" | null;
  pause_reason: string | null;
  waiting: "plan" | "publish" | null;
  stages: StageState[];
  current: string | null;
  /** Keyed "from>to". */
  sendbacks: Record<string, number>;
  usage: { input: number; output: number; reasoning: number };
  model_calls: number;
  budget_tokens: number | null;
}
export interface PlanState {
  current: Plan | null;
  status: "none" | "proposed" | "accepted" | "denied" | "replanning";
  accepted_steps: string[];
  budgets: Record<string, number>;
  steps: Record<string, { status: "pending" | "running" | StepOutcome; cards: string[]; note: string }>;
}
export interface JobState {
  id: string; title: string; kind: "research" | "query" | "model" | "check"; source: string | null;
  status: "running" | "done" | "failed"; started_ts: string; ended_ts: string | null;
}
export interface QueryState {
  id: string; source: string; text: string; why: string; window: Window; by: Actor;
  step: string | null; verifies: string | null;
  issued_seq: number; issued_ts: string;
  status: "running" | "done" | "failed";
  rows: number | null; rows_hash: string | null; coverage: Coverage | null; result: BlobRef | null;
  error: string | null; card: string | null;
}
export type ProposalState = Proposal & { status: "open" | "accepted" | "rejected"; seq: number; budget: number | null; reason: string | null };
export interface ReviewState {
  checks: { check: string; pass: boolean; findings: CheckFinding[] }[];
  evaluation: { pass: boolean; findings: CheckFinding[] } | null;
  challenges: string[];
  /** Ids of stages that finished with outcome "pass" for this draft hash. */
  passed_stages: string[];
}
export type ChallengeState = Challenge & { status: "open" | "answered"; answer: string | null; action: "revised" | "rebutted" | null };

export interface CaseState {
  seq: number;
  head_ts: string | null;
  meta: Payloads["case.created"] | null;
  phase: string | null;
  counters: Record<IdKind, number>;
  // cards and lanes (Task 5)
  cards: Record<string, CardState>;
  incoming: string[];
  lanes: LaneState[];
  target: string | null;
  discarded: string[];
  undoable: UndoItem[];
  // run (Task 6)
  stage_models: Record<string, ModelChoice>;
  run: RunState;
  plan: PlanState;
  jobs: Record<string, JobState>;
  queries: Record<string, QueryState>;
  proposals: Record<string, ProposalState>;
  // analysis (Task 7)
  drafts: Draft[];
  reviews: Record<string, ReviewState>;
  challenges: Record<string, ChallengeState>;
  published: { n: number; draft_hash: string; head_hash: string; dir: string; seq: number; ts: string }[];
  feedback: Payloads["feedback.recorded"][];
  conversation: { turn: string; asked: string; answer: string | null; cites: string[]; request: string | null }[];
}
```

- [ ] **Step 2: Write the test helper `tests/helpers/entries.ts`**

As described under Interfaces. The default actor is `{ kind: "system", id: "test" }`.

- [ ] **Step 3: Write the failing tests**

`tests/core/state-cards.test.ts`:

```ts
test("initial state is empty and at seq 0", () => {
  const s = initial();
  expect(s).toMatchObject({ seq: 0, head_ts: null, meta: null, incoming: [], lanes: [], target: null, discarded: [], undoable: [] });
  expect(s.counters.card).toBe(0);
});
test("case.created sets meta", ...);
test("every entry advances seq and head_ts, known or not", () => {
  const b = new EntryBuilder();
  const e = b.add("setting.changed", { key: "k", value: 1 });
  expect(apply(initial(), e)).toMatchObject({ seq: 1, head_ts: e.ts });
});
test("a new card arrives in Incoming and bumps the card counter", () => {
  const s = fold(new EntryBuilder().also(b => b.add("card.created", { card: card("c1") })).entries);
  expect(s.incoming).toEqual(["c1"]);
  expect(s.cards.c1).toMatchObject({ place: "incoming", lane: null, pinned: false, created_seq: 1, validated: null });
  expect(s.counters.card).toBe(1);
});
test("the first lane created becomes the keep target", ...);              // target === "l1"; a second lane does not change it
test("keep moves a card from Incoming to the end of a lane", ...);
test("keep with an index inserts at that position", ...);
test("move reorders within a lane and moves across lanes", ...);
test("discard moves a card to Discarded from Incoming or from a lane", ...);
test("restore returns a discarded card to Incoming", ...);
test("send back returns a kept card to Incoming", ...);
test("pin and unpin", ...);
test("rename, remove and retarget lanes", ...);                           // removing the target lane sets target to the first remaining lane, or null
test("keep, move, discard and send back are undoable, newest last", () => {
  // after keep (seq 3) then discard (seq 4): undoable is
  // [{ seq: 3, card: "c1", place: "incoming", lane: null, index: 0 }, { seq: 4, card: "c1", place: "lane", lane: "l1", index: 0 }]
});
test("undo puts the card back where the payload says and drops the item", () => {
  // undo { target: 4, card: "c1", place: "lane", lane: "l1", index: 0 } -> card is in l1 at 0; undoable has only seq 3
});
test("undo into a lane that no longer exists puts the card in Incoming", ...);
test("the undo stack holds at most 50 items", ...);
test("cardLocation finds a card in each place and returns null when unknown", ...);
test("entries naming a missing card or lane change only seq", () => {
  const b = new EntryBuilder();
  b.add("card.kept", { card: "nope", lane: "l9", index: null });
  b.add("card.moved", { card: "nope", lane: "l9", index: 0 });
  b.add("lane.renamed", { lane: "l9", title: "x" });
  b.add("undo", { target: 99, card: "nope", place: "incoming", lane: null, index: null });
  const s = fold(b.entries);
  expect({ ...s, seq: 0, head_ts: null }).toEqual(initial());
});
test("an unknown entry type does not throw", () => {
  const e = { ...new EntryBuilder().add("run.resumed", {}), type: "future.thing" } as never;
  expect(() => apply(initial(), e)).not.toThrow();
});
test("apply never mutates the state it is given", () => {
  // deep-freeze the state before each apply across a 12-entry sequence covering every type above; no throw
});
test("fold with upTo stops at that seq", ...);
test("folding 5000 entries over 500 cards takes under one second", ...);
```

`EntryBuilder.also(fn)` is a small convenience that calls `fn(this)` and returns `this`; add it to the helper.

- [ ] **Step 4: Run the tests to see them fail**

Run: `bun test tests/core/state-cards.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 5: Implement the fold**

- `src/core/state/index.ts`: `initial`, `fold`, and re-exports.
- `src/core/state/apply.ts`: `apply` sets `seq` and `head_ts`, bumps the counter for the entry's kind, then hands the entry to each area's reducer. Wrap nothing in try/catch: reducers are written so they cannot throw on missing references.
- `src/core/state/cards.ts`: `applyCards(state, entry): CaseState` and `cardLocation`.

Counter bumps: `card.created` → `card`; `lane.created` → `lane`; `query.issued` → `query`; `job.started` → `job`; `proposal.created` → `proposal`; `challenge.raised` → `challenge`; `model.request` → `request`; `tool.called` → `call`; `agent.asked` → `turn`; `run.started` → `run`; `plan.proposed` → `plan`.

Copy on write: clone the top-level object and only the branches an entry touches. Do not `structuredClone` the whole state per entry; the 5000-entry test would not pass.

Before applying `card.kept`, `card.moved`, `card.discarded` or `card.sent_back`, push an `UndoItem` holding the card's location before the change. `card.restored` and `card.pinned` are not undoable.

- [ ] **Step 6: Run the tests and the type check**

Run: `bun test tests/core && bun run typecheck`
Expected: all pass.

- [ ] **Step 7: Check the browser-safety constraint**

Run: `grep -rnE "from ['\"](bun|node):" src/core/state src/core/types.ts src/core/canonical.ts src/core/schema.ts; echo "exit $?"`
Expected: no lines printed, `exit 1`.

- [ ] **Step 8: Commit**

```bash
git add src/core/state tests/helpers/entries.ts tests/core/state-cards.test.ts
git commit -m "feat(core): state fold for case, cards, lanes and undo"
```

---

### Task 6: State fold: run, plan, queries, jobs, proposals

**Files:**
- Create: `src/core/state/run.ts`
- Modify: `src/core/state/apply.ts` (call the new reducer)
- Test: `tests/core/state-run.test.ts`

**Interfaces:**
- Consumes: `CaseState` and its parts (Task 5); `EntryBuilder`, `card` (Task 5 helper).
- Produces: `applyRun(state: CaseState, entry: Entry): CaseState`. No new exports from `index.ts`.

- [ ] **Step 1: Write the failing tests**

`tests/core/state-run.test.ts`. Define two stage definitions for reuse:

```ts
const stages: StageDef[] = [
  { id: "plan", title: "Plan", phase: "direct", runs: "agent", gate: "plan", reviews: false, model: { provider: "scripted", model: "m", effort: null } },
  { id: "checks", title: "Checks", phase: "produce", runs: "script", gate: null, reviews: true, model: null },
];
```

```ts
test("run.started lists the stages as idle", () => {
  // run: { id: "run-1", status: "running", waiting: null, current: null, outcome: null }, stages[0].status "idle", attempts 0
});
test("a model chosen before the run starts is used when it starts", () => {
  // stage.model_set { stage: "plan", choice: X } then run.started -> run.stages[0].model equals X, and stage_models.plan equals X
});
test("a model chosen during the run updates the stage", ...);
test("stage.started marks the stage running and current", ...);        // attempts equals the entry's attempt
test("stage.finished maps pass, fail and declined to passed, failed and declined", ...);   // last_reason is the entry's reason
test("stage.sent_back records the count and resets the target stage to idle", () => {
  // { from: "checks", to: "plan", reason: "r", count: 2 } -> run.sendbacks["checks>plan"] === 2; stage plan status "idle"
});
test("gate.waiting puts the run and the gated stage in waiting; gate.passed clears it", ...);
test("pause, resume, interrupted and finished set the run status", ...);   // paused keeps pause_reason; finished keeps outcome
test("model.response adds usage and counts the call", ...);                // two responses sum input/output/reasoning; model_calls 2
test("model.blocked marks that stage blocked", ...);
test("budget.set sets the token budget", ...);
test("jobs start running and finish done or failed with an end time", ...);
test("plan.proposed sets the plan with every step pending", ...);
test("plan.accepted records the accepted steps and budgets", ...);
test("plan.denied and plan.replan_requested set the status", ...);         // "denied", "replanning"
test("a newer proposed plan replaces the old one", ...);
test("step.started and step.finished track each step", ...);               // status "running" then the outcome; cards and note kept
test("query.issued then query.result fills the query", () => {
  // status "running" -> "done"; rows, rows_hash, coverage, result set; by equals the issuing entry's actor; issued_seq set
});
test("query.failed records the error", ...);
test("a result card links back to its query", ...);                        // card.created with card.query "q1" sets queries.q1.card
test("verify.run stamps the card as validated", ...);                      // cards.c1.validated = { outcome, detail, seq, ts }
test("proposals open, then are accepted with a budget or rejected with a reason", ...);
test("case.phase_changed sets the phase", ...);
test("run entries before any run.started change only seq", ...);
test("apply never mutates the state it is given", ...);                    // deep-freeze across a sequence of every type above
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/core/state-run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `applyRun` in `src/core/state/run.ts` and call it from `apply`**

Rules the tests do not spell out:

- `run.started` builds each `StageState` from its `StageDef`, with `model` taken from `stage_models[id]` when present.
- `stage.started` also sets the run status to `"running"` unless it is `"paused"`.
- `gate.waiting` finds the stage whose `gate` matches.
- A second `run.started` replaces the run (a case has one run at a time).
- `model.blocked` and `stage.*` entries for an unknown stage change nothing.

- [ ] **Step 4: Run the tests and the type check**

Run: `bun test tests/core && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/state/run.ts src/core/state/apply.ts tests/core/state-run.test.ts
git commit -m "feat(core): state fold for run, plan, queries, jobs and proposals"
```

---

### Task 7: State fold: drafts, reviews, challenges, publishing, feedback, conversation

**Files:**
- Create: `src/core/state/analysis.ts`
- Modify: `src/core/state/apply.ts`, `src/core/state/index.ts`
- Test: `tests/core/state-analysis.test.ts`

**Interfaces:**
- Consumes: `CaseState` (Task 5); the run state from Task 6.
- Produces (exported from `src/core/state/index.ts`):
  - `applyAnalysis(state: CaseState, entry: Entry): CaseState`
  - `latestDraft(state: CaseState): Draft | null`
  - `publishable(state: CaseState, draftHash: string): boolean`
  - `blockers(state: CaseState, draftHash: string): string[]` — the plain-language reasons `publishable` is false; empty when it is true

- [ ] **Step 1: Write the failing tests**

`tests/core/state-analysis.test.ts`. Use a helper `draft(n, hash)` that builds a `Draft` with a minimal valid `Product`. Start each publishing test from a run whose stages are `assemble` (`reviews: false`), then `checks`, `evaluate`, `challenge` (all `reviews: true`), then `publish` (`gate: "publish"`, `reviews: false`).

```ts
test("draft.revised appends a revision and opens its review record", () => {
  // drafts.length 1; reviews.h1 equals { checks: [], evaluation: null, challenges: [], passed_stages: [] }
});
test("latestDraft is the last revision, or null", ...);
test("a check result is recorded against its draft, and a re-run replaces it", ...);   // one entry per check id
test("an evaluation is recorded against its draft", ...);
test("a challenge opens against its draft and can be answered", ...);                  // status "open" -> "answered", answer and action kept
test("a passing review stage is recorded against the draft it examined", () => {
  // stage.finished { stage: "checks", outcome: "pass", draft_hash: "h1", ... } -> reviews.h1.passed_stages equals ["checks"]
});
test("a failing stage is not recorded as passed", ...);
test("a draft is publishable only when every review stage passed that exact hash", () => {
  // checks + evaluate passed h1: false. Then challenge passed h1: true.
});
test("an open must-address challenge blocks publishing; answering it unblocks", ...);
test("a 'consider' challenge does not block", ...);
test("a new revision is not publishable on the old revision's passes", () => {
  // h1 fully passed; draft.revised h2 -> publishable(s, "h2") false, publishable(s, "h1") false (h1 is no longer the latest)
});
test("a run with no review stages publishes nothing", ...);                            // publishable false
test("blockers names what is missing", () => {
  // with only checks passed: ["Evaluate has not passed this revision", "Challenge has not passed this revision"]
  // with an open must-address challenge x1: includes "Challenge x1 must be addressed"
  // for a hash that is not the latest: ["This is not the latest revision"]
});
test("product.published records the bundle", ...);                                     // n, draft_hash, head_hash, dir, seq, ts
test("feedback is appended in order", ...);
test("agent.asked opens a turn and agent.answered fills it", ...);
test("analysis entries for an unknown draft hash change only seq", ...);
test("apply never mutates the state it is given", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/core/state-analysis.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `applyAnalysis`, `latestDraft`, `publishable`, `blockers`**

`publishable(state, hash)` is true only when all of these hold:

1. `hash` is the hash of the latest draft;
2. at least one stage in `state.run.stages` has `reviews: true`;
3. every such stage's id is in `state.reviews[hash].passed_stages`;
4. no challenge with that `draft_hash` has severity `must_address` and status `open`.

`blockers` builds its sentences from the stage titles: `"<Title> has not passed this revision"`. `publishable` is `blockers(...).length === 0`.

`stage.finished` is handled twice: Task 6 sets the stage status, and this reducer records the pass against the draft. Record a pass whenever `outcome` is `"pass"` and `draft_hash` is not null and a review record exists for it.

- [ ] **Step 4: Run the tests and the type check**

Run: `bun test tests/core && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/state tests/core/state-analysis.test.ts
git commit -m "feat(core): state fold for drafts, reviews and publishing"
```

---

### Task 8: Data directory, case sessions, id allocation

**Files:**
- Create: `src/core/ids.ts`, `src/core/session.ts`, `src/core/workbench.ts`
- Test: `tests/core/session.test.ts`, `tests/core/workbench.test.ts`

**Interfaces:**
- Consumes: `Ledger` (Task 2); `BlobStore` (Task 3); `initial`, `apply`, `fold`, `CaseState`, `IdKind`, `ID_PREFIX` (Task 5).
- Produces:
  - `class IdAllocator { constructor(state: CaseState); next(kind: IdKind): string }` — first call returns prefix + (counter + 1), then counts up locally
  - `class CaseSession` with:
    - `readonly id: string`, `readonly dir: string`, `readonly blobs: BlobStore`
    - `get state(): CaseState`
    - `commit(build: (state: CaseState, ids: IdAllocator) => EntryInput[]): Entry[]` — synchronous; appends everything `build` returns in one transaction, then advances state
    - `entries(after?: number): Entry[]`
    - `stateAt(seq: number): CaseState`
    - `subscribe(fn: (entry: Entry, state: CaseState) => void): () => void`
    - `head(): { seq: number; hash: string }`
  - `interface NewCase { title: string; asked: string; why: string; starting: Observable[]; window: Window; objective: string | null; marking: Marking }`
  - `interface CaseSummary { id: string; title: string; marking: Marking; created_ts: string; run_status: RunState["status"]; phase: string | null; incoming: number; kept: number }`
  - `class Workbench` with:
    - `static open(dataDir: string, opts?: { now?: () => string }): Workbench`
    - `readonly dataDir: string`
    - `readonly chain: Ledger` (the workbench chain at `<dataDir>/workbench.sqlite`, case id `"workbench"`)
    - `createCase(input: NewCase, actor: Actor): CaseSession`
    - `session(id: string): CaseSession` (throws `CaseNotFoundError`; returns the same object every time for one id)
    - `listCases(): CaseSummary[]` (newest first)
    - `close(): void`
  - `class CaseNotFoundError extends Error`

- [ ] **Step 1: Write the failing tests**

`tests/core/session.test.ts`:

```ts
test("commit appends what the builder returns and advances state", () => {
  const out = s.commit((_state, ids) => [{ type: "card.created", payload: { card: card(ids.next("card")) }, actor: human }]);
  expect(out).toHaveLength(1);
  expect(s.state.incoming).toEqual(["c1"]);
  expect(s.state.seq).toBe(s.head().seq);
});
test("the allocator counts up within one commit and across commits", () => {
  // one commit creating two cards -> "c1", "c2"; the next commit -> "c3"
});
test("the builder sees the state as of the previous commit", ...);
test("a builder that throws writes nothing and leaves state unchanged", () => {
  const before = s.state, head = s.head();
  expect(() => s.commit(() => { throw new Error("boom"); })).toThrow("boom");
  expect(s.head()).toEqual(head);
  expect(s.state).toBe(before);
});
test("an invalid entry in a commit writes none of them", ...);        // second entry has a NaN payload; head unchanged; state unchanged
test("a builder returning no entries is a no-op", ...);
test("subscribers get each entry with the state after it", ...);
test("state at entry N is the same live and replayed", () => {
  // 30 commits covering cards, lanes, keeps, an undo; record structuredClone(s.state) after each entry via subscribe;
  // then for every n: expect(fold(s.entries(), n)).toEqual(recorded[n]) and expect(s.stateAt(n)).toEqual(recorded[n])
});
test("a session opened on an existing case rebuilds the same state", ...);
```

`tests/core/workbench.test.ts`:

```ts
test("createCase makes CASE-1 with its own folder and a first entry", () => {
  const s = wb.createCase(newCase, human);
  expect(s.id).toBe("CASE-1");
  expect(existsSync(join(dir, "cases", "CASE-1", "ledger.sqlite"))).toBe(true);
  expect(existsSync(join(dir, "cases", "CASE-1", "blobs"))).toBe(true);
  expect(s.entries()[0]).toMatchObject({ seq: 1, type: "case.created", actor: human, payload: { id: "CASE-1", title: newCase.title } });
  expect(s.state.meta?.marking).toBe(newCase.marking);
});
test("case ids count up and survive a restart", ...);                 // CASE-1, CASE-2; reopen the workbench; next is CASE-3
test("session returns the same object for the same id", ...);         // toBe, not toEqual
test("session of an unknown id throws CaseNotFoundError", ...);
test("listCases is newest first with a summary of each", ...);
test("the workbench chain is its own verifiable ledger", () => {
  wb.chain.append({ type: "setting.changed", payload: { key: "k", value: 1 }, actor: human });
  wb.close();
  expect(verifyLedger(join(dir, "workbench.sqlite"), join(dir, "blobs")).ok).toBe(true);
});
test("a created case verifies from the command line", ...);           // spawn src/cli/verify.ts on the case folder, exit 0
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/core/session.test.ts tests/core/workbench.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `IdAllocator` in `src/core/ids.ts`**

- [ ] **Step 4: Implement `CaseSession` in `src/core/session.ts`**

The constructor takes `{ id, dir, ledger, blobs }` and folds the existing entries once. `commit` calls `build` with the current state and a fresh `IdAllocator`, passes the result to `ledger.appendMany`, then applies each returned entry and notifies subscribers. If `build` or `appendMany` throws, state is left exactly as it was. `stateAt` folds from the start; no cache is needed yet.

- [ ] **Step 5: Implement `Workbench` in `src/core/workbench.ts`**

Layout under `dataDir`: `workbench.sqlite`, `blobs/` (for the workbench chain), and `cases/<id>/{ledger.sqlite, blobs/, published/}`. The next case number is one more than the highest `CASE-<n>` directory present. `createCase` commits the `case.created` entry through the new session. Sessions are cached in a map so there is exactly one per case in the process.

- [ ] **Step 6: Run the whole suite and the type check**

Run: `bun test && bun run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/ids.ts src/core/session.ts src/core/workbench.ts tests/core/session.test.ts tests/core/workbench.test.ts
git commit -m "feat(core): data directory, case sessions and id allocation"
```
