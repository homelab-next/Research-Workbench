import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { buildProduct, DraftWork, draftOf, termsOf } from "../../src/agents/draft";
import { toolSpecs } from "../../src/agents/tools";
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
/** A work copy that knows the sample standard's terms, as Assemble makes one. */
const drafting = (): DraftWork => new DraftWork(null, termsOf(f.sample.registry.get("standard", "icd203")!.body));
const view = (r: { view: Json }): Record<string, Json> => r.view as Record<string, Json>;
const assess = (extra: Record<string, Json> = {}): Record<string, Json> => ({
  why: "w", claim: "it is internal", likelihood: "likely", confidence: "high", confidence_basis: "asset record", cites: ["c1"], assumptions: ["the record is current"], reasoning: "matches", ...extra,
});

test("propose_assessment adds a finding and refuses a card that does not exist", async () => {
  f.ctx.draft = drafting();
  const ok = await f.call("propose_assessment", assess());
  expect(ok).toMatchObject({ ok: true, marking: null });
  expect(view(ok)).toEqual({ finding: "f1" });
  expect(f.ctx.draft.findings[0]).toMatchObject({ id: "f1", statement: "We assess it is likely that it is internal.", likelihood: "likely", cites: ["c1"] });
  const bad = await f.call("propose_assessment", assess({ cites: ["c1", "c99"] }));
  expect(bad.ok).toBe(false);
  expect(view(bad).error).toBe("refused: unknown card: c99; the draft now has finding f1 and no section set");
  expect(f.ctx.draft.findings).toHaveLength(1);
  const again = await f.call("propose_assessment", assess({ claim: "it is revised", replaces: "f1" }));
  expect(view(again)).toEqual({ finding: "f1" });
  expect(f.ctx.draft.findings.map((x) => x.statement)).toEqual(["We assess it is likely that it is revised."]);
  const none = await f.call("propose_assessment", assess({ replaces: "f7" }));
  expect(none.ok).toBe(false);
});

test("propose_assessment with no citation is a schema error", async () => {
  f.ctx.draft = drafting();
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
  expect(view(missing).error).toBe("refused: unknown card: c42; the draft now has no findings and summary set");
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
  expect(view(again).error).toBe(`${id} is not an open challenge; there is no open challenge`);
  const nope = await f.call("answer_challenge", { why: "w", challenge: "x99", answer: "x", action: "rebutted" });
  expect(view(nope).error).toBe("x99 is not an open challenge; there is no open challenge");
});

