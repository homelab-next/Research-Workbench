// A form check: JSON on standard input, one JSON object on standard output. It judges form only and calls nothing.
const input = JSON.parse(await Bun.stdin.text());
const product = input.draft.product;
const findings: { where: string; message: string }[] = [];
const fail = (where: string, message: string): void => { findings.push({ where, message }); };

const listed: string[] = [...product.assumptions, ...product.key_findings.flatMap((f: { assumptions: string[] }) => f.assumptions)];
if (listed.length === 0) fail("assumptions", "no assumption is listed");
const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A card named anywhere in the text: [c3], [c3, c2], [Card c3] or a bare c3. */
const holdsCard = (a: string): boolean => /(?<![\w])c\d+(?![\w])/i.test(a) || Object.keys(input.cards).some((id) => new RegExp(`(?<![\\w])${esc(id)}(?![\\w])`, "i").test(a));
product.assumptions.forEach((a: string) => { if (holdsCard(a)) fail("assumptions", `an assumption cites a card, so it is a finding, not an assumption: ${a}`); });
for (const f of product.key_findings) {
  f.assumptions.forEach((a: string) => { if (holdsCard(a)) fail(f.id, `${f.id}: an assumption cites a card: ${a}`); });
  const s = f.statement.toLowerCase();
  if (!input.standard.judgment_markers.some((m: string) => s.includes(m.toLowerCase()))) fail(f.id, `${f.id}: the statement does not say it is a judgment (${input.standard.judgment_markers.join(", ")})`);
}
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
