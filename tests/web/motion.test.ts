import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { flip } from "../../src/web/motion";
import { testUi } from "../helpers/dom";
import { page } from "../helpers/dom";

const css = readFileSync(new URL("../../src/web/style.css", import.meta.url), "utf8");

function rig(reduced: boolean) {
  const win = new Window({ url: "http://127.0.0.1:1/" });
  const ui = testUi(win, { reducedMotion: () => reduced });
  const doc = ui.doc;
  const a = doc.createElement("div"); const b = doc.createElement("div");
  doc.body.append(a, b);
  let moved = false;
  const rect = (top: number) => ({ top, left: 0, width: 100, height: 20, bottom: top + 20, right: 100, x: 0, y: top });
  (a as unknown as { getBoundingClientRect(): unknown }).getBoundingClientRect = () => rect(moved ? 200 : 0);
  (b as unknown as { getBoundingClientRect(): unknown }).getBoundingClientRect = () => rect(50);          // does not move
  const calls: { el: unknown; frames: unknown; options: unknown }[] = [];
  for (const el of [a, b]) (el as unknown as { animate: unknown }).animate = (frames: unknown, options: unknown) => { calls.push({ el, frames, options }); return { finished: Promise.resolve() }; };
  let changed = 0;
  flip(ui, () => [a, b], () => { changed++; moved = true; });
  return { calls, changed, a, b };
}

test("flip slides moved elements, and with reduced motion only makes the change", () => {
  const moving = rig(false); const still = rig(true);
  expect(moving.changed).toBe(1);
  expect(still.changed).toBe(1);
  expect(moving.calls.length).toBe(1);                          // b did not move, so it does not animate
  expect(moving.calls[0]!.el).toBe(moving.a);
  expect(JSON.stringify(moving.calls[0]!.frames)).toContain("-200px");
  expect((moving.calls[0]!.options as { duration: number }).duration).toBe(160);
  expect(still.calls.length).toBe(0);
});

test("an element that leaves slides out as a copy instead of vanishing", () => {
  const win = new Window({ url: "http://127.0.0.1:1/" });
  const ui = testUi(win, { reducedMotion: () => false });
  const el = ui.doc.createElement("div");
  ui.doc.body.appendChild(el);
  (el as unknown as { getBoundingClientRect(): unknown }).getBoundingClientRect = () => ({ top: 10, left: 5, width: 100, height: 20, bottom: 30, right: 105, x: 5, y: 10 });
  const animated: unknown[] = [];
  (ui.doc.body as unknown as { animate: unknown }).animate = () => ({ finished: Promise.resolve() });
  const proto = Object.getPrototypeOf(el) as { animate?: unknown };
  const had = proto.animate;
  proto.animate = function (this: unknown) { animated.push(this); return { finished: Promise.resolve() }; };
  try { flip(ui, () => [el], () => el.remove()); } finally { proto.animate = had; }
  expect(animated.length).toBe(1);
  expect(animated[0]).not.toBe(el);
});

test("the work area animates nothing under reduced motion", async () => {
  const calls: number[] = [];
  const watch = (q: Awaited<ReturnType<typeof page>>): void => {
    // happy-dom has an animate of its own, somewhere up the chain of each kind of element: count calls on every one that defines it
    for (const el of [q.q("[data-area=incoming]"), q.q("[data-card]")]) {
      for (let o = Object.getPrototypeOf(el) as object | null; o !== null; o = Object.getPrototypeOf(o) as object | null) {
        if (Object.hasOwn(o, "animate")) (o as { animate: unknown }).animate = () => { calls.push(1); return { finished: Promise.resolve() }; };
      }
    }
  };
  for (const reduced of [true, false]) {
    calls.length = 0;
    const q = await page({ reducedMotion: reduced });
    const id = await q.s.newCase();
    await q.s.toPublishGate(id);
    q.win.location.hash = `#/case/${id}`; await q.settle();
    watch(q);
    let n = 0;
    for (const el of q.all("[data-card]")) { let top = 0; (el as unknown as { getBoundingClientRect(): unknown }).getBoundingClientRect = () => ({ top: top += 7, left: 0, width: 10, height: 10, bottom: 0, right: 0, x: 0, y: 0 }); n++; }
    const first = q.q("[data-area=incoming] [data-card]"); first.focus();
    q.press("x"); await q.settle();
    if (reduced) expect(calls.length).toBe(0); else expect(calls.length).toBeGreaterThan(0);
    expect(n).toBeGreaterThan(0);
    await q.close();
  }
});

test("the stylesheet turns every transition and animation off under prefers-reduced-motion", () => {
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after\s*\{[^}]*transition: none !important;[^}]*animation: none !important;/);
});

test("only the trail and the drag line have transitions of their own, and none is decorative", () => {
  const rules = css.split("}").filter((r) => /transition\s*:/.test(r) && !/prefers-reduced-motion/.test(r));
  for (const r of rules) expect(r).toMatch(/\.(trail|pill|crumb|toast)/);
});
