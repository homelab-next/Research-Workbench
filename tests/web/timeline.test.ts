import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { makeTimeline, timelineScale, TIMELINE_ROWS } from "../../src/web/lenses/timeline";
import type { View } from "../../src/web/ui";
import { CaseStore } from "../../src/web/store";
import type { Card, Observed, Payloads, Sighting } from "../../src/core/types";
import { EntryBuilder, card } from "../helpers/entries";
import { page, testUi } from "../helpers/dom";
import type { Page } from "../helpers/dom";

const T = (day: number, hh = 0): string => `2026-11-${String(day).padStart(2, "0")}T${String(hh).padStart(2, "0")}:00:00.000Z`;
const sight = (type: string, value: string, first: string | null, last: string | null, count: number | null = null, points: [string, number][] = []): Sighting => ({ type, value, first, last, count, points });
const obs = (pivot: string, from: { type: string; value: string }, span: Observed["span"], found: Sighting[], unread = 0): Observed => ({ pivot, from, span, found, more: 0, unread });
const ADDR = { type: "address", value: "198.51.100.77" };
const DOM = { type: "domain", value: "a.example.com" };
const C1 = obs("address_to_domains", ADDR, { first: T(17, 1), last: T(19, 5), count: 7 }, [sight("domain", "a.example.com", T(17, 1), T(19, 5), 7, [[T(17, 2), 2], [T(18, 2), 1]])]);
const C2 = obs("domain_to_clients", DOM, { first: T(18), last: T(20), count: 5 }, [sight("address", "192.0.2.17", T(18), T(20), 5)]);

const win = new Window({ url: "http://127.0.0.1:1/" });
afterEach(() => { win.document.body.innerHTML = ""; });

interface Rig { store: CaseStore; v: View; calls: unknown[][]; b: EntryBuilder; push(): void }
function rig(cards: [string, Partial<Card>][], window: Payloads["case.created"]["window"] = { from: null, to: null }, ref?: Partial<Parameters<typeof testUi>[1]>): Rig {
  const store = new CaseStore("CASE-1");
  const b = new EntryBuilder("CASE-1");
  b.add("case.created", { id: "CASE-1", title: "t", asked: "a", why: "w", starting: [], window, objective: null, marking: "TLP:AMBER" });
  for (const [id, over] of cards) b.add("card.created", { card: card(id, over) });
  let pushed = 0;
  const push = (): void => { for (; pushed < b.entries.length; pushed++) store.push(b.entries[pushed]!); };
  push();
  const calls: unknown[][] = [];
  const nav = new Proxy({}, { get: (_t, name) => (...a: unknown[]) => { calls.push([name as string, ...a]); } }) as never;
  const ui = testUi(win, { ref: { types: [{ id: "address", title: "Address" }, { id: "domain", title: "Domain" }], sources: [], pivots: [
    { id: "address_to_domains", title: "Names that resolved to the address", from: "address", to: "domain", source: "s", free: true, weight: 0, needs_window: false, empty_means: "not-seen", inventory: null },
    { id: "domain_to_clients", title: "Clients that looked the name up", from: "domain", to: "address", source: "s", free: true, weight: 0, needs_window: false, empty_means: "not-seen", inventory: null }],
  objectives: [], phases: [], profile: { id: "p", title: "p" }, send_back_cap: 3, playbooks: [], inventories: [], likelihood: [], stage_tools: [], stage_models: [], case_types: [] }, ...ref });
  const v = makeTimeline(ui, { store, nav });
  win.document.body.append(v.el as never);
  v.update();
  return { store, v, calls, b, push };
}
const q = (r: Rig, sel: string): HTMLElement => r.v.el.querySelector(sel) as HTMLElement;
const all = (r: Rig, sel: string): HTMLElement[] => [...r.v.el.querySelectorAll(sel)] as HTMLElement[];
const rows = (r: Rig) => all(r, ".tl-row");
const click = (el: Element): void => { el.dispatchEvent(new win.Event("click", { bubbles: true }) as never); };
const two = (): Rig => rig([["c1", { observed: C1 }], ["c2", { observed: C2 }]]);

