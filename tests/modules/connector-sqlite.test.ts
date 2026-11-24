import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardError } from "../../src/modules/sqlguard";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import type { SourceManifest } from "../../src/modules/manifests";
import { ConnectorError, MAX_TS, MIN_TS } from "../../src/modules/connectors/types";
import { effectiveBound, placeholders } from "../../src/modules/connectors/placeholders";
import { ConnectorPool, makeConnector } from "../../src/modules/connectors";
import { SqliteConnector } from "../../src/modules/connectors/sqlite";
import type { QueryRequest } from "../../src/modules/connectors";

let root: string;
const ctx = { secrets: new Secrets({}, null), observables: new Observables([]) };

function source(over: Partial<SourceManifest> = {}): SourceManifest {
  return {
    id: "flows", title: "Flows", hash: "h1", dir: root, root, connector: "sql", location: "flows.db", credential: null, user: null,
    tls_verify: true, marking: "TLP:AMBER", where: "machine", confirmed: true, adhoc: false, cost: { weight: 0, unit: "seconds" },
    limits: { max_rows: 5, timeout_ms: 1000 }, quality: "", quality_notes: [], tables: [], endpoints: [], ...over,
  };
}
function req(text: string, bound: QueryRequest["bound"] = {}, window: QueryRequest["window"] = { from: null, to: null }): QueryRequest {
  return { text, bound, window, max_rows: 5, timeout_ms: 1000, budget: null };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "csql-"));
  const db = new Database(join(root, "flows.db"));
  db.run("create table flows (ts TEXT, src TEXT, dst TEXT, bytes INTEGER)");
  for (let i = 0; i < 10; i++) {
    db.run("insert into flows values (?, ?, ?, ?)", [`2026-01-0${(i % 9) + 1}T00:00:00.000Z`, i < 6 ? "192.0.2.17" : "192.0.2.18", `198.51.100.${i}`, 100 - i]);
  }
  db.close();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const make = (): SqliteConnector => makeConnector(source(), ctx) as SqliteConnector;

test("placeholders lists names in order of first use and effectiveBound fills open ends", () => {
  expect(placeholders("a {x} b {window.from} {x}")).toEqual(["x", "window.from"]);
  expect(effectiveBound(req("x", { v: 1 }))).toEqual({ v: 1, "window.from": MIN_TS, "window.to": MAX_TS });
});

test("render replaces placeholders with named parameters", () => {
  const c = make();
  expect(c.render(req("select dst from flows where src = {value} and ts >= {window.from} and ts < {window.to}")))
    .toBe("select dst from flows where src = $value and ts >= $window_from and ts < $window_to");
  c.close();
});

test("run binds values instead of pasting them", async () => {
  const c = make();
  const out = await c.run(req("select dst from flows where src = {value}", { value: "192.0.2.17' OR '1'='1" }));
  expect(out.rows).toEqual([]);
  c.close();
});

test("run returns columns, rows and the raw bytes as JSON", async () => {
  const c = make();
  const out = await c.run(req("select src, bytes from flows where src = {value} order by bytes limit 2", { value: "192.0.2.17" }));
  expect(out.columns).toEqual(["src", "bytes"]);
  expect(out.rows).toHaveLength(2);
  expect(out.rows[0]).toEqual(["192.0.2.17", 95]);
  expect(out.media).toBe("application/json");
  expect(JSON.parse(new TextDecoder().decode(out.raw))).toEqual({ columns: out.columns, rows: out.rows });
  expect(out.coverage).toEqual({ kind: "full" });
  c.close();
});

test("an open window binds the minimum and maximum timestamps", async () => {
  const c = make();
  const open = await c.run(req("select {window.from} as a, {window.to} as b"));
  expect(open.rows).toEqual([[MIN_TS, MAX_TS]]);
  const closed = await c.run(req("select {window.from} as a, {window.to} as b", {}, { from: "2026-01-02T00:00:00.000Z", to: null }));
  expect(closed.rows).toEqual([["2026-01-02T00:00:00.000Z", MAX_TS]]);
  c.close();
});

test("stopping at the row cap is partial coverage", async () => {
  const c = make();
  const out = await c.run(req("select * from flows"));
  expect(out.rows).toHaveLength(5);
  expect(out.coverage).toEqual({ kind: "partial", reason: "row_limit", detail: "stopped at 5 rows" });
  const exact = await c.run(req("select * from flows limit 5"));
  expect(exact.coverage).toEqual({ kind: "full" });
  c.close();
});

test("duplicate column names are refused rather than silently collapsed", async () => {
  const c = make();
  await expect(c.run(req("select src, src from flows limit 1"))).rejects.toBeInstanceOf(ConnectorError);
  c.close();
});

test("a write is refused before it reaches the database", async () => {
  const c = make();
  expect(() => c.render(req("delete from flows"))).toThrow(GuardError);
  await expect(c.run(req("delete from flows"))).rejects.toThrow(GuardError);
  await expect(c.run(req("select 1; delete from flows"))).rejects.toThrow(GuardError);
  expect((await c.run(req("select count(*) from flows limit 1"))).rows).toEqual([[10]]);
  c.close();
});

test("the database is opened read-only", async () => {
  const c = make();
  await c.run(req("select 1"));
  expect(() => c.handle.run("delete from flows")).toThrow();
  c.close();
});

