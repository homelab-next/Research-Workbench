import { expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CardState } from "../../src/core/state/types";
import type { Actor, Finding, Product } from "../../src/core/types";
import { buildProduct, DraftWork, draftOf } from "../../src/agents/draft";
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
