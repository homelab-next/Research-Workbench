import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { buildProduct, DraftWork, draftOf } from "../../src/agents/draft";
import { agent, person } from "../helpers/tools-fixture";
import { fixture } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";
import type { ToolName } from "../../src/agents/tools";

let f: Fixture;
beforeEach(async () => {
  f = fixture(true);
  await f.call("run_step", { step: "s1", why: "w" });
});
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});
const view = (r: { view: Json }): Record<string, Json> => r.view as Record<string, Json>;
const assess = (extra: Record<string, Json> = {}): Record<string, Json> => ({
  why: "w", statement: "it is internal", likelihood: "likely", confidence: "high", confidence_basis: "asset record", cites: ["c1"], assumptions: ["the record is current"], reasoning: "matches", ...extra,
});

test("propose_assessment adds a finding and refuses a card that does not exist", async () => {
  f.ctx.draft = new DraftWork(null);
  const ok = await f.call("propose_assessment", assess());
  expect(ok).toMatchObject({ ok: true, marking: null });
  expect(view(ok)).toEqual({ finding: "f1" });
  expect(f.ctx.draft.findings[0]).toMatchObject({ id: "f1", statement: "it is internal", cites: ["c1"] });
  const bad = await f.call("propose_assessment", assess({ cites: ["c1", "c99"] }));
  expect(bad.ok).toBe(false);
  expect(view(bad).error).toBe("unknown card: c99");
  expect(f.ctx.draft.findings).toHaveLength(1);
  const again = await f.call("propose_assessment", assess({ statement: "revised", replaces: "f1" }));
  expect(view(again)).toEqual({ finding: "f1" });
  expect(f.ctx.draft.findings.map((x) => x.statement)).toEqual(["revised"]);
  const none = await f.call("propose_assessment", assess({ replaces: "f7" }));
  expect(none.ok).toBe(false);
});

test("propose_assessment with no citation is a schema error", async () => {
  f.ctx.draft = new DraftWork(null);
  const r = await f.call("propose_assessment", assess({ cites: [] }));
  expect(r.ok).toBe(false);
  expect(view(r).error).toContain("invalid arguments");
  const bad = await f.call("propose_assessment", assess({ confidence: "certain" }));
  expect(bad.ok).toBe(false);
  expect(f.ctx.draft.findings).toEqual([]);
});

test("propose_narrative sets a section and refuses key_findings", async () => {
  f.ctx.draft = new DraftWork(null);
  const ok = await f.call("propose_narrative", { why: "w", section: "summary", text: "all clear", cites: ["c1"] });
  expect(ok.ok).toBe(true);
  expect(view(ok)).toEqual({ section: "summary" });
  expect(f.ctx.draft.sections.summary).toBe("all clear");
  const kf = await f.call("propose_narrative", { why: "w", section: "key_findings", text: "x", cites: ["c1"] });
  expect(kf.ok).toBe(false);
  expect(view(kf).error).toContain("invalid arguments");
  const missing = await f.call("propose_narrative", { why: "w", section: "alternatives", text: "x", cites: ["c42"] });
  expect(view(missing).error).toBe("unknown card: c42");
  expect(f.ctx.draft.sections.alternatives).toBe("");
});

test("the drafting tools fail plainly outside a drafting stage", async () => {
  expect(f.ctx.draft).toBeNull();
  for (const [name, args] of [
    ["propose_assessment", assess()], ["propose_narrative", { why: "w", section: "summary", text: "t", cites: ["c1"] }], ["request_research", { why: "w", question: "q" }],
  ] as [ToolName, Record<string, Json>][]) {
    const r = await f.call(name, args);
    expect(r).toMatchObject({ ok: false, view: { error: "no draft is being assembled in this stage" } });
  }
  expect(f.s.entries().some((e) => e.type === "research.requested")).toBe(false);
  const c = await f.call("raise_challenge", { why: "w", severity: "consider", text: "t", cites: ["c1"] });
  expect(view(c).error).toBe("no draft is under review in this stage");
});

test("request_research is recorded with its why", async () => {
  f.ctx.draft = new DraftWork(null);
  const r = await f.call("request_research", { why: "the peers are unexplained", question: "who runs the peer?" });
  expect(view(r)).toEqual({ requested: true });
  expect(f.ctx.draft.research).toEqual([{ question: "who runs the peer?", why: "the peers are unexplained" }]);
  const e = f.s.entries().filter((x) => x.type === "research.requested");
  expect(e).toHaveLength(1);
  expect(e[0]!.payload).toEqual({ question: "who runs the peer?", why: "the peers are unexplained" });
  expect(e[0]!.actor).toEqual(agent);
});

