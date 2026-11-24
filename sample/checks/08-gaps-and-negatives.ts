// A form check: JSON on standard input, one JSON object on standard output. It judges form only and calls nothing.
const input = JSON.parse(await Bun.stdin.text());
const product = input.draft.product;
const findings: { where: string; message: string }[] = [];
const fail = (where: string, message: string): void => { findings.push({ where, message }); };

const gaps: string = product.gaps_and_limits;
if (gaps.trim() === "") fail("gaps_and_limits", "no gaps or limits are stated");
/** Every card the draft cites, in its findings or its narrative; only the findings' cites when the input does not say. */
const cited: string[] = [...new Set<string>(input.cited ?? product.key_findings.flatMap((f: { cites: string[] }) => f.cites))];
for (const id of cited) {
  const card = input.cards[id];
  if (card === undefined) continue;
  if (card.coverage !== null && card.coverage.kind === "partial") {
    if (!new RegExp(`(?<![\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i").test(gaps)) fail("gaps_and_limits", `${id} has partial coverage (${card.coverage.reason}) and is not named in the gaps and limits`);
  }
  if (card.row_count === 0 && !(card.empty === "proven-negative" && card.coverage !== null && card.coverage.kind === "full")) {
    const by = product.key_findings.filter((f: { cites: string[] }) => f.cites.includes(id));
    for (const f of by) fail(f.id, `${f.id} cites ${id}, which has no rows and is not a proven negative with full coverage`);
    if (by.length === 0) fail("narrative", `the narrative cites ${id}, which has no rows and is not a proven negative with full coverage`);
  }
}
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
