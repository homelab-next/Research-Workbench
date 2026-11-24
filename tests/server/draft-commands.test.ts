import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { blockers, latestDraft } from "../../src/core/state";
import type { Actor, Marking, Section } from "../../src/core/types";
import { agentParts } from "../../src/server/converse";
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

/** The model request an agent answers before it writes, at the given marking (the case's by default). */
function requestAs(id: string, marking?: Marking): string {
  const session = s.app.hub.read(id);
  let request = "";
  session.commit((_st, ids) => {
    request = ids.next("request");
    return [{ type: "model.request", actor: agent, payload: {
      request, provider: "scripted", model: "m", effort: null, where: "machine", marking: marking ?? session.state.meta!.marking, pack: [], left_out: [], messages: session.blobs.put("{}"), tools: [],
    } }];
  });
  return request;
}

/** Raises a narrative proposal by hand, as an agent would after its model request, and returns its id. */
function propose(id: string, section: Section, text: string, opts: { marking?: Marking; request?: boolean } = {}): string {
  if (opts.request !== false) requestAs(id, opts.marking);
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

test("approve carries the draft the person saw, and is refused when a newer one exists, writing nothing", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPublishGate(id);
  const seen = latestDraft(state(id))!.hash;
  const p = propose(id, "summary", "A newer summary.");
  expect((await s.command(id, "accept_proposal", { proposal: p })).status).toBe(200);
  await s.app.hub.idle();
  const before = s.entries(id).length;
  const r = await s.command(id, "approve", { draft_hash: seen });
  expect(r).toEqual({ status: 409, body: { ok: false, refused: ["a newer draft arrived; review it before approving"] } });
  expect(s.entries(id).length).toBe(before);
  expect((await s.command(id, "approve", { draft_hash: latestDraft(state(id))!.hash })).status).toBe(200);
  await s.app.hub.idle();
  expect(state(id).run.outcome).toBe("published");
});

test("accept_plan carries the plan the person saw, and is refused when it is not the current one", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPlanGate(id);
  const before = s.entries(id).length;
  const r = await s.command(id, "accept_plan", { plan: "plan-99", budgets: { s3: 1 } });
  expect(r).toEqual({ status: 409, body: { ok: false, refused: ["a newer plan arrived; review it before accepting"] } });
  expect(s.entries(id).length).toBe(before);
  expect((await s.command(id, "accept_plan", { plan: state(id).plan.current!.id, budgets: { s3: 1 } })).status).toBe(200);
});

test("approve without the draft it was shown, and accept_plan without the plan it was shown, are refused by the schema", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPlanGate(id);
  const raw = async (name: string, args: Record<string, unknown>) => (await s.post(`/api/cases/${id}/commands`, { command: name, args })).status;
  const before = s.entries(id).length;
  expect(await raw("accept_plan", { budgets: { s3: 1 } })).toBe(400);
  expect(await raw("approve", {})).toBe(400);
  expect(s.entries(id).length).toBe(before);
});

test("an answer written under a stricter marking keeps that marking when accepted into the draft", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPublishGate(id);
  const session = s.app.hub.read(id);
  expect(session.state.meta!.marking).toBe("TLP:GREEN");
  let turn = "";
  session.commit((_st, ids) => { turn = ids.next("turn"); return [{ type: "agent.asked", actor: { kind: "human", id: "analyst" }, payload: { turn, text: "Earlier?", left_out: [], added: [] } }]; });
  const request = requestAs(id, "TLP:RED");
  session.commit(() => [{ type: "agent.answered", actor: agent, payload: { turn, request, text: "Text a model wrote after reading RED material.", cites: [] } }]);
  expect((await s.command(id, "propose_answer", { turn, section: "summary" })).status).toBe(200);
  const p = Object.values(session.state.proposals).at(-1)!;
  const before = session.state.seq;
  expect((await s.command(id, "accept_proposal", { proposal: p.id })).status).toBe(200);
  const d = latestDraft(session.state)!;
  expect(d.product.summary).toBe("Text a model wrote after reading RED material.");
  expect(d.product.marking).toBe("TLP:RED");
  expect(agentParts(session, s.app.hub.deps, []).find((x) => x.kind === "draft")!.marking).toBe("TLP:RED");
  await s.app.hub.idle();
  // nothing after it goes to a model below RED
  const later = s.entries(id).filter((e) => e.seq > before && e.type === "model.request");
  for (const e of later) if (e.type === "model.request") expect(e.payload.marking).toBe("TLP:RED");
});

