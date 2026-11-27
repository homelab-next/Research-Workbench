import { clear } from "../dom";
import { KEYMAP } from "../keys";
import type { Area } from "../keys";
import type { Ui } from "../ui";

const SECTIONS: readonly [Area, string][] = [["anywhere", "Anywhere"], ["incoming", "Incoming"], ["columns", "Columns"], ["lanes", "Lanes"], ["lenses", "Lenses"], ["replay", "Replay"]];
const SHOWN: Record<string, string> = { ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→" };

/** The "?" card, drawn from KEYMAP alone. It takes focus when it opens and gives it back when it closes. */
export function makeHelp(ui: Ui, host: HTMLElement): { open(): void; close(): boolean; trap(back: boolean): void; toggle(): void; isOpen(): boolean; destroy(): void } {
  const { h, doc } = ui;
  let card: HTMLElement | null = null;
  let back: HTMLElement | null = null;
  const build = (): HTMLElement => h("div", { class: "help", role: "dialog", name: "Keys", tabindex: -1, aria: { modal: "true" } },
    h("h2", null, "Keys"),
    SECTIONS.map(([area, title]) => h("section", { class: "help-section" },
      h("h3", null, title),
      h("table", null, h("tbody", null, KEYMAP.filter((k) => k.area === area).map((k) =>
        h("tr", null, h("td", { class: "keys" }, k.keys.map((key, i) => [i > 0 ? " " : null, h("kbd", null, SHOWN[key] ?? key)])), h("td", null, k.label))))))),
    h("p", { class: "command-words" }, h("code", null, "state <what you know>"), " in the command bar adds a statement of yours as a card in Incoming"),
    h("p", { class: "command-words" }, h("code", null, "answer ask-1 <your answer>"), " answers the question an agent put to you"),
    h("p", { class: "command-words" }, h("code", null, "overrule f1"), " opens the Narrative lens on that finding's Overrule form"),
    h("p", { class: "where-to" }, "Answer a question in Questions for you, under the brief. Overrule a finding with the Overrule button under it, in the Narrative lens or under Questions for you at the publish gate."),
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
    /** Tab and Shift+Tab stay inside the card: they walk its controls (it has none yet, so the card itself keeps focus). */
    trap(back: boolean) {
      if (card === null) return;
      const items = [...card.querySelectorAll("button, a, input, select, textarea, [tabindex='0']")] as HTMLElement[];
      if (items.length === 0) { card.focus(); return; }
      const at = items.indexOf(doc.activeElement as HTMLElement);
      items[at < 0 ? (back ? items.length - 1 : 0) : (at + (back ? -1 : 1) + items.length) % items.length]!.focus();
    },
    toggle() { if (card === null) api.open(); else api.close(); },
    destroy() { if (card !== null) { card.remove(); card = null; } clear(host); },
  };
  return api;
}
