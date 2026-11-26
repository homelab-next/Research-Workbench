import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import type { CaseSession } from "../../src/core/session";
import type { Actor, Entry, Observable, TimeWindow } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { Refused } from "../../src/core/refused";
import { recoverSession } from "../../src/pipeline/recover";
import { ConnectorPool } from "../../src/modules/connectors";
import { Observables } from "../../src/modules/observables";
import { runPivot } from "../../src/modules/pivots";
import { beginPlaybook, playbookProblem, runPlaybook } from "../../src/modules/playbook-run";
import type { PlaybookEnd, PlaybookStart } from "../../src/modules/playbook-run";
import { toPlaybook } from "../../src/modules/playbooks";
import type { PlaybookManifest } from "../../src/modules/playbooks";
import { Registry } from "../../src/modules/registry";
import type { RunnerDeps } from "../../src/modules/runner";
import { Secrets } from "../../src/modules/secrets";
import { sampleRoot } from "../helpers/sample-root";
import { agent, person, START, WINDOW } from "../helpers/tools-fixture";

const KNOWN = "192.0.2.17";

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let wb: Workbench;
let s: CaseSession;
let deps: RunnerDeps;
let extraPools: ConnectorPool[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "playbook-run-"));
  sample = sampleRoot(dir);
  deps = sample.deps;
  extraPools = [];
  wb = Workbench.open(join(dir, "wb"), { onError: () => {} });
  s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [{ type: "address", value: START }], window: WINDOW, objective: null, marking: "TLP:GREEN" }, person);
});