test("a placeholder with no bound value is refused", async () => {
  const c = make();
  const err = await c.run(req("select * from flows where src = {missing}")).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectorError);
  expect((err as Error).message).toContain("{missing}");
  c.close();
});

test("a missing database file is a ConnectorError", async () => {
  const c = makeConnector(source({ location: "nope.db" }), ctx);
  await expect(c.run(req("select 1"))).rejects.toBeInstanceOf(ConnectorError);
});

test("a database that is not inside the module root is refused when opened", async () => {
  const outside = mkdtempSync(join(tmpdir(), "csql-out-"));
  try {
    new Database(join(outside, "x.db")).close();
    symlinkSync(join(outside, "x.db"), join(root, "link.db"));
    const c = makeConnector(source({ location: "link.db" }), ctx);
    await expect(c.run(req("select 1"))).rejects.toBeInstanceOf(ConnectorError);
    const d = makeConnector(source({ location: "../" + outside.split("/").pop() + "/x.db" }), ctx);
    await expect(d.run(req("select 1"))).rejects.toBeInstanceOf(ConnectorError);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("load_extension is refused", async () => {
  const c = make();
  await expect(c.run(req("select load_extension('x')"))).rejects.toBeInstanceOf(GuardError);
  c.close();
});

test("estimate is null", async () => {
  const c = make();
  expect(await c.estimate(req("select 1"))).toBeNull();
  c.close();
});

test("makeConnector refuses a kind it does not know, and the pool rebuilds on a new hash", () => {
  expect(() => makeConnector(source({ connector: "nosuch" as SourceManifest["connector"] }), ctx)).toThrow(ConnectorError);
  const pool = new ConnectorPool(ctx);
  const a = pool.for(source());
  expect(pool.for(source())).toBe(a);
  const b = pool.for(source({ hash: "h2" }));
  expect(b).not.toBe(a);
  pool.closeAll();
});

// ---------- local queries run in a worker and stop at their timeout ----------
const FOREVER = "with recursive n(x) as (select 1 union all select x + 1 from n) select count(*) as c from n";
const forever = (timeout_ms: number): QueryRequest => ({ text: FOREVER, bound: {}, window: { from: null, to: null }, max_rows: 10, timeout_ms, budget: null });

test("a query that never ends is stopped at timeout_ms and does not block the thread", async () => {
  const c = make();
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  let out;
  try {
    out = await c.run(forever(300));
  } finally {
    clearInterval(timer);
    c.close();
  }
  expect(out.coverage).toEqual({ kind: "partial", reason: "timeout", detail: "no complete result within 300 ms" });
  expect(out.rows).toEqual([]);
  expect(out.columns).toEqual([]);
  expect(out.media).toBe("application/json");
  expect(out.cost).toBeNull();
  expect(new TextDecoder().decode(out.raw)).toBe('{"columns":[],"rows":[]}');
  expect(ticks).toBeGreaterThan(5);
});

test("the next query on the same connector runs in a new worker", async () => {
  const c = make();
  try {
    expect((await c.run(forever(200))).coverage).toMatchObject({ kind: "partial", reason: "timeout" });
    const out = await c.run(req("select src from flows where dst = {v}", { v: "198.51.100.1" }));
    expect(out.coverage).toEqual({ kind: "full" });
    expect(out.rows).toEqual([["192.0.2.17"]]);
  } finally { c.close(); }
});

test("queries on one connector run one at a time, in order", async () => {
  const c = make();
  try {
    const [a, b, d] = await Promise.all([
      c.run(req("select 1 as one")), c.run(req("select 2 as two")), c.run(req("select 3 as three")),
    ]);
    expect([a.rows, b.rows, d.rows]).toEqual([[[1]], [[2]], [[3]]]);
  } finally { c.close(); }
});

test("a query the database refuses is a ConnectorError, and a write is still refused before it is posted", async () => {
  const c = make();
  try {
    await expect(c.run(req("select * from nosuchtable"))).rejects.toBeInstanceOf(ConnectorError);
    await expect(c.run(req("delete from flows"))).rejects.toThrow(GuardError);
    expect((await c.run(req("select count(*) from flows"))).rows).toEqual([[10]]);
  } finally { c.close(); }
});

test("a timed-out query leaves no busy process behind: the script exits on its own, the CPU is idle, the file can be written", () => {
  new Database(join(root, "w.db")).run("create table t(x)");
  const t0 = Date.now();
  const r = Bun.spawnSync(["bun", "run", "tests/helpers/local-timeout.ts", join(root, "w.db")], { cwd: join(import.meta.dir, "../.."), timeout: 15000 });
  expect(r.exitCode).toBe(0);
  expect(Date.now() - t0).toBeLessThan(10000);
  const said = JSON.parse(r.stdout.toString()) as { coverage: unknown; idleCpuMs: number };
  expect(said.coverage).toEqual({ kind: "partial", reason: "timeout", detail: "no complete result within 400 ms" });
  expect(said.idleCpuMs).toBeLessThan(200);
});

test("closing the connector ends its worker", async () => {
  const c = make();
  await c.run(req("select 1"));
  c.close();
  // a closed connector starts a new worker when it is used again
  expect((await c.run(req("select 2 as two"))).rows).toEqual([[2]]);
  c.close();
});