test("a row per value: a button with the type and value, and a strip with a mark per card", () => {
  const r = two();
  expect(rows(r).map((x) => x.querySelector(".tl-label")!.textContent)).toEqual(["Address 198.51.100.77", "Domain a.example.com", "Address 192.0.2.17"]);
  const strip = rows(r)[1]!.querySelector("svg.tl-strip")!;
  expect(strip.namespaceURI).toBe("http://www.w3.org/2000/svg");
  expect(strip.getAttribute("viewBox")).toBe("0 0 1000 20");
  expect([...strip.querySelectorAll("g.tl-mark")].map((g) => g.getAttribute("data-card"))).toEqual(["c1", "c2"]);
});

test("a span is a bar from first to last, never narrower than 4; points are bars as tall as their share of the row's largest count", () => {
  const r = two();
  const scale = timelineScale({ from: T(17, 1), to: T(20) });
  const sub = rows(r)[1]!.querySelector("g[data-card=c2] rect.tl-span")!;
  expect(Number(sub.getAttribute("x"))).toBeCloseTo(scale(T(18)), 1);
  expect(Number(sub.getAttribute("width"))).toBeCloseTo(scale(T(20)) - scale(T(18)), 1);
  const instant = rows(r)[0]!.querySelector("rect.tl-span")!;
  expect(Number(instant.getAttribute("width"))).toBeGreaterThanOrEqual(4);
  const pointBars = [...rows(r)[1]!.querySelectorAll("g[data-card=c1] rect.tl-point")];
  expect(pointBars.map((b) => Number(b.getAttribute("height")))).toEqual([18, 9]);
  expect(pointBars.every((b) => Number(b.getAttribute("width")) >= 4)).toBe(true);
});

test("the case window is shaded on every strip", () => {
  const r = rig([["c1", { observed: C1 }], ["c2", { observed: C2 }]], { from: T(18), to: T(19) });
  const scale = timelineScale({ from: T(17, 1), to: T(20) });
  for (const row of rows(r)) {
    const w = row.querySelector("rect.tl-window")!;
    expect(Number(w.getAttribute("x"))).toBeCloseTo(scale(T(18)), 1);
    expect(Number(w.getAttribute("width"))).toBeCloseTo(scale(T(19)) - scale(T(18)), 1);
  }
});

test("a click on a mark opens its card", () => {
  const r = two();
  click(rows(r)[1]!.querySelector("g[data-card=c2]")!);
  expect(r.calls).toEqual([["focusCard", "c2"]]);
});

test("Enter on the row's button opens its detail: a line per mark with the card's chip, its role, the pivot's title, its times and its count", () => {
  const r = two();
  const row = (): HTMLElement => rows(r)[1]!;
  const button = (): Element => row().querySelector(".tl-label")!;
  const detail = (): HTMLElement[] => [...row().querySelectorAll(".tl-detail li")] as HTMLElement[];
  expect((row().querySelector(".tl-detail") as HTMLElement).hidden).toBe(true);
  click(button());
  expect(detail().map((li) => li.textContent)).toEqual([
    "c1 · found by Names that resolved to the address · 2026-11-17T01:00:00.000Z → 2026-11-19T05:00:00.000Z · 7 events",
    "c2 · subject of Clients that looked the name up · 2026-11-18T00:00:00.000Z → 2026-11-20T00:00:00.000Z · 5 events",
  ]);
  click(detail()[0]!.querySelector(".card-chip")!);
  expect(r.calls).toEqual([["focusCard", "c1"]]);
  expect(button().getAttribute("aria-expanded")).toBe("true");
  expect((row().querySelector(".tl-detail") as HTMLElement).hidden).toBe(false);
  expect(row().querySelector("g[data-card=c1] title")!.textContent).toBe(detail()[0]!.textContent!);
});

