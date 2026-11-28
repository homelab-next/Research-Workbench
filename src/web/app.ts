import type { CaseSummaryView } from "../core/wire";
import type { Observable } from "../core/types";
import { clear } from "./dom";
import { CaseStore, follow } from "./store";
import type { Ui, View } from "./ui";
import { homeView, MODES } from "./views/home";
import { newView } from "./views/newcase";
import { pickView, soonView } from "./views/pick";
import { caseStoreView } from "./views/casestore";
import { loopsView } from "./views/loops";
import { loopView } from "./views/loop";
import { loopEditView } from "./views/loopedit";
import { memoryView } from "./views/memory";
import { topBar } from "./views/topbar";
import { caseScreenFor } from "./views/workarea";
import { AT_GATE, makeSend } from "./ui";
import { makeToasts } from "./views/toasts";
import { makeHelp } from "./views/help";
import { dispatchKey } from "./keys";
import { nextThing } from "./derive";

export type LensId = "agent" | "steps" | "timeline" | "graph" | "narrative" | "worklog" | "memory" | "discarded" | "jobs" | "pipeline" | "improve" | "replay";
export type Route = { screen: "home" } | { screen: "pick" } | { screen: "new"; loop?: string } | { screen: "store" } | { screen: "soon"; mode: string } | { screen: "case"; id: string; at?: number }
  | { screen: "loops" } | { screen: "loop"; id: string } | { screen: "loop_edit"; id: string } | { screen: "memory" };

/** A loop's id as the server takes one: letters, digits, ".", "_" and "-", starting with a letter or digit, at most 64, never "..". */
const LOOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const loopId = (s: string | undefined): s is string => s !== undefined && LOOP_ID.test(s) && !s.includes("..");

/**
 * "#/" · "#/investigate" · "#/investigate/new" · "#/investigate/new/<loop>" · "#/investigate/store" · "#/soon/<mode>" · "#/case/CASE-1" · "#/loops" ·
 * "#/case/CASE-1/at/<seq>" (the case, replayed at that entry once it has arrived) · "#/loops/<loop>" · "#/loops/<loop>/edit" · "#/memory". Anything else is home.
 */
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter((p) => p !== "");
  const home: Route = { screen: "home" };
  if (parts[0] === "investigate") {
    if (parts.length === 1) return { screen: "pick" };
    if (parts.length === 2 && parts[1] === "new") return { screen: "new" };
    if (parts.length === 3 && parts[1] === "new" && loopId(parts[2])) return { screen: "new", loop: parts[2] };
    if (parts.length === 2 && parts[1] === "store") return { screen: "store" };
    return home;
  }
  if (parts[0] === "soon" && parts.length === 2 && /^[a-z0-9-]+$/.test(parts[1]!)) return { screen: "soon", mode: parts[1]! };
  if (parts[0] === "loops") {
    if (parts.length === 1) return { screen: "loops" };
    if (parts.length === 2 && loopId(parts[1])) return { screen: "loop", id: parts[1] };
    if (parts.length === 3 && loopId(parts[1]) && parts[2] === "edit") return { screen: "loop_edit", id: parts[1] };
    return home;
  }
  if (parts[0] === "memory" && parts.length === 1) return { screen: "memory" };
  if (parts[0] === "case" && parts.length === 2 && /^CASE-[1-9][0-9]{0,8}$/.test(parts[1]!)) return { screen: "case", id: parts[1]! };
  if (parts[0] === "case" && parts.length === 4 && /^CASE-[1-9][0-9]{0,8}$/.test(parts[1]!) && parts[2] === "at" && /^(?:0|[1-9][0-9]{0,8})$/.test(parts[3]!)) {
    return { screen: "case", id: parts[1]!, at: Number(parts[3]) };
  }
  return home;
}

