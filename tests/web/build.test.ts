import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildInterface } from "../../src/web/build";
import type { Assets } from "../../src/server/app";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

const SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Workbench</title><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>`;
let assets: Assets;
let s: Served | undefined;
beforeEach(async () => { assets = await buildInterface(); });
afterEach(async () => { await s?.close(); s = undefined; });

test("the bundle is browser code: no bun: or node: import, no Bun, process or Buffer", () => {
  expect(assets.js.length).toBeGreaterThan(100);
  expect(assets.js).not.toMatch(/from\s*["'](?:bun|node):/);
  expect(assets.js).not.toMatch(/\brequire\s*\(\s*["'](?:bun|node):/);
  for (const g of ["Bun", "process", "Buffer"]) expect(new RegExp(`(?<![.\\w$"'])${g}\\.`).test(assets.js)).toBe(false);
  expect(assets.js).not.toContain("happy-dom");
});

test("the page is the constant shell and holds no inline script or style", () => {
  expect(assets.html).toBe(SHELL);
  expect(assets.html).not.toMatch(/<script(?![^>]*\bsrc=)|<style|\sstyle=|\sonclick=/);
  expect(assets.css).not.toMatch(/@import|url\(/);
  expect(assets.css).toContain("--accent: #7cc4ff");
});

test("the server serves the page, the script and the stylesheet with their types, and a page policy that needs trusted types", async () => {
  s = await served();
  for (const [path, type, body] of [["/", "text/html; charset=utf-8", assets.html], ["/app.js", "text/javascript; charset=utf-8", assets.js], ["/app.css", "text/css; charset=utf-8", assets.css]] as const) {
    const res = await s.get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expect(await res.text()).toBe(body);
  }
  const csp = (await s.get("/")).headers.get("content-security-policy")!;
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("require-trusted-types-for 'script'");
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
});
