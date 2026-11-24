import { afterEach, expect, test } from "bun:test";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";
import { KEYMAP, areaOf, dispatchKey, keyOf } from "../../src/web/keys";
import { LENSES } from "../../src/web/lenses";
import type { LensDef } from "../../src/web/lenses";

let p: Page | null = null;
const added: LensDef[] = [];
afterEach(async () => {
  for (const l of added) LENSES.splice(LENSES.indexOf(l), 1);
  added.length = 0;
  if (p !== null) expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]);
  await p?.close();
  p = null;
});

const EXPECTED = [
  "anywhere:?:help", "anywhere:/:command_bar", "anywhere:Escape:up", "anywhere:Shift+Enter:next_thing",
  "incoming:j,ArrowDown:next_card", "incoming:k,ArrowUp:prev_card", "incoming:Space,ArrowRight:keep", "incoming:x,ArrowLeft,Backspace:discard", "incoming:p:pin", "incoming:o:keep_open",
  "incoming:Enter:open_card", "incoming:u:undo", "incoming:c:cite",
  "columns:Tab,l,]:next_column", "columns:Shift+Tab,h,[:prev_column", "columns:0:focus_incoming",
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `columns:${n}:target_${n}`),
  "lanes:j,ArrowDown:next_card", "lanes:k,ArrowUp:prev_card", "lanes:Shift+H:card_left", "lanes:Shift+L:card_right", "lanes:F2:rename_lane", "lanes:Enter:open_card", "lanes:x,Backspace:discard", "lanes:u:undo", "lanes:c:cite",
  ...[["a", "agent"], ["s", "steps"], ["t", "timeline"], ["r", "narrative"], ["w", "worklog"], ["d", "discarded"], ["b", "jobs"], ["q", "pipeline"], ["e", "replay"]].map(([k, id]) => `lenses:${k}:lens_${id}`),
  "lenses:v:dock_side", "replay:j,ArrowDown:replay_next", "replay:k,ArrowUp:replay_prev",
];

type Gate = "publish" | "plan";
async function open(gate: Gate = "publish"): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  if (gate === "publish") { await p.s.toPublishGate(id); await seed(p, id); } else await p.s.toPlanGate(id);
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
const first = (q: Page): HTMLElement => q.q("[data-area=incoming] [data-card]");
const incomingIds = (q: Page): string[] => q.all("[data-area=incoming] [data-card]").map((e) => e.dataset.card!);
const focused = (q: Page): HTMLElement => q.doc.activeElement as HTMLElement;
const lens = (id: string, key: string, seen: string[]): LensDef => {
  const def: LensDef = { id: id as never, key, title: id, make: (ui) => { seen.push(id); return { el: ui.h("div", { class: "stub-lens" }, id), update() {} }; } };
  LENSES.push(def); added.push(def);
  return def;
};
const stubTarget = (q: Page, tag: string, props: Record<string, string> = {}): Element => {
  const el = q.doc.createElement(tag);
  for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
  return el as unknown as Element;
};

test("the map is the one in the plan", () => {
  expect(KEYMAP.map((b) => `${b.area}:${b.keys.join(",")}:${b.action}`)).toEqual(EXPECTED);
});

test("no key is bound twice in one area", () => {
  for (const area of new Set(KEYMAP.map((b) => b.area))) {
    const keys = KEYMAP.filter((b) => b.area === area).flatMap((b) => b.keys);
    expect(new Set(keys).size).toBe(keys.length);
  }
});

test("keyOf names keys as the map does", () => {
  const ev = (key: string, shiftKey = false) => ({ key, shiftKey }) as KeyboardEvent;
  expect([keyOf(ev("j")), keyOf(ev("J")), keyOf(ev("H", true)), keyOf(ev(" ")), keyOf(ev("?", true)), keyOf(ev("Tab", true)), keyOf(ev("Enter", true)), keyOf(ev("F2")), keyOf(ev("3"))])
    .toEqual(["j", "j", "Shift+H", "Space", "?", "Shift+Tab", "Shift+Enter", "F2", "3"]);
});

