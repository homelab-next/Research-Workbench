import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { cardChip, markingChip, tag } from "../../src/web/chips";
import type { TagKind } from "../../src/web/chips";
import { clear, fileLink, link, makeH, syncList, TAGS } from "../../src/web/dom";
import type { H, Props } from "../../src/web/dom";
import { makePrefs } from "../../src/web/prefs";
import { shortLocal, timeEl, utc } from "../../src/web/time";
import { testUi } from "../helpers/dom";

let win: Window;
let h: H;
let ui: ReturnType<typeof testUi>;
beforeEach(() => {
  win = new Window();
  h = makeH(win.document as unknown as Document);
  ui = testUi(win);
});
afterEach(async () => { await win.happyDOM.close(); });

test("a marking chip always reads the full marking", () => {
  expect(markingChip(ui, "TLP:AMBER+STRICT").textContent).toBe("TLP:AMBER+STRICT");
  expect(markingChip(ui, "TLP:AMBER+STRICT").className).toContain("tlp-amber");
  expect(markingChip(ui, "TLP:RED").className).toContain("tlp-red");
  expect(markingChip(ui, "TLP:GREEN").className).toContain("tlp-green");
  expect(markingChip(ui, "TLP:CLEAR").className).toContain("tlp-clear");
});

test("every tag has text as well as a colour class", () => {
  for (const kind of ["done", "attention", "agent", "system", "human"] as TagKind[]) {
    const t = tag(ui, kind, `is ${kind}`, "why");
    expect(t.textContent).toBe(`is ${kind}`);
    expect(t.className).toContain(kind);
    expect(t.getAttribute("title")).toBe("why");
  }
});

test("a card chip reads the card id, opens it, and is dashed when proposed", () => {
  const opened: string[] = [];
  const c = cardChip(ui, "C-3", (id) => { opened.push(id); }, true);
  expect([c.tagName, c.textContent, c.classList.contains("proposed")]).toEqual(["BUTTON", "C-3", true]);
  c.dispatchEvent(new win.Event("click") as unknown as Event);
  expect(opened).toEqual(["C-3"]);
  expect(cardChip(ui, "C-4", () => {}).classList.contains("proposed")).toBe(false);
});

test("timeEl shows UTC with milliseconds, or local time with UTC as the tooltip", () => {
  expect(timeEl(ui, "2026-11-23T20:02:11.482Z", "utc").textContent).toBe("2026-11-23T20:02:11.482Z");
  expect(utc("2026-11-23T20:02:11.482Z")).toBe("2026-11-23T20:02:11.482Z");
  const t = timeEl(ui, "2026-11-23T20:02:11.482Z", "local");
  expect(t.tagName).toBe("TIME");
  expect(t.getAttribute("title")).toBe("2026-11-23T20:02:11.482Z");
  expect(t.getAttribute("datetime")).toBe("2026-11-23T20:02:11.482Z");
  expect(shortLocal("2026-11-23T20:02:11.482Z", new Date("2026-11-23T21:00:00Z"), "UTC")).toBe("20:02");
  expect(shortLocal("2026-11-22T20:02:11.482Z", new Date("2026-11-23T21:00:00Z"), "UTC")).toBe("22 Nov 20:02");
});

test("prefs keep choices under rw: and survive a storage that throws", () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); } } as unknown as Storage;
  const p = makePrefs(storage);
  expect(p.get("lens", "timeline")).toBe("timeline");
  const isStr = (v: unknown): v is string => typeof v === "string";
  const isNums = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === "number");
  mem.set("rw:shape", JSON.stringify({ a: 1 }));
  expect(p.get("shape", "none", isStr)).toBe("none");
  mem.set("rw:shape", JSON.stringify("ok"));
  expect(makePrefs(storage).get("shape", "none", isStr)).toBe("ok");
  const memoryOnly = makePrefs(null);
  memoryOnly.set("n", ["x"]);
  expect(memoryOnly.get("n", [0], isNums)).toEqual([0]);
  p.set("lens", "graph");
  expect(mem.get("rw:lens")).toBe(JSON.stringify("graph"));
  expect(makePrefs(storage).get("lens", "x")).toBe("graph");
  mem.set("rw:bad", "{not json");
  expect(p.get("bad", 7)).toBe(7);
  const throwing = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } } as unknown as Storage;
  const q = makePrefs(throwing);
  q.set("a", 1);
  expect(q.get("a", 0)).toBe(1);
  const r = makePrefs(null);
  r.set("a", [1]);
  expect(r.get<number[]>("a", [])).toEqual([1]);
});
