import { afterEach, expect, test } from "bun:test";
import { SAMPLE_START } from "../../scripts/make-sample-data";
import type { CaseSummaryView, StoreView } from "../../src/core/wire";
import { findChrome, launch } from "../helpers/chrome";
import type { Tab } from "../helpers/chrome";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

// Slice 11's acceptance in a real browser: a case unloaded from its tile's menu, found in the Case store by a starting value, loaded and
// replayed; and a case approved with "Unload after publishing" ticked, which leaves the list once its run has finished.
const chrome = findChrome();
const NONE = "browser run skipped: no Chromium found (set WORKBENCH_CHROME)";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length > 0) await closers.pop()!(); });

async function begin(path: string, url: (s: Served) => string, before: (s: Served) => Promise<void>): Promise<{ s: Served; tab: Tab }> {
  const s = await served({ listen: true });
  closers.push(() => s.close());
  await before(s);
  const browser = await launch(path);
  closers.push(() => browser.close());
  return { s, tab: await browser.tab(url(s)) };
}
const listed = async (s: Served): Promise<string[]> => ((await (await s.get("/api/cases")).json()) as CaseSummaryView[]).map((c) => c.id);
const inStore = async (s: Served): Promise<StoreView> => (await (await s.get("/api/store")).json()) as StoreView;
const text = (tab: Tab, selector: string): Promise<string> => tab.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`);
const clean = async (s: Served, tab: Tab): Promise<void> => {
  // a card that left the screen slides out as a copy for 160 ms (motion.ts); the page itself has no inline style
  await tab.waitFor(`document.querySelectorAll(".ghost").length === 0`);
  expect(await tab.evaluate<number>(`document.querySelectorAll("script:not([src]), style, [style], [onclick]").length`)).toBe(0);
  expect(tab.requests().filter((u) => !u.startsWith(s.origin))).toEqual([]);
  // nothing is logged, not even while the case was packed: the page does not read a case whose unload has begun
  expect(tab.problems()).toEqual([]);
};

async function unloadFindLoadReplay(path: string): Promise<void> {
  const { s, tab } = await begin(path, (x) => `${x.origin}/#/investigate`, async (x) => {
    await x.newCase({ title: "Traffic to the sample address" });
    await x.newCase({ title: "Another address", asked: "Who is behind the traffic to 203.0.113.50?", starting: [{ ...SAMPLE_START, value: "203.0.113.50" }] });
    // CASE-2 is put away first, so the search below has something to leave out
    expect((await x.post("/api/cases/CASE-2/unload", {})).status).toBe(200);
  });
  await tab.waitFor(`document.querySelector(".tile-menu[data-case='CASE-1']") !== null`);
  const total = s.entries("CASE-1").length;

  // the tile's menu: More, then Unload; the toast says where it went and the tile leaves the list
  await tab.click(".tile-menu[data-case='CASE-1'] summary");
  await tab.click(".tile-menu[data-case='CASE-1'] [data-action=unload]");
  await tab.waitFor(`[...document.querySelectorAll(".toast .message")].some((m) => m.textContent === "CASE-1 was unloaded to the case store")`);
  await tab.waitFor(`document.querySelector(".tile-menu[data-case='CASE-1']") === null`);
  expect(await listed(s)).toEqual([]);
  expect((await inStore(s)).cases.map((c) => c.id).sort()).toEqual(["CASE-1", "CASE-2"]);

  // the Case store, searched by the starting value: only the case that began with it
  await tab.click("[data-action=case-store]");
  await tab.waitFor(`document.querySelectorAll(".store-list[data-ready] .stored-case").length === 2`);
  await tab.click("[aria-label='Search the case store']");
  await tab.type(SAMPLE_START.value);
  await tab.waitFor(`document.querySelector(".store-list").dataset.ready === ${JSON.stringify(SAMPLE_START.value)}`);
  expect(await tab.evaluate<string[]>(`[...document.querySelectorAll(".stored-case")].map((r) => r.dataset.id)`)).toEqual(["CASE-1"]);
  expect(await text(tab, ".stored-case[data-id='CASE-1'] .title")).toBe("Traffic to the sample address");

  // Load opens it; its record is the one unloaded, then case.unloaded and case.loaded
  await tab.click(".stored-case[data-id='CASE-1'] [data-action=load]");
  await tab.waitFor(`location.hash === "#/case/CASE-1" && document.querySelector("[data-screen=case]") !== null`);
  const entries = s.entries("CASE-1");
  expect(entries.length).toBe(total + 2);
  expect(entries.slice(total).map((e) => e.type)).toEqual(["case.unloaded", "case.loaded"]);
  expect(s.app.hub.read("CASE-1").state.skipped).toEqual([]);

  // replayed from entry 0 to its head
  const head = entries.length;
  await tab.waitFor(`document.querySelector("[data-area=incoming]") !== null`);
  await tab.evaluate(`document.activeElement?.blur?.()`);
  await tab.press("e");
  await tab.waitFor(`document.querySelector(".lens-replay") !== null`);
  const goTo = async (n: number): Promise<void> => {
    await tab.click("[aria-label='Go to entry']");
    await tab.evaluate(`document.querySelector("[aria-label='Go to entry']").select()`);
    await tab.type(String(n));
    await tab.press("Enter");
    await tab.waitFor(`(document.querySelector(".replay-head")?.textContent ?? "").startsWith(${JSON.stringify(`Replay · entry ${n} of ${head}`)})`);
  };
  await goTo(0);
  await goTo(1);
  expect(await text(tab, ".replay-head")).toContain(`${entries[0]!.ts}`);
  await goTo(head - 1);
  expect(await text(tab, ".replay-what")).toContain("unloaded");
  await tab.click("[aria-label='Next entry']");
  await tab.waitFor(`(document.querySelector(".replay-head")?.textContent ?? "").startsWith(${JSON.stringify(`Replay · entry ${head} of ${head}`)})`);
  expect(await text(tab, ".replay-what")).toContain("loaded");
  await tab.click("[aria-label=Live]");
  await tab.waitFor(`document.querySelector(".replay-head") === null || !(document.querySelector(".replay-head").textContent ?? "").startsWith("Replay · entry")`);
  await s.app.hub.idle();
  await clean(s, tab);
}

