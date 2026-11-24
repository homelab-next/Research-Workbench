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

const guards: TableGuard[] = [{ table: "lake.archive.events", time_column: "event_time", large_columns: ["raw_line"] }];
const ok = "select rule_id, count(*) c from lake.archive.events where event_time >= timestamp '2026-11-20 00:00:00 UTC' group by rule_id order by c desc limit 50";
test("a bounded, projected, limited query passes", () => { expect(checkGuardrails(ok, guards)).toEqual([]); });
test("a query on an unguarded table is not checked", () => { expect(checkGuardrails("select * from other", guards)).toEqual([]); });
test.each([
  ["select rule_id from lake.archive.events", "time filter"],
  ["select * from lake.archive.events where event_time > now() - interval '1' day", "select *"],
  ["select e.* from lake.archive.events e where event_time > now() - interval '1' day", "select *"],
  ["select count(distinct host_id) from lake.archive.events where event_time > now() - interval '1' day", "approx_distinct"],
  ["select rule_id from lake.archive.events where event_time > now() - interval '1' day order by rule_id", "limit"],
  ["select rule_id from lake.archive.events where event_time >= timestamp '2026-11-20 00:00:00'", "time zone"],
  ["select rule_id from lake.archive.events where 'event_time > 1' = 'x'", "time filter"],
  ["select a, * from lake.archive.events where event_time > now() - interval '1' day", "select *"],
])("violation: %s", (sql, why) => { expect(checkGuardrails(sql, guards).join(" ")).toContain(why); });

