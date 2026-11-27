import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findChrome, launch } from "../helpers/chrome";
import { served } from "../helpers/served";

// Task 13 in a real browser, over the real server and its save check: copy the sample's investigation, edit the copy in forms, check and save it,
// see a problem placed beside the stage it names, be asked once before leaving with changes, and edit the investigation itself, whose unedited
// stages stay references to their stage files. A stage title that looks like markup is only ever text, under the page's own policy.
const chrome = findChrome();
const NONE = "browser run skipped: no Chromium found (set WORKBENCH_CHROME)";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length > 0) await closers.pop()!(); });

const MARKUP = "<img src=x onerror=\"document.title='owned'\">";

async function theForms(path: string): Promise<void> {
  const s = await served({ listen: true });
  closers.push(() => s.close());
  const browser = await launch(path);
  closers.push(() => browser.close());
  const tab = await browser.tab(`${s.origin}/#/loops/investigation`);
  const text = (selector: string): Promise<string> => tab.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`);
  const fill = async (selector: string, value: string): Promise<void> => {
    await tab.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select(); })()`);
    await tab.type(value);
  };

  // Copy asks for an id and a title, then opens the copy's edit screen
  await tab.waitFor(`document.querySelector("[data-screen=loop] [data-action=copy]") !== null`);
  await tab.click("[data-screen=loop] [data-action=copy]");
  await fill("[aria-label=\"Copy's id\"]", "My Copy");
  await tab.click("[data-action=make-copy]");
  await tab.waitFor(`(document.querySelector(".copy-form .field-problem")?.textContent ?? "") === "An id is lower-case letters, digits and -"`);
  await fill("[aria-label=\"Copy's id\"]", "my-copy");
  await fill("[aria-label=\"Copy's title\"]", "My copy");
  await tab.click("[data-action=make-copy]");
  await tab.waitFor(`location.hash === "#/loops/my-copy/edit" && document.querySelectorAll(".stage-edit").length === 9`);

  // a stage title like markup, checked and saved: version 2
  await fill(".stage-edit[data-stage=research] [data-field=title]", MARKUP);
  expect(await text(".stage-edit[data-stage=research] .stage-name")).toBe(`3. ${MARKUP}`);
  await tab.click("[data-action=check]");
  await tab.waitFor(`(document.querySelector(".loop-form .said")?.textContent ?? "") === "No problems: this draft would save"`);
  await tab.click("[data-action=save]");
  await tab.waitFor(`(document.querySelector(".loop-form .said")?.textContent ?? "").startsWith("Saved as version 2 · ")`);

  // removing the plan stage leaves Frame's on pass on none, and the check says Research is not reached, beside Research
  await tab.click(".stage-edit[data-stage=plan] [data-action=remove]");
  await tab.waitFor(`document.querySelectorAll(".stage-edit").length === 8`);
  expect(await text(".stage-edit[data-stage=frame] .edge-note")).toBe("on pass named Plan, which was removed: it is none now");
  await tab.click("[data-action=check]");
  await tab.waitFor(`document.querySelectorAll(".stage-edit[data-stage=research] .problems li").length > 0`);
  expect(await text(".stage-edit[data-stage=research] .problems li")).toContain(`stage "research" is not reached from the entry "frame"`);

  // leaving with that change asks once; the second time it goes
  await tab.evaluate(`location.hash = "#/loops"`);
  await tab.waitFor(`location.hash === "#/loops/my-copy/edit" && document.querySelector(".leave-ask") !== null`);
  await tab.evaluate(`location.hash = "#/loops"`);
  await tab.waitFor(`location.hash === "#/loops" && document.querySelector("[data-screen=loops]") !== null`);
  await tab.waitFor(`(document.querySelector(".loop-tile[data-loop=my-copy] .version")?.textContent ?? "").startsWith("v2 · ")`);

  // the investigation itself: an edit of its about text keeps every stage a reference to its stage file
  await tab.evaluate(`location.hash = "#/loops/investigation"`);
  await tab.waitFor(`document.querySelector("[data-screen=loop] [data-action=edit]") !== null`);
  await tab.click("[data-screen=loop] [data-action=edit]");
  await tab.waitFor(`location.hash === "#/loops/investigation/edit" && document.querySelectorAll(".stage-edit").length === 9`);
  await fill("[aria-label=About]", "Edited in the forms.");
  await tab.click("[data-action=save]");
  await tab.waitFor(`(document.querySelector(".loop-form .said")?.textContent ?? "").startsWith("Saved as version 2 · ")`);
  const file = readFileSync(join(s.config.roots[0]!.path, "loops", "investigation.yaml"), "utf8");
  expect(file).toContain("\"Edited in the forms.\"");
  for (const id of ["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"]) expect(file).toContain(`- "${id}"`);
  expect(file).not.toContain("\"order\"");

  expect(await tab.evaluate<string>(`document.title`)).not.toBe("owned");
  expect(await tab.evaluate<number>(`document.querySelectorAll("main img").length`)).toBe(0);
  expect(await tab.evaluate<number>(`document.querySelectorAll("script:not([src]), style, [style], [onclick]").length`)).toBe(0);
  expect(tab.requests().filter((u) => !u.startsWith(s.origin))).toEqual([]);
  expect(tab.problems()).toEqual([]);
}

if (chrome === null) {
  if (process.env.WORKBENCH_REQUIRE_BROWSER === "1") test("building a loop in a browser", () => { throw new Error(NONE); });
  else test.skip("building a loop in a browser", () => {});
} else {
  test("building a loop in a browser", async () => { await theForms(chrome); }, 120_000);
}