export function routeHash(route: Route): string {
  switch (route.screen) {
    case "home": return "#/";
    case "pick": return "#/investigate";
    case "new": return route.loop === undefined ? "#/investigate/new" : `#/investigate/new/${route.loop}`;
    case "store": return "#/investigate/store";
    case "soon": return `#/soon/${route.mode}`;
    case "case": return route.at === undefined ? `#/case/${route.id}` : `#/case/${route.id}/at/${route.at}`;
    case "loops": return "#/loops";
    case "loop": return `#/loops/${route.id}`;
    case "loop_edit": return `#/loops/${route.id}/edit`;
    case "memory": return "#/memory";
  }
}

export interface Nav {
  go(route: Route): void;
  openLens(id: LensId, arg?: string): void; closeLens(): void;
  focusCard(card: string): void;
  /** Opens the Narrative lens in edit mode and inserts `[<card>]` at the caret of the section last focused (Summary by default); `section` names another. */
  cite(card: string, section?: string): void;
  pivot(card: string, values: Observable[]): void;
  ask(text: string): void;
  /** What Shift+Enter does: resume, or take you to the gate's own button (a gate is passed only there). */
  nextThing(): void;
  /** One step up: close what is open, else go up a level (case → which one? → home). */
  up(): void;
}
/** Set by the case screen (Task 6); null on every other screen. */
export interface Open { store: CaseStore; nav: Nav }

/** What the case screen answers for the app. Anything it leaves out does nothing. `closeLens` says whether it closed something. */
export interface CaseHandlers {
  openLens?(id: LensId, arg?: string): void; closeLens?(): boolean; focusCard?(card: string): void; cite?(card: string, section?: string): void;
  pivot?(card: string, values: Observable[]): void; ask?(text: string): void; focusLane?(lane: string): void;
  /** The key actions of the case screen (every action of KEYMAP but the four of "anywhere"). */
  actions?: Record<string, () => void>;
  /** Escape on the case screen: returns to live, closes the lens, closes the open cards. True when it closed something. */
  escape?(): boolean;
}
/** Builds the case screen. It calls `register` with what it can do for the app. */
export type CaseScreen = (open: Open, register: (handlers: CaseHandlers) => void) => View;
export interface AppOptions { caseScreen?: CaseScreen }

/** What every screen and the top bar may ask of the app. */
export interface Shell {
  ui: Ui; nav: Nav;
  cases(): CaseSummaryView[];
  /** "loading" until the first answer; "failed" when the latest read failed. */
  casesStatus(): "loading" | "ready" | "failed";
  store(): CaseStore | null;
  route(): Route;
  focusLane(lane: string): void;
  /** Reads the case list again (after an unload or a load from a screen that stays). */
  refreshCases(): void;
}
/** `leave` is asked before the app goes to another screen: false keeps this one (it has told the person why). */
export type Screen = View & { focus?(): void; leave?(): boolean };

