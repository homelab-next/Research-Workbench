import { afterEach, expect, test } from "bun:test";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";
import { card } from "../helpers/entries";
import type { Actor, Card, EntryInput } from "../../src/core/types";

let p: Page | null = null;
afterEach(async () => {
  if (p !== null) expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]);
  await p?.close();
  p = null;
});

async function open(): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPublishGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  return p;
}
const sys = { kind: "system" as const, id: "t" };
/** Commits a hand-made card (and optionally the query it came from), waits for it to render, and answers the id the ledger gave the card. */
async function plant(q: Page, c: Card, query?: { by?: Actor; error?: string; why?: string }): Promise<string> {
  const session = q.s.app.hub.read("CASE-1");
  let made = "";
  session.commit((_state, ids) => {
    const out: EntryInput[] = [];
    made = ids.next("card");
    let qid: string | null = null;
    if (query !== undefined) {
      qid = ids.next("query");
      out.push({ type: "query.issued", actor: query.by ?? sys, payload: { query: qid, source: "reputation", source_hash: "h", pivot: null, pivot_hash: null, connector: "c", text: "SELECT 1 -- <b>", bound: {}, window: { from: null, to: null }, why: query.why ?? "to see", estimate: null, step: null, verifies: null, purpose: "result" } });
      if (query.error !== undefined) out.push({ type: "query.failed", actor: sys, payload: { query: qid, error: query.error } });
    }
    out.push({ type: "card.created", actor: sys, payload: { card: { ...c, id: made, query: qid } } });
    return out;
  });
  await q.settle();
  return made;
}
const state = (q: Page) => q.s.app.hub.read("CASE-1").state;
const labels = (q: Page, id: string): string[] => q.all(`[data-card=${id}] dt`).map((e) => e.textContent!);

test("a closed card shows title, tags in words and its one-line body", async () => {
  const q = await open();
  const c9 = await plant(q, card("x", { title: "Reputation of 192.0.2.9", body: "two hits", made_by: "agent", coverage: { kind: "partial", reason: "timeout", detail: "slow" }, rows: [["a"], ["b"], ["c"], ["d"]], row_count: 4 }));
  const el = q.q(`[data-card=${c9}]`);
  expect(el.querySelector(".title")!.textContent).toBe("Reputation of 192.0.2.9");
  const tags = [...el.querySelectorAll(".tag")].map((t) => t.textContent);
  expect(tags).toEqual(expect.arrayContaining(["new", "partial", "agent"]));
  expect(el.querySelector(".tag-attention")!.getAttribute("title")).toContain("timeout");
  expect(el.querySelector(".body")!.textContent).toBe("two hits");
  expect(el.querySelectorAll("tbody tr").length).toBe(3);
  expect(el.querySelector("dl")).toBeNull();
  expect(tags).not.toContain("proven negative");
});

test("proven negative, nothing found, pinned, validated and differs are tagged in words", async () => {
  const q = await open();
  const c9 = await plant(q, card("x", { row_count: 0, rows: [], empty: "proven-negative", coverage: { kind: "full" }, made_by: "human" }));
  const c10 = await plant(q, card("y", { row_count: 0, rows: [], empty: "not-seen", coverage: { kind: "full" }, made_by: "system" }));
  const tags = (id: string): string[] => [...q.q(`[data-card=${id}]`).querySelectorAll(".tag")].map((t) => t.textContent!);
  expect(tags(c9)).toEqual(expect.arrayContaining(["proven negative", "human"]));
  expect(tags(c10)).toEqual(expect.arrayContaining(["nothing found", "system"]));
  q.s.app.hub.read("CASE-1").commit(() => [
    { type: "card.pinned", actor: sys, payload: { card: c9, pinned: true } },
    { type: "verify.run", actor: sys, payload: { original: "q1", rerun: null, card: c9, outcome: "differs", detail: "3 rows now" } },
    { type: "verify.run", actor: sys, payload: { original: "q1", rerun: null, card: c10, outcome: "matches", detail: "same" } },
  ]);
  await q.settle();
  expect(tags(c9)).toEqual(expect.arrayContaining(["pinned", "differs"]));
  expect(q.q(`[data-card=${c9}] .tag-attention`).getAttribute("title")).toBe("3 rows now");
  expect(tags(c10).find((t) => t.startsWith("validated "))).toBeDefined();
});

