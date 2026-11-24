import { clear } from "./dom";
import type { Ui } from "./ui";

/** Task 5 fills this in. */
export function startApp(ui: Ui, root: HTMLElement): { destroy(): void } {
  root.appendChild(ui.h("main", null, ui.h("h1", null, "Workbench")));
  return { destroy() { clear(root); } };
}
