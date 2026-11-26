import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { makeGraph } from "../../src/web/lenses/graph";
import type { View } from "../../src/web/ui";
import { CaseStore } from "../../src/web/store";
import type { Card, Observable, Observed, Sighting } from "../../src/core/types";
import { EntryBuilder, card } from "../helpers/entries";
import { page, testUi } from "../helpers/dom";
import type { Page } from "../helpers/dom";

const sight = (type: string, value: string): Sighting => ({ type, value, first: null, last: null, count: null, points: [] });
const obs = (pivot: string, from: Observable, found: Sighting[], more = 0): Observed => ({ pivot, from, span: { first: null, last: null, count: null }, found, more, unread: 0 });
const ADDR = { type: "address", value: "198.51.100.77" };
const DOM = { type: "domain", value: "a.example.com" };
const C1 = obs("address_to_domains", ADDR, [sight("domain", "a.example.com")]);
const C2 = obs("domain_to_clients", DOM, [sight("address", "192.0.2.17")]);
const WIN = { from: null, to: null };

const win = new Window({ url: "http://127.0.0.1:1/" });
afterEach(() => { win.document.body.innerHTML = ""; win.localStorage.clear(); });

const PIVOTS = [
  { id: "address_to_domains", title: "Names that resolved to the address", from: "address", to: "domain", source: "s", free: true, weight: 0, needs_window: false, empty_means: "not-seen", inventory: null },
  { id: "domain_to_clients", title: "Clients that looked the name up", from: "domain", to: "address", source: "s", free: true, weight: 0, needs_window: false, empty_means: "not-seen", inventory: null },
  { id: "asset_lookup", title: "Asset with the address", from: "address", to: "address", source: "s", free: true, weight: 0, needs_window: false, empty_means: "proven-negative", inventory: "hosts" },
  { id: "lease_lookup", title: "Lease of the address", from: "address", to: "address", source: "s", free: true, weight: 0, needs_window: false, empty_means: "not-seen", inventory: "leases" },
];
const REF = {
  types: [{ id: "address", title: "Address" }, { id: "domain", title: "Domain" }], sources: [], pivots: PIVOTS, objectives: [], phases: [], profile: { id: "p", title: "p" }, send_back_cap: 3, playbooks: [],
  inventories: [{ id: "hosts", title: "Hosts", holds: "asset", scope: "internal hosts", complete: true }, { id: "leases", title: "Leases", holds: "asset", scope: "leases", complete: false }],
};

interface Rig { store: CaseStore; v: View; calls: unknown[][]; b: EntryBuilder; push(): void; ui: ReturnType<typeof testUi> }
function rig(cards: [string, Partial<Card>][], starting: Observable[] = [ADDR], extra?: (b: EntryBuilder) => void): Rig {
  const store = new CaseStore("CASE-1");
  const b = new EntryBuilder("CASE-1");
  b.add("case.created", { id: "CASE-1", title: "t", asked: "a", why: "w", starting, window: WIN, objective: null, marking: "TLP:AMBER" });
  for (const [id, over] of cards) b.add("card.created", { card: card(id, over) });
  extra?.(b);
  let pushed = 0;
  const push = (): void => { for (; pushed < b.entries.length; pushed++) store.push(b.entries[pushed]!); };
  push();
  const calls: unknown[][] = [];
  const nav = new Proxy({}, { get: (_t, name) => (...a: unknown[]) => { calls.push([name as string, ...a]); } }) as never;
  const ui = testUi(win, { ref: REF as never });
  const v = makeGraph(ui, { store, nav });
  win.document.body.append(v.el as never);
  v.update();
  return { store, v, calls, b, push, ui };
}
const q = (r: Rig, sel: string): HTMLElement => r.v.el.querySelector(sel) as HTMLElement;
const all = (r: Rig, sel: string): HTMLElement[] => [...r.v.el.querySelectorAll(sel)] as HTMLElement[];
const node = (r: Rig, key: string): HTMLElement => q(r, `g.node[data-key="${key}"]`);
const click = (el: Element): void => { el.dispatchEvent(new win.Event("click", { bubbles: true }) as never); };
const key = (el: Element, k: string): void => { el.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true }) as never); };
const two = (): Rig => rig([["c1", { observed: C1 }], ["c2", { observed: C2 }]]);
const detail = (r: Rig): HTMLElement => q(r, ".graph-detail");

