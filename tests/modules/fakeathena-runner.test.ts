// Slice 15, Task 12: a fakeathena source (pivot v0.3.0's synthetic lake) is usable through runQuery, with nothing in the runner changed.
// The lake is made by hand here with pivot's writeLakeCatalog: three days of sign-ins, in a temporary folder the test removes.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { writeLakeCatalog } from "pivot/synth/format";
import type { LakePartition } from "pivot/synth/format";
import { Workbench } from "../../src/core/workbench";
import type { CaseSession } from "../../src/core/session";
import type { Actor, Cost, Payloads, TimeWindow } from "../../src/core/types";
import type { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import { ConnectorPool } from "../../src/modules/connectors";
import { rowsOfBlob } from "../../src/modules/connectors/rows";
import { rowsHash, runQuery } from "../../src/modules/runner";
import type { RunnerDeps, RunQueryInput } from "../../src/modules/runner";
import { answeredBefore } from "../../src/modules/reuse";
import { revalidateCard } from "../../src/modules/revalidate";

const human: Actor = { kind: "human", id: "analyst" };
const agent: Actor = { kind: "agent", id: "a1", stage: "gather", profile: "p", model: "m", effort: null, where: "machine" };
const win: TimeWindow = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-04T00:00:00.000Z" };
const DAYS = ["2026-10-01", "2026-10-02", "2026-10-03"];
const SCALE = 50000;
// each day of signins weighs 4 rows * 100 bytes * SCALE = 20 MB; the pivots name 4 of its 5 columns (dt is not named), over 3 days:
// ceil(60 MB * 4 / 5) = 48 MB scanned, above the 10 MB minimum, at 5 USD a terabyte
const PRICE: Cost = { amount: 0.00024, unit: "USD" };

let dir: string;
let wb: Workbench;
let s: CaseSession;
let registry: Registry;
let pool: ConnectorPool;
let deps: RunnerDeps;
const observables = new Observables([
  { id: "account", title: "Account", pattern: "^[a-z][a-z0-9._-]*$" },
  { id: "address", title: "Address", pattern: "^(?:\\d{1,3}\\.){3}\\d{1,3}$" },
]);

const QUERY = "select src_ip, result from signins where ts >= {window.from} and ts < {window.to} and account = {value} limit 50";
const ROOT: Record<string, string> = {
  "sources/signins.yaml": `kind: source
id: signins
title: Sign-ins (synthetic)
connector: fakeathena
location: ../../lake.sqlite
marking: "TLP:GREEN"
where: machine
adhoc: true
cost: { weight: 0.001, unit: USD }
limits: { max_rows: 100, timeout_ms: 20000 }
tables:
  - { name: signins, time_column: ts, guarded: true, columns: [{ name: account, type: account }, { name: src_ip, type: address }] }
`,
  "types.yaml": `kind: types
types:
  - { id: account, title: Account, pattern: '^[a-z][a-z0-9._-]*$' }
  - { id: address, title: Address, pattern: '^(?:\\d{1,3}\\.){3}\\d{1,3}$' }
`,
  "pivots.yaml": `kind: pivots
pivots:
  - { id: signins_free, title: Where an account signed in from (free), from: account, to: address, source: signins, query: "${QUERY}", weight: 0, needs_window: true, empty_means: not-seen, yields: { src_ip: address } }
  - { id: signins_paid, title: Where an account signed in from, from: account, to: address, source: signins, query: "${QUERY}", needs_window: true, empty_means: not-seen, yields: { src_ip: address } }
`,
};

function makeLake(path: string): void {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = OFF");
  db.run("CREATE TABLE signins (ts TEXT, account TEXT, src_ip TEXT, result TEXT, dt TEXT)");
  const partitions: LakePartition[] = [];
  for (const dt of DAYS) {
    for (let i = 0; i < 4; i++) db.run("INSERT INTO signins VALUES (?, ?, ?, ?, ?)", [`${dt}T0${i}:00:00.000Z`, i % 2 === 0 ? "ada" : "bo", `192.0.2.${10 + i}`, i === 3 ? "fail" : "ok", dt]);
    partitions.push({ table: "signins", dt, rows: 4, bytes: 4 * 100 * SCALE });
  }
  writeLakeCatalog(db, { params: { seed: 15 }, digest: "d".repeat(64), tables: [{ name: "signins", columns: ["ts", "account", "src_ip", "result", "dt"], row_bytes: 100, partitioned: true }], partitions });
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fakeathena-runner-"));
  const root = join(dir, "root");
  mkdirSync(join(root, "sources"), { recursive: true });
  for (const [name, text] of Object.entries(ROOT)) writeFileSync(join(root, name), text);
  makeLake(join(dir, "lake.sqlite"));
  registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
  pool = new ConnectorPool({ secrets: new Secrets({}, null), observables });
  deps = { registry, pool, observables };
  wb = Workbench.open(join(dir, "data"), { onError: () => {} });
  s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [], window: win, objective: null, marking: "TLP:GREEN" }, human);
});
afterEach(() => {
  expect(s.state.skipped).toEqual([]);
  pool.closeAll();
  try { wb.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const ada = (pivot: string, over: Partial<RunQueryInput> = {}): RunQueryInput =>
  ({ source: "signins", text: QUERY, bound: { value: "ada" }, window: win, why: "where ada signed in", actor: human, pivot: registry.pivot(pivot)!, ...over });
const types = (): string[] => s.entries().map((e) => e.type);
const issued = (): Payloads["query.issued"][] => s.entries().filter((e) => e.type === "query.issued").map((e) => e.payload as Payloads["query.issued"]);
const results = (): Payloads["query.result"][] => s.entries().filter((e) => e.type === "query.result").map((e) => e.payload as Payloads["query.result"]);

test("runQuery on a free fakeathena pivot writes query.issued, query.result with a USD cost, and a card", async () => {
  expect(registry.problems).toEqual([]);
  const r = await runQuery(s, deps, ada("signins_free"));
  if (r.status !== "done") throw new Error(JSON.stringify(r));
  expect(r).toMatchObject({ outcome: "answered", rows: 6, card: "c1", query: "q1" });
  expect(types()).toEqual(["case.created", "query.issued", "query.result", "card.created"]);
  expect(issued()[0]).toMatchObject({ connector: "fakeathena", source: "signins", pivot: "signins_free", purpose: "result", estimate: null,
    text: "select src_ip, result from signins where ts >= $window_from and ts < $window_to and account = $value limit 50" });
  expect(results()[0]!.cost).toEqual(PRICE);
  expect(s.state.cards.c1).toMatchObject({ row_count: 6 });
});

test("an agent's costly fakeathena pivot issues an estimate query and becomes a costly_query proposal with the estimate in USD; nothing else is sent", async () => {
  const r = await runQuery(s, deps, ada("signins_paid", { actor: agent, step: "st1" }));
  expect(r).toEqual({ status: "needs_budget", proposal: "p1", estimate: PRICE });
  expect(types()).toEqual(["case.created", "query.issued", "query.result", "proposal.created"]);
  expect(issued()).toHaveLength(1);
  expect(issued()[0]).toMatchObject({ purpose: "estimate", connector: "fakeathena" });
  expect(issued()[0]!.text.startsWith("EXPLAIN (TYPE IO, FORMAT JSON) ")).toBe(true);
  expect(s.state.proposals.p1).toMatchObject({ kind: "costly_query", source: "signins", estimate: PRICE, status: "open", by: "a1", step: "st1" });
  expect(Object.keys(s.state.cards)).toEqual([]);
});

test("a person's budget below the estimate is needs_budget with the estimate; a budget that covers it runs, and the result's cost is the estimate", async () => {
  expect(await runQuery(s, deps, ada("signins_paid", { budget: 0.0001 }))).toEqual({ status: "needs_budget", proposal: null, estimate: PRICE });
  expect(issued().map((q) => q.purpose)).toEqual(["estimate"]);
  const r = await runQuery(s, deps, ada("signins_paid", { budget: 1 }));
  expect(r).toMatchObject({ status: "done", rows: 6 });
  const real = issued().find((q) => q.purpose === "result")!;
  expect(real.estimate).toEqual(PRICE);
  expect(results().at(-1)!.cost).toEqual(PRICE);
});

test("the stored result reads back through rowsOfBlob, so a reused and a revalidated fakeathena query work as a sql one does", async () => {
  const r = await runQuery(s, deps, ada("signins_free"));
  if (r.status !== "done") throw new Error(JSON.stringify(r));
  const q = s.state.queries.q1!;
  const back = rowsOfBlob(registry.source("signins")!, issued()[0]!, s.blobs.get(q.result!.blob), q.rows);
  expect(back).not.toBeNull();
  expect(rowsHash(back!.columns, back!.rows)).toBe(q.rows_hash!);
  // the raw bytes carry what was scanned beside the rows
  const raw = JSON.parse(new TextDecoder().decode(s.blobs.get(q.result!.blob))) as { stats: Record<string, number> };
  expect(raw.stats).toMatchObject({ bytes_scanned: 48_000_000, billed_bytes: 48_000_000, partitions: 3, usd: PRICE.amount });
  const reused = answeredBefore(s, deps, registry.pivot("signins_free")!, { value: "ada" }, win);
  expect(reused).toMatchObject({ query: "q1", card: "c1", rows: 6, reused: { query: "q1" } });
  const v = await revalidateCard(s, deps, { card: "c1", actor: human, why: "check before publishing" });
  expect(v).toMatchObject({ outcome: "matches", rerun: "q2" });
});

test("the workbench loads nothing of pivot's run code or service when it loads the connector", () => {
  // the seam test's own walk: every pivot module the workbench's src/ loads, followed through pivot's imports
  const REPO = join(import.meta.dir, "..", "..");
  const PIVOT = join(REPO, "node_modules", "pivot");
  const files = (d: string): string[] => (!existsSync(d) ? [] : readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(d, e.name)] : [])));
  const t = new Bun.Transpiler({ loader: "ts" });
  const toFile = (spec: string, from: string | null): string | null => {
    let base: string;
    if (spec === "pivot") base = join(PIVOT, "src", "index");
    else if (spec.startsWith("pivot/")) base = join(PIVOT, "src", spec.slice("pivot/".length));
    else if (from !== null && spec.startsWith(".")) base = resolve(dirname(from), spec);
    else return null;
    for (const c of [`${base}.ts`, join(base, "index.ts")]) if (existsSync(c)) return c;
    return null;
  };
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const f of files(join(REPO, "src"))) {
    for (const imp of t.scanImports(readFileSync(f, "utf8"))) {
      const p = imp.path.startsWith("pivot") ? toFile(imp.path, null) : null;
      if (p !== null && !seen.has(p)) { seen.add(p); queue.push(p); }
    }
  }
  while (queue.length > 0) {
    const f = queue.pop()!;
    for (const imp of t.scanImports(readFileSync(f, "utf8"))) {
      const p = toFile(imp.path, f);
      if (p !== null && !seen.has(p)) { seen.add(p); queue.push(p); }
    }
  }
  const loaded = [...seen].map((f) => relative(join(PIVOT, "src"), f)).sort();
  expect(loaded).toContain("connectors/fakeathena.ts");
  expect(loaded.filter((f) => /^(run|service|cli)\//.test(f) || f === "index.ts")).toEqual([]);
});
