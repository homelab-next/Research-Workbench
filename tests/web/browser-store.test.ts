import { afterEach, expect, test } from "bun:test";
import { findChrome, launch } from "../helpers/chrome";
import { served } from "../helpers/served";

// Slice 11 in a real browser: a case open in a tab is unloaded, its stream ends saying so and the tab goes to the list; the Case store view draws
// a markup-looking title as text, and Load brings the case back and opens it. The page's own policy is in force throughout.
const chrome = findChrome();
const NONE = "browser run skipped: no Chromium found (set WORKBENCH_CHROME)";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length > 0) await closers.pop()!(); });

async function theStore(path: string): Promise<void> {
  const s = await served({ listen: true });
  closers.push(() => s.close());
  await s.newCase({ title: "<img src=x onerror=\"document.title='owned'\">", asked: "<b>who</b> is behind it?" });
  const open = await s.newCase({ title: "Sign-in burst" });
  expect((await s.post("/api/cases/CASE-1/unload", {})).status).toBe(200);

  const browser = await launch(path);
  closers.push(() => browser.close());
  const tab = await browser.tab(`${s.origin}/#/case/${open}`);
  const text = (selector: string): Promise<string> => tab.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`);
  await tab.waitFor(`document.querySelector("[data-screen=case]") !== null`);

  // unloaded while open: the stream's last word is "unloaded", so the tab says so and goes to the list, and does not sit reconnecting
  expect((await s.post(`/api/cases/${open}/unload`, {})).status).toBe(200);
  await tab.waitFor(`location.hash === "#/investigate" && document.querySelector("[data-screen=pick]") !== null`);
  await tab.waitFor(`[...document.querySelectorAll(".toast .message")].some((m) => m.textContent === "CASE-2 was unloaded to the case store")`);
  expect(await tab.evaluate<number>(`document.querySelectorAll(".connection").length`)).toBe(0);

  // the Case store: both files, the markup drawn as text
  await tab.click("[data-action=case-store]");
  await tab.waitFor(`document.querySelectorAll(".store-list[data-ready] .stored-case").length === 2`);
  expect(await text(".stored-case[data-id='CASE-1'] .title")).toBe("<img src=x onerror=\"document.title='owned'\">");
  expect(await text(".stored-case[data-id='CASE-1'] .asked")).toBe("<b>who</b> is behind it?");
  expect(await tab.evaluate<number>(`document.querySelectorAll("main img, main b").length`)).toBe(0);
  expect(await tab.evaluate<string>(`document.title`)).not.toBe("owned");

  // a search the server answers
  await tab.click("[aria-label='Search the case store']");
  await tab.type("burst");
  await tab.waitFor(`document.querySelector(".store-list").dataset.ready === "burst"`);
  expect(await tab.evaluate<string[]>(`[...document.querySelectorAll(".stored-case")].map((r) => r.dataset.id)`)).toEqual(["CASE-2"]);

  // Load opens the case again, and its record is the one that was unloaded, plus case.loaded
  await tab.click(".stored-case[data-id='CASE-2'] [data-action=load]");
  await tab.waitFor(`location.hash === "#/case/CASE-2" && document.querySelector("[data-screen=case]") !== null`);
  expect(s.app.hub.read("CASE-2").entries(0).at(-1)!.type).toBe("case.loaded");
  expect(s.app.hub.read("CASE-2").state.skipped).toEqual([]);
  await s.app.hub.idle();

  expect(await tab.evaluate<number>(`document.querySelectorAll("script:not([src]), style, [style], [onclick]").length`)).toBe(0);
  expect(tab.requests().filter((u) => !u.startsWith(s.origin))).toEqual([]);
  expect(tab.problems()).toEqual([]);
}

if (chrome === null) {
  if (process.env.WORKBENCH_REQUIRE_BROWSER === "1") test("the case store and an unloaded case in a browser", () => { throw new Error(NONE); });
  else test.skip("the case store and an unloaded case in a browser", () => {});
} else {
  test("the case store and an unloaded case in a browser", async () => { await theStore(chrome); }, 120_000);
}
