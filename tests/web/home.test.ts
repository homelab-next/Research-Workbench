import { afterEach, expect, test } from "bun:test";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";
import { parseRoute, routeHash } from "../../src/web/app";

let p: Page | null = null;
afterEach(async () => { await p?.close(); p = null; });
async function open(opts: Parameters<typeof page>[0] = {}): Promise<Page> { p = await page(opts); await p.settle(); return p; }
const two = async (q: Page): Promise<void> => {
  await q.s.newCase({ title: "Odd traffic", marking: "TLP:GREEN" });
  await q.s.newCase({ title: "Sign-in burst", marking: "TLP:AMBER" });
};

test("routes parse and print, and anything else is home", () => {
  for (const h of ["#/", "#/investigate", "#/investigate/new", "#/soon/hunt", "#/case/CASE-1"]) expect(routeHash(parseRoute(h))).toBe(h);
  expect(parseRoute("#/case/x")).toEqual({ screen: "home" });
  expect(parseRoute("")).toEqual({ screen: "home" });
  expect(parseRoute("#/nonsense/1")).toEqual({ screen: "home" });
  expect(parseRoute("#/case/CASE-4")).toEqual({ screen: "case", id: "CASE-4" });
});

test("an analyst's home has Do the work and Resources, with Investigate live and the rest soon", async () => {
  const p = await open();
  expect(p.q("[data-screen=home] h1").textContent).toBe("How can I help you today?");
  expect(p.all("[data-column] h2").map((e) => e.textContent)).toEqual(["Do the work", "Resources"]);
  expect(p.all("[data-column=work] button").map((e) => e.textContent)).toEqual(["Work ticketssoon", "Investigate0 open", "Huntsoon", "Actorssoon", "My folderssoon"]);
  expect(p.all("[data-column=resources] button").map((e) => e.getAttribute("aria-label"))).not.toContain("Priorities: soon");
  expect(p.q("[data-mode=hunt]").className).toContain("soon");
  expect(p.q("[aria-label=Command]").getAttribute("placeholder")).toBe("investigate CASE-1");
  expect(p.text()).toContain("Press ? for keys");
});

test("a requester's home has Get help only and no command input", async () => {
  const p = await open({ role: "requester" });
  expect(p.all("[data-column] h2").map((e) => e.textContent)).toEqual(["Get help"]);
  expect(p.all("[data-column=help] button").map((e) => e.textContent)).toEqual(["Ask for helpsoon", "My requestssoon", "Give feedbacksoon"]);
  expect(p.root.querySelector("[aria-label=Command]")).toBeNull();
});

test("a leader sees Resources with Priorities", async () => {
  const p = await open({ role: "leader" });
  expect(p.all("[data-column=resources] button").map((e) => e.textContent)).toEqual(["Strategysoon", "Requirementssoon", "Gapssoon", "Prioritiessoon"]);
});

test("the Investigate count is the cases whose run is not finished", async () => {
  const p = await open();
  await two(p);
  p.click("[data-mode=investigate]"); await p.settle();
  p.click(".trail .home"); await p.settle();
  expect(p.q("[data-mode=investigate]").textContent).toBe("Investigate2 open");
});

test("a soon tile opens an explanatory stage", async () => {
  const p = await open();
  p.click("[data-mode=hunt]");
  expect(p.q("[data-screen=soon] h1").textContent).toBe("Hunt");
  expect(p.text()).toContain("Not built yet. This part comes after the investigation slice.");
  expect(p.win.location.hash).toBe("#/soon/hunt");
});

test("which one? lists New investigation first, then cases newest first, and filters", async () => {
  const p = await open();
  await two(p);
  p.click("[data-mode=investigate]"); await p.settle();
  expect(p.q("h1").textContent).toBe("Investigate: which one?");
  expect(p.all(".tile").map((t) => t.getAttribute("aria-label")!.split(" · ")[0])).toEqual(["New investigation", "Sign-in burst", "Odd traffic"]);
  expect(p.q(".tile.proposed").textContent).toBe("+ New investigation");
  p.fill("[aria-label=Filter]", "amber");
  expect(p.all(".tile").length).toBe(2);
  p.fill("[aria-label=Filter]", "zzz");
  expect(p.text()).toContain("Nothing matches");
  expect(p.all(".tile").length).toBe(1);
  p.press("Escape");
  expect(p.all(".tile").length).toBe(3);
});