const W = "lake.archive.events";
const tf = "event_time > now() - interval '1' day";
test("whitespace or comments between the dots do not hide a guarded table", () => {
  expect(checkGuardrails("select a from lake . archive . events", guards).join(" ")).toContain("time filter");
  expect(checkGuardrails("select a from lake /* x */ . archive\n.events", guards).join(" ")).toContain("time filter");
});
test("a window order by needs no limit, a top-level one still does", () => {
  expect(checkGuardrails(`select row_number() over (partition by a order by ts) from ${W} where ${tf}`, guards)).toEqual([]);
  expect(checkGuardrails(`select row_number() over (partition by a order by ts) from ${W} where ${tf} order by a`, guards).join(" ")).toContain("limit");
});
test("named zones and +hhmm offsets pass; comments are not read", () => {
  for (const z of ["2026-01-01 00:00:00 America/New_York", "2026-01-01 00:00:00 +0200", "2026-01-01 00:00:00 utc"]) {
    expect(checkGuardrails(`select a from ${W} where event_time >= timestamp '${z}' limit 1`, guards)).toEqual([]);
  }
  expect(checkGuardrails(`select a from ${W} where ${tf} limit 1 -- timestamp '2026-01-01 00:00:00'`, guards)).toEqual([]);
  expect(checkGuardrails(`select a from ${W} where event_time >= timestamp '2026-01-01 00:00:00' limit 1`, guards).join(" ")).toContain("time zone");
});
test("count(*) is not select *", () => {
  expect(checkGuardrails("select count(*) from lake.archive.events where event_time > now() - interval '1' day", guards)).toEqual([]);
});
test("zone offsets and Z are accepted", () => {
  for (const z of ["2026-11-20T00:00:00Z", "2026-11-20 00:00:00 +02:00", "2026-11-20 00:00:00 -05:30"]) {
    expect(checkGuardrails(`select a from lake.archive.events where event_time >= timestamp '${z}' limit 1`, guards)).toEqual([]);
  }
});
test("several violations are all reported", () => {
  const v = checkGuardrails("select * from lake.archive.events", guards);
  expect(v.length).toBe(2);
});
test("the table name matches case-insensitively and when quoted", () => {
  const v = checkGuardrails('select a from "LAKE"."archive"."events"', guards);
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

// ---------- the review's bypasses ----------
test.each([
  ["a CR ends a -- comment in the engine", `select a ${head} --\r or true\n`],
  ["a CR ends a -- comment, in the middle", `select a ${head} --x\r or 1 = 1 --\n`],
  ["a CR ends a -- comment at the where", `select a from lake.archive.events where --\r true or event_time >= ${lit.from} and event_time < ${lit.to}`],
  ["explain analyze of a parenthesised select with a quoted alias", `EXPLAIN ANALYZE (SELECT a FROM lake.archive.events AS "x)select" WHERE event_time > TIMESTAMP '1970-01-01 00:00:00 UTC')`],
  ["explain of a parenthesised select with a quoted alias", `EXPLAIN (SELECT a FROM lake.archive.events AS "x)select" WHERE event_time > TIMESTAMP '1970-01-01 00:00:00 UTC')`],
  ["explain analyze of a conforming select", `explain analyze select a ${head}`],
  ["explain analyze of any select", "explain analyze select a from other"],
  ["a table function", "select a from table(lake.system.table_changes(schema_name => 'archive', table_name => 'events', start_snapshot_id => 1, end_snapshot_id => 2))"],
  ["a table function on another table", "select a from table (other.system.query(query => 'select 1'))"],
  ["limit all", `select a ${head} order by a limit all`],
  ["a huge limit", `select a ${head} limit 999999999999`],
  ["a huge fetch first", `select a ${head} fetch first 10000000 rows only`],
  ["an offset", `select a ${head} offset 5`],
])("the guarded shape refuses (review): %s", (_n, sql) => {
  expect(checkGuardedShape(sql, gs, lit, 100).length).toBeGreaterThan(0);
});
test("control characters are refused by assertReadOnly", () => {
  for (const c of ["\r", "\u000b", "\u000c", "\u0085", "\u007f", "\u009f", "\u2028", "\u2029", "\u0000"]) {
    expect(() => assertReadOnly(`select 1${c}from t`)).toThrow(GuardError);
  }
  expect(() => assertReadOnly("select\t1\nfrom t")).not.toThrow();
});
test("a limit within the source's rows, an options-only explain and describe without a window are allowed", () => {
  expect(checkGuardedShape(`select a ${head} limit 100`, gs, lit, 100)).toEqual([]);
  expect(checkGuardedShape(`select a ${head} fetch first 100 rows only`, gs, lit, 100)).toEqual([]);
  expect(checkGuardedShape(`explain (type io, format json) select a ${head}`, gs, lit, 100)).toEqual([]);
  expect(checkGuardedShape("describe lake.archive.events", gs, null, 100)).toEqual([]);
  expect(checkGuardedShape("show columns from lake.archive.events", gs, null, 100)).toEqual([]);
});

// ---------- final review C-1: a number glued to a keyword ----------
test.each([
  `select a ${head} and a = 1.5or true`,
  `select a ${head} and a = .5or true`,
  `select a ${head} and a = 1.5e3or true`,
  `select a ${head} and a = 15or true`,
  `select a ${head} and a = 1.5e+3or true`,
  `select a ${head} and a > 1.5order by a limit 5`,
  `select a ${head} and a = 1.5limit 999999`,
  "select 1.5or true",
])("a number glued to a word is refused: %s", (sql) => {
  expect(checkGuardedShape(sql, gs, lit, 100).join(" ")).toContain("a number must be followed by a space or punctuation");
});
test("numbers that are well formed still pass", () => {
  for (const q of [
    `select a ${head} and a = 1.5 or_x = 2`.replace(" or_x = 2", ""),
    `select a ${head} and a = 1.5e+3 and b = .5 and c in (1, 2)`,
    `select date_trunc('hour', event_time) h, count(*) c ${head} and a = 15 group by 1 order by 2 limit 50`,
    `select a ${head} and t1.x = 3`.replace("t1.x", "x1"),
  ]) expect(checkGuardedShape(q, gs, lit, 100)).toEqual([]);
});
