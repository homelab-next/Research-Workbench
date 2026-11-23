import { expect, test } from "bun:test";
import { GuardError, assertReadOnly, checkGuardrails, stripForAnalysis, type TableGuard } from "../../src/modules/sqlguard";

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
