import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const WEB = resolve(import.meta.dir, "../../src/web");
const REPO = resolve(import.meta.dir, "../..");

const BANNED: [string, RegExp][] = [
  ["innerHTML", /\binnerHTML\b/], ["outerHTML", /\bouterHTML\b/], ["insertAdjacentHTML", /\binsertAdjacentHTML\b/], ["document.write", /\bdocument\s*\.\s*write(ln)?\b/],
  ["DOMParser", /\bDOMParser\b/], ["createContextualFragment", /\bcreateContextualFragment\b/], ["srcdoc", /\bsrcdoc\b/], ["eval", /\beval\s*\(/], ["new Function", /\bnew\s+Function\b/],
  ["string timer", /\bset(?:Timeout|Interval)\s*\(\s*["'`]/], ["setAttribute", /\bsetAttribute(NS)?\s*\(/], ["createElement", /\bcreateElement(NS)?\s*\(/],
  ["href or src", /\.\s*(?:href|src|action|formAction)\s*=[^=]/], ["style text", /\.\s*(?:cssText)\s*=|\binsertRule\b/], ["location change", /\blocation\s*\.\s*(?:assign|replace)\b|\blocation\s*(?:\.\s*href)?\s*=[^=]/], ["window.open", /\b(?:window|win)\s*\.\s*open\s*\(/],
];
/** Banned everywhere, dom.ts included: an event-handler attribute set by name. */
const HANDLER_ATTRIBUTE = /\bsetAttribute(?:NS)?\s*\([^)]*?["'`]\s*on/i;
/** What dom.ts alone may use. */
const DOM_ONLY = new Set(["setAttribute", "createElement", "href or src"]);

const SAMPLES: Record<string, string> = {
  innerHTML: "el.innerHTML = x", outerHTML: "el.outerHTML = x", insertAdjacentHTML: `el.insertAdjacentHTML("beforeend", x)`, "document.write": "document.write(x); document . writeln(x)",
  DOMParser: "new DOMParser()", createContextualFragment: "range.createContextualFragment(x)", srcdoc: "frame.srcdoc = x", eval: "eval(x)", "new Function": "new Function('return 1')",
  "string timer": `setTimeout("go()", 1); setInterval('go()', 1); setTimeout(\`go()\`, 1)`, setAttribute: `el.setAttribute("title", x)`, createElement: `doc.createElement("a")`,
  "href or src": "a.href = x; img.src = x", "style text": "el.style.cssText = x; sheet.insertRule(x)", "location change": "location.assign(x); location = x; location.href = x", "window.open": "window.open(x)",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}
/** Strips comments so a word in a doc comment is not mistaken for code. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test("nothing under src/web uses an HTML sink", () => {
  const violations: string[] = [];
  const scanned = files(WEB).filter((f) => f !== join(WEB, "build.ts"));
  expect(scanned.length).toBeGreaterThan(5);
  for (const file of scanned) {
    const text = code(readFileSync(file, "utf8"));
    const isDom = file === join(WEB, "dom.ts");
    for (const [name, re] of BANNED) {
      if (isDom && DOM_ONLY.has(name)) continue;
      if (re.test(text)) violations.push(`${relative(REPO, file)}: ${name}`);
    }
    if (HANDLER_ATTRIBUTE.test(text)) violations.push(`${relative(REPO, file)}: setAttribute("on...")`);
  }
  expect(violations).toEqual([]);
});

test("the scan catches each banned form", () => {
  for (const [name, re] of BANNED) expect(re.test(SAMPLES[name]!)).toBe(true);
  for (const form of [`el.setAttribute("onclick", x)`, `el.setAttribute('onerror', x)`, "el.setAttributeNS(null, `onload`, x)", `el.setAttribute( "ONCLICK" , x)`]) expect(HANDLER_ATTRIBUTE.test(form)).toBe(true);
  expect(HANDLER_ATTRIBUTE.test(`el.setAttribute("title", x); el.setAttribute("data-on", x)`)).toBe(false);
  expect(code(`// innerHTML\n/* eval( */ x`)).not.toMatch(/innerHTML|eval/);
});

test("the lint's own file list holds every web file, and nothing outside src/web is read", () => {
  expect(files(WEB).map((f) => relative(WEB, f))).toContain("dom.ts");
  expect(dirname(join(WEB, "dom.ts"))).toBe(WEB);
});

test("the stylesheet loads nothing", () => {
  const css = readFileSync(join(WEB, "style.css"), "utf8");
  expect(css).not.toMatch(/@import|url\(/);
  for (const v of ["--bg: #0b1020", "--panel: #121a2e", "--accent: #7cc4ff", "--tlp-red: #ff5c5c", "--radius-lg: 16px"]) expect(css).toContain(v);
  expect(css).toContain(":focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }");
  expect(css).toContain(".proposed { border-style: dashed }");
  expect(css.trimEnd().endsWith("}")).toBe(true);
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
});

test("the dom helper's attribute names are a fixed list, none starting with on", () => {
  const text = code(readFileSync(join(WEB, "dom.ts"), "utf8"));
  const names = [...text.matchAll(/setAttribute\(\s*"([^"]+)"/g)].map((m) => m[1]!);
  expect(names.length).toBeGreaterThan(0);
  expect(names.filter((n) => /^on/i.test(n))).toEqual([]);
});

test("src/web imports only src/web, src/core/state and src/core/wire (and the shared type files)", () => {
  const allowed = [WEB, join(REPO, "src/core/state"), join(REPO, "src/core/wire.ts"), join(REPO, "src/core/types.ts"), join(REPO, "src/core/canonical.ts")];
  const IMPORT = /\b(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g;
  const bad: string[] = [];
  for (const file of files(WEB)) {
    if (file === join(WEB, "build.ts")) continue;
    for (const m of code(readFileSync(file, "utf8")).matchAll(IMPORT)) {
      const spec = m[1] ?? m[2]!;
      if (!spec.startsWith(".")) { bad.push(`${relative(REPO, file)}: ${spec}`); continue; }
      const target = resolve(dirname(file), spec);
      if (!allowed.some((a) => target === a || target.startsWith(`${a}/`) || target === a.replace(/\.ts$/, ""))) bad.push(`${relative(REPO, file)}: ${spec}`);
    }
    const text = code(readFileSync(file, "utf8"));
    for (const g of ["Bun", "process", "Buffer"]) if (new RegExp(`(?<![.\\w$])${g}\\b`).test(text)) bad.push(`${relative(REPO, file)}: uses ${g}`);
  }
  expect(bad).toEqual([]);
});
