import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../src/core/workbench";
import { verifyCase } from "../../src/core/verify";
import type { CaseSession } from "../../src/core/session";
import type { Actor, Observable } from "../../src/core/types";
import { Registry } from "../../src/modules/registry";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import { ConnectorPool } from "../../src/modules/connectors";
import type { RunnerDeps } from "../../src/modules/runner";
import { runPivot } from "../../src/modules/pivots";
import { cheapestSeeker, DEFAULT_LIMITS } from "../../src/modules/seeker";
import type { Seeker } from "../../src/modules/seeker";
import { runRoute } from "../../src/modules/routes";
import { ensureSampleData, makeSampleData, SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { startReputationFixture } from "../../sample/fixture/reputation-server";

const human: Actor = { kind: "human", id: "analyst" };
const REPO_SAMPLE = join(import.meta.dir, "..", "..", "sample");

let dir: string;
let root: string;
let wb: Workbench | null;
let s: CaseSession;
let pool: ConnectorPool;
let fixture: { url: string; stop(): void };
let registry: Registry;
let deps: RunnerDeps;
let seeker: Seeker;

/** A temp copy of the sample's manifests, with data generated beside them and the reputation source pointed at the fixture. */
function copySample(into: string): void {
  cpSync(REPO_SAMPLE, into, { recursive: true, filter: (p) => !/[\\/]sample[\\/](?:data|fixture)(?:[\\/]|$)/.test(p) });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sample-"));
  root = join(dir, "sample");
  copySample(root);
  makeSampleData(join(root, "data"));
  fixture = startReputationFixture(join(root, "data"), 0);
  const rep = join(root, "sources", "reputation.yaml");
  writeFileSync(rep, readFileSync(rep, "utf8").replace("http://127.0.0.1:4801", fixture.url));
  registry = Registry.load([{ path: root, trusted: true, credentials: [] }]);
  expect(registry.problems).toEqual([]);
  const observables = new Observables(registry.types());
  pool = new ConnectorPool({ secrets: new Secrets({}, null), observables });
  deps = { registry, pool, observables };
  seeker = cheapestSeeker(registry);
  wb = Workbench.open(join(dir, "case-data"), { onError: () => {} });
  s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [], window: SAMPLE_WINDOW, objective: null, marking: "TLP:GREEN" }, human);
});

afterEach(() => {
  expect(s.state.skipped).toEqual([]);
  pool.closeAll();
  fixture.stop();
  try { wb?.close(); } catch { /* already closed */ }
  wb = null;
  rmSync(dir, { recursive: true, force: true });
});

const addr = (value: string): Observable => ({ type: "address", value });
const pivot = (id: string, value: string, extra: Partial<Parameters<typeof runPivot>[2]> = {}) =>
  runPivot(s, deps, { pivot: id, value, window: SAMPLE_WINDOW, why: "check", actor: human, ...extra });

test("the generator is deterministic", () => {
  const a = join(dir, "a");
  const b = join(dir, "b");
  makeSampleData(a);
  makeSampleData(b);
  const files = readdirSync(a).filter((f) => /\.(?:jsonl|csv|json)$/.test(f));
  expect(files.sort()).toEqual(["assets.csv", "dns.jsonl", "leases.csv", "reputation.json", "signins.jsonl"]);
  for (const f of files) expect(readFileSync(join(a, f)).equals(readFileSync(join(b, f)))).toBe(true);
  const rows = (p: string): unknown[] => {
    const db = new Database(p, { readonly: true });
    try { return db.query("select * from flows order by rowid").all(); } finally { db.close(); }
  };
  const ra = rows(join(a, "flows.sqlite"));
  expect(ra.length).toBeGreaterThan(3000);
  expect(ra).toEqual(rows(join(b, "flows.sqlite")));
});

test("the sample root loads with no problems", () => {
  expect(Registry.load([{ path: root, trusted: true, credentials: [] }]).problems).toEqual([]);
  expect(registry.sources().map((x) => x.id).sort()).toEqual(["assets", "dns-logs", "flows", "leases", "reputation", "signins"]);
  expect(registry.pivots()).toHaveLength(8);
  expect(registry.types().map((t) => t.id).sort()).toEqual(["account", "address", "asset", "domain", "host", "verdict"]);
});