test("a card opened is no longer new", async () => {
  const q = await open();
  const c9 = await plant(q, card("x"));
  expect([...q.q(`[data-card=${c9}]`).querySelectorAll(".tag")].map((t) => t.textContent)).toContain("new");
  q.click(`[data-card=${c9}]`); await q.settle();
  expect([...q.q(`[data-card=${c9}]`).querySelectorAll(".tag")].map((t) => t.textContent)).not.toContain("new");
});

test("an open card shows where it came from", async () => {
  const q = await open();
  const c1 = state(q).cards.c1!;
  q.click("[data-card=c1]"); await q.settle();
  for (const label of ["Source", "Query", "Why", "By", "Marking", "When", "Coverage", "If empty"]) expect(labels(q, "c1")).toContain(label);
  expect(q.q("[data-card=c1] pre.query").textContent).toBe(state(q).queries[c1.query!]!.text);
  expect(q.q("[data-card=c1] time").textContent).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(q.q("[data-card=c1] .provenance").textContent).toContain(c1.marking);
  const job = q.s.entries("CASE-1")[state(q).queries[c1.query!]!.issued_seq - 1]!.job;
  if (job !== null) expect(labels(q, "c1")).toContain("Job");
  expect(q.q("[data-card=c1] [role=toolbar]")).toBeDefined();
});

test("an agent's why is labelled as the agent's own account", async () => {
  const q = await open();
  const agent: Actor = { kind: "agent", id: "researcher-1", stage: "research", profile: "p", model: "m", effort: null, where: "machine" };
  const c9 = await plant(q, card("x"), { by: agent, why: "to check reputation" });
  q.click(`[data-card=${c9}]`); await q.settle();
  const why = [...q.all(`[data-card=${c9}] dd`)][labels(q, c9).indexOf("Why")]!;
  expect(why.textContent).toBe("reasoning as stated by the agent: to check reputation");
  expect([...q.all(`[data-card=${c9}] dd`)][labels(q, c9).indexOf("By")]!.textContent).toBe("agent researcher-1");
});

test("typed cells are chips, untyped cells are text, and a value not yet in the case is dashed", async () => {
  const q = await open();
  const c9 = await plant(q, card("x", { columns: ["ip", "note"], column_types: ["address", null], rows: [["203.0.113.9", "hello"], ["198.51.100.77", "again"]], row_count: 2 }));
  const el = q.q(`[data-card=${c9}]`);
  const chips = [...el.querySelectorAll("button.value")] as HTMLElement[];
  expect(chips.map((c) => c.getAttribute("aria-label"))).toEqual(["address 203.0.113.9", "address 198.51.100.77"]);
  expect(chips[0]!.classList.contains("proposed")).toBe(true);           // not in the case
  expect(chips[1]!.classList.contains("proposed")).toBe(false);          // the case's own starting value
  expect(el.querySelectorAll("td button").length).toBe(2);
  chips[0]!.dispatchEvent(new q.win.MouseEvent("click", { bubbles: true }) as unknown as Event);
  expect(q.navCalls).toContainEqual(["pivot", c9, [{ type: "address", value: "203.0.113.9" }]]);
});

test("a column header offers every distinct value in the column", async () => {
  const q = await open();
  const c9 = await plant(q, card("x", { columns: ["ip"], column_types: ["ip"], rows: [["192.0.2.1"], ["192.0.2.2"], ["192.0.2.1"], ["192.0.2.3"]], row_count: 4 }));
  q.click(`[data-card=${c9}] th button`);
  expect(q.navCalls.at(-1)).toEqual(["pivot", c9, [{ type: "ip", value: "192.0.2.1" }, { type: "ip", value: "192.0.2.2" }, { type: "ip", value: "192.0.2.3" }]]);
});

