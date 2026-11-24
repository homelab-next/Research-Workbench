import { expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CardState } from "../../src/core/state/types";
import type { Actor, Finding, Product } from "../../src/core/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildProduct, CARD_REF, cardRefs, citedBy, composeChange, composeStatement, DraftWork, draftOf, likelihoodTermsIn, termsOf, withFormExceptions } from "../../src/agents/draft";
import { ToolError } from "../../src/agents/tools";
import type { SourceManifest } from "../../src/modules/manifests";

const analyst: Actor = { kind: "agent", id: "analyst", stage: "analysis", profile: "investigation", model: "s", effort: null, where: "machine" };
const f = (statement: string, cites: string[] = ["c1"]): Omit<Finding, "id"> => ({
  statement, likelihood: "likely", confidence: "moderate", confidence_basis: "two sources", cites, assumptions: [], reasoning: "because",
});
const card = (id: string, source: string | null, marking: string, notes: string[] = []): CardState => ({ id, source, marking, quality_notes: notes } as unknown as CardState);
const src = (id: string, quality: string, notes: { id: string; text: string }[]): SourceManifest => ({ id, quality, quality_notes: notes } as unknown as SourceManifest);
const SOURCES: Record<string, SourceManifest> = {
  dns: src("dns", "good", [{ id: "n1", text: "duplicated" }, { id: "n2", text: "gap on Monday" }]),
  assets: src("assets", "fair", []),
};
const facts = (cards: Record<string, CardState>, extra: Partial<Parameters<typeof buildProduct>[1]> = {}): Parameters<typeof buildProduct>[1] => ({
  objective: "obj", question: "q?", case_marking: "TLP:GREEN", cards, source: (id) => SOURCES[id] ?? null, assumptions: ["a1"], change: "first", ...extra,
});

test("findings are numbered in order and a replacement keeps its id", () => {
  const w = new DraftWork(null);
  expect(w.setFinding(f("a"), null)).toBe("f1");
  expect(w.setFinding(f("b"), null)).toBe("f2");
  expect(w.setFinding(f("a2"), "f1")).toBe("f1");
  expect(w.findings.map((x) => x.statement)).toEqual(["a2", "b"]);
});

test("replacing a finding that does not exist is a ToolError", () => {
  const w = new DraftWork(null);
  expect(() => w.setFinding(f("a"), "f9")).toThrow(ToolError);
});

test("a new revision starts from the previous one", () => {
  const w = new DraftWork(null);
  w.setFinding(f("a"), null);
  w.setSection("summary", "sum");
  const p = buildProduct(w, facts({ c1: card("c1", "dns", "TLP:GREEN") }));
  const next = new DraftWork(p);
  expect(next.findings.map((x) => x.statement)).toEqual(["a"]);
  expect(next.sections.summary).toBe("sum");
  expect(next.setFinding(f("b"), null)).toBe("f2");
  expect(w.findings).toHaveLength(1);
  expect(next.findings).toHaveLength(2);
});

test("the product's marking is the strictest of the case and the cited cards", () => {
  const w = new DraftWork(null);
  w.setFinding(f("a", ["c1"]), null);
  const cards = { c1: card("c1", "dns", "TLP:AMBER"), c2: card("c2", "dns", "TLP:RED") };
  expect(buildProduct(w, facts(cards)).marking).toBe("TLP:AMBER");
  expect(buildProduct(w, facts(cards, { case_marking: "TLP:RED" })).marking).toBe("TLP:RED");
  expect(buildProduct(new DraftWork(null), facts(cards)).marking).toBe("TLP:GREEN");
});

