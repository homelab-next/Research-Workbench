import type { CaseState } from "../../core/state";
import { knownValues } from "../derive";
import { clear } from "../dom";
import type { CaseHandlers, CaseScreen, LensId, Open } from "../app";
import { LENSES } from "../lenses";
import type { Ui, View } from "../ui";
import { makeBrief } from "./brief";
import { makeCardPool } from "./card";
import type { CardEnv } from "./card";
import { makeIncoming } from "./incoming";
import { makeLanes } from "./lanes";
import { makeShelf } from "./shelf";
import type { Dock } from "./shelf";

export interface WorkArea extends View {
  selected(): string | null;                         // the card that has the selection, in whichever column has focus
  select(card: string | null): void;
  column(): "incoming" | string;                     // "incoming" or a lane id
  focusColumn(column: "incoming" | string): void;
  openCards(): string[]; open(card: string, keep?: boolean): void; close(card: string): void;
  lens(): LensId | null;
  /** Opens a lens that is on the shelf; one that is not (yet) does nothing. */
  openLens(id: LensId, arg?: string): void;
  /** True when a lens was open. */
  closeLens(): boolean;
}

/** The case screen of the app: the work area for the case the store follows. */
export function caseScreenFor(ui: Ui): CaseScreen {
  return (open, register) => {
    const area = makeWorkArea(ui, open);
    const handlers: CaseHandlers = {
      openLens: (id, arg) => area.openLens(id, arg),
      closeLens: () => area.closeLens(),
      focusCard: (card) => { area.open(card); area.select(card); },
      focusLane: (lane) => area.focusColumn(lane),
    };
    register(handlers);
    return area;
  };
}

