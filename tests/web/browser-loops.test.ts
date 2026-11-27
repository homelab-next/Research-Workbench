import { afterEach, expect, test } from "bun:test";
import { findChrome, launch } from "../helpers/chrome";
import { served } from "../helpers/served";
import { writeLoopFile, writeTriage } from "../helpers/loop-files";

// Slice 12 in a real browser: the Loops tile and list, a loop's outline opened stage by stage, a sub-loop's link, New case from this loop, Export,
// and a parent paused on its child with a way to open each from the other. A loop title that looks like markup is drawn as text, under the page's own policy.
const chrome = findChrome();
const NONE = "browser run skipped: no Chromium found (set WORKBENCH_CHROME)";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length > 0) await closers.pop()!(); });

const MARKUP = "<img src=x onerror=\"document.title='owned'\">";

async function theLoops(path: string): Promise<void> {
  const s = await served({
    listen: true,
    before: (root) => {
      writeTriage(root);
      // not usable (the frame stage's on_pass names a stage this loop does not have), and titled like markup
      writeLoopFile(root, "oddly", { title: MARKUP, about: "<b>bold</b> about", stages: ["frame"] });
    },
  });
  closers.push(() => s.close());
  const parent = await s.newCase({ loop: "triage" });
  expect((await s.command(parent, "start_run")).status).toBe(200);
  await s.app.hub.idle();

  const browser = await launch(path);
  closers.push(() => browser.close());
  const tab = await browser.tab(`${s.origin}/#/`);
  const text = (selector: string): Promise<string> => tab.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`);

  // the home tile counts the usable loops, and opens the list
  await tab.waitFor(`(document.querySelector("[data-mode=loops] .count")?.textContent ?? "") === "2 usable"`);
  await tab.click("[data-mode=loops]");
  await tab.waitFor(`document.querySelectorAll(".loop-tile").length === 3 && document.querySelector(".loop-tile[data-loop=triage] .stages")?.textContent === "Frame → Investigate"`);
  expect(await text(".loop-tile[data-loop=oddly] .head")).toBe(MARKUP);
  expect(await text(".loop-tile[data-loop=oddly] .about")).toBe("<b>bold</b> about");
  expect(await tab.evaluate<number>(`document.querySelectorAll(".loop-tile[data-loop=oddly] .problems li").length`)).toBeGreaterThan(0);
  expect(await tab.evaluate<number>(`document.querySelectorAll(".loop-tile[data-loop=oddly] [data-action=new-from-loop]").length`)).toBe(0);
  expect(await tab.evaluate<number>(`document.querySelectorAll("main img, main b").length`)).toBe(0);

  // the triage loop's outline: two stages; the sub-loop stage opens to its orchestration and links to the loop it runs
  await tab.click(".loop-tile[data-loop=triage] [data-action=open-loop]");
  await tab.waitFor(`location.hash === "#/loops/triage" && document.querySelectorAll(".loop-stages > li").length === 2`);
  expect(await text(".stage[data-stage=frame] .stage-line")).toBe("1. Frame · runs agent · on pass → Investigate");
  expect(await tab.evaluate<boolean>(`document.querySelector(".stage[data-stage=investigate]").open === false && document.querySelector(".stage[data-stage=investigate] .subloop").checkVisibility() === false`)).toBe(true);
  await tab.click(".stage[data-stage=investigate] > summary");
  await tab.waitFor(`document.querySelector(".stage[data-stage=investigate]").open && document.querySelector(".stage[data-stage=investigate] .subloop").checkVisibility()`);
  await tab.click(".stage[data-stage=investigate] [data-action=open-subloop]");
  await tab.waitFor(`location.hash === "#/loops/investigation" && document.querySelectorAll(".loop-stages > li").length === 9`);
  expect(await text(".stage[data-stage=evaluate] .stage-line")).toContain("6. Evaluate · runs agent · on pass → ");
  await tab.click(".stage[data-stage=research] > summary");
  await tab.waitFor(`document.querySelectorAll(".stage[data-stage=research] [data-group=context] .item .hash").length > 0`);

  // Export writes the file and names it; the list then shows it with what an import would do
  await tab.click("[data-screen=loop] [data-action=export]");
  await tab.waitFor(`(document.querySelector(".export-row .said")?.textContent ?? "").startsWith("Exported to investigation.v1.")`);
  // its download link is this server's, and answers the file as an attachment
  const href = await tab.evaluate<string>(`document.querySelector(".export-row a.download").getAttribute("href")`);
  expect(href).toMatch(/^\/api\/loop-files\/investigation\.v1\.[0-9a-f]{12}\.loop\.tar\.gz$/);
  expect(await tab.evaluate<string>(`fetch(${JSON.stringify(href)}).then((r) => r.status + " " + r.headers.get("content-disposition"))`)).toStartWith("200 attachment;");
  // New case from this loop goes to the form for it
  await tab.click("[data-screen=loop] [data-action=new-from-loop]");
  await tab.waitFor(`location.hash === "#/investigate/new/investigation" && document.querySelector(".loop-line")?.textContent === "Loop: Investigation"`);
  await tab.evaluate(`document.activeElement.blur()`);          // Escape in the title box keeps the form; from the page it steps up to the loop
  await tab.press("Escape");
  await tab.waitFor(`location.hash === "#/loops/investigation"`);
  await tab.press("Escape");
  await tab.waitFor(`location.hash === "#/loops" && document.querySelectorAll(".loop-file").length === 1`);
  expect(await text(".loop-file .plan")).toMatch(/^0 to write, \d+ already here$/);

  // the parent waits on its child: Open CASE-2 beside the reason, and the child's way back
  await tab.evaluate(`location.hash = "#/case/${parent}"`);
  await tab.waitFor(`(document.querySelector(".pause-child [data-action=open-child]")?.textContent ?? "") === "Open CASE-2"`);
  expect(await text(".pause-child .paused")).toStartWith("Paused: waiting on child CASE-2: ");
  expect(await tab.evaluate<number>(`document.body.textContent.split("waiting on child CASE-2:").length - 1`)).toBe(1);
  await tab.click(".pause-child [data-action=open-child]");
  await tab.waitFor(`location.hash === "#/case/CASE-2" && (document.querySelector(".topbar [data-action=open-parent]")?.textContent ?? "") === "child of CASE-1"`);
  await tab.click(".topbar [data-action=open-parent]");
  await tab.waitFor(`location.hash === "#/case/CASE-1"`);

  expect(await tab.evaluate<string>(`document.title`)).not.toBe("owned");
  expect(await tab.evaluate<number>(`document.querySelectorAll("script:not([src]), style, [style], [onclick]").length`)).toBe(0);
  expect(tab.requests().filter((u) => !u.startsWith(s.origin))).toEqual([]);
  expect(tab.problems()).toEqual([]);
  await s.app.hub.idle();
  for (const c of s.wb.listCases()) expect(s.app.hub.read(c.id).state.skipped).toEqual([]);
}

if (chrome === null) {
  if (process.env.WORKBENCH_REQUIRE_BROWSER === "1") test("the loops and a child case in a browser", () => { throw new Error(NONE); });
  else test.skip("the loops and a child case in a browser", () => {});
} else {
  test("the loops and a child case in a browser", async () => { await theLoops(chrome); }, 120_000);
}
