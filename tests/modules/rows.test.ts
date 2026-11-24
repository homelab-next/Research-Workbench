import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../src/core/workbench";
import type { CaseSession } from "../../src/core/session";
import type { Actor, Payloads, TimeWindow } from "../../src/core/types";
import { Registry } from "../../src/modules/registry";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import { ConnectorPool } from "../../src/modules/connectors";
import { rowsOfBlob } from "../../src/modules/connectors/rows";
import { runQuery, rowsHash } from "../../src/modules/runner";
import type { RunnerDeps } from "../../src/modules/runner";
import { startStandin } from "../helpers/http-standin";
import type { Standin } from "../helpers/http-standin";
import { startTrino } from "../helpers/trino-standin";
import type { TrinoStandin } from "../helpers/trino-standin";

const human: Actor = { kind: "human", id: "analyst" };
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rows-"));
  const root = join(dir, "modules");
  standin = startStandin({
    "GET /v1/reputation/198.51.100.77": () => new Response(JSON.stringify({ meta: { n: 2 }, results: [{ address: "198.51.100.77", verdict: "suspicious", extra: 1 }, { address: "198.51.100.78", verdict: "clean" }] }), { headers: { "content-type": "application/json" } }),
  });
  trino = startTrino();
  trino.on(/iceberg/, { columns: ["a", "n"], pages: [[["192.0.2.1", 1]], [["192.0.2.2", 2], ["192.0.2.3", null]]] });
  mkdirSync(join(root, "sources", "data"), { recursive: true });
  const files: Record<string, string> = {
    "sources/flows.yaml": `kind: source\nid: flows\ntitle: Flows\nconnector: sql\nlocation: flows.db\nmarking: "TLP:GREEN"\nwhere: machine\n`,
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
location: ${standin.url}
credential: REP_KEY
marking: "TLP:AMBER"
where: hosted
adhoc: false
endpoints:
  - { name: reputation, method: GET, path: "/v1/reputation/{value}?days={days}", read: true, rows: results, columns: [address, verdict] }
  - { name: other, method: GET, path: "/v1/reputation/{value}", read: true, rows: results, columns: [verdict] }
`,
    "sources/lake.yaml": `kind: source
id: lake
title: Lake
connector: trino
location: ${trino.url}
user: workbench
marking: "TLP:AMBER"
where: machine
confirmed: true
cost: { weight: 0, unit: rows }
tables:
  - { name: iceberg.s.events, time_column: ts, guarded: true, columns: [] }
`,
    "types.yaml": `kind: types\ntypes:\n  - { id: address, title: Address, pattern: '^(?:\\\\d{1,3}\\\\.){3}\\\\d{1,3}$' }\n`,
    "pivots.yaml": `kind: pivots\npivots: []\n`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  writeFileSync(join(root, "sources", "data", "assets.csv"), "asset,address\nlaptop-1,192.0.2.17\nlaptop-2,192.0.2.18\n");
  const db = new Database(join(root, "sources", "flows.db"));
  db.run("create table flows (ts TEXT, src TEXT, dst TEXT, bytes INTEGER, note BLOB)");
  db.run("insert into flows values ('2026-01-01T00:00:00.000Z', '192.0.2.17', '198.51.100.1', 100, null)");
  db.run("insert into flows values ('2026-01-02T00:00:00.000Z', '192.0.2.17', '198.51.100.2', 99, x'0102')");
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

const REQUESTS: Record<string, { source: string; text: string; bound: Record<string, string | number> }> = {
  sql: { source: "flows", text: "select dst, bytes, note from flows where src = {value}", bound: { value: "192.0.2.17" } },
  files: { source: "assets", text: "select asset, address from assets", bound: {} },
  http: { source: "rep", text: "reputation", bound: { value: "198.51.100.77", days: 7 } },
  trino: { source: "lake", text: "select a, n from iceberg.s.events where ts >= {window.from} and ts < {window.to}", bound: {} },
};

const recorded = (q: string): { issued: Payloads["query.issued"]; result: Payloads["query.result"] } => ({
  issued: s.entries().find((e) => e.type === "query.issued" && (e.payload as { query: string }).query === q)!.payload as Payloads["query.issued"],
  result: s.entries().find((e) => e.type === "query.result" && (e.payload as { query: string }).query === q)!.payload as Payloads["query.result"],
});

test.each(["sql", "files", "http", "trino"])("a stored %s result reads back to the rows it was recorded with", async (kind) => {
  const r = await runQuery(s, deps, { ...REQUESTS[kind]!, window: win, why: "read back", actor: human });
  expect(r.status).toBe("done");
  const { issued, result } = recorded("q1");
  const source = registry.source(issued.source)!;
  const back = rowsOfBlob(source, issued, s.blobs.get(result.result.blob))!;
  expect(back).not.toBeNull();
  expect(back.rows.length).toBe(result.rows);
  expect(rowsHash(back.columns, back.rows)).toBe(result.rows_hash);
});

test("the http reader finds the endpoint the text was rendered from, and reads only its columns", async () => {
  await runQuery(s, deps, { ...REQUESTS.http!, window: win, why: "x", actor: human });
  const { issued, result } = recorded("q1");
  const back = rowsOfBlob(registry.source("rep")!, issued, s.blobs.get(result.result.blob))!;
  expect(back.columns).toEqual(["address", "verdict"]);
  expect(back.rows).toEqual([["198.51.100.77", "suspicious"], ["198.51.100.78", "clean"]]);
});

test("bytes that are not a result read back as null", async () => {
  for (const kind of ["sql", "files", "http", "trino"]) {
    const q = await runQuery(s, deps, { ...REQUESTS[kind]!, window: win, why: "x", actor: human });
    expect(q.status).toBe("done");
  }
  for (const [n, kind] of ["sql", "files", "http", "trino"].entries()) {
    const { issued } = recorded(`q${n + 1}`);
    const source = registry.source(issued.source)!;
    const junk = new TextEncoder().encode("not a result at all");
    expect([kind, rowsOfBlob(source, issued, junk)]).toEqual([kind, null]);
    expect([kind, rowsOfBlob(source, issued, new TextEncoder().encode('{"x":1}'))]).toEqual([kind, null]);
  }
});

test("an http result whose endpoint is gone from the source reads back as null", async () => {
  await runQuery(s, deps, { ...REQUESTS.http!, window: win, why: "x", actor: human });
  const { issued, result } = recorded("q1");
  const source = { ...registry.source("rep")!, endpoints: [] };
  expect(rowsOfBlob(source, issued, s.blobs.get(result.result.blob))).toBeNull();
});