test("a pivot the reference no longer names reads by its id, and a count of one reads 1 event", () => {
  const one = obs("gone_pivot", ADDR, { first: T(17), last: T(17), count: 1 }, []);
  const r = rig([["c1", { observed: one }]]);
  click(q(r, ".tl-label"));
  expect(q(r, ".tl-detail li").textContent).toBe(`c1 · subject of gone_pivot · ${T(17)} → ${T(17)} · 1 event`);
});

test("unticking a type hides its rows", () => {
  const r = two();
  (r.v.el.querySelector("[aria-label='Address']") as HTMLElement).click();
  expect(rows(r).map((x) => x.querySelector(".tl-label")!.textContent)).toEqual(["Domain a.example.com"]);
  (r.v.el.querySelector("[aria-label='Address']") as HTMLElement).click();
  expect(rows(r).length).toBe(3);
});

test("the header shows the two ends of the axis in UTC", () => {
  expect(q(two(), ".tl-axis").textContent).toBe(`${T(17, 1)} → ${T(20)}`);
});

test("the first 200 rows are drawn and a line says how many more", () => {
  const many = obs("p", ADDR, { first: null, last: null, count: null },
    Array.from({ length: 100 }, (_, i) => sight("domain", `h${i}.example.com`, T(17), T(17))));
  const more = obs("p", DOM, { first: null, last: null, count: null },
    Array.from({ length: 100 }, (_, i) => sight("domain", `k${i}.example.com`, T(18), T(18))));
  const third = obs("p", DOM, { first: null, last: null, count: null },
    Array.from({ length: 37 }, (_, i) => sight("domain", `m${i}.example.com`, T(19), T(19))));
  const r = rig([["c1", { observed: many }], ["c2", { observed: more }], ["c3", { observed: third }]]);
  expect(rows(r).length).toBe(TIMELINE_ROWS);
  expect(q(r, ".tl-more").textContent).toBe("37 more values: narrow by type.");
});

test("the honest lines appear only when true", () => {
  const clean = two();
  expect([".tl-untimed", ".tl-unread", ".tl-legacy"].map((s) => q(clean, s))).toEqual([null as never, null as never, null as never]);
  const o1 = obs("p", ADDR, { first: T(17), last: T(17), count: 1 }, [sight("domain", "x.example.com", null, null), sight("domain", "y.example.com", null, null)], 2);
  const o2 = obs("p", DOM, { first: null, last: null, count: null }, [], 1);
  const r = rig([["c1", { observed: o1 }], ["c2", { observed: o2 }]]);
  expect(q(r, ".tl-untimed").textContent).toBe("3 values have no observed time (their pivots declare none); they are in the Graph.");
  expect(q(r, ".tl-unread").textContent).toBe("3 rows had a time that could not be read.");
  const one = rig([["c1", { observed: obs("p", ADDR, { first: T(17), last: T(17), count: 1 }, [sight("domain", "x.example.com", null, null)], 1) }]]);
  expect(q(one, ".tl-untimed").textContent).toBe("1 value has no observed time (its pivot declares none); it is in the Graph.");
  expect(q(one, ".tl-unread").textContent).toBe("1 row had a time that could not be read.");
  const more = rig([["c1", { observed: one.store.shown.cards.c1!.observed! }]]);
  expect(more.v.el.querySelector(".tl-more")!.hasAttribute("hidden")).toBe(true);
});