test("each cited source appears once with its quality and the notes on the cited cards", () => {
  const w = new DraftWork(null);
  w.setFinding(f("a", ["c1", "c2"]), null);
  w.setFinding(f("b", ["c3", "c4"]), null);
  const cards = {
    c1: card("c1", "dns", "TLP:GREEN", ["n1"]), c2: card("c2", "dns", "TLP:GREEN", ["n2"]),
    c3: card("c3", "assets", "TLP:GREEN"), c4: card("c4", null, "TLP:GREEN"), c5: card("c5", "dns", "TLP:GREEN", ["n1"]),
  };
  const p = buildProduct(w, facts(cards));
  expect(p.sources).toEqual([{ source: "assets", quality: "fair" }, { source: "dns", quality: "good duplicated gap on Monday" }]);
});

test("draftOf hashes the canonical product", () => {
  const w = new DraftWork(null);
  w.setFinding(f("a"), null);
  const p = buildProduct(w, facts({ c1: card("c1", "dns", "TLP:GREEN") }));
  const d = draftOf(p, 1, analyst, "first draft");
  expect(d.hash).toBe(sha256Hex(canonical(p as unknown as Json)));
  expect(d).toMatchObject({ n: 1, author: analyst, reason: "first draft" });
});

test("the same work and facts always give the same hash", () => {
  const make = (): string => {
    const w = new DraftWork(null);
    w.setFinding(f("a", ["c1", "c2"]), null);
    w.setSection("assessment", "x");
    const cards = { c1: card("c1", "dns", "TLP:GREEN", ["n1"]), c2: card("c2", "assets", "TLP:AMBER") };
    return draftOf(buildProduct(w, facts(cards)), 1, analyst, "r").hash;
  };
  expect(make()).toBe(make());
  const p: Product = buildProduct(new DraftWork(null), facts({}));
  expect(draftOf(p, 1, analyst, "r").hash).not.toBe(draftOf({ ...p, summary: "changed" }, 1, analyst, "r").hash);
});

test("a finding carried over that cites a card since discarded refuses the build, naming the finding", () => {
  const w = new DraftWork(null);
  w.setFinding(f("a", ["c1"]), null);
  const prev = buildProduct(w, facts({ c1: card("c1", "dns", "TLP:GREEN") }));
  const gone = { ...card("c1", "dns", "TLP:GREEN"), place: "discarded" } as unknown as CardState;
  expect(() => buildProduct(new DraftWork(prev), facts({ c1: gone }))).toThrow(/f1.*c1.*discarded/);
});

test("a narrative's citations count toward the product's marking and sources", () => {
  const w = new DraftWork(null);
  w.setFinding(f("a", ["c1"]), null);
  w.setSection("summary", "text", ["c2"]);
  const cards = { c1: card("c1", "assets", "TLP:GREEN"), c2: card("c2", "dns", "TLP:AMBER", ["n1"]) };
  const p = buildProduct(w, facts(cards));
  expect(p.marking).toBe("TLP:AMBER");
  expect(p.sources).toEqual([{ source: "assets", quality: "fair" }, { source: "dns", quality: "good duplicated" }]);
  expect(Object.keys(p)).not.toContain("cites");
  const gone = { ...cards.c2, place: "discarded" } as unknown as CardState;
  expect(() => buildProduct(w, facts({ ...cards, c2: gone }))).toThrow(/summary.*c2.*discarded/);
});

test("a missing source manifest and a missing quality note are shown, not dropped", () => {
  const w = new DraftWork(null);
  w.setFinding(f("a", ["c1", "c2"]), null);
  const cards = { c1: card("c1", "gone", "TLP:GREEN"), c2: card("c2", "dns", "TLP:GREEN", ["n1", "n9"]) };
  expect(buildProduct(w, facts(cards)).sources).toEqual([
    { source: "dns", quality: "good duplicated n9 (note no longer in the source manifest)" },
    { source: "gone", quality: "source manifest not loaded" },
  ]);
});

