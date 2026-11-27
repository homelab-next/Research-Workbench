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
/** Abbreviations whose dot does not end a sentence. */
const ABBREV = /(?<!\b(?:approx|e\.g|i\.e|etc|vs|cf|ca|incl|esp|fig|al|resp|min|max|avg|est)\.)/;
/** The sentences of a text, trimmed; a dot inside an address or a number, or after an abbreviation, does not end one. */
const sentences = (text: string): string[] => text.split(new RegExp(String.raw`(?<=[.!?])${ABBREV.source}\s+`)).map((t) => t.trim()).filter((t) => t !== "");
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
// Silence is never the reason for a likelihood or a belonging judgment. Nothing seen may lower confidence, or be named as a limit or as
// something that cannot be told; it may not make a thing more or less likely, or say what the thing is or where it belongs. Deterministic and
// conservative, read clause by clause:
// - a clause ends at a contrast ("but", "although", ...) or a ";" (unless "therefore", "so", ... follows it); a part of a clause ends at ", and";
// - a marker joins a reason to a judgment: forward markers ("because", "as no", "due to", "given", "with no", "without", ":") have the reason
//   after them, backward markers ("so", "therefore", "suggests", "means", "makes", "supports", ...) before them. "since", "given", "with" and
//   "without" count only at the start of a clause or after a comma; "so" does not count as an intensifier ("so short that") or in "so far";
// - a sentence opening with "Therefore", "Thus", "So", "This suggests", ... is read with the one before it;
// - the sentence fails when the reason holds a silence and the judgment holds a likelihood or belonging term, unless the judgment first says
//   confidence, unknown, a limit, or that it cannot be told; a proven negative over full coverage cited in the reason is evidence, not silence.
const NOT_SILENCE = String.raw`(?!\s+(?:doubt|reason|longer|question|sooner|matter)\b)`;
const SILENCE = new RegExp([
  String.raw`\b(?:no|nothing|none)\b${NOT_SILENCE}(?:\s+[^\s.;:!?]+){0,10}?\s+(?:(?:was|were|is|are|has been|have been|had been|has|have|had)\s+)?(?:observed|seen|recorded|found|detected|logged|captured)\b`,
  String.raw`\black of\b(?:\s+[^\s.;:!?]+){0,4}?\s+(?:activity|traffic|data|flows?|records?|logs?|events?|connections?|answers?|evidence|queries|lookups?|sign-ins?)\b`,
  String.raw`\babsence of\b`,
  String.raw`\b(?:was|were|is|are|been|be|being)\s+(?:not|never)\s+(?:(?:yet|once|ever)\s+)?(?:observed|seen|recorded|found|detected|logged)\b`,
  String.raw`\b(?:did|does|do|could|can)(?:\s+not|n't)\s+(?:see|observe|find|record|detect|show|log)\b`,
  String.raw`\bnever\s+(?:saw|observed|seen|recorded|appeared|showed)\b`,
  String.raw`\bthere\s+(?:is|was|are|were|has been|have been)\s+no\b${NOT_SILENCE}`,
  String.raw`\b(?:produced|generated|sent|showed|returned|made|gave)\s+no\b${NOT_SILENCE}`,
  String.raw`\bwithout\s+(?:any\s+)?(?:[^\s.;:!?,]+\s+){0,4}?(?:data|traffic|activity|flows?|records?|logs?|evidence|answers?|sign-ins?)\b`,
].join("|"), "gi");
const FORWARD = /\b(?:because(?:\s+of)?|due\s+to|owing\s+to|on\s+account\s+of|given(?:\s+that)?|since|as|with(?=\s+(?:no|nothing)\b)|without)\b|:/gi;
const BACKWARD = /\b(?:so|therefore|thus|hence|consequently|accordingly|suggest(?:s|ing|ed)?|indicat(?:es?|ing|ed)|impl(?:y|ies|ying|ied)|means?|meaning|mak(?:es?|ing)|made|points?\s+to|pointing\s+to|favou?r(?:s|ing|ed)?|support(?:s|ing|ed)?|consistent\s+with|argues?\s+for)\b/gi;
/** Backward markers that are a judgment themselves: "supports the guest hypothesis". */
const EVIDENTIAL = /^(?:favou?r|support|consistent|points?|pointing|argues?)/i;
/** A clause's own start: nothing before it but a conjunction. */
const OPENS = /^[\s"'(]*(?:(?:and|or|but|although|though|while|whereas|yet|however|so)[\s,]+)?$/i;
const CONTRAST = /\b(?:but|though|although|however|whereas|while|(?<!\b(?:not|as)\s)yet)\b|;(?!\s*(?:therefore|thus|hence|so|consequently|accordingly)\b)/gi;
const SOFT = /,\s+(?:and|or)\b/gi;
/** A sentence that reasons from the one before it. */
const FOLLOWS = /^(?:therefore|thus|hence|so|consequently|accordingly|this\s+(?:suggests|means|makes|indicates|implies|points|supports|favou?rs))\b/i;
const JUDGE = /\b(?:likely|unlikely|likelihood|probabl[ey]|probable|improbable|almost\s+certain(?:ly)?|remote\s+chance|roughly\s+even|chances?|belong(?:s|ing|ed)?|part\s+of|owned\s+by|(?:is|was|are|were|be)\s+(?:not\s+)?an?\b(?!\s+(?:gap|limit|limitation)\b))/i;
/** What a judgment part may say first without drawing a judgment from the silence: confidence, a limit, the unknown, or that it cannot be told. */
const NOT_JUDGED = /\b(?:(?:cannot|can\s?not|can't|could\s+not|unable\s+to|not\s+possible\s+to|impossible\s+to|no\s+way\s+to)\s+(?:\w+\s+){0,2}?(?:say|tell|determine|confirm|establish|know|assess|judge|rule\s+out|be\s+sure|decide|conclude)|confidence|unknown|unclear|rests?\s+on|(?:was|were|is|are)\s+used|limits?|limiting|insufficient|not\s+enough)\b/i;
/** The places a pattern matches: [start, end] pairs. */
const spans = (re: RegExp, text: string): [number, number][] => [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length]);
/** True when the marker at [m0, m1] of the clause counts; only the few characters around it are read. */
function counts(clause: string, m0: number, m1: number): boolean {
  const word = clause.slice(m0, m1).toLowerCase();
  const before = clause.slice(Math.max(0, m0 - 40), m0);
  const after = clause.slice(m1, m1 + 80);
  const atStart = m0 < 40 && OPENS.test(clause.slice(0, m0));
  const afterComma = /,\s*$/.test(before);
  if (word === "since" || word.startsWith("given") || word === "with" || word === "without") return atStart || afterComma;
  if (word === "as") return atStart || afterComma || /^\s+(?:no|nothing|there\s+(?:is|was|are|were)\s+no|the\s+(?:lack|absence)|we\s+(?:did|could)\s+not|it\s+(?:produced|generated|showed|sent)\s+no)\b/i.test(after);
  if (word === "so") {
    if (/\b(?:is|are|was|were|be|been|not|very|quite)\s+$/i.test(before)) return false;
    return !/^\s+(?:far|that|much|many|long|few|little|\w+\s+that)\b/i.test(after);
  }
  if (word === "means") return !/\bby\s+$/i.test(before);
  return true;
}
/** The first of the sorted starts at or after `a` and before `b`, or -1. */
function firstIn(starts: readonly number[], a: number, b: number): number {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (starts[mid]! < a) lo = mid + 1; else hi = mid; }
  return lo < starts.length && starts[lo]! < b ? starts[lo]! : -1;
}
/** The clauses of a sentence, a contrast word starting the clause it opens. */
function clauses(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  for (const [a, b] of spans(CONTRAST, text)) {
    out.push(text.slice(at, a));
    at = text[a] === ";" ? b : a;
  }
  out.push(text.slice(at));
  return out.filter((c) => c.trim() !== "");
}
const PROVEN: string[] = Object.values(input.cards as Record<string, { id: string; row_count: number; empty: string | null; coverage: { kind: string } | null }>)
  .filter((c) => c.row_count === 0 && c.empty === "proven-negative" && c.coverage !== null && c.coverage.kind === "full").map((c) => c.id);
const citeRe = (id: string): RegExp => new RegExp(`(?<![\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "gi");
/** The silence a text gives as the reason for a judgment, with the marker that joins them, or null. Each clause is scanned once per pattern. */
function silenceAsReason(text: string): { silence: string; marker: string } | null {
  for (const clause of clauses(text)) {
    const silences = spans(SILENCE, clause);
    if (silences.length === 0) continue;
    const sil = silences.map(([a]) => a);
    const judge = spans(new RegExp(JUDGE.source, "gi"), clause).map(([a]) => a);
    const notJudged = spans(new RegExp(NOT_JUDGED.source, "gi"), clause).map(([a]) => a);
    // a proven negative over full coverage cited in the reason is evidence: its cite is where the reason names it
    const cites = PROVEN.flatMap((id) => spans(citeRe(id), clause).map(([a]) => a)).sort((x, y) => x - y);
    const soft = spans(SOFT, clause);
    const softStarts = soft.map(([a]) => a);
    const partEnd = (from: number): number => { const i = firstIn(softStarts, from, clause.length); return i === -1 ? clause.length : i; };
    const partStart = (to: number): number => { let at = 0; for (const [, b] of soft) if (b <= to) at = b; return at; };
    /** True when [a, b) draws a likelihood or a belonging judgment: a term that no "confidence", limit or "cannot tell" comes before. */
    const judges = (a: number, b: number, evidential: boolean): boolean => {
      if (evidential) return true;
      const j = firstIn(judge, a, b);
      return j !== -1 && firstIn(notJudged, a, j) === -1;
    };
    const hit = (r0: number, r1: number, j0: number, j1: number, evidential: boolean, marker: string): { silence: string; marker: string } | null => {
      const s = firstIn(sil, r0, r1);
      if (s === -1 || firstIn(cites, r0, r1) !== -1 || !judges(j0, j1, evidential)) return null;
      const [x, y] = silences.find(([q]) => q === s)!;
      return { silence: clause.slice(x, y), marker };
    };
    for (const [m0, m1] of spans(FORWARD, clause)) {
      if (!counts(clause, m0, m1)) continue;
      const marker = clause.slice(m0, m1);
      let r: { silence: string; marker: string } | null;
      if (marker !== ":" && m0 < 40 && OPENS.test(clause.slice(0, m0))) {
        // "Because no DNS was seen, it is unlikely ...": the reason runs to the first comma, the judgment is the part after it
        const comma = clause.indexOf(",", m1);
        r = comma === -1 ? hit(m0, clause.length, m1, clause.length, false, marker) : hit(m0, comma, comma + 1, partEnd(comma + 1), false, marker);
      } else {
        // "It is unlikely because no DNS was seen": the reason runs to the clause's end, the judgment is the part before the marker
        r = hit(m0, clause.length, partStart(m0), m0, false, marker);
      }
      if (r !== null) return r;
    }
    for (const [m0, m1] of spans(BACKWARD, clause)) {
      if (!counts(clause, m0, m1)) continue;
      const marker = clause.slice(m0, m1);
      const r = hit(0, m0, m1, partEnd(m1), EVIDENTIAL.test(marker), marker);
      if (r !== null) return r;
    }
  }
  return null;
}
/** The units read for silence: each sentence, with a sentence that reasons from the one before it read together with that one. */
function units(text: string): string[] {
  const out: string[] = [];
  for (const s of sentences(text)) {
    if (out.length > 0 && FOLLOWS.test(s)) out[out.length - 1] += ` ${s}`;
    else out.push(s);
  }
  return out;
}
for (const k of NARRATIVE) {
  for (const s of units(product[k])) {
    const r = silenceAsReason(s);
    if (r === null) continue;
    fail(k, `the ${k} gives silence as a reason: "${s}" draws a judgment ("${r.marker}") from "${r.silence}"; nothing seen is a gap, not evidence, unless a proven negative over full coverage is cited: name it in gaps_and_limits only. The rule: silence may lower confidence, or be named as a limit or as what cannot be told, but it is never the reason for a likelihood or for what the thing is or where it belongs.`);
  }
}
// a question put to the person and not answered is a gap: the gaps and limits name it (Assemble writes the note)
for (const q of (input.questions ?? []) as { id: string }[]) {
  if (!names(gaps, q.id)) fail("gaps_and_limits", `${q.id} was put to the person and is not answered, and the gaps and limits do not name it`);
}
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
