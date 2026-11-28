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
import { loadRegistry } from "../../src/modules/registry-record";
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
import { compose } from "../../src/cli/compose";
import { fold } from "../../src/core/state";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps } from "../../src/pipeline/engine";
import { loadPipeline } from "../../src/pipeline/manifests";
import { sampleRoot } from "../helpers/sample-root";

/** The sample's pipeline hash as the workbench computed it before slice 12 (loadPipeline on the tree before any change). */
const SAMPLE_LEGACY_HASH = "19f7829f3f9c97faf5c149c0eddc4b047471ca3b2119f168abe2cbef93761329";

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
  registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
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
  expect(files.sort()).toEqual(["assets.csv", "dns.jsonl", "leases.csv", "reputation.json", "signins.jsonl", "wifi.jsonl"]);
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
  expect(loadRegistry([{ path: root, trusted: true, credentials: [] }]).problems).toEqual([]);
  expect(registry.sources().map((x) => x.id).sort()).toEqual(["assets", "dns-logs", "flows", "leases", "reputation", "signins", "wifi"]);
  expect(registry.pivots()).toHaveLength(9);
  expect(registry.types().map((t) => t.id).sort()).toEqual(["account", "address", "asset", "domain", "host", "verdict"]);
});

test("the sample holds only reserved addresses and example domains", () => {
  const data = join(root, "data");
  const text = ["dns.jsonl", "signins.jsonl", "assets.csv", "leases.csv", "reputation.json", "wifi.jsonl"].map((f) => readFileSync(join(data, f), "utf8"));
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

test("from the suspicious address, one route call reaches the account behind it", async () => {
  // The asset list proves 198.51.100.77 is not internal. That empty answer marks only address_to_asset|198.51.100.77 as
  // done: the run learns the internal host that beacons to it, and the asset list then places that host.
  const r = await runRoute(s, deps, seeker, { have: [SAMPLE_START], want: "account", window: SAMPLE_WINDOW, why: "who is behind this", actor: human });
  expect(r.outcome).toBe("answered");
  expect(r.reached.map((o) => o.value)).toEqual(["j.doe"]);
  expect(r.trail.map((t) => [t.hop.pivot, t.value, t.outcome])).toEqual([
    ["address_to_asset", "198.51.100.77", "empty"],
    ["address_to_internal_peers", "198.51.100.77", "partial"],
    ["address_to_asset", "192.0.2.17", "answered"],
    ["asset_to_accounts", "ws-17.example.net", "answered"],
  ]);
  expect(s.state.cards[r.trail[0]!.card!]!.empty).toBe("proven-negative");
  expect(r.blocked).toEqual([]);
  expect(r.caveats).toEqual(["address_to_internal_peers: partial coverage (row_limit)"]);
  expect(verifyCase(s.dir).ok).toBe(true);
});

test("asking for addresses from an address finds other addresses, never the one given", async () => {
  const r = await runRoute(s, deps, seeker, { have: [SAMPLE_START], want: "address", window: SAMPLE_WINDOW, why: "who talks to it", actor: human });
  expect(r.outcome).toBe("answered");
  expect(r.reached.map((o) => o.value)).toEqual(["192.0.2.17"]);
});

test("an address the sample knows nothing about has no route: the run is blocked after trying each way in", async () => {
  const r = await runRoute(s, deps, seeker, { have: [addr("203.0.113.200")], want: "account", window: SAMPLE_WINDOW, why: "who is behind this", actor: human });
  expect(r.outcome).toBe("blocked");
  expect(r.reached).toEqual([]);
  expect(r.trail.map((t) => [t.hop.pivot, t.outcome])).toEqual([
    ["address_to_asset", "empty"], ["address_to_internal_peers", "empty"], ["address_to_domains", "empty"],
  ]);
  expect(r.blocked).toEqual(["address_to_asset", "address_to_domains"]);
});

test("the unconfirmed lease source is skipped by default, and adds nothing when allowed", async () => {
  const input = { have: [SAMPLE_START], want: "asset", window: SAMPLE_WINDOW, why: "which asset", actor: human };
  const skipped = await runRoute(s, deps, seeker, input);
  expect(skipped.reached.map((o) => o.value)).toEqual(["ws-17.example.net"]);
  expect(skipped.trail.some((t) => t.hop.pivot === "address_to_asset_by_lease")).toBe(false);
  const r = await runRoute(s, deps, seeker, { ...input, limits: { ...DEFAULT_LIMITS, allow_unconfirmed: true } });
  expect(r.reached.map((o) => o.value)).toEqual(["ws-17.example.net"]);
  expect(r.trail.filter((t) => t.hop.pivot === "address_to_asset_by_lease").map((t) => [t.value, t.found, t.outcome])).toEqual([["198.51.100.77", [], "empty"]]);
  expect(r.caveats).toContain("address_to_asset_by_lease: unconfirmed source leases");
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
  expect(dns.status === "done" && dns.data).toEqual([["cdn-update.example.org", "2026-11-20T03:16:00.000Z", "2026-11-23T21:16:00.000Z", 16]]);
  const clients = await pivot("domain_to_clients", "cdn-update.example.org");
  expect(clients.status === "done" && clients.data).toEqual([["192.0.2.17", "2026-11-20T03:16:00.000Z", "2026-11-23T21:16:00.000Z", 16]]);
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

test("the sample's windowed pivots give observed times", async () => {
  const r = await pivot("address_to_domains", "198.51.100.77");
  if (r.status !== "done" || r.card === null) throw new Error(JSON.stringify(r));
  const c = s.state.cards[r.card]!;
  expect(c.columns).toEqual(["name", "first_seen", "last_seen", "events"]);
  expect(c.observed!.found.length).toBeGreaterThan(0);
  expect(c.observed!.found.every((f) => f.first !== null && f.last !== null && f.count !== null && f.first <= f.last)).toBe(true);
  expect(c.observed!.unread).toBe(0);
  expect(c.event_time).toBe(c.observed!.span.first);
  const p = await pivot("address_to_internal_peers", "198.51.100.77");
  if (p.status !== "done" || p.card === null) throw new Error(JSON.stringify(p));
  const peers = s.state.cards[p.card]!.observed!;
  expect(peers.found.length).toBeGreaterThan(0);
  expect(peers.found.every((f) => f.points.length > 0)).toBe(true);
  expect(peers.unread).toBe(0);
  for (const id of ["domain_to_clients", "asset_to_accounts", "account_to_signin_addresses"]) expect(registry.pivot(id)!.times).toMatchObject({ kind: "span", count: "events" });
});

const yamlOf = (...p: string[]): Record<string, unknown> => Bun.YAML.parse(readFileSync(join(REPO_SAMPLE, ...p), "utf8")) as Record<string, unknown>;
const stage = (id: string): { tools: string[] } => yamlOf("stages", `${id}.yaml`) as unknown as { tools: string[] };
const profile = yamlOf("context", "profile.yaml") as unknown as { stages: Record<string, { skills?: string[] }> };

test("Plan, Research and Assemble may ask the person, the reviewers may not, and those three are given the skill", () => {
  for (const id of ["plan", "research", "assemble"]) { expect(stage(id).tools).toContain("ask_person"); expect(profile.stages[id]!.skills).toEqual(["ask-the-person"]); }
  for (const id of ["frame", "evaluate", "challenge", "publish"]) expect(stage(id).tools).not.toContain("ask_person");
  const skill = registry.get("skill", "ask-the-person");
  expect(skill?.title).toBe("Ask the person");
});

test("the sample's pipeline is the loop manifest loops/investigation.yaml: the nine stages by id and the investigation profile", () => {
  const loop = registry.get("loop", "investigation")!;
  expect(loop.body).toEqual({
    kind: "loop", id: "investigation", title: "Investigation",
    about: "Frame a question, plan and run the research, assemble a product, review it and publish it at a person's gate.",
    version: 1, profile: "investigation", entry: "frame", stages: ["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"],
    inputs: { question: { type: "question", required: true }, observables: { type: "observables", required: true }, window: { type: "window", required: true } },
    outputs: { product: { from: "product" }, findings: { from: "findings" }, cards: { from: "cards.kept" } },
  });
  expect(loadPipeline(registry).pipeline!.hash).toBe(SAMPLE_LEGACY_HASH);
});

test("the sample's second loop is loops/triage.yaml: Sort on its own script, then the investigation loop as a sub-loop, with the triage profile", () => {
  const loop = registry.get("loop", "triage")!;
  expect(loop.body).toEqual({
    kind: "loop", id: "triage", title: "Triage",
    about: "Sort a report into a question worth an investigation, then run the investigation loop on it and bring its findings back.",
    version: 1, profile: "triage", entry: "sort",
    stages: [
      {
        id: "sort", title: "Sort", order: 1, phase: "direction", runs: "agent", role: "frame", tools: ["list_sources"], schema: "frame-output",
        model: { provider: "scripted", model: "sample-triage", effort: null }, on_pass: "investigate", on_fail: null,
      },
      {
        id: "investigate", title: "Investigate", order: 2, phase: "collection", runs: "loop", role: "subloop", loop: "investigation",
        inputs: { question: "case.question", observables: "case.observables", window: "case.window" }, returns: { findings: { as: "cards" } }, on_pass: null, on_fail: null,
      },
    ],
    inputs: { question: { type: "question", required: true }, observables: { type: "observables", required: true }, window: { type: "window", required: true } },
    outputs: { cards: { from: "cards.kept" } },
  });
  const triage = registry.get("profile", "triage")!.body as { rules: string; framework: string; standard: string; stages: Record<string, Record<string, unknown>> };
  const investigation = yamlOf("context", "profile.yaml") as { rules: string; framework: string; standard: string };
  expect([triage.rules, triage.framework, triage.standard]).toEqual([investigation.rules, investigation.framework, investigation.standard]);
  expect(Object.keys(triage.stages)).toEqual(["sort"]);
  expect(triage.stages.sort).toMatchObject({ agent: "orchestrator", persona: "orchestrator" });
  expect(String(triage.stages.sort!.goal).split(/[.!?](\s|$)/).filter((x) => x.trim() !== "").length).toBe(1);
  // two turns: one list_sources call, then a frame answer with one goal, about the sample's own address
  const script = registry.get("script", "sample-triage")!.body as { turns: { actor: string; reply: { tool_calls?: { tool: string }[]; content?: string } }[] };
  expect(script.turns.map((t) => t.actor)).toEqual(["orchestrator", "orchestrator"]);
  expect(script.turns[0]!.reply.tool_calls!.map((c) => c.tool)).toEqual(["list_sources"]);
  const answer = JSON.parse(script.turns[1]!.reply.content!) as { goals: { question: string }[] };
  expect(answer.goals).toHaveLength(1);
  expect(answer.goals[0]!.question).toContain(SAMPLE_START.value);
});

test("a case started before slice 12 and stopped at its plan gate goes on to the publish gate under the loops: the hash it recorded, no pause, nothing skipped, replay unchanged", async () => {
  const d = mkdtempSync(join(tmpdir(), "sample-old-"));
  const sample = sampleRoot(d);
  try {
    const config: Config = { ...loadConfig({ env: {}, home: d, repoRoot: d }), data_dir: join(d, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 } };
    // what the workbench ran with before slice 12: the pipeline of every stage manifest, id "default" and the old formula's hash, and no loops
    let wb = Workbench.open(config.data_dir, { onError: () => {} });
    let composed = compose(config, wb);
    const { loops: _l, components: _c, content: _b, ...rest } = composed.deps;
    const old: EngineDeps = { ...rest, pipeline: loadPipeline(composed.deps.registry).pipeline! };
    const first = wb.createCase({ title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" }, human);
    const oldEngine = Engine.open(first, old);
    oldEngine.start(human);
    expect((await oldEngine.advance()).waiting).toBe("plan");
    const before = first.entries();
    const started = before.find((e) => e.type === "run.started")!;
    expect(started.type === "run.started" && [started.payload.pipeline, started.payload.pipeline_hash]).toEqual(["default", SAMPLE_LEGACY_HASH]);
    const id = first.id;
    wb.close();
    composed.close();

    // after the upgrade: the composed deps are the investigation loop's, whose legacy hash is the one the run recorded
    wb = Workbench.open(config.data_dir, { onError: () => {} });
    composed = compose(config, wb);
    try {
      expect(composed.deps.pipeline.id).toBe("investigation");
      expect(composed.deps.pipeline.legacy_hash).toBe(SAMPLE_LEGACY_HASH);
      const again = wb.session(id);
      const engine = Engine.open(again, composed.deps);
      engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
      expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
      const entries = again.entries();
      expect(entries.slice(0, before.length)).toEqual(before);
      expect(entries.some((e) => e.type === "run.paused")).toBe(false);
      expect(entries.some((e) => e.type === "loop.bound")).toBe(false);
      expect(entries.filter((e) => e.type === "run.started").length).toBe(1);
      expect(again.state.skipped).toEqual([]);
      expect(verifyCase(again.dir).ok).toBe(true);
      for (let n = 1; n <= entries.length; n++) {
        const at = fold(entries, n);
        if (n <= before.length) expect(at).toEqual(fold(before, n));
        expect(at.skipped).toEqual([]);
      }
    } finally {
      wb.close();
      composed.close();
    }
  } finally {
    sample.close();
    rmSync(d, { recursive: true, force: true });
  }
});

/** The sample investigation loop's version-2 hash as slice 12's code computed it on the sample as it was before slice 13. */
const SAMPLE_INVESTIGATION_HASH = "ec2e79367acfc215dbbc23642eb0039c9d2f67971ab12618618fd04f68b35c1c";
/** The twelve entry types slice 13 adds; a ledger written before it holds none of them. */
const SLICE_13_TYPES = ["case.type_set", "case.type_proposed", "memory.noted", "memory.revised", "memory.dropped", "memory.bound", "lesson.proposed", "lesson.accepted", "lesson.rejected", "lesson.retired", "memory.exported", "memory.loaded"];

/** What slice 13 adds to the sample root: a case type, two seed lessons and the unknown-device loop with its profile, schemas, persona and script. */
const SLICE_13_SAMPLE_FILES = [
  "case-types.yaml", "memory/unknown-device-lessons.yaml", "loops/unknown-device.yaml", "context/unknown-device-profile.yaml",
  "context/schemas/lessons-output.yaml", "context/schemas/frame-with-type.yaml", "context/personas/reviewer.md", "scripts/sample-device.yaml",
];

test("a case started before slice 13 and stopped at its plan gate goes on to the publish gate once the root has case types and a loop that reads memory: the hash it recorded, no pause, no memory bound, nothing skipped, replay unchanged", async () => {
  const d = mkdtempSync(join(tmpdir(), "sample-pre13-"));
  const sample = sampleRoot(d);
  // the sample as it was before slice 13
  for (const f of SLICE_13_SAMPLE_FILES) rmSync(join(sample.root, f));
  try {
    const config: Config = { ...loadConfig({ env: {}, home: d, repoRoot: d }), data_dir: join(d, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 } };
    // before the slice: the sample as it was, the investigation loop at the hash slice 12 gave it
    let wb = Workbench.open(config.data_dir, { onError: () => {} });
    let composed = compose(config, wb);
    expect(composed.deps.pipeline.hash).toBe(SAMPLE_INVESTIGATION_HASH);
    const first = wb.createCase({ title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" }, human);
    const engine0 = Engine.open(first, composed.deps);
    engine0.start(human);
    expect((await engine0.advance()).waiting).toBe("plan");
    const before = first.entries();
    expect(before.some((e) => SLICE_13_TYPES.includes(e.type))).toBe(false);
    const started = before.find((e) => e.type === "run.started")!;
    expect(started.type === "run.started" && [started.payload.pipeline, started.payload.pipeline_hash]).toEqual(["investigation", SAMPLE_INVESTIGATION_HASH]);
    const id = first.id;
    wb.close();
    composed.close();

    // the root gains what this slice brings: a case-types manifest, a profile that lists memory references and a loop that reads them
    writeFileSync(join(sample.root, "case-types.yaml"), "kind: case-types\nid: sample-types\ntypes:\n  - { id: unknown-device, title: Unknown device }\n");
    const profile = readFileSync(join(sample.root, "context", "profile.yaml"), "utf8").replace("id: investigation", "id: memory-test").replace("    procedure: research-sop\n", "    procedure: research-sop\n    references: [shared-lessons, case-notes]\n");
    writeFileSync(join(sample.root, "context", "memory-profile.yaml"), profile);
    const loopBody = Bun.YAML.parse(readFileSync(join(sample.root, "loops", "investigation.yaml"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(sample.root, "loops", "memo.yaml"), JSON.stringify({
      ...loopBody, id: "memo", title: "Memo", profile: "memory-test", case_type: "unknown-device",
      components: { research: { "reference:shared-lessons": { memory: "shared/unknown-device" }, "reference:case-notes": { memory: "case/notes" } } },
    }));

    wb = Workbench.open(config.data_dir, { onError: () => {} });
    composed = compose(config, wb);
    try {
      expect(composed.problems.filter((p) => p.startsWith("loop "))).toEqual([]);
      expect(composed.deps.loops!.current("memo")).not.toBeNull();
      expect(composed.deps.pipeline.hash).toBe(SAMPLE_INVESTIGATION_HASH);
      const again = wb.session(id);
      const engine = Engine.open(again, composed.deps);
      engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
      expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
      const entries = again.entries();
      expect(entries.slice(0, before.length)).toEqual(before);
      expect(entries.some((e) => e.type === "run.paused")).toBe(false);
      expect(entries.some((e) => SLICE_13_TYPES.includes(e.type))).toBe(false);
      expect(entries.filter((e) => e.type === "run.started").length).toBe(1);
      expect(again.state.memory).toEqual({ type: null, type_by: null, proposed_type: null, notes: {}, order: [], pending: null, bound: null });
      expect(again.state.skipped).toEqual([]);
      expect(verifyCase(again.dir).ok).toBe(true);
      for (let n = 1; n <= entries.length; n++) {
        const at = fold(entries, n);
        if (n <= before.length) expect(at).toEqual(fold(before, n));
        expect(at.skipped).toEqual([]);
      }
    } finally {
      wb.close();
      composed.close();
    }
  } finally {
    sample.close();
    rmSync(d, { recursive: true, force: true });
  }
});

test("the sample's slice 13 files: the unknown-device case type, two TLP:CLEAR seeds of it, and a third loop with every stage inline that reads memory, on its own script", async () => {
  for (const f of SLICE_13_SAMPLE_FILES) expect(`${f}: ${existsSync(join(REPO_SAMPLE, f))}`).toBe(`${f}: true`);
  expect(registry.get("case-types", "sample-case-types")!.body.types).toEqual([
    { id: "unknown-device", title: "Unknown device", about: "A device nobody recognises is on the network: what is it, and does it belong?" },
  ]);
  const seeds = registry.get("lesson-seeds", "sample-unknown-device")!.body.lessons as { id: string; case_type: string; title: string; triggers: unknown[]; marking: string }[];
  expect(seeds.map((l) => [l.id, l.case_type, l.title, l.triggers, l.marking])).toEqual([
    ["connection-message", "unknown-device", "Read the connection message before the lease", [{ observable: "address" }], "TLP:CLEAR"],
    ["complete-list", "unknown-device", "An empty answer proves absence only from a list declared complete", [{ source: "assets" }], "TLP:CLEAR"],
  ]);
  // the loop: nine inline stages on sample-device, the case type, memory at Plan, Research and Assemble, notes at Research and Assemble
  const loop = registry.get("loop", "unknown-device")!.body as { case_type: string; profile: string; stages: Record<string, unknown>[]; components: Record<string, Record<string, unknown>>; uses: { sources: string[] } };
  expect([loop.case_type, loop.profile]).toEqual(["unknown-device", "unknown-device"]);
  expect(loop.stages.map((st) => st.id)).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"]);
  for (const st of loop.stages) if (st.model !== null) expect(st.model).toEqual({ provider: "scripted", model: "sample-device", effort: null });
  // each inline stage is the sample's stage manifest, but for its model and the three changes slice 13 makes
  for (const st of loop.stages) {
    const { kind: _k, model: _m, ...own } = registry.get("stage", st.id as string)!.body as Record<string, unknown>;
    const { model: _n, ...inline } = st;
    const changed = { ...own, ...(st.id === "frame" ? { schema: "frame-with-type" } : {}), ...(st.id === "research" ? { tools: [...(own.tools as string[]), "note_memory"] } : {}),
      ...(st.id === "feedback" ? { runs: "agent", schema: "lessons-output", tools: ["list_cards", "read_card"] } : {}) };
    expect(inline).toEqual(changed);
  }
  expect(loop.components).toEqual({
    plan: { "reference:shared-lessons": { memory: "shared/unknown-device" } },
    research: { "reference:shared-lessons": { memory: "shared/unknown-device" }, "reference:case-notes": { memory: "case/notes" } },
    assemble: { "reference:shared-lessons": { memory: "shared/unknown-device" }, "reference:case-notes": { memory: "case/notes" } },
  });
  expect(loop.uses.sources).toEqual(["wifi", "assets"]);
  const profile = registry.get("profile", "unknown-device")!.body.stages as Record<string, { references?: string[]; agent: string; persona: string; goal: string }>;
  expect([profile.plan!.references, profile.research!.references, profile.assemble!.references]).toEqual([["shared-lessons"], ["shared-lessons", "case-notes"], ["shared-lessons", "case-notes"]]);
  expect(profile.feedback).toEqual({ agent: "reviewer", persona: "reviewer", goal: "Say what would have made this case faster or more correct, as lessons for later cases of its type." });
  expect(registry.get("persona", "reviewer")).not.toBeNull();
  // the script: Frame names the type, the researcher writes one note, the reviewer answers with two lessons
  const script = Bun.YAML.parse(readFileSync(join(REPO_SAMPLE, "scripts", "sample-device.yaml"), "utf8")) as { id: string; turns: { actor: string; reply: { content?: string; tool_calls?: { tool: string }[] } }[] };
  expect(script.id).toBe("sample-device");
  const framed = script.turns.filter((t) => t.actor === "orchestrator" && t.reply.content !== undefined).map((t) => JSON.parse(t.reply.content!) as { case_type?: string });
  expect(framed.map((f) => f.case_type)).toEqual(["unknown-device"]);
  expect(script.turns.flatMap((t) => (t.reply.tool_calls ?? []).filter((c) => c.tool === "note_memory").map(() => t.actor))).toEqual(["researcher-g1"]);
  const reviewer = script.turns.filter((t) => t.actor === "reviewer");
  expect(reviewer.length).toBe(1);
  expect((JSON.parse(reviewer[0]!.reply.content!) as { lessons: unknown[] }).lessons.length).toBe(2);
  // the investigation loop's two hashes are what they were
  const w = Workbench.open(join(dir, "wb13"), { onError: () => {} });
  const config: Config = { ...loadConfig({ env: {}, home: dir, repoRoot: dir }), data_dir: join(dir, "wb13"), roots: [{ path: root, trusted: true, credentials: [] }] };
  const composed = compose(config, w);
  try {
    expect(composed.problems).toEqual([]);
    expect(composed.deps.loops!.current("investigation")!.pipeline.hash).toBe(SAMPLE_INVESTIGATION_HASH);
    expect(composed.deps.loops!.current("investigation")!.pipeline.legacy_hash).toBe(SAMPLE_LEGACY_HASH);
    expect(composed.deps.loops!.current("unknown-device")).not.toBeNull();
  } finally {
    composed.close();
    w.close();
  }
});