export function startApp(ui: Ui, root: HTMLElement, opts: AppOptions = {}): { destroy(): void; actions(): Record<string, () => void> } {
  const { h, win, doc } = ui;
  let cases: CaseSummaryView[] = [];
  let store: CaseStore | null = null;
  let stopFollow: (() => void) | null = null;
  let stopWatch: (() => void) | null = null;
  /** A wait for the entry a "#/case/<id>/at/<seq>" address names, to replay the case there once it has arrived. */
  let stopSeek: (() => void) | null = null;
  let handlers: CaseHandlers = {};
  let route: Route = { screen: "home" };
  let routeKey = "";
  let view: Screen | null = null;
  let destroyed = false;
  let loads = 0;
  let casesStatus: "loading" | "ready" | "failed" = "loading";

  const dropStore = (): void => {
    stopSeek?.(); stopWatch?.(); stopFollow?.();
    stopSeek = null; stopWatch = null; stopFollow = null; store = null;
  };
  const nav: Nav = {
    go(next) { win.location.hash = routeHash(next); render(); },
    openLens: (id, arg) => handlers.openLens?.(id, arg),
    closeLens: () => { handlers.closeLens?.(); },
    focusCard: (card) => handlers.focusCard?.(card),
    cite: (card, section) => handlers.cite?.(card, section),
    pivot: (card, values) => handlers.pivot?.(card, values),
    ask: (text) => handlers.ask?.(text),
    nextThing: () => actions().next_thing?.(),
    up() {
      if (route.screen === "case") { if (!(handlers.closeLens?.() ?? false)) nav.go({ screen: "pick" }); }
      else if (route.screen === "new" && route.loop !== undefined) nav.go({ screen: "loop", id: route.loop });
      else if (route.screen === "new" || route.screen === "store") nav.go({ screen: "pick" });
      else if (route.screen === "loop") nav.go({ screen: "loops" });
      else if (route.screen === "loop_edit") nav.go({ screen: "loop", id: route.id });
      else if (route.screen !== "home") nav.go({ screen: "home" });
    },
  };
  const shell: Shell = {
    ui, nav, cases: () => cases, casesStatus: () => casesStatus, store: () => store, route: () => route, focusLane: (lane) => handlers.focusLane?.(lane),
    refreshCases: () => refresh(),
  };
  // The real toasts and command sending. A toast also goes to whatever `ui.toast` was before, so a host can listen.
  const toasts = makeToasts(ui);
  const priorToast = ui.toast; const priorSend = ui.send; const priorAct = ui.act;
  ui.toast = (message, undo) => { priorToast(message, undo); toasts.toast(message, undo); };
  Object.assign(ui, makeSend(ui, () => store));
  const top = topBar(shell);
  const stage = h("div", { class: "stage" });
  root.append(stage, toasts.el);

  const refresh = (): void => {
    if (ui.me.role !== "analyst") return;                // only an analyst may read the case list
    const mine = ++loads;
    ui.api.cases().then((list) => {
      if (destroyed || mine !== loads) return;
      cases = list; casesStatus = "ready";
      view?.update();
      top.update();
    }).catch(() => {
      if (destroyed || mine !== loads) return;
      casesStatus = "failed";
      view?.update();
    });
  };

  const render = (): void => {
    if (destroyed) return;
    let next = parseRoute(win.location.hash);
    if (next.screen !== "home" && next.screen !== "soon" && ui.me.role !== "analyst") next = { screen: "home" };
    if (next.screen === "soon") { const wanted = next.mode; if (!MODES.some((m) => m.id === wanted)) next = { screen: "home" }; }
    const key = routeHash(next);
    if (key === routeKey && view !== null) return;
    // a screen with work not saved may keep the person once: the address goes back to it
    if (view?.leave !== undefined && !view.leave()) { win.location.hash = routeKey; return; }
    routeKey = key; route = next;
    view?.destroy?.(); view = null;
    toasts.dropUndo();                       // an Undo belongs to the case it was made in
    handlers = {};
    if (next.screen === "case") {
      if (store === null || store.id !== next.id) {
        dropStore();
        const s = new CaseStore(next.id);
        store = s;
        stopFollow = follow(s, ui.api.entries, win);
        const watch = (): void => {
          // the server says the case is not loaded (it was unloaded, here or elsewhere): say so and go to the list, instead of reconnecting
          if (s.connection === "gone") {
            if (store !== s || destroyed) return;
            nav.go({ screen: "pick" });
            ui.toast(s.live.seq > 0 ? `${s.id} was unloaded to the case store` : `${s.id} is not loaded`);
            return;
          }
          top.update();
        };
        stopWatch = s.subscribe(watch);
        if (s.connection === "gone") void Promise.resolve().then(watch);   // said while opening: acted on once this render is done
      }
      // an address with an entry (a probe's link to its child, slice 14): replay the case there once that entry has arrived
      stopSeek?.(); stopSeek = null;
      const at = next.at;
      if (at !== undefined) {
        const s = store!;
        const seek = (): boolean => { if (s.live.seq < at) return false; s.goTo(at); return true; };
        if (!seek()) { const off = s.subscribe(() => { if (seek()) { off(); stopSeek = null; } }); stopSeek = off; }
      }
    } else dropStore();
    switch (next.screen) {
      case "home": view = homeView(shell); break;
      case "pick": view = pickView(shell); break;
      case "new": view = newView(shell, next.loop); break;
      case "store": view = caseStoreView(shell); break;
      case "soon": view = soonView(shell, next.mode); break;
      case "loops": view = loopsView(shell); break;
      case "loop": view = loopView(shell, next.id); break;
      case "loop_edit": view = loopEditView(shell, next.id); break;
      case "memory": view = memoryView(shell); break;
      case "case": view = (opts.caseScreen ?? caseScreenFor(ui))({ store: store!, nav }, (hs) => { handlers = hs; }); break;
    }
    clear(stage);
    stage.appendChild(view.el);
    if (next.screen === "home") top.el.remove(); else if (top.el.parentElement === null) root.insertBefore(top.el, stage);
    top.update();
    refresh();
    view.focus?.();
  };

  const onHash = (): void => render();
  const inText = (t: EventTarget | null): boolean => {
    const tag = (t as HTMLElement | null)?.tagName?.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select";
  };
  const helpHost = h("div", { class: "help-host" });
  root.appendChild(helpHost);
  const help = makeHelp(ui, helpHost);
  /** The four keys of "anywhere", and whatever the case screen in front adds. */
  const actions = (): Record<string, () => void> => ({
    ...handlers.actions,
    help: () => help.toggle(),
    command_bar: () => { (root.querySelector("[aria-label=Command]") as HTMLElement | null)?.focus(); },
    up: () => { if (help.close()) return; if (handlers.escape?.() === true) return; nav.up(); },
    next_thing: () => {
      const next = store === null ? null : nextThing(store.live);
      if (next === null) return;
      if ("lens" in next) { nav.openLens(next.lens, AT_GATE); return; }
      if (next.command === "resume") { void ui.act("resume"); return; }
      // A gate is passed only by its own button in its lens: the key takes you there.
      const lens = next.command === "approve" ? "narrative" : "steps";
      nav.openLens(lens, AT_GATE);
      ui.toast(next.command === "approve" ? "Approve the draft from the Narrative lens" : "Accept the plan from the Steps lens");
      (root.querySelector(`.lens-dock [data-action=${next.command}]:not([disabled])`) as HTMLElement | null)?.focus();
    },
  });
  const onKey = (e: Event): void => {
    const k = e as KeyboardEvent;
    if (k.defaultPrevented) return;                        // a view or a drag took it
    if (help.isOpen()) {                                   // the card is modal: only its own keys work
      if (k.ctrlKey || k.metaKey || k.altKey || inText(k.target)) return;
      if (k.key === "Tab") { k.preventDefault(); help.trap(k.shiftKey); }
      else if (k.key === "Escape" || k.key === "?") { k.preventDefault(); help.close(); }
      return;
    }
    const target = k.target as Element | null;
    if (k.key === "Escape" && !inText(target) && target !== null && typeof target.closest === "function") {
      const home = target.closest("[data-card], .lane, [data-area]") as HTMLElement | null;
      if (home !== null && home !== target) home.focus();  // a button in a card: back to the card first
    }
    if (dispatchKey(k, actions())) k.preventDefault();
  };
  win.addEventListener("hashchange", onHash);
  doc.addEventListener("keydown", onKey);
  render();

  return {
    actions,
    destroy() {
      destroyed = true;
      help.destroy();
      win.removeEventListener("hashchange", onHash);
      doc.removeEventListener("keydown", onKey);
      view?.destroy?.(); view = null;
      dropStore();
      toasts.destroy();
      ui.toast = priorToast; ui.send = priorSend; ui.act = priorAct;
      clear(root);
    },
  };
}
