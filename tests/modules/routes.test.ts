import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../src/core/workbench";
import type { CaseSession } from "../../src/core/session";
import type { Actor, Observable, TimeWindow } from "../../src/core/types";
import { Registry } from "../../src/modules/registry";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import { ConnectorPool } from "../../src/modules/connectors";
import type { RunnerDeps } from "../../src/modules/runner";
import { cheapestSeeker } from "../../src/modules/seeker";
import type { Seeker } from "../../src/modules/seeker";
import { runRoute } from "../../src/modules/routes";

const human: Actor = { kind: "human", id: "analyst" };
const win: TimeWindow = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };
const TYPES = [
  { id: "address", title: "Address", pattern: "(?:\\d{1,3}\\.){3}\\d{1,3}" },
  { id: "domain", title: "Domain", pattern: "(?:[a-z0-9-]+\\.)?example\\.(?:org|net)" },
  { id: "registrar", title: "Registrar", pattern: "Registrar [A-Za-z]+" },
  { id: "owner", title: "Owner", pattern: "Example [A-Za-z]+" },
  { id: "rating", title: "Rating", pattern: "rating-\\d" },
  { id: "tag", title: "Tag", pattern: "tag-\\d" },
  { id: "label", title: "Label", pattern: "label-\\d" },
];
const observables = new Observables(TYPES);

let dir: string;
let wb: Workbench;
let s: CaseSession;
let pool: ConnectorPool;
let deps: RunnerDeps;
let seeker: Seeker;