test("Enter in the filter opens the first match", async () => {
  const p = await open();
  await two(p);
  p.click("[data-mode=investigate]"); await p.settle();
  p.fill("[aria-label=Filter]", "odd");
  p.press("Enter");
  expect(p.win.location.hash).toBe("#/case/CASE-1");
});

test("a tile's accessible name is its full text, and its chips include the full marking", async () => {
  const p = await open();
  await p.s.newCase({ title: "A very long title that will be cut with an ellipsis on the tile but not in its name", marking: "TLP:AMBER+STRICT" });
  p.click("[data-mode=investigate]"); await p.settle();
  const t = p.all(".tile")[1]!;
  const name = t.getAttribute("aria-label")!;
  expect(name).toContain("A very long title that will be cut with an ellipsis on the tile but not in its name");
  expect(name).toContain("CASE-1 · not started · not started");
  expect(name).toContain("TLP:AMBER+STRICT");
  expect(t.getAttribute("title")).toBe(name);
  expect(t.querySelector(".marking")!.textContent).toBe("TLP:AMBER+STRICT");
  expect(t.textContent).toContain("0 incoming");
  expect(t.textContent).toContain("0 kept");
});

test("New investigation creates the case, starts the run and opens it", async () => {
  const p = await open();
  p.click("[data-mode=investigate]"); await p.settle();
  p.click(".tile.proposed");
  p.fill("[aria-label=Title]", "Odd traffic"); p.fill("[aria-label='What was asked']", "Who is behind the traffic to 198.51.100.77?"); p.fill("[aria-label=Why]", "test");
  p.fill("[aria-label='Starting value 1']", "198.51.100.77");
  p.fill("[aria-label='Window from']", "2026-11-17T00:00:00.000Z"); p.fill("[aria-label='Window to']", "2026-11-24T00:00:00.000Z");
  expect(p.q("button.primary").textContent).toBe("Create and frame the run");
  p.click("button.primary");
  await p.settle();
  expect(p.win.location.hash).toBe("#/case/CASE-1");
  expect(p.s.app.hub.read("CASE-1").state.run.waiting).toBe("plan");
});

test("the new-investigation form starts with a week's window, AMBER, and rows that add and remove", async () => {
  const p = await open();
  p.click("[data-mode=investigate]"); await p.settle();
  p.click(".tile.proposed");
  const from = (p.q("[aria-label='Window from']") as HTMLInputElement).value;
  const to = (p.q("[aria-label='Window to']") as HTMLInputElement).value;
  expect(from).toMatch(/^\d{4}-\d\d-\d\dT00:00:00\.000Z$/);
  expect(to).toMatch(/^\d{4}-\d\d-\d\dT00:00:00\.000Z$/);
  expect(Date.parse(to) - Date.parse(from)).toBe(8 * 86_400_000);
  expect((p.q("[aria-label=Marking]") as HTMLSelectElement).value).toBe("TLP:AMBER");
  expect(p.all("[aria-label=Objective] option")[0]!.textContent).toBe("None");
  expect(p.all("[aria-label^='Starting value']").length).toBe(1);
  p.click("[aria-label='Add a value']");
  expect(p.all("[aria-label^='Starting value']").length).toBe(2);
  p.click("[aria-label='Remove value 2']");
  expect(p.all("[aria-label^='Starting value']").length).toBe(1);
  expect(p.q("[aria-label='Remove value 1']").hasAttribute("disabled")).toBe(true);
});

test("a refused new case shows the reason and keeps the fields", async () => {
  const p = await open();
  p.click("[data-mode=investigate]"); await p.settle();
  p.click(".tile.proposed");
  p.fill("[aria-label=Title]", "Odd traffic"); p.fill("[aria-label='What was asked']", "q"); p.fill("[aria-label=Why]", "w");
  p.fill("[aria-label='Starting value 1']", "not-an-address");
  p.click("button.primary");
  await p.settle();
  expect(p.all(".refusals li").length).toBeGreaterThan(0);
  expect(p.q(".refusals").textContent!.length).toBeGreaterThan(5);
  expect((p.q("[aria-label=Title]") as HTMLInputElement).value).toBe("Odd traffic");
  expect((p.q("[aria-label='Starting value 1']") as HTMLInputElement).value).toBe("not-an-address");
  expect(p.win.location.hash).not.toContain("case");
  expect(await p.ui.api.cases()).toEqual([]);
});

