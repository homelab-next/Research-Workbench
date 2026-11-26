import { beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { makeS } from "../../src/web/svg";
import type { S } from "../../src/web/svg";

let s: S;
beforeEach(() => { s = makeS(new Window().document as unknown as Document); });

test("elements are in the SVG namespace and text goes in as text nodes", () => {
  const el = s("text", { x: 1, y: 2 }, "<b>x</b>", 3);
  expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg"); expect(el.childNodes.length).toBe(2); expect(el.querySelector("b")).toBeNull(); expect(el.textContent).toBe("<b>x</b>3");
});
test("a tag outside the list throws", () => { for (const t of ["script", "foreignObject", "a", "use", "image", "style", "div"]) expect(() => s(t)).toThrow(`s: tag not allowed: ${t}`); });
test("a prop outside the list throws", () => { for (const k of ["style", "href", "d", "fill", "stroke", "onclick", "xlink:href"]) expect(() => s("g", { [k]: "x" } as never)).toThrow(`s: prop not allowed: ${k}`); });
test("a number attribute must be a finite number and is written with at most two decimals", () => {
  expect(s("rect", { x: 1.23456, width: 10 }).getAttribute("x")).toBe("1.23");
  for (const v of [Number.NaN, Infinity, "5" as never, null as never]) expect(() => s("rect", { x: v })).toThrow("s: x must be a finite number");
});
test("viewBox, translate, anchor and stretch are built from their parts", () => {
  const el = s("svg", { viewBox: [0, 0, 1000, 20], stretch: true });
  expect(el.getAttribute("viewBox")).toBe("0 0 1000 20"); expect(el.getAttribute("preserveAspectRatio")).toBe("none");
  expect(s("g", { translate: [1.5, 2] }).getAttribute("transform")).toBe("translate(1.5 2)");
  expect(s("text", { anchor: "middle" }).getAttribute("text-anchor")).toBe("middle"); expect(() => s("text", { anchor: "left" as never })).toThrow();
});
test("points become a path's d and are refused on any other tag", () => {
  expect(s("path", { points: [[0, 0], [10, 5.555]] }).getAttribute("d")).toBe("M 0 0 L 10 5.56"); expect(() => s("line", { points: [[0, 0]] })).toThrow("s: points is for path only");
});
test("name, hidden, role, tabindex, data and aria are written as on the HTML helper; a name starting on is refused", () => {
  const el = s("g", { name: "Address 198.51.100.77", hidden: true, role: "button", tabindex: -1, data: { key: "a|b" }, aria: { expanded: "false" } });
  expect([el.getAttribute("aria-label"), el.getAttribute("aria-hidden"), el.getAttribute("tabindex"), el.getAttribute("data-key")]).toEqual(["Address 198.51.100.77", "true", "-1", "a|b"]);
  expect(() => s("g", { data: { onclick: "x" } })).toThrow(); expect(() => s("g", { aria: { "bad name": "x" } })).toThrow();
});
test("a listener must be a function and is called", () => {
  let n = 0;
  const el = s("g", { on: { click: () => { n++; } } });
  el.dispatchEvent(new (el.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event("click"));
  expect(n).toBe(1);
  expect(() => s("g", { on: { click: "x" as never } })).toThrow("s: handler for click is not a function");
});
test("an attribute value that looks like markup stays an attribute value", () => {
  const el = s("g", { name: '"><script>' });
  expect(el.getAttribute("aria-label")).toBe('"><script>'); expect(el.children.length).toBe(0); expect(el.attributes.length).toBe(1);
  expect(el.outerHTML).toContain("&quot;");   // the quote is escaped, so the value cannot end its attribute
});