/** A finished "does it belong?" run on ADDR: its lookups, and the cards that say what an empty one proves. */
const belongs = (lookups: { outcome: "answered" | "empty" | "failed"; card: string | null; pivot?: string }[], job = "job-1") => (b: EntryBuilder): void => {
  b.add("playbook.started", { job, playbook: "does-it-belong", playbook_hash: "h", title: "Does it belong?", inputs: [ADDR], window: WIN, why: "w", plan_step: null, steps: lookups.map((l, i) => ({ id: `s${i}`, pivot: l.pivot ?? "asset_lookup", pivot_hash: "h" })) });
  lookups.forEach((l, i) => b.add("playbook.step", { job, step: `s${i}`, pivot: l.pivot ?? "asset_lookup", status: "ran", reason: "", lookups: [{ value: ADDR.value, outcome: l.outcome, rows: l.outcome === "answered" ? 1 : 0, query: "q1", card: l.card, reused: false, detail: "" }], found: [], left: 0 }));
  b.add("playbook.finished", { job, outcome: "empty", end_step: null, cards: [], end_cards: [], caveats: [], lookups: lookups.length, reused: 0 });
};
const proven = (id: string): [string, Partial<Card>] => [id, { empty: "proven-negative", rows: [], row_count: 0 }];
const unseen = (id: string): [string, Partial<Card>] => [id, { empty: "not-seen", rows: [], row_count: 0 }];

test("a node per value with its type's title and its value, placed where the layout says", () => {
  const r = two();
  const n = node(r, "domain|a.example.com");
  expect(n.getAttribute("role")).toBe("button"); expect(n.getAttribute("transform")).toBe("translate(262 12)");
  expect([...n.querySelectorAll("text")].map((t) => t.textContent)).toEqual(["Domain", "a.example.com"]);
  expect(n.getAttribute("aria-label")).toBe("Domain a.example.com, 2 cards");
  expect(node(r, "address|198.51.100.77").getAttribute("aria-label")).toBe("Address 198.51.100.77, 1 card");
  const svg = q(r, "svg");
  expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(svg.getAttribute("viewBox")).toBe(`0 0 ${svg.getAttribute("width")} ${svg.getAttribute("height")}`);
  expect(n.querySelector("rect")!.getAttribute("rx")).toBe("6");
  expect(["t0", "t1"].map((c) => node(r, "address|198.51.100.77").classList.contains(c))).toEqual([true, false]);
  expect(n.classList.contains("t1")).toBe(true);
  expect(node(r, "address|198.51.100.77").classList.contains("starting")).toBe(true);
});

test("an edge is a path between its two nodes with a tooltip naming the pivot and the cards", () => {
  const r = two();
  const edges = all(r, "g.edge");
  expect(edges.length).toBe(2);
  const edge = edges[0]!;
  expect(edge.querySelector("path")!.getAttribute("d")!.startsWith("M ")).toBe(true);
  expect(edge.querySelector("circle.edge-end")!.getAttribute("r")).toBe("3");
  expect(edge.querySelector("title")!.textContent).toBe("Names that resolved to the address · c1");
});

test("selecting a node fills the detail: its cards, its links both ways, Pivot… and Focus", () => {
  const r = two();
  expect(detail(r).querySelector("h3")).toBeNull();
  click(node(r, "domain|a.example.com"));
  expect(node(r, "domain|a.example.com").classList.contains("selected")).toBe(true);
  expect(detail(r).querySelector("h3")!.textContent).toBe("Domain a.example.com");
  expect([...detail(r).querySelectorAll(".node-cards .card-chip")].map((b) => b.textContent)).toEqual(["c1", "c2"]);
  expect([...detail(r).querySelectorAll(".node-links li")].map((li) => li.textContent)).toEqual([
    "← Address 198.51.100.77 · Names that resolved to the address · c1", "→ Address 192.0.2.17 · Clients that looked the name up · c2",
  ]);
  click(detail(r).querySelector('[data-action="pivot"]')!);
  expect(r.calls).toEqual([["pivot", "c2", [{ type: "domain", value: "a.example.com" }]]]);
  expect(detail(r).querySelector('[data-action="focus-self"]')!.textContent).toBe("Focus on this value");
});

test("the selected node's edges carry the pivot's title as a label; no other edge does", () => {
  const r = two();
  expect(all(r, "text.edge-label")).toEqual([]);
  click(node(r, "address|198.51.100.77"));
  expect(all(r, "text.edge-label").map((t) => t.textContent)).toEqual(["Names that resolved to the address"]);
  click(node(r, "domain|a.example.com"));
  expect(all(r, "text.edge-label").map((t) => t.textContent)).toEqual(["Names that resolved to the address", "Clients that looked the name up"]);
});

