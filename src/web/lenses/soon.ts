import type { Ui, View } from "../ui";

/** A lens that is not built yet: its title and one line on what it will be. */
export function makeSoon(ui: Ui, title: string, text: string): View {
  const { h } = ui;
  return { el: h("div", { class: "lens lens-soon", name: title }, h("p", { class: "soon-text" }, text)), update() {} };
}
