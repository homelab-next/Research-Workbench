import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../src/core/workbench";
import type { CaseSession } from "../../src/core/session";
import type { Actor, Card, TimeWindow } from "../../src/core/types";
import { Registry } from "../../src/modules/registry";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import { ConnectorPool } from "../../src/modules/connectors";
import { runQuery } from "../../src/modules/runner";
import type { Connector, QueryOutcome } from "../../src/modules/connectors";
import type { RunnerDeps } from "../../src/modules/runner";
import { difference, revalidateCard } from "../../src/modules/revalidate";
import type { Revalidation, Verdict } from "../../src/modules/revalidate";
import { startStandin } from "../helpers/http-standin";
import type { Standin } from "../helpers/http-standin";
import { startTrino } from "../helpers/trino-standin";
import type { TrinoStandin } from "../helpers/trino-standin";

const human: Actor = { kind: "human", id: "analyst" };
const other: Actor = { kind: "human", id: "reviewer" };
const win: TimeWindow = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };

let dir: string;
let dbPath: string;
let wb: Workbench;
let s: CaseSession;
let standin: Standin;
let trino: TrinoStandin;
let registry: Registry;
let pool: ConnectorPool;
let deps: RunnerDeps;
const observables = new Observables([{ id: "address", title: "Address", pattern: "^(?:\\d{1,3}\\.){3}\\d{1,3}$" }]);

const SOURCES = (url: string, trinoUrl: string): Record<string, string> => ({
  "sources/flows.yaml": `kind: source
id: flows
title: Flows
connector: sql
location: flows.db
marking: "TLP:GREEN"
where: machine
`,
  "sources/assets.yaml": `kind: source
id: assets
title: Assets
connector: files
location: data
marking: "TLP:AMBER"
where: machine
tables:
  - { name: assets, file: assets.csv, format: csv, time_column: null, columns: [{ name: asset, type: null }, { name: address, type: address }] }
`,
  "sources/rep.yaml": `kind: source
id: rep
title: Reputation
connector: http
location: ${url}
credential: REP_KEY
marking: "TLP:AMBER"
where: hosted
adhoc: false
cost: { weight: 5, unit: lookups }
endpoints:
  - { name: reputation, method: GET, path: "/v1/reputation/{value}?days={days}", read: true, rows: results, columns: [address, verdict] }
`,
  "sources/lake.yaml": `kind: source
id: lake
title: Lake
connector: trino
location: ${trinoUrl}
user: workbench
marking: "TLP:AMBER"
where: machine
confirmed: true
cost: { weight: 0, unit: rows }
tables:
  - { name: iceberg.s.events, time_column: ts, guarded: true, columns: [] }
`,
  "types.yaml": `kind: types
types:
  - { id: address, title: Address, pattern: '^(?:\\d{1,3}\\.){3}\\d{1,3}$' }
`,
  "pivots.yaml": `kind: pivots
pivots:
  - { id: peers, title: Peers, from: address, to: address, source: flows, query: "select dst, bytes from flows where src = {value}", empty_means: not-seen, yields: { dst: address } }
  - { id: paid_rep, title: Paid reputation, from: address, to: address, source: rep, query: reputation, empty_means: not-seen, yields: { address: address } }
  - { id: lake_peers, title: Lake peers, from: address, to: address, source: lake, query: "select a from iceberg.s.events where ts >= {window.from} and ts < {window.to} and a = {value}", empty_means: proven-negative, yields: { a: address } }
`,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "revalidate-"));
  const root = join(dir, "modules");
  standin = startStandin({
    "GET /v1/reputation/198.51.100.77": () => new Response(JSON.stringify({ results: [{ address: "198.51.100.77", verdict: "suspicious" }] }), { headers: { "content-type": "application/json" } }),
  });
  trino = startTrino();
  mkdirSync(join(root, "sources", "data"), { recursive: true });
  for (const [name, text] of Object.entries(SOURCES(standin.url, trino.url))) writeFileSync(join(root, name), text);
  writeFileSync(join(root, "sources", "data", "assets.csv"), "asset,address\nlaptop-1,192.0.2.17\nlaptop-2,192.0.2.18\nprinter,192.0.2.19\n");
  dbPath = join(root, "sources", "flows.db");
  const db = new Database(dbPath);
  db.run("create table flows (ts TEXT, src TEXT, dst TEXT, bytes INTEGER)");
  for (let i = 0; i < 3; i++) db.run("insert into flows values (?, ?, ?, ?)", [`2026-01-0${i + 1}T00:00:00.000Z`, "192.0.2.17", `198.51.100.${i}`, 100 - i]);
  db.close();
  registry = Registry.load([{ path: root, trusted: true, credentials: ["REP_KEY"] }]);
  pool = new ConnectorPool({ secrets: new Secrets({ REP_KEY: "rep-key-value" }, null), observables });
  deps = { registry, pool, observables };
  wb = Workbench.open(join(dir, "data"), { onError: () => {} });
  s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [], window: win, objective: null, marking: "TLP:GREEN" }, human);
});
afterEach(() => {
  expect(s.state.skipped).toEqual([]);
  pool.closeAll();
  try { wb.close(); } catch { /* already closed */ }
  standin.stop();
  trino.stop();
  rmSync(dir, { recursive: true, force: true });
});

