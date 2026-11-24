import type { Marking } from "../core/types";
import type { Ui } from "./ui";

export type TagKind = "done" | "attention" | "agent" | "system" | "human";    // green, amber, violet, blue, neutral

/** A small pill: the colour carries meaning, the text always says it too. */
export function tag(ui: Ui, kind: TagKind, text: string, tooltip?: string): HTMLElement {
  return ui.h("span", { class: `tag tag-${kind}`, title: tooltip }, text);
}

/** TLP:AMBER+STRICT is drawn as amber; the chip still reads the whole marking. */
const tlpClass = (marking: Marking): string => `tlp-${marking.slice(4).split("+")[0]!.toLowerCase()}`;

/** The full marking text, always. */
export function markingChip(ui: Ui, marking: Marking): HTMLElement {
  return ui.h("span", { class: `chip marking ${tlpClass(marking)}`, title: `Handling marking ${marking}` }, marking);
}

/** A button reading the card id; activating it calls onOpen. Dashed when `proposed`. */
export function cardChip(ui: Ui, card: string, onOpen: (card: string) => void, proposed = false): HTMLElement {
  return ui.h("button", { type: "button", class: proposed ? "chip card-chip proposed" : "chip card-chip", title: `Open ${card}`, on: { click: () => onOpen(card) } }, card);
}