const csv = (rows: string[]): string => rows.join("\n") + "\n";
const many = Array.from({ length: 8 }, (_, i) => `d${i}.example.org`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "routes-"));
  const root = join(dir, "modules");
  mkdirSync(join(root, "data"), { recursive: true });
  const d = (f: string, rows: string[]): void => writeFileSync(join(root, "data", f), csv(rows));
  d("dns.csv", ["address,domain", "192.0.2.17,example.org", "192.0.2.50," + many[0], ...many.slice(1).map((m) => "192.0.2.50," + m), "192.0.2.60,paid.example.org"]);
  d("owners.csv", ["domain,owner", "nobody.example.net,Example Nobody"]);
  d("registrars.csv", ["domain,registrar", "example.org,Registrar Alpha", ...many.slice(0, 2).map((m) => m + ",Registrar Alpha")]);
  d("regowners.csv", ["registrar,owner", "Registrar Alpha,Example Hosting"]);
  d("ratings.csv", ["domain,rating", "paid.example.org,rating-1"]);
  d("tags.csv", ["address,tag", "192.0.2.70,tag-1", "192.0.2.70,tag-2"]);
  d("labels.csv", ["address,label", "192.0.2.70,label-1"]);
  const source = (id: string, file: string, cols: [string, string][], extra = ""): void => writeFileSync(join(root, `${id}.yaml`), `kind: source
id: ${id}
title: ${id}
connector: files
location: data
marking: "TLP:GREEN"
where: machine
${extra}
tables:
  - { name: ${id}, file: ${file}, format: csv, columns: [${cols.map(([n, t]) => `{ name: ${n}, type: ${t} }`).join(", ")}] }
`);
  source("dns", "dns.csv", [["address", "address"], ["domain", "domain"]]);
  source("owners", "owners.csv", [["domain", "domain"], ["owner", "owner"]]);
  source("registrars", "registrars.csv", [["domain", "domain"], ["registrar", "registrar"]]);
  source("regowners", "regowners.csv", [["registrar", "registrar"], ["owner", "owner"]]);
  source("paid", "ratings.csv", [["domain", "domain"], ["rating", "rating"]], "cost: { weight: 3, unit: lookups }");
  source("small", "tags.csv", [["address", "address"], ["tag", "tag"]], "limits: { max_rows: 1, timeout_ms: 1000 }");
  source("unconf", "labels.csv", [["address", "address"], ["label", "label"]], "confirmed: false");
  writeFileSync(join(root, "types.yaml"), `kind: types\ntypes:\n${TYPES.map((t) => `  - { id: ${t.id}, title: ${t.title}, pattern: '${t.pattern}' }`).join("\n")}\n`);
  const pv = (id: string, from: string, to: string, src: string, col: string, key: string): string =>
    `  - { id: ${id}, title: ${id} title, from: ${from}, to: ${to}, source: ${src}, query: "select ${col} from ${src} where ${key} = {value}", weight: ${src === "paid" ? "null" : "0"}, empty_means: not-seen, yields: { ${col}: ${to} } }`;
  writeFileSync(join(root, "pivots.yaml"), `kind: pivots\npivots:\n${[
    pv("ad", "address", "domain", "dns", "domain", "address"),
    pv("do1", "domain", "owner", "owners", "owner", "domain"),
    pv("dr", "domain", "registrar", "registrars", "registrar", "domain"),
    pv("ro", "registrar", "owner", "regowners", "owner", "registrar"),
    pv("dq", "domain", "rating", "paid", "rating", "domain"),
    pv("at", "address", "tag", "small", "tag", "address"),
    pv("au", "address", "label", "unconf", "label", "address"),
  ].join("\n")}\n`);
  const registry = Registry.load([{ path: root, trusted: true, credentials: [] }]);
  expect(registry.problems).toEqual([]);
  pool = new ConnectorPool({ secrets: new Secrets({}, null), observables });
  deps = { registry, pool, observables };
  seeker = cheapestSeeker(registry);
  wb = Workbench.open(join(dir, "data"), { onError: () => {} });
  s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [], window: win, objective: null, marking: "TLP:GREEN" }, human);
});
afterEach(() => {
  expect(s.state.skipped).toEqual([]);
  pool.closeAll();
  try { wb.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const addr = (value: string): Observable[] => [{ type: "address", value }];
const go = (have: Observable[], want: string, extra: Partial<Parameters<typeof runRoute>[3]> = {}) =>
  runRoute(s, deps, seeker, { have, want, window: win, why: "who owns it", actor: human, ...extra });

test("a route runs hop by hop, feeding each hop's values to the next", async () => {
  const r = await go(addr("192.0.2.17"), "registrar");
  expect(r.outcome).toBe("answered");
  expect(r.trail.map((t) => [t.hop.pivot, t.value, t.found])).toEqual([
    ["ad", "192.0.2.17", ["example.org"]],
    ["dr", "example.org", ["Registrar Alpha"]],
  ]);
  expect(r.reached).toEqual([{ type: "registrar", value: "Registrar Alpha" }]);
  expect(r.trail.every((t) => t.status === "done" && t.card !== null && t.query !== null)).toBe(true);
  expect(r.cards).toEqual(r.trail.map((t) => t.card!));
});

test("an empty hop is a roadblock: the run re-routes from what it now knows", async () => {
  const r = await go(addr("192.0.2.17"), "owner");
  expect(r.outcome).toBe("answered");
  expect(r.blocked).toEqual(["do1"]);
  expect(r.trail.map((t) => t.hop.pivot)).toEqual(["ad", "do1", "dr", "ro"]);
  expect(r.reached).toEqual([{ type: "owner", value: "Example Hosting" }]);
  expect(r.cards).toHaveLength(4);
});

test("the pivot already run successfully is not run again after a re-route", async () => {
  const r = await go(addr("192.0.2.17"), "owner");
  expect(r.trail.filter((t) => t.hop.pivot === "ad")).toHaveLength(1);
  const keys = r.trail.map((t) => `${t.hop.pivot}|${t.value}`);
  expect(new Set(keys).size).toBe(keys.length);
});

test("when every route is blocked the outcome is blocked, with the trail", async () => {
  const r = await go(addr("192.0.2.99"), "owner");
  expect(r.outcome).toBe("blocked");
  expect(r.blocked).toEqual(["ad"]);
  expect(r.trail.map((t) => [t.hop.pivot, t.status, t.outcome])).toEqual([["ad", "done", "empty"]]);
  expect(r.reached).toEqual([]);
});

test("a costly hop with no budget blocks that pivot and moves on", async () => {
  const r = await go(addr("192.0.2.60"), "rating");
  expect(r.outcome).toBe("blocked");
  expect(r.blocked).toEqual(["dq"]);
  expect(r.trail.map((t) => [t.hop.pivot, t.status])).toEqual([["ad", "done"], ["dq", "needs_budget"]]);
  expect(r.trail[1]).toMatchObject({ card: null, query: null, found: [], proposal: null, estimate: null });
  expect(r.caveats).toEqual(["dq: needs a budget"]);
  expect(s.entries().filter((e) => e.type === "query.issued")).toHaveLength(1);
});

test("an agent's costly hop names the proposal it raised, in the trail and in the caveats", async () => {
  const agent: Actor = { kind: "agent", id: "a1", stage: "gather", profile: "p", model: "m", effort: null, where: "machine" };
  const r = await go(addr("192.0.2.60"), "rating", { actor: agent });
  expect(r.trail[1]).toMatchObject({ status: "needs_budget", proposal: "p1", estimate: null });
  expect(r.caveats).toEqual(["dq: needs a budget (proposal p1)"]);
  expect(s.state.proposals.p1).toMatchObject({ kind: "costly_query", pivot: "dq", bound: { value: "paid.example.org" } });
});

test("a refused hop is a roadblock", async () => {
  const r = await go([{ type: "address", value: "not an address" }], "owner");
  expect(r.outcome).toBe("blocked");
  expect(r.trail.map((t) => t.status)).toEqual(["refused"]);
  expect(r.blocked).toEqual(["ad"]);
});

test("values given in have never count as reached: holding the goal type asks for other values of it", async () => {
  const r = await go([{ type: "owner", value: "Example Hosting" }], "owner");
  expect(r).toMatchObject({ outcome: "blocked", reached: [], trail: [], cards: [], blocked: [] });
  // given an owner and an address, the owner found by the route is reached; the given one is not
  const both = await go([{ type: "owner", value: "Example Other" }, ...addr("192.0.2.17")], "owner");
  expect(both.reached).toEqual([{ type: "owner", value: "Example Hosting" }]);
});

test("fan-out is capped", async () => {
  const r = await go(addr("192.0.2.50"), "owner", { max_fanout: 3 });
  expect(r.trail.filter((t) => t.hop.pivot === "ad")).toHaveLength(1);
  expect(r.trail.filter((t) => t.hop.pivot === "do1")).toHaveLength(3);
  expect(r.trail.filter((t) => t.hop.pivot === "do1").map((t) => t.value)).toEqual(many.slice(0, 3));
});

test("the total number of pivot runs is capped at 50", async () => {
  const many2: Observable[] = Array.from({ length: 60 }, (_, i) => ({ type: "address", value: `192.0.2.${100 + i}` }));
  const r = await go(many2, "owner", { max_fanout: 100 });
  expect(r.outcome).toBe("blocked");
  expect(r.trail).toHaveLength(50);
  expect(r.caveats).toContain("stopped after 50 lookups");
});

test("every query in the trail is in the ledger with its why", async () => {
  const r = await go(addr("192.0.2.17"), "owner");
  const issued = s.entries().filter((e) => e.type === "query.issued").map((e) => e.payload as { query: string; why: string; pivot: string });
  expect(issued.map((i) => i.query)).toEqual(r.trail.map((t) => t.query!));
  expect(issued.map((i) => i.why)).toEqual(r.trail.map((t) => `who owns it — ${t.hop.title}`));
});

test("a clean answer has no caveats", async () => {
  expect((await go(addr("192.0.2.17"), "owner")).caveats).toEqual([]);
});

test("a partial hop is a caveat on the answer", async () => {
  const r = await go(addr("192.0.2.70"), "tag");
  expect(r.outcome).toBe("answered");
  expect(r.caveats).toEqual(["at: partial coverage (row_limit)"]);
});

test("an unconfirmed source is a caveat when it is allowed", async () => {
  const lim = { max_weight: null, allow_unconfirmed: true, max_hops: 4 };
  const r = await go(addr("192.0.2.70"), "label", { limits: lim });
  expect(r.outcome).toBe("answered");
  expect(r.caveats).toEqual(["au: unconfirmed source unconf"]);
});

test("values beyond the fan-out limit are a caveat", async () => {
  const r = await go(addr("192.0.2.50"), "owner", { max_fanout: 3 });
  expect(r.caveats).toContain("do1: 5 values not tried (fan-out limit 3)");
});

test("once the goal is known, the hop's remaining values are not run, and the answer says so", async () => {
  const have = ["192.0.2.17", "192.0.2.50", "192.0.2.60", "192.0.2.61", "192.0.2.62"].map((value) => ({ type: "address", value }));
  const r = await go(have, "domain");
  expect(r.outcome).toBe("answered");
  expect(r.trail.map((t) => [t.hop.pivot, t.value])).toEqual([["ad", "192.0.2.17"]]);
  expect(r.caveats).toEqual(["ad: 4 values not followed after the goal was reached"]);
  const two = await go(["192.0.2.61", "192.0.2.17", "192.0.2.62"].map((value) => ({ type: "address", value })), "domain");
  expect(two.trail.map((t) => t.value)).toEqual(["192.0.2.61", "192.0.2.17"]);
  expect(two.caveats).toEqual(["ad: 1 value not followed after the goal was reached"]);
});

test("an empty lookup marks only that pivot and value: the pivot runs again on a value found later", async () => {
  // 192.0.2.99 has no domain, so ad runs dry on it; at gives tags, not addresses, so nothing reopens ad, and the run ends
  const dry = await go(addr("192.0.2.99"), "domain");
  expect(dry).toMatchObject({ outcome: "blocked", blocked: ["ad"] });
  // with a second address in hand, ad is tried on each value in turn, not blocked after the first
  const r = await go([...addr("192.0.2.99"), ...addr("192.0.2.17")], "domain");
  expect(r.outcome).toBe("answered");
  expect(r.trail.map((t) => [t.hop.pivot, t.value, t.outcome])).toEqual([["ad", "192.0.2.99", "empty"], ["ad", "192.0.2.17", "answered"]]);
  expect(r.blocked).toEqual([]);
});

test("a route whose first hop ran dry blocks that hop, not the route's last one", async () => {
  // ad finds nothing for 192.0.2.99; the routes to owner are ad>do1 and ad>dr>ro, and it is ad that ran dry
  const r = await go(addr("192.0.2.99"), "owner");
  expect(r.blocked).toEqual(["ad"]);
  expect(r.blocked).not.toContain("do1");
  expect(r.blocked).not.toContain("ro");
});
