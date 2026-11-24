import { cardRefs, latestDraft } from "../core/state";
import type { CaseState } from "../core/state";
import { SECTIONS, strictest } from "../core/types";
import type { Draft, Product } from "../core/types";
import type { Reference } from "../core/wire";

export type TextSection = "summary" | "gaps_and_limits" | "alternatives" | "assessment";
/** The five sections in order, with the words the screen and the Markdown give them. */
export const SECTION_TITLES: { id: "summary" | "key_findings" | "gaps_and_limits" | "alternatives" | "assessment"; title: string }[] = [
  { id: "summary", title: "Summary" }, { id: "key_findings", title: "Key findings" }, { id: "gaps_and_limits", title: "Gaps and limits" },
  { id: "alternatives", title: "Alternatives" }, { id: "assessment", title: "Assessment" },
];
export const TEXT_SECTIONS: TextSection[] = SECTIONS.filter((k): k is TextSection => k !== "key_findings");

/** Every card id a draft cites (its findings, its recorded narrative cites and every card its text names), in id order. */
export function citedIds(draft: Draft): string[] {
  const p: Product = draft.product;
  const ids = new Set<string>([...p.key_findings.flatMap((f) => f.cites), ...(draft.cited ?? [])]);
  for (const k of TEXT_SECTIONS) for (const id of cardRefs(p[k])) ids.add(id);
  return [...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** Text shown as plain text in Markdown: nothing in it can start a heading, a list, a link or emphasis; newlines are gone (the same as the bundle's product.md). */
const plain = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/([\\`*_{}[\]()#+\-.!|>~<&])/g, "\\$1");

/** A fence longer than any run of backticks in `text`, so the text cannot close it. */
function fenced(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/** The recorded product as Markdown: the marking first and last (the strictest of the product's and its cited cards'), the five sections, and the provenance of every card the draft cites. Plain text; it is never drawn as HTML. */
export function narrativeMarkdown(state: CaseState, ref: Reference): string {
  const d = latestDraft(state);
  if (d === null) return "";
  const p = d.product;
  // the copy carries each cited card's title and query, so its banner is as strict as the strictest of them
  const cited = citedIds(d);
  const banner = strictest(p.marking, ...cited.filter((id) => Object.hasOwn(state.cards, id)).map((id) => state.cards[id]!.marking));
  const out: string[] = [banner, "", `# ${plain(state.meta?.title ?? "Case")}`, ""];
  for (const { id, title } of SECTION_TITLES) {
    out.push(`## ${title}`, "");
    if (id !== "key_findings") { out.push(p[id], ""); continue; }
    p.key_findings.forEach((f, i) => {
      out.push(`${i + 1}. ${f.statement}`, `   - Likelihood: ${f.likelihood}`, `   - Confidence: ${f.confidence} — ${f.confidence_basis}`);
      out.push(`   - Cites: ${f.cites.length === 0 ? "none" : f.cites.map((c) => `[${c}]`).join(", ")}`);
      out.push(`   - Assumptions: ${f.assumptions.length === 0 ? "none" : ""}`);
      for (const a of f.assumptions) out.push(`     - ${a}`);
      out.push(`   - Reasoning (judgment): ${f.reasoning}`);
    });
    out.push("");
  }
  out.push("## Provenance", "");
  for (const id of cited) {
    const c = Object.hasOwn(state.cards, id) ? state.cards[id]! : null;
    if (c === null) { out.push(`### ${id}`, "", "This card is not in the record.", ""); continue; }
    const q = c.query !== null && Object.hasOwn(state.queries, c.query) ? state.queries[c.query]! : null;
    const coverage = c.coverage === null ? "not recorded" : c.coverage.kind === "full" ? "full" : `partial: ${c.coverage.reason}${c.coverage.detail === undefined ? "" : ` — ${c.coverage.detail}`}`;
    out.push(`### ${id}: ${plain(c.title)}`, "");
    out.push(`- Source: ${plain(ref.sources.find((s) => s.id === c.source)?.title ?? c.source ?? "none")}`);
    out.push("- Query:", "", q === null ? "none" : fenced(q.text), "");
    out.push(`- Why: ${plain(q?.why ?? c.why)}`);
    out.push(`- By: ${plain(q === null ? c.made_by : `${q.by.kind} ${q.by.id}`)}`);
    out.push(`- When (UTC): ${q?.issued_ts ?? c.created_ts}`);
    out.push(`- Marking: ${c.marking}`);
    out.push(`- Coverage: ${plain(coverage)}`);
    out.push(`- Rows: ${c.row_count}`, "");
  }
  out.push(banner);
  return out.join("\n");
}
