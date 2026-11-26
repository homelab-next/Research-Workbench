import { syncList } from "../dom";
import type { LensId } from "../app";
import { LENSES } from "../lenses";
import type { Ui, View } from "../ui";

export type Dock = "bottom" | "right";

/** The shelf: one button per lens, reading its title and key letter, and the dock-side button. */
export function makeShelf(ui: Ui, on: { open(id: LensId): void; dock(): Dock; toggleDock(): void; current(): LensId | null }): View {
  const { h } = ui;
  const buttons = h("div", { class: "lens-buttons" });
  const side = h("button", { type: "button", class: "dock-side", title: "Dock the lens on the other side (V)", on: { click: () => on.toggleDock() } });
  const el = h("footer", { class: "shelf", name: "Lenses" }, buttons, side);
  return {
    el,
    update() {
      syncList(buttons, LENSES, (l) => l.id,
        (l) => h("button", { type: "button", class: l.soon === true ? "lens-button soon" : "lens-button", data: { lens: l.id }, on: { click: () => on.open(l.id) } }, `${l.title} ${l.key.toUpperCase()}${l.soon === true ? " · soon" : ""}`),
        (b, l) => { b.classList.toggle("active", on.current() === l.id); });
      side.textContent = on.dock() === "bottom" ? "Dock right" : "Dock bottom";
    },
  };
}