async function tickAndApprove(path: string): Promise<void> {
  const { s, tab } = await begin(path, (x) => `${x.origin}/#/case/CASE-1`, async (x) => {
    const id = await x.newCase();
    await x.toPublishGate(id);
  });
  await tab.waitFor(`document.querySelector("[data-area=incoming]") !== null`);
  await tab.evaluate(`document.activeElement?.blur?.()`);
  await tab.press("r");
  await tab.waitFor(`document.querySelector("[data-action=unload-after]") !== null && !document.querySelector("[data-action=approve]").disabled`);
  // off by default (the setting is keep); ticking it sends nothing and writes nothing
  expect(await tab.evaluate<boolean>(`document.querySelector("[data-action=unload-after]").checked`)).toBe(false);
  const before = s.entries("CASE-1").length;
  await tab.click("[data-action=unload-after]");
  await tab.waitFor(`document.querySelector("[data-action=unload-after]").checked === true`);
  // a round trip through the server after the tick, so anything the tick had sent would have arrived
  expect(await tab.evaluate<number>(`fetch("/api/me").then((r) => r.status)`)).toBe(200);
  await s.app.hub.idle();
  expect(s.entries("CASE-1").length).toBe(before);

  await tab.click("[data-action=approve]");
  // the run publishes and finishes, the workbench unloads the case, and the page goes to the list saying so
  await tab.waitFor(`location.hash === "#/investigate" && document.querySelector("[data-screen=pick]") !== null`, 60_000);
  await tab.waitFor(`[...document.querySelectorAll(".toast .message")].some((m) => m.textContent === "CASE-1 was unloaded to the case store")`);
  await s.app.hub.idle();
  expect(await listed(s)).toEqual([]);
  const stored = (await inStore(s)).cases;
  expect(stored.map((c) => [c.id, c.outcome, c.published, c.loaded])).toEqual([["CASE-1", "published", 1, false]]);
  await tab.waitFor(`document.querySelector(".tile-menu[data-case='CASE-1']") === null`);
  await clean(s, tab);
}

const CASES: [string, (path: string) => Promise<void>][] = [
  ["in a real browser: unload a case from its menu, find it in the Case store by a starting value, load it, and replay it from entry 0 to its head", unloadFindLoadReplay],
  ["in a real browser: tick Unload after publishing, approve, and the page goes to the list once the run has finished; the store has the case", tickAndApprove],
];
for (const [name, run] of CASES) {
  if (chrome === null) {
    if (process.env.WORKBENCH_REQUIRE_BROWSER === "1") test(name, () => { throw new Error(NONE); });
    else test.skip(name, () => {});
  } else {
    test(name, async () => { await run(chrome); }, 120_000);
  }
}
