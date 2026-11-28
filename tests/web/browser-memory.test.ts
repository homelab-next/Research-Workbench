import { afterEach, expect, test } from "bun:test";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { findChrome, launch } from "../helpers/chrome";
import { served } from "../helpers/served";

// Slice 13 in a real browser, on the sample as it ships: the Memory page lists the sample's two seed lessons under Unknown device as proposals;
// the person accepts one and it reads as shared; a new case from the Unknown device loop shows the loop's case type on its form; the case's
// Memory lens takes a note and lists it. Every string is drawn as text, under the page's own policy.
const chrome = findChrome();
const NONE = "browser run skipped: no Chromium found (set WORKBENCH_CHROME)";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length > 0) await closers.pop()!(); });

const NOTE = "AP-3 is in the lobby <b>by the desk</b>.";

async function theMemory(path: string): Promise<void> {
  const s = await served({ listen: true });
  closers.push(() => s.close());
  expect(s.problems).toEqual([]);
  const browser = await launch(path);
  closers.push(() => browser.close());
  const tab = await browser.tab(`${s.origin}/#/memory`);
  const text = (selector: string): Promise<string> => tab.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`);
  const typeInto = async (selector: string, what: string): Promise<void> => {
    await tab.click(selector);
    await tab.evaluate(`document.querySelector(${JSON.stringify(selector)}).select?.()`);
    await tab.type(what);
  };
  const choose = (selector: string, value: string): Promise<unknown> =>
    tab.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);

  // the Memory page: the two seeds, under Unknown device, waiting for a person
  const group = ".memory-group[data-type=unknown-device]";
  await tab.waitFor(`document.querySelectorAll(${JSON.stringify(`${group} details.lesson`)}).length === 2`);
  expect(await text(`${group} h2`)).toBe("Unknown device");
  for (const id of ["LESSON-1", "LESSON-2"]) expect(await text(`${group} details.lesson[data-lesson=${id}] > summary .status`)).toBe("proposed");
  expect(await text(`${group} details.lesson[data-lesson=LESSON-1] > summary`)).toContain("Read the connection message before the lease");
  // the person opens one and accepts it at its own marking
  await tab.click(`${group} details.lesson[data-lesson=LESSON-1] > summary`);
  await tab.waitFor(`document.querySelector(${JSON.stringify(`${group} details.lesson[data-lesson=LESSON-1]`)}).open`);
  await tab.click(`${group} details.lesson[data-lesson=LESSON-1] [data-action=accept]`);
  await tab.waitFor(`(document.querySelector(${JSON.stringify(`${group} details.lesson[data-lesson=LESSON-1] > summary .status`)})?.textContent ?? "") === "shared"`);
  expect(s.wb.memory.state.lessons["LESSON-1"]!.status).toBe("accepted");
  expect(s.wb.memory.state.lessons["LESSON-2"]!.status).toBe("proposed");
  expect(s.wb.memory.entries().find((e) => e.type === "lesson.accepted")!.actor).toEqual({ kind: "human", id: s.config.user });

  // a new case from the Unknown device loop: its form shows the loop's case type
  await tab.evaluate(`location.hash = "#/loops/unknown-device"`);
  await tab.waitFor(`document.querySelector("[data-screen=loop] [data-action=new-from-loop]") !== null`);
  await tab.click("[data-screen=loop] [data-action=new-from-loop]");
  await tab.waitFor(`location.hash === "#/investigate/new/unknown-device" && (document.querySelector("#nc-type")?.value ?? "") === "unknown-device"`);
  expect(await tab.evaluate<string>(`document.querySelector("#nc-type").selectedOptions[0].textContent`)).toBe("Unknown device");
  await typeInto("[aria-label=Title]", "A device in the lobby");
  await typeInto("[aria-label='What was asked']", "Who is behind the traffic to 198.51.100.77?");
  await typeInto("[aria-label=Why]", "a device nobody recognises");
  await choose("[aria-label='Starting type 1']", SAMPLE_START.type);
  await typeInto("[aria-label='Starting value 1']", SAMPLE_START.value);
  await typeInto("[aria-label='Window from']", SAMPLE_WINDOW.from ?? "");
  await typeInto("[aria-label='Window to']", SAMPLE_WINDOW.to ?? "");
  await choose("[aria-label=Objective]", "sample-objective");
  await choose("[aria-label=Marking]", "TLP:GREEN");
  await tab.click(".primary");
  await tab.waitFor(`location.hash === "#/case/CASE-1"`);
  expect(s.app.hub.read("CASE-1").state.memory.type).toBe("unknown-device");

  // the form started the run, which binds the shared lesson and stops at the plan gate; the page has drawn it before the person goes on
  await s.app.hub.idle();
  await tab.waitFor(`(document.querySelector(".stage-button[data-stage=plan]")?.textContent ?? "").includes("◌ waiting")`);
  expect(s.app.hub.read("CASE-1").state.memory.bound!.lessons.map((l) => l.lesson)).toEqual(["LESSON-1"]);

  // its Memory lens: the type and the lesson the run was given, then a note added and listed
  await tab.press("m");
  await tab.waitFor(`(document.querySelector(".lens-memory [data-part=type] .case-type")?.textContent ?? "") === "Unknown device"`);
  await tab.waitFor(`document.querySelectorAll(".lens-memory .loaded-lesson[data-lesson=LESSON-1]").length === 1`);
  expect(await text(".lens-memory .loaded-lesson .why")).toBe("Offered because: observable address is present");
  await typeInto(".lens-memory [data-field=note-text]", NOTE);
  await tab.click(".lens-memory [data-action=add-note]");
  await tab.waitFor(`document.querySelectorAll(".lens-memory .notes .note").length === 1`);
  expect(await text(".lens-memory .note[data-note=m1] .text")).toBe(NOTE);
  expect(await tab.evaluate<number>(`document.querySelectorAll(".lens-memory b").length`)).toBe(0);
  expect(await text(".lens-memory .note[data-note=m1] .who")).toBe(`noted by ${s.config.user}`);
  const noted = s.entries("CASE-1").filter((e) => e.type === "memory.noted");
  expect(noted.map((e) => [e.actor, (e.payload as { text: string }).text])).toEqual([[{ kind: "human", id: s.config.user }, NOTE]]);

  expect(await tab.evaluate<number>(`document.querySelectorAll("script:not([src]), style, [style], [onclick]").length`)).toBe(0);
  expect(tab.requests().filter((u) => !u.startsWith(s.origin))).toEqual([]);
  expect(tab.problems()).toEqual([]);
  await s.app.hub.idle();
  for (const c of s.wb.listCases()) expect(s.app.hub.read(c.id).state.skipped).toEqual([]);
  expect(s.wb.memory.state.skipped).toEqual([]);
}

const NAME = "the Memory page lists the sample's two seeds under Unknown device; accept one and it is shared; a case from the Unknown device loop shows its type on the form; its Memory lens takes a note and lists it";
if (chrome === null) {
  if (process.env.WORKBENCH_REQUIRE_BROWSER === "1") test(NAME, () => { throw new Error(NONE); });
  else test.skip(NAME, () => {});
} else {
  test(NAME, async () => { await theMemory(chrome); }, 120_000);
}