test("the legacy line", () => {
  const b = new EntryBuilder("CASE-1");
  b.add("case.created", { id: "CASE-1", title: "t", asked: "a", why: "w", starting: [ADDR], window: { from: null, to: null }, objective: null, marking: "TLP:AMBER" });
  b.add("query.issued", { query: "q1", source: "s", source_hash: "h", pivot: "address_to_domains", pivot_hash: "ph", connector: "files", text: "t", bound: { value: ADDR.value } as never, window: { from: null, to: null }, why: "w", estimate: null, step: null, verifies: null, purpose: "result" });
  b.add("query.result", { query: "q1", result: { blob: "0".repeat(64), bytes: 1 }, rows: 1, rows_hash: "r", coverage: { kind: "full" }, duration_ms: 1, cost: null });
  b.add("card.created", { card: card("c1", { query: "q1", columns: ["n"], column_types: ["domain"], rows: [["z.example.com"]], row_count: 1 }) });
  const r = rig([]);
  for (const e of b.entries.slice(1)) r.store.push({ ...e, seq: r.store.entries.length + 1 } as never);
  r.v.update();
  expect(q(r, ".tl-legacy").textContent).toBe("Some cards were recorded before times were; their values are in the Graph only.");
});

test("with nothing observed it says so, at entry 0 and in a replay to before the first card", () => {
  const r = rig([["c1", { observed: C1 }]]);
  expect(q(r, ".empty").hasAttribute("hidden")).toBe(true);
  r.store.goTo(1); r.v.update();
  expect(q(r, ".empty").textContent).toBe("No card carries an observed time yet. A pivot gives one when its manifest declares times.");
  expect(q(r, ".empty").hasAttribute("hidden")).toBe(false);
  expect(rows(r)).toEqual([]);
  r.store.goTo(null); r.v.update();
  expect(rows(r).length).toBe(2);
  const none = rig([]);
  expect(q(none, ".empty").hasAttribute("hidden")).toBe(false);
});

test("a value that looks like markup is text, and a long one is cut in the label and whole in its title", () => {
  const long = "x".repeat(300);
  const o = obs("p", ADDR, { first: T(17), last: T(17), count: 1 }, [sight("domain", "<img src=x onerror=1>", T(17), T(17)), sight("domain", long, T(18), T(18))]);
  const r = rig([["c1", { observed: o }]]);
  expect(r.v.el.querySelector("img")).toBeNull();
  const labels = all(r, ".tl-label");
  expect(labels.some((l) => l.textContent!.includes("<img src=x onerror=1>"))).toBe(true);
  const l = labels.find((x) => x.getAttribute("title")!.length > 300)!;
  expect(l.textContent!.length).toBeLessThan(80);
});

test("everything at one instant, with an open-ended window, still draws a mark 4 wide", () => {
  const r = rig([["c1", { observed: obs("p", ADDR, { first: T(17), last: T(17), count: 1 }, []) }]], { from: null, to: null });
  const bar = q(r, "rect.tl-span");
  expect(Number(bar.getAttribute("width"))).toBe(4);
  const scale = timelineScale({ from: T(17), to: T(17) });
  expect(scale(T(17))).toBe(500);
});

test("the scale: 0..1000 over the axis, an axis of no width widened by 30 minutes each side", () => {
  const sc = timelineScale({ from: T(17), to: T(18) });
  expect([sc(T(17)), sc(T(18))]).toEqual([0, 1000]);
  expect(timelineScale({ from: T(17), to: T(17) })(T(17))).toBe(500);
});

test("it repaints when a card arrives", () => {
  const r = rig([["c1", { observed: C1 }]]);
  expect(rows(r).length).toBe(2);
  r.b.add("card.created", { card: card("c2", { observed: C2 }) });
  r.push(); r.v.update();
  expect(rows(r).length).toBe(3);
});

let p: Page;
test("on a real page, T opens the Timeline with rows and the shelf reads Timeline T", async () => {
  p = await page();
  try {
    const id = await p.s.newCase();
    await p.s.toPublishGate(id);
    p.win.location.hash = `#/case/${id}`;
    await p.settle();
    expect(p.q('.shelf [data-lens="timeline"]').textContent).toBe("Timeline T");
    p.press("t");
    expect(p.all(".lens .tl-row").length).toBeGreaterThan(0);
    expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]);
  } finally { await p.close(); }
});

const active = (): Element | null => win.document.activeElement as unknown as Element | null;