const FLOWS = "select dst, bytes from flows where src = {value}";
const flows = { source: "flows", text: FLOWS, bound: { value: "192.0.2.17" }, window: win, why: "find peers", actor: human };
const issued = (q: string): Record<string, unknown> =>
  s.entries().find((e) => e.type === "query.issued" && (e.payload as { query: string }).query === q)!.payload as Record<string, unknown>;
const edit = (sql: string, ...args: (string | number)[]): void => { const d = new Database(dbPath); d.run(sql, args); d.close(); };
/** A verdict; a refusal fails the test. */
const verdict = (r: Revalidation): Verdict => {
  if (r.outcome === "refused") throw new Error(`refused: ${r.reasons.join("; ")}`);
  return r;
};
const v = async (card = "c1", extra: { actor?: Actor; budget?: number | null } = {}): Promise<Verdict> =>
  verdict(await revalidateCard(s, deps, { card, actor: extra.actor ?? human, why: "check before publishing", budget: extra.budget }));

test("an unchanged source matches", async () => {
  await runQuery(s, deps, flows);
  const r = await revalidateCard(s, deps, { card: "c1", actor: human, why: "check before publishing" });
  expect(r).toMatchObject({ outcome: "matches", rerun: "q2" });
  expect(s.state.cards.c1!.validated).toMatchObject({ outcome: "matches" });
  const e = s.entries().at(-1)!;
  expect(e.type).toBe("verify.run");
  expect(e.payload).toMatchObject({ original: "q1", rerun: "q2", card: "c1", outcome: "matches" });
});

test("the re-run is a logged query that names what it verifies and makes no card", async () => {
  await runQuery(s, deps, flows);
  await v();
  expect(issued("q2")).toMatchObject({ verifies: "q1", purpose: "verify" });
  expect(issued("q1")).toMatchObject({ verifies: null, purpose: "result" });
  expect(s.state.queries.q2).toMatchObject({ status: "done", card: null, verifies: "q1" });
  expect(Object.keys(s.state.cards)).toEqual(["c1"]);
});

test("the re-run uses the original text, bound values and window, and the caller's actor", async () => {
  const narrow: TimeWindow = { from: "2026-01-02T00:00:00.000Z", to: "2026-01-03T12:00:00.000Z" };
  await runQuery(s, deps, { ...flows, text: "select dst from flows where src = {value} and ts >= {window.from} and ts < {window.to}", window: narrow });
  expect(s.state.cards.c1!.row_count).toBe(2);
  const r = await v("c1", { actor: other });
  expect(r.outcome).toBe("matches");
  const a = issued("q1"), b = issued("q2");
  expect(b).toMatchObject({ text: a.text, bound: a.bound, window: narrow, source: "flows" });
  expect(s.entries().find((e) => e.type === "query.issued" && (e.payload as { query: string }).query === "q2")!.actor).toEqual(other);
});

test("a changed source differs, and says how", async () => {
  await runQuery(s, deps, flows);
  edit("insert into flows values (?, ?, ?, ?)", "2026-01-09T00:00:00.000Z", "192.0.2.17", "198.51.100.9", 5);
  const r = await v();
  expect(r).toMatchObject({ outcome: "differs", detail: "was 3 rows, now 4 rows; the source may have changed since", rerun: "q2" });
  expect(s.state.cards.c1!.validated).toMatchObject({ outcome: "differs" });
});

test("same row count but different content differs", async () => {
  await runQuery(s, deps, flows);
  edit("update flows set bytes = 1 where dst = ?", "198.51.100.0");
  const r = await v();
  expect(r).toMatchObject({ outcome: "differs", detail: "same number of rows (3) but different content; the source may have changed since" });
});

