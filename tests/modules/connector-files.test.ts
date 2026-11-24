import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardError } from "../../src/modules/sqlguard";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import type { SourceManifest } from "../../src/modules/manifests";
import { ConnectorError, makeConnector } from "../../src/modules/connectors";
import type { QueryRequest } from "../../src/modules/connectors";

let root: string;
const ctx = { secrets: new Secrets({}, null), observables: new Observables([]) };

function source(over: Partial<SourceManifest> = {}): SourceManifest {
  return {
    id: "logs", title: "Logs", hash: "h1", dir: root, root, connector: "files", location: "data", credential: null, user: null,
    tls_verify: true, marking: "TLP:AMBER", where: "machine", confirmed: true, adhoc: false, cost: { weight: 0, unit: "seconds" },
    limits: { max_rows: 5, timeout_ms: 1000 }, quality: "", quality_notes: [],
    tables: [
      { name: "dns", time_column: "ts", guarded: false, large_columns: [], file: "dns.jsonl", format: "jsonl", columns: [] },
      { name: "assets", time_column: null, guarded: false, large_columns: [], file: "assets.csv", format: "csv", columns: [] },
    ],
    endpoints: [], ...over,
  };
}
function req(text: string, bound: QueryRequest["bound"] = {}, max = 5): QueryRequest {
  return { text, bound, window: { from: null, to: null }, max_rows: max, timeout_ms: 1000, budget: null };
}
const dnsLines = [
  { ts: "2026-01-01T00:00:00Z", client: "192.0.2.17", name: "a.example.org", answer: "198.51.100.1" },
  { ts: "2026-01-01T00:01:00Z", client: "192.0.2.17", name: "b.example.org", answer: "198.51.100.2" },
  { ts: "2026-01-01T00:02:00Z", client: "192.0.2.18", name: "c.example.org", answer: "198.51.100.3", ttl: 30 },
  { ts: "2026-01-01T00:03:00Z", client: "192.0.2.18", name: "d.example.org", answer: "198.51.100.4" },
  { ts: "2026-01-01T00:04:00Z", client: "192.0.2.19", name: "e.example.org", answer: "198.51.100.5" },
  { ts: "2026-01-01T00:05:00Z", client: "192.0.2.19", name: "f.example.org", answer: "198.51.100.6" },
];
const dnsText = (): string => dnsLines.map(l => JSON.stringify(l)).join("\n") + "\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cfiles-"));
  require("node:fs").mkdirSync(join(root, "data"));
  writeFileSync(join(root, "data", "dns.jsonl"), dnsText());
  writeFileSync(join(root, "data", "assets.csv"),
    'asset,address,owner\nlaptop-1,192.0.2.17,"Example, Alice"\nlaptop-2,192.0.2.18,bob\nprinter,192.0.2.19,facilities\n');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test("jsonl and csv files are queryable as tables", async () => {
  const c = makeConnector(source(), ctx);
  const out = await c.run(req("select d.name, a.owner from dns d join assets a on a.address = d.client where d.client = {value}", { value: "192.0.2.17" }));
  expect(out.columns).toEqual(["name", "owner"]);
  expect(out.rows).toEqual([["a.example.org", "Example, Alice"], ["b.example.org", "Example, Alice"]]);
  expect(out.coverage).toEqual({ kind: "full" });
  c.close();
});

test("csv quoting is honoured", async () => {
  const c = makeConnector(source(), ctx);
  const out = await c.run(req("select owner from assets where asset = 'laptop-1'"));
  expect(out.rows).toEqual([["Example, Alice"]]);
  c.close();
});

test("numbers in jsonl stay numbers and missing keys are null", async () => {
  const c = makeConnector(source({
    tables: [{ name: "dns", time_column: null, guarded: false, large_columns: [], file: "dns.jsonl", format: "jsonl", columns: [{ name: "name", type: null }, { name: "ttl", type: null }] }],
  }), ctx);
  const out = await c.run(req("select name, ttl from dns where name in ('a.example.org', 'c.example.org') order by name"));
  expect(out.rows).toEqual([["a.example.org", null], ["c.example.org", 30]]);
  c.close();
});

test("a blank or malformed jsonl line is skipped and reported as partial coverage", async () => {
  writeFileSync(join(root, "data", "dns.jsonl"), dnsText() + "{not json\n");
  const c = makeConnector(source(), ctx);
  const out = await c.run(req("select name from dns", {}, 100));
  expect(out.rows).toHaveLength(6);
  expect(out.coverage).toEqual({ kind: "partial", reason: "source_error", detail: "1 unreadable line in dns.jsonl" });
  c.close();
});

