// A form check: JSON on standard input, one JSON object on standard output. It judges form only and calls nothing.
const input = JSON.parse(await Bun.stdin.text());
const product = input.draft.product;
const findings: { where: string; message: string }[] = [];
const fail = (where: string, message: string): void => { findings.push({ where, message }); };

for (const f of product.key_findings) {
  if (f.cites.length === 0) fail(f.id, `${f.id} cites no card`);
  for (const c of f.cites) if (!Object.hasOwn(input.cards, c)) fail(f.id, `${f.id} cites ${c}, which is not a card of this case`);
}
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
