import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { Json } from "../../src/core/canonical";
import { MARKINGS } from "../../src/core/types";
import type { Product } from "../../src/core/types";
import { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import type { CheckInput } from "../../src/pipeline/checks";
import { runCheck } from "../../src/pipeline/checks";
import { loadChecks } from "../../src/pipeline/manifests";
import { composeChange, composeStatement, termsOf } from "../../src/agents/draft";
import type { CheckManifest } from "../../src/pipeline/manifests";

const SAMPLE = join(import.meta.dir, "..", "..", "sample");
let checks: CheckManifest[];
let registry: Registry;
beforeAll(() => {
  registry = loadRegistry([{ path: SAMPLE, trusted: true, credentials: [] }]);
  checks = loadChecks(registry).checks;
});

const IDS = ["schema", "likelihood-term", "confidence-and-likelihood", "citations", "source-quality", "assumptions-and-judgments", "alternatives", "gaps-and-negatives", "objective-and-question", "change", "marking"];

/** A product, cards and sources that pass all eleven. */
function good(): CheckInput {
  const product: Product = {
    objective: "Establish who is behind 198.51.100.77", question: "Which asset is behind 198.51.100.77?", marking: "TLP:AMBER",
    summary: "We assess the address is very likely a managed laptop. We have moderate confidence in the sources.",
    key_findings: [
      {
        id: "f1", statement: "We assess it is very likely that the address belongs to the managed laptop ws-17.", likelihood: "very likely", confidence: "moderate",
        confidence_basis: "Two sources agree, but the proxy log is partial.", cites: ["c2", "c3"], assumptions: ["The proxy clock is correct."], reasoning: "The lease and the flows match.",
      },
      {
        id: "f2", statement: "We judge it is very unlikely that the address is an unmanaged host.", likelihood: "very unlikely", confidence: "high",
        confidence_basis: "The asset list is complete for internal hosts.", cites: ["c1"], assumptions: [], reasoning: "No unmanaged record exists.",
      },
    ],
    gaps_and_limits: "The proxy log is partial [c3]; the last hour is missing.", alternatives: "A shared address pool could explain the lease; the flows argue against it.",
    assessment: "We assess the address is a managed laptop.", sources: [
      { source: "assets", quality: "Complete for internal hosts." },
      { source: "flows", quality: "Complete for proxy traffic; clock skew of up to a minute." },
    ],
    assumptions: ["The asset list is current."], change: "First judgment on this question.",
  };
  const std = registry.get("standard", "icd203")!.body;
  const card = (id: string, over: Partial<CheckInput["cards"][string]>): CheckInput["cards"][string] => ({
    id, title: id, source: "flows", marking: "TLP:GREEN", coverage: { kind: "full" }, empty: null, row_count: 3, quality_notes: [], ...over,
  });
  return {
    check: "", draft: { n: 1, hash: sha256Hex(canonical(product as never)), product },
    cards: {
      c1: card("c1", { source: "assets", row_count: 0, empty: "proven-negative" }),
      c2: card("c2", { marking: "TLP:AMBER" }),
      c3: card("c3", { coverage: { kind: "partial", reason: "row_limit" }, quality_notes: ["skew"] }),
    },
    sources: {
      assets: { quality: "Complete for internal hosts.", quality_notes: [], marking: "TLP:GREEN" },
      flows: { quality: "Complete for proxy traffic.", quality_notes: [{ id: "skew", text: "clock skew of up to a minute" }], marking: "TLP:AMBER" },
    },
    schema: registry.get("schema", "product")!.body.schema as Json, standard: std as Json, markings: [...MARKINGS],
    objective: { id: "o1", title: "Establish who is behind 198.51.100.77" }, question: "Which asset is behind 198.51.100.77?", earlier: [],
  };
}

const run = (id: string, input: CheckInput) => runCheck(checks.find((c) => c.id === id)!, { ...input, check: id });

test("the sample root loads eleven checks in order with no problems", () => {
  const r = loadChecks(registry);
  expect(r.problems).toEqual([]);
  expect(r.checks.map((c) => c.id)).toEqual(IDS);
  expect(r.checks.map((c) => c.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  // every sample check stays blocking
  expect(r.checks.every((c) => c.blocking)).toBe(true);
});

test("the good product passes all eleven checks", async () => {
  const i = good();
  for (const id of IDS) expect(await run(id, i)).toMatchObject({ pass: true, findings: [] });
});

type Spoil = (i: CheckInput) => void;
const CASES: [string, Spoil, string][] = [
  ["schema", (i) => { Object.assign(i.draft.product, { extra: 1 }); }, "product"],
  ["likelihood-term", (i) => { i.draft.product.key_findings[0]!.likelihood = "quite likely"; }, "f1"],
  ["likelihood-term", (i) => { i.draft.product.key_findings[0]!.statement = "We assess it is likely, and very likely, that this is so."; }, "f1"],
  ["confidence-and-likelihood", (i) => { i.draft.product.summary += " We have moderate confidence that this is likely."; }, "summary"],
  ["confidence-and-likelihood", (i) => { i.draft.product.key_findings[0]!.confidence_basis = ""; }, "f1"],
  ["citations", (i) => { i.draft.product.key_findings[0]!.cites = []; }, "f1"],
  ["citations", (i) => { i.draft.product.key_findings[0]!.cites = ["c99"]; }, "f1"],
  ["source-quality", (i) => { i.draft.product.sources = []; }, "sources"],
  ["assumptions-and-judgments", (i) => { i.draft.product.assumptions = ["The asset list is current [c2]."]; }, "assumptions"],
  ["assumptions-and-judgments", (i) => { i.draft.product.key_findings[0]!.statement = "The account is very likely behind it."; }, "f1"],
  ["alternatives", (i) => { i.draft.product.alternatives = "  "; }, "alternatives"],
  ["gaps-and-negatives", (i) => { i.draft.product.gaps_and_limits = "None known."; }, "gaps_and_limits"],
  ["gaps-and-negatives", (i) => { i.cards.c1!.empty = "not-seen"; }, "f2"],
  ["objective-and-question", (i) => { i.draft.product.question = ""; }, "product"],
  ["change", (i) => { i.draft.product.change = "No comment."; }, "change"],
  ["change", (i) => { i.earlier = [{ n: 1, hash: "0".repeat(64) }]; }, "change"],
  ["marking", (i) => { i.cards.c2!.marking = "TLP:RED"; }, "product"],
];
test.each(CASES)("%s fails when it should", async (id, spoil, where) => {
  const i = good();
  spoil(i);
  const o = await run(id, i);
  expect(o.pass).toBe(false);
  expect(o.findings[0]!.where).toBe(where);
  expect(o.findings.every((f) => f.check === id)).toBe(true);
});

test("each failing case fails only the check it is aimed at", async () => {
  for (const [id, spoil] of CASES) {
    const i = good();
    spoil(i);
    for (const other of IDS.filter((x) => x !== id)) {
      const o = await run(other, i);
      expect([id, other, o.pass, o.findings]).toEqual([id, other, true, []]);
    }
  }
});

test("a likelihood term inside another word or a longer term is not counted twice", async () => {
  const i = good();
  i.draft.product.key_findings[1]!.statement = "We judge it is unlikely that the address is unmanaged, and very unlikely that it is external.";
  expect((await run("likelihood-term", i)).pass).toBe(false);
  const j = good();
  j.draft.product.key_findings[1]!.likelihood = "unlikely";
  j.draft.product.key_findings[1]!.statement = "We judge it is unlikely that the address is unmanaged.";
  expect((await run("likelihood-term", j)).pass).toBe(true);
});

test("a variant of a term counts as that term", async () => {
  const i = good();
  i.draft.product.key_findings[0]!.statement = "We assess it is highly probable that the address belongs to ws-17.";
  expect((await run("likelihood-term", i)).pass).toBe(true);
  i.draft.product.key_findings[0]!.likelihood = "likely";
  expect((await run("likelihood-term", i)).pass).toBe(false);
});

test("the word remote alone is not a likelihood term; the phrase remote chance is", async () => {
  const i = good();
  i.draft.product.key_findings[0]!.statement = "We assess it is very likely that the address was used for remote desktop by ws-17.";
  expect(await run("likelihood-term", i)).toMatchObject({ pass: true });
  const j = good();
  j.draft.product.key_findings[0]!.likelihood = "almost no chance";
  j.draft.product.key_findings[0]!.statement = "We assess there is a remote chance that ws-17 is external.";
  expect(await run("likelihood-term", j)).toMatchObject({ pass: true });
});

test("a card with a marking that is not a marking fails the marking check", async () => {
  const i = good();
  i.cards.c2!.marking = "TLP:PURPLE" as never;
  const o = await run("marking", i);
  expect(o.pass).toBe(false);
  expect(o.findings[0]!.where).toBe("product");
});

test("a product with no key findings fails the citations check", async () => {
  const i = good();
  i.draft.product.key_findings = [];
  const o = await run("citations", i);
  expect(o.pass).toBe(false);
  expect(o.findings[0]).toMatchObject({ where: "key_findings", message: "the product has no key findings" });
});

test.each(["[c2]", "[c3, c2]", "c3", "[Card c2]", "(see C2)"])("an assumption citing a card as %s fails", async (form) => {
  const i = good();
  i.draft.product.assumptions = [`The asset list is current ${form}.`];
  const o = await run("assumptions-and-judgments", i);
  expect(o.pass).toBe(false);
  expect(o.findings[0]!.where).toBe("assumptions");
});

test.each(["[c3]", "[c3, c2]", "c3", "[Card c3]"])("a partial card named as %s in the gaps counts as named", async (form) => {
  const i = good();
  i.draft.product.gaps_and_limits = `The proxy log is partial ${form}; the last hour is missing.`;
  expect(await run("gaps-and-negatives", i)).toMatchObject({ pass: true });
});

test.each(["We have confidence is low in this, and it is likely.", "Confidence: moderate, and this is likely.", "Our confidence is high; it is very likely so."])("%s mixes confidence and likelihood", async (text) => {
  const i = good();
  i.draft.product.summary = text;
  const o = await run("confidence-and-likelihood", i);
  expect(o.pass).toBe(false);
  expect(o.findings[0]!.where).toBe("summary");
});

test("check 8 examines the cards the narrative cites, not only the findings' cites", async () => {
  const card = (over: Partial<CheckInput["cards"][string]>): CheckInput["cards"][string] => ({
    id: "c4", title: "c4", source: "flows", marking: "TLP:GREEN", coverage: { kind: "full" }, empty: null, row_count: 3, quality_notes: [], ...over,
  });
  const partial = good();
  partial.cards.c4 = card({ coverage: { kind: "partial", reason: "timeout" } });
  partial.cited = ["c1", "c2", "c3", "c4"];
  expect(await run("gaps-and-negatives", partial)).toMatchObject({ pass: false, findings: [{ where: "gaps_and_limits", message: expect.stringContaining("c4 has partial coverage (timeout)") }] });
  const empty = good();
  empty.cards.c4 = card({ row_count: 0, empty: "not-seen" });
  empty.cited = ["c1", "c2", "c3", "c4"];
  expect(await run("gaps-and-negatives", empty)).toMatchObject({ pass: false, findings: [{ where: "narrative", message: expect.stringContaining("the narrative cites c4, which has no rows") }] });
  // a full-coverage proven negative is a fine thing for a narrative to cite
  const negative = good();
  negative.cards.c4 = card({ row_count: 0, empty: "proven-negative" });
  negative.cited = ["c1", "c2", "c3", "c4"];
  expect(await run("gaps-and-negatives", negative)).toMatchObject({ pass: true });
});

test("a composed draft passes checks 2, 6 and 10 by construction, for every likelihood term and every kind of change", async () => {
  const terms = termsOf(registry.get("standard", "icd203")!.body)!;
  const claims = ["the address belongs to ws-17", "We judge that the host is managed.", "198.51.100.77 is not an internal host"];
  for (const likelihood of terms.likelihood) {
    for (const claim of claims) {
      const i = good();
      i.draft.product.key_findings = [{ ...i.draft.product.key_findings[0]!, likelihood, statement: composeStatement(likelihood, claim, terms) }];
      for (const id of ["likelihood-term", "assumptions-and-judgments"]) expect({ likelihood, claim, r: await run(id, i) }).toMatchObject({ r: { pass: true, findings: [] } });
    }
  }
  for (const kind of terms.change_terms) {
    for (const detail of ["", "the earlier judgment, with the account now named", `${kind} draft 1`]) {
      const i = good();
      i.draft.product.change = composeChange(kind, detail, terms.first_change);
      if (kind !== "first judgment") i.earlier = [{ n: 1, hash: "a".repeat(64) }];
      expect({ kind, detail, r: await run("change", i) }).toMatchObject({ r: { pass: true, findings: [] } });
    }
  }
});

test("check 8 accepts a not-seen card cited in gaps_and_limits, and refuses it in a finding, the summary or the assessment", async () => {
  const notSeen = (i: CheckInput): void => {
    i.cards.c4 = { id: "c4", title: "c4", source: "flows", marking: "TLP:AMBER", coverage: { kind: "full" }, empty: "not-seen", row_count: 0, quality_notes: [] };
    i.cited = ["c1", "c2", "c3", "c4"];
  };
  const gaps = good();
  notSeen(gaps);
  gaps.draft.product.gaps_and_limits += " The proxy lookup for the address returned nothing [c4]; that is not proof of absence.";
  expect(await run("gaps-and-negatives", gaps)).toMatchObject({ pass: true, findings: [] });
  // a gaps cite is still a real cite: the card's marking floors the draft, and check 11 sees it
  gaps.cards.c4!.marking = "TLP:RED";
  expect(await run("marking", gaps)).toMatchObject({ pass: false });
  const finding = good();
  notSeen(finding);
  finding.draft.product.gaps_and_limits += " Nothing was seen [c4].";
  finding.draft.product.key_findings[0]!.cites.push("c4");
  expect(await run("gaps-and-negatives", finding)).toMatchObject({ pass: false, findings: [{ where: "f1", message: expect.stringContaining("f1 cites c4, which has no rows") }] });
  for (const k of ["summary", "assessment"] as const) {
    const i = good();
    notSeen(i);
    i.draft.product.gaps_and_limits += " Nothing was seen [c4].";
    i.draft.product[k] += " The address is absent [c4].";
    expect(await run("gaps-and-negatives", i)).toMatchObject({ pass: false, findings: [{ where: k, message: expect.stringContaining(`the ${k} cites c4, which has no rows`) }] });
  }
});