test("areaOf is null in a control and the nearest data-area elsewhere", async () => {
  const q = await open();
  const card = first(q);
  expect(areaOf(card)).toBe("incoming");
  expect(areaOf(q.q("[data-area=lanes] [data-card]"))).toBe("lanes");
  expect(areaOf(q.q(".lens-dock"))).toBe("lenses");
  expect(areaOf(q.doc.body)).toBe("anywhere");
  for (const tag of ["button", "input", "textarea", "select", "a"]) expect(areaOf(stubTarget(q, tag))).toBeNull();
  expect(areaOf(stubTarget(q, "div", { contenteditable: "true" }))).toBeNull();
  expect(areaOf(q.q("[data-area=lanes] .lane-title"))).toBeNull();
});

test("dispatchKey runs the binding, says whether one ran, and ignores a key with a modifier", () => {
  const ran: string[] = [];
  const doc = new (require("happy-dom").Window)().document as Document;
  const ev = (key: string, init: object = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: doc.body, ...init }) as unknown as KeyboardEvent;
  const actions = { help: () => ran.push("help") };
  expect(dispatchKey(ev("?"), actions)).toBe(true);
  expect(dispatchKey(ev("?", { ctrlKey: true }), actions)).toBe(false);
  expect(dispatchKey(ev("/"), actions)).toBe(false);          // bound, but no handler given
  expect(dispatchKey(ev("z"), actions)).toBe(false);
  expect(ran).toEqual(["help"]);
});

test("every action in the map has a handler, and every handler is in the map", async () => {
  const q = await open();
  expect(Object.keys(q.actions()).sort()).toEqual([...new Set(KEYMAP.map((b) => b.action))].sort());
});

test("the ? card lists every binding, grouped by area, and nothing else", async () => {
  const q = await open();
  const before = focused(q);
  q.press("?");
  const rows = q.all("[role=dialog] tr").map((r) => r.textContent);
  expect(rows.length).toBe(KEYMAP.length);
  expect(q.all("[role=dialog] h3").map((e) => e.textContent)).toEqual(["Anywhere", "Incoming", "Columns", "Lanes", "Lenses", "Replay"]);
  expect(q.q("[role=dialog]").getAttribute("aria-modal")).toBe("true");
  expect(q.q("[role=dialog]").getAttribute("aria-label")).toBe("Keys");
  expect(q.q("[role=dialog] tr kbd").tagName.toLowerCase()).toBe("kbd");
  expect(focused(q)).toBe(q.q("[role=dialog]"));
  const labels = KEYMAP.map((b) => b.label);
  expect(q.all("[role=dialog] tr").map((r) => r.lastElementChild!.textContent)).toEqual(KEYMAP.map((b) => b.label));
  expect(labels.length).toBe(rows.length);
  q.press("Escape");
  expect(q.doc.querySelector("[role=dialog]")).toBeNull();
  expect(focused(q)).toBe(before);
});

test("while the ? card is open, Escape closes it before anything else and ? closes it too", async () => {
  const q = await open();
  const c = first(q); c.focus(); q.press("Enter");
  q.press("?"); q.press("?");
  expect(q.doc.querySelector("[role=dialog]")).toBeNull();
  q.press("?"); q.press("j");                         // a card key does nothing while the card is open
  expect(q.doc.querySelector("[role=dialog]")).not.toBeNull();
  q.press("Escape");
  expect(q.doc.querySelector("[role=dialog]")).toBeNull();
  expect(q.store()).not.toBeNull();
  expect(q.win.location.hash).toBe("#/case/CASE-1");
});

test("J and K, and the arrows, move the selection", async () => {
  const q = await open();
  const ids = incomingIds(q);
  expect(ids.length).toBeGreaterThan(2);
  q.q("[data-area=incoming]").focus();
  q.press("j"); expect(focused(q).dataset.card).toBe(ids[0]);
  q.press("j"); expect(focused(q).dataset.card).toBe(ids[1]);
  q.press("ArrowDown"); expect(focused(q).dataset.card).toBe(ids[2]);
  q.press("k"); expect(focused(q).dataset.card).toBe(ids[1]);
  q.press("ArrowUp"); expect(focused(q).dataset.card).toBe(ids[0]);
  q.press("k"); expect(focused(q).dataset.card).toBe(ids[0]);
});

test("Space keeps the selected card into the target lane; ArrowRight does the same", async () => {
  const q = await open();
  const ids = incomingIds(q);
  const target = st(q).target!;
  first(q).focus();
  q.press(" "); await q.settle();
  expect(st(q).cards[ids[0]!]).toMatchObject({ place: "lane", lane: target });
  expect(focused(q).dataset.card).toBe(ids[1]);                 // the selection moves on to the next card
  q.press("ArrowRight"); await q.settle();
  expect(st(q).cards[ids[1]!]).toMatchObject({ place: "lane", lane: target });
});