test("an agent's proposal carries the marking of the request it answered", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPublishGate(id);
  const p = propose(id, "alternatives", "Other readings.", { marking: "TLP:AMBER" });
  expect((await s.command(id, "accept_proposal", { proposal: p })).status).toBe(200);
  expect(latestDraft(state(id))!.product.marking).toBe("TLP:AMBER");
});

test("a proposal whose text has no known request is refused and stays open", async () => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  await s.toPublishGate(id);
  const n = state(id).drafts.length;
  const p = propose(id, "summary", "Words from nowhere.", { request: false });
  expect(await s.command(id, "accept_proposal", { proposal: p })).toEqual({ status: 409, body: { ok: false, refused: ["the marking of this text is unknown"] } });
  // a person's proposal whose cause is not an answer
  let q = "";
  s.app.hub.read(id).commit((_st, ids) => {
    q = ids.next("proposal");
    return [{ type: "proposal.created", actor: { kind: "human", id: "analyst" }, payload: { proposal: { id: q, kind: "narrative", title: "t", by: "analyst", section: "summary", text: "Mine.", cites: [] } } }];
  });
  expect(await s.command(id, "accept_proposal", { proposal: q })).toEqual({ status: 409, body: { ok: false, refused: ["the marking of this text is unknown"] } });
  expect(state(id).proposals[p]!.status).toBe("open");
  expect(state(id).proposals[q]!.status).toBe("open");
  expect(state(id).drafts.length).toBe(n);
});

test("a draft the analyst wrote after seeing AMBER material is AMBER, and so are the publisher's request and the bundle", async () => {
  s = await served({ before: (root) => {
    const f = `${root}/sources/reputation.yaml`;
    const y = readFileSync(f, "utf8");
    if (!y.includes('marking: "TLP:GREEN"')) throw new Error("reputation.yaml not changed");
    writeFileSync(f, y.replace('marking: "TLP:GREEN"', 'marking: "TLP:AMBER"'));
  } });
  const id = await s.newCase();
  cases.push(id);
  await s.toPublishGate(id);
  expect(state(id).meta!.marking).toBe("TLP:GREEN");
  // the analyst was shown the AMBER verdict: its requests say so
  const analyst = s.entries(id).filter((e) => e.type === "model.request" && e.stage === "assemble");
  expect(analyst.length).toBeGreaterThan(0);
  expect(analyst.every((e) => e.type === "model.request" && e.payload.marking === "TLP:AMBER")).toBe(true);
  const drafts = s.entries(id).filter((e) => e.type === "draft.revised").map((e) => (e.type === "draft.revised" ? e.payload.draft.product.marking : ""));
  expect(drafts.length).toBeGreaterThan(0);
  expect(drafts.every((m) => m === "TLP:AMBER")).toBe(true);
  const d = latestDraft(state(id))!;
  const before = s.entries(id).length;
  expect((await s.command(id, "approve", { draft_hash: d.hash })).status).toBe(200);
  await s.app.hub.idle();
  const after = s.entries(id).slice(before);
  const publisher = after.filter((e) => e.type === "model.request");
  for (const e of publisher) if (e.type === "model.request") expect(e.payload.marking).toBe("TLP:AMBER");
  const published = after.find((e) => e.type === "product.published");
  expect(published).toBeDefined();
  if (published?.type === "product.published") {
    const bundle = JSON.parse(s.app.hub.read(id).blobs.text(published.payload.bundle.blob)) as { manifest: { marking: string } };
    expect(bundle.manifest.marking).toBe("TLP:AMBER");
  }
});