test("an open card shows every preview row and how many there are", async () => {
  const q = await open();
  const c9 = await plant(q, card("x", { rows: [["a"], ["b"], ["c"], ["d"], ["e"]], row_count: 40 }));
  expect(q.all(`[data-card=${c9}] tbody tr`).length).toBe(3);
  q.click(`[data-card=${c9}]`); await q.settle();
  expect(q.all(`[data-card=${c9}] tbody tr`).length).toBe(5);
  expect(q.q(`[data-card=${c9}] .rowcount`).textContent).toBe("5 of 40 rows");
});

test("hostile source text is shown as text and makes no link", async () => {
  const q = await open();
  const long = "A".repeat(4096);
  const c9 = await plant(q, card("x", {
    title: "<img src=x onerror=alert(1)>", body: "see javascript:alert(1) and http://example.net",
    columns: ["v", "w"], column_types: [null, "domain"], rows: [[long, "‮gnp.exe"]], row_count: 1,
    quality_notes: ["<script>alert(1)</script>"],
  }), { error: "<script>alert(2)</script>" });
  q.click(`[data-card=${c9}]`); await q.settle();
  expect(q.q(`[data-card=${c9}]`).querySelectorAll("img, script, a").length).toBe(0);
  expect(q.q(`[data-card=${c9}] .title`).textContent).toBe("<img src=x onerror=alert(1)>");
  expect(q.q(`[data-card=${c9}] .body`).textContent).toBe("see javascript:alert(1) and http://example.net");
  expect(q.q(`[data-card=${c9}] td.long`).textContent!.length).toBeLessThanOrEqual(201);
  expect(q.q(`[data-card=${c9}] td.long`).getAttribute("title")!.length).toBe(4096);
  expect(q.q(`[data-card=${c9}]`).textContent).toContain("<script>alert(1)</script>");
  expect(q.q(`[data-card=${c9}]`).textContent).toContain("<script>alert(2)</script>");
});

test("the actions offered follow where the card is", async () => {
  const q = await open();
  const incoming = q.q("[data-area=incoming] [data-card]");
  const id = incoming.dataset.card!;
  q.click(incoming); await q.settle();
  const names = (): string[] => [...q.q(`[data-card=${id}] [role=toolbar]`).querySelectorAll("button, select")].map((e) => e.getAttribute("aria-label") ?? e.textContent!);
  expect(names()).toEqual(["Pivot…", "Verify", "Cite", "Keep", "Discard", "Pin"]);
  expect([...q.q(`[data-card=${id}] [role=toolbar]`).querySelectorAll("button")].filter((b) => ["Pivot…", "Verify"].includes(b.textContent!)).every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);   // Pivot… and Verify are live (Task 13)
  expect((q.q(`[data-card=${id}] [data-action=cite]`) as HTMLButtonElement).disabled).toBe(false);   // Cite opens the Narrative edit (Task 10)
  q.click(`[data-card=${id}] [data-action=keep]`); await q.settle();       // the card stays open where it lands
  expect(names()).toEqual(["Pivot…", "Verify", "Cite", "Move", "Back to Incoming", "Discard", "Pin"]);
});

test("a double click keeps the card", async () => {
  const q = await open();
  const id = q.q("[data-area=incoming] [data-card]").dataset.card!;
  q.q(`[data-card=${id}]`).dispatchEvent(new q.win.MouseEvent("dblclick", { bubbles: true }) as unknown as Event);
  await q.settle();
  expect(state(q).cards[id]!.place).toBe("lane");
});

