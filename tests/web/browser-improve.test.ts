import { afterEach, expect, test } from "bun:test";
import { findChrome, launch } from "../helpers/chrome";
import { served } from "../helpers/served";

// Task 19 in a real browser: a person sets a known answer on the sample's published product, and it is there after a reload. Nothing passes a gate.
const chrome = findChrome();
const NONE = "browser run skipped: no Chromium found (set WORKBENCH_CHROME)";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length > 0) await closers.pop()!(); });

const TEXT = "A printer on the guest network, set up by the help desk <b>not markup</b>.";

async function theAnswer(path: string): Promise<void> {
  const s = await served({ listen: true });
  closers.push(() => s.close());
  const id = await s.newCase();
  await s.toPublishGate(id);
  expect((await s.command(id, "approve")).status).toBe(200);
  await s.app.hub.idle();
  expect(s.app.hub.read(id).state.published.length).toBe(1);
  const gates = (): string[] => s.entries(id).filter((e) => e.type === "gate.passed" || e.type === "product.published").map((e) => `${e.type}:${e.seq}`);
  const passedBefore = gates();

  const browser = await launch(path);
  closers.push(() => browser.close());
  const tab = await browser.tab(`${s.origin}/#/case/${id}`);
  // no slide-in: a click lands where the control is
  await tab.reducedMotion(true);
  const text = (selector: string): Promise<string> => tab.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`);
  const choose = (selector: string, value: string): Promise<unknown> =>
    tab.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const openNarrative = async (): Promise<void> => {
    await tab.waitFor(`document.querySelector("[data-area=incoming]") !== null`);
    await tab.press("r");
    await tab.waitFor(`document.querySelector(".lens-narrative .known-answer") !== null`);
    // the bundle's file list is read after the head is drawn: once it is there nothing above the form moves
    await tab.waitFor(`document.querySelector(".lens-narrative .draft-head a[href*='/published/1/']") !== null`);
  };
  await openNarrative();

  await tab.click(".known-answer-form summary");
  await tab.waitFor(`document.querySelector(".known-answer-form").open`);
  await tab.click(".known-answer [aria-label='Known answer text']");
  await tab.type(TEXT);
  await tab.click(".known-answer [aria-label='Claim 1']");
  await tab.type("the device is a printer");
  await choose(".known-answer [aria-label='Likelihood 1']", "very likely");
  await choose(".known-answer [aria-label='Confidence 1']", "high");
  await tab.waitFor(`!document.querySelector(".known-answer [data-action=save-answer]").disabled`);
  await tab.click(".known-answer [data-action=save-answer]");
  await tab.waitFor(`document.querySelector(".known-answer .known-answer-text") !== null`);
  await s.app.hub.idle();
  expect(s.entries(id).filter((e) => e.type === "answer.known").length).toBe(1);

  // after a reload the answer is there, drawn as text, with who set it
  await tab.evaluate(`(window.__before = 1, setTimeout(() => location.reload(), 0), true)`);
  await tab.waitFor(`window.__before === undefined && document.readyState === "complete"`);
  await openNarrative();
  await tab.waitFor(`document.querySelector(".known-answer .known-answer-text") !== null`);
  expect(await text(".known-answer .known-answer-text")).toBe(TEXT);
  expect(await tab.evaluate<number>(`document.querySelectorAll(".known-answer b").length`)).toBe(0);
  expect(await text(".known-answer .known-answer-findings li")).toBe("the device is a printer · very likely · high confidence");
  expect(await text(".known-answer .known-answer-by")).toStartWith(`Set by ${s.config.user} at `);
  expect(await text(".known-answer-form summary")).toBe("Change the known answer");

  // Improve this loop on the loop's page; this workbench has no improve loop, so the server refuses, the refusal is beside the button and nothing navigates
  const caseCount = async (): Promise<number> => ((await (await s.get("/api/cases")).json()) as unknown[]).length;
  const cases = await caseCount();
  await tab.evaluate(`(location.hash = "#/loops/investigation", true)`);
  await tab.waitFor(`document.querySelector("[data-screen=loop] .improve-form [data-action=improve]") !== null`);
  expect(await text(".improve-form h2")).toBe("Improve this loop");
  await tab.click(".improve-form [data-action=improve]");
  await tab.waitFor(`document.querySelector(".improve-form .refusal") !== null`);
  expect(await text(".improve-form .refusal")).toStartWith("Refused: there is no usable improve loop here");
  expect(await tab.evaluate<string>("location.hash")).toBe("#/loops/investigation");
  expect(await caseCount()).toBe(cases);

  // what the page is, in the browser that enforces it; and the answer passed no gate
  expect(await tab.evaluate<number>(`document.querySelectorAll("script:not([src]), style, [style], [onclick]").length`)).toBe(0);
  expect(tab.requests().filter((u) => !u.startsWith(s.origin))).toEqual([]);
  // the one refused request the browser logs is the improve request this test made to be refused
  expect(tab.problems().filter((m) => !(m.includes("409 (Conflict)") && m.endsWith("/api/improve")))).toEqual([]);
  expect(gates()).toEqual(passedBefore);
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
}

if (chrome === null) {
  if (process.env.WORKBENCH_REQUIRE_BROWSER === "1") test("a known answer set in a browser is there after a reload", () => { throw new Error(NONE); });
  else test.skip("a known answer set in a browser is there after a reload", () => {});
} else {
  test("a known answer set in a browser is there after a reload", async () => { await theAnswer(chrome); }, 120_000);
}
