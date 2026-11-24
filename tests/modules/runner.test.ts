import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../src/core/workbench";
import type { CaseSession } from "../../src/core/session";
import { verifyCase } from "../../src/core/verify";
import type { Actor, Cost, TimeWindow } from "../../src/core/types";
import { Registry } from "../../src/modules/registry";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import { ConnectorPool } from "../../src/modules/connectors";
import type { Connector, QueryOutcome, QueryRequest } from "../../src/modules/connectors";
import { CARD_CELL_CHARS, CARD_PREVIEW_ROWS, rowsHash, runQuery } from "../../src/modules/runner";
import { runProposal } from "../../src/modules/proposals";
import type { RunnerDeps, RunQueryInput } from "../../src/modules/runner";
import { startStandin } from "../helpers/http-standin";
import type { Standin } from "../helpers/http-standin";
import { startTrino } from "../helpers/trino-standin";
import type { TrinoStandin } from "../helpers/trino-standin";

const human: Actor = { kind: "human", id: "analyst" };
const agent: Actor = { kind: "agent", id: "a1", stage: "gather", profile: "p", model: "m", effort: null, where: "machine" };
const win: TimeWindow = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };

let dir: string;
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
quality_notes:
  - { id: dup-1, text: duplicated rows, from: "2026-01-10T00:00:00.000Z", to: "2026-01-20T00:00:00.000Z" }
`,
  "sources/assets.yaml": `kind: source
id: assets
title: Assets
connector: files
location: data
marking: "TLP:AMBER"
where: machine
limits: { max_rows: 2, timeout_ms: 1000 }
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
  - { name: reputation2, method: GET, path: "/v1/reputation/{value}", read: true, rows: results, columns: [address, verdict] }
`,
  "sources/lake.yaml": `kind: source
id: lake
title: Lake
connector: trino
location: ${trinoUrl}
user: workbench
marking: "TLP:AMBER"
where: machine
adhoc: true
cost: { weight: 2, unit: rows }
limits: { max_rows: 10, timeout_ms: 5000 }
tables:
  - { name: iceberg.s.events, time_column: ts, columns: [] }
`,
  "types.yaml": `kind: types
types:
  - { id: address, title: Address, pattern: '^(?:\\d{1,3}\\.){3}\\d{1,3}$' }
`,
  "pivots.yaml": `kind: pivots
pivots:
  - { id: peers, title: Peers of an address, from: address, to: address, source: flows, query: "select dst as peer from flows where src = {value}", needs_window: false, empty_means: proven-negative, yields: { peer: address } }
  - { id: seen, title: Seen, from: address, to: address, source: flows, query: "select dst from flows where src = {value}", empty_means: not-seen, yields: { dst: address } }
  - { id: paid_rep, title: Paid reputation, from: address, to: address, source: rep, query: reputation, empty_means: not-seen, yields: { address: address } }
  - { id: free_rep, title: Free reputation, from: address, to: address, source: rep, query: reputation, weight: 0, empty_means: not-seen, yields: { address: address } }
  - { id: windowed, title: Windowed peers, from: address, to: address, source: flows, query: "select dst from flows where src = {value} and ts >= {window.from} and ts < {window.to}", needs_window: true, empty_means: proven-negative, yields: { dst: address } }
