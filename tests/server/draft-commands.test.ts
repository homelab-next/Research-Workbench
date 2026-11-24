import { afterEach, expect, test } from "bun:test";
import { blockers, latestDraft } from "../../src/core/state";
import type { Actor, Section } from "../../src/core/types";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served;
const cases: string[] = [];
afterEach(async () => {
  try {
    for (const id of cases) expect(s.app.hub.read(id).state.skipped).toEqual([]);
  } finally {
    cases.length = 0;
    await s?.close();
  }
});

const agent: Actor = { kind: "agent", id: "assistant", stage: "agent", profile: "investigation", model: "m", effort: null, where: "machine" };
const state = (id: string) => s.app.hub.read(id).state;

/** Raises a narrative proposal by hand, as the agent pane will, and returns its id. */
function propose(id: string, section: Section, text: string): string {
  let made = "";
  s.app.hub.read(id).commit((_st, ids) => {
    made = ids.next("proposal");
    return [{ type: "proposal.created", actor: agent, payload: { proposal: { id: made, kind: "narrative", title: `Proposed ${section}`, by: "assistant", section, text, cites: ["c1"] } } }];
  });
  return made;
}

test("accepting a narrative proposal makes a new revision in the person's name and review starts again", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPublishGate(id);
  const before = latestDraft(state(id))!;
  const p = propose(id, "summary", "A new summary [c1].");
  expect((await s.command(id, "accept_proposal", { proposal: p })).status).toBe(200);
  await s.app.hub.idle();
  const d = latestDraft(state(id))!;
  expect(d.n).toBe(before.n + 1);
  expect(d.product.summary).toBe("A new summary [c1].");
  expect(d.product.assessment).toBe(before.product.assessment);
  expect(d.author).toEqual({ kind: "human", id: s.config.user });
  expect(d.reason).toBe(`accepted proposal ${p}`);
  expect(state(id).proposals[p]!.status).toBe("accepted");
  expect(state(id).run.waiting).toBe("publish");                              // the scripted reviewers pass it again
  expect(blockers(state(id), d.hash)).toEqual([]);
});

test("the person's own text replaces the proposal's when one is sent", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPublishGate(id);
  const p = propose(id, "alternatives", "Proposed words.");
  expect((await s.command(id, "accept_proposal", { proposal: p, text: "My own words." })).status).toBe(200);
  await s.app.hub.idle();
  expect(latestDraft(state(id))!.product.alternatives).toBe("My own words.");
});

test("with no draft it is refused and the proposal stays open", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPlanGate(id);
  const p = propose(id, "summary", "Words.");
  const r = await s.command(id, "accept_proposal", { proposal: p });
  expect(r).toEqual({ status: 409, body: { ok: false, refused: ["there is no draft yet to put this in"] } });
  expect(state(id).proposals[p]!.status).toBe("open");
  expect(state(id).drafts).toEqual([]);
});

test("a costly_query proposal is not a narrative one", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPublishGate(id);
  s.app.hub.read(id).commit((_st, ids) => [{ type: "proposal.created", actor: agent, payload: { proposal: {
    id: ids.next("proposal"), kind: "costly_query", title: "t", by: "assistant", step: null, subgoal: null, source: "reputation", pivot: null, pivot_hash: null,
    source_hash: "h", text: "q", bound: {}, window: { from: null, to: null }, estimate: null, why: "w",
  } } }]);
  const costly = Object.values(state(id).proposals).find((x) => x.kind === "costly_query" && x.status === "open")!.id;
  const r = await s.command(id, "accept_proposal", { proposal: costly });
  expect(r.status).toBe(409);
  expect(state(id).proposals[costly]!.status).toBe("open");
});

test("a proposal already decided, or unknown, is refused", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPublishGate(id);
  const p = propose(id, "summary", "Words.");
  expect((await s.command(id, "reject_proposal", { proposal: p, reason: "no" })).status).toBe(200);
  expect((await s.command(id, "accept_proposal", { proposal: p })).status).toBe(409);
  expect((await s.command(id, "accept_proposal", { proposal: "p99" })).status).toBe(409);
});

test("a refused revision leaves the proposal open", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPublishGate(id);
  const same = latestDraft(state(id))!.product.summary;
  const p = propose(id, "summary", same);
  const r = await s.command(id, "accept_proposal", { proposal: p });
  expect(r.status).toBe(409);
  expect(state(id).proposals[p]!.status).toBe("open");
});