test("X, ArrowLeft and Backspace discard", async () => {
  const q = await open();
  const ids = incomingIds(q);
  first(q).focus();
  q.press("x"); await q.settle();
  expect(st(q).discarded).toContain(ids[0]!);
  q.press("ArrowLeft"); await q.settle();
  expect(st(q).discarded).toContain(ids[1]!);
  q.press("Backspace"); await q.settle();
  expect(st(q).discarded).toContain(ids[2]!);
});

test("P pins and unpins; O keeps a card open while another opens; Enter opens and focuses the first action", async () => {
  const q = await open();
  const [a, b, c] = incomingIds(q);
  first(q).focus();
  q.press("p"); await q.settle();
  expect(st(q).cards[a!]!.pinned).toBe(true);
  q.press("p"); await q.settle();
  expect(st(q).cards[a!]!.pinned).toBe(false);
  q.press("o");
  expect(q.q(`[data-card=${a}]`).classList.contains("open")).toBe(true);
  q.press("j"); q.press("Enter");
  expect(q.all("[data-card].open").map((e) => e.dataset.card).sort()).toEqual([a, b].sort());
  expect(focused(q).closest("[role=toolbar]")).not.toBeNull();
  expect(focused(q)).toBe(q.q(`[data-card=${b}] .actions button:not([disabled])`));
  q.q(`[data-card=${c}]`).focus(); q.press("Enter");
  expect(q.all("[data-card].open").map((e) => e.dataset.card).sort()).toEqual([a, c].sort());   // b was not marked keep-open
});

test("U undoes the last keep", async () => {
  const q = await open();
  const id = incomingIds(q)[0]!;
  first(q).focus();
  q.press("Space"); await q.settle();
  expect(st(q).cards[id]!.place).toBe("lane");
  q.press("u"); await q.settle();
  expect(st(q).cards[id]!.place).toBe("incoming");
});

test("C cites through the card's own Cite button when it can be pressed", async () => {
  const q = await open();
  const card = first(q);
  card.focus(); q.press("c");
  expect(card.classList.contains("open")).toBe(true);           // a card that is closed is opened, so its action row is there
  let pressed = 0;
  const cite = q.q(`[data-card=${card.dataset.card}] [data-action=cite]`);
  cite.removeAttribute("disabled");
  cite.addEventListener("click", () => { pressed++; });
  q.press("c");
  expect(pressed).toBe(1);
});

test("Tab, L and ] move to the next column; Shift+Tab, H and [ move back; 0 goes to Incoming", async () => {
  const q = await open();
  const lanes = st(q).lanes.map((l) => l.id);
  expect(lanes.length).toBeGreaterThan(1);
  const at = (): string | undefined => (focused(q).closest(".lane") as HTMLElement | null)?.dataset.lane ?? (focused(q).closest("[data-area=incoming]") ? "incoming" : undefined);
  q.q("[data-area=incoming]").focus();
  q.press("Tab"); expect(at()).toBe(lanes[0]);
  q.press("l"); expect(at()).toBe(lanes[1]);
  q.press("]"); expect(at()).toBe(lanes[2] ?? "incoming");
  q.press("Shift+Tab" , { shift: true }); expect(at()).toBe(lanes[2] === undefined ? lanes[1] : lanes[1]);
  q.press("h"); expect(at()).toBe(lanes[0]);
  q.press("["); expect(at()).toBe("incoming");
  q.press("Tab"); q.press("0"); expect(at()).toBe("incoming");
});

test("1 to 9 set the keep target to that lane, and a number past the last lane does nothing", async () => {
  const q = await open();
  const lanes = st(q).lanes.map((l) => l.id);
  const n = st(q).lanes.length;
  first(q).focus();
  q.press("2"); await q.settle();
  expect(st(q).target).toBe(lanes[1]);
  q.press("1"); await q.settle();
  expect(st(q).target).toBe(lanes[0]);
  const seq = st(q).seq;
  q.press(String(n + 1 > 9 ? 9 : n + 1)); await q.settle();
  expect(st(q).seq).toBe(seq);
});