test("the sample holds only reserved addresses and example domains", () => {
  const data = join(root, "data");
  const text = ["dns.jsonl", "signins.jsonl", "assets.csv", "leases.csv", "reputation.json"].map((f) => readFileSync(join(data, f), "utf8"));
  const db = new Database(join(data, "flows.sqlite"), { readonly: true });
  try {
    for (const r of db.query("select src, dst from flows").all() as { src: string; dst: string }[]) text.push(`${r.src}\n${r.dst}`);
  } finally {
    db.close();
  }
  const reserved = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/;
  const seen = new Set<string>();
  for (const t of text) for (const m of t.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g)) seen.add(m[0]);
  expect(seen.size).toBeGreaterThan(20);
  for (const a of seen) expect(reserved.test(a)).toBe(true);
  const names = new Set<string>();
  for (const line of readFileSync(join(data, "dns.jsonl"), "utf8").trim().split("\n")) names.add((JSON.parse(line) as { name: string }).name);
  for (const line of readFileSync(join(data, "signins.jsonl"), "utf8").trim().split("\n")) names.add((JSON.parse(line) as { host: string }).host);
  for (const line of readFileSync(join(data, "assets.csv"), "utf8").trim().split("\n").slice(1)) names.add(line.split(",")[0]!);
  for (const n of names) expect(/\.example\.(?:com|net|org)$/.test(n)).toBe(true);
});

test("from the suspicious address, a route reaches the account behind it", async () => {
  // The asset list proves 198.51.100.77 is not internal, which blocks that pivot for the whole run; the analyst therefore
  // learns the internal client first (address -> domain -> client), then asks for the account from both addresses.
  const dom = await runRoute(s, deps, seeker, { have: [SAMPLE_START], want: "domain", window: SAMPLE_WINDOW, why: "who named it", actor: human });
  expect(dom.reached.map((o) => o.value)).toEqual(["cdn-update.example.org"]);
  const cli = await runRoute(s, deps, seeker, { have: dom.reached, want: "address", window: SAMPLE_WINDOW, why: "who asked", actor: human });
  expect(cli.reached.map((o) => o.value)).toEqual(["192.0.2.17"]);
  const r = await runRoute(s, deps, seeker, { have: [SAMPLE_START, ...cli.reached], want: "account", window: SAMPLE_WINDOW, why: "who is behind this", actor: human });
  expect(r.outcome).toBe("answered");
  expect(r.reached.map((o) => o.value)).toContain("j.doe");
  expect(r.trail.map((t) => [t.hop.pivot, t.value, t.outcome])).toEqual([
    ["address_to_asset", "198.51.100.77", "empty"],
    ["address_to_asset", "192.0.2.17", "answered"],
    ["asset_to_accounts", "ws-17.example.net", "answered"],
  ]);
  expect(verifyCase(s.dir).ok).toBe(true);
});

test("from the suspicious address alone, the proven negative in the asset list ends the default route", async () => {
  const r = await runRoute(s, deps, seeker, { have: [SAMPLE_START], want: "account", window: SAMPLE_WINDOW, why: "who is behind this", actor: human });
  expect(r.outcome).toBe("blocked");
  expect(r.blocked).toEqual(["address_to_asset"]);
  expect(r.trail.map((t) => [t.hop.pivot, t.outcome])).toEqual([["address_to_asset", "empty"]]);
});

test("the unconfirmed lease source is skipped by default, and is a dead end when allowed", async () => {
  const input = { have: [SAMPLE_START], want: "asset", window: SAMPLE_WINDOW, why: "which asset", actor: human };
  const skipped = await runRoute(s, deps, seeker, input);
  expect(skipped.trail.map((t) => t.hop.pivot)).toEqual(["address_to_asset"]);
  const r = await runRoute(s, deps, seeker, { ...input, limits: { ...DEFAULT_LIMITS, allow_unconfirmed: true } });
  expect(r.outcome).toBe("blocked");
  expect(r.trail.map((t) => [t.hop.pivot, t.found, t.outcome])).toEqual([
    ["address_to_asset", [], "empty"],
    ["address_to_asset_by_lease", [], "empty"],
  ]);
  // the lease list is silent about the workstation too: it cannot place 192.0.2.17, so it is no basis for a negative
  const lease = await pivot("address_to_asset_by_lease", "192.0.2.17");
  expect(lease.status === "done" && lease.rows).toBe(0);
  expect(s.state.cards[lease.status === "done" ? lease.card! : ""]?.empty).toBe("not-seen");
});

test("with both addresses known and unconfirmed sources allowed, the route still prefers the asset list", async () => {
  const r = await runRoute(s, deps, seeker, {
    have: [SAMPLE_START, addr("192.0.2.17")], want: "account", window: SAMPLE_WINDOW, why: "who", actor: human,
    limits: { ...DEFAULT_LIMITS, allow_unconfirmed: true },
  });
  expect(r.reached.map((o) => o.value)).toContain("j.doe");
  expect(r.trail.some((t) => t.hop.pivot === "address_to_asset_by_lease")).toBe(false);
});

