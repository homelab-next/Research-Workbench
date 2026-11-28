import { afterEach, expect, test } from "bun:test";
import { findChrome, launch } from "../helpers/chrome";
import { served } from "../helpers/served";
import { writeLoopFile, writeTriage } from "../helpers/loop-files";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";

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

  // the home tile counts the usable loops (investigation, triage and the sample's unknown-device), and opens the list
  await tab.waitFor(`(document.querySelector("[data-mode=loops] .count")?.textContent ?? "") === "3 usable"`);
  await tab.click("[data-mode=loops]");
  await tab.waitFor(`document.querySelectorAll(".loop-tile").length === 4 && document.querySelector(".loop-tile[data-loop=triage] .stages")?.textContent === "Frame → Investigate"`);
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

/** The sample's own triage loop, from the home screen to a finished parent: the person's only gate actions are the child's, by the child's own buttons. */
async function theTriage(path: string): Promise<void> {
  const s = await served({ listen: true });
  closers.push(() => s.close());
  const browser = await launch(path);
  closers.push(() => browser.close());
  const tab = await browser.tab(`${s.origin}/#/`);
  const text = (selector: string): Promise<string> => tab.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`);
  const ready = (selector: string): Promise<void> => tab.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
  const typeInto = async (selector: string, what: string): Promise<void> => {
    await tab.click(selector);
    await tab.evaluate(`document.querySelector(${JSON.stringify(selector)}).select?.()`);
    await tab.type(what);
  };
  const choose = (selector: string, value: string): Promise<unknown> =>
    tab.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const GATES = new Set(["gate.passed", "plan.accepted", "product.published"]);

  // Loops, open Triage, expand Investigate: it runs the investigation loop
  await tab.waitFor(`(document.querySelector("[data-mode=loops] .count")?.textContent ?? "") === "3 usable"`);
  await tab.click("[data-mode=loops]");
  await tab.waitFor(`document.querySelector(".loop-tile[data-loop=triage] .stages")?.textContent === "Sort → Investigate"`);
  await tab.click(".loop-tile[data-loop=triage] [data-action=open-loop]");
  await tab.waitFor(`location.hash === "#/loops/triage" && document.querySelectorAll(".loop-stages > li").length === 2`);
  expect(await text(".stage[data-stage=sort] .stage-line")).toBe("1. Sort · runs agent · on pass → Investigate");
  await tab.click(".stage[data-stage=investigate] > summary");
  await tab.waitFor(`document.querySelector(".stage[data-stage=investigate]").open && document.querySelector(".stage[data-stage=investigate] .subloop").checkVisibility()`);
  expect(await text(".stage[data-stage=investigate] [data-action=open-subloop]")).toBe("investigation");

  // New case from this loop, filled in and started
  await tab.click("[data-screen=loop] [data-action=new-from-loop]");
  await tab.waitFor(`location.hash === "#/investigate/new/triage" && document.querySelector(".loop-line")?.textContent === "Loop: Triage"`);
  await ready("[aria-label=Title]");
  await typeInto("[aria-label=Title]", "Report of traffic to 198.51.100.77");
  await typeInto("[aria-label='What was asked']", "Who is behind the traffic to 198.51.100.77?");
  await typeInto("[aria-label=Why]", "a report to sort");
  await choose("[aria-label='Starting type 1']", SAMPLE_START.type);
  await typeInto("[aria-label='Starting value 1']", SAMPLE_START.value);
  await typeInto("[aria-label='Window from']", SAMPLE_WINDOW.from ?? "");
  await typeInto("[aria-label='Window to']", SAMPLE_WINDOW.to ?? "");
  await choose("[aria-label=Objective]", "sample-objective");
  await choose("[aria-label=Marking]", "TLP:GREEN");
  await tab.click(".primary");

  // the parent says it waits on its child, once, with a way to open it
  await tab.waitFor(`location.hash === "#/case/CASE-1" && (document.querySelector(".pause-child [data-action=open-child]")?.textContent ?? "") === "Open CASE-2"`);
  expect(await text(".pause-child .paused")).toStartWith("Paused: waiting on child CASE-2: ");
  expect(await tab.evaluate<number>(`document.body.textContent.split("waiting on child CASE-2:").length - 1`)).toBe(1);
  await tab.click(".pause-child [data-action=open-child]");
  await tab.waitFor(`location.hash === "#/case/CASE-2" && (document.querySelector(".topbar [data-action=open-parent]")?.textContent ?? "") === "child of CASE-1"`);

  // the child's plan gate, passed by its own button
  await tab.waitFor(`(document.querySelector(".stage-button[data-stage=plan]")?.textContent ?? "").includes("◌ waiting")`);
  await tab.click(".next-thing");
  await ready(".lens-steps .plan");
  await tab.click("[aria-label='Budget for s3, in lookups']");
  await tab.type("1");
  await tab.waitFor(`!document.querySelector("[data-action=accept_plan]").disabled`);
  await tab.click("[data-action=accept_plan]");

  // its publish gate, passed by its own Approve
  await tab.waitFor(`(document.querySelector(".stage-button[data-stage=publish]")?.textContent ?? "").includes("◌ waiting")`);
  await tab.waitFor(`(document.querySelector(".next-thing")?.textContent ?? "") === "Review the draft"`);
  await tab.click(".next-thing");
  await tab.evaluate(`document.activeElement.blur()`);
  await tab.press("Enter", { shift: true });
  await tab.waitFor(`document.activeElement?.dataset?.action === "approve" && !document.activeElement.disabled`);
  await tab.click(".lens-dock [data-action=approve]");
  await tab.waitFor(`(document.querySelector(".lens .draft-head")?.textContent ?? "").includes("Published as product 1")`);

  // back in CASE-1: the run is finished, and what came back is in Incoming
  await s.app.hub.idle();
  expect(s.app.hub.read("CASE-1").state.run).toMatchObject({ status: "finished", outcome: "completed" });
  const returned = s.entries("CASE-1").flatMap((e) => (e.type === "card.created" && (e.payload as { card: { from?: unknown } }).card.from !== undefined ? [(e.payload as { card: { id: string } }).card.id] : []));
  expect(returned.length).toBeGreaterThan(0);
  await tab.click(".topbar [data-action=open-parent]");
  await tab.waitFor(`location.hash === "#/case/CASE-1"`);
  await tab.waitFor(`document.querySelector(".pause-child") === null && document.querySelector(".brief .stop")?.disabled === true`);
  await tab.waitFor(`${JSON.stringify(returned)}.every((id) => document.querySelector("[data-area=incoming] [data-card=" + id + "]") !== null)`);

  // nothing but the person passed a gate, and only in the child
  for (const id of ["CASE-1", "CASE-2"]) for (const e of s.entries(id).filter((x) => GATES.has(x.type))) expect(e.actor).toEqual({ kind: "human", id: s.config.user });
  expect(s.entries("CASE-1").some((e) => GATES.has(e.type))).toBe(false);
  expect(await tab.evaluate<number>(`document.querySelectorAll("script:not([src]), style, [style], [onclick]").length`)).toBe(0);
  expect(tab.requests().filter((u) => !u.startsWith(s.origin))).toEqual([]);
  expect(tab.problems()).toEqual([]);
  for (const c of s.wb.listCases()) expect(s.app.hub.read(c.id).state.skipped).toEqual([]);
}

/** Copy the sample's Triage as triage-2, change one field of Sort in the forms, and save it as the copy's next version. */
async function copyTriage(path: string): Promise<void> {
  const s = await served({ listen: true });
  closers.push(() => s.close());
  const browser = await launch(path);
  closers.push(() => browser.close());
  const tab = await browser.tab(`${s.origin}/#/loops/triage`);
  const fill = async (selector: string, value: string): Promise<void> => {
    await tab.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select(); })()`);
    await tab.type(value);
  };
  await tab.waitFor(`document.querySelector("[data-screen=loop] [data-action=copy]") !== null`);
  await tab.click("[data-screen=loop] [data-action=copy]");
  await fill("[aria-label=\"Copy's id\"]", "triage-2");
  await fill("[aria-label=\"Copy's title\"]", "Triage 2");
  await tab.click("[data-action=make-copy]");
  await tab.waitFor(`location.hash === "#/loops/triage-2/edit" && document.querySelectorAll(".stage-edit").length === 2`);
  // nothing is moved; Sort's turn cap is set to 4
  await fill(".stage-edit[data-stage=sort] [data-field=max_turns]", "4");
  await tab.evaluate(`document.querySelector(".stage-edit[data-stage=sort] [data-field=max_turns]").dispatchEvent(new Event("change", { bubbles: true }))`);
  await tab.click("[data-action=save]");
  await tab.waitFor(`(document.querySelector(".loop-form .said")?.textContent ?? "").startsWith("Saved as version 2 · ")`);
  await tab.evaluate(`location.hash = "#/loops"`);
  await tab.waitFor(`location.hash === "#/loops" && (document.querySelector(".loop-tile[data-loop=triage-2] .version")?.textContent ?? "").startsWith("v2 · ")`);
  // the saved copy runs the same two stages, Sort now with its turn cap of 4; the sample's triage is untouched
  const copy = (await (await s.get("/api/loops/triage-2")).json()) as { draft: { stages: { id: string; max_turns?: number }[] } };
  expect(copy.draft.stages.map((x) => [x.id, x.max_turns ?? null])).toEqual([["sort", 4], ["investigate", null]]);
  expect(((await (await s.get("/api/loops/triage")).json()) as { draft: { stages: { max_turns?: number }[] } }).draft.stages[0]!.max_turns).toBeUndefined();
  expect(tab.requests().filter((u) => !u.startsWith(s.origin))).toEqual([]);
  expect(tab.problems()).toEqual([]);
}

const TRIAGE = "from the home screen: Loops, open Triage, expand Investigate and see that it runs the investigation loop; New case from this loop; start; the case says waiting on child CASE-2; Open CASE-2; accept its plan; approve; back in CASE-1 the run is finished and the returned cards are in Incoming";
const COPY = "copy Triage as triage-2, move nothing, set Sort's max_turns to 4, Save: the Loops list shows triage-2 at version 2";
const RUNS: [string, (path: string) => Promise<void>][] = [["the loops and a child case in a browser", theLoops], [TRIAGE, theTriage], [COPY, copyTriage]];
for (const [name, run] of RUNS) {
  if (chrome === null) {
    if (process.env.WORKBENCH_REQUIRE_BROWSER === "1") test(name, () => { throw new Error(NONE); });
    else test.skip(name, () => {});
  } else {
    test(name, async () => { await run(chrome); }, 120_000);
  }
}