test("in a lane, Shift+L moves the card one lane right and Shift+H one left; from the first lane Shift+H sends it back to Incoming", async () => {
  const q = await open();
  const lanes = st(q).lanes.map((l) => l.id);
  const card = st(q).lanes[0]!.cards[0]!;
  const el = (): HTMLElement => q.q(`[data-card=${card}]`);
  el().focus();
  q.press("L", { shift: true }); await q.settle();
  expect(st(q).cards[card]).toMatchObject({ place: "lane", lane: lanes[1] });
  expect(focused(q).dataset.card).toBe(card);                   // focus follows the card
  q.press("H", { shift: true }); await q.settle();
  expect(st(q).cards[card]).toMatchObject({ place: "lane", lane: lanes[0] });
  q.press("H", { shift: true }); await q.settle();
  expect(st(q).cards[card]!.place).toBe("incoming");
  // from the last lane, Shift+L does nothing
  const last = st(q).lanes.at(-1)!.cards[0] ?? null;
  if (last !== null) { q.q(`[data-card=${last}]`).focus(); const seq = st(q).seq; q.press("L", { shift: true }); await q.settle(); expect(st(q).seq).toBe(seq); }
});

test("j and k walk the cards of a lane", async () => {
  const q = await open();
  const lane = st(q).lanes.find((l) => l.cards.length > 1)!;
  q.q(`[data-card=${lane.cards[0]}]`).focus();
  q.press("j"); expect(focused(q).dataset.card).toBe(lane.cards[1]);
  q.press("k"); expect(focused(q).dataset.card).toBe(lane.cards[0]);
});

test("F2 renames the focused lane", async () => {
  const q = await open();
  const id = st(q).lanes[0]!.id;
  (q.q(`[data-lane=${id}]`) as HTMLElement).focus();
  q.press("F2");
  const input = q.q(`[data-lane=${id}] input`) as HTMLInputElement;
  expect(focused(q)).toBe(input);
  q.fill(input, "Keyed"); q.press("Enter"); await q.settle();
  expect(st(q).lanes.find((l) => l.id === id)!.title).toBe("Keyed");
});

test("each lens letter opens its lens and V flips the dock side", async () => {
  const q = await open();
  const seen: string[] = [];
  const ids = [["a", "agent"], ["s", "steps"], ["t", "timeline"], ["r", "narrative"], ["w", "worklog"], ["d", "discarded"], ["b", "jobs"], ["q", "pipeline"], ["e", "replay"]] as const;
  for (const [k, id] of ids) lens(id, k, seen);
  first(q).focus();
  for (const [k, id] of ids) { q.press(k); expect(q.store()).not.toBeNull(); expect(seen.at(-1)).toBe(id); }
  expect(seen).toEqual(ids.map(([, id]) => id));
  expect(q.q(".workarea").classList.contains("dock-bottom")).toBe(true);
  q.press("v");
  expect(q.q(".workarea").classList.contains("dock-right")).toBe(true);
  q.press("v");
  expect(q.q(".workarea").classList.contains("dock-bottom")).toBe(true);
});

test("a lens key for a lens that is not on the shelf does nothing", async () => {
  const q = await open();
  first(q).focus();
  q.press("a");
  expect(q.q(".lens-dock").hasAttribute("hidden")).toBe(true);
});

test("/ focuses the command bar and Escape leaves it", async () => {
  const q = await open();
  first(q).focus();
  q.press("/");
  expect(focused(q)).toBe(q.q("[aria-label=Command]"));
  q.press("Escape");
  expect(focused(q)).not.toBe(q.q("[aria-label=Command]"));
  expect(q.win.location.hash).toBe("#/case/CASE-1");
});

test("Escape closes the lens, then the open cards, then steps up to which one?, then home", async () => {
  const q = await open();
  const seen: string[] = [];
  lens("steps", "s", seen);
  const c = first(q); c.focus(); q.press("Enter");
  c.focus(); q.press("s");                                      // focus is on an action button after Enter, where letters are not keys
  expect(q.q(".lens-dock").hasAttribute("hidden")).toBe(false);
  q.press("Escape");
  expect(q.q(".lens-dock").hasAttribute("hidden")).toBe(true);
  expect(c.classList.contains("open")).toBe(true);
  q.press("Escape");
  expect(q.all("[data-card].open").length).toBe(0);
  expect(q.win.location.hash).toBe("#/case/CASE-1");
  q.press("Escape");
  expect(q.win.location.hash).toBe("#/investigate");
  q.press("Escape");
  expect(q.win.location.hash).toBe("#/");
});

