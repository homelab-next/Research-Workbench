import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import { CARD_REF, cardRefs } from "../core/state/cites";
import type { CardState } from "../core/state/types";
import type { Actor, Draft, Finding, Marking, Product, Section } from "../core/types";
import { SECTIONS, strictest } from "../core/types";
import type { SourceManifest } from "../modules/manifests";
import { escapeRe } from "../modules/sqlguard";
import { ToolError } from "./tools/kit";

export type TextSection = Exclude<Section, "key_findings">;

/** What the draft builder takes from the profile's standard (context/standards): the one place the terms are listed. */
export interface StandardTerms {
  /** The likelihood terms, in the standard's order. */
  likelihood: string[];
  /** Every term and variant, lower-cased and longest first, with the term each stands for. */
  names: { text: string; term: string }[];
  judgment_markers: string[];
  change_terms: string[];
}

const strList = (x: unknown): string[] | null => (Array.isArray(x) && x.every((v) => typeof v === "string") ? [...x] as string[] : null);

/** The terms of a standard's body; null when it does not list likelihood terms, judgment markers and change terms. */
export function termsOf(body: unknown): StandardTerms | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const markers = strList(b.judgment_markers);
  const change = strList(b.change_terms);
  if (!Array.isArray(b.likelihood) || b.likelihood.length === 0 || markers === null || change === null) return null;
  const likelihood: string[] = [];
  const names: StandardTerms["names"] = [];
  for (const l of b.likelihood as unknown[]) {
    if (typeof l !== "object" || l === null || typeof (l as { term?: unknown }).term !== "string") return null;
    const term = (l as { term: string }).term;
    const also = strList((l as { also?: unknown }).also ?? []);
    if (also === null) return null;
    likelihood.push(term);
    for (const t of [term, ...also]) names.push({ text: t.toLowerCase(), term });
  }
  names.sort((a, b2) => b2.text.length - a.text.length);
  return { likelihood, names, judgment_markers: markers, change_terms: change };
}


/** The likelihood terms a text holds, longest match first, so "very likely" is not also "likely", each with the words that matched. A match is a whole phrase, as check 2 reads it. */
export function likelihoodMatches(text: string, terms: StandardTerms): { term: string; text: string }[] {
  let rest = text.toLowerCase();
  const found: { term: string; text: string; at: number }[] = [];
  for (const n of terms.names) {
    const re = new RegExp(`(?<![\\w])${escapeRe(n.text)}(?![\\w])`, "g");
    rest = rest.replace(re, (m: string, at: number) => { found.push({ term: n.term, text: m, at }); return " ".repeat(m.length); });
  }
  return found.sort((a, b) => a.at - b.at).map(({ term, text: t }) => ({ term, text: t }));
}
export const likelihoodTermsIn = (text: string, terms: StandardTerms): string[] => likelihoodMatches(text, terms).map((m) => m.term);

/** Words that may start a claim and are lower-cased inside the composed sentence; any other first word (a name, an address) is kept as written. */
const LEADING = new Set(["the", "a", "an", "this", "that", "these", "those", "it", "its", "there", "one", "some", "no", "all", "each", "every", "both", "neither", "none"]);

/**
 * A finding's statement, composed by code from the likelihood and the analyst's plain claim: "We assess it is <likelihood> that <claim>." A claim
 * that already begins with a judgment marker of the standard ("we assess/judge/estimate", with or without "that") is not doubled.
 */
export function composeStatement(likelihood: string, claim: string, terms: StandardTerms): string {
  let c = claim.trim();
  for (const m of [...terms.judgment_markers].sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`^${escapeRe(m)}(?![\\w])[\\s,:]*(?:that(?![\\w])[\\s,]*)?`, "i");
    if (re.test(c)) { c = c.replace(re, ""); break; }
  }
  c = c.replace(/[\s.]+$/, "");
  const first = /^[A-Za-z]+/.exec(c)?.[0] ?? "";
  if (LEADING.has(first.toLowerCase())) c = first.toLowerCase() + c.slice(first.length);
  return `We assess it is ${likelihood} that ${c}.`;
}

/**
 * The product's change from earlier judgments, composed by code from its kind (a change term of the standard) and the analyst's detail, so that
 * it always starts with the term. A detail that repeats the kind is not doubled.
 */