test("the original result is untouched", async () => {
  await runQuery(s, deps, flows);
  const before = s.state.queries.q1!;
  edit("insert into flows values (?, ?, ?, ?)", "2026-01-09T00:00:00.000Z", "192.0.2.17", "198.51.100.9", 5);
  await v();
  const after = s.state.queries.q1!;
  expect(after.rows_hash).toBe(before.rows_hash);
  expect(after.rows).toBe(3);
  expect(s.blobs.check(after.result!.blob)).toBe("ok");
  expect(s.state.cards.c1!.row_count).toBe(3);
});

test("a source that now fails could not run", async () => {
  await runQuery(s, deps, flows);
  pool.closeAll();
  rmSync(dbPath);
  const r = await v();
  expect(r.outcome).toBe("could_not_run");
  expect(r.detail).toContain("database file not found");
  expect(r.rerun).toBe("q2");
  expect(s.state.queries.q2!.status).toBe("failed");
  expect(s.entries().at(-1)!.type).toBe("verify.run");
});

test("a costly source with no budget could not run, and says a budget is needed", async () => {
  const pivot = registry.pivot("paid_rep")!;
  const first = await runQuery(s, deps, { source: "rep", text: pivot.query, bound: { value: "198.51.100.77", days: 7 }, window: win, why: "w", actor: human, pivot, budget: 10 });
  expect(first.status).toBe("done");
  const r = await v();
  expect(r).toMatchObject({ outcome: "could_not_run", rerun: null });
  expect(r.detail).toContain("budget");
  expect(s.entries().at(-1)!.payload).toMatchObject({ rerun: null }); // no re-run is recorded as null, not ""
  expect(s.state.cards.c1!.validated).toMatchObject({ outcome: "could_not_run" });
  const withBudget = await v("c1", { budget: 10 });
  expect(withBudget).toMatchObject({ outcome: "matches", rerun: "q2" });
  expect(issued("q2")).toMatchObject({ pivot: "paid_rep", pivot_hash: pivot.hash, text: issued("q1").text, verifies: "q1" });
});

test("a card with no query could not run", async () => {
  await runQuery(s, deps, flows);
  const c1 = s.state.cards.c1!;
  const card: Card = { ...c1, id: "c2", kind: "assessment", made_by: "human", query: null, source: null, place: undefined } as unknown as Card;
  const { place: _p, created_seq: _s, created_ts: _t, validated: _v, ...bare } = card as unknown as Record<string, unknown>;
  s.commit((_st, ids) => { ids.next("card"); return [{ type: "card.created", actor: human, payload: { card: bare as unknown as Card } }]; });
  expect(s.state.cards.c2).toBeDefined();
  const before = s.entries().length;
  const r = await v("c2");
  expect(r).toEqual({ outcome: "could_not_run", detail: "this card did not come from a query", rerun: null, proposal: null });
  expect(s.entries().length).toBe(before);
});

test("an unknown card is refused, not thrown, and writes nothing", async () => {
  const before = s.head().seq;
  expect(await revalidateCard(s, deps, { card: "c99", actor: human, why: "w" })).toEqual({ outcome: "refused", reasons: ["unknown card: c99"] });
  expect(s.head().seq).toBe(before);
});

test("a files source re-runs its stored $name text", async () => {
  await runQuery(s, deps, { source: "assets", text: "select asset from assets where address = {value} and {window.from} < {window.to}", bound: { value: "192.0.2.18" }, window: win, why: "w", actor: human });
  expect(s.state.cards.c1!.row_count).toBe(1);
  expect(issued("q1").text).toContain("$window_from");
  const r = await v();
  expect(r).toMatchObject({ outcome: "matches", rerun: "q2" });
  expect(issued("q2")).toMatchObject({ text: issued("q1").text, bound: { value: "192.0.2.18" } });
});

test("a trino query re-runs its rendered text as-is with the stored window", async () => {
  trino.on(/iceberg\.s\.events/, { columns: ["a"], pages: [[["x"], ["y"]]] });
  const w: TimeWindow = { from: "2026-11-20T00:00:00.000Z", to: "2026-11-23T00:00:00.000Z" };
  const r1 = await runQuery(s, deps, { source: "lake", text: "select a from iceberg.s.events where ts >= {window.from} and ts < {window.to} and a <> {value}", bound: { value: "o'b" }, window: w, why: "w", actor: human });
  expect(r1.status).toBe("done");
  const r = await v();
  expect(r).toMatchObject({ outcome: "matches", rerun: "q2" });
  expect(issued("q2")).toMatchObject({ text: issued("q1").text, bound: {}, window: w, verifies: "q1" });
  expect(trino.statements.map((x) => x.sql)).toEqual([...trino.statements.map((x) => x.sql).slice(0, 1), trino.statements.at(-1)!.sql]);
  expect(trino.statements.at(-1)!.sql).toBe(issued("q1").text as string);
});

