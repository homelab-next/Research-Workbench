// A form check: JSON on standard input, one JSON object on standard output. It judges form only and calls nothing.
const input = JSON.parse(await Bun.stdin.text());
const product = input.draft.product;
const findings: { where: string; message: string }[] = [];
const fail = (where: string, message: string): void => { findings.push({ where, message }); };

const gaps: string = product.gaps_and_limits;
if (gaps.trim() === "") fail("gaps_and_limits", "no gaps or limits are stated");
const seen = new Set<string>();
for (const f of product.key_findings) {
  for (const id of f.cites) {
    const card = input.cards[id];
    if (card === undefined) continue;
    if (card.coverage !== null && card.coverage.kind === "partial" && !seen.has(id)) {
      seen.add(id);
      if (!new RegExp(`(?<![\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i").test(gaps)) fail("gaps_and_limits", `${id} has partial coverage (${card.coverage.reason}) and is not named in the gaps and limits`);
    }
    if (card.row_count === 0 && !(card.empty === "proven-negative" && card.coverage !== null && card.coverage.kind === "full")) {
      fail(f.id, `${f.id} cites ${id}, which has no rows and is not a proven negative with full coverage`);
    }
  }
}
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
