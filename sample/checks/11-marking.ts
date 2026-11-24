// A form check: JSON on standard input, one JSON object on standard output. It judges form only and calls nothing.
const input = JSON.parse(await Bun.stdin.text());
const product = input.draft.product;
const findings: { where: string; message: string }[] = [];
const fail = (where: string, message: string): void => { findings.push({ where, message }); };

const order: string[] = input.markings;
const own = order.indexOf(product.marking);
if (own < 0) fail("product", `"${product.marking}" is not a marking`);
else {
  const cited: string[] = input.cited ?? product.key_findings.flatMap((f) => f.cites);
  for (const id of cited) {
    const card = input.cards[id];
    if (card !== undefined && order.indexOf(card.marking) < 0) fail("product", `${id} is marked "${card.marking}", which is not a marking, so it counts as the most restrictive`);
    else if (card !== undefined && order.indexOf(card.marking) > own) fail("product", `the product is marked ${product.marking}, which is less restrictive than ${id} (${card.marking})`);
  }
}
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
