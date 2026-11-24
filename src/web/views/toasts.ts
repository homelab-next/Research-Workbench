import { clear } from "../dom";
import type { Ui } from "../ui";

export const TOAST_MS = 6000;

/** Bottom-centre messages. A toast leaves after six seconds or when dismissed; an action that can be undone carries an Undo button. */
export function makeToasts(ui: Pick<Ui, "h">): { el: HTMLElement; toast: Ui["toast"]; destroy(): void; dropUndo(): void } {
  const { h } = ui;
  // The page's own timers, not the window's: a test that waits for the window to go quiet must not wait six seconds for a toast to leave.
  const el = h("div", { class: "toasts", role: "status", aria: { live: "polite" } });
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const toast: Ui["toast"] = (message, undo) => {
    const item = h("div", { class: "toast" }, h("span", { class: "message" }, message));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const leave = (): void => { if (timer !== undefined) { clearTimeout(timer); timers.delete(timer); } item.remove(); };
    if (undo !== undefined) {
      item.appendChild(h("button", { type: "button", class: "undo", data: { action: "undo" }, on: { click: () => { undo.act(); leave(); } } }, undo.label));
    }
    item.appendChild(h("button", { type: "button", class: "dismiss", name: "Dismiss", on: { click: leave } }, "×"));
    if (undo !== undefined) item.classList.add("has-undo");
    el.appendChild(item);
    timer = setTimeout(leave, TOAST_MS);
    timers.add(timer);
  };
  const dropUndo = (): void => { for (const t of [...el.querySelectorAll(".has-undo")]) (t as HTMLElement).remove(); };
  return { el, toast, dropUndo, destroy() { for (const t of timers) clearTimeout(t); timers.clear(); clear(el); el.remove(); } };
}
