// A form check: JSON on standard input, one JSON object on standard output. It judges form only and calls nothing.
const input = JSON.parse(await Bun.stdin.text());
const product = input.draft.product;
const findings: { where: string; message: string }[] = [];
const fail = (where: string, message: string): void => { findings.push({ where, message }); };

if (product.objective.trim() === "") fail("product", "the objective is empty");
if (product.question.trim() === "") fail("product", "the question is empty");
if (input.objective !== null && product.objective !== input.objective.title) fail("product", `the objective is not "${input.objective.title}"`);
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