test("the beacon query is partial because of the row cap", async () => {
  const r = await pivot("address_to_internal_peers", "198.51.100.77");
  expect(r.status).toBe("done");
  if (r.status !== "done") return;
  expect(r.outcome).toBe("partial");
  expect(r.coverage).toMatchObject({ kind: "partial", reason: "row_limit" });
  expect(r.rows).toBe(200);
  expect(new Set(r.data.map((row) => row[0]))).toEqual(new Set(["192.0.2.17"]));
});

test("an external address is a proven negative in the asset list", async () => {
  const r = await pivot("address_to_asset", "198.51.100.77");
  expect(r.status).toBe("done");
  if (r.status !== "done") return;
  expect(r.rows).toBe(0);
  expect(s.state.cards[r.card!]!.empty).toBe("proven-negative");
  const inside = await pivot("address_to_asset", "192.0.2.17");
  expect(inside.status === "done" && inside.data).toEqual([["ws-17.example.net"]]);
});

test("the reputation lookup is costly and needs a budget", async () => {
  const none = await pivot("address_to_verdict", "198.51.100.77");
  expect(none.status).toBe("needs_budget");
  if (none.status === "needs_budget") expect(none.estimate).toEqual({ amount: 1, unit: "lookups" });
  const r = await pivot("address_to_verdict", "198.51.100.77", { budget: 1 });
  expect(r.status).toBe("done");
  if (r.status !== "done") return;
  expect(r.columns).toEqual(["address", "verdict", "first_seen"]);
  expect(r.data).toEqual([["198.51.100.77", "suspicious", "2026-11-19"]]);
  const unknown = await pivot("address_to_verdict", "203.0.113.99", { budget: 1 });
  expect(unknown.status === "done" && unknown.rows).toBe(0);
});

test("the planted story is in the data", async () => {
  const sign = await pivot("account_to_signin_addresses", "j.doe");
  expect(sign.status === "done" && sign.data.map((r) => r[0]).sort()).toEqual(["192.0.2.17", "203.0.113.50"]);
  const dns = await pivot("address_to_domains", "198.51.100.77");
  expect(dns.status === "done" && dns.data).toEqual([["cdn-update.example.org"]]);
  const clients = await pivot("domain_to_clients", "cdn-update.example.org");
  expect(clients.status === "done" && clients.data).toEqual([["192.0.2.17"]]);
  const db = new Database(join(root, "data", "flows.sqlite"), { readonly: true });
  try {
    const rows = db.query("select src, dport, bytes, ts from flows where dst = '198.51.100.77' order by ts").all() as { src: string; dport: number; bytes: number; ts: string }[];
    expect(new Set(rows.map((x) => x.src))).toEqual(new Set(["192.0.2.17"]));
    expect(rows.every((x) => x.dport === 443 && x.bytes >= 480 && x.bytes <= 520)).toBe(true);
    expect(rows[0]!.ts).toBe("2026-11-20T03:20:00.000Z");
    expect(Date.parse(rows[1]!.ts) - Date.parse(rows[0]!.ts)).toBe(600_000);
  } finally {
    db.close();
  }
});

test("a card over the duplicated-logging days carries the quality note", async () => {
  const over = await pivot("address_to_domains", "198.51.100.77", { window: { from: "2026-11-18T00:00:00.000Z", to: "2026-11-20T00:00:00.000Z" } });
  expect(over.status).toBe("done");
  if (over.status !== "done") return;
  expect(s.state.cards[over.card!]!.quality_notes).toEqual(["duplicated-logging"]);
  const after = await pivot("address_to_domains", "198.51.100.77", { window: { from: "2026-11-21T00:00:00.000Z", to: "2026-11-23T00:00:00.000Z" } });
  expect(after.status === "done" && s.state.cards[after.card!]!.quality_notes).toEqual([]);
});

test("ensureSampleData generates once and then leaves the data alone", () => {
  const r = join(dir, "fresh");
  expect(existsSync(join(r, "data", "flows.sqlite"))).toBe(false);
  ensureSampleData(r);
  const path = join(r, "data", "flows.sqlite");
  expect(existsSync(path)).toBe(true);
  const stamp = statSync(path).mtimeMs;
  writeFileSync(join(r, "data", "dns.jsonl"), "kept\n");
  ensureSampleData(r);
  expect(statSync(path).mtimeMs).toBe(stamp);
  expect(readFileSync(join(r, "data", "dns.jsonl"), "utf8")).toBe("kept\n");
});