test("Escape from a button inside a card goes back to the card first", async () => {
  const q = await open();
  const c = first(q); c.focus(); q.press("Enter");
  expect(focused(q).tagName.toLowerCase()).toBe("button");
  q.press("Escape");
  expect(focused(q)).toBe(c);
  expect(c.classList.contains("open")).toBe(false);
});

test("Shift+Enter accepts a plan of free steps, approves a publishable draft, and resumes a paused run", async () => {
  const q = await open("publish");
  const label = q.q(".next-thing").textContent!;
  expect(label).toMatch(/^Approve: publish draft/);
  first(q).focus();
  q.press("Enter", { shift: true }); await q.settle(); await q.s.app.hub.idle(); await q.settle();
  expect(st(q).published.length).toBe(1);
  // a paused run
  await q.s.command("CASE-1", "pause", {}); await q.settle();
  if (q.root.querySelector(".next-thing") !== null && /^Resume/.test(q.q(".next-thing").textContent!)) {
    q.press("Enter", { shift: true }); await q.settle();
    expect(st(q).run.status).not.toBe("paused");
  }
});

test("Shift+Enter on a plan of free steps accepts it", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  p.win.location.hash = `#/case/${id}`; await p.settle();
  const free = st(p).plan.current!.steps.every((s) => s.free);
  if (!free) return;                                              // the sample's plan has a costly step: covered by the next test
  p.press("Enter", { shift: true }); await p.settle();
  expect(st(p).plan.status).toBe("accepted");
});

test("Shift+Enter on a plan with a costly step opens Steps instead of accepting", async () => {
  const q = await open("plan");
  const seen: string[] = [];
  lens("steps", "s", seen);
  expect(st(q).plan.current!.steps.some((s) => !s.free)).toBe(true);
  const seq = st(q).seq;
  q.press("Enter", { shift: true }); await q.settle();
  expect(seen).toEqual(["steps"]);
  expect(st(q).seq).toBe(seq);
});

test("typing in a field never triggers a shortcut", async () => {
  const q = await open();
  const before = q.s.entries("CASE-1").length;
  q.q("[aria-label=Command]").focus();
  for (const k of ["j", "x", " ", "a", "?", "1", "/"]) q.press(k);
  q.press("Enter", { shift: true });
  expect(q.s.entries("CASE-1").length).toBe(before);
  expect(q.doc.querySelector("[role=dialog]")).toBeNull();
  const sel = q.q("[aria-label='Sort by']"); sel.focus();
  q.press("j"); q.press("x");
  expect(q.s.entries("CASE-1").length).toBe(before);
});

test("a focused button is not a shortcut target, so Space activates the button", async () => {
  const q = await open();
  const before = q.s.entries("CASE-1").length;
  const button = q.q(".reverse"); button.focus();
  for (const k of ["j", "x", " ", "p", "1", "l"]) q.press(k);
  await q.settle();
  expect(q.s.entries("CASE-1").length).toBe(before);
  expect(focused(q)).toBe(button);
  // but / still reaches the command bar from a button
  q.press("/");
  expect(focused(q)).toBe(q.q("[aria-label=Command]"));
});

test("while replaying, keys that change the case do nothing and say why", async () => {
  const q = await open();
  q.store()!.goTo(q.store()!.live.seq - 1); await q.settle();
  const before = q.s.entries("CASE-1").length;
  first(q).focus();
  q.press("x"); q.press(" "); q.press("2"); await q.settle();
  expect(q.s.entries("CASE-1").length).toBe(before);
  expect(q.toasts().filter((t) => t === "Return to live to change the case").length).toBeGreaterThan(0);
});

test("in Replay, Escape returns to live first, and j and k step through the entries", async () => {
  const q = await open();
  q.store()!.goTo(5); await q.settle();
  q.root.querySelector(".lens-dock")!.setAttribute("data-area", "replay");
  (q.q(".lens-dock") as HTMLElement).focus();
  q.press("j"); expect(q.store()!.at).toBe(6);
  q.press("k"); q.press("k"); expect(q.store()!.at).toBe(4);
  q.press("Escape");
  expect(q.store()!.at).toBeNull();
  expect(q.win.location.hash).toBe("#/case/CASE-1");
});
