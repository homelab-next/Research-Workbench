import { expect, test } from "bun:test";
import { GuardError, assertReadOnly, checkGuardedShape, checkGuardrails, stripForAnalysis, type TableGuard } from "../../src/modules/sqlguard";

test.each([
  "select 1",
  "SELECT a FROM t WHERE b = 'x;y'",
  "with x as (select 1) select * from x",
  "show tables from iceberg.s",
  "describe iceberg.s.t",
  "explain select 1",
  "explain analyze select 1",
  "explain (type io, format json) select 1",
  "select 1;",
  "select update_time, deleted_at from t",
  "select 'drop table t' as s",
  "-- note\nselect 1",
  "select replace(name, 'a', 'b') from t",
  'select "set", call_count from t',
  "select 'a''b; drop table t' as s",
  "select /* ; delete */ 1",
  "select m['k'], arr[1], ARRAY[1,2] from t",
  "select truncate(x), merge(h) from t",
  "show create table a.b.c",
])("allows read: %s", sql => { expect(() => assertReadOnly(sql)).not.toThrow(); });

test.each([
  ["insert into t values (1)", "write"],
  ["with x as (select 1) delete from t", "write"],
  ["select 1; drop table t", "one statement"],
  ["select 1; select 2", "one statement"],
  ["/* hi */ update t set a = 1", "write"],
  ["explain analyze delete from t", "write"],
  ["create table t (a int)", "write"],
  ["pragma journal_mode = wal", "write"],
  ["attach database 'x' as y", "write"],
  ["call system.sync()", "write"],
  ["set session x = 1", "write"],
  ["", "empty"],
  ["   ", "empty"],
  ["-- only a comment", "empty"],
  ["with x as (select 1) replace into t select * from x", "write"],
  ["explain analyze call system.sync()", "write"],
  ["explain analyze insert into t values (1)", "write"],
  ["explain (type io) set session x = 1", "write"],
  ["select 1; /* x */ select 2", "one statement"],
  ["select 1 where x = 'a'; drop table t", "one statement"],
  ["copy t to 'x'", "write"],
  ["(select 1)", "write"],
  ["select `a'` from t; drop table t", "backtick"],
  ["select [a'] from t; drop table t", "bracket"],
  ["select [--] from t; drop table t", "bracket"],
  ["select [/*] from t; drop table t", "bracket"],
  ["select `--` from t; delete from t", "backtick"],
  ["select (1) [x] from t", "bracket"],
  ["truncate table t", "write"],
  ["merge into t using s on t.a = s.a when matched then delete", "write"],
  ["select load_extension('x')", "write"],
])("refuses: %s", (sql, why) => {
  expect(() => assertReadOnly(sql)).toThrow(GuardError);
  try { assertReadOnly(sql); } catch (e) { expect((e as GuardError).violations.join(" ")).toContain(why); }
});

const guards: TableGuard[] = [{ table: "iceberg.wazuh_archive.events", time_column: "event_timestamp", large_columns: ["full_log"] }];
const ok = "select rule_id, count(*) c from iceberg.wazuh_archive.events where event_timestamp >= timestamp '2026-11-20 00:00:00 UTC' group by rule_id order by c desc limit 50";
test("a bounded, projected, limited query passes", () => { expect(checkGuardrails(ok, guards)).toEqual([]); });
test("a query on an unguarded table is not checked", () => { expect(checkGuardrails("select * from other", guards)).toEqual([]); });
test.each([
  ["select rule_id from iceberg.wazuh_archive.events", "time filter"],
  ["select * from iceberg.wazuh_archive.events where event_timestamp > now() - interval '1' day", "select *"],
  ["select e.* from iceberg.wazuh_archive.events e where event_timestamp > now() - interval '1' day", "select *"],
  ["select count(distinct agent_id) from iceberg.wazuh_archive.events where event_timestamp > now() - interval '1' day", "approx_distinct"],
  ["select rule_id from iceberg.wazuh_archive.events where event_timestamp > now() - interval '1' day order by rule_id", "limit"],
  ["select rule_id from iceberg.wazuh_archive.events where event_timestamp >= timestamp '2026-11-20 00:00:00'", "time zone"],
  ["select rule_id from iceberg.wazuh_archive.events where 'event_timestamp > 1' = 'x'", "time filter"],
  ["select a, * from iceberg.wazuh_archive.events where event_timestamp > now() - interval '1' day", "select *"],
])("violation: %s", (sql, why) => { expect(checkGuardrails(sql, guards).join(" ")).toContain(why); });