test("a card chip opens the card; a linked value's button focuses the graph on it", () => {
  const r = rig([["c1", { observed: C1 }], ["c2", { observed: C2 }]], [ADDR, { type: "domain", value: "lone.example.com" }]);
  expect(q(r, ".graph-count").textContent).toBe("Showing 4 of 4 values");
  expect(q(r, ".graph-whole").hasAttribute("hidden")).toBe(true);
  click(node(r, "domain|a.example.com"));
  click(detail(r).querySelector(".node-cards .card-chip")!);
  expect(r.calls).toEqual([["focusCard", "c1"]]);
  click(detail(r).querySelector('.node-links [data-action="focus"]')!);
  expect(q(r, ".graph-count").textContent).toBe("Showing 3 of 4 values");
  expect(detail(r).querySelector("h3")!.textContent).toBe("Address 198.51.100.77");
  expect(node(r, "domain|lone.example.com")).toBeNull();
  click(q(r, ".graph-whole"));
  expect(q(r, ".graph-count").textContent).toBe("Showing 4 of 4 values");
  expect(q(r, ".graph-whole").hasAttribute("hidden")).toBe(true);
});

test("the drawing is one tab stop; arrows move between nodes in layout order; Enter selects", () => {
  const r = two();
  const doc = win.document;
  const stops = (): number => all(r, "g.node").filter((n) => n.getAttribute("tabindex") === "0").length;
  expect(stops()).toBe(1);
  key(node(r, "address|198.51.100.77"), "ArrowRight"); expect(doc.activeElement?.getAttribute("data-key")).toBe("domain|a.example.com");
  expect(stops()).toBe(1);
  key(doc.activeElement as never, "ArrowLeft"); expect(doc.activeElement?.getAttribute("data-key")).toBe("address|198.51.100.77");
  key(doc.activeElement as never, "ArrowDown"); key(doc.activeElement as never, "ArrowUp"); expect(doc.activeElement?.getAttribute("data-key")).toBe("address|198.51.100.77");
  key(doc.activeElement as never, "End"); expect(doc.activeElement?.getAttribute("data-key")).toBe("address|192.0.2.17");
  key(doc.activeElement as never, "Home"); expect(doc.activeElement?.getAttribute("data-key")).toBe("address|198.51.100.77");
  key(doc.activeElement as never, "End"); key(doc.activeElement as never, "Enter");
  expect(detail(r).querySelector("h3")!.textContent).toBe("Address 192.0.2.17");
  expect(doc.activeElement?.getAttribute("data-key")).toBe("address|192.0.2.17");
  key(node(r, "address|198.51.100.77"), " ");
  expect(detail(r).querySelector("h3")!.textContent).toBe("Address 198.51.100.77");
});

test("a value 'does it belong?' has finished on carries its verdict, in a glyph and in words", () => {
  const r = rig([proven("cp")], [ADDR], belongs([{ outcome: "empty", card: "cp" }]));
  const n = node(r, "address|198.51.100.77");
  expect(n.querySelector("text.belongs")!.textContent).toBe("✗"); expect(n.classList.contains("belongs-proven")).toBe(true);
  expect(n.getAttribute("aria-label")).toBe("Address 198.51.100.77, 0 cards, Not a known asset: proven for internal hosts");
  click(n);
  expect(detail(r).querySelector(".belongs-verdict")!.textContent).toBe("Not a known asset: proven for internal hosts");
});

test("the four verdicts have four glyph-and-class pairs", () => {
  const verdict = (cards: [string, Partial<Card>][], lookups: Parameters<typeof belongs>[0]): [string, string] => {
    const n = node(rig(cards, [ADDR], belongs(lookups)), "address|198.51.100.77");
    return [n.querySelector("text.belongs")!.textContent!, [...n.classList].filter((c) => c.startsWith("belongs-")).join(" ")];
  };
  expect(verdict([], [{ outcome: "answered", card: null }])).toEqual(["✓", "belongs-known"]);
  expect(verdict([proven("cp")], [{ outcome: "empty", card: "cp" }])).toEqual(["✗", "belongs-proven"]);
  expect(verdict([unseen("cu")], [{ outcome: "empty", card: "cu", pivot: "lease_lookup" }])).toEqual(["?", "belongs-not-seen"]);
  expect(verdict([], [{ outcome: "failed", card: null }])).toEqual(["?", "belongs-unknown"]);
});