test("an http query that did not come from a pivot cannot be re-run", async () => {
  const first = await runQuery(s, deps, { source: "rep", text: "reputation", bound: { value: "198.51.100.77", days: 7 }, window: win, why: "w", actor: human, budget: 10 });
  expect(first.status).toBe("done");
  const r = await v("c1", { budget: 10 });
  expect(r).toMatchObject({ outcome: "could_not_run", detail: "only pivot queries can be re-run on this source", rerun: null });
  expect(s.entries().at(-1)!.type).toBe("verify.run");
});

test("a pivot that changed since the original query could not run", async () => {
  const pivot = registry.pivot("paid_rep")!;
  await runQuery(s, deps, { source: "rep", text: pivot.query, bound: { value: "198.51.100.77", days: 7 }, window: win, why: "w", actor: human, pivot, budget: 10 });
  const changed = { source: (id: string) => registry.source(id), pivot: (id: string) => ({ ...pivot, id, hash: "changed" }) } as unknown as Registry;
  const r = await revalidateCard(s, { ...deps, registry: changed }, { card: "c1", actor: human, why: "w", budget: 10 });
  expect(r).toMatchObject({ outcome: "could_not_run", detail: "the pivot has changed since the original query", rerun: null });
});

/** Deps whose sql connector returns the given outcomes in turn (same three rows each time). */
function stubbed(coverages: QueryOutcome["coverage"][]): RunnerDeps {
  let i = 0;
  const stub: Connector = {
    kind: "sql", render: (r) => r.text, estimate: async () => null, estimateRequest: () => null, readEstimate: () => null, close: () => {},
    run: async () => ({ columns: ["dst"], rows: [["a"], ["b"], ["c"]], raw: new TextEncoder().encode("[]"), media: "application/json", coverage: coverages[i++]!, cost: null }),
  };
  return { ...deps, pool: { for: () => stub, closeAll: () => {} } as unknown as ConnectorPool };
}
const partial: QueryOutcome["coverage"] = { kind: "partial", reason: "row_limit", detail: "x" };
const full: QueryOutcome["coverage"] = { kind: "full" };

test("equal hashes with a partial original cannot be fully verified", async () => {
  const d = stubbed([partial, full]);
  await runQuery(s, d, flows);
  const r = await revalidateCard(s, d, { card: "c1", actor: human, why: "w" });
  expect(r).toMatchObject({ outcome: "could_not_run", rerun: "q2", detail: "same 3 rows, but the original result is partial (row_limit); it cannot be fully verified" });
});
test("equal hashes with a partial re-run cannot be fully verified", async () => {
  const d = stubbed([full, partial]);
  await runQuery(s, d, flows);
  const r = await revalidateCard(s, d, { card: "c1", actor: human, why: "w" });
  expect(r).toMatchObject({ outcome: "could_not_run", detail: "same 3 rows, but the re-run result is partial (row_limit); it cannot be fully verified" });
});
test("both partial, and both full", async () => {
  const d = stubbed([partial, partial, full, full]);
  await runQuery(s, d, flows);
  const r = verdict(await revalidateCard(s, d, { card: "c1", actor: human, why: "w" }));
  expect(r.detail).toBe("same 3 rows, but the original and re-run result is partial (row_limit, row_limit); it cannot be fully verified");
  await runQuery(s, d, flows);
  expect((await revalidateCard(s, d, { card: "c2", actor: human, why: "w" })).outcome).toBe("matches");
});
test("differing hashes add the partial note", async () => {
  await runQuery(s, deps, flows);
  edit("insert into flows values (?, ?, ?, ?)", "2026-01-09T00:00:00.000Z", "192.0.2.17", "198.51.100.9", 5);
  // the stub returns three other rows, partially covered
  const stubPartial = stubbed([partial]);
  const r = verdict(await revalidateCard(s, stubPartial, { card: "c1", actor: human, why: "w" }));
  expect(r.outcome).toBe("differs");
  expect(r.detail).toContain("the re-run result is partial (row_limit)");
});