const W = "iceberg.wazuh_archive.events";
const tf = "event_timestamp > now() - interval '1' day";
test("whitespace or comments between the dots do not hide a guarded table", () => {
  expect(checkGuardrails("select a from iceberg . wazuh_archive . events", guards).join(" ")).toContain("time filter");
  expect(checkGuardrails("select a from iceberg /* x */ . wazuh_archive\n.events", guards).join(" ")).toContain("time filter");
});
test("a window order by needs no limit, a top-level one still does", () => {
  expect(checkGuardrails(`select row_number() over (partition by a order by ts) from ${W} where ${tf}`, guards)).toEqual([]);
  expect(checkGuardrails(`select row_number() over (partition by a order by ts) from ${W} where ${tf} order by a`, guards).join(" ")).toContain("limit");
});
test("named zones and +hhmm offsets pass; comments are not read", () => {
  for (const z of ["2026-01-01 00:00:00 America/New_York", "2026-01-01 00:00:00 +0200", "2026-01-01 00:00:00 utc"]) {
    expect(checkGuardrails(`select a from ${W} where event_timestamp >= timestamp '${z}' limit 1`, guards)).toEqual([]);
  }
  expect(checkGuardrails(`select a from ${W} where ${tf} limit 1 -- timestamp '2026-01-01 00:00:00'`, guards)).toEqual([]);
  expect(checkGuardrails(`select a from ${W} where event_timestamp >= timestamp '2026-01-01 00:00:00' limit 1`, guards).join(" ")).toContain("time zone");
});
test("count(*) is not select *", () => {
  expect(checkGuardrails("select count(*) from iceberg.wazuh_archive.events where event_timestamp > now() - interval '1' day", guards)).toEqual([]);
});
test("zone offsets and Z are accepted", () => {
  for (const z of ["2026-11-20T00:00:00Z", "2026-11-20 00:00:00 +02:00", "2026-11-20 00:00:00 -05:30"]) {
    expect(checkGuardrails(`select a from iceberg.wazuh_archive.events where event_timestamp >= timestamp '${z}' limit 1`, guards)).toEqual([]);
  }
});
test("several violations are all reported", () => {
  const v = checkGuardrails("select * from iceberg.wazuh_archive.events", guards);
  expect(v.length).toBe(2);
});
test("the table name matches case-insensitively and when quoted", () => {
  const v = checkGuardrails('select a from "ICEBERG"."wazuh_archive"."events"', guards);
  expect(v.join(" ")).toContain("time filter");
});
test("stripForAnalysis removes comments and empties literals", () => {
  expect(stripForAnalysis("SELECT 'a;b' -- x\n FROM t /* y */")).toBe("select '' from t");
});

const gs: TableGuard[] = [{ table: "lake.archive.events", time_column: "event_time", large_columns: ["raw_line"] }];
const lit = { from: "TIMESTAMP '2026-11-20 00:00:00.000 UTC'", to: "TIMESTAMP '2026-11-23 00:00:00.000 UTC'" };
const head = `from lake.archive.events where event_time >= ${lit.from} and event_time < ${lit.to}`;

