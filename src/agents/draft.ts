import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { CardState } from "../core/state/types";
import type { Actor, Draft, Finding, Marking, Product, Section } from "../core/types";
import { strictest } from "../core/types";
import type { SourceManifest } from "../modules/manifests";
import { ToolError } from "./tools/kit";

export type TextSection = Exclude<Section, "key_findings">;

/** The draft an analyst is assembling. Nothing here is a revision until the engine builds one from it. */
export class DraftWork {
  readonly findings: Finding[];
  readonly sections: Record<TextSection, string>;
  readonly research: { question: string; why: string }[] = [];

  constructor(previous: Product | null) {
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

  setSection(section: TextSection, text: string): void {
    this.sections[section] = text;
  }
}

export function buildProduct(work: DraftWork, facts: {
  objective: string; question: string; case_marking: Marking; cards: Readonly<Record<string, CardState>>;
  source: (id: string) => SourceManifest | null; assumptions: string[]; change: string;
}): Product {
  const cited = [...new Set(work.findings.flatMap((f) => f.cites))]
    .filter((id) => Object.hasOwn(facts.cards, id)).map((id) => facts.cards[id]!);
  const sources: Product["sources"] = [];
  for (const id of [...new Set(cited.flatMap((c) => (c.source === null ? [] : [c.source])))].sort()) {
    const m = facts.source(id);
    if (m === null) continue;
    const named = new Set(cited.filter((c) => c.source === id).flatMap((c) => c.quality_notes));
    const notes = m.quality_notes.filter((n) => named.has(n.id)).map((n) => n.text);
    sources.push({ source: id, quality: [m.quality, ...notes].join(" ") });
  }
  return {
    objective: facts.objective, question: facts.question, marking: strictest(facts.case_marking, ...cited.map((c) => c.marking)),
    summary: work.sections.summary, key_findings: work.findings.map((f) => ({ ...f })), gaps_and_limits: work.sections.gaps_and_limits,
    alternatives: work.sections.alternatives, assessment: work.sections.assessment, sources, assumptions: [...facts.assumptions], change: facts.change,
  };
}

/** The hash is always computed here, from the product; a model never supplies it. */
export function draftOf(product: Product, n: number, author: Actor, reason: string): Draft {
  return { n, hash: sha256Hex(canonical(product as unknown as Json)), author, product, reason };
}
