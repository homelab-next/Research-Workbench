// Slice 9 goal 5 in the planner's pack: a Plan pass after a plan was accepted is told what a partly used playbook would also have fetched.
import { afterEach, expect, test } from "bun:test";
import { gapsPart } from "../../src/pipeline/glean";
import { agent, fixture, person, PLAN } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
afterEach(() => { expect(f.s.state.skipped).toEqual([]); f.close(); });

/** The fixture's plan, proposed by an agent answering a TLP:AMBER request, and accepted. */
function accepted(): void {
  f = fixture(false);
  f.s.commit((_st, ids) => [{ type: "model.request", actor: agent, payload: { request: ids.next("request"), provider: "scripted", model: "m", effort: null, where: "machine", marking: "TLP:AMBER", pack: [], left_out: [], messages: f.s.blobs.put("{}"), tools: [] } }]);
  f.s.commit((_st, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: PLAN(ids.next("plan")) } }]);
  f.s.commit(() => [{ type: "plan.accepted", actor: person, payload: { plan: "plan-1", steps: ["s1", "s2", "s3", "s4"], budgets: {} } }]);
}

test("an accepted plan that uses one lookup of address-triage gives the planner a part naming the rest", () => {
  accepted();
  const part = gapsPart(f.s.state, f.s.entries(), f.sample.registry)!;
  expect(part).toMatchObject({ kind: "playbook-gaps", id: "playbook-gaps", title: "What the playbooks would also have fetched", fixed: false, marking: "TLP:AMBER" });
  expect(part.text).toContain("- The plan uses address_to_asset of the playbook Triage an address (address-triage, from address) as single pivots; the playbook would also have fetched: ");
  expect(part.text).toContain("(address_to_asset_by_lease, finds asset)");
  expect(part.text).toContain("(address_to_domains, finds domain)");
  expect(part.text).toContain("(domain_to_clients, finds address)");
});

test("with no plan, or none accepted, there is no part", () => {
  f = fixture(false);
  expect(gapsPart(f.s.state, f.s.entries(), f.sample.registry)).toBeNull();
});