test("a trino text that rendering would change is not re-run", async () => {
  trino.on(/iceberg\.s\.events/, { columns: ["a"], pages: [[["x"]]] });
  const w: TimeWindow = { from: "2026-11-20T00:00:00.000Z", to: "2026-11-23T00:00:00.000Z" };
  const r1 = await runQuery(s, deps, { source: "lake", text: "select a from iceberg.s.events where ts >= {window.from} and ts < {window.to} and a <> {value}", bound: { value: "{window.to}" }, window: w, why: "w", actor: human });
  expect(r1.status).toBe("done");
  const before = trino.statements.length;
  const r = await v();
  expect(r).toMatchObject({ outcome: "could_not_run", detail: "the stored text cannot be re-run unchanged", rerun: null });
  expect(trino.statements.length).toBe(before);
});

test("a re-run of a pivot query on sql keeps the pivot and its hash", async () => {
  const pivot = registry.pivot("peers")!;
  await runQuery(s, deps, { ...flows, pivot });
  const r = await v();
  expect(r.outcome).toBe("matches");
  expect(issued("q2")).toMatchObject({ pivot: "peers", pivot_hash: pivot.hash, text: issued("q1").text });
});
test("a changed or missing pivot stops a sql re-run before anything runs", async () => {
  const pivot = registry.pivot("peers")!;
  await runQuery(s, deps, { ...flows, pivot });
  for (const got of [{ ...pivot, hash: "changed" }, null]) {
    const changed = { source: (id: string) => registry.source(id), pivot: () => got } as unknown as Registry;
    const r = await revalidateCard(s, { ...deps, registry: changed }, { card: "c1", actor: human, why: "w" });
    expect(r).toMatchObject({ outcome: "could_not_run", detail: "the pivot has changed since the original query", rerun: null });
  }
  expect(s.state.queries.q2).toBeUndefined();
});

test("a $ inside a string literal and an underscore name re-run unchanged", async () => {
  const text = "select dst from flows where src = {src_ip} and dst <> '$x' and ts < {window.to}";
  await runQuery(s, deps, { ...flows, text, bound: { src_ip: "192.0.2.17" } });
  expect(issued("q1").text).toContain("$src_ip");
  const r = await v();
  expect(r).toMatchObject({ outcome: "matches", rerun: "q2" });
  expect(issued("q2")).toMatchObject({ text: issued("q1").text, bound: { src_ip: "192.0.2.17" } });
  expect(String(issued("q2").text)).toContain("'$x'");
});

// ---------- final review finding 7: an agent's re-run of a costly source raises a proposal the verdict names ----------
test("an agent re-validating a costly card gets a verdict naming the proposal it raised; its budget is ignored", async () => {
  const pivot = registry.pivot("paid_rep")!;
  expect((await runQuery(s, deps, { source: "rep", text: pivot.query, bound: { value: "198.51.100.77", days: 7 }, window: win, why: "w", actor: human, pivot, budget: 10 })).status).toBe("done");
  const agent: Actor = { kind: "agent", id: "a1", stage: "check", profile: "p", model: "m", effort: null, where: "machine" };
  const r = await v("c1", { actor: agent, budget: 10 });
  expect(r).toEqual({ outcome: "could_not_run", detail: "a budget is needed to re-run this query on a costly source (proposal p1)", rerun: null, proposal: "p1" });
  expect(s.state.proposals.p1).toMatchObject({ kind: "costly_query", source: "rep", pivot: "paid_rep", status: "open" });
  expect(standin.requests).toHaveLength(1);
});

// ---------- final review minor 12: a changed source manifest is noticed ----------
test("a source whose manifest changed since the original query could not run, and says so", async () => {
  await runQuery(s, deps, flows);
  const src = registry.source("flows")!;
  const edited = { ...registry, source: (id: string) => (id === "flows" ? { ...src, hash: "edited" } : registry.source(id)), pivot: registry.pivot.bind(registry) } as unknown as Registry;
  const r = verdict(await revalidateCard(s, { ...deps, registry: edited }, { card: "c1", actor: human, why: "w" }));
  expect(r).toEqual({ outcome: "could_not_run", detail: "the source has changed since the original query", rerun: null, proposal: null });
  expect(s.state.queries.q2).toBeUndefined();
  expect(s.state.cards.c1!.validated).toMatchObject({ outcome: "could_not_run", detail: "the source has changed since the original query" });
});