export function makeWorkArea(ui: Ui, open: Open): WorkArea {
  const { h, win } = ui;
  const { store } = open;

  // ---------- which cards are open, new, selected ----------
  const opened = new Set<string>();
  const keepOpen = new Set<string>();
  const seen = new Set<string>();
  let selection: string | null = null;
  let where: string = "incoming";
  let knownCache: { cards: unknown; lanes: unknown; meta: unknown; values: Set<string>; version: number } | null = null;
  const known = (): { values: Set<string>; version: number } => {
    const s = store.shown;
    if (knownCache !== null && knownCache.cards === s.cards && knownCache.lanes === s.lanes && knownCache.meta === s.meta) return knownCache;
    const values = knownValues(s);
    const same = knownCache !== null && knownCache.values.size === values.size && [...values].every((v) => knownCache!.values.has(v));
    knownCache = { cards: s.cards, lanes: s.lanes, meta: s.meta, values: same ? knownCache!.values : values, version: (knownCache?.version ?? 0) + (same ? 0 : 1) };
    return knownCache;
  };

  // ---------- commands, with the words each one answers in ----------
  const undo = (target: number): { label: string; act(): void } => ({ label: "Undo", act: () => { void ui.send("undo", { target }, "that action can no longer be undone"); } });
  const laneTitle = (s: CaseState, id: string | null): string => s.lanes.find((l) => l.id === id)?.title ?? "Kept";
  const done = (message: string, r: { seq: number } | null): void => { if (r !== null) ui.toast(message, undo(r.seq)); };
  const env: CardEnv = {
    ui, store, nav: open.nav,
    isOpen: (id) => opened.has(id),
    isNew: (id) => !seen.has(id),
    toggle: (id) => { if (opened.has(id)) area.close(id); else area.open(id); },
    known,
    readonly: () => store.at !== null,
    keep: (card) => { const to = laneTitle(store.live, store.live.target); void ui.send("keep", { card }).then((r) => done(`Kept in ${to}`, r)); },
    move: (card, lane) => {
      const to = store.live.lanes.find((l) => l.id === lane);
      if (to === undefined) return;
      void ui.send("move", { card, lane, index: to.cards.length }).then((r) => done(`Moved to ${to.title}`, r));
    },
    discard: (card) => { void ui.send("discard", { card }).then((r) => done("Discarded", r)); },
    sendBack: (card) => { void ui.send("send_back", { card }).then((r) => done("Back in Incoming", r)); },
    pin: (card, pinned) => { void ui.send("pin", { card, pinned }); },
  };
  const pool = makeCardPool(env);

  // ---------- the parts ----------
  const brief = makeBrief(ui, open);
  const incoming = makeIncoming(ui, store, pool.el, pool.patch);
  const lanes = makeLanes(ui, store, pool.el, pool.patch);
  let dock: Dock = ui.prefs.get<unknown>("dock", "bottom") === "right" ? "right" : "bottom";
  let lensId: LensId | null = null;
  let lensView: View | null = null;
  const shelf = makeShelf(ui, {
    open: (id) => area.openLens(id),
    dock: () => dock,
    toggleDock: () => { dock = dock === "bottom" ? "right" : "bottom"; ui.prefs.set("dock", dock); layout(); shelf.update(); },
    current: () => lensId,
  });
  const banner = h("div", { class: "replay-banner", role: "status" });
  const stage = h("div", { class: "stage-col" }, brief.el, lanes.el);
  const lensBox = h("div", { class: "lens-dock", tabindex: 0, data: { area: "lens" }, hidden: true });
  const el = h("div", { class: "workarea", data: { screen: "case" }, tabindex: -1 }, incoming.el, stage, lensBox, shelf.el);

  const layout = (): void => {
    el.classList.toggle("dock-right", dock === "right");
    el.classList.toggle("dock-bottom", dock === "bottom");
    el.classList.toggle("has-lens", lensId !== null);
  };

  // ---------- rendering ----------
  let replayText = "";
  const render = (): void => {
    const state = store.shown;
    brief.update();
    incoming.update();
    lanes.update();
    shelf.update();
    lensView?.update();
    for (const id of state.discarded) pool.forget(id);
    const text = store.at === null ? "" : `Replay · entry ${store.at} of ${store.live.seq} · read-only`;
    if (text !== replayText) {
      replayText = text;
      if (text === "") banner.remove(); else { banner.textContent = text; stage.insertBefore(banner, stage.firstChild); }
    }
    layout();
  };
  let frame: number | null = null;
  const schedule = (): void => {
    if (frame !== null) return;
    frame = win.requestAnimationFrame(() => { frame = null; render(); });
  };
  const stopWatching = store.subscribe(schedule);

  // focus and selection follow the browser's focus
  el.addEventListener("focusin", (e) => {
    const t = e.target as Element;
    const cardEl = t.closest?.("[data-card]") as HTMLElement | null;
    if (cardEl !== null && cardEl !== undefined) selection = cardEl.dataset.card ?? null;
    const laneEl = t.closest?.(".lane") as HTMLElement | null;
    if (laneEl !== null && laneEl !== undefined) where = laneEl.dataset.lane ?? "incoming";
    else if (t.closest?.("[data-area=incoming]") !== null && t.closest?.("[data-area=incoming]") !== undefined) where = "incoming";
  });

  const byData = (key: "card" | "lane", value: string): HTMLElement | null =>
    ([...el.querySelectorAll(`[data-${key}]`)] as HTMLElement[]).find((n) => n.dataset[key] === value) ?? null;

  const area: WorkArea = {
    el,
    update: render,
    destroy() {
      stopWatching();
      if (frame !== null) win.cancelAnimationFrame(frame);
      lensView?.destroy?.();
      brief.destroy?.();
    },
    selected: () => selection,
    select(card) {
      selection = card;
      if (card !== null) byData("card", card)?.focus();
    },
    column: () => where,
    focusColumn(column) {
      where = column;
      const target = column === "incoming" ? incoming.el : byData("lane", column);
      target?.focus();
    },
    openCards: () => [...opened],
    open(card, keep = false) {
      if (keep) keepOpen.add(card);
      else for (const other of [...opened]) if (other !== card && !keepOpen.has(other)) opened.delete(other);
      opened.add(card);
      seen.add(card);
      render();
    },
    close(card) { opened.delete(card); keepOpen.delete(card); render(); },
    lens: () => lensId,
    openLens(id, arg) {
      const def = LENSES.find((l) => l.id === id);
      if (def === undefined) return;
      lensView?.destroy?.();
      clear(lensBox);
      lensId = id;
      lensView = def.make(ui, open, arg ?? null);
      lensBox.hidden = false;
      lensBox.appendChild(lensView.el);
      render();
    },
    closeLens() {
      if (lensId === null) return false;
      lensView?.destroy?.();
      lensView = null; lensId = null;
      clear(lensBox);
      lensBox.hidden = true;
      render();
      return true;
    },
  };
  render();
  return area;
}
