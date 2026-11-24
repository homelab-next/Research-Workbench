import { afterEach, expect, test } from "bun:test";
import { initial } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import { dropCommand, half } from "../../src/web/drag";
import type { DropTarget } from "../../src/web/drag";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";

let p: Page | null = null;
afterEach(async () => {
  if (p !== null) expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]);
  await p?.close();
  p = null;
});

const card = (id: string, place: string, lane: string | null) => ({ id, place, lane, title: id });
const state = {
  ...initial(),
  cards: { c1: card("c1", "incoming", null), c4: card("c4", "lane", "l1"), c5: card("c5", "lane", "l1"), c6: card("c6", "lane", "l1"), c9: card("c9", "discarded", null), c8: card("c8", "incoming", null) },
  incoming: ["c1", "c8"],
  lanes: [{ id: "l1", title: "One", subgoal: null, cards: ["c4", "c5", "c6"] }, { id: "l2", title: "Two", subgoal: null, cards: [] }],
} as unknown as CaseState;

test("the upper half drops above and the lower half below", () => {
  expect(half(109, { top: 100, height: 20 })).toBe("upper");
  expect(half(110, { top: 100, height: 20 })).toBe("lower");
});

test.each([
  ["Incoming card onto a lane", "c1", { kind: "lane", lane: "l2" }, { command: "keep", args: { card: "c1", lane: "l2" } }],
  ["Incoming card onto the upper half of the second card of l1", "c1", { kind: "card", card: "c5", half: "upper" }, { command: "keep", args: { card: "c1", lane: "l1", index: 1 } }],
  ["Incoming card onto the lower half of the second card of l1", "c1", { kind: "card", card: "c5", half: "lower" }, { command: "keep", args: { card: "c1", lane: "l1", index: 2 } }],
  ["lane card below a later card of its own lane", "c4", { kind: "card", card: "c6", half: "lower" }, { command: "move", args: { card: "c4", lane: "l1", index: 2 } }],
  ["lane card above an earlier card of its own lane", "c6", { kind: "card", card: "c4", half: "upper" }, { command: "move", args: { card: "c6", lane: "l1", index: 0 } }],
  ["lane card onto another lane", "c4", { kind: "lane", lane: "l2" }, { command: "move", args: { card: "c4", lane: "l2", index: 0 } }],
  ["lane card onto its own lane goes to the end", "c4", { kind: "lane", lane: "l1" }, { command: "move", args: { card: "c4", lane: "l1", index: 2 } }],
  ["lane card onto Incoming", "c4", { kind: "incoming" }, { command: "send_back", args: { card: "c4" } }],
  ["lane card onto an Incoming card", "c4", { kind: "card", card: "c8", half: "lower" }, { command: "send_back", args: { card: "c4" } }],
  ["a card onto itself", "c4", { kind: "card", card: "c4", half: "upper" }, null],
  ["a drop that leaves the card where it is", "c4", { kind: "card", card: "c5", half: "upper" }, null],
  ["Incoming card onto Incoming", "c1", { kind: "incoming" }, null],
  ["Incoming card onto an Incoming card", "c1", { kind: "card", card: "c8", half: "upper" }, null],
  ["onto a discarded card", "c1", { kind: "card", card: "c9", half: "upper" }, null],
  ["a discarded card", "c9", { kind: "lane", lane: "l1" }, null],
  ["a card that is not there", "zz", { kind: "lane", lane: "l1" }, null],
  ["a lane that is not there", "c1", { kind: "lane", lane: "nope" }, null],
  ["a Narrative section: Task 10 gives it a meaning", "c1", { kind: "cite", section: "summary" }, null],
])("%s", (_name, c, target, expected) => expect(dropCommand(state, c as string, target as DropTarget)).toEqual(expected));

const box = (el: Element, top: number, height = 40, left = 0, width = 200): void => {
  (el as unknown as { getBoundingClientRect(): unknown }).getBoundingClientRect = () => ({ top, height, left, width, bottom: top + height, right: left + width, x: left, y: top });
};
const ptr = (q: Page, type: string, target: Element | Document, x: number, y: number) =>
  target.dispatchEvent(new q.win.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }) as unknown as Event);