`,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-"));
  const root = join(dir, "modules");
  standin = startStandin({
    "GET /v1/reputation/198.51.100.77": () => new Response(JSON.stringify({ results: [{ address: "198.51.100.77", verdict: "suspicious" }] }), { headers: { "content-type": "application/json" } }),
    "GET /v1/reputation/198.51.100.99": () => new Response("no", { status: 500 }),
    "GET /v1/reputation/198.51.100.66": (r) => new Response(JSON.stringify({ results: [{ address: "198.51.100.66", verdict: r.headers.get("authorization") }] }), { headers: { "content-type": "application/json" } }),
  });
  mkdirSync(join(root, "sources"), { recursive: true });
  trino = startTrino();
  for (const [name, text] of Object.entries(SOURCES(standin.url, trino.url))) writeFileSync(join(root, name), text);
  mkdirSync(join(root, "sources", "data"), { recursive: true });
  // the files source reads from <dir of manifest>/data
  writeFileSync(join(root, "sources", "data", "assets.csv"), "asset,address\nlaptop-1,192.0.2.17\nlaptop-2,192.0.2.18\nprinter,192.0.2.19\n");
  const db = new Database(join(root, "sources", "flows.db"));
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

const base: RunQueryInput = { source: "flows", text: "select dst, bytes from flows where src = {value}", bound: { value: "192.0.2.17" }, window: win, why: "find peers", actor: human };
const repInput: RunQueryInput = { source: "rep", text: "reputation", bound: { value: "198.51.100.77", days: 7 }, window: win, why: "w", actor: human };

/** A pool whose only connector is a stub that returns the given outcome. */
function stubDeps(outcome: Partial<QueryOutcome> | (() => Promise<QueryOutcome>), seen: QueryRequest[] = []): RunnerDeps {
  const stub: Connector = {
    kind: "sql",
    render: (r) => r.text,
    estimate: async () => null,
    estimateRequest: () => null,
    readEstimate: () => null,
    run: async (r) => {
      seen.push(r);
      if (typeof outcome === "function") return outcome();
      return { columns: ["dst"], rows: [], raw: new TextEncoder().encode("[]"), media: "application/json", coverage: { kind: "full" }, cost: null, ...outcome };
    },
    close: () => {},
  };
  return { registry, observables, pool: { for: () => stub, closeAll: () => {} } as unknown as ConnectorPool };
}
const types = (): string[] => s.entries().map((e) => e.type);

test("a query writes issued, then result and card, and stores the raw bytes", async () => {
  const r = await runQuery(s, deps, base);
  if (r.status !== "done") throw new Error(JSON.stringify(r));
  expect(r).toMatchObject({ status: "done", outcome: "answered", card: "c1", query: "q1" });
  expect(types().slice(-3)).toEqual(["query.issued", "query.result", "card.created"]);
  const issued = s.entries().find((e) => e.type === "query.issued")!.payload as Record<string, unknown>;
  expect(issued).toMatchObject({ query: "q1", source: "flows", connector: "sql", why: "find peers", verifies: null,
    text: "select dst, bytes from flows where src = $value", bound: { value: "192.0.2.17" }, window: win, pivot: null, pivot_hash: null });
  expect(issued.source_hash).toBe(deps.registry.source("flows")!.hash);
  const result = s.entries().find((e) => e.type === "query.result")!.payload as { result: { blob: string }; rows_hash: string };
  expect(s.blobs.check(result.result.blob)).toBe("ok");
  expect(result.rows_hash).toBe(rowsHash(r.columns, r.data));
  expect(s.state.queries.q1).toMatchObject({ status: "done", card: "c1" });
});

test("issued is written before the source is contacted", async () => {
  let status: string | undefined;
  const d = stubDeps(async () => {
    status = s.state.queries.q1?.status;
    return { columns: ["dst"], rows: [["x"]], raw: new TextEncoder().encode("x"), media: "text/plain", coverage: { kind: "full" }, cost: null };
  });
  await runQuery(s, d, base);
  expect(status).toBe("running");
});

test("the card carries provenance: source, why, marking, query, columns and their types", async () => {
  await runQuery(s, deps, base);
  expect(s.state.cards.c1).toMatchObject({ kind: "result", made_by: "human", query: "q1", source: "flows", why: "find peers", marking: "TLP:GREEN",
    columns: ["dst", "bytes"], column_types: ["address", null], row_count: 3, coverage: { kind: "full" }, empty: null, place: "incoming",
    title: "Query on Flows", body: "3 rows", event_time: null, step: null, subgoal: null });
});

test("a pivot supplies the card title, column types and empty meaning", async () => {
  const pivot = registry.pivot("peers")!;
  const r = await runQuery(s, deps, { ...base, text: pivot.query, pivot });
  expect(r).toMatchObject({ status: "done" });
  expect(s.state.cards.c1).toMatchObject({ title: "Peers of an address: 192.0.2.17", columns: ["peer"], column_types: ["address"] });
  const issued = s.entries().find((e) => e.type === "query.issued")!.payload as Record<string, unknown>;
  expect(issued).toMatchObject({ pivot: "peers", pivot_hash: pivot.hash });
  const r2 = await runQuery(s, deps, { ...base, title: "Mine" });
  expect(r2).toMatchObject({ status: "done" });
  expect(s.state.cards.c2!.title).toBe("Mine");
});

test("the card previews at most 50 rows but counts them all", async () => {
  const rows = Array.from({ length: 60 }, (_, i) => [`198.51.100.${i}`]);
  const r = await runQuery(s, stubDeps({ rows }), base);
  expect(CARD_PREVIEW_ROWS).toBe(50);
  expect(r).toMatchObject({ status: "done", rows: 60 });
  if (r.status === "done") expect(r.data).toHaveLength(60);
  expect(s.state.cards.c1!.rows).toHaveLength(50);
  expect(s.state.cards.c1!.row_count).toBe(60);
  expect(s.state.queries.q1!.rows).toBe(60);
});

const none = { ...base, bound: { value: "192.0.2.99" } };

test("zero rows with full coverage on a proven-negative pivot is a proven negative", async () => {
  const r = await runQuery(s, deps, { ...none, text: registry.pivot("peers")!.query, pivot: registry.pivot("peers")! });
  expect(r).toMatchObject({ status: "done", outcome: "empty", rows: 0 });
  expect(s.state.cards.c1).toMatchObject({ empty: "proven-negative", body: "No rows · proven negative", coverage: { kind: "full" } });
});

test("zero rows on a not-seen pivot is not a proven negative", async () => {
  await runQuery(s, deps, { ...none, text: registry.pivot("seen")!.query, pivot: registry.pivot("seen")! });
  expect(s.state.cards.c1).toMatchObject({ empty: "not-seen", body: "No rows · not seen (not proof of absence)" });
});

test("zero rows with partial coverage is never a proven negative", async () => {
  const r = await runQuery(s, stubDeps({ coverage: { kind: "partial", reason: "timeout" } }), { ...none, text: registry.pivot("peers")!.query, pivot: registry.pivot("peers")! });
  expect(r).toMatchObject({ status: "done", outcome: "partial" });
  expect(s.state.cards.c1).toMatchObject({ empty: "not-seen", coverage: { kind: "partial", reason: "timeout" } });
});

test("the same empty answer is a proven negative with full coverage and not-seen with partial", async () => {
  const text = registry.pivot("peers")!.query; // the proven-negative pivot
  await runQuery(s, stubDeps({ coverage: { kind: "full" } }), { ...none, text, pivot: registry.pivot("peers")! });
  await runQuery(s, stubDeps({ coverage: { kind: "partial", reason: "timeout" } }), { ...none, text, pivot: registry.pivot("peers")! });
  expect(s.state.cards.c1!.empty).toBe("proven-negative");
  expect(s.state.cards.c2!.empty).toBe("not-seen");
});

test("zero rows with no pivot is not-seen", async () => {
  const r = await runQuery(s, deps, none);
  expect(r).toMatchObject({ outcome: "empty" });
  expect(s.state.cards.c1!.empty).toBe("not-seen");
});

test("partial coverage with rows is outcome partial and the card says why", async () => {
  const r = await runQuery(s, deps, { source: "assets", text: "select asset, address from assets", bound: {}, window: win, why: "w", actor: human });
  expect(r).toMatchObject({ status: "done", outcome: "partial", rows: 2, coverage: { kind: "partial", reason: "row_limit" } });
  expect(s.state.cards.c1!.body).toContain("2 rows · partial: row_limit");
  expect(s.state.cards.c1!.column_types).toEqual([null, "address"]);
});

test("a source failure writes query.failed and makes no card", async () => {
  const r = await runQuery(s, deps, { ...repInput, bound: { value: "198.51.100.99", days: 7 }, budget: 1 });
  expect(r.status).toBe("failed");
  expect(types().slice(-2)).toEqual(["query.issued", "query.failed"]);
  expect(types()).not.toContain("card.created");
  expect(s.state.queries.q1!.status).toBe("failed");
  if (r.status === "failed") expect(r.error).toBe(s.state.queries.q1!.error as string);
});

test("a guard refusal writes nothing", async () => {
  const before = s.head().seq;
  const r = await runQuery(s, deps, { ...base, text: "delete from flows" });
  expect(r.status).toBe("refused");
  if (r.status === "refused") expect(r.reasons.length).toBeGreaterThan(0);
  expect(s.head().seq).toBe(before);
});

test("an unknown source is refused", async () => {
  const before = s.head().seq;
  expect(await runQuery(s, deps, { ...base, source: "nope" })).toMatchObject({ status: "refused" });
  expect(s.head().seq).toBe(before);
});

test("a costly query with no budget from a person asks for one and writes nothing", async () => {
  const before = s.head().seq;
  const r = await runQuery(s, deps, repInput);
  expect(r).toEqual({ status: "needs_budget", proposal: null, estimate: { amount: 1, unit: "lookups" } });
  expect(s.head().seq).toBe(before);
  expect(standin.requests).toHaveLength(0);
});

test("a costly query with no budget from an agent becomes a proposal", async () => {
  const r = await runQuery(s, deps, { ...repInput, actor: agent, pivot: registry.pivot("paid_rep")!, step: "st1" });
  expect(r).toMatchObject({ status: "needs_budget", proposal: "p1" });
  expect(s.state.proposals.p1).toMatchObject({ kind: "costly_query", source: "rep", estimate: { amount: 1, unit: "lookups" }, status: "open", why: "w", by: "a1", step: "st1" });
  expect(types().at(-1)).toBe("proposal.created");
  expect(standin.requests).toHaveLength(0);
});

test("a costly query with a budget runs and records its cost", async () => {
  const r = await runQuery(s, deps, { ...repInput, budget: 3 });
  expect(r).toMatchObject({ status: "done", outcome: "answered", rows: 1 });
  const issued = s.entries().find((e) => e.type === "query.issued")!.payload as Record<string, unknown>;
  expect(issued.estimate).toEqual({ amount: 1, unit: "lookups" });
  const result = s.entries().find((e) => e.type === "query.result")!.payload as { cost: Cost | null };
  expect(result.cost).toEqual({ amount: 1, unit: "lookups" });
  expect(standin.requests).toHaveLength(1);
});

test("a pivot's own weight overrides the source's", async () => {
  const r = await runQuery(s, deps, { ...repInput, pivot: registry.pivot("free_rep")! });
  expect(r.status).toBe("done");
  expect((s.entries().find((e) => e.type === "query.issued")!.payload as { estimate: Cost | null }).estimate).toBeNull();
  expect(standin.requests).toHaveLength(1);
});

test("a quality note overlapping the window is attached to the card", async () => {
  await runQuery(s, deps, base);
  expect(s.state.cards.c1!.quality_notes).toEqual(["dup-1"]);
  await runQuery(s, deps, { ...base, window: { from: "2026-03-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z" } });
  expect(s.state.cards.c2!.quality_notes).toEqual([]);
  await runQuery(s, deps, { ...base, window: { from: null, to: null } });
  expect(s.state.cards.c3!.quality_notes).toEqual(["dup-1"]);
});

test("make_card false records the query but makes no card", async () => {
  const r = await runQuery(s, deps, { ...base, make_card: false });
  expect(r).toMatchObject({ status: "done", card: null, query: "q1" });
  expect(types().slice(-2)).toEqual(["query.issued", "query.result"]);
  expect(Object.keys(s.state.cards)).toEqual([]);
});

test("verifies, step, subgoal, run, stage and job are carried onto the entries and card", async () => {
  const r = await runQuery(s, deps, { ...base, verifies: "claim-1", step: "st1", subgoal: "g1", run: null, stage: "gather", job: null });
  expect(r.status).toBe("done");
  const issued = s.entries().find((e) => e.type === "query.issued")!;
  expect(issued.payload).toMatchObject({ verifies: "claim-1", step: "st1" });
  expect(issued.stage).toBe("gather");
  expect(s.entries().at(-1)!.stage).toBe("gather");
  expect(s.state.cards.c1).toMatchObject({ step: "st1", subgoal: "g1" });
  expect(s.state.queries.q1).toMatchObject({ verifies: "claim-1", step: "st1" });
});

test("max_rows and timeout_ms come from the source's limits", async () => {
  const seen: QueryRequest[] = [];
  await runQuery(s, stubDeps({}, seen), base);
  expect(seen[0]).toMatchObject({ max_rows: registry.source("flows")!.limits.max_rows, timeout_ms: registry.source("flows")!.limits.timeout_ms, budget: null });
});

test("agent-written text is refused on a source that does not allow it", async () => {
  const before = s.head().seq;
  const r = await runQuery(s, deps, { ...base, actor: agent });
  expect(r).toEqual({ status: "refused", reasons: ["this source does not allow agent-written queries"] });
  expect(s.head().seq).toBe(before);
});

test("the whole case still verifies", async () => {
  await runQuery(s, deps, base);
  await runQuery(s, deps, { ...repInput, budget: 1 });
  expect(verifyCase(s.dir).ok).toBe(true);
});

test("the stored blob holds the connector's raw bytes exactly", async () => {
  const raw = new Uint8Array([0, 1, 2, 255, 10, 13, 200]);
  await runQuery(s, stubDeps({ raw, media: "application/octet-stream", rows: [["x"]] }), base);
  const ref = s.state.queries.q1!.result!;
  expect(Array.from(s.blobs.get(ref.blob))).toEqual(Array.from(raw));
  expect(ref.media).toBe("application/octet-stream");
});

test("a throwing connector writes query.failed and returns failed", async () => {
  const r = await runQuery(s, stubDeps(async () => { throw new Error("source down\nmore"); }), base);
  expect(r).toMatchObject({ status: "failed", error: "source down" });
  expect(types().slice(-2)).toEqual(["query.issued", "query.failed"]);
});

test("a blob-store throw after the run writes query.failed", async () => {
  const orig = s.blobs.put.bind(s.blobs);
  s.blobs.put = () => { throw new Error("disk full"); };
  const r = await runQuery(s, stubDeps({ rows: [["x"]] }), base);
  s.blobs.put = orig;
  expect(r).toMatchObject({ status: "failed", error: "disk full" });
  expect(s.state.queries.q1!.status).toBe("failed");
  expect(types()).not.toContain("card.created");
});

test("a pivot for another source is refused", async () => {
  const before = s.head().seq;
  const r = await runQuery(s, deps, { ...base, source: "assets", pivot: registry.pivot("peers")! });
  expect(r.status).toBe("refused");
  expect(s.head().seq).toBe(before);
});

test("a forged pivot is refused: unknown id or changed hash", async () => {
  const before = s.head().seq;
  const real = registry.pivot("paid_rep")!;
  expect((await runQuery(s, deps, { ...repInput, pivot: { ...real, hash: "x" } })).status).toBe("refused");
  expect((await runQuery(s, deps, { ...repInput, pivot: { ...real, id: "nope" } })).status).toBe("refused");
  expect(s.head().seq).toBe(before);
});

test("a forged pivot weight does not make a costly query free", async () => {
  const r = await runQuery(s, deps, { ...repInput, pivot: { ...registry.pivot("paid_rep")!, weight: 0 } });
  expect(r).toMatchObject({ status: "needs_budget" });
  expect(standin.requests).toHaveLength(0);
});

test("a forged empty_means does not forge a proven negative", async () => {
  await runQuery(s, deps, { ...none, pivot: { ...registry.pivot("seen")!, empty_means: "proven-negative" } });
  expect(s.state.cards.c1!.empty).toBe("not-seen");
});

test("agent text that differs from the pivot's query is refused as agent-written", async () => {
  const before = s.head().seq;
  const r = await runQuery(s, deps, { ...base, text: "select * from flows", actor: agent, pivot: registry.pivot("peers")! });
  expect(r).toEqual({ status: "refused", reasons: ["this source does not allow agent-written queries"] });
  expect(s.head().seq).toBe(before);
  const ok = await runQuery(s, deps, { ...base, text: registry.pivot("peers")!.query, actor: agent, pivot: registry.pivot("peers")! });
  expect(ok.status).toBe("done");
});

test("a budget that is 0, negative or NaN counts as missing", async () => {
  for (const budget of [0, -1, NaN, Infinity]) {
    expect(await runQuery(s, deps, { ...repInput, budget })).toEqual({ status: "needs_budget", proposal: null, estimate: { amount: 1, unit: "lookups" } });
  }
  expect(standin.requests).toHaveLength(0);
});

test("an estimate above the budget needs a budget (a proposal for an agent) and runs nothing", async () => {
  expect(await runQuery(s, deps, { ...repInput, budget: 0.5 })).toMatchObject({ status: "needs_budget", proposal: null });
  const r = await runQuery(s, deps, { ...repInput, actor: agent, pivot: registry.pivot("paid_rep")!, budget: 0.5 });
  expect(r).toMatchObject({ status: "needs_budget", proposal: "p1" });
  expect(standin.requests).toHaveLength(0);
});

test("a result the fold would refuse becomes query.failed, not a silent loss", async () => {
  const bad = { kind: "partial", reason: "nonsense" } as unknown as QueryOutcome["coverage"];
  const r = await runQuery(s, stubDeps({ coverage: bad }), base);
  expect(r).toMatchObject({ status: "failed" });
  if (r.status === "failed") expect(r.error).toContain("invalid result");
  expect(s.state.queries.q1!.status).toBe("failed");
  expect(types()).not.toContain("card.created");
  const r2 = await runQuery(s, stubDeps({ columns: [1 as unknown as string] }), base);
  expect(r2.status).toBe("failed");
  expect(s.state.queries.q2!.status).toBe("failed");
});

// ---------- final review finding 10 ----------
test("an http result that echoes the credential is refused: the secret reaches neither the blobs nor the ledger", async () => {
  const r = await runQuery(s, deps, { ...repInput, bound: { value: "198.51.100.66", days: 7 }, budget: 5 });
  expect(r).toMatchObject({ status: "failed", error: "the source echoed the credential; result refused" });
  expect(types()).toEqual(["case.created", "query.issued", "query.failed"]);
  const stored = [readFileSync(join(s.dir, "ledger.sqlite")), ...(existsSync(join(s.dir, "blobs")) ? readdirSync(join(s.dir, "blobs"), { recursive: true }).map(String).filter((f) => statSync(join(s.dir, "blobs", f)).isFile()).map((f) => readFileSync(join(s.dir, "blobs", f))) : [])];
  for (const bytes of stored) expect(bytes.includes("rep-key-value")).toBe(false);
});

// ---------- final review finding 3: the window is checked before anything is written ----------
test("a malformed window, or one whose from is after its to, is refused and writes nothing", async () => {
  const pn = registry.pivot("peers")!;
  const before = s.head().seq;
  const bad: unknown[] = [
    { from: "last tuesday", to: "now" }, { from: "2026-01-01T00:00:00Z", to: null }, { from: "2026-01-01T00:00:00.000+01:00", to: null },
    { from: "2026-02-30T00:00:00.000Z", to: null }, { from: 1767225600000, to: null }, { from: null }, null,
    { from: "2026-02-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" },
  ];
  for (const window of bad) {
    const r = await runQuery(s, deps, { ...none, text: pn.query, pivot: pn, window: window as TimeWindow });
    expect(r.status, JSON.stringify(window)).toBe("refused");
  }
  expect(s.head().seq).toBe(before);
  // an instant window and open ends are fine
  expect((await runQuery(s, deps, { ...none, text: pn.query, pivot: pn, window: { from: win.from, to: win.from } })).status).toBe("done");
  expect((await runQuery(s, deps, { ...none, text: pn.query, pivot: pn, window: { from: null, to: null } })).status).toBe("done");
});

test("a pivot that needs a window is refused with an open end", async () => {
  const before = s.head().seq;
  const pivot = registry.pivot("windowed")!;
  for (const window of [{ from: null, to: win.to }, { from: win.from, to: null }, { from: null, to: null }]) {
    expect(await runQuery(s, deps, { ...base, text: pivot.query, pivot, window })).toEqual({ status: "refused", reasons: ["pivot windowed needs a window with both ends set"] });
  }
  expect(s.head().seq).toBe(before);
  expect((await runQuery(s, deps, { ...base, text: pivot.query, pivot })).status).toBe("done");
});

// ---------- final review finding 4: a pivot applies only to its own text ----------
test("a pivot passed with other text lends neither its weight nor its proven negative", async () => {
  const free = registry.pivot("free_rep")!;
  // a person on a non-adhoc source, a free pivot's id, a costly source: the source's weight applies
  expect(await runQuery(s, deps, { ...repInput, text: "reputation2", pivot: free })).toEqual({ status: "needs_budget", proposal: null, estimate: { amount: 1, unit: "lookups" } });
  expect(standin.requests).toHaveLength(0);
  const peers = registry.pivot("peers")!;
  const r = await runQuery(s, deps, { ...none, text: "select dst as peer from flows where src = {value} and 1 = 0", pivot: peers });
  expect(r).toMatchObject({ status: "done", outcome: "empty" });
  expect(s.state.cards.c1).toMatchObject({ empty: "not-seen", title: "Query on Flows" });
  expect(s.entries().find((e) => e.type === "query.issued")!.payload).toMatchObject({ pivot: null, pivot_hash: null });
});

test("an agent on an adhoc source with other text gets the source's weight, not the free pivot's", async () => {
  const adhoc = Registry.load([{ path: join(dir, "modules"), trusted: true, credentials: ["REP_KEY"] }]);
  const src = adhoc.source("rep")!;
  const d: RunnerDeps = { ...deps, registry: { ...adhoc, source: (id: string) => (id === "rep" ? { ...src, adhoc: true } : adhoc.source(id)), pivot: (id: string) => adhoc.pivot(id), rootOf: adhoc.rootOf.bind(adhoc) } as unknown as Registry };
  const r = await runQuery(s, d, { ...repInput, actor: agent, pivot: adhoc.pivot("free_rep")!, text: "reputation" });
  expect(r.status).toBe("done"); // the pivot's own text: free
  const other = await runQuery(s, d, { ...repInput, actor: agent, pivot: adhoc.pivot("free_rep")!, text: "reputation2" });
  expect(other).toMatchObject({ status: "needs_budget", proposal: "p1" });
  expect(standin.requests).toHaveLength(1);
});

// ---------- final review minors 13 and 14 ----------
test("bound values that are not strings, finite numbers or null are refused before anything is written", async () => {
  const before = s.head().seq;
  for (const value of [true, { a: 1 }, [1], NaN, Infinity, undefined]) {
    const r = await runQuery(s, deps, { ...base, bound: { value } as unknown as RunQueryInput["bound"] });
    expect(r.status, String(value)).toBe("refused");
  }
  expect((await runQuery(s, deps, { ...base, bound: null as unknown as RunQueryInput["bound"] })).status).toBe("refused");
  expect(s.head().seq).toBe(before);
});

test("bound values are copied at entry: a change by the caller during the run does not reach the source", async () => {
  const seen: QueryRequest[] = [];
  const bound: Record<string, string> = { value: "192.0.2.17" };
  const d = stubDeps(async () => {
    bound.value = "changed";
    return { columns: ["dst"], rows: [], raw: new Uint8Array(), media: "", coverage: { kind: "full" }, cost: null };
  }, seen);
  await runQuery(s, d, { ...base, bound });
  expect(seen[0]!.bound).toEqual({ value: "192.0.2.17" });
  expect(s.entries().find((e) => e.type === "query.issued")!.payload).toMatchObject({ bound: { value: "192.0.2.17" } });
});

test("any error while rendering or estimating is a refusal, not a throw", async () => {
  const throwing = (where: "render" | "estimate"): RunnerDeps => {
    const stub = {
      kind: "sql", close: () => {},
      render: (r: QueryRequest) => { if (where === "render") throw new TypeError("render broke"); return r.text; },
      estimate: async () => { throw new RangeError("estimate broke"); },
      estimateRequest: () => null, readEstimate: () => null,
      run: async () => { throw new Error("not reached"); },
    } as unknown as Connector;
    return { registry, observables, pool: { for: () => stub, closeAll: () => {} } as unknown as ConnectorPool };
  };
  expect(await runQuery(s, throwing("render"), base)).toEqual({ status: "refused", reasons: ["render broke"] });
  expect(await runQuery(s, throwing("estimate"), { ...repInput, budget: 3 })).toEqual({ status: "refused", reasons: ["estimate broke"] });
  expect(types()).toEqual(["case.created"]);
});

// ---------- final review finding 2: an estimate that asks the source is a recorded query ----------
const LAKE = "select a from iceberg.s.events where a <> {value}";
const lakeInput: RunQueryInput = { source: "lake", text: LAKE, bound: { value: "x" }, window: win, why: "events", actor: human };
const plan = (rows: number) => ({ columns: ["Query Plan"], pages: [[[JSON.stringify({ estimate: { outputRowCount: rows } })]]] });
const issuedPayloads = () => s.entries().filter((e) => e.type === "query.issued").map((e) => e.payload as Record<string, unknown>);

test("a costly trino query is priced by a recorded EXPLAIN query, then runs citing it", async () => {
  trino.on(/^explain/i, plan(3));
  trino.on(/^select/i, { columns: ["a"], pages: [[["p"], ["q"]]] });
  const r = await runQuery(s, deps, { ...lakeInput, budget: 5 });
  expect(r).toMatchObject({ status: "done", rows: 2 });
  expect(types()).toEqual(["case.created", "query.issued", "query.result", "query.issued", "query.result", "card.created"]);
  const [est, real] = issuedPayloads();
  expect(est).toMatchObject({ purpose: "estimate", pivot: null, estimate: null, why: "estimate for: events", text: `EXPLAIN (TYPE IO, FORMAT JSON) select a from iceberg.s.events where a <> 'x'` });
  expect(real).toMatchObject({ purpose: "result", estimate: { amount: 3, unit: "rows" }, text: "select a from iceberg.s.events where a <> 'x'" });
  const entries = s.entries();
  const estResult = entries.find((e) => e.type === "query.result")!;
  expect(entries.filter((e) => e.type === "query.issued")[1]!.cause).toBe(estResult.seq);
  expect(s.state.queries.q1).toMatchObject({ purpose: "estimate", status: "done", card: null });
  expect(s.blobs.get((estResult.payload as { result: { blob: string } }).result.blob).length).toBeGreaterThan(0);
  expect(trino.statements.map((x) => x.sql.split(" ")[0])).toEqual(["EXPLAIN", "select"]);
  expect(verifyCase(s.dir).ok).toBe(true);
});

test("an estimate above the budget is recorded, and the query does not run", async () => {
  trino.on(/^explain/i, plan(50));
  expect(await runQuery(s, deps, { ...lakeInput, budget: 5 })).toEqual({ status: "needs_budget", proposal: null, estimate: { amount: 50, unit: "rows" } });
  expect(types()).toEqual(["case.created", "query.issued", "query.result"]);
  expect(trino.statements).toHaveLength(1);
});

test("a failed estimate is query.failed; with no estimate only a person's budget runs the query", async () => {
  trino.on(/^explain/i, { error: "no stats" });
  trino.on(/^select/i, { columns: ["a"], pages: [[["p"]]] });
  const system: Actor = { kind: "system", id: "scheduler" };
  expect(await runQuery(s, deps, { ...lakeInput, actor: system, budget: 1000 })).toEqual({ status: "needs_budget", proposal: null, estimate: null });
  expect(s.state.queries.q1).toMatchObject({ purpose: "estimate", status: "failed" });
  const person = await runQuery(s, deps, { ...lakeInput, budget: 1000 });
  expect(person).toMatchObject({ status: "done" });
  const viaAgent = await runQuery(s, deps, { ...lakeInput, actor: agent });
  expect(viaAgent).toEqual({ status: "needs_budget", proposal: "p1", estimate: null });
  expect(s.state.proposals.p1).toMatchObject({ estimate: null }); // never the ranking weight
});

test("a person's budget below the fresh estimate records proposal.repriced and runs nothing", async () => {
  trino.on(/^explain/i, plan(40));
  const first = await runQuery(s, deps, { ...lakeInput, actor: agent });
  expect(first).toEqual({ status: "needs_budget", proposal: "p1", estimate: { amount: 40, unit: "rows" } });
  trino.on(/^explain/i, plan(900));
  const r = await runProposal(s, deps, { proposal: "p1", budget: 100, actor: human });
  expect(r).toEqual({ status: "needs_budget", proposal: null, estimate: { amount: 900, unit: "rows" } });
  const e = s.entries().at(-1)!;
  const estimateResult = s.entries().filter((x) => x.type === "query.result").at(-1)!;
  const estimateIssued = s.entries().filter((x) => x.type === "query.issued").at(-1)!;
  expect(e.type).toBe("proposal.repriced");
  expect(e.actor).toEqual(human);
  expect(e.payload).toEqual({ proposal: "p1", estimate: { amount: 900, unit: "rows" }, budget: 100, query: (estimateIssued.payload as { query: string }).query });
  expect(e.cause).toBe(estimateResult.seq);
  expect(s.state.proposals.p1).toMatchObject({ status: "open", estimate: { amount: 900, unit: "rows" }, refused_budget: 100 });
  expect(s.entries().some((x) => x.type === "proposal.accepted")).toBe(false);
  expect(trino.statements.filter((x) => !x.sql.startsWith("EXPLAIN")).length).toBe(0);
  expect(s.state.skipped).toEqual([]);
});

test("an estimate the engine cannot give leaves the decision to the person", async () => {
  trino.on(/^explain/i, { columns: ["Query Plan"], pages: [[[JSON.stringify({ estimate: { outputRowCount: "NaN" } })]]] });
  trino.on(/^select/i, { columns: ["a"], pages: [[["p"], ["q"]], [["r"], ["s"]], [["t"]]] });
  expect(await runQuery(s, deps, { ...lakeInput, actor: agent })).toEqual({ status: "needs_budget", proposal: "p1", estimate: null });
  const r = await runProposal(s, deps, { proposal: "p1", budget: 3, actor: human });
  expect(r).toMatchObject({ status: "done", outcome: "partial", coverage: { kind: "partial", reason: "budget" } });
  expect(s.entries().some((x) => x.type === "proposal.repriced")).toBe(false);
  expect(s.state.skipped).toEqual([]);
});

// ---------- final review finding 6: budgets are enforced ----------
test("a non-finite or wrongly-unitted estimate counts as none", async () => {
  for (const bad of [{ amount: NaN, unit: "lookups" }, { amount: Infinity, unit: "lookups" }, { amount: -1, unit: "lookups" }, { amount: 1, unit: "usd" }]) {
    const stub = {
      kind: "sql", render: (r: QueryRequest) => r.text, close: () => {}, estimate: async () => bad, estimateRequest: () => null, readEstimate: () => null,
      run: async () => ({ columns: ["dst"], rows: [], raw: new Uint8Array(), media: "", coverage: { kind: "full" }, cost: null }),
    } as unknown as Connector;
    const d: RunnerDeps = { registry, observables, pool: { for: () => stub, closeAll: () => {} } as unknown as ConnectorPool };
    expect(await runQuery(s, d, { ...repInput, actor: { kind: "system", id: "x" }, budget: 3 })).toEqual({ status: "needs_budget", proposal: null, estimate: null });
  }
  expect(s.head().seq).toBe(1);
});

test("a malformed cost from the source fails the query before anything is kept", async () => {
  for (const cost of [{ amount: NaN, unit: "s" }, { amount: 1 }, "1", { amount: -2, unit: "s" }]) {
    const r = await runQuery(s, stubDeps({ cost: cost as unknown as Cost }), base);
    expect(r).toMatchObject({ status: "failed", error: "the source returned an invalid result: cost is malformed" });
  }
  expect(types().filter((t) => t === "query.result")).toEqual([]);
});

test("the budget reaches the connector in the source's unit, and a trino query stops at it", async () => {
  trino.on(/^explain/i, plan(2));
  trino.on(/^select/i, { columns: ["a"], pages: [[["p"], ["q"]], [["r"], ["s"]], [["t"]]] });
  const r = await runQuery(s, deps, { ...lakeInput, budget: 2 });
  expect(r).toMatchObject({ status: "done", outcome: "partial", rows: 2, coverage: { kind: "partial", reason: "budget" } });
  expect(trino.cancelled).toHaveLength(1);
});

// ---------- final review finding 7: the costly path, from an agent's proposal to a person's run ----------
const paidRep = (): RunQueryInput => ({ ...repInput, actor: agent, pivot: registry.pivot("paid_rep")!, step: "st1", subgoal: "g1" });

test("an agent's budget is ignored: a costly query from an agent is always a proposal", async () => {
  const r = await runQuery(s, deps, { ...paidRep(), budget: 1000 });
  expect(r).toMatchObject({ status: "needs_budget", proposal: "p1" });
  expect(standin.requests).toHaveLength(0);
});

test("a proposal holds what it takes to run it, and the same request reuses it", async () => {
  const pivot = registry.pivot("paid_rep")!;
  const r = await runQuery(s, deps, paidRep());
  expect(r).toEqual({ status: "needs_budget", proposal: "p1", estimate: { amount: 1, unit: "lookups" } });
  expect(s.state.proposals.p1).toMatchObject({
    kind: "costly_query", source: "rep", pivot: "paid_rep", pivot_hash: pivot.hash, text: "reputation", bound: { value: "198.51.100.77", days: 7 },
    window: win, subgoal: "g1", step: "st1", estimate: { amount: 1, unit: "lookups" }, status: "open",
  });
  expect(await runQuery(s, deps, paidRep())).toEqual(r);
  expect(types().filter((t) => t === "proposal.created")).toHaveLength(1);
  const other = await runQuery(s, deps, { ...paidRep(), bound: { value: "198.51.100.77", days: 8 } });
  expect(other).toMatchObject({ proposal: "p2" });
  const otherWindow = await runQuery(s, deps, { ...paidRep(), window: { from: win.from, to: null } });
  expect(otherWindow).toMatchObject({ proposal: "p3" });
});

test("a reused proposal does not ask the engine for another estimate", async () => {
  trino.on(/^explain/i, plan(3));
  const lakeAgent = { ...lakeInput, actor: agent };
  expect(await runQuery(s, deps, lakeAgent)).toEqual({ status: "needs_budget", proposal: "p1", estimate: { amount: 3, unit: "rows" } });
  expect(await runQuery(s, deps, lakeAgent)).toEqual({ status: "needs_budget", proposal: "p1", estimate: { amount: 3, unit: "rows" } });
  expect(trino.statements).toHaveLength(1);
  expect(s.entries().find((e) => e.type === "proposal.created")!.cause).toBe(s.entries().find((e) => e.type === "query.result")!.seq);
});

test("a person runs an accepted proposal from the record alone, even after a restart", async () => {
  await runQuery(s, deps, paidRep());
  const caseId = s.id;
  wb.close();
  wb = Workbench.open(join(dir, "data"), { onError: () => {} });
  s = wb.session(caseId);
  const r = await runProposal(s, deps, { proposal: "p1", budget: 2, actor: human });
  expect(r).toMatchObject({ status: "done", rows: 1 });
  expect(s.state.proposals.p1).toMatchObject({ status: "accepted", budget: 2 });
  const accepted = s.entries().find((e) => e.type === "proposal.accepted")!;
  expect(accepted.payload).toEqual({ proposal: "p1", budget: 2 });
  const issued = s.entries().find((e) => e.type === "query.issued")!;
  expect(issued.cause).toBe(accepted.seq);
  expect(issued.actor).toEqual(human);
  expect(issued.payload).toMatchObject({ pivot: "paid_rep", bound: { value: "198.51.100.77", days: 7 }, window: win, step: "st1", purpose: "result" });
  expect(standin.requests).toHaveLength(1);
  // a proposal runs once
  expect(await runProposal(s, deps, { proposal: "p1", budget: 2, actor: human })).toEqual({ status: "refused", reasons: ["proposal p1 is accepted, not open"] });
});

test("only a person may run a proposal; an unknown, changed or unfunded one is refused and writes nothing", async () => {
  await runQuery(s, deps, paidRep());
  const before = s.head().seq;
  const refusal = async (input: Parameters<typeof runProposal>[2], d: RunnerDeps = deps) => {
    const r = await runProposal(s, d, input);
    expect(r.status).toBe("refused");
    return r.status === "refused" ? r.reasons[0] : "";
  };
  expect(await refusal({ proposal: "p1", budget: 2, actor: agent })).toBe("only a person may accept and run a proposal");
  expect(await refusal({ proposal: "p1", budget: 2, actor: { kind: "system", id: "x" } })).toBe("only a person may accept and run a proposal");
  expect(await refusal({ proposal: "p9", budget: 2, actor: human })).toBe("unknown proposal: p9");
  for (const budget of [0, -1, NaN]) expect(await refusal({ proposal: "p1", budget, actor: human })).toBe("the budget must be a number above zero");
  const real = registry.pivot("paid_rep")!;
  const changed = { ...registry, source: registry.source.bind(registry), pivot: (id: string) => (id === "paid_rep" ? { ...real, hash: "other" } : registry.pivot(id)) } as unknown as Registry;
  expect(await refusal({ proposal: "p1", budget: 2, actor: human }, { ...deps, registry: changed })).toBe("the pivot paid_rep has changed since the proposal");
  const gone = { ...registry, source: () => null, pivot: registry.pivot.bind(registry) } as unknown as Registry;
  expect(await refusal({ proposal: "p1", budget: 2, actor: human }, { ...deps, registry: gone })).toBe("the source rep is no longer loaded");
  expect(s.head().seq).toBe(before);
  expect(standin.requests).toHaveLength(0);
});

test("a proposal carries its source's hash", async () => {
  await runQuery(s, deps, paidRep());
  expect(s.state.proposals.p1).toMatchObject({ source_hash: registry.source("rep")!.hash });
});

test("a proposal whose source has changed is refused and stays open", async () => {
  await runQuery(s, deps, paidRep());
  const file = join(dir, "modules", "sources", "rep.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace("title: Reputation", "title: Reputation, edited"));
  const reloaded = Registry.load([{ path: join(dir, "modules"), trusted: true, credentials: ["REP_KEY"] }]);
  expect(reloaded.source("rep")!.hash).not.toBe(registry.source("rep")!.hash);
  const r = await runProposal(s, { ...deps, registry: reloaded }, { proposal: "p1", budget: 2, actor: human });
  expect(r).toEqual({ status: "refused", reasons: ["the source rep has changed since the proposal"] });
  expect(s.state.proposals.p1!.status).toBe("open");
  expect(standin.requests).toHaveLength(0);
  // an agent asking again does not reuse the proposal made against the old source
  expect(await runQuery(s, { ...deps, registry: reloaded }, paidRep())).toMatchObject({ status: "needs_budget", proposal: "p2" });
});

test("a budget below the fresh estimate leaves the proposal open", async () => {
  await runQuery(s, deps, paidRep());
  const r = await runProposal(s, deps, { proposal: "p1", budget: 0.5, actor: human });
  expect(r.status).toBe("needs_budget");
  expect(s.state.proposals.p1!.status).toBe("open");
  expect(s.entries().some((e) => e.type === "proposal.accepted")).toBe(false);
  expect((await runProposal(s, deps, { proposal: "p1", budget: 1, actor: human })).status).toBe("done");
});

test("a proposal the guard now refuses stays open", async () => {
  await runQuery(s, deps, { ...lakeInput, actor: agent });
  const text = "select * from iceberg.s.events; drop table x";
  // the guard refuses this text, so the person's run is refused before any acceptance is written
  const bad = { ...lakeInput, text, actor: human, budget: 5, accept: { proposal: "p1" } };
  const r = await runQuery(s, deps, bad);
  expect(r.status).toBe("refused");
  expect(s.state.proposals.p1!.status).toBe("open");
  expect(s.entries().some((e) => e.type === "proposal.accepted")).toBe(false);
});

test("accept is ignored unless the actor is a person", async () => {
  await runQuery(s, deps, paidRep());
  for (const actor of [agent, { kind: "system", id: "x" } as Actor]) {
    await runQuery(s, deps, { ...repInput, actor, pivot: registry.pivot("free_rep")!, budget: 2, accept: { proposal: "p1" } });
  }
  expect(s.state.proposals.p1!.status).toBe("open");
  expect(s.entries().some((e) => e.type === "proposal.accepted")).toBe(false);
});

test("the accepted entry is the cause of the query it paid for", async () => {
  await runQuery(s, deps, paidRep());
  await runProposal(s, deps, { proposal: "p1", budget: 2, actor: human });
  const accepted = s.entries().find((e) => e.type === "proposal.accepted")!;
  const result = s.entries().filter((e) => e.type === "query.issued").at(-1)!;
  expect(result.cause).toBe(accepted.seq);
  expect(accepted.cause).toBe(s.state.proposals.p1!.seq);
});

// ---------- final review minor 15 and the Task 6 isCard row ----------
test("a previewed card cell is capped at 4,096 characters; the blob and the result keep the whole value", async () => {
  const long = "x".repeat(20_000);
  const nested = { deep: "y".repeat(5000) };
  const raw = new TextEncoder().encode(JSON.stringify([long]));
  const r = await runQuery(s, stubDeps({ columns: ["dst", "obj", "n"], rows: [[long, nested, 7]], raw }), base);
  expect(r.status).toBe("done");
  const cell = s.state.cards.c1!.rows[0]!;
  expect((cell[0] as string).length).toBe(CARD_CELL_CHARS);
  expect(cell[0]).toEndWith("…");
  expect(typeof cell[1]).toBe("string");
  expect((cell[1] as string).length).toBe(CARD_CELL_CHARS);
  expect(cell[2]).toBe(7);
  if (r.status === "done") {
    expect(r.data[0]![0]).toBe(long);
    expect(r.rows_hash).toBe(rowsHash(["dst", "obj", "n"], [[long, nested, 7]]));
  }
  expect(s.blobs.get(s.state.queries.q1!.result!.blob)).toEqual(raw);
});

test("a card the fold would refuse fails the query whole: no result is recorded without its card", async () => {
  const d = stubDeps({ rows: [["a"]] });
  const broken = { ...d, observables: { columnTypes: () => [5] } as unknown as Observables };
  const r = await runQuery(s, broken, base);
  expect(r).toMatchObject({ status: "failed", error: "the card built from the result is malformed" });
  expect(types()).toEqual(["case.created", "query.issued", "query.failed"]);
  expect(s.state.queries.q1!.status).toBe("failed");
});
