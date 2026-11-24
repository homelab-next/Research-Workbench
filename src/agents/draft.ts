import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { CardState } from "../core/state/types";
import type { Actor, Draft, Finding, Marking, Product, Section } from "../core/types";
import { SECTIONS, strictest } from "../core/types";
import type { SourceManifest } from "../modules/manifests";
import { ToolError } from "./tools/kit";

export type TextSection = Exclude<Section, "key_findings">;

/** The draft an analyst is assembling. Nothing here is a revision until the engine builds one from it. */
export class DraftWork {
  readonly findings: Finding[];
  readonly sections: Record<TextSection, string>;
  /** What each section's text cited. Not part of the product: it shows through the product's marking and sources. */
  readonly narrativeCites: Record<TextSection, string[]> = { summary: [], gaps_and_limits: [], alternatives: [], assessment: [] };
  readonly research: { question: string; why: string }[] = [];

  /** The revision this one starts from: its marking is a floor and its sources are kept (narrative cites are not stored in a product). */
  readonly previous: Product | null;

  constructor(previous: Product | null) {
    this.previous = previous;
    this.findings = previous === null ? [] : previous.key_findings.map((f) => ({ ...f, cites: [...f.cites], assumptions: [...f.assumptions] }));
    this.sections = previous === null
      ? { summary: "", gaps_and_limits: "", alternatives: "", assessment: "" }
      : { summary: previous.summary, gaps_and_limits: previous.gaps_and_limits, alternatives: previous.alternatives, assessment: previous.assessment };
  }

  /** Adds a finding as f<n>, or replaces the one named. Throws ToolError when `replaces` names none. */
  setFinding(f: Omit<Finding, "id">, replaces: string | null): string {
    if (replaces !== null) {
      const i = this.findings.findIndex((x) => x.id === replaces);
      if (i < 0) throw new ToolError(`no such finding to replace: ${replaces}`);
      this.findings[i] = { id: replaces, ...f };
      return replaces;
    }
    const used = this.findings.map((x) => Number(/^f(\d+)$/.exec(x.id)?.[1] ?? 0));
    const id = `f${Math.max(0, ...used) + 1}`;
    this.findings.push({ id, ...f });
    return id;
  }

  setSection(section: TextSection, text: string, cites: string[] = []): void {
    this.sections[section] = text;
    this.narrativeCites[section] = [...cites];
  }
}

export function buildProduct(work: DraftWork, facts: {
  objective: string; question: string; case_marking: Marking; cards: Readonly<Record<string, CardState>>;
  source: (id: string) => SourceManifest | null; assumptions: string[]; change: string;
}): Product {
  const live = (id: string, what: string): CardState | null => {
    if (!Object.hasOwn(facts.cards, id)) return null;
    const c = facts.cards[id]!;
    if (c.place === "discarded") throw new ToolError(`${what} cites card ${id}, which was discarded`);
    return c;
  };
  const found = new Map<string, CardState>();
  for (const f of work.findings) for (const id of f.cites) { const c = live(id, `finding ${f.id}`); if (c !== null) found.set(id, c); }
  for (const [section, ids] of Object.entries(work.narrativeCites)) for (const id of ids) { const c = live(id, `section ${section}`); if (c !== null) found.set(id, c); }
  const cited = [...found.values()];
  const sources: Product["sources"] = [];
  for (const id of [...new Set(cited.flatMap((c) => (c.source === null ? [] : [c.source])))].sort()) {
    const m = facts.source(id);
    if (m === null) { sources.push({ source: id, quality: "source manifest not loaded" }); continue; }
    const named = [...new Set(cited.filter((c) => c.source === id).flatMap((c) => c.quality_notes))];
    const notes = named.map((nid) => m.quality_notes.find((n) => n.id === nid)?.text ?? `${nid} (note no longer in the source manifest)`);
    sources.push({ source: id, quality: [m.quality, ...notes].join(" ") });
  }
  const prev = work.previous;
  const kept = new Map((prev === null ? [] : prev.sources).map((x) => [x.source, x]));
  for (const x of sources) kept.set(x.source, x);
  const allSources = [...kept.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const product: Product = {
    objective: facts.objective, question: facts.question, marking: strictest(facts.case_marking, ...cited.map((c) => c.marking), ...(prev === null ? [] : [prev.marking])),
    summary: work.sections.summary, key_findings: work.findings.map((f) => ({ ...f })), gaps_and_limits: work.sections.gaps_and_limits,
    alternatives: work.sections.alternatives, assessment: work.sections.assessment, sources: allSources, assumptions: [...facts.assumptions], change: facts.change,
  };
  builtCites.set(product, cited.map((c) => c.id));
  return product;
}

/** The hash is always computed here, from the product; a model never supplies it. */
export function draftOf(product: Product, n: number, author: Actor, reason: string, narrativeCites: readonly string[] = []): Draft {
  return { n, hash: sha256Hex(canonical(product as unknown as Json)), author, product, reason, cited: citedBy(product, [...narrativeCites, ...(builtCites.get(product) ?? [])]) };
}

/** The card ids a draft cites: those it records, and always what its findings cite (an older draft records none). */
export function citedOf(draft: Draft): string[] {
  return citedBy(draft.product, draft.cited ?? []);
}

/** What a product built by buildProduct got its narrative to cite: a product does not store these, and the draft that records the product needs them. */
const builtCites = new WeakMap<Product, string[]>();

/**
 * A card named in text: `[c3]`, `[c3, c2]`, `[Card c3]` or a bare `c3`; only lower-case ids cite (`C3 traffic` does not). Check 6 (sample/checks/06-assumptions-and-judgments.ts)
 * runs alone as a program and cannot import this, so it spells the same pattern; a test holds the two together.
 */
export const CARD_REF = /(?<![\w])c\d+(?![\w])/g;

/** The card ids a text names, lower-cased, in the order they appear. */
export function cardRefs(text: string): string[] {
  return [...text.matchAll(CARD_REF)].map((m) => m[0].toLowerCase());
}

const TEXT_SECTIONS = SECTIONS.filter((k): k is TextSection => k !== "key_findings");

/**
 * The cards a new revision keeps from the one before because a section it carries over unchanged cited them by tool only (a product does not
 * store those). Those that cited the old findings are not carried, nor are cards discarded since; when every section changed there is nothing
 * carried over. Assemble and a person's edit share this rule.
 */
export function carriedCites(latest: Draft | null, product: Product, cards: Readonly<Record<string, CardState>>): string[] {
  if (latest === null || !TEXT_SECTIONS.some((k) => product[k] === latest.product[k])) return [];
  const byFindings = new Set(latest.product.key_findings.flatMap((x) => x.cites));
  return (latest.cited ?? []).filter((id) => !byFindings.has(id) && Object.hasOwn(cards, id) && cards[id]!.place !== "discarded");
}

/** Every card id the findings cite, the given narrative cites, and every card the product's narrative text names (see CARD_REF), sorted. */
export function citedBy(product: Product, narrativeCites: readonly string[] = []): string[] {
  const ids = new Set<string>([...product.key_findings.flatMap((f) => f.cites), ...narrativeCites]);
  for (const k of TEXT_SECTIONS) for (const id of cardRefs(product[k])) ids.add(id);
  return [...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}
