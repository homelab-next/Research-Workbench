import { afterEach, expect, test } from "bun:test";
import { initial } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Reference } from "../../src/core/wire";
import { citedIds, narrativeMarkdown } from "../../src/web/markdown";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served | null = null;
const esc = (t: string): string => t.replace(/([\\`*_{}[\]()#+\-.!|>~<&])/g, "\\$1");
afterEach(async () => { await s?.close(); s = null; });

async function sample(): Promise<{ state: CaseState; ref: Reference; id: string }> {
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  const ref = (await (await s.get("/api/reference")).json()) as Reference;
  return { state: s.app.hub.read(id).state, ref, id };
}

test("the Markdown has the marking first and last, the five sections, and each cited card's provenance", async () => {
  const { state, ref } = await sample();
  const md = narrativeMarkdown(state, ref);
  const lines = md.split("\n");
  const d = state.drafts.at(-1)!;
  expect(lines[0]).toBe(d.product.marking);
  expect(lines.at(-1)).toBe(d.product.marking);
  expect(md).toContain(`# ${state.meta!.title}`);
  const heads = lines.filter((l) => l.startsWith("## "));
  expect(heads).toEqual(["## Summary", "## Key findings", "## Gaps and limits", "## Alternatives", "## Assessment", "## Provenance"]);
  expect(md).toContain(d.product.summary);
  expect(md).toContain(d.product.key_findings[0]!.statement);
  expect(md).toContain("Likelihood: very likely");
  expect(md).toContain("Confidence: moderate");
  // every cited card is expanded
  const cited = [...new Set([...d.product.key_findings.flatMap((f) => f.cites), ...(d.cited ?? [])])];
  expect(cited.length).toBeGreaterThan(2);
  for (const id of cited) {
    const c = state.cards[id]!;
    const q = state.queries[c.query!]!;
    expect(md).toContain(`### ${id}: ${esc(c.title)}`);
    expect(md).toContain(q.text);
    expect(md).toContain(`Marking: ${c.marking}`);
    expect(md).toContain(`Rows: ${c.row_count}`);
    expect(md).toContain(q.issued_ts);
    expect(md).toContain(`Source: ${esc(ref.sources.find((x) => x.id === c.source)!.title)}`);
  }
  expect(md).toContain("Coverage: partial");
});

test("a query holding backticks cannot break out of its fence", async () => {
  const { state, ref } = await sample();
  const id = state.drafts.at(-1)!.product.key_findings[0]!.cites[0]!;
  const q = state.queries[state.cards[id]!.query!]!;
  const hostile: CaseState = { ...state, queries: { ...state.queries, [q.id]: { ...q, text: "select ```; # heading" } } };
  const md = narrativeMarkdown(hostile, ref);
  expect(md).toContain("````\nselect ```; # heading\n````");
});

test("the provenance fields are plain text: nothing in them can start a heading, a list or a link, and newlines are gone", async () => {
  const { state, ref } = await sample();
  const id = state.drafts.at(-1)!.product.key_findings[0]!.cites[0]!;
  const c = state.cards[id]!;
  const q = state.queries[c.query!]!;
  const evil = "x\n## Injected\n- [a](https://example.invalid)";
  const hostile: CaseState = {
    ...state, meta: { ...state.meta!, title: "T\n# Bad title" },
    cards: { ...state.cards, [id]: { ...c, title: evil, why: evil } },
    queries: { ...state.queries, [q.id]: { ...q, why: evil, by: { kind: "human", id: "a\n# who" } } },
  };
  const md = narrativeMarkdown(hostile, ref);
  const heads = md.split("\n").filter((l) => l.startsWith("#"));
  expect(heads).toEqual(["# T \\# Bad title", "## Summary", "## Key findings", "## Gaps and limits", "## Alternatives", "## Assessment", "## Provenance", ...citedIds(state.drafts.at(-1)!).map((x) => (x === id ? `### ${x}: x \\#\\# Injected \\- \\[a\\]\\(https://example\\.invalid\\)` : `### ${x}: ${esc(state.cards[x]!.title)}`))]);
  expect(md.split("\n").some((l) => l.startsWith("- [a]") || l.startsWith("# who"))).toBe(false);
});

test("with no draft there is nothing to copy", () => {
  expect(narrativeMarkdown(initial(), { types: [], sources: [], pivots: [], objectives: [], phases: [], profile: { id: "p", title: "p" }, send_back_cap: 3, playbooks: [], inventories: [] })).toBe("");
});

test("the banner is the strictest of the product's marking and every cited card's", async () => {
  const { state, ref } = await sample();
  const d = state.drafts.at(-1)!;
  const id = d.product.key_findings[0]!.cites[0]!;
  expect(d.product.marking).toBe("TLP:GREEN");
  const stricter: CaseState = { ...state, cards: { ...state.cards, [id]: { ...state.cards[id]!, marking: "TLP:AMBER" } } };
  const lines = narrativeMarkdown(stricter, ref).split("\n");
  expect(lines[0]).toBe("TLP:AMBER");
  expect(lines.at(-1)).toBe("TLP:AMBER");
});

test("the copied provenance of a statement says it is the person's word and how they know", async () => {
  const { state, ref } = await sample();
  const id = state.drafts.at(-1)!.product.key_findings[0]!.cites[0]!;
  const c = state.cards[id]!;
  const said: CaseState = { ...state, cards: { ...state.cards, [id]: { ...c, query: null, source: null, made_by: "human", kind: "note", rows: [], row_count: 0, coverage: null, why: "did it myself: I installed it\n## Injected",
    person: { basis: "did", detail: "I installed it\n## Injected", about: [{ type: "address", value: "192.0.2.17" }], answers: "ask-1" } } } };
  const md = narrativeMarkdown(said, ref);
  const at = md.indexOf(`### ${id}:`);
  const section = md.slice(at, md.indexOf("### ", at + 4) < 0 ? undefined : md.indexOf("### ", at + 4));
  expect(section).toContain("- Source: the person (a statement, not data from a source)");
  expect(section).toContain("- How they know: did it myself: I installed it \\#\\# Injected");
  expect(section).toContain("- About: address 192\\.0\\.2\\.17");
  expect(section).toContain("- Answers: ask\\-1");
  expect(section).not.toContain("- Query:");
  expect(section).not.toContain("- Coverage:");
  expect(md.split("\n").filter((l) => l.startsWith("#"))).not.toContain("## Injected");
});
