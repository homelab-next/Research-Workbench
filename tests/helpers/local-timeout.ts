// bun run tests/helpers/local-timeout.ts <database> <sql|files>: times out a never-ending query, closes the connector, and prints what happened.
import { Database } from "bun:sqlite";
import { LocalQueryHost } from "../../src/modules/connectors/local-host";

const [path] = process.argv.slice(2);
const host = new LocalQueryHost({ kind: "sql", path: path! });
const started = Date.now();
const out = await host.query({
  text: "with recursive n(x) as (select 1 union all select x + 1 from n) select count(*) as c from n",
  bound: {}, window: { from: null, to: null }, max_rows: 10, timeout_ms: 400, budget: null,
});
const cpu0 = process.cpuUsage();
await Bun.sleep(1000);
const cpu = process.cpuUsage(cpu0);
host.close();
// another process may write to the database now: nothing is still holding it
const w = new Database(path!);
w.run("insert into t values (2)");
w.close();
console.log(JSON.stringify({ coverage: out.coverage, took: Date.now() - started, idleCpuMs: (cpu.user + cpu.system) / 1000 }));