test("a click opens one card and closes the others; a kept-open card stays", async () => {
  const q = await open();
  const [a, b, c] = q.all("[data-area=incoming] [data-card]").map((e) => e.dataset.card!);
  q.click(`[data-card=${a}]`); await q.settle();
  q.click(`[data-card=${b}]`); await q.settle();
  expect(q.root.querySelector(`[data-card=${a}] dl`)).toBeNull();
  expect(q.root.querySelector(`[data-card=${b}] dl`)).not.toBeNull();
  expect(c).toBeDefined();
});

// A statement by the person: made by a human actor, as the server writes it.
const analyst = { kind: "human" as const, id: "analyst" };
async function plantStatement(q: Page, body: string, over: Partial<NonNullable<Card["person"]>> = {}): Promise<string> {
  let made = "";
  q.s.app.hub.read("CASE-1").commit((_s, ids) => {
    made = ids.next("card");
    const c = card("x", { id: made, title: "Statement: the TV", body, kind: "note", made_by: "human", columns: [], column_types: [], rows: [], row_count: 0, coverage: null, empty: null, why: "did it myself: I installed it", marking: "TLP:AMBER",
      person: { basis: "did", detail: "I installed it", about: [{ type: "address", value: "192.0.2.17" }], answers: null, ...over } });
    return [{ type: "card.created", actor: analyst, payload: { card: c } }];
  });
  await q.settle();
  return made;
}
const dlOf = (q: Page, id: string): Map<string, string> => {
  const m = new Map<string, string>();
  for (const dt of q.all(`[data-card=${id}] dt`)) m.set(dt.textContent!, dt.nextElementSibling!.textContent!);
  return m;
};

test("a statement card is tagged as the person's statement, and its record says how they know and what it is about", async () => {
  const q = await open();
  const id = await plantStatement(q, "The device at 192.0.2.17 is the meeting-room TV.");
  q.click(`[data-card=${id}] .card-head`);
  await q.settle();
  const tagTexts = [...q.q(`[data-card=${id}]`).querySelectorAll(".tag")].map((t) => t.textContent);
  expect(tagTexts).toContain("your statement");
  expect(tagTexts).not.toContain("nothing found");
  const dl = dlOf(q, id);
  expect(dl.get("Source")).toBe("the person: a statement, not data from a source");
  expect(dl.get("How they know")).toBe("did it myself: I installed it");
  expect(dl.get("About")).toBe("address 192.0.2.17");
  expect([...dl.keys()]).toEqual(["Source", "How they know", "About", "Marking", "When"]);
});

test("an answer card names the question it answers", async () => {
  const q = await open();
  const id = await plantStatement(q, "It is the lobby TV.", { answers: "ask-1" });
  q.click(`[data-card=${id}] .card-head`);
  await q.settle();
  expect(dlOf(q, id).get("Answers")).toBe("ask-1");
});

test("a statement that looks like markup is drawn as text", async () => {
  const q = await open();
  const id = await plantStatement(q, "<img src=x onerror=1>");
  expect(q.q(`[data-card=${id}]`).querySelector("img")).toBeNull();
  expect(q.q(`[data-card=${id}] .body`).textContent).toBe("<img src=x onerror=1>");
});

test("a statement card has no Verify and no Pivot from rows; Keep and Discard work as for any card", async () => {
  const q = await open();
  const id = await plantStatement(q, "The TV is in the lobby.");
  q.click(`[data-card=${id}] .card-head`);
  await q.settle();
  expect(q.all(`[data-card=${id}] [data-action=verify]`).length).toBe(0);
  expect(q.all(`[data-card=${id}] .chip.value`).length).toBe(0);
  expect(q.all(`[data-card=${id}] .actions [data-action=cite]`).length).toBe(1);
  q.click(`[data-card=${id}] [data-action=keep]`);
  await q.settle();
  expect(state(q).cards[id]!.place).toBe("lane");
  q.click(`[data-card=${id}] [data-action=discard]`);
  await q.settle();
  expect(state(q).cards[id]!.place).toBe("discarded");
});
