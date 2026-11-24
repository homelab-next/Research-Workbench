import { clear } from "../dom";
import { KEYMAP } from "../keys";
import type { Area } from "../keys";
import type { Ui } from "../ui";

const SECTIONS: readonly [Area, string][] = [["anywhere", "Anywhere"], ["incoming", "Incoming"], ["columns", "Columns"], ["lanes", "Lanes"], ["lenses", "Lenses"], ["replay", "Replay"]];
const SHOWN: Record<string, string> = { ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→" };

/** The "?" card, drawn from KEYMAP alone. It takes focus when it opens and gives it back when it closes. */
export function makeHelp(ui: Ui, host: HTMLElement): { open(): void; close(): boolean; toggle(): void; isOpen(): boolean; destroy(): void } {
  const { h, doc } = ui;
  let card: HTMLElement | null = null;
  let back: HTMLElement | null = null;
  const build = (): HTMLElement => h("div", { class: "help", role: "dialog", name: "Keys", tabindex: -1, aria: { modal: "true" } },
    h("h2", null, "Keys"),
    SECTIONS.map(([area, title]) => h("section", { class: "help-section" },
      h("h3", null, title),
      h("table", null, h("tbody", null, KEYMAP.filter((k) => k.area === area).map((k) =>
        h("tr", null, h("td", { class: "keys" }, k.keys.map((key, i) => [i > 0 ? " " : null, h("kbd", null, SHOWN[key] ?? key)])), h("td", null, k.label))))))),
    h("p", { class: "muted" }, "Esc closes this card"));
  const api = {
    isOpen: () => card !== null,
    open() {
      if (card !== null) return;
      back = doc.activeElement as HTMLElement | null;
      card = build();
      host.appendChild(card);
      card.focus();
    },
    close() {
      if (card === null) return false;
      card.remove(); card = null;
      const to = back; back = null;
      if (to !== null && to.isConnected) to.focus();
      return true;
    },
    toggle() { if (card === null) api.open(); else api.close(); },
    destroy() { if (card !== null) { card.remove(); card = null; } clear(host); },
  };
  return api;
}
