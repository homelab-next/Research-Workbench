import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Ledger } from "../../src/core/ledger";
import { sha256Hex } from "../../src/core/hash";
import type { RootConfig } from "../../src/modules/config";
import { Registry, staysInside } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import { PATTERN_PROBE_LIMIT_MS, probePattern } from "../../src/modules/observables";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "rw-registry-"));
  dirs.push(d);
  return d;
};
const ledgers: Ledger[] = [];
afterEach(() => {
  for (const l of ledgers.splice(0)) l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function root(files: Record<string, string>, grant: { trusted?: boolean; credentials?: string[] } = {}): RootConfig {
  const dir = tmp();
  for (const [name, text] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return { path: dir, trusted: grant.trusted ?? true, credentials: grant.credentials ?? [] };
}
function chain(): Ledger {
  const l = Ledger.open(join(tmp(), "ledger.sqlite"), "CASE-1");
  ledgers.push(l);
  return l;
}

const SOURCE = `kind: source
id: dns-logs
title: DNS logs
connector: files
location: data
marking: "TLP:GREEN"
where: machine
tables:
  - name: dns
    file: dns.jsonl
    format: jsonl
    time_column: ts
    columns:
      - { name: ts, type: null }
      - { name: client, type: address }
      - { name: name, type: domain }
`;
const TYPES = `kind: types
types:
  - { id: address, title: Address, pattern: '^(?:\\d{1,3}\\.){3}\\d{1,3}$' }
  - { id: domain, title: Domain, pattern: '^(?=.{1,253}$)(?:[a-z0-9-]{1,63}\\.)+[a-z]{2,63}$' }
`;
const PIVOTS = `kind: pivots
pivots:
  - id: address_to_domains
    title: Domains resolved by an address
    from: address
    to: domain
    source: dns-logs
    query: "select name as domain from dns where client = {value}"
    needs_window: true
    weight: null
    empty_means: not-seen
    yields: { domain: domain }
`;
const GOOD = { "sources/dns-logs.yaml": SOURCE, "types.yaml": TYPES, "pivots.yaml": PIVOTS };
const sourceWith = (id: string, extra = ""): string => `kind: source\nid: ${id}\ntitle: T\nconnector: files\nlocation: data\nmarking: "TLP:GREEN"\nwhere: machine\n${extra}`;

test("loading records each manifest on the chain once per content", () => {
  const rootA = root(GOOD);
  const c = chain();
  const loaded = () => c.read().filter(e => e.type === "module.loaded").map(e => e.payload as { kind: string; id: string; hash: string; root: string; path: string });
  loadRegistry([rootA], { chain: c });
  expect(loaded().map(p => `${p.kind}:${p.id}`).sort()).toEqual(["pivot:address_to_domains", "source:dns-logs", "type:address", "type:domain"]);
  expect(loaded().find(p => p.id === "dns-logs")).toEqual({
    kind: "source", id: "dns-logs", hash: sha256Hex(readFileSync(join(rootA.path, "sources/dns-logs.yaml"))), root: rootA.path, path: join(rootA.path, "sources/dns-logs.yaml"),
  });
  loadRegistry([rootA], { chain: c });
  expect(loaded()).toHaveLength(4);
  writeFileSync(join(rootA.path, "sources/dns-logs.yaml"), SOURCE + "quality: changed\n");
  loadRegistry([rootA], { chain: c });
  expect(loaded()).toHaveLength(5);
  expect(loaded()[4]!.id).toBe("dns-logs");
  expect(c.read().every(e => e.actor.kind === "system" && e.actor.id === "registry")).toBe(true);
});

test("problems are recorded on the chain as module.rejected", () => {
  const rootA = root({ ...GOOD, "bad.yaml": "kind: [unclosed\n" });
  const c = chain();
  const r = loadRegistry([rootA], { chain: c, actor: { kind: "system", id: "test" } });
  const rejected = c.read().filter(e => e.type === "module.rejected");
  expect(rejected.map(e => e.payload)).toEqual(r.problems);
  expect(rejected[0]!.actor).toEqual({ kind: "system", id: "test" });
  loadRegistry([rootA], { chain: c });
  expect(c.read().filter(e => e.type === "module.rejected")).toHaveLength(1);
});

// ---------- task 13 fix I1: a hash the ledger records is the workbench's own sha256 of the file ----------
/** Loads with pivot's Registry.load wrapped so that `spoil` can alter what it returns, as a pivot whose hash diverged would. */
function loadSpoiled(roots: RootConfig[], spoil: (r: Registry) => void, c?: Ledger): () => Registry {
  return () => {
    const real = Registry.load;
    Registry.load = (...args: Parameters<typeof Registry.load>) => { const r = real(...args); spoil(r); return r; };
    try {
      return loadRegistry(roots, c === undefined ? {} : { chain: c });
    } finally {
      Registry.load = real;
    }
  };
}

test("each manifest hash is held to the workbench's own sha256 of the file", () => {
  const rootA = root(GOOD);
  const r = loadRegistry([rootA]);
  for (const m of r.manifests()) expect(m.hash).toBe(sha256Hex(readFileSync(m.path)));
  for (const s of r.sources()) expect(s.hash).toBe(sha256Hex(readFileSync(r.get("source", s.id)!.path)));
  for (const p of r.pivots()) expect(p.hash).toBe(sha256Hex(readFileSync(r.get("pivot", p.id)!.path)));
});

test("a manifest hash that is not the workbench's own refuses the load and records nothing", () => {
  const rootA = root(GOOD);
  const c = chain();
  expect(loadSpoiled([rootA], (r) => { r.manifests()[0]!.hash = "0".repeat(64); }, c)).toThrow(/is not the workbench's own sha256/);
  expect(loadSpoiled([rootA], (r) => { (r.source("dns-logs") as { hash: string }).hash = "1".repeat(64); }, c)).toThrow(/source "dns-logs".*is not the workbench's own sha256/);
  expect(loadSpoiled([rootA], (r) => { (r.pivot("address_to_domains") as { hash: string }).hash = "2".repeat(64); }, c)).toThrow(/pivot "address_to_domains".*is not the workbench's own sha256/);
  expect(c.read()).toHaveLength(0);
  // a file changed after it was read is the same refusal: the hash would not be of the bytes on disk
  expect(loadSpoiled([rootA], () => { writeFileSync(join(rootA.path, "sources/dns-logs.yaml"), SOURCE + "quality: later\n"); }, c)).toThrow(/is not the workbench's own sha256/);
  expect(c.read()).toHaveLength(0);
});

const withFile = (file: string): string => sourceWith("s", `tables:\n  - { name: t, file: "${file}", format: csv }\n`);

// ---------- final review finding 1: what a root may cause ----------
const httpSource = (id: string, extra = ""): string =>
  `kind: source\nid: ${id}\ntitle: T\nconnector: http\nlocation: https://rep.example.com\nmarking: "TLP:GREEN"\nwhere: network\n${extra}endpoints:\n  - { name: x, method: GET, path: /x, columns: [a] }\n`;
const trinoSource = (id: string, extra = ""): string =>
  `kind: source\nid: ${id}\ntitle: T\nconnector: trino\nlocation: https://lake.example.com\nuser: u\nmarking: "TLP:GREEN"\nwhere: network\ncost: { weight: 1, unit: rows }\n${extra}`;

// ---------- plan 3 task 0: a pivot may not borrow a source; an id from two roots loads from neither ----------
const REP_SOURCE = httpSource("rep", "cost: { weight: 5, unit: lookups }\n");
const pivotFor = (id: string, source: string, extra = ""): string =>
  `kind: pivots\npivots:\n  - { id: ${id}, title: T, from: address, to: address, source: ${source}, query: x, ${extra}yields: { a: address } }\n`;

// ---------- 6b: a pivot's time columns ----------
const TIMED = (times: string): string => `kind: pivots
pivots:
  - id: p
    from: address
    to: domain
    source: dns-logs
    query: "select name, min(ts) as first_seen, max(ts) as last_seen, count(*) as events, ts from dns where client = {value} group by name"
    yields: { name: domain }
${times === "" ? "" : `    ${times}\n`}`;
const load = (times: string): Registry => loadRegistry([root({ ...GOOD, "pivots.yaml": TIMED(times) })]);