test.each([
  `select host_id, count(*) c ${head} group by host_id order by c desc limit 50`,
  `select a ${head}`,
  `select a ${head} and a = 'x or y join z with w'`,
  `select e.a from lake.archive.events e where e.event_time >= ${lit.from} and e.event_time < ${lit.to} and e.a in ('x', 'y') limit 5`,
  `select e.a from lake.archive.events as e where e.event_time >= ${lit.from} and e.event_time < ${lit.to}`,
  `EXPLAIN (TYPE IO, FORMAT JSON) select a ${head} limit 5`,
  "describe lake.archive.events",
  "show columns from lake.archive.events",
  "select * from other join third on 1 = 1 or 2 = 2",
])("the guarded shape allows: %s", (sql) => { expect(checkGuardedShape(sql, gs, lit)).toEqual([]); });

test.each([
  [`select a ${head} and a = 1 or 1 = 1`, "or are not allowed"],
  [`select a from lake.archive.events e join other o on e.k = o.k where o.event_time >= ${lit.from} and o.event_time < ${lit.to}`, "join"],
  [`select a ${head} union all select a from other`, "union"],
  [`with x as (select a ${head}) select a from x`, "with"],
  [`select a from lake.archive.events where a = 1 and event_time >= ${lit.from} and event_time < ${lit.to}`, "must begin with event_time"],
  [`select a from lake.archive.events where event_time >= ${lit.from}`, "must begin with event_time"],
  [`select a from lake.archive.events where event_time >= TIMESTAMP '2020-01-01 00:00:00.000 UTC' and event_time < ${lit.to}`, "must begin with event_time"],
  [`select a from lake.archive.events where event_time > now() - interval '1' day`, "must begin with event_time"],
  [`select a from lake.archive.events where not (event_time >= ${lit.from} and event_time < ${lit.to})`, "must begin with event_time"],
  [`select a from lake.archive.events, other where event_time >= ${lit.from} and event_time < ${lit.to}`, "must begin with event_time"],
  [`select a as "event_time >= x" from lake.archive.events`, "must begin with event_time"],
  [`select a ${head} and b in (select b from lake.archive.events)`, "names it once"],
  [`select extract(hour from event_time) ${head}`, "names it once"],
  ['select a from "lake"."archive"."events$partitions"', "metadata tables"],
  ["select a from lake.archive.events$files", "metadata tables"],
  ["show stats for lake.archive.events", "names it once"],
  // comments and further statements cannot carry a rule across, and a quoted alias is not the column
  [`select a from lake.archive.events /* where event_time >= ${lit.from} and event_time < ${lit.to} */`, "must begin with event_time"],
  [`select a from lake.archive.events -- ${head}\n`, "must begin with event_time"],
  [`select a from lake.archive.events where "event_time" >= ${lit.from} and event_time < ${lit.to}`, "must begin with event_time"],
  [`select a from lake.archive.events where event_time >= ${lit.from} and event_time < ${lit.to} + interval '1' year`, "must begin with event_time"],
  [`select a from lake.archive.events where event_time >= ${lit.from} and event_time < ${lit.to} intersect select a from other`, "intersect"],
  [`select a from lake.archive.events where event_time >= ${lit.from} and event_time < ${lit.to} except select a from other`, "except"],
  [`select a from lake.archive.events where event_time >= ${lit.from} and event_time < ${lit.to} and b in (select b from other)`, "names it once"],
])("the guarded shape refuses: %s", (sql, why) => { expect(checkGuardedShape(sql, gs, lit).join(" ")).toContain(why); });

test("an open window is refused on a guarded table and ignored on any other", () => {
  expect(checkGuardedShape(`select a ${head}`, gs, null)).toEqual(["a guarded table needs a bounded window"]);
  expect(checkGuardedShape("select a from other", gs, null)).toEqual([]);
});
test("a quoted alias is not a limit", () => {
  expect(checkGuardrails(`select a as "limit" ${head} order by a`, gs).join(" ")).toContain("a sort needs a limit");
});
test("a quoted alias is not a time filter", () => {
  expect(checkGuardrails('select a as "event_time >= x" from lake.archive.events', gs).join(" ")).toContain("needs a time filter");
});
