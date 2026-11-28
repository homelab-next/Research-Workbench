import type { CaseState } from "../../core/state";
import type { Observable } from "../../core/types";
import { knownValues } from "../derive";
import { clear } from "../dom";
import type { CaseHandlers, CaseScreen, LensId, Open } from "../app";
import { dropCommand, enableDrag } from "../drag";
import { LENSES } from "../lenses";
import { flip } from "../motion";
import { changedBy } from "../replay";
import type { Ui, View } from "../ui";
import { makeBrief } from "./brief";
import { makeCardPool } from "./card";
import type { CardEnv } from "./card";
import { makeIncoming } from "./incoming";
import { makeLanes } from "./lanes";
import { makeQuestionsPanel } from "./questions";
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
  /** Opens the Narrative lens (when it is not the one open) and cites `card` there. */
  cite(card: string, section?: string): void;
  /** Opens the card and its Pivot panel, starting from `values`. */
  pivot(card: string, values: Observable[]): void;
  /** Opens the Agent lens (when it is not the one open) and sends `text` to your agent. */
  ask(text: string): void;
  /** The key actions of the work area, by the names KEYMAP gives them. */
  actions(): Record<string, () => void>;
  /** The Escape of the work area: back to live, else close the lens, else close the open cards. True when one did something. */
  escape(): boolean;
}