test("a carried-over narrative keeps its cards' marking and sources in the next revision", () => {
  const cards = { c1: card("c1", "assets", "TLP:GREEN"), c2: card("c2", "dns", "TLP:AMBER", ["n1"]) };
  const w1 = new DraftWork(null);
  w1.setFinding(f("a", ["c1"]), null);
  w1.setSection("summary", "text", ["c2"]);
  const p1 = buildProduct(w1, facts(cards));
  const w2 = new DraftWork(p1);
  w2.setFinding(f("a2", ["c1"]), "f1");
  const p2 = buildProduct(w2, facts(cards));
  expect(p2.marking).toBe("TLP:AMBER");
  expect(p2.sources).toEqual(p1.sources);
  expect(p2.sources.map((x) => x.source)).toContain("dns");
});

test("a revision never has a lower marking than the one before it", () => {
  const cards = { c1: card("c1", "dns", "TLP:AMBER"), c2: card("c2", "assets", "TLP:GREEN") };
  const w1 = new DraftWork(null);
  w1.setFinding(f("a", ["c1"]), null);
  const p1 = buildProduct(w1, facts(cards));
  const w2 = new DraftWork(p1);
  w2.setFinding(f("b", ["c2"]), "f1");
  expect(buildProduct(w2, facts(cards)).marking).toBe("TLP:AMBER");
});

test("the refusal for a discarded card is a ToolError", () => {
  const w = new DraftWork(null);
  w.setFinding(f("a", ["c1"]), null);
  const gone = { ...card("c1", "dns", "TLP:GREEN"), place: "discarded" } as unknown as CardState;
  expect(() => buildProduct(w, facts({ c1: gone }))).toThrow(ToolError);
});

test("a card is named in text as [c1], [c1, c2], [Card c1] or a bare c1, the same pattern check 6 uses", () => {
  expect(cardRefs("see [c1]")).toEqual(["c1"]);
  expect(cardRefs("see [c1, c2]")).toEqual(["c1", "c2"]);
  expect(cardRefs("see [Card c3]")).toEqual(["c3"]);
  expect(cardRefs("c4 shows it")).toEqual(["c4"]);
  expect(cardRefs("(see C2)")).toEqual([]);
  expect(cardRefs("abc1, c1x, 0c1 and c12345abc are not cards")).toEqual([]);
  const product = { summary: "[c1, c2]", gaps_and_limits: "[Card c3]", alternatives: "c4", assessment: "none", key_findings: [] } as unknown as Product;
  expect(citedBy(product)).toEqual(["c1", "c2", "c3", "c4"]);
  // check 6 runs alone and cannot import the helper: its source spells the same pattern
  const check6 = readFileSync(join(import.meta.dir, "../../sample/checks/06-assumptions-and-judgments.ts"), "utf8");
  expect(check6).toContain(`/${CARD_REF.source}/.test(`);
  expect(CARD_REF.flags).not.toContain("i");
});

test("only lower-case card ids are citations", () => {
  expect(cardRefs("C2 traffic to c3, [c1, c2] and [Card c4]; C5.")).toEqual(["c3", "c1", "c2", "c4"]);
});

test("CARD_REF and cardRefs live in src/core/state/cites.ts (browser-safe) and src/agents/draft.ts re-exports the same ones", async () => {
  const cites = await import("../../src/core/state/cites");
  expect(cites.CARD_REF).toBe(CARD_REF);
  expect(cites.cardRefs).toBe(cardRefs);
  expect(cites.cardRefs("see [c1, c2] and C3")).toEqual(["c1", "c2"]);
});

test("a source from an untrusted root contributes no free text to the product's sources", () => {
  const w = new DraftWork(null);
  w.setFinding(f("a"), null);
  const cards = { c1: { ...card("c1", "dns", "TLP:GREEN"), quality_notes: ["n1"] } };
  const p = buildProduct(w, facts(cards, { untrusted: (id: string) => id === "dns" }));
  expect(p.sources).toEqual([{ source: "dns", quality: "quality text withheld: untrusted root" }]);
  const trusted = buildProduct(w, facts(cards));
  expect(trusted.sources[0]!.quality).toContain("good");
});

// ---- composed wording (task 11 item 1) ----

