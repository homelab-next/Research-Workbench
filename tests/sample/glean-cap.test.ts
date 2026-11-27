// Slice 9: the glean send-back's cap, driven through the engine: glean.max_sendbacks from the configuration bounds it in a run.
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry } from "../../src/core/types";
import { GLEAN_PREFIX } from "../../src/pipeline/glean";
import { SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served | null = null;
afterEach(async () => { await s?.close(); s = null; });

const say = (x: unknown): Record<string, unknown> => ({ content: JSON.stringify(x) });
const FRAME = { actor: "orchestrator", reply: say({
  goals: [
    { title: "What joined the WiFi", question: "Which device held the address on the WiFi?", want: "host" },
    { title: "Who uses the device", question: "Which account uses the device?", want: "account" },
  ],
  window: SAMPLE_WINDOW, limits: { allow_unconfirmed: true, max_weight: null }, notes: "The address is not in the asset list.",
}) };
/** A plan whose WiFi lookup extracts the device at `address`, and whose lease lookup for it finds nothing (so "Who uses the device" stays open). */
const plan = (address: string) => ({ actor: "planner", reply: say({
  goal: `Find the device at ${address} and who uses it`,
  subgoals: [
    { title: "What joined the WiFi", question: `Which device held ${address} on the WiFi?`, have: [{ type: "address", value: address }], want: "host", route: ["address_to_wifi"] },
    { title: "Who uses the device", question: `Which account uses the device at ${address}?`, have: [{ type: "address", value: address }], want: "account", route: ["address_to_asset_by_lease", "asset_to_accounts"] },
  ],
}) });
const RESEARCH = [
  { actor: "researcher-g1", reply: say({ outcome: "answered", found: [], note: "The device joined the WiFi." }) },
  { actor: "researcher-g2", reply: say({ outcome: "blocked", found: [], note: "No lease names the address." }) },
];

async function start(turns: unknown[], max_sendbacks: number): Promise<{ id: string; served: Served }> {
  s = await served({
    config: { glean: { max_sendbacks } },
    before: (root) => writeFileSync(join(root, "scripts", "sample-run.yaml"), JSON.stringify({ kind: "script", id: "sample-run", title: "WiFi device", turns }, null, 1)),
  });
  const id = await s.newCase({ title: "Unknown WiFi device", asked: "What is the device on the WiFi, and who uses it?", starting: [{ type: "address", value: "192.0.2.61" }], objective: null });
  await s.toPlanGate(id);
  expect((await s.command(id, "accept_plan")).status).toBe(200);
  await s.app.hub.idle();
  return { id, served: s };
}
const research = (entries: Entry[]) => entries.filter((e): e is Extract<Entry, { type: "stage.finished" }> => e.type === "stage.finished" && e.payload.stage === "research");
const gleaned = (entries: Entry[]) => research(entries).filter((e) => e.payload.outcome === "fail" && (e.payload.reason ?? "").startsWith(GLEAN_PREFIX));

test("with glean.max_sendbacks 0 Research never sends the work back for new values, though one is followable", async () => {
  const { id, served: sv } = await start([FRAME, plan("192.0.2.61"), ...RESEARCH], 0);
  const entries = sv.entries(id);
  const session = sv.app.hub.read(id);
  // the WiFi card gave the device, which no query used and no step starts from
  expect(Object.values(session.state.cards).some((c) => (c.extracted ?? []).some((x) => x.value === "ws-17.example.net"))).toBe(true);
  expect(gleaned(entries)).toEqual([]);
  expect(research(entries).map((e) => e.payload.outcome)).toEqual(["pass"]);
  expect(entries.some((e) => e.type === "stage.sent_back" && e.payload.from === "research")).toBe(false);
  expect(session.state.skipped).toEqual([]);
});

test("with glean.max_sendbacks 1 the second Research pass with a new followable value passes", async () => {
  const { id, served: sv } = await start([FRAME, plan("192.0.2.61"), ...RESEARCH, plan("192.0.2.62"), ...RESEARCH], 1);
  // the first pass sent the work back; the person accepts the second plan
  expect(sv.app.hub.read(id).state.plan.status).toBe("proposed");
  expect((await sv.command(id, "accept_plan")).status).toBe(200);
  await sv.app.hub.idle();
  const entries = sv.entries(id);
  const session = sv.app.hub.read(id);
  // the second pass extracted pr-2, new since the second plan and followable, yet the cap of one is spent
  const second = Object.values(session.state.cards).find((c) => (c.extracted ?? []).some((x) => x.value === "pr-2.example.net"));
  expect(second).toBeDefined();
  expect(gleaned(entries)).toHaveLength(1);
  expect(research(entries).map((e) => e.payload.outcome)).toEqual(["fail", "pass"]);
  expect(session.state.skipped).toEqual([]);
});
