import type { CardState } from "../../core/state";
import type { Open } from "../app";
import { markingChip, tag } from "../chips";
import type { TagKind } from "../chips";
import { cardStatus } from "../derive";
import { syncList } from "../dom";
import type { Ui, View } from "../ui";

/** The Discarded lens: cards the person set aside, newest first, each one a click from coming back to Incoming. */
export function makeDiscarded(ui: Ui, open: Open): View {
  const { h } = ui;
  const { store } = open;
  const list = h("div", { class: "discarded" });
  const empty = h("p", { class: "empty" }, "Nothing discarded.");
  const el = h("div", { class: "lens lens-discarded", name: "Discarded" }, list, empty);
  let seen: unknown = null;
  let readOnly = false;

  const tags = (c: CardState): HTMLElement[] => {
    const status = cardStatus(c);
    return [
      status === "partial" ? tag(ui, "attention", "partial") : status === "proven negative" ? tag(ui, "done", "proven negative") : status === "nothing found" ? tag(ui, "human", "nothing found") : null,
      tag(ui, c.made_by as TagKind, c.made_by), markingChip(ui, c.marking),
    ].filter((x): x is HTMLElement => x !== null);
  };
  const make = (c: CardState): HTMLElement =>
    h("div", { class: "discarded-row", data: { about: c.id } },
      h("span", { class: "title" }, c.title), " ", h("span", { class: "tags" }, tags(c)), " ",
      h("button", { type: "button", data: { action: "restore" }, title: "Put this card back in Incoming", on: { click: () => { void ui.act("restore", { card: c.id }); } } }, "Restore"));
  const paint = (n: HTMLElement): void => { (n.querySelector("[data-action=restore]") as HTMLButtonElement).disabled = store.at !== null; };

  return {
    el,
    update() {
      const state = store.shown;
      if (seen === state && readOnly === (store.at !== null)) return;
      seen = state;
      readOnly = store.at !== null;
      const cards = [...state.discarded].reverse().flatMap((id) => (Object.hasOwn(state.cards, id) ? [state.cards[id]!] : []));
      empty.hidden = cards.length > 0;
      syncList(list, cards, (c) => c.id, (c) => { const n = make(c); paint(n); return n; }, paint);
    },
  };
}