afterEach(() => {
  expect(s.state.skipped).toEqual([]);
  try { wb.close(); } finally {
    for (const p of extraPools) p.closeAll();
    sample.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const entries = (): Entry[] => s.entries();
const triage = (): PlaybookManifest => deps.registry.playbook("address-triage")!;
const startOf = (inputs: Observable[], playbook = triage(), over: Partial<PlaybookStart> = {}): PlaybookStart =>
  ({ playbook, inputs, window: WINDOW, why: "is it ours", actor: person, ...over });

async function run(inputs: Observable[], playbook = triage(), stop?: () => boolean): Promise<{ job: string; end: PlaybookEnd }> {
  const start = startOf(inputs, playbook);
  const job = beginPlaybook(s, deps, start);
  const end = await runPlaybook(s, deps, job, start, stop);
  expect(end).not.toBeNull();
  return { job, end: end! };
}
const step = (job: string, id: string) => s.state.playbooks[job]!.steps[id]!;

/** A playbook written by the test, built as the registry builds one. */
function written(id: string, body: Record<string, Json>): PlaybookManifest {
  return toPlaybook({ kind: "playbook", id, title: id, ...body }, `hash-${id}`);
}

/** The sample again, after `change` edits its files: a fresh registry over the same root. */
function reloaded(change: () => void): RunnerDeps {
  change();
  const registry = Registry.load([{ path: sample.root, trusted: true, credentials: [] }]);
  const observables = new Observables(registry.types());
  const pool = new ConnectorPool({ secrets: new Secrets({}, null), observables });
  extraPools.push(pool);
  return { registry, pool, observables };
}

test("every lookup is the runner's: issued with purpose playbook, linked to the job, with a card", async () => {
  const { job, end } = await run([{ type: "address", value: START }]);
  const issued = entries().filter((e) => e.type === "query.issued");
  expect(issued.length).toBe(end.lookups);
  expect(end.lookups).toBe(4);
  for (const e of issued) {
    expect(e.type === "query.issued" && e.payload.purpose).toBe("playbook");
    expect(e.job).toBe(job);
    expect(e.actor).toEqual(person);
  }
  for (const id of end.cards) expect(s.state.cards[id]!.query).not.toBeNull();
  expect(entries().filter((e) => e.type === "model.request")).toEqual([]);
  expect(s.state.playbooks[job]!.status).toBe(end.outcome);
  expect(s.state.jobs[job]).toMatchObject({ kind: "playbook", status: "done", title: "Playbook: Triage an address on 198.51.100.77" });
  const started = entries().find((e) => e.type === "playbook.started")!;
  expect(started.type === "playbook.started" && started.payload.steps.map((x) => x.pivot)).toEqual(["address_to_asset", "address_to_asset_by_lease", "address_to_domains", "domain_to_clients"]);
  expect(started.type === "playbook.started" && started.payload.steps[0]!.pivot_hash).toBe(deps.registry.pivot("address_to_asset")!.hash);
  expect(s.state.playbooks[job]!.order).toEqual(["asset", "lease", "names", "clients"]);
});

test("the branch on empty is taken for an address the asset list does not hold, and skipped for one it does", async () => {
  const a = await run([{ type: "address", value: START }]);
  expect(step(a.job, "asset").lookups[0]).toMatchObject({ outcome: "empty", rows: 0, reused: false });
  expect(step(a.job, "lease").status).toBe("ran");
  expect(a.end).toMatchObject({ outcome: "empty", end_step: "asset" });
  expect(a.end.end_cards.map((c) => s.state.cards[c]!.empty)).toEqual(["proven-negative"]);
  const b = await run([{ type: "address", value: KNOWN }]);
  expect(step(b.job, "lease")).toMatchObject({ status: "skipped", reason: "asset returned rows", lookups: [] });
  expect(b.end).toMatchObject({ outcome: "answered", end_step: "asset" });
});

test("with several end steps the outcome is the first listed one that ran", async () => {
  const two: PlaybookManifest = { ...triage(), id: "triage-lease", hash: "hash-two", end: ["lease", "asset"] };
  const a = await run([{ type: "address", value: START }], two);
  expect(a.end.end_step).toBe("lease");
  const b = await run([{ type: "address", value: KNOWN }], two);
  expect(step(b.job, "lease").status).toBe("skipped");
  expect(b.end).toMatchObject({ end_step: "asset", outcome: "answered" });
});

test("a step runs once for each value the earlier step found", async () => {
  const { job } = await run([{ type: "address", value: START }]);
  expect(step(job, "names").found).toContain("cdn-update.example.org");
  expect(step(job, "clients").lookups.map((l) => l.value)).toEqual(step(job, "names").found);
});

test("a second run reuses every full answer and sends nothing", async () => {
  await run([{ type: "address", value: START }]);
  const before = entries().filter((e) => e.type === "query.issued").length;
  const again = await run([{ type: "address", value: START }]);
  expect(entries().filter((e) => e.type === "query.issued").length).toBe(before);
  expect(again.end.reused).toBe(again.end.lookups);
  expect(again.end.lookups).toBe(4);
  expect(Object.values(s.state.playbooks[again.job]!.steps).flatMap((x) => x.lookups).every((l) => l.reused && l.query !== null && l.card !== null)).toBe(true);
});

test("a researcher's answer is reused by a playbook, and a discarded or partial one is not", async () => {
  const r = await runPivot(s, deps, { pivot: "address_to_asset", value: START, window: WINDOW, why: "w", actor: agent });
  expect(r.status).toBe("done");
  const theirs = r.status === "done" ? r : null;
  const a = await run([{ type: "address", value: START }]);
  expect(step(a.job, "asset").lookups[0]).toMatchObject({ reused: true, query: theirs!.query, card: theirs!.card });
  // a discarded answer stands for nothing: the next run asks again (the playbook's own answers are still reused)
  for (const c of [theirs!.card!]) s.commit(() => [{ type: "card.discarded", actor: person, payload: { card: c } }]);
  const sentBefore = entries().filter((e) => e.type === "query.issued").length;
  const b = await run([{ type: "address", value: START }]);
  expect(step(b.job, "asset").lookups[0]).toMatchObject({ reused: false });
  expect(step(b.job, "asset").lookups[0]!.query).not.toBe(theirs!.query);
  expect(entries().filter((e) => e.type === "query.issued").length).toBe(sentBefore + 1);

  // a source capped to one row answers partially; a partial answer is never reused
  const capped = reloaded(() => {
    const path = join(sample.root, "sources", "dns-logs.yaml");
    writeFileSync(path, `${readFileSync(path, "utf8")}limits: { max_rows: 1 }\n`);
  });
  const wide = "203.0.113.10";
  const p = await runPivot(s, capped, { pivot: "address_to_domains", value: wide, window: WINDOW, why: "w", actor: agent });
  expect(p.status === "done" && p.outcome).toBe("partial");
  const only = written("names-only", { inputs: [{ name: "address", type: "address" }], steps: [{ id: "names", pivot: "address_to_domains", from: "input.address" }] });
  const start = startOf([{ type: "address", value: wide }], only);
  const job = beginPlaybook(s, capped, start);
  const end = (await runPlaybook(s, capped, job, start))!;
  expect(step(job, "names").lookups[0]).toMatchObject({ reused: false, outcome: "partial" });
  expect(end).toMatchObject({ outcome: "partial", reused: 0, lookups: 1 });
  expect(end.caveats.some((c) => c.startsWith("names: partial coverage (row_limit"))).toBe(true);
});

test("a step that could not be decided skips what depends on it", async () => {
  renameSync(join(sample.root, "data", "assets.csv"), join(sample.root, "data", "assets.gone"));
  const { job, end } = await run([{ type: "address", value: START }]);
  expect(step(job, "asset").lookups[0]!.outcome).toBe("failed");
  expect(step(job, "lease")).toMatchObject({ status: "skipped", reason: "could not tell whether asset was empty" });
  expect(step(job, "names").status).toBe("ran");
  expect(end).toMatchObject({ outcome: "failed", end_step: "asset" });
});

test("the fan-out cap leaves the count in the step and in the caveats", async () => {
  const fan = written("fan", {
    inputs: [{ name: "address", type: "address" }],
    steps: [{ id: "names", pivot: "address_to_domains", from: "input.address" }, { id: "clients", pivot: "domain_to_clients", from: "names", max_values: 1 }],
  });
  const { job, end } = await run([{ type: "address", value: "203.0.113.30" }], fan);
  expect(step(job, "names").found.length).toBe(2);
  expect(step(job, "clients").left).toBe(1);
  expect(step(job, "clients").lookups.map((l) => l.value)).toEqual([step(job, "names").found[0]!]);
  expect(end.caveats).toContain("clients: 1 values not followed (limit 1)");
});

test("the run stops at 50 lookups and says so", async () => {
  const pivots = ["address_to_asset", "address_to_asset_by_lease", "address_to_internal_peers"];
  const wide = written("wide", {
    inputs: [{ name: "address", type: "address" }],
    steps: [
      { id: "names", pivot: "address_to_domains", from: "input.address" },
      { id: "clients", pivot: "domain_to_clients", from: "names", max_values: 20 },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `s${i + 3}`, pivot: pivots[i % 3]!, from: "clients", max_values: 20 })),
    ],
  });
  const { end } = await run([{ type: "address", value: "203.0.113.10" }], wide);
  expect(end.lookups).toBe(50);
  expect(end.caveats).toContain("stopped after 50 lookups");
  expect(entries().filter((e) => e.type === "query.issued").length).toBe(50 - end.reused);
}, 30_000); // fifty lookups against the sample's files take a few seconds on a loaded machine