test("a changed file is re-read on the next query", async () => {
  const c = makeConnector(source(), ctx);
  expect((await c.run(req("select count(*) from dns"))).rows).toEqual([[6]]);
  const p = join(root, "data", "dns.jsonl");
  writeFileSync(p, dnsText() + JSON.stringify({ ts: "2026-01-02T00:00:00Z", client: "192.0.2.17", name: "g.example.org", answer: "198.51.100.7" }) + "\n");
  utimesSync(p, new Date(), new Date(Date.now() + 5000));
  expect((await c.run(req("select count(*) from dns"))).rows).toEqual([[7]]);
  c.close();
});

test("a table whose file is missing is a ConnectorError naming the file", async () => {
  const c = makeConnector(source({
    tables: [{ name: "gone", time_column: null, guarded: false, large_columns: [], file: "gone.csv", format: "csv", columns: [] }],
  }), ctx);
  const err = await c.run(req("select * from gone")).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectorError);
  expect((err as Error).message).toContain("gone.csv");
});

test("a table file that escapes the module root is refused", async () => {
  const c = makeConnector(source({
    tables: [{ name: "x", time_column: null, guarded: false, large_columns: [], file: "../../../etc/hostname", format: "csv", columns: [] }],
  }), ctx);
  await expect(c.run(req("select * from x"))).rejects.toBeInstanceOf(ConnectorError);
});

test("writes are refused", async () => {
  const c = makeConnector(source(), ctx);
  await expect(c.run(req("delete from dns"))).rejects.toBeInstanceOf(GuardError);
  await expect(c.run(req("drop table assets"))).rejects.toBeInstanceOf(GuardError);
  expect((await c.run(req("select count(*) from dns"))).rows).toEqual([[6]]);
  c.close();
});

test("the row cap applies", async () => {
  const c = makeConnector(source(), ctx);
  const out = await c.run(req("select * from dns"));
  expect(out.rows).toHaveLength(5);
  expect(out.coverage).toEqual({ kind: "partial", reason: "row_limit", detail: "stopped at 5 rows" });
  c.close();
});

// ---------- final review finding 5: a declared column the file lacks is an error, not a column of nulls ----------
test("a csv header without a declared column is a ConnectorError naming the column and file", async () => {
  writeFileSync(join(root, "data", "assets.csv"), "asset,ip\nlaptop-1,192.0.2.17\n");
  const declared = source({ tables: [{ name: "assets", time_column: null, guarded: false, large_columns: [], file: "assets.csv", format: "csv", columns: [{ name: "asset", type: null }, { name: "address", type: null }] }] });
  const c = makeConnector(declared, ctx);
  const err = await c.run(req("select asset from assets where address = {v}", { v: "192.0.2.17" })).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectorError);
  expect((err as Error).message).toBe("file assets.csv for table assets has no column address, which the manifest declares");
});

test("json lines none of which has a declared column are a ConnectorError; a key missing from some lines is not", async () => {
  const table = (cols: string[]) => source({ tables: [{ name: "dns", time_column: "ts", guarded: false, large_columns: [], file: "dns.jsonl", format: "jsonl", columns: cols.map(name => ({ name, type: null })) }] });
  const err = await makeConnector(table(["ts", "client", "qname"]), ctx).run(req("select ts from dns")).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectorError);
  expect((err as Error).message).toContain("has no column qname");
  expect((err as Error).message).toContain("dns.jsonl");
  const ok = await makeConnector(table(["ts", "ttl"]), ctx).run(req("select ttl from dns where ttl is not null"));
  expect(ok.rows).toEqual([[30]]);
  expect(ok.coverage).toEqual({ kind: "full" });
});

test("a query that never ends is stopped at timeout_ms and does not block the thread", async () => {
  const c = makeConnector(source(), ctx);
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  let out;
  try {
    out = await c.run({ ...req("with recursive n(x) as (select 1 union all select x + 1 from n) select count(*) as c from n"), timeout_ms: 300, max_rows: 10 });
  } finally {
    clearInterval(timer);
  }
  expect(out.coverage).toEqual({ kind: "partial", reason: "timeout", detail: "no complete result within 300 ms" });
  expect(out.rows).toEqual([]);
  expect(ticks).toBeGreaterThan(5);
  // the next query starts a new worker, which loads the files again
  expect((await c.run(req("select count(*) from dns"))).rows).toEqual([[6]]);
  c.close();
});

test("a file changed after a timeout is read afresh by the new worker, and notes about unreadable lines survive the worker", async () => {
  const c = makeConnector(source(), ctx);
  const p = join(root, "data", "dns.jsonl");
  writeFileSync(p, dnsText() + "not json\n");
  const out = await c.run(req("select count(*) from dns"));
  expect(out.rows).toEqual([[6]]);
  expect(out.coverage).toEqual({ kind: "partial", reason: "source_error", detail: "1 unreadable line in dns.jsonl" });
  c.close();
});