test("a type's checkbox hides its nodes and their edges", () => {
  const r = two();
  (r.v.el.querySelector("[aria-label='Domain']") as HTMLElement).click();
  expect(all(r, "g.node").map((n) => n.getAttribute("data-key"))).toEqual(["address|198.51.100.77", "address|192.0.2.17"]);
  expect(all(r, "g.edge")).toEqual([]);
  expect(q(r, ".graph-count").textContent).toBe("Showing 2 of 2 values");
  (r.v.el.querySelector("[aria-label='Domain']") as HTMLElement).click();
  expect(all(r, "g.node").length).toBe(3);
});

const hub = (extra = 0): Rig => rig([["c1", { observed: obs("address_to_domains", { type: "address", value: "hub" }, Array.from({ length: 30 }, (_, i) => sight("domain", `h${String(i).padStart(2, "0")}.example.com`)), extra) }]], [{ type: "address", value: "hub" }]);

test("a hub shows 12 of its neighbours and a +N badge; its detail lists every link", () => {
  const r = hub();
  expect(node(r, "address|hub").querySelector("text.more")!.textContent).toBe("+18");
  expect(node(r, "address|hub").getAttribute("aria-label")).toBe("Address hub, 1 card, 18 more linked values not drawn");
  expect(q(r, ".graph-count").textContent).toBe("Showing 13 of 31 values");
  click(node(r, "address|hub")); expect(detail(r).querySelectorAll(".node-links li").length).toBe(30);
});

test("a node whose cards hold more values than they list says so", () => {
  const r = hub(30);
  click(node(r, "address|hub"));
  expect(detail(r).querySelector(".node-more")!.textContent).toBe("Its cards hold 30 more values than they list.");
  const none = two(); click(node(none, "address|198.51.100.77"));
  expect(detail(none).querySelector(".node-more")).toBeNull();
});

test("docked right the layout is tall; docked at the bottom it is wide; a change of dock lays it out again", () => {
  const r = two();
  expect(node(r, "domain|a.example.com").getAttribute("transform")).toBe("translate(262 12)");
  r.ui.prefs.set("dock", "right"); r.v.update();
  expect(node(r, "domain|a.example.com").getAttribute("transform")).toBe("translate(36 46)");
  r.ui.prefs.set("dock", "bottom"); r.v.update();
  expect(node(r, "domain|a.example.com").getAttribute("transform")).toBe("translate(262 12)");
});

test("in replay Pivot… is disabled and says why; so it is for a starting value no card holds", () => {
  const r = rig([["c1", { observed: C1 }]], [ADDR, { type: "domain", value: "lone.example.com" }]);
  click(node(r, "domain|lone.example.com"));
  const pivot = (): HTMLButtonElement => detail(r).querySelector('[data-action="pivot"]') as HTMLButtonElement;
  expect(pivot().disabled).toBe(true); expect(pivot().title).toBe("No card holds this value yet");
  click(node(r, "domain|a.example.com"));
  expect(pivot().disabled).toBe(false);
  r.store.goTo(r.store.live.seq); r.v.update();
  expect(pivot().disabled).toBe(true); expect(pivot().title).toBe("Return to live to pivot");
  click(pivot()); expect(r.calls).toEqual([]);
});

test("with no card the starting values are drawn and a line says nothing links them; at entry 0 there is only the line", () => {
  const r = rig([]);
  expect(q(r, ".empty").textContent).toBe("No lookup has linked these yet.");
  expect(all(r, "g.node").length).toBe(1);
  const full = two();
  expect(q(full, ".empty").hasAttribute("hidden")).toBe(true);
  full.store.goTo(0); full.v.update();
  expect(q(full, ".empty").textContent).toBe("No lookup has linked these yet.");
  expect(q(full, ".empty").hasAttribute("hidden")).toBe(false);
  expect(all(full, "g.node")).toEqual([]);
});

test("a case read the legacy way says so", () => {
  const b = new EntryBuilder("CASE-1");
  b.add("case.created", { id: "CASE-1", title: "t", asked: "a", why: "w", starting: [ADDR], window: WIN, objective: null, marking: "TLP:AMBER" });
  b.add("query.issued", { query: "q1", source: "s", source_hash: "h", pivot: "address_to_domains", pivot_hash: "ph", connector: "files", text: "t", bound: { value: ADDR.value } as never, window: WIN, why: "w", estimate: null, step: null, verifies: null, purpose: "result" });
  b.add("query.result", { query: "q1", result: { blob: "0".repeat(64), bytes: 1 }, rows: 1, rows_hash: "r", coverage: { kind: "full" }, duration_ms: 1, cost: null });
  b.add("card.created", { card: card("c1", { query: "q1", columns: ["n"], column_types: ["domain"], rows: [["z.example.com"]], row_count: 1 }) });
  const r = rig([]);
  for (const e of b.entries.slice(1)) r.store.push({ ...e, seq: r.store.entries.length + 1 } as never);
  r.v.update();
  expect(q(r, ".graph-legacy").textContent).toBe("Some cards were recorded before links were; their links are read from the first 50 rows.");
  expect(q(two(), ".graph-legacy")).toBeNull();
});