/** The case screen of the app: the work area for the case the store follows. */
export function caseScreenFor(ui: Ui): CaseScreen {
  return (open, register) => {
    const area = makeWorkArea(ui, open);
    const handlers: CaseHandlers = {
      openLens: (id, arg) => area.openLens(id, arg),
      closeLens: () => area.closeLens(),
      focusCard: (card) => { area.open(card); area.select(card); },
      cite: (card, section) => area.cite(card, section),
      pivot: (card, values) => area.pivot(card, values),
      ask: (text) => area.ask(text),
      focusLane: (lane) => area.focusColumn(lane),
      actions: area.actions(),
      escape: () => area.escape(),
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
  const undo = (target: number): { label: string; act(): void } => ({ label: "Undo", act: () => { void ui.send("undo", { target }, "that action can no longer be undone", store.id); } });
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
    toggleDock: () => toggleDock(),
    current: () => lensId,
  });
  const toggleDock = (): void => { dock = dock === "bottom" ? "right" : "bottom"; ui.prefs.set("dock", dock); layout(); shelf.update(); };
  const bannerText = h("span", { class: "banner-text" });
  const bannerStep = (dir: 1 | -1) => (): void => { if (store.at !== null) stepReplay(dir); };
  const banner = h("div", { class: "replay-banner", role: "status", tabindex: 0, data: { area: "replay" } },
    bannerText,
    h("button", { type: "button", name: "Previous entry", on: { click: bannerStep(-1) } }, "◂"),
    h("button", { type: "button", name: "Next entry", on: { click: bannerStep(1) } }, "▸"),
    h("button", { type: "button", name: "Return to live", on: { click: () => store.goTo(null) } }, "Return to live"));
  // the questions put to the person, and the findings at the publish gate, first under the brief, whatever lens is open (spec slice 10)
  const forYou = makeQuestionsPanel(ui, open, () => lensId);
  const stage = h("div", { class: "stage-col" }, brief.el, forYou.el, lanes.el);
  const lensBox = h("div", { class: "lens-dock", tabindex: 0, data: { area: "lens" }, hidden: true });
  const el = h("div", { class: "workarea", data: { screen: "case" }, tabindex: -1 }, incoming.el, stage, lensBox, shelf.el);

  const layout = (): void => {
    el.classList.toggle("dock-right", dock === "right");
    el.classList.toggle("dock-bottom", dock === "bottom");
    el.classList.toggle("has-lens", lensId !== null);
  };

  // ---------- rendering ----------
  let replayText = "";
  let pendingFocus: { card: string; seq: number } | null = null;
  /** Cards slide to where they now are (and a discarded one slides out); with reduced motion this is just `paint`. */
  const render = (): void => flip(ui, () => [...el.querySelectorAll("[data-card]")] as HTMLElement[], paint);
  const paint = (): void => {
    const state = store.shown;
    const follow = pendingFocus !== null && store.live.seq > pendingFocus.seq ? pendingFocus : null;   // read before the parts repaint: they may move the focus themselves
    brief.update();
    forYou.update();
    incoming.update();
    lanes.update();
    shelf.update();
    lensView?.update();
    for (const id of state.discarded) pool.forget(id);
    const text = store.at === null ? "" : `Replay · entry ${store.at} of ${store.live.seq} · read-only`;
    if (text !== replayText) {
      replayText = text;
      if (text === "") banner.remove(); else { bannerText.textContent = text; stage.insertBefore(banner, stage.firstChild); }
    }
    markChanged();
    layout();
    // A card that was focused and left its place (kept, sent back, moved) gives the focus to the card that follows it, once the entries have arrived.
    if (follow !== null) {
      pendingFocus = null;
      const next = byData("card", follow.card);
      if (next !== null && ui.doc.activeElement !== next) next.focus();
    }
  };
  /** While replaying, the cards, lanes and stages the entry at the position touched carry the class `changed`. */
  let marked = false;
  const markChanged = (): void => {
    const entry = store.at === null ? null : store.entries[store.at - 1] ?? null;
    if (entry === null && !marked) return;
    const c = entry === null ? { cards: [], lanes: [], stages: [] } : changedBy(entry);
    marked = entry !== null;
    for (const n of el.querySelectorAll("[data-card]") as Iterable<HTMLElement>) n.classList.toggle("changed", c.cards.includes(n.dataset.card ?? ""));
    for (const n of el.querySelectorAll(".lane") as Iterable<HTMLElement>) n.classList.toggle("changed", c.lanes.includes(n.dataset.lane ?? ""));
    for (const n of el.querySelectorAll(".phase-strip [data-stage]") as Iterable<HTMLElement>) n.classList.toggle("changed", c.stages.includes(n.dataset.stage ?? ""));
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
    pendingFocus = null;
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
      (lensView as View & { focus?(): void }).focus?.();
    },
    cite(card, section) {
      if (lensId !== "narrative") area.openLens("narrative");
      (lensView as (View & { cite?(card: string, section?: string): void }) | null)?.cite?.(card, section);
    },
    pivot(card, values) {
      if (store.at !== null) return;                       // nothing is asked of a source while replaying
      area.open(card);
      pool.pivot(card, store.shown, values);
      byData("card", card)?.querySelector<HTMLElement>(".pivot-panel select")?.focus();
    },
    ask(text) {
      if (lensId !== "agent") area.openLens("agent");
      (lensView as (View & { ask?(text: string): void }) | null)?.ask?.(text);
    },
    actions: () => ({}),
    escape: () => false,
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
  const columns = (): string[] => ["incoming", ...store.shown.lanes.map((l) => l.id)];
  const column = (): string => {
    const active = ui.doc.activeElement;
    const lane = active?.closest?.(".lane") as HTMLElement | null | undefined;
    if (lane !== null && lane !== undefined && el.contains(lane)) return lane.dataset.lane ?? "incoming";
    if (active !== null && incoming.el.contains(active)) return "incoming";
    if (active !== null && lanes.el.contains(active) && where === "incoming") return store.shown.lanes[0]?.id ?? "incoming";
    return where;
  };
  const cardsIn = (col: string): HTMLElement[] => {
    const root = col === "incoming" ? incoming.el : byData("lane", col);
    return root === null ? [] : ([...root.querySelectorAll("[data-card]")] as HTMLElement[]);
  };
  const current = (): string | null => {
    const active = ui.doc.activeElement?.closest?.("[data-card]") as HTMLElement | null | undefined;
    return active?.dataset.card ?? selection;
  };
  const currentState = (): CaseState["cards"][string] | null => { const c = current(); return c !== null && Object.hasOwn(store.shown.cards, c) ? store.shown.cards[c]! : null; };
  /** The card after this one in its column, else the one before it. */
  const neighbour = (card: string): string | null => {
    const ids = cardsIn(column()).map((n) => n.dataset.card!);
    const at = ids.indexOf(card);
    return at < 0 ? null : (ids[at + 1] ?? ids[at - 1] ?? null);
  };
  const followCard = (card: string | null): void => { pendingFocus = card === null ? null : { card, seq: store.live.seq }; };
  const step = (dir: 1 | -1): void => {
    const ids = cardsIn(column()).map((n) => n.dataset.card!);
    if (ids.length === 0) return;
    const at = current() === null ? -1 : ids.indexOf(current()!);
    area.select(ids[at < 0 ? (dir > 0 ? 0 : ids.length - 1) : Math.max(0, Math.min(ids.length - 1, at + dir))]!);
  };
  const goColumn = (dir: 1 | -1): void => {
    const all = columns();
    const at = all.indexOf(column());
    area.focusColumn(all[(Math.max(at, 0) + dir + all.length) % all.length]!);
  };
  const withCard = (fn: (card: string, c: NonNullable<ReturnType<typeof currentState>>) => void) => (): void => { const c = currentState(); if (c !== null) fn(c.id, c); };
  const lensKeys: Record<string, () => void> = {};
  for (const id of ["agent", "steps", "timeline", "graph", "narrative", "worklog", "memory", "discarded", "jobs", "pipeline", "replay"] as const) lensKeys[`lens_${id}`] = () => area.openLens(id);
  const targetKeys: Record<string, () => void> = {};
  for (let n = 1; n <= 9; n++) {
    targetKeys[`target_${n}`] = () => {
      const lane = store.shown.lanes[n - 1];
      if (lane !== undefined && lane.id !== store.live.target) void ui.act("set_target", { lane: lane.id });
    };
  }
  const sideways = (dir: 1 | -1) => withCard((card, c) => {
    if (c.place !== "lane") return;
    const all = store.shown.lanes;
    const at = all.findIndex((l) => l.id === c.lane);
    followCard(card);
    if (dir < 0 && at === 0) env.sendBack(card);
    else if (all[at + dir] !== undefined) env.move(card, all[at + dir]!.id);
  });
  /** J and K in the Replay lens: one entry, by the lens's own filter. */
  const stepReplay = (dir: 1 | -1): void => {
    const lens = lensView as (View & { step?(dir: 1 | -1): void }) | null;
    if (lens?.step !== undefined) lens.step(dir);
    else if (store.at !== null) store.goTo(store.at + dir);
  };
  const keys: Record<string, () => void> = {
    next_card: () => step(1), prev_card: () => step(-1),
    keep: withCard((card, c) => { if (c.place === "incoming") { followCard(neighbour(card)); env.keep(card); } }),
    discard: withCard((card) => { followCard(neighbour(card)); env.discard(card); }),
    pin: withCard((card, c) => env.pin(card, !c.pinned)),
    keep_open: withCard((card) => area.open(card, true)),
    open_card: withCard((card) => {
      area.open(card);
      byData("card", card)?.querySelector<HTMLElement>(".actions button:not([disabled]), .actions select:not([disabled])")?.focus();
    }),
    undo: () => { void ui.act("undo"); },
    cite: withCard((card) => {
      if (!opened.has(card)) area.open(card);
      byData("card", card)?.querySelector<HTMLElement>("[data-action=cite]:not([disabled])")?.click();
    }),
    next_column: () => goColumn(1), prev_column: () => goColumn(-1),
    focus_incoming: () => area.focusColumn("incoming"),
    card_left: sideways(-1), card_right: sideways(1),
    rename_lane: () => { const c = column(); if (c !== "incoming") lanes.rename(c); },
    dock_side: () => toggleDock(),
    replay_next: () => stepReplay(1), replay_prev: () => stepReplay(-1),
    ...targetKeys, ...lensKeys,
  };
  area.actions = () => ({ ...keys });
  area.escape = () => {
    if (store.at !== null) { store.goTo(null); return true; }
    if (area.closeLens()) return true;
    if (opened.size > 0) { for (const id of [...opened]) area.close(id); return true; }
    return false;
  };

  const stopDrag = enableDrag(ui, el, open, (card, target) => {
    if (target.kind === "cite") { area.cite(card, target.section); return; }
    const cmd = dropCommand(store.live, card, target);
    if (cmd === null) return;
    const lane = typeof cmd.args.lane === "string" ? store.live.lanes.find((l) => l.id === cmd.args.lane) : undefined;
    const words = cmd.command === "keep" ? `Kept in ${lane?.title ?? "Kept"}` : cmd.command === "move" ? `Moved to ${lane?.title ?? ""}` : "Back in Incoming";
    void ui.send(cmd.command, cmd.args).then((r) => done(words, r));
  });
  const baseDestroy = area.destroy!;
  area.destroy = () => { stopDrag(); baseDestroy(); };
  render();
  return area;
}