test("a costly step waits for a budget and the rest run", async () => {
  const costly = written("costly", {
    inputs: [{ name: "address", type: "address" }],
    steps: [{ id: "verdict", pivot: "address_to_verdict", from: "input.address" }, { id: "names", pivot: "address_to_domains", from: "input.address" }],
    end: ["verdict"],
  });
  const { job, end } = await run([{ type: "address", value: START }], costly);
  expect(step(job, "verdict").lookups[0]).toMatchObject({ outcome: "needs_budget", query: null, card: null, reused: false });
  expect(step(job, "names").status).toBe("ran");
  expect(entries().filter((e) => e.type === "proposal.created")).toEqual([]);
  // nothing was sent to the costly source, not even to price it
  expect(entries().filter((e) => e.type === "query.issued" && e.payload.source === "reputation")).toEqual([]);
  expect(end.caveats).toContain("verdict: address_to_verdict needs a budget");
  expect(end).toMatchObject({ outcome: "blocked", end_step: "verdict", lookups: 1 });
});

test("stop is asked before each lookup, and a stopped run does not read as answered", async () => {
  let asked = 0;
  const { job, end } = await run([{ type: "address", value: KNOWN }], triage(), () => asked++ >= 1);
  expect(entries().filter((e) => e.type === "query.issued").length).toBe(1);
  expect(end.caveats).toContain("stopped before every lookup was sent");
  // the end step (asset) had run before the stop, so its answer stands
  expect(end).toMatchObject({ outcome: "answered", end_step: "asset", lookups: 1 });
  expect(Object.keys(s.state.playbooks[job]!.steps)).toEqual(["asset", "lease"]);
  // a stop before the end step ran leaves it blocked
  const late: PlaybookManifest = { ...triage(), id: "late", hash: "hash-late", end: ["names"] };
  const b = await run([{ type: "address", value: START }], late, () => true);
  expect(b.end).toMatchObject({ outcome: "blocked", end_step: null, lookups: 0 });
});

