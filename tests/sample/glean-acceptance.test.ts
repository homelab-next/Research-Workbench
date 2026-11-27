// Slice 9 acceptance: a value the workbench extracts from a WiFi message is offered to the planner and followed.
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry } from "../../src/core/types";
import { verifyCase } from "../../src/core/verify";
import { GLEAN_PREFIX } from "../../src/pipeline/glean";
import { SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served | null = null;
afterEach(async () => { await s?.close(); s = null; });

const ADDRESS = "192.0.2.61";
const DEVICE = "ws-17.example.net";
const say = (x: unknown): Record<string, unknown> => ({ content: JSON.stringify(x) });

/** The whole script: frame; a plan whose second sub-goal (by lease) finds nothing; then a second plan that starts from the extracted device. */
const TURNS = [
  { actor: "orchestrator", reply: say({
    goals: [
      { title: "What joined the WiFi", question: `Which device held ${ADDRESS} on the WiFi?`, want: "host" },
      { title: "Who uses the device", question: `Which account uses the device at ${ADDRESS}?`, want: "account" },
    ],
    window: SAMPLE_WINDOW, limits: { allow_unconfirmed: true, max_weight: null }, notes: "The address is not in the asset list.",
  }) },
  { actor: "planner", reply: say({
    goal: `Find the device at ${ADDRESS} and who uses it`,
    subgoals: [
      { title: "What joined the WiFi", question: `Which device held ${ADDRESS} on the WiFi?`, have: [{ type: "address", value: ADDRESS }], want: "host", route: ["address_to_wifi"] },
      { title: "Who uses the device", question: `Which account uses the device at ${ADDRESS}?`, have: [{ type: "address", value: ADDRESS }], want: "account", route: ["address_to_asset_by_lease", "asset_to_accounts"] },
    ],
  }) },
  { actor: "researcher-g1", reply: say({ outcome: "answered", found: [{ type: "host", value: "ap-3" }], note: "The device joined ap-3." }) },
  { actor: "researcher-g2", reply: say({ outcome: "blocked", found: [], note: "No lease names the address." }) },
  // the second pass: the planner follows the device the workbench extracted from the connection message
  { actor: "planner", reply: say({
    goal: `Find who uses ${DEVICE}, the device at ${ADDRESS}`,
    subgoals: [
      { title: "Who uses the device", question: `Which account uses ${DEVICE}?`, have: [{ type: "asset", value: DEVICE }], want: "account", route: ["asset_to_accounts"] },
    ],
  }) },
  { actor: "researcher-g1", reply: say({ outcome: "answered", found: [{ type: "account", value: "j.doe" }], note: "j.doe signs in to the device." }) },
];

test("a hostname extracted from a WiFi message is offered to the planner, Research sends the work back for it once, and the planner follows it", async () => {
  s = await served({ before: (root) => writeFileSync(join(root, "scripts", "sample-run.yaml"), JSON.stringify({ kind: "script", id: "sample-run", title: "WiFi device", turns: TURNS }, null, 1)) });
  const id = await s.newCase({ title: "Unknown WiFi device", asked: `What is the device at ${ADDRESS} on the WiFi, and who uses it?`, starting: [{ type: "address", value: ADDRESS }], objective: null });
  await s.toPlanGate(id);
  expect((await s.command(id, "accept_plan")).status).toBe(200);
  await s.app.hub.idle();
  // the work came back to Plan; the person accepts the new plan
  expect(s.app.hub.read(id).state.plan.status).toBe("proposed");
  expect((await s.command(id, "accept_plan")).status).toBe(200);
  await s.app.hub.idle();
  const session = s.app.hub.read(id);

  // the WiFi card carries the device the message named, code-derived
  const wifi = Object.values(session.state.cards).find((c) => c.query !== null && c.title.startsWith("WiFi messages for the address"))!;
  expect(wifi.extracted).toContainEqual({ type: "asset", value: DEVICE, column: "message", rule: "device", row: 0, by: "code" });

  // Research sent the work back to Plan once, naming the value and the route to the open sub-goal
  const entries = s.entries(id);
  const finished = entries.filter((e): e is Extract<Entry, { type: "stage.finished" }> => e.type === "stage.finished" && e.payload.stage === "research");
  const gleaned = finished.filter((e) => e.payload.outcome === "fail" && (e.payload.reason ?? "").startsWith(GLEAN_PREFIX));
  expect(gleaned).toHaveLength(1);
  expect(gleaned[0]!.payload.reason).toContain(`asset ${DEVICE} (card ${wifi.id}) opens asset_to_accounts to g2 "Who uses the device" (wants account)`);
  expect(entries.some((e) => e.type === "stage.sent_back" && e.payload.from === "research" && e.payload.to === "plan" && e.payload.reason.startsWith(GLEAN_PREFIX))).toBe(true);

  // the planner's first pack had no glean part; its second had one, listing the device and what it opens up
  const asked = entries.filter((e): e is Extract<Entry, { type: "model.request" }> => e.type === "model.request" && e.actor.kind === "agent" && e.actor.id === "planner");
  expect(asked).toHaveLength(2);
  expect(asked[0]!.payload.pack.some((p) => p.kind === "glean")).toBe(false);
  expect(asked[1]!.payload.pack.find((p) => p.kind === "glean")).toMatchObject({ id: "glean", title: "What the new values open up" });
  const sent = session.blobs.text(asked[1]!.payload.messages.blob);
  expect(sent).toContain(`- asset ${DEVICE} (card ${wifi.id}, rule device on column message; code-derived)`);
  expect(sent).toContain('bears on: g2 \\"Who uses the device\\" (wants account) by asset_to_accounts');
  // the first plan ran the lease lookup alone: the second pass is told what address-triage would also have fetched
  expect(asked[1]!.payload.pack.some((p) => p.kind === "playbook-gaps")).toBe(true);
  expect(sent).toContain("The plan uses address_to_asset_by_lease of the playbook Triage an address (address-triage, from address) as single pivots");

  // the second plan starts from the device, and its step found the account
  const plan = session.state.plan;
  expect(plan.status).toBe("accepted");
  expect(plan.current!.steps).toMatchObject([{ pivot: "asset_to_accounts", from: { type: "asset", value: DEVICE } }]);
  const step = plan.steps[plan.current!.steps[0]!.id]!;
  expect(step.status).toBe("answered");
  const accounts = session.state.cards[step.cards[0]!]!;
  expect(accounts.rows.map((r) => r[0])).toContain("j.doe");
  // the second Research did not send the work back again: it passed
  expect(finished[finished.length - 1]!.payload.outcome).toBe("pass");

  expect(session.state.skipped).toEqual([]);
  expect(verifyCase(session.dir).ok).toBe(true);
});
