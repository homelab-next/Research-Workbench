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

const levels: string[] = input.standard.confidence;
const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/);
/** A sentence that holds both "<level> confidence" and a likelihood term has run the two together. */
function mixed(text: string): boolean {
  return sentences(text).some((s) => levels.some((l) => new RegExp(`(?<![\\w])(?:${l} confidence|confidence(?:\\s+(?:is|of|level|level is))?\\s*[:=-]?\\s*${l})(?![\\w])`, "i").test(s)) && termsIn(s).length > 0);
}
for (const f of product.key_findings) {
  if (!levels.includes(f.confidence)) fail(f.id, `${f.id}: "${f.confidence}" is not a confidence level of the standard`);
  if (f.confidence_basis.trim() === "") fail(f.id, `${f.id}: the basis for the confidence is empty`);
  if (mixed(f.statement)) fail(f.id, `${f.id}: a sentence of the statement gives both a confidence level and a likelihood`);
}
if (mixed(product.summary)) fail("summary", "a sentence of the summary gives both a confidence level and a likelihood");
if (mixed(product.assessment)) fail("assessment", "a sentence of the assessment gives both a confidence level and a likelihood");
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
