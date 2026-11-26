import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose } from "../../src/cli/compose";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { runQuery } from "../../src/modules/runner";
import { sampleRoot } from "../helpers/sample-root";
import { startTrino } from "../helpers/trino-standin";

test("the workbench calls itself research-workbench to the lake, so x-trino-source is what the lake has always seen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "client-name-"));
  const trino = startTrino();
  const sample = sampleRoot(dir);
  writeFileSync(join(sample.root, "sources", "lake.yaml"), `kind: source
id: lake
title: Lake
connector: trino
location: ${trino.url}
user: workbench
marking: "TLP:AMBER"
where: machine
adhoc: true
cost: { weight: 2, unit: rows }
limits: { max_rows: 10, timeout_ms: 5000 }
tables:
  - { name: iceberg.s.events, time_column: ts, columns: [] }
`);
  const config: Config = { ...loadConfig({ env: {}, home: dir, repoRoot: dir }), data_dir: join(dir, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }] };
  const wb = Workbench.open(config.data_dir, { onError: () => {} });
  const composed = compose(config, wb);
  try {
    expect(composed.problems).toEqual([]);
    trino.on(/^explain/i, { columns: ["Query Plan"], pages: [[[JSON.stringify({ estimate: { outputRowCount: 3 } })]]] });
    trino.on(/^select/i, { columns: ["a"], pages: [[["p"]]] });
    const human = { kind: "human", id: "analyst" } as const;
    const win = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };
    const s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [], window: win, objective: null, marking: "TLP:AMBER" }, human);
    const r = await runQuery(s, composed.deps.runner, { source: "lake", text: "select a from iceberg.s.events", bound: {}, window: win, why: "events", actor: human, budget: 5 });
    expect(r).toMatchObject({ status: "done" });
    expect(trino.statements.length).toBeGreaterThan(0);
    for (const st of trino.statements) expect(st.headers["x-trino-source"]).toBe("research-workbench");
  } finally {
    composed.close();
    wb.close();
    sample.close();
    trino.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
