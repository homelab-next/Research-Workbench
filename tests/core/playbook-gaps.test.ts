// Slice 9 goal 5: a plan that uses some of a playbook's lookups as single pivots says what the playbook would also have fetched.
import { expect, test } from "bun:test";
import { gapsText, playbookGaps } from "../../src/core/state/gaps";
import type { Plan, PlanStep } from "../../src/core/types";

const win = { from: null, to: null };
const step = (id: string, subgoal: string, pivot: string, from: string, to: string, value: string, playbook?: PlanStep["playbook"]): PlanStep => ({
  id, subgoal, pivot, source: "s", from: { type: from, value }, to, window: win, needs_window: false, free: true, weight: 0, estimate: null, empty_means: "not-seen", warnings: [],
  ...(playbook === undefined ? {} : { playbook }),
});
const plan = (steps: PlanStep[]): Plan => ({
  id: "plan-1", goal: "g", window: win, steps,
  subgoals: [...new Set(steps.map((x) => x.subgoal))].map((g) => ({ id: g, title: g, question: "q", steps: steps.filter((x) => x.subgoal === g).map((x) => x.id) })),
});
const PLAYBOOKS = [{
  id: "address-triage", title: "Triage an address", inputs: [{ type: "address" }],
  steps: [{ id: "asset", pivot: "address_to_asset" }, { id: "lease", pivot: "address_to_asset_by_lease" }, { id: "wifi", pivot: "address_to_wifi" }, { id: "again", pivot: "address_to_asset" }],
}];
const PIVOTS = [
  { id: "address_to_asset", title: "Asset with the address", to: "asset" },
  { id: "address_to_asset_by_lease", title: "Asset by lease", to: "asset" },
  { id: "address_to_wifi", title: "WiFi messages for the address", to: "host" },
  { id: "asset_to_accounts", title: "Accounts on the asset", to: "account" },
];

test("single pivots that cover part of a playbook for the same start type name what the playbook would also have fetched", () => {
  const p = plan([step("s1", "g1", "address_to_asset_by_lease", "address", "asset", "192.0.2.61"), step("s2", "g1", "asset_to_accounts", "asset", "account", "")]);
  const gaps = playbookGaps(p, null, PLAYBOOKS, PIVOTS);
  expect(gaps).toEqual([{
    playbook: "address-triage", title: "Triage an address", from: "address", used: ["address_to_asset_by_lease"],
    also: [{ pivot: "address_to_asset", title: "Asset with the address", to: "asset" }, { pivot: "address_to_wifi", title: "WiFi messages for the address", to: "host" }],
  }]);
  expect(gapsText(gaps)).toBe(
    "- The plan uses address_to_asset_by_lease of the playbook Triage an address (address-triage, from address) as single pivots; the playbook would also have fetched: Asset with the address (address_to_asset, finds asset); WiFi messages for the address (address_to_wifi, finds host).",
  );
});

test("an accepted plan counts only its accepted steps", () => {
  const p = plan([step("s1", "g1", "address_to_asset_by_lease", "address", "asset", "192.0.2.61"), step("s2", "g2", "address_to_wifi", "address", "host", "192.0.2.61")]);
  expect(playbookGaps(p, ["s1", "s2"], PLAYBOOKS, PIVOTS)[0]!.also.map((x) => x.pivot)).toEqual(["address_to_asset"]);
  expect(playbookGaps(p, ["s1"], PLAYBOOKS, PIVOTS)[0]!.also.map((x) => x.pivot)).toEqual(["address_to_asset", "address_to_wifi"]);
});

test("no note when the plan uses none of the playbook, all of it, the playbook itself, or starts from another type", () => {
  const none = plan([step("s1", "g1", "asset_to_accounts", "asset", "account", "ws-17.example.net")]);
  expect(playbookGaps(none, null, PLAYBOOKS, PIVOTS)).toEqual([]);
  const all = plan(["address_to_asset", "address_to_asset_by_lease", "address_to_wifi"].map((pv, i) => step(`s${i + 1}`, `g${i + 1}`, pv, "address", "x", "192.0.2.61")));
  expect(playbookGaps(all, null, PLAYBOOKS, PIVOTS)).toEqual([]);
  const itself = plan([step("s1", "g1", "", "address", "asset", "192.0.2.61", { id: "address-triage", hash: "h", inputs: [{ type: "address", value: "192.0.2.61" }] }),
    step("s2", "g2", "address_to_asset_by_lease", "address", "asset", "192.0.2.61")]);
  expect(playbookGaps(itself, null, PLAYBOOKS, PIVOTS)).toEqual([]);
  // a lookup the playbook makes, used only in a sub-goal that starts from another type, is not the playbook skipped
  const other = plan([step("s1", "g1", "x_to_address", "asset", "address", "ws-17.example.net"), step("s2", "g1", "address_to_asset_by_lease", "address", "asset", "")]);
  expect(playbookGaps(other, null, PLAYBOOKS, PIVOTS)).toEqual([]);
  expect(gapsText([])).toBe("");
});
