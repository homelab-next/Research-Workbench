import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// Final review minor 17: runner.ts is the single custody point. No other file under src/ may contact a source through a
// connector (run, estimate, estimateRequest), so a tool built on these modules cannot reach a source unrecorded.
const SRC = join(import.meta.dir, "..", "..", "src");
const CUSTODY_POINT = "modules/runner.ts";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

/** `.run(` on a SQLite handle or statement is not a connector call: db.run, insert.run, stmt.run, db.query(...).run. */
const SQLITE_RUN = /(?:\b(?:db|insert|stmt)|\.query\([^\n]*\))\s*$/;

/** Each call in `text` that could be a connector contacting its source, as "line: code". */
function connectorCalls(text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "");
    for (const m of code.matchAll(/\.\s*(estimateRequest|estimate|run)\s*\(/g)) {
      const before = code.slice(0, m.index);
      if (m[1] === "run" && SQLITE_RUN.test(before)) continue;
      out.push(`${i + 1}: ${line.trim()}`);
    }
  });
  return out;
}

test("the check finds a connector call however it is written, and passes SQLite's own run", () => {
  expect(connectorCalls("const out = await connector.run(req);")).toHaveLength(1);
  expect(connectorCalls("deps.pool.for(source).estimate(req)")).toHaveLength(1);
  expect(connectorCalls("const r = c . estimateRequest (req)")).toHaveLength(1);
  expect(connectorCalls("await makeConnector(s, ctx).run(r)")).toHaveLength(1);
  expect(connectorCalls('db.run("pragma query_only = on");\ninsert.run(...r);\ndb.query("x").run(a);')).toEqual([]);
});

test("no file under src/ other than runner.ts calls run, estimate or estimateRequest on a connector", () => {
  const found = files(SRC)
    .map((f) => ({ file: relative(SRC, f), calls: connectorCalls(readFileSync(f, "utf8")) }))
    .filter(({ file, calls }) => file !== CUSTODY_POINT && calls.length > 0);
  expect(found).toEqual([]);
  // and the custody point does make them
  expect(connectorCalls(readFileSync(join(SRC, CUSTODY_POINT), "utf8")).length).toBeGreaterThanOrEqual(3);
});