const ICD203 = (): NonNullable<ReturnType<typeof termsOf>> => {
  const body = Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", "..", "sample", "context", "standards", "icd203.yaml"), "utf8"));
  const t = termsOf(body);
  if (t === null) throw new Error("the sample standard gives no terms");
  return t;
};

test("the standard's terms are read from the standard itself: the likelihood terms, their variants, the judgment markers and the change terms", () => {
  const t = ICD203();
  expect(t.likelihood).toEqual(["almost no chance", "very unlikely", "unlikely", "roughly even chance", "likely", "very likely", "almost certain"]);
  expect(t.judgment_markers).toEqual(["we assess", "we judge", "we estimate"]);
  expect(t.change_terms).toEqual(["first judgment", "consistent with", "changes"]);
  expect(termsOf(null)).toBeNull();
  expect(termsOf({ likelihood: "x" })).toBeNull();
});

test("a statement is composed from the likelihood and the claim", () => {
  const t = ICD203();
  expect(composeStatement("very likely", "the address belongs to ws-17", t)).toBe("We assess it is very likely that the address belongs to ws-17.");
  expect(composeStatement("likely", "The host was used by j.doe.", t)).toBe("We assess it is likely that the host was used by j.doe.");
  expect(composeStatement("unlikely", "198.51.100.77 is internal ", t)).toBe("We assess it is unlikely that 198.51.100.77 is internal.");
});

test("a claim already beginning with a judgment marker is not doubled", () => {
  const t = ICD203();
  expect(composeStatement("likely", "We assess that the address is external.", t)).toBe("We assess it is likely that the address is external.");
  expect(composeStatement("likely", "we judge the address is external", t)).toBe("We assess it is likely that the address is external.");
  expect(composeStatement("likely", "We estimate, that the address is external", t)).toBe("We assess it is likely that the address is external.");
});

test("the likelihood terms a claim holds are found as whole phrases, longest first", () => {
  const t = ICD203();
  expect(likelihoodTermsIn("the host is probably compromised", t)).toEqual(["likely"]);
  expect(likelihoodTermsIn("it is very likely, not unlikely", t)).toEqual(["very likely", "unlikely"]);
  expect(likelihoodTermsIn("the address belongs to ws-17", t)).toEqual([]);
});

test("the change is composed from its kind and its detail", () => {
  expect(composeChange("first judgment", "on this question")).toBe("First judgment: on this question.");
  expect(composeChange("first judgment", "")).toBe("First judgment.");
  expect(composeChange("consistent with", "the judgment published as product 1")).toBe("Consistent with the judgment published as product 1.");
  expect(composeChange("changes", "the earlier judgment: the account is now named.")).toBe("Changes the earlier judgment: the account is now named.");
  expect(composeChange("changes", "")).toBe("Changes the earlier judgment.");
  expect(composeChange("consistent with", "")).toBe("Consistent with the earlier judgment.");
  // a detail that repeats its kind is not doubled
  expect(composeChange("consistent with", "Consistent with product 1")).toBe("Consistent with product 1.");
  expect(composeChange("first judgment", "First judgment on this question.")).toBe("First judgment: on this question.");
});

test("the form exceptions note is appended to gaps_and_limits, replaces an earlier one, and leaves text with no note untouched", () => {
  const x = [{ check: "change", where: "change", message: "empty" }, { check: "gaps-and-negatives", where: "f1", message: "f1 cites c17, which has no rows" }];
  const noted = withFormExceptions("Flows were cut off. ", x);
  expect(noted).toBe("Flows were cut off.\n\nForm exceptions noted:\n- change (change): empty\n- gaps-and-negatives (f1): f1 cites card 17, which has no rows");
  expect(cardRefs(noted)).toEqual([]);
  expect(withFormExceptions(noted, x)).toBe(noted);
  expect(withFormExceptions(noted, [])).toBe("Flows were cut off.");
  expect(withFormExceptions("", [x[0]!])).toBe("Form exceptions noted:\n- change (change): empty");
  expect(withFormExceptions("untouched \n", [])).toBe("untouched \n");
});