// ---------- ruling 5 on re-runs: a pivot query is re-run from the pivot's own text, so it keeps the pivot ----------
test("a trino pivot query re-runs from its pivot's text and stored values, keeping the pivot", async () => {
  trino.on(/iceberg\.s\.events/, { columns: ["a"], pages: [[["x"]]] });
  const pivot = registry.pivot("lake_peers")!;
  const r1 = await runQuery(s, deps, { source: "lake", text: pivot.query, bound: { value: "192.0.2.17" }, window: win, why: "w", actor: human, pivot });
  expect(r1.status).toBe("done");
  const r = await v();
  expect(r).toMatchObject({ outcome: "matches", rerun: "q2" });
  expect(issued("q2")).toMatchObject({ pivot: "lake_peers", pivot_hash: pivot.hash, text: issued("q1").text, purpose: "verify" });
});

test("a changed source gives the rows that left and the rows that came", async () => {
  await runQuery(s, deps, flows);
  edit("delete from flows where dst = ?", "198.51.100.0");
  edit("insert into flows values (?, ?, ?, ?)", "2026-01-09T00:00:00.000Z", "192.0.2.17", "198.51.100.9", 5);
  expect((await v()).outcome).toBe("differs");
  expect(difference(s, deps, "c1")).toEqual({
    original: "q1", rerun: "q2", columns: ["dst", "bytes"], removed: [["198.51.100.0", 100]], added: [["198.51.100.9", 5]], same: 2, cut: false,
  });
});

test("rows are compared as a multiset: a repeated row counts each time", async () => {
  await runQuery(s, deps, { ...flows, text: "select bytes from flows where src = {value}" });
  edit("update flows set bytes = 100 where dst = ?", "198.51.100.2");
  expect((await v()).outcome).toBe("differs");
  expect(difference(s, deps, "c1")).toMatchObject({ removed: [[98]], added: [[100]], same: 2 });
});

test("each list is cut at 200 rows, and cut says so", async () => {
  edit("delete from flows");
  for (let i = 0; i < 250; i++) edit("insert into flows values (?, ?, ?, ?)", "2026-01-01T00:00:00.000Z", "192.0.2.17", `198.51.100.${i % 200}-a${i}`, i);
  await runQuery(s, deps, flows);
  edit("update flows set bytes = bytes + 1000");
  expect((await v()).outcome).toBe("differs");
  const d = difference(s, deps, "c1");
  if ("reason" in d) throw new Error(d.reason);
  expect(d.removed.length).toBe(200);
  expect(d.added.length).toBe(200);
  expect(d.cut).toBe(true);
  expect(d.same).toBe(0);
});

test("a card that matches, or was never verified, has no difference to show", async () => {
  await runQuery(s, deps, flows);
  expect(difference(s, deps, "c1")).toEqual({ reason: "this card has no difference to show" });
  await v();
  expect(difference(s, deps, "c1")).toEqual({ reason: "this card has no difference to show" });
  expect(difference(s, deps, "c9")).toEqual({ reason: "this card has no difference to show" });
});

test("a re-run that could not run has no difference to show; the newest verification decides", async () => {
  await runQuery(s, deps, flows);
  edit("insert into flows values (?, ?, ?, ?)", "2026-01-09T00:00:00.000Z", "192.0.2.17", "198.51.100.9", 5);
  await v();
  expect(difference(s, deps, "c1")).toMatchObject({ added: [["198.51.100.9", 5]] });
  edit("delete from flows where dst = ?", "198.51.100.9");
  await v();
  expect(difference(s, deps, "c1")).toEqual({ reason: "this card has no difference to show" });
});

test("a stored result that cannot be read back row by row gives that reason", async () => {
  await runQuery(s, deps, flows);
  edit("insert into flows values (?, ?, ?, ?)", "2026-01-09T00:00:00.000Z", "192.0.2.17", "198.51.100.9", 5);
  await v();
  const gone = { ...registry, source: () => null } as unknown as typeof registry;
  expect(difference(s, { ...deps, registry: gone }, "c1")).toEqual({ reason: "the stored result cannot be read back row by row" });
});

test("a reader that throws gives the unreadable reason, never an error", async () => {
  await runQuery(s, deps, flows);
  edit("insert into flows values (?, ?, ?, ?)", "2026-01-09T00:00:00.000Z", "192.0.2.17", "198.51.100.9", 5);
  await v();
  const broken = { ...registry, source: () => ({ limits: null }) } as unknown as typeof registry;
  expect(difference(s, { ...deps, registry: broken }, "c1")).toEqual({ reason: "the stored result cannot be read back row by row" });
});
