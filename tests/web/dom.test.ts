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

test("text with markup in it is shown as text", () => {
  const evil = `<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>`;
  const el = h("div", { title: evil }, evil);
  expect(el.children.length).toBe(0);
  expect(el.textContent).toBe(evil);
  expect(el.getAttribute("title")).toBe(evil);
  expect((win as unknown as { pwned?: number }).pwned).toBeUndefined();
});

test("h refuses a tag or a prop it does not know", () => {
  for (const t of ["script", "iframe", "a", "style", "object", "img"]) expect(() => h(t)).toThrow();
  expect(() => h("div", { onclick: "x" } as unknown as Props)).toThrow();
  expect(() => h("div", { href: "x" } as unknown as Props)).toThrow();
  expect(TAGS).toContain("div");
  expect(TAGS).not.toContain("script");
});

test("h sets the props it knows and nests children, skipping empty ones", () => {
  let clicks = 0;
  const el = h("button", { class: "x", id: "b", name: "Go", current: true, disabled: true, data: { k: "v" }, aria: { expanded: "false" }, on: { click: () => { clicks++; } } },
    "a", 2, null, undefined, false, [h("span", null, "in"), ["deep"]]);
  expect([el.className, el.id, el.getAttribute("aria-label"), el.getAttribute("aria-current"), el.getAttribute("data-k"), el.getAttribute("aria-expanded")]).toEqual(["x", "b", "Go", "true", "v", "false"]);
  expect(el.hasAttribute("disabled")).toBe(true);
  expect(el.textContent).toBe("a2indeep");
  el.dispatchEvent(new win.Event("click") as unknown as Event);
  expect(clicks).toBe(1);
  expect(() => h("div", { on: { "bad": 1 as unknown as () => void } })).toThrow();
});

test("a link is made only for https", () => {
  const a = link(h, "https://example.net/a?b=1", "report");
  expect([a.tagName, a.getAttribute("rel"), a.getAttribute("target"), a.getAttribute("href")]).toEqual(["A", "noopener noreferrer", "_blank", "https://example.net/a?b=1"]);
  for (const bad of ["http://example.net", "javascript:alert(1)", " javascript:alert(1)", "data:text/html,x", "//example.net", "/api/me", "file:///etc/passwd", "https:", "\u0000https://example.net", ""]) {
    const s = link(h, bad, "label");
    expect([s.tagName, s.textContent]).toEqual(["SPAN", "label"]);
  }
});

test("a file link is made only for this server's blobs and bundles", () => {
  expect(fileLink(h, `/api/cases/CASE-1/blobs/${"a".repeat(64)}`, "raw").tagName).toBe("A");
  expect(fileLink(h, "/api/cases/CASE-1/published/1/product.md", "product").tagName).toBe("A");
  for (const bad of ["https://example.net/x", "/api/cases/CASE-1/published/../../x", "/api/me", "//example.net/api/cases/CASE-1/blobs/aa", "javascript:alert(1)"]) expect(fileLink(h, bad, "x").tagName).toBe("SPAN");
});

test("syncList reuses nodes by key, follows the new order and keeps focus", () => {
  const doc = win.document as unknown as Document;
  const parent = h("ul");
  doc.body.append(parent);
  const made: string[] = [];
  const updated: string[] = [];
  const make = (i: { k: string; t: string }): HTMLElement => { made.push(i.k); return h("li", { data: { k: i.k } }, h("button", null, i.t)); };
  const update = (el: HTMLElement, i: { k: string; t: string }): void => { updated.push(i.k); el.querySelector("button")!.textContent = i.t; };
  const key = (i: { k: string }): string => i.k;
  syncList(parent, [{ k: "a", t: "A" }, { k: "b", t: "B" }, { k: "c", t: "C" }], key, make, update);
  const nodes = [...parent.children];
  (nodes[1]!.querySelector("button") as HTMLElement).focus();
  expect(doc.activeElement).toBe(nodes[1]!.querySelector("button"));
  made.length = 0; updated.length = 0;
  syncList(parent, [{ k: "c", t: "C2" }, { k: "b", t: "B2" }, { k: "d", t: "D" }], key, make, update);
  expect(made).toEqual(["d"]);
  expect(updated.sort()).toEqual(["b", "c"]);
  expect([...parent.children].map((e) => e.getAttribute("data-k"))).toEqual(["c", "b", "d"]);
  expect(parent.children[0]).toBe(nodes[2]!);
  expect(parent.children[1]).toBe(nodes[1]!);
  expect(doc.activeElement).toBe(nodes[1]!.querySelector("button"));
  expect(parent.textContent).toBe("C2B2D");
  clear(parent);
  expect(parent.children.length).toBe(0);
});

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