test("a value that looks like markup is text; a long one is cut in the node and whole in its name", () => {
  const long = "x".repeat(300);
  const r = rig([["c1", { observed: obs("address_to_domains", ADDR, [sight("domain", "<img src=x onerror=1>"), sight("domain", long)]) }]]);
  expect(r.v.el.querySelector("img")).toBeNull();
  const n = node(r, `domain|${long}`);
  expect(n.querySelector("text.node-value")!.textContent!.length).toBeLessThan(30);
  expect(n.getAttribute("aria-label")).toBe(`Domain ${long}, 1 card`);
  expect(n.querySelector("title")!.textContent).toContain(long);
  expect(node(r, "domain|<img src=x onerror=1>").querySelector("text.node-value")!.textContent).toBe("<img src=x onerror=1>");
});

test("the selection survives a new entry and is dropped when its node is gone", () => {
  const r = rig([["c1", { observed: C1 }]]);
  click(node(r, "domain|a.example.com"));
  r.b.add("card.created", { card: card("c2", { observed: C2 }) }); r.push(); r.v.update();
  expect(detail(r).querySelector("h3")!.textContent).toBe("Domain a.example.com");
  expect(node(r, "domain|a.example.com").classList.contains("selected")).toBe(true);
  expect([...detail(r).querySelectorAll(".node-cards .card-chip")].map((b) => b.textContent)).toEqual(["c1", "c2"]);
  r.store.goTo(1); r.v.update();
  expect(detail(r).querySelector("h3")).toBeNull();
});

let p: Page;
test("on a real page, G opens the Graph and the shelf reads Graph G", async () => {
  p = await page();
  try {
    const id = await p.s.newCase();
    await p.s.toPublishGate(id);
    p.win.location.hash = `#/case/${id}`;
    await p.settle();
    expect(p.q('.shelf [data-lens="graph"]').textContent).toBe("Graph G");
    p.press("g");
    expect(p.all(".lens-graph g.node").length).toBeGreaterThan(0);
    expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]);
  } finally { await p.close(); }
});

const active = (): Element | null => win.document.activeElement as unknown as Element | null;

test("unticking a type keeps the focus on its checkbox, not on the cursor's node", () => {
  const r = two();
  key(node(r, "address|198.51.100.77"), "Enter");
  const box = q(r, "[aria-label='Domain']") as HTMLInputElement;
  box.focus(); box.click();
  expect(all(r, "g.node").length).toBe(2);
  expect(active()!.getAttribute("aria-label")).toBe("Domain");
});

test("a focused button in the detail keeps the focus when a card arrives; a focused node stays focused", () => {
  const r = rig([["c1", { observed: C1 }]]);
  click(node(r, "domain|a.example.com"));
  (detail(r).querySelector(".node-cards .card-chip") as HTMLElement).focus();
  r.b.add("card.created", { card: card("c2", { observed: C2 }) }); r.push(); r.v.update();
  expect([...detail(r).querySelectorAll(".node-cards .card-chip")].map((b) => b.textContent)).toEqual(["c1", "c2"]);
  expect(detail(r).contains(active())).toBe(true);
  expect(active()!.textContent).toBe("c1");
  (detail(r).querySelector('[data-action="focus-self"]') as HTMLElement).focus();
  r.b.add("card.created", { card: card("c3", { observed: obs("p", DOM, [sight("address", "192.0.2.18")]) }) }); r.push(); r.v.update();
  expect(active()!.getAttribute("data-action")).toBe("focus-self");
  node(r, "address|192.0.2.17").focus();
  r.b.add("card.created", { card: card("c4", { observed: obs("p", DOM, [sight("address", "192.0.2.19")]) }) }); r.push(); r.v.update();
  expect(active()!.getAttribute("data-key")).toBe("address|192.0.2.17");
});

test("an entry that changes nothing the Graph reads repaints nothing", () => {
  const r = two();
  click(node(r, "domain|a.example.com"));
  const svg = q(r, "svg"), h3 = detail(r).querySelector("h3");
  r.b.add("lane.created", { lane: "L1", title: "a lane", subgoal: null }); r.push(); r.v.update();
  expect(r.store.shown.skipped).toEqual([]);
  expect(q(r, "svg") === svg).toBe(true);
  expect(detail(r).querySelector("h3") === h3).toBe(true);
});
