// A form check: JSON on standard input, one JSON object on standard output. It judges form only and calls nothing.
const input = JSON.parse(await Bun.stdin.text());
const product = input.draft.product;
const findings: { where: string; message: string }[] = [];
const fail = (where: string, message: string): void => { findings.push({ where, message }); };

const entries: { source: string; quality: string }[] = product.sources;
/** The source a finding names when it rests on the person's word; the workbench spells it the same. */
const PERSON = "the person";
/** True when the text names the card, as a whole word. */
const names = (text: string, id: string): boolean => new RegExp(`(?<![\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i").test(text);
const checked = new Set<string>();
for (const f of product.key_findings) {
  for (const id of f.cites) {
    const card = input.cards[id];
    if (card === undefined || checked.has(`${id}`)) continue;
    // a statement by the person is not data from a source: the sources must say the finding rests on it
    if (card.person !== undefined) {
      checked.add(id);
      const said = entries.find((e) => e.source === PERSON);
      if (said === undefined || !names(said.quality, id)) fail("sources", `${f.id} rests on the person's statement ${id}, and the sources do not say so`);
      continue;
    }
    if (card.source === null) continue;
    checked.add(id);
    const entry = entries.find((e) => e.source === card.source);
    if (entry === undefined || entry.quality.trim() === "") { fail("sources", `${card.source} (cited by ${f.id}) has no statement of its quality in the sources`); continue; }
    const notes: { id: string; text: string }[] = input.sources[card.source]?.quality_notes ?? [];
    for (const n of card.quality_notes) {
      const note = notes.find((x) => x.id === n);
      if (note !== undefined && !entry.quality.toLowerCase().includes(note.text.toLowerCase())) fail("sources", `the quality of ${card.source} leaves out the note "${note.text}" that applies to ${id}`);
    }
  }
}
console.log(JSON.stringify({ pass: findings.length === 0, findings }));
