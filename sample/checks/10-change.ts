// A form check: JSON on standard input, one JSON object on standard output. It judges form only and calls nothing.
const input = JSON.parse(await Bun.stdin.text());
const product = input.draft.product;
const findings: { where: string; message: string }[] = [];
const fail = (where: string, message: string): void => { findings.push({ where, message }); };

const change: string = product.change;
const lower = change.trim().toLowerCase();
const terms: string[] = input.standard.change_terms;
const start = terms.find((t) => lower.startsWith(t.toLowerCase()));
if (lower === "") fail("change", "the change from earlier judgments is empty");
else if (start === undefined) fail("change", `the change must start with one of: ${terms.join(", ")}`);
else if (start.toLowerCase() === "first judgment" && input.earlier.length > 0) fail("change", "the change says this is the first judgment, but one has been published");
else if (start.toLowerCase() !== "first judgment" && input.earlier.length === 0) fail("change", `the change starts with "${start}", but no judgment has been published before`);
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