function reviewable(): string {
  const w = new DraftWork(null);
  w.setFinding({ statement: "s", likelihood: "l", confidence: "low", confidence_basis: "b", cites: ["c1"], assumptions: [], reasoning: "r" }, null);
  const p = buildProduct(w, { objective: "o", question: "q", case_marking: "TLP:GREEN", cards: f.s.state.cards, source: (id) => f.sample.registry.source(id), assumptions: [], change: "first" });
  const d = draftOf(p, 1, person, "first");
  expect(d.hash).toBe(sha256Hex(canonical(p as unknown as Json)));
  f.s.commit(() => [{ type: "draft.revised", actor: person, payload: { draft: d } }]);
  return d.hash;
}

test("raise_challenge records the challenge against the draft under review", async () => {
  const hash = reviewable();
  f.ctx.draft_hash = hash;
  const r = await f.call("raise_challenge", { why: "w", severity: "must_address", text: "the peer is unexplained", cites: ["c1"] });
  expect(r).toMatchObject({ ok: true, marking: null });
  const id = view(r).challenge as string;
  expect(f.s.state.challenges[id]).toMatchObject({ draft_hash: hash, severity: "must_address", text: "the peer is unexplained", cites: ["c1"], status: "open" });
  const bad = await f.call("raise_challenge", { why: "w", severity: "consider", text: "t", cites: ["c9"] });
  expect(view(bad).error).toBe("unknown card: c9");
  expect(Object.keys(f.s.state.challenges)).toEqual([id]);
});

test("answer_challenge closes an open challenge and refuses a closed one", async () => {
  f.ctx.draft_hash = reviewable();
  const id = view(await f.call("raise_challenge", { why: "w", severity: "consider", text: "t", cites: [] })).challenge as string;
  const r = await f.call("answer_challenge", { why: "w", challenge: id, answer: "fixed", action: "revised" });
  expect(r.ok).toBe(true);
  expect(view(r)).toEqual({ answered: id });
  expect(f.s.state.challenges[id]).toMatchObject({ status: "answered", answer: "fixed", action: "revised" });
  const again = await f.call("answer_challenge", { why: "w", challenge: id, answer: "x", action: "rebutted" });
  expect(view(again).error).toBe(`challenge ${id} is not open`);
  const nope = await f.call("answer_challenge", { why: "w", challenge: "x99", answer: "x", action: "rebutted" });
  expect(view(nope).error).toBe("challenge x99 is not open");
});

test("a discarded card cannot be cited", async () => {
  f.ctx.draft = new DraftWork(null);
  f.s.commit(() => [{ type: "card.discarded", actor: person, payload: { card: "c1" } }]);
  const a = await f.call("propose_assessment", assess());
  expect(view(a).error).toBe("card c1 was discarded");
  const n = await f.call("propose_narrative", { why: "w", section: "summary", text: "t", cites: ["c1"] });
  expect(view(n).error).toBe("card c1 was discarded");
  expect(f.ctx.draft.findings).toEqual([]);
});

test("narrative citations are kept in the work", async () => {
  f.ctx.draft = new DraftWork(null);
  await f.call("propose_narrative", { why: "w", section: "summary", text: "t", cites: ["c1"] });
  expect(f.ctx.draft.narrativeCites.summary).toEqual(["c1"]);
});

test("raise_challenge refuses a hash with no review, and the state holds what was committed", async () => {
  f.ctx.draft_hash = "0".repeat(64);
  const r = await f.call("raise_challenge", { why: "w", severity: "consider", text: "t", cites: [] });
  expect(view(r).error).toBe("no draft is under review in this stage");
  expect(Object.keys(f.s.state.challenges)).toEqual([]);
});

test("answer_challenge answers only a challenge against the draft under review", async () => {
  const hash = reviewable();
  f.ctx.draft_hash = hash;
  const id = view(await f.call("raise_challenge", { why: "w", severity: "consider", text: "t", cites: [] })).challenge as string;
  f.ctx.draft_hash = "1".repeat(64);
  const r = await f.call("answer_challenge", { why: "w", challenge: id, answer: "a", action: "revised" });
  expect(view(r).error).toBe(`challenge ${id} is not open`);
  expect(f.s.state.challenges[id]!.status).toBe("open");
});

test("text fields need a non-blank character", async () => {
  f.ctx.draft = new DraftWork(null);
  expect((await f.call("propose_assessment", assess({ statement: "   " }))).ok).toBe(false);
  expect((await f.call("propose_assessment", assess({ reasoning: "\n\t" }))).ok).toBe(false);
  expect((await f.call("propose_narrative", { why: "w", section: "summary", text: " ", cites: [] })).ok).toBe(false);
  expect((await f.call("request_research", { why: "w", question: "  " })).ok).toBe(false);
  expect((await f.call("raise_challenge", { why: "w", severity: "consider", text: " ", cites: [] })).ok).toBe(false);
  expect((await f.call("answer_challenge", { why: "w", challenge: "x1", answer: " ", action: "revised" })).ok).toBe(false);
  expect(f.ctx.draft.findings).toEqual([]);
});