test("the trail offers every level in one activation", async () => {
  const p = await open();
  await two(p);
  p.click("[data-mode=investigate]"); await p.settle();
  p.click(".tile:nth-child(3)"); await p.settle();            // Odd traffic, CASE-1
  expect(p.win.location.hash).toBe("#/case/CASE-1");
  expect(p.q(".trail .home").getAttribute("aria-label")).toBe("Home");
  expect(p.q(".trail .level-mode .pill").textContent).toBe("Investigate");
  expect(p.q(".trail .level-item .pill").textContent).toBe("CASE-1");
  expect(p.all(".trail .level-item .dot").map((d) => d.getAttribute("aria-label"))).toEqual(["Sign-in burst"]);
  expect(p.all(".trail .level-mode .dot").map((d) => d.getAttribute("aria-label"))).toContain("Hunt");
  expect(p.all(".trail .flyout button").map((b) => b.textContent)).toEqual(["CASE-2 · Sign-in burst", "CASE-1 · Odd traffic"]);
  p.click(".trail .level-item .dot");
  expect(p.win.location.hash).toBe("#/case/CASE-2");
  p.click(".trail .level-mode .pill");
  expect(p.win.location.hash).toBe("#/investigate");
  p.click(".trail .home");
  expect(p.win.location.hash).toBe("#/");
});

test("the trail's lane level moves column focus", async () => {
  const p = await open();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`; await p.settle();
  expect(p.root.querySelector(".trail .level-lane")).toBeNull();     // no lanes yet
});

test("the jobs indicator counts running jobs and opens the Jobs lens", async () => {
  const p = await open();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`; await p.settle();
  expect(p.q(".jobs").textContent).toBe("jobs (0)");
  p.click(".jobs");                                                  // the case screen is not built yet: nothing throws
});

test("the connection state shows only when it is not live", async () => {
  const p = await open();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`; await p.settle();
  expect(p.root.querySelector(".connection")).toBeNull();
});

test("/ focuses the command bar", async () => {
  const p = await open();
  p.click("[data-mode=investigate]"); await p.settle();
  p.q("[aria-label=Filter]");
  (p.doc.activeElement as HTMLElement | null)?.blur();
  p.press("/");
  expect(p.doc.activeElement).toBe(p.q("[aria-label=Command]"));
  expect(p.q("[aria-label=Command]").getAttribute("placeholder")).toBe("open, run, verify c3, or ask");
});

test("the command bar opens a case on Enter and clears; a say is kept", async () => {
  const p = await open();
  await two(p);
  p.click("[data-mode=investigate]"); await p.settle();
  const input = p.q("[aria-label=Command]") as HTMLInputElement;
  p.fill(input, "run"); input.focus(); p.press("Enter"); await p.settle();
  expect(input.value).toBe("run");
  expect(p.q(".say").textContent).toBe("Open a case first: investigate CASE-1");
  p.fill(input, "investigate odd traffic"); p.press("Enter"); await p.settle();
  expect(p.win.location.hash).toBe("#/case/CASE-1");
  expect(input.value).toBe("");
});

test("in a case the bar sends run through the command path, and ask goes to nav.ask", async () => {
  const p = await open();
  const id = await p.s.newCase();
  const sent: string[] = [];
  p.ui.act = async (c) => { sent.push(c); return true; };
  p.win.location.hash = `#/case/${id}`; await p.settle();
  const input = p.q("[aria-label=Command]") as HTMLInputElement;
  p.fill(input, "run"); input.focus(); p.press("Enter"); await p.settle();
  expect(sent).toEqual(["start_run"]);
  expect(input.value).toBe("");
});

test("the home command input opens a case", async () => {
  const p = await open();
  await two(p);
  p.click("[data-mode=investigate]"); await p.settle();
  p.click(".trail .home"); await p.settle();
  const input = p.q("[aria-label=Command]") as HTMLInputElement;
  p.fill(input, "investigate CASE-2"); input.focus(); p.press("Enter"); await p.settle();
  expect(p.win.location.hash).toBe("#/case/CASE-2");
});
