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
import { CARD_PREVIEW_ROWS, rowsHash, runQuery } from "../../src/modules/runner";
import type { RunnerDeps, RunQueryInput } from "../../src/modules/runner";
import { startStandin } from "../helpers/http-standin";
import type { Standin } from "../helpers/http-standin";

const human: Actor = { kind: "human", id: "analyst" };
const agent: Actor = { kind: "agent", id: "a1", stage: "gather", profile: "p", model: "m", effort: null, where: "machine" };
const win: TimeWindow = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };

let dir: string;
let wb: Workbench;
let s: CaseSession;
let standin: Standin;
let registry: Registry;
let pool: ConnectorPool;
let deps: RunnerDeps;
const observables = new Observables([{ id: "address", title: "Address", pattern: "^(?:\\d{1,3}\\.){3}\\d{1,3}$" }]);

const SOURCES = (url: string): Record<string, string> => ({
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
  for (const [name, text] of Object.entries(SOURCES(standin.url))) writeFileSync(join(root, name), text);
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
  const r = await runQuery(s, deps, { ...none, pivot: registry.pivot("peers")! });
  expect(r).toMatchObject({ status: "done", outcome: "empty", rows: 0 });
  expect(s.state.cards.c1).toMatchObject({ empty: "proven-negative", body: "No rows · proven negative", coverage: { kind: "full" } });
});

test("zero rows on a not-seen pivot is not a proven negative", async () => {
  await runQuery(s, deps, { ...none, pivot: registry.pivot("seen")! });
  expect(s.state.cards.c1).toMatchObject({ empty: "not-seen", body: "No rows · not seen (not proof of absence)" });
});

test("zero rows with partial coverage is never a proven negative", async () => {
  const r = await runQuery(s, stubDeps({ coverage: { kind: "partial", reason: "timeout" } }), { ...none, pivot: registry.pivot("peers")! });
  expect(r).toMatchObject({ status: "done", outcome: "partial" });
  expect(s.state.cards.c1).toMatchObject({ empty: "not-seen", coverage: { kind: "partial", reason: "timeout" } });
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