async function open(): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPublishGate(id);
  await seed(p, id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  return p;
}
/** Three cards kept: two in the first lane, one in the second. Three are left in Incoming. */
async function seed(q: Page, id: string): Promise<void> {
  const s = q.s.app.hub.read(id).state;
  const [a, b, c] = s.incoming;
  for (const [card, lane] of [[a, s.lanes[0]!.id], [b, s.lanes[0]!.id], [c, s.lanes[1]!.id]] as const) {
    const r = await q.s.command(id, "keep", { card, lane });
    if (r.status !== 200) throw new Error(JSON.stringify(r));
  }
  await q.s.app.hub.idle();
}
const st = (q: Page) => q.s.app.hub.read("CASE-1").state;
const under = (q: Page, el: Element | null): void => { (q.doc as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => el; };

test("a press that does not move is a click, not a drag", async () => {
  const q = await open();
  const c = q.q("[data-area=incoming] [data-card]");
  box(c, 100);
  ptr(q, "pointerdown", c, 10, 110); ptr(q, "pointermove", q.doc, 12, 112); ptr(q, "pointerup", q.doc, 12, 112);
  expect(q.doc.querySelector(".drop-line")).toBeNull();
  expect(c.classList.contains("dragging")).toBe(false);
  q.click(c);                                            // the click that follows still opens the card
  expect(c.classList.contains("open")).toBe(true);
  expect(st(q).cards[c.dataset.card!]!.place).toBe("incoming");
});

test("dragging a card onto a lane keeps it there", async () => {
  const q = await open();
  const lane = st(q).lanes[1]!.id;
  const c = q.q("[data-area=incoming] [data-card]");
  const id = c.dataset.card!;
  const laneEl = q.q(`.lane[data-lane=${lane}]`);
  box(c, 100); box(laneEl, 300, 200, 300, 300);
  under(q, laneEl);
  ptr(q, "pointerdown", c, 10, 110); ptr(q, "pointermove", q.doc, 10, 150);
  expect(c.classList.contains("dragging")).toBe(true);
  ptr(q, "pointerup", q.doc, 320, 350);
  q.click(c);                                            // the click that follows a drag does not open the card
  expect(c.classList.contains("open")).toBe(false);
  await q.settle();
  expect(st(q).cards[id]).toMatchObject({ place: "lane", lane });
  expect(q.doc.querySelector(".drop-line")).toBeNull();
  expect(q.root.querySelector(`[data-card=${id}]`)!.classList.contains("dragging")).toBe(false);
});

test("dropping on the upper half of a kept card puts the dragged card above it", async () => {
  const q = await open();
  const l = st(q).lanes.find((x) => x.cards.length > 0)!;
  const target = l.cards[0]!;
  const c = q.q("[data-area=incoming] [data-card]");
  const id = c.dataset.card!;
  const t = q.q(`[data-area=lanes] [data-card=${target}]`);
  box(c, 100); box(t, 300, 40, 300, 300);
  under(q, t);
  ptr(q, "pointerdown", c, 10, 110); ptr(q, "pointermove", q.doc, 100, 200);
  ptr(q, "pointermove", q.doc, 320, 305);
  const line = q.doc.querySelector(".drop-line") as HTMLElement;
  expect(line.style.getPropertyValue("top")).toBe("300px");
  ptr(q, "pointerup", q.doc, 320, 305);
  await q.settle();
  expect(st(q).lanes.find((x) => x.id === l.id)!.cards[0]).toBe(id);
});

test("a line shows where the card would land, and Escape cancels the drag", async () => {
  const q = await open();
  const lane = st(q).lanes[1]!.id;
  const c = q.q("[data-area=incoming] [data-card]");
  const laneEl = q.q(`.lane[data-lane=${lane}]`);
  box(c, 100); box(laneEl, 300, 200, 300, 300);
  under(q, laneEl);
  const before = q.s.entries("CASE-1").length;
  ptr(q, "pointerdown", c, 10, 110); ptr(q, "pointermove", q.doc, 320, 350);
  expect(q.doc.querySelector(".drop-line")).not.toBeNull();
  q.press("Escape");
  expect(q.doc.querySelector(".drop-line")).toBeNull();
  expect(c.classList.contains("dragging")).toBe(false);
  ptr(q, "pointerup", q.doc, 320, 350);
  await q.settle();
  expect(q.s.entries("CASE-1").length).toBe(before);
  expect(q.win.location.hash).toBe("#/case/CASE-1");       // Escape went to the drag, not up a level
});

test("dropping on Incoming sends a kept card back; no drop target means no command", async () => {
  const q = await open();
  const l = st(q).lanes.find((x) => x.cards.length > 0)!;
  const id = l.cards[0]!;
  const c = q.q(`[data-area=lanes] [data-card=${id}]`);
  const inc = q.q("[data-area=incoming]");
  box(c, 400); box(inc, 0, 600, 0, 200);
  under(q, null);
  ptr(q, "pointerdown", c, 310, 410); ptr(q, "pointermove", q.doc, 100, 200); ptr(q, "pointerup", q.doc, 100, 200);
  await q.settle();
  expect(st(q).cards[id]!.place).toBe("lane");
  under(q, inc);
  ptr(q, "pointerdown", c, 310, 410); ptr(q, "pointermove", q.doc, 100, 200); ptr(q, "pointerup", q.doc, 100, 200);
  await q.settle();
  expect(st(q).cards[id]!.place).toBe("incoming");
});

test("while replaying a drop changes nothing and says why", async () => {
  const q = await open();
  const lane = st(q).lanes[0]!.id;
  q.store()!.goTo(q.store()!.live.seq - 1); await q.settle();
  const c = q.q("[data-area=incoming] [data-card]");
  const laneEl = q.q(`.lane[data-lane=${lane}]`);
  box(c, 100); box(laneEl, 300);
  under(q, laneEl);
  const before = q.s.entries("CASE-1").length;
  ptr(q, "pointerdown", c, 10, 110); ptr(q, "pointermove", q.doc, 320, 350); ptr(q, "pointerup", q.doc, 320, 350);
  await q.settle();
  expect(q.s.entries("CASE-1").length).toBe(before);
  expect(q.toasts()).toContain("Return to live to change the case");
});
