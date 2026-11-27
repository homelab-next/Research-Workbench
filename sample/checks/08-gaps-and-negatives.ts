// A form check: JSON on standard input, one JSON object on standard output. It judges form only and calls nothing.
const input = JSON.parse(await Bun.stdin.text());
const product = input.draft.product;
const findings: { where: string; message: string }[] = [];
const fail = (where: string, message: string): void => { findings.push({ where, message }); };

const gaps: string = product.gaps_and_limits;
if (gaps.trim() === "") fail("gaps_and_limits", "no gaps or limits are stated");
/** True when the text names the card, as a whole word. */
const names = (text: string, id: string): boolean => new RegExp(`(?<![\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i").test(text);
/** The narrative sections read for silence used as evidence; gaps_and_limits is where silence belongs, so it is never read for it. */
const NARRATIVE = ["summary", "assessment", "alternatives"];
/** The sentences of a text, trimmed; a dot inside an address or a number does not end one. */
const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/).map((t) => t.trim()).filter((t) => t !== "");
/** Every card the draft cites, in its findings or its narrative; only the findings' cites when the input does not say. */
const cited: string[] = [...new Set<string>(input.cited ?? product.key_findings.flatMap((f: { cites: string[] }) => f.cites))];
for (const id of cited) {
  const card = input.cards[id];
  if (card === undefined) continue;
  if (card.coverage !== null && card.coverage.kind === "partial") {
    if (!names(gaps, id)) fail("gaps_and_limits", `${id} has partial coverage (${card.coverage.reason}) and is not named in the gaps and limits`);
  }
  // a result with no rows that is not a proven negative over full coverage is a gap, not evidence: gaps_and_limits is where it belongs.
  // A statement by the person has no rows by nature: it is their word, not an empty result.
  if (card.person === undefined && card.row_count === 0 && !(card.empty === "proven-negative" && card.coverage !== null && card.coverage.kind === "full")) {
    const by = product.key_findings.filter((f: { cites: string[] }) => f.cites.includes(id));
    for (const f of by) fail(f.id, `${f.id} cites ${id}, which has no rows and is not a proven negative with full coverage`);
    const asEvidence = NARRATIVE.filter((k) => names(product[k], id));
    for (const k of asEvidence) {
      for (const s of sentences(product[k]).filter((t) => names(t, id))) fail(k, `the ${k} cites ${id}, which has no rows and is not a proven negative with full coverage: "${s}"; name it in gaps_and_limits only`);
    }
    // cited by tool only, with no section's text naming it: where it is used cannot be seen, so it is not accepted as a gap
    if (by.length === 0 && asEvidence.length === 0 && !names(gaps, id)) fail("narrative", `the narrative cites ${id}, which has no rows and is not a proven negative with full coverage`);
  }
}
// Silence is never a reason, anywhere: a sentence that says nothing was seen and draws a likelihood or a belonging judgment from it fails.
// Saying the silence limits what can be told, or that it cannot be told, is a gap and passes. Deterministic and conservative:
// the silence and the reason marker must sit in one clause (no "but", "though", ... between them), on the side the marker reasons from.
const SILENCE = /\b(?:no|nothing)\b(?:\s+[^\s.;!?]+){0,10}?\s+(?:(?:was|were|is|are|has been|have been)\s+)?(?:observed|seen|recorded|found|detected|logged)\b|\black of\b(?:\s+[^\s.;!?]+){0,4}?\s+(?:activity|traffic|data|flows?|records?|logs?|events?|connections?|answers?)\b|\babsence of\b/gi;
/** Markers whose reason follows them ("because no DNS was seen"). */
const FORWARD = /\b(?:because|since|given that|as there (?:was|were|is|are))\b/gi;
/** Markers whose reason comes before them ("no DNS was seen, so ..."). */
const BACKWARD = /\b(?:so(?!\s+far\b)|therefore|thus|hence|suggests?|suggesting|indicates?|indicating|points? to|makes?\b(?:\s+[^\s.;!?]+){0,6}?\s+(?:less|more)\s+(?:likely|probable)|favou?r(?:s|ing)?)\b/gi;
const CONTRAST = /\b(?:but|though|although|however|yet|while|whereas)\b|;/i;
const LIKELIHOOD = /\b(?:likely|unlikely|likelihood|probabl[ey]|improbable|almost certain(?:ly)?|remote chance|roughly even)\b/i;
const UNCERTAIN = /\b(?:cannot|can ?not|can't|unable to|not possible to|impossible to|no way to|limits?|limiting|insufficient|not enough)\b/i;
/** The places a pattern matches: [start, end] pairs. */
const spans = (re: RegExp, text: string): [number, number][] => [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length]);
/** The silence phrase a sentence draws a judgment from, or null. */
function silenceAsReason(sentence: string): { silence: string; marker: string } | null {
  if (UNCERTAIN.test(sentence) && !LIKELIHOOD.test(sentence)) return null;
  for (const [s0, s1] of spans(SILENCE, sentence)) {
    for (const [m0, m1] of spans(FORWARD, sentence)) {
      if (m1 <= s0 && !CONTRAST.test(sentence.slice(m1, s0))) return { silence: sentence.slice(s0, s1), marker: sentence.slice(m0, m1) };
    }
    for (const [m0, m1] of spans(BACKWARD, sentence)) {
      if (s1 <= m0 && !CONTRAST.test(sentence.slice(s1, m0))) return { silence: sentence.slice(s0, s1), marker: sentence.slice(m0, m1) };
    }
  }
  return null;
}
/** True when the sentence cites a card whose empty result is a proven negative over full coverage: that silence is evidence. */
const proven = (sentence: string): boolean => Object.values(input.cards as Record<string, { id: string; row_count: number; empty: string | null; coverage: { kind: string } | null }>)
  .some((c) => c.row_count === 0 && c.empty === "proven-negative" && c.coverage !== null && c.coverage.kind === "full" && names(sentence, c.id));
for (const k of NARRATIVE) {
  for (const s of sentences(product[k])) {
    const r = silenceAsReason(s);
    if (r === null || proven(s)) continue;
    fail(k, `the ${k} gives silence as a reason: "${s}" draws a judgment ("${r.marker}") from "${r.silence}"; nothing seen is a gap, not evidence, unless a proven negative over full coverage is cited: name it in gaps_and_limits only`);
  }
}
// a question put to the person and not answered is a gap: the gaps and limits name it (Assemble writes the note)
for (const q of (input.questions ?? []) as { id: string }[]) {
  if (!names(gaps, q.id)) fail("gaps_and_limits", `${q.id} was put to the person and is not answered, and the gaps and limits do not name it`);
}
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