test("an interrupted playbook reads interrupted, and its re-run sends only what had no full answer", async () => {
  const start = startOf([{ type: "address", value: START }]);
  const job = beginPlaybook(s, deps, start); // started, never run: as a stopped server leaves it
  recoverSession(s);
  expect(s.state.jobs[job]!.status).toBe("failed");
  expect(s.state.playbooks[job]!.status).toBe("interrupted");
  expect(await runPlaybook(s, deps, job, start)).toBeNull();
  const by = await runPivot(s, deps, { pivot: "address_to_asset", value: START, window: WINDOW, why: "w", actor: person, purpose: "playbook" });
  expect(by.status).toBe("done");
  const before = entries().filter((e) => e.type === "query.issued").length;
  const again = await run([{ type: "address", value: START }]);
  expect(again.end.reused).toBe(1);
  expect(step(again.job, "asset").lookups[0]).toMatchObject({ reused: true, query: by.status === "done" ? by.query : "" });
  expect(entries().filter((e) => e.type === "query.issued").length).toBe(before + again.end.lookups - 1);
});

test("a job that threw is ended failed and reads interrupted", async () => {
  const start = startOf([{ type: "address", value: START }]);
  const job = beginPlaybook(s, deps, start);
  const broken: RunnerDeps = { ...deps, registry: new Proxy(deps.registry, { get: (t, k) => (k === "pivot" ? () => { throw new Error("boom"); } : Reflect.get(t, k)) }) };
  await expect(runPlaybook(s, broken, job, start)).rejects.toThrow("boom");
  expect(s.state.jobs[job]!.status).toBe("failed");
  expect(s.state.playbooks[job]!.status).toBe("interrupted");
});

test("bad inputs are refused before anything is written", () => {
  const n = entries().length;
  const address = (value: string): Observable => ({ type: "address", value });
  const cases: [Observable[], string, TimeWindow?][] = [
    [[], "the playbook needs a address for address"],
    [[address(START), address(KNOWN)], "the playbook needs a address for address"],
    [[address("not-an-address")], "\"not-an-address\" is not a address"],
    [[address(START), { type: "domain", value: "cdn-update.example.org" }], "the playbook takes no domain"],
    [[address(START)], "this playbook needs a window with both ends set", { from: null, to: WINDOW.to }],
  ];
  for (const [inputs, why, window] of cases) {
    expect(playbookProblem(deps, triage(), inputs, window ?? WINDOW)).toBe(why);
    expect(() => beginPlaybook(s, deps, startOf(inputs, triage(), window === undefined ? {} : { window }))).toThrow(new Refused(why));
  }
  // never an agent's
  const asAgent: Actor = agent;
  expect(() => beginPlaybook(s, deps, startOf([address(START)], triage(), { actor: asAgent }))).toThrow(Refused);
  expect(playbookProblem(deps, triage(), [address(START)], WINDOW)).toBeNull();
  expect(entries().length).toBe(n);
});

