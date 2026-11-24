// A form check: JSON on standard input, one JSON object on standard output. It judges form only and calls nothing.
const input = JSON.parse(await Bun.stdin.text());
const product = input.draft.product;
const findings: { where: string; message: string }[] = [];
const fail = (where: string, message: string): void => { findings.push({ where, message }); };


/** Every likelihood term and variant of the standard, longest first, with the term each stands for. */
const names: { text: string; term: string }[] = [];
for (const l of input.standard.likelihood) for (const t of [l.term, ...(l.also ?? [])]) names.push({ text: String(t).toLowerCase(), term: l.term });
names.sort((a, b) => b.text.length - a.text.length);
/** The terms a text holds, longest match first, so "very likely" is not also "likely". A match is a whole phrase. */
function termsIn(text: string): string[] {
  let rest = text.toLowerCase();
  const found: string[] = [];
  for (const n of names) {
    const re = new RegExp(`(?<![\\w])${n.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "g");
    rest = rest.replace(re, () => { found.push(n.term); return " ".repeat(n.text.length); });
  }
  return found;
}

for (const f of product.key_findings) {
  const terms = new Set(input.standard.likelihood.map((l: { term: string }) => l.term));
  if (!terms.has(f.likelihood)) { fail(f.id, `${f.id}: "${f.likelihood}" is not a likelihood term of the standard`); continue; }
  const held = termsIn(f.statement);
  if (held.length !== 1) fail(f.id, `${f.id}: the statement must hold exactly one likelihood term, and holds ${held.length === 0 ? "none" : held.map((t) => `"${t}"`).join(", ")}`);
  else if (held[0] !== f.likelihood) fail(f.id, `${f.id}: the statement says "${held[0]}" but the likelihood is "${f.likelihood}"`);
}
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
