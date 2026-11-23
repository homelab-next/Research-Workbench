import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../src/core/workbench";
import type { CaseSession } from "../../src/core/session";
import type { Actor, TimeWindow } from "../../src/core/types";
import { Registry } from "../../src/modules/registry";
import type { PivotManifest } from "../../src/modules/registry";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import { ConnectorPool } from "../../src/modules/connectors";
import type { RunnerDeps, RunQueryResult } from "../../src/modules/runner";
import { PivotError, bindPivot, runPivot, yielded } from "../../src/modules/pivots";

const human: Actor = { kind: "human", id: "analyst" };
const win: TimeWindow = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };
const observables = new Observables([
  { id: "address", title: "Address", pattern: "(?:\\d{1,3}\\.){3}\\d{1,3}" },
  { id: "domain", title: "Domain", pattern: "[a-z0-9.-]+\\.example\\.(?:org|net)|example\\.(?:org|net)" },
]);

let dir: string;
let wb: Workbench;
let s: CaseSession;
let pool: ConnectorPool;
let deps: RunnerDeps;
let p: PivotManifest;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pivots-"));
  const root = join(dir, "modules");
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "dns.csv"), "address,domain\n192.0.2.17,example.org\n192.0.2.17,www.example.org\n");
  writeFileSync(join(root, "src.yaml"), `kind: source
id: dns
title: DNS
connector: files
location: data
marking: "TLP:GREEN"
where: machine
tables:
  - { name: dns, file: dns.csv, format: csv, columns: [{ name: address, type: address }, { name: domain, type: domain }] }
`);
  writeFileSync(join(root, "types.yaml"), `kind: types
types:
  - { id: address, title: Address, pattern: '(?:\\d{1,3}\\.){3}\\d{1,3}' }
  - { id: domain, title: Domain, pattern: '[a-z0-9.-]+\\.example\\.(?:org|net)|example\\.(?:org|net)' }
`);
  writeFileSync(join(root, "pivots.yaml"), `kind: pivots
pivots:
  - { id: ad, title: Domains of an address, from: address, to: domain, source: dns, query: "select domain from dns where address = {value}", weight: 0, yields: { domain: domain } }
`);
  const registry = Registry.load([{ path: root, trusted_scripts: false }]);
  p = registry.pivot("ad")!;
  pool = new ConnectorPool({ secrets: new Secrets({}, null), observables });
  deps = { registry, pool, observables };
  wb = Workbench.open(join(dir, "data"), { onError: () => {} });
  s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [], window: win, objective: null, marking: "TLP:GREEN" }, human);
});
afterEach(() => {
  expect(s.state.skipped).toEqual([]);
  pool.closeAll();
  try { wb.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

test("bindPivot returns the template and the value", () => {
  expect(bindPivot(p, "192.0.2.17", observables)).toEqual({ text: p.query, bound: { value: "192.0.2.17" } });
});

test("a value that is not of the pivot's type is refused", () => {
  expect(() => bindPivot(p, "192.0.2.17' OR '1'='1", observables)).toThrow(PivotError);
  expect(() => bindPivot(p, "example.org", observables)).toThrow(PivotError);
});

test("runPivot runs through the runner with the pivot attached", async () => {
  const r = await runPivot(s, deps, { pivot: "ad", value: "192.0.2.17", window: win, why: "who is it", actor: human });
  if (r.status !== "done") throw new Error(JSON.stringify(r));
  expect(r.rows).toBe(2);
  const issued = s.entries().find((e) => e.type === "query.issued")!.payload as Record<string, unknown>;
  expect(issued).toMatchObject({ pivot: "ad", pivot_hash: p.hash, source: "dns", why: "who is it" });
  expect(s.state.cards[r.card!]!.title).toBe("Domains of an address: 192.0.2.17");
});

test("an unknown pivot is refused", async () => {
  const r = await runPivot(s, deps, { pivot: "nope", value: "192.0.2.17", window: win, why: "w", actor: human });
  expect(r.status).toBe("refused");
  const bad = await runPivot(s, deps, { pivot: "ad", value: "example.org", window: win, why: "w", actor: human });
  expect(bad.status).toBe("refused");
  expect(s.entries().some((e) => e.type === "query.issued")).toBe(false);
});

test("yielded returns distinct values of the target type only", () => {
  const result: RunQueryResult = {
    status: "done", query: "q1", card: null, outcome: "answered", rows: 5, rows_hash: "h", coverage: { kind: "full" },
    columns: ["domain", "other"],
    data: [["example.org", "x"], ["example.org", "y"], [null, "z"], ["not a domain", "w"], ["a.example.net", "v"]],
  };
  expect(yielded(p, result, observables)).toEqual([{ type: "domain", value: "example.org" }, { type: "domain", value: "a.example.net" }]);
  // an unrelated column whose values match the type is not read
  const other: RunQueryResult = { ...result, columns: ["name", "domain"], data: [["example.net", null], ["x.example.org", "example.org"]] };
  expect(yielded(p, other, observables)).toEqual([{ type: "domain", value: "example.org" }]);
  expect(yielded(p, { status: "refused", reasons: [] }, observables)).toEqual([]);
});
