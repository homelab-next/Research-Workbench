// A form check: JSON on standard input, one JSON object on standard output. It judges form only and calls nothing.
const input = JSON.parse(await Bun.stdin.text());
const product = input.draft.product;
const findings: { where: string; message: string }[] = [];
const fail = (where: string, message: string): void => { findings.push({ where, message }); };

const gaps: string = product.gaps_and_limits;
if (gaps.trim() === "") fail("gaps_and_limits", "no gaps or limits are stated");
/** True when the text names the card, as a whole word. */
const names = (text: string, id: string): boolean => new RegExp(`(?<![\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i").test(text);
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
    const asEvidence = ["summary", "assessment", "alternatives"].filter((k) => names(product[k], id));
    for (const k of asEvidence) fail(k, `the ${k} cites ${id}, which has no rows and is not a proven negative with full coverage: name it in gaps_and_limits only`);
    // cited by tool only, with no section's text naming it: where it is used cannot be seen, so it is not accepted as a gap
    if (by.length === 0 && asEvidence.length === 0 && !names(gaps, id)) fail("narrative", `the narrative cites ${id}, which has no rows and is not a proven negative with full coverage`);
  }
}
// a question put to the person and not answered is a gap: the gaps and limits name it (Assemble writes the note)
for (const q of (input.questions ?? []) as { id: string }[]) {
  if (!names(gaps, q.id)) fail("gaps_and_limits", `${q.id} was put to the person and is not answered, and the gaps and limits do not name it`);
}
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