export function composeChange(kind: string, detail: string): string {
  let d = detail.trim();
  if (d.toLowerCase().startsWith(kind.toLowerCase())) d = d.slice(kind.length).replace(/^[\s,:]+/, "");
  d = d.replace(/[\s.]+$/, "");
  const head = kind.charAt(0).toUpperCase() + kind.slice(1);
  if (kind.toLowerCase() === "first judgment") return d === "" ? `${head}.` : `${head}: ${d}.`;
  return `${head} ${d === "" ? "the earlier judgment" : d}.`;
}

/** The draft an analyst is assembling. Nothing here is a revision until the engine builds one from it. */
export class DraftWork {
  readonly findings: Finding[];
  readonly sections: Record<TextSection, string>;
  /** What each section's text cited. Not part of the product: it shows through the product's marking and sources. */
  readonly narrativeCites: Record<TextSection, string[]> = { summary: [], gaps_and_limits: [], alternatives: [], assessment: [] };
  readonly research: { question: string; why: string }[] = [];

  /** The revision this one starts from: its marking is a floor and its sources are kept (narrative cites are not stored in a product). */
  readonly previous: Product | null;
  /** The profile standard's terms, which a finding's wording is composed from; null when the profile names none. */
  readonly terms: StandardTerms | null;

  constructor(previous: Product | null, terms: StandardTerms | null = null) {
    this.previous = previous;
    this.terms = terms;
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
  source: (id: string) => SourceManifest | null;
  /** True for a source whose manifest came from an untrusted root: its quality text is not carried into the product. */
  untrusted?: (id: string) => boolean;
  assumptions: string[]; change: string;
  /** The markings of the model requests that wrote this text: text a model wrote is as strict as everything that model had seen. */
  written_at?: readonly Marking[];
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
    if (facts.untrusted?.(id) === true) { sources.push({ source: id, quality: "quality text withheld: untrusted root" }); continue; }
    const named = [...new Set(cited.filter((c) => c.source === id).flatMap((c) => c.quality_notes))];
    const notes = named.map((nid) => m.quality_notes.find((n) => n.id === nid)?.text ?? `${nid} (note no longer in the source manifest)`);
    sources.push({ source: id, quality: [m.quality, ...notes].join(" ") });
  }
  const prev = work.previous;
  const kept = new Map((prev === null ? [] : prev.sources).map((x) => [x.source, x]));
  for (const x of sources) kept.set(x.source, x);
  const allSources = [...kept.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const product: Product = {
    objective: facts.objective, question: facts.question, marking: strictest(facts.case_marking, ...cited.map((c) => c.marking), ...(prev === null ? [] : [prev.marking]), ...(facts.written_at ?? [])),
    summary: work.sections.summary, key_findings: work.findings.map((f) => ({ ...f })), gaps_and_limits: work.sections.gaps_and_limits,
    alternatives: work.sections.alternatives, assessment: work.sections.assessment, sources: allSources, assumptions: [...facts.assumptions], change: facts.change,
  };
  builtCites.set(product, cited.map((c) => c.id));
  return product;
}

export const FORM_EXCEPTIONS = "Form exceptions noted:";

/**
 * gaps_and_limits with the Checks stage's note of failed non-blocking checks: any earlier note (from FORM_EXCEPTIONS to the end) is replaced, and
 * with no exceptions none is left. A card id in a check's message is written "card <n>", so that the note cites no card of its own.
 */
export function withFormExceptions(gaps: string, exceptions: readonly { check: string; where: string; message: string }[]): string {
  const at = gaps.indexOf(FORM_EXCEPTIONS);
  if (at < 0 && exceptions.length === 0) return gaps;
  const own = (at < 0 ? gaps : gaps.slice(0, at)).replace(/\s+$/, "");
  if (exceptions.length === 0) return own;
  const plain = (t: string): string => t.replace(CARD_REF, (id) => `card ${id.slice(1)}`).replace(/\s+/g, " ").trim();
  const lines = exceptions.map((x) => `- ${x.check} (${plain(x.where)}): ${plain(x.message)}`);
  return `${own === "" ? "" : `${own}\n\n`}${FORM_EXCEPTIONS}\n${lines.join("\n")}`;
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

export { CARD_REF, cardRefs };

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
