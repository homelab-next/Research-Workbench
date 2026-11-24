import type { CaseState } from "../core/state";
import type { Open } from "./app";
import type { Ui } from "./ui";

export type DropTarget = { kind: "lane"; lane: string } | { kind: "card"; card: string; half: "upper" | "lower" } | { kind: "incoming" } | { kind: "cite"; section: string };
export const DRAG_PX = 5;

/** The half of `rect` that `y` falls in. */
export function half(y: number, rect: { top: number; height: number }): "upper" | "lower" {
  return y < rect.top + rect.height / 2 ? "upper" : "lower";
}

/** What a card dropped on `target` does: the command and its arguments, or null for a drop that does nothing (onto itself; onto Incoming from Incoming; a card or lane that is not there). */
export function dropCommand(state: CaseState, card: string, target: DropTarget): { command: string; args: Record<string, unknown> } | null {
  const c = Object.hasOwn(state.cards, card) ? state.cards[card]! : null;
  if (c === null || c.place === "discarded") return null;
  const fromLane = c.place === "lane";
  const toLane = (lane: string, indexIn: (others: string[]) => number): { command: string; args: Record<string, unknown> } | null => {
    const l = state.lanes.find((x) => x.id === lane);
    if (l === undefined) return null;
    const others = l.cards.filter((id) => id !== card);
    const index = Math.max(0, Math.min(indexIn(others), others.length));
    if (!fromLane) return { command: "keep", args: { card, lane, index: index } };
    if (c.lane === lane && l.cards.indexOf(card) === index) return null;
    return { command: "move", args: { card, lane, index } };
  };
  switch (target.kind) {
    case "incoming": return fromLane ? { command: "send_back", args: { card } } : null;
    case "cite": return null;
    case "lane": {
      const hit = toLane(target.lane, (others) => others.length);
      // Dropping on a lane keeps it at the end; from Incoming the server's own default (no index) is the end too.
      return hit !== null && hit.command === "keep" ? { command: "keep", args: { card, lane: target.lane } } : hit;
    }
    case "card": {
      if (target.card === card) return null;
      const t = Object.hasOwn(state.cards, target.card) ? state.cards[target.card]! : null;
      if (t === null || t.place === "discarded") return null;
      if (t.place === "incoming") return fromLane ? { command: "send_back", args: { card } } : null;
      return toLane(t.lane!, (others) => others.indexOf(target.card) + (target.half === "lower" ? 1 : 0));
    }
  }
}

/** The drop target an element stands for, by its data-drop: "lane", "card", "incoming" or "cite". */
function targetOf(el: Element | null, y: number): { target: DropTarget; el: HTMLElement } | null {
  const zone = el !== null && typeof el.closest === "function" ? (el.closest("[data-drop]") as HTMLElement | null) : null;
  if (zone === null) return null;
  const d = zone.dataset;
  switch (d.drop) {
    case "lane": return d.lane === undefined ? null : { target: { kind: "lane", lane: d.lane }, el: zone };
    case "card": return d.card === undefined ? null : { target: { kind: "card", card: d.card, half: half(y, zone.getBoundingClientRect()) }, el: zone };
    case "incoming": return { target: { kind: "incoming" }, el: zone };
    case "cite": return d.section === undefined ? null : { target: { kind: "cite", section: d.section }, el: zone };
    default: return null;
  }
}

/** Wires pointerdown/move/up on [data-card] under `root`. A press that moves less than 5 px is a click. While dragging, the element under the pointer with data-drop decides the target, and a line (class "drop-line") shows where a card would land. Returns what takes it all down. */
export function enableDrag(ui: Ui, root: HTMLElement, open: Open, onDrop: (card: string, target: DropTarget) => void): () => void {
  const { doc, h } = ui;
  let press: { card: string; el: HTMLElement; x: number; y: number } | null = null;
  let dragging = false;
  let line: HTMLElement | null = null;

  const showLine = (hit: { target: DropTarget; el: HTMLElement } | null): void => {
    const would = hit !== null && press !== null && open.store.at === null && (hit.target.kind === "cite" || dropCommand(open.store.live, press.card, hit.target) !== null) ? hit : null;
    if (would === null) { line?.remove(); line = null; return; }
    if (line === null) { line = h("div", { class: "drop-line" }); doc.body.appendChild(line); }
    const r = would.el.getBoundingClientRect();
    const t = would.target;
    const inCard = t.kind === "card";
    const y = inCard ? (t.half === "upper" ? r.top : r.top + r.height) : r.top + r.height;
    line.style.setProperty("top", `${y}px`);
    line.style.setProperty("left", `${r.left}px`);
    line.style.setProperty("width", `${r.width}px`);
  };
  const stop = (): void => {
    doc.removeEventListener("pointermove", move);
    doc.removeEventListener("pointerup", up);
    doc.removeEventListener("pointercancel", cancel);
    doc.removeEventListener("keydown", key, true);
    ui.win.removeEventListener("blur", cancel);
    doc.removeEventListener("visibilitychange", hide);
    press?.el.classList.remove("dragging");
    line?.remove(); line = null; press = null; dragging = false;
  };
  const swallowClick = (): void => {
    const eat = (e: Event): void => { e.stopPropagation(); e.preventDefault(); };
    root.addEventListener("click", eat, true);
    setTimeout(() => root.removeEventListener("click", eat, true), 0);
  };
  const at = (e: MouseEvent): HTMLElement | null => (typeof doc.elementFromPoint === "function" ? (doc.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null) : null);
  function move(ev: Event): void {
    const e = ev as MouseEvent;
    if (press === null) return;
    if (dragging && e.buttons === 0) { cancel(); return; }   // the release happened where we could not hear it
    if (!dragging) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_PX) return;
      dragging = true;
      press.el.classList.add("dragging");
    }
    showLine(targetOf(at(e), e.clientY));
  }
  function up(ev: Event): void {
    const e = ev as MouseEvent;
    if (press === null) return;
    if (!dragging) { stop(); return; }
    const card = press.card;
    const hit = targetOf(at(e), e.clientY);
    stop(); swallowClick();
    if (hit !== null) onDrop(card, hit.target);
  }
  function cancel(): void { if (dragging) swallowClick(); stop(); }
  function hide(): void { if (doc.visibilityState === "hidden") cancel(); }
  function key(ev: Event): void {
    const e = ev as KeyboardEvent;
    if (e.key !== "Escape") return;
    e.preventDefault(); e.stopPropagation();
    cancel();
  }
  const down = (ev: Event): void => {
    const e = ev as MouseEvent;
    if (press !== null || (typeof e.button === "number" && e.button !== 0)) return;
    const target = e.target as Element | null;
    const el = target !== null && typeof target.closest === "function" ? (target.closest("[data-card]") as HTMLElement | null) : null;
    if (el === null || !root.contains(el) || el.dataset.card === undefined) return;
    if ((target as Element).closest("button, select, input, textarea, a, [role=toolbar]") !== null) return;
    press = { card: el.dataset.card, el, x: e.clientX, y: e.clientY };
    doc.addEventListener("pointermove", move);
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", cancel);
    doc.addEventListener("keydown", key, true);
    ui.win.addEventListener("blur", cancel);
    doc.addEventListener("visibilitychange", hide);
  };
  root.addEventListener("pointerdown", down);
  return () => { stop(); root.removeEventListener("pointerdown", down); };
}
