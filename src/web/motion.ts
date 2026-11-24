import type { Ui } from "./ui";

export const FLIP_MS = 160;

interface Box { top: number; left: number; width: number; height: number }
const boxOf = (el: HTMLElement): Box => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height }; };
const canAnimate = (el: HTMLElement): boolean => typeof (el as { animate?: unknown }).animate === "function";

/** First-Last-Invert-Play for the elements whose keys are given: records their boxes, runs `change`, then slides each from its old box to its new one in 160 ms. With reduced motion it only runs `change`. An element that no longer exists afterwards slides out as a copy. */
export function flip(ui: Ui, elements: () => HTMLElement[], change: () => void): void {
  if (ui.reducedMotion()) { change(); return; }
  const before = elements().filter(canAnimate).map((el) => ({ el, box: boxOf(el) }));
  change();
  for (const { el, box } of before) {
    if (!el.isConnected) {
      const ghost = el.cloneNode(true) as HTMLElement;
      ghost.classList.add("ghost");
      for (const [k, v] of [["position", "fixed"], ["top", `${box.top}px`], ["left", `${box.left}px`], ["width", `${box.width}px`], ["height", `${box.height}px`], ["pointer-events", "none"], ["margin", "0"]] as const) ghost.style.setProperty(k, v);
      ui.doc.body.appendChild(ghost);
      const run = canAnimate(ghost) ? ghost.animate([{ opacity: 1, transform: "translateX(0)" }, { opacity: 0, transform: "translateX(-24px)" }], { duration: FLIP_MS, easing: "ease-out" }) : null;
      if (run === null) ghost.remove(); else void run.finished.then(() => ghost.remove(), () => ghost.remove());
      continue;
    }
    const now = boxOf(el);
    const dx = box.left - now.left; const dy = box.top - now.top;
    if (dx === 0 && dy === 0) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration: FLIP_MS, easing: "ease-out" });
  }
}