test("a focused control keeps the focus when a card arrives: a row's card chip, a row's button, a type's checkbox", () => {
  const r = rig([["c1", { observed: C1 }]]);
  const row = (key: string): HTMLElement => q(r, `.tl-row[data-key="${key}"]`);
  click(row("domain|a.example.com").querySelector(".tl-label")!);
  (row("domain|a.example.com").querySelector(".tl-detail .card-chip") as HTMLElement).focus();
  r.b.add("card.created", { card: card("c2", { observed: C2 }) }); r.push(); r.v.update();
  expect(rows(r).length).toBe(3);
  expect(r.v.el.contains(active())).toBe(true);
  expect(active()!.classList.contains("card-chip")).toBe(true);
  expect(active()!.textContent).toBe("c1");
  expect(active()!.closest(".tl-row")!.getAttribute("data-key")).toBe("domain|a.example.com");
  expect(row("domain|a.example.com").querySelectorAll(".tl-detail li").length).toBe(2);

  (row("address|198.51.100.77").querySelector(".tl-label") as HTMLElement).focus();
  r.b.add("card.created", { card: card("c3", { observed: obs("address_to_domains", ADDR, { first: T(16), last: T(16), count: 1 }, []) }) }); r.push(); r.v.update();
  expect(active()!.classList.contains("tl-label")).toBe(true);
  expect(active()!.closest(".tl-row")!.getAttribute("data-key")).toBe("address|198.51.100.77");

  (q(r, "[aria-label='Domain']")).focus();
  r.b.add("card.created", { card: card("c4", { observed: obs("p", { type: "domain", value: "b.example.com" }, { first: T(18), last: T(18), count: 1 }, []) }) }); r.push(); r.v.update();
  expect(active()!.getAttribute("aria-label")).toBe("Domain");
});

test("an entry that changes nothing the Timeline reads repaints nothing; a card repaints only the rows it changes", () => {
  const untimed = obs("p", DOM, { first: null, last: null, count: null }, [sight("domain", "u.example.com", null, null)]);
  const r = rig([["c1", { observed: C1 }], ["c2", { observed: C2 }], ["c0", { observed: untimed }]]);
  click(rows(r)[1]!.querySelector(".tl-label")!);
  const before = rows(r);
  const strips = all(r, "svg.tl-strip");
  const noteEl = q(r, ".tl-untimed");
  r.b.add("lane.created", { lane: "L1", title: "a lane", subgoal: null }); r.push(); r.v.update();
  expect(r.store.shown.skipped).toEqual([]);
  expect(rows(r).length).toBe(before.length);
  expect(rows(r).every((x, i) => x === before[i])).toBe(true);
  expect(all(r, "svg.tl-strip").every((x, i) => x === strips[i])).toBe(true);
  expect(q(r, ".tl-untimed") === noteEl).toBe(true);
  // a card inside the axis on a new value: the other rows keep their strips
  r.b.add("card.created", { card: card("c9", { observed: obs("p", { type: "domain", value: "n.example.com" }, { first: T(18), last: T(18), count: 1 }, []) }) }); r.push(); r.v.update();
  expect(rows(r).length).toBe(before.length + 1);
  for (const [i, row] of before.entries()) expect(row.querySelector("svg.tl-strip") === strips[i]).toBe(true);
});

test("a mark at the right end of the axis is drawn inside the strip", () => {
  const o = obs("p", ADDR, { first: T(17), last: T(18), count: 2 }, [sight("domain", "a.example.com", T(18), T(18), 1, [[T(18), 1]]), sight("domain", "b.example.com", T(18), T(18), 1)]);
  const r = rig([["c1", { observed: o }]]);
  const point = q(r, '.tl-row[data-key="domain|a.example.com"] rect.tl-point');
  expect([Number(point.getAttribute("x")), Number(point.getAttribute("width"))]).toEqual([996, 4]);
  const span = q(r, '.tl-row[data-key="domain|b.example.com"] rect.tl-span');
  expect([Number(span.getAttribute("x")), Number(span.getAttribute("width"))]).toEqual([996, 4]);
});