test("a discarded card cannot be cited", async () => {
  f.ctx.draft = drafting();
  f.s.commit(() => [{ type: "card.discarded", actor: person, payload: { card: "c1" } }]);
  const a = await f.call("propose_assessment", assess());
  expect(view(a).error).toBe("refused: card c1 was discarded; the draft now has no findings and no section set");
  const n = await f.call("propose_narrative", { why: "w", section: "summary", text: "t", cites: ["c1"] });
  expect(view(n).error).toBe("refused: card c1 was discarded; the draft now has no findings and no section set");
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

test("answer_challenge answers an open challenge from any draft of the run, once, and needs a draft in the stage", async () => {
  const hash = reviewable();
  f.ctx.draft_hash = hash;
  const id = view(await f.call("raise_challenge", { why: "w", severity: "consider", text: "t", cites: [] })).challenge as string;
  f.ctx.draft_hash = "1".repeat(64);
  expect((await f.call("answer_challenge", { why: "w", challenge: id, answer: "a", action: "revised" })).ok).toBe(true);
  expect(f.s.state.challenges[id]!.status).toBe("answered");
  expect(view(await f.call("answer_challenge", { why: "w", challenge: id, answer: "a", action: "revised" })).error).toBe(`${id} is not an open challenge; there is no open challenge`);
  f.ctx.draft_hash = null;
  expect((await f.call("answer_challenge", { why: "w", challenge: id, answer: "a", action: "revised" })).ok).toBe(false);
});

test("text fields need a non-blank character", async () => {
  f.ctx.draft = drafting();
  expect((await f.call("propose_assessment", assess({ claim: "   " }))).ok).toBe(false);
  expect((await f.call("propose_assessment", assess({ reasoning: "\n\t" }))).ok).toBe(false);
  expect((await f.call("propose_narrative", { why: "w", section: "summary", text: " ", cites: [] })).ok).toBe(false);
  expect((await f.call("request_research", { why: "w", question: "  " })).ok).toBe(false);
  expect((await f.call("raise_challenge", { why: "w", severity: "consider", text: " ", cites: [] })).ok).toBe(false);
  expect((await f.call("answer_challenge", { why: "w", challenge: "x1", answer: " ", action: "revised" })).ok).toBe(false);
  expect(f.ctx.draft.findings).toEqual([]);
});

// ---- composed wording (task 11 item 1) ----

test("propose_assessment takes a claim, not a statement: the statement is composed from the likelihood and the claim", async () => {
  f.ctx.draft = drafting();
  const old = await f.call("propose_assessment", { ...assess(), statement: "We assess it is likely that it is internal." });
  expect(old.ok).toBe(false);
  expect(view(old).error).toContain("invalid arguments");
  const ok = await f.call("propose_assessment", assess({ claim: "We judge that the host is internal.", likelihood: "very likely" }));
  expect(ok.ok).toBe(true);
  expect(f.ctx.draft.findings[0]!.statement).toBe("We assess it is very likely that the host is internal.");
});

test("a likelihood that is not one of the standard's terms is refused, naming the terms", async () => {
  f.ctx.draft = drafting();
  const r = await f.call("propose_assessment", assess({ likelihood: "probable" }));
  expect(r.ok).toBe(false);
  expect(view(r).error).toBe('refused: "probable" is not a likelihood term of the standard: give one of almost no chance, very unlikely, unlikely, roughly even chance, likely, very likely, almost certain; the draft now has no findings and no section set');
  expect(f.ctx.draft.findings).toEqual([]);
});

test("the claim re-check covers every term and variant of the standard, whole word and any case: the real run's f7 and f8 are refused", async () => {
  f.ctx.draft = drafting();
  const refused = async (claim: string): Promise<string> => {
    const r = await f.call("propose_assessment", assess({ claim }));
    expect(r.ok).toBe(false);
    return String(view(r).error);
  };
  expect(await refused("the device likely connected to the address")).toContain('holds the likelihood term "likely":');
  expect(await refused("We judge that this device probably connected to the address")).toContain('holds the likelihood term "likely" (as "probably")');
  expect(await refused("the device PROBABLY connected")).toContain('(as "probably")');
  expect(await refused("It is Likely that the device connected")).toContain('"likely"');
  expect(await refused("the device very likely connected")).toContain('"very likely"');
  // a term inside another word is not a term
  const ok = await f.call("propose_assessment", assess({ claim: "the device connected to unlikelyhost.example.net and probablyfine.example.org" }));
  expect(ok.ok).toBe(true);
  expect(f.ctx.draft.findings.map((x) => x.statement)).toEqual(["We assess it is likely that the device connected to unlikelyhost.example.net and probablyfine.example.org."]);
});

test("a claim that holds a likelihood term of its own is refused: the likelihood is said once, by the likelihood field", async () => {
  f.ctx.draft = drafting();
  const r = await f.call("propose_assessment", assess({ claim: "the host was probably compromised" }));
  expect(r.ok).toBe(false);
  expect(view(r).error).toBe('refused: the claim holds the likelihood term "likely" (as "probably"): state the claim plainly and give how likely it is only in likelihood; the draft now has no findings and no section set');
  expect(f.ctx.draft.findings).toEqual([]);
});

test("with no standard's terms the drafting tool refuses a finding rather than guess its wording", async () => {
  f.ctx.draft = new DraftWork(null);
  const r = await f.call("propose_assessment", assess());
  expect(view(r).error).toBe("refused: the profile names no standard with likelihood terms, so a finding cannot be worded; the draft now has no findings and no section set");
});

test("while a draft is assembled, the tool's likelihood parameter is the standard's terms as an enum, read from the standard", () => {
  f.ctx.draft = drafting();
  const [spec] = toolSpecs(["propose_assessment"], f.ctx);
  const props = spec!.parameters.properties!;
  expect(props.likelihood).toMatchObject({ type: "string", enum: ["almost no chance", "very unlikely", "unlikely", "roughly even chance", "likely", "very likely", "almost certain"] });
  expect(props.claim).toBeDefined();
  expect(props.statement).toBeUndefined();
  expect(spec!.parameters.required).toContain("claim");
});

// ---- refuse at the source (task 11 item 2) ----

/** A card made by hand: no rows, with this empty meaning and coverage. */
function emptyCard(empty: "not-seen" | "proven-negative" | null, coverage: { kind: "full" } | { kind: "partial"; reason: "row_limit" } | null): string {
  let id = "";
  f.s.commit((_s, ids) => {
    id = ids.next("card");
    return [{ type: "card.created", actor: person, payload: { card: {
      id, title: "t", body: "b", kind: "result", made_by: "human", query: null, columns: [], column_types: [], rows: [], row_count: 0, coverage, empty,
      marking: "TLP:GREEN", source: "assets", step: null, subgoal: null, why: "w", event_time: null, quality_notes: [],
    } } }];
  });
  return id;
}

test("a finding may not cite an empty card that is not a proven negative with full coverage: it is a gap, not evidence", async () => {
  f.ctx.draft = drafting();
  for (const [empty, coverage] of [["not-seen", { kind: "full" }], ["proven-negative", { kind: "partial", reason: "row_limit" }], ["proven-negative", null], [null, { kind: "full" }]] as const) {
    const id = emptyCard(empty, coverage);
    const r = await f.call("propose_assessment", assess({ cites: ["c1", id] }));
    expect(r.ok).toBe(false);
    expect(view(r).error).toBe(`refused: ${id} is not seen (not proof of absence): put it in gaps_and_limits, not in a finding; the draft now has no findings and no section set`);
  }
  expect(f.ctx.draft.findings).toEqual([]);
});

test("a finding may cite an empty card that is a proven negative with full coverage", async () => {
  f.ctx.draft = drafting();
  const id = emptyCard("proven-negative", { kind: "full" });
  const r = await f.call("propose_assessment", assess({ cites: [id] }));
  expect(r.ok).toBe(true);
  expect(f.ctx.draft.findings[0]!.cites).toEqual([id]);
});

test("a finding that cites an unknown or a discarded card is refused, and nothing is added", async () => {
  f.ctx.draft = drafting();
  expect(view(await f.call("propose_assessment", assess({ cites: ["c404"] }))).error).toBe("refused: unknown card: c404; the draft now has no findings and no section set");
  const id = emptyCard("proven-negative", { kind: "full" });
  f.s.commit(() => [{ type: "card.discarded", actor: person, payload: { card: id } }]);
  expect(view(await f.call("propose_assessment", assess({ cites: [id] }))).error).toBe(`refused: card ${id} was discarded; the draft now has no findings and no section set`);
  expect(f.ctx.draft.findings).toEqual([]);
});

// ---- the turn budget (task 12 item 3) ----

test("answer_challenge takes a challenge's id or its exact text, and a miss names the open challenges", async () => {
  f.ctx.draft_hash = reviewable();
  const raise = async (text: string): Promise<string> => view(await f.call("raise_challenge", { why: "w", severity: "must_address", text, cites: [] })).challenge as string;
  const a = await raise("Why is the peer unexplained?");
  const b = await raise("Is the asset record current?");
  const c = await raise("Was the\nwindow wide enough?");
  // by its exact text
  const byText = await f.call("answer_challenge", { why: "w", challenge: "Is the asset record current?", answer: "it is", action: "rebutted" });
  expect(byText.ok).toBe(true);
  expect(view(byText)).toEqual({ answered: b });
  expect(f.s.state.challenges[b]).toMatchObject({ status: "answered", answer: "it is", action: "rebutted" });
  // neither an id nor the text of an open challenge: the open ones are named, each on the one line
  const miss = await f.call("answer_challenge", { why: "w", challenge: "Why is the peer unexplained", answer: "x", action: "revised" });
  expect(miss.ok).toBe(false);
  expect(view(miss).error).toBe(`Why is the peer unexplained is not an open challenge; open challenges: ${a}: Why is the peer unexplained?, ${c}: Was the window wide enough?`);
  // an answered challenge's text no longer matches
  const closed = await f.call("answer_challenge", { why: "w", challenge: "Is the asset record current?", answer: "x", action: "revised" });
  expect(view(closed).error).toStartWith("Is the asset record current? is not an open challenge; open challenges: ");
  // by id, as before
  expect((await f.call("answer_challenge", { why: "w", challenge: a, answer: "explained", action: "revised" })).ok).toBe(true);
});

test("answer_challenge's challenge parameter takes text as long as a challenge's", () => {
  const spec = toolSpecs(["answer_challenge"])[0]!;
  const p = (spec.parameters.properties as Record<string, { maxLength?: number; description?: string }>).challenge!;
  expect(p.maxLength).toBe(4000);
  expect(p.description).toContain("exact text");
});

// ---- the turn budget (task 12 item 4) ----

test("a refused propose call gives the reason and the draft's state in one line", async () => {
  f.ctx.draft = drafting();
  const empty = await f.call("propose_narrative", { why: "w", section: "summary", text: "t", cites: ["c404"] });
  expect(empty.ok).toBe(false);
  expect(view(empty).error).toBe("refused: unknown card: c404; the draft now has no findings and no section set");
  expect(empty.summary).toBe(view(empty).error as string);
  await f.call("propose_assessment", assess());
  await f.call("propose_assessment", assess({ claim: "it is old" }));
  await f.call("propose_assessment", assess({ claim: "it is new" }));
  f.ctx.draft.findings.splice(1, 1);
  await f.call("propose_narrative", { why: "w", section: "gaps_and_limits", text: "the window is short", cites: [] });
  const id = emptyCard("not-seen", { kind: "full" });
  const r = await f.call("propose_assessment", assess({ cites: [id] }));
  expect(view(r).error).toBe(`refused: ${id} is not seen (not proof of absence): put it in gaps_and_limits, not in a finding; the draft now has findings f1, f3 and gaps_and_limits set`);
  // a call refused for its arguments says the same
  const bad = await f.call("propose_assessment", assess({ confidence: "certain" }));
  expect(view(bad).error).toStartWith("refused: invalid arguments: confidence ");
  expect(view(bad).error).toEndWith("; the draft now has findings f1, f3 and gaps_and_limits set");
  await f.call("propose_narrative", { why: "w", section: "summary", text: "s", cites: [] });
  f.ctx.draft.findings.splice(0, 2);
  await f.call("propose_assessment", assess());
  const one = await f.call("propose_narrative", { why: "w", section: "summary", text: "t", cites: ["c404"] });
  expect(view(one).error).toBe("refused: unknown card: c404; the draft now has finding f1 and summary, gaps_and_limits set");
  expect(view(one).error).not.toContain("\n");
});

// ---- the last two form failures (task 15 item 1) ----

test("propose_narrative refuses summary, assessment and alternatives text that names a card which is not seen; gaps_and_limits may name it", async () => {
  f.ctx.draft = drafting();
  for (const [empty, coverage] of [["not-seen", { kind: "full" }], ["proven-negative", { kind: "partial", reason: "row_limit" }], ["proven-negative", null], [null, { kind: "full" }]] as const) {
    f.ctx.draft = drafting();
    const id = emptyCard(empty, coverage);
    for (const section of ["summary", "assessment", "alternatives"]) {
      // named in the text, as a whole word in any case, whether or not it is cited by tool
      const r = await f.call("propose_narrative", { why: "w", section, text: `an outside actor, though ${id.toUpperCase()} shows nothing`, cites: ["c1"] });
      expect(r.ok).toBe(false);
      expect(view(r).error).toBe(`refused: ${id} is not seen (not proof of absence): name it only in gaps_and_limits; the draft now has no findings and no section set`);
    }
    expect(f.ctx.draft.sections.summary).toBe("");
    expect(f.ctx.draft.sections.assessment).toBe("");
    expect(f.ctx.draft.sections.alternatives).toBe("");
    const gaps = await f.call("propose_narrative", { why: "w", section: "gaps_and_limits", text: `${id} returned no rows over the window`, cites: [id] });
    expect(gaps.ok).toBe(true);
  }
});

test("propose_narrative lets a section name a proven negative with full coverage, and a card id inside a longer word is not a name", async () => {
  f.ctx.draft = drafting();
  const id = emptyCard("proven-negative", { kind: "full" });
  const ok = await f.call("propose_narrative", { why: "w", section: "alternatives", text: `an insider is ruled out: ${id} proves it`, cites: [id] });
  expect(ok.ok).toBe(true);
  const gap = emptyCard("not-seen", { kind: "full" });
  const longer = await f.call("propose_narrative", { why: "w", section: "summary", text: `see ${gap}0 and x${gap}`, cites: ["c1"] });
  expect(longer.ok).toBe(true);
});
