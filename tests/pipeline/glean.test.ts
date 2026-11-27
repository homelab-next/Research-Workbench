// Slice 9 goal 3: what the values the workbench extracted open up, listed by code for the planner, and the research stage's send-back.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../src/core/workbench";
import type { CaseSession } from "../../src/core/session";
import type { Actor, Plan, PlanStep, TimeWindow } from "../../src/core/types";
import { loadRegistry } from "../../src/modules/registry-record";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import { ConnectorPool } from "../../src/modules/connectors";
import type { RunnerDeps } from "../../src/modules/runner";
import { runPivot } from "../../src/modules/pivots";
import { cheapestSeeker, DEFAULT_LIMITS } from "../../src/modules/seeker";
import type { Seeker } from "../../src/modules/seeker";
import type { Registry } from "../../src/modules/registry";
import { GLEAN_PREFIX, DEFAULT_GLEAN_SENDBACKS, gleanOf, gleanPart, gleanSendBack, gleanText } from "../../src/pipeline/glean";
import { loadConfig } from "../../src/modules/config";

const human: Actor = { kind: "human", id: "analyst" };
const planner: Actor = { kind: "agent", id: "planner", stage: "plan", profile: "p", model: "m", effort: null, where: "machine" };
const win: TimeWindow = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };
const START = "192.0.2.44";
const DEVICE = "ws-23.example.net";

const FILES: Record<string, string> = {
  "types.yaml": `kind: types
types:
  - { id: address, title: Address, pattern: '(?:\\d{1,3}\\.){3}\\d{1,3}' }
  - { id: host, title: Host, pattern: '[a-z]{2,6}-\\d{1,3}' }
  - { id: account, title: Account, pattern: '[a-z]\\.[a-z]{2,20}' }
  - { id: asset, title: Asset, pattern: '[a-z]{2,6}-\\d{1,3}\\.example\\.net' }
`,
  "sources/wifi.yaml": `kind: source
id: wifi
title: WiFi controller log
connector: files
location: data
marking: "TLP:AMBER"
where: machine
tables:
  - name: wifi
    file: wifi.jsonl
    format: jsonl
    time_column: ts
    columns:
      - { name: ts }
      - { name: address, type: address }
      - name: message
        reveals: The host name the device announced, and the access point it joined.
        extract:
          - { id: device, type: asset, pattern: '^(\\S+) [0-9a-f]{2}:[0-9a-f]{2} connected to ' }
          - { id: access_point, type: host, pattern: ' connected to (\\S+?)\\. Connection Info:' }
`,
  "sources/leases.yaml": `kind: source
id: leases
title: Leases
connector: files
location: data
marking: "TLP:GREEN"
where: machine
tables:
  - { name: leases, file: leases.csv, format: csv, time_column: null, columns: [{ name: address, type: address }, { name: asset, type: asset }] }
`,
  "sources/signins.yaml": `kind: source
id: signins
title: Sign-ins
connector: files
location: data
marking: "TLP:GREEN"
where: machine
tables:
  - { name: signins, file: signins.csv, format: csv, time_column: null, columns: [{ name: host, type: asset }, { name: account, type: account }] }
`,
  "pivots.yaml": `kind: pivots
pivots:
  - { id: address_to_wifi, title: WiFi messages for the address, from: address, to: address, source: wifi, query: "select ts, address, message from wifi where address = {value}", empty_means: not-seen, yields: { address: address } }
  - { id: address_to_asset_by_lease, title: Asset by lease, from: address, to: asset, source: leases, query: "select asset from leases where address = {value}", empty_means: not-seen, yields: { asset: asset } }
  - { id: asset_to_accounts, title: Accounts that signed in to the asset, answers: Which accounts signed in to this asset?, from: asset, to: account, source: signins, query: "select account from signins where host = {value}", empty_means: not-seen, yields: { account: account } }
`,
  "sources/data/wifi.jsonl": `${JSON.stringify({ ts: "2026-01-03T10:00:00.000Z", address: START, message: `${DEVICE} 3f:9a connected to ap-9. Connection Info: band=5GHz` })}\n`,
  "sources/data/leases.csv": "address,asset\n192.0.2.200,pc-1.example.net\n",
  "sources/data/signins.csv": `host,account\n${DEVICE},k.lund\n`,
};