/** The sample's asset list without the rows for these addresses (so a lookup of them comes back empty, a proven negative), reloaded. */
const assetsWithout = (...gone: string[]): RunnerDeps => reloaded(() => {
  const f = join(sample.root, "data", "assets.csv");
  writeFileSync(f, readFileSync(f, "utf8").split("\n").filter((l) => !gone.some((g) => l.includes(`,${g},`))).join("\n"));
});

test("a fan-out step with values left unfollowed is not empty: it is blocked, and a branch on its empty is not taken", async () => {
  // final review I1: twenty of twenty-one addresses were never asked, yet the step read empty and the sub-goal "no, proven"
  const d = assetsWithout("192.0.2.28");
  const fan = written("fan-left", {
    inputs: [{ name: "address", type: "address" }],
    steps: [
      { id: "names", pivot: "address_to_domains", from: "input.address" },
      { id: "clients", pivot: "domain_to_clients", from: "names" },
      { id: "asset", pivot: "address_to_asset", from: "clients", max_values: 1 },
      { id: "lease", pivot: "address_to_asset_by_lease", from: "clients", when: "asset.empty", max_values: 1 },
    ],
    end: ["asset"],
  });
  const start = startOf([{ type: "address", value: "203.0.113.30" }], fan);
  const job = beginPlaybook(s, d, start);
  const end = (await runPlaybook(s, d, job, start))!;
  const a = step(job, "asset");
  expect(a.left).toBeGreaterThan(0);
  expect(a.lookups.every((l) => l.outcome === "empty")).toBe(true);
  expect(end.outcome).toBe("blocked");
  expect(end.caveats.some((c) => c.startsWith("asset: ") && c.includes("values not followed"))).toBe(true);
  expect(step(job, "lease")).toMatchObject({ status: "skipped", reason: "could not tell whether asset was empty" });
});

test("a step fed by a partial step is not empty when every lookup comes back empty: it is blocked", async () => {
  // final review I1: the upstream step was partial, so the list the end step walked may be short
  const wide = "203.0.113.30";
  const peers = await runPivot(s, deps, { pivot: "address_to_internal_peers", value: wide, window: WINDOW, why: "w", actor: agent });
  const first = peers.status === "done" ? [...new Set(peers.data.flatMap((r) => r.map(String)))] : [];
  expect(first.length).toBeGreaterThan(1);
  const d = reloaded(() => {
    const path = join(sample.root, "sources", "flows.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("max_rows: 200", "max_rows: 1"));
    const f = join(sample.root, "data", "assets.csv");
    writeFileSync(f, readFileSync(f, "utf8").split("\n").filter((l) => !first.some((g) => l.includes(`,${g},`))).join("\n"));
  });
  const fed = written("fed-partial", {
    inputs: [{ name: "address", type: "address" }],
    steps: [{ id: "peers", pivot: "address_to_internal_peers", from: "input.address" }, { id: "asset", pivot: "address_to_asset", from: "peers" }],
    end: ["asset"],
  });
  const start = startOf([{ type: "address", value: wide }], fed);
  const job = beginPlaybook(s, d, start);
  const end = (await runPlaybook(s, d, job, start))!;
  expect(step(job, "peers").lookups[0]!.outcome).toBe("partial");
  expect(step(job, "asset").lookups.length).toBeGreaterThan(0);
  expect(step(job, "asset").lookups.every((l) => l.outcome === "empty")).toBe(true);
  expect(end.outcome).toBe("blocked");
});