let dir: string;
let wb: Workbench;
let s: CaseSession;
let registry: Registry;
let pool: ConnectorPool;
let deps: RunnerDeps;
let seeker: Seeker;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glean-"));
  const root = join(dir, "modules");
  for (const [name, text] of Object.entries(FILES)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
  expect(registry.problems).toEqual([]);
  const observables = new Observables(registry.types());
  pool = new ConnectorPool({ secrets: new Secrets({}, null), observables });
  deps = { registry, pool, observables };
  seeker = cheapestSeeker(registry);
  wb = Workbench.open(join(dir, "data"), { onError: () => {} });
  s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [{ type: "address", value: START }], window: win, objective: null, marking: "TLP:GREEN" }, human);
});
afterEach(() => {
  expect(s.state.skipped).toEqual([]);
  pool.closeAll();
  try { wb.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const step = (id: string, subgoal: string, pivot: string, source: string, from: string, to: string, value: string): PlanStep => ({
  id, subgoal, pivot, source, from: { type: from, value }, to, window: win, needs_window: false, free: true, weight: 0, estimate: null, empty_means: "not-seen", warnings: [],
});
/** g1: what joined the WiFi (one step); g2: who uses the device, by lease then sign-ins (its lease lookup finds nothing, so it stays open). */
const PLAN = (id: string, extra: PlanStep[] = []): Plan => ({
  id, goal: "what is the device", window: win,
  subgoals: [
    { id: "g1", title: "What joined the WiFi", question: "What device joined?", steps: ["s1"] },
    { id: "g2", title: "Who uses the device", question: "Which account uses it?", steps: ["s2", "s3", ...extra.map((x) => x.id)] },
  ],
  steps: [step("s1", "g1", "address_to_wifi", "wifi", "address", "address", START), step("s2", "g2", "address_to_asset_by_lease", "leases", "address", "asset", START),
    step("s3", "g2", "asset_to_accounts", "signins", "asset", "account", ""), ...extra],
});
function acceptPlan(extra: PlanStep[] = []): void {
  s.commit((_st, ids) => [{ type: "plan.proposed", actor: planner, payload: { plan: PLAN(ids.next("plan"), extra) } }]);
  const id = s.state.plan.current!.id;
  s.commit(() => [{ type: "plan.accepted", actor: human, payload: { plan: id, steps: s.state.plan.current!.steps.map((x) => x.id), budgets: {} } }]);
}
/** Runs a step as research would, recording its outcome on the plan. */
async function runStep(id: string, value: string): Promise<void> {
  const st = s.state.plan.current!.steps.find((x) => x.id === id)!;
  s.commit(() => [{ type: "step.started", actor: human, payload: { step: id, by: "workbench" } }]);
  const r = await runPivot(s, deps, { pivot: st.pivot, value, window: win, why: "w", actor: human, step: id, subgoal: st.subgoal });
  if (r.status !== "done") throw new Error(JSON.stringify(r));
  s.commit(() => [{ type: "step.finished", actor: human, payload: { step: id, outcome: r.outcome, cards: r.card === null ? [] : [r.card], note: "" } }]);
}
const glean = () => gleanOf(s.state, s.entries(), { registry, seeker }, DEFAULT_LIMITS);

test("before any plan is accepted there is nothing to glean", async () => {
  await runPivot(s, deps, { pivot: "address_to_wifi", value: START, window: win, why: "w", actor: human });
  expect(glean()).toBeNull();
});

test("a value extracted since the last accepted plan is listed with the pivots from its type and the open sub-goals it bears on", async () => {
  acceptPlan();
  await runStep("s1", START);
  await runStep("s2", START);
  const g = glean()!;
  expect(g.openings.map((o) => `${o.type} ${o.value}`)).toEqual([`asset ${DEVICE}`, "host ap-9"]);
  const device = g.openings[0]!;
  expect(device).toMatchObject({ card: "c1", rule: "device", column: "message", marking: "TLP:AMBER", visited: false, covered: false });
  expect(device.leads).toEqual([{ pivot: "asset_to_accounts", title: "Accounts that signed in to the asset", cost: "free", reveals: "Which accounts signed in to this asset? Finds account." }]);
  // g1 is answered; g2 (its lease lookup found nothing) is open and wants an account, which asset_to_accounts reaches
  expect(device.bears).toEqual([{ subgoal: "g2", title: "Who uses the device", want: "account", route: ["asset_to_accounts"] }]);
  expect(g.openings[1]!.leads).toEqual([]);
  expect(g.openings[1]!.bears).toEqual([]);
});

test("the planner's part says what each new value opens up, in code's words, as strict as the cards and the plan", async () => {
  acceptPlan();
  await runStep("s1", START);
  await runStep("s2", START);
  const text = gleanText(glean()!.openings);
  expect(text).toContain(`- asset ${DEVICE} (card c1, rule device on column message; code-derived)`);
  expect(text).toContain("  pivots from asset: asset_to_accounts (free): Which accounts signed in to this asset? Finds account.");
  expect(text).toContain('  bears on: g2 "Who uses the device" (wants account) by asset_to_accounts');
  expect(text).toContain("- host ap-9 (card c1, rule access_point on column message; code-derived)");
  expect(text).toContain("  no pivot starts from host");
  const part = gleanPart(s.state, s.entries(), { registry, seeker }, DEFAULT_LIMITS, [])!;
  expect(part).toMatchObject({ kind: "glean", id: "glean", title: "What the new values open up", fixed: false, marking: "TLP:AMBER" });
});

test("a value from before the last accepted plan is not new, and with nothing new there is no part", async () => {
  acceptPlan();
  await runStep("s1", START);
  acceptPlan();
  expect(glean()!.openings).toEqual([]);
  expect(gleanPart(s.state, s.entries(), { registry, seeker }, DEFAULT_LIMITS, [])).toBeNull();
});

test("a value already looked up is visited, and one an accepted step starts from is covered: neither sends work back", async () => {
  acceptPlan();
  await runStep("s1", START);
  await runStep("s2", START);
  expect(gleanSendBack(s.state, s.entries(), glean()!.openings, { cap: DEFAULT_GLEAN_SENDBACKS, stage: "research" })).toStartWith(GLEAN_PREFIX);
  await runPivot(s, deps, { pivot: "asset_to_accounts", value: DEVICE, window: win, why: "w", actor: human });
  expect(glean()!.openings[0]!.visited).toBe(true);
  expect(gleanSendBack(s.state, s.entries(), glean()!.openings, { cap: DEFAULT_GLEAN_SENDBACKS, stage: "research" })).toBeNull();
});

test("an accepted step from the value covers it", async () => {
  acceptPlan([step("s4", "g2", "asset_to_accounts", "signins", "asset", "account", DEVICE)]);
  await runStep("s1", START);
  await runStep("s2", START);
  expect(glean()!.openings[0]!.covered).toBe(true);
  expect(gleanSendBack(s.state, s.entries(), glean()!.openings, { cap: 2, stage: "research" })).toBeNull();
});

test("the send-back names each value and route, and stops at the cap counted in this run", async () => {
  acceptPlan();
  await runStep("s1", START);
  await runStep("s2", START);
  const reason = gleanSendBack(s.state, s.entries(), glean()!.openings, { cap: 2, stage: "research" })!;
  expect(reason).toBe(`${GLEAN_PREFIX}: asset ${DEVICE} (card c1) opens asset_to_accounts to g2 "Who uses the device" (wants account), and no accepted step starts from it. Re-plan to follow it, or leave it.`);
  expect(gleanSendBack(s.state, s.entries(), glean()!.openings, { cap: 0, stage: "research" })).toBeNull();
  // two earlier glean send-backs in this run reach a cap of two
  s.commit((_st, ids) => [{ type: "run.started", actor: human, payload: { run: ids.next("run"), pipeline: "p", pipeline_hash: "h", stages: [] } }]);
  const run = s.state.run.id;
  for (let i = 0; i < 2; i++) {
    s.commit(() => [{ type: "stage.finished", actor: { kind: "system", id: "engine" }, run, stage: "research", payload: { stage: "research", attempt: i + 1, outcome: "fail", draft_hash: null, output: null, reason } }]);
  }
  expect(gleanSendBack(s.state, s.entries(), glean()!.openings, { cap: 2, stage: "research" })).toBeNull();
  expect(gleanSendBack(s.state, s.entries(), glean()!.openings, { cap: 3, stage: "research" })).toStartWith(GLEAN_PREFIX);
});

test("the cap is configurable and defaults to two", () => {
  expect(DEFAULT_GLEAN_SENDBACKS).toBe(2);
  expect(loadConfig({ env: {}, home: dir, repoRoot: dir }).glean).toEqual({ max_sendbacks: 2 });
  const f = join(dir, "c.yaml");
  writeFileSync(f, "glean: { max_sendbacks: 0 }\n");
  expect(loadConfig({ path: f, env: {}, home: dir, repoRoot: dir }).glean).toEqual({ max_sendbacks: 0 });
});
