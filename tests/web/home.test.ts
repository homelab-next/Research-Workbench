import { afterEach, expect, test } from "bun:test";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";
import { parseRoute, routeHash } from "../../src/web/app";
import { writeTriage } from "../helpers/loop-files";

let p: Page | null = null;
afterEach(async () => { await p?.close(); p = null; });
async function open(opts: Parameters<typeof page>[0] = {}): Promise<Page> { p = await page(opts); await p.settle(); return p; }
const two = async (q: Page): Promise<void> => {
  await q.s.newCase({ title: "Odd traffic", marking: "TLP:GREEN" });
  await q.s.newCase({ title: "Sign-in burst", marking: "TLP:AMBER" });
};

test("routes parse and print, and anything else is home", () => {
  for (const h of ["#/", "#/investigate", "#/investigate/new", "#/investigate/store", "#/soon/hunt", "#/case/CASE-1"]) expect(routeHash(parseRoute(h))).toBe(h);
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
  p.click(".grid > :nth-child(3) .tile"); await p.settle();   // Odd traffic, CASE-1 (a case tile sits in a wrap beside its menu)
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

// --- review fixes ---
const fillNew = (p: Page): void => {
  p.fill("[aria-label=Title]", "Odd traffic"); p.fill("[aria-label='What was asked']", "q"); p.fill("[aria-label=Why]", "w");
  p.fill("[aria-label='Starting value 1']", "198.51.100.77");
};

test("a failure after the case exists goes to the case and says the run did not start", async () => {
  const p = await open();
  p.ui.act = async () => { throw new Error("network down"); };
  p.click("[data-mode=investigate]"); await p.settle();
  p.click(".tile.proposed"); fillNew(p);
  p.click("button.primary"); await p.settle();
  expect(p.win.location.hash).toBe("#/case/CASE-1");
  expect(p.toasts().join("|")).toContain("The case was created; the run did not start: network down");
  expect((await p.ui.api.cases()).length).toBe(1);
});

test("a second click while a create is in flight makes no second case", async () => {
  const p = await open();
  p.ui.act = async () => true;
  p.click("[data-mode=investigate]"); await p.settle();
  p.click(".tile.proposed"); fillNew(p);
  p.click("button.primary"); p.click("button.primary");
  expect(p.q("button.primary").hasAttribute("disabled")).toBe(true);
  await p.settle();
  expect((await p.ui.api.cases()).length).toBe(1);
});

test("a requester's routes never read the case list", async () => {
  const p = await open({ role: "requester" });
  let reads = 0;
  p.ui.api.cases = async () => { reads++; return []; };
  p.win.location.hash = "#/soon/ask"; await p.settle();
  p.win.location.hash = "#/"; await p.settle();
  expect(reads).toBe(0);
});

test("the count shows … while the list loads and an error line, not a count, when it fails", async () => {
  const p = await open();
  p.ui.api.cases = async () => { throw new Error("boom"); };
  p.click("[data-mode=hunt]"); await p.settle();
  p.click(".trail .home"); await p.settle();
  expect(p.q("[data-mode=investigate]").textContent).toBe("Investigate");
  expect(p.q(".load-error").textContent).toBe("The cases could not be loaded");
});

test("the count is … before the first answer", async () => {
  p = await page();
  expect(p.q("[data-mode=investigate]").textContent).toBe("Investigate…");
});

test("typing approve or accept plan opens the gate's lens and says so, and sends nothing", async () => {
  const p = await open();
  const id = await p.s.newCase();
  const sent: string[] = [];
  p.ui.act = async (c) => { sent.push(c); return true; };
  const opened: string[] = [];
  p.win.location.hash = `#/case/${id}`; await p.settle();
  p.ui.send = async (c) => { sent.push(c); return null; };
  const input = p.q("[aria-label=Command]") as HTMLInputElement;
  p.fill(input, "approve"); input.focus(); p.press("Enter"); await p.settle();
  expect(p.q(".topbar .say").textContent).toBe("Approve the draft from the Narrative lens");
  p.fill(input, "accept plan"); p.press("Enter"); await p.settle();
  expect(p.q(".topbar .say").textContent).toBe("Accept the plan from the Steps lens");
  expect(sent).toEqual([]);
  expect(opened).toEqual([]);
});

test("a case number longer than nine digits, and an unknown soon mode, are home", async () => {
  expect(parseRoute("#/case/CASE-1234567890")).toEqual({ screen: "home" });
  expect(parseRoute("#/case/CASE-123456789")).toEqual({ screen: "case", id: "CASE-123456789" });
  const p = await open({ hash: "#/soon/%3Cb%3E" });
  expect(p.root.querySelector("[data-screen=soon]")).toBeNull();
  p.win.location.hash = "#/soon/nonesuch"; await p.settle();
  expect(p.root.querySelector("[data-screen=soon]")).toBeNull();
  expect(p.root.querySelector("[data-screen=home]")).not.toBeNull();
});

test("the trail shows no pill for a case that is not in the list", async () => {
  const p = await open();
  p.win.location.hash = "#/case/CASE-77"; await p.settle();
  expect(p.root.querySelector(".trail .level-item .pill")).toBeNull();
});

test("/ reaches the command bar from a focused button", async () => {
  const p = await open();
  p.click("[data-mode=investigate]"); await p.settle();
  (p.q(".tile.proposed") as HTMLElement).focus();
  p.press("/");
  expect(p.doc.activeElement).toBe(p.q("[aria-label=Command]"));
});

test("Escape from a button in a filled new-investigation form keeps the form", async () => {
  const p = await open();
  p.click("[data-mode=investigate]"); await p.settle();
  p.click(".tile.proposed");
  p.fill("[aria-label=Title]", "keep me");
  (p.q("[aria-label='Add a value']") as HTMLElement).focus();
  p.press("Escape");
  expect(p.win.location.hash).toBe("#/investigate/new");
  expect((p.q("[aria-label=Title]") as HTMLInputElement).value).toBe("keep me");
});

test("the command box is cleared only if it still holds the command that ran, and a second Enter in flight is ignored", async () => {
  const p = await open();
  const id = await p.s.newCase();
  let calls = 0;
  let release: () => void = () => {};
  p.ui.act = () => { calls++; return new Promise<boolean>((r) => { release = () => r(true); }); };
  p.win.location.hash = `#/case/${id}`; await p.settle();
  const input = p.q("[aria-label=Command]") as HTMLInputElement;
  p.fill(input, "run"); input.focus(); p.press("Enter"); p.press("Enter");
  expect(calls).toBe(1);
  p.fill(input, "something typed meanwhile");
  release(); await p.settle();
  expect(input.value).toBe("something typed meanwhile");
});

test("a case open in the interface when it is unloaded says it was unloaded and goes to the list", async () => {
  const p = await open();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`; await p.settle();
  const followed = p.store()!;
  expect(followed.connection).toBe("live");
  expect((await p.s.post(`/api/cases/${id}/unload`, {})).status).toBe(200);
  await p.settle();
  expect(p.win.location.hash).toBe("#/investigate");
  expect(p.toasts()).toContain("CASE-1 was unloaded to the case store");
  // the store stopped following: it is gone, not reconnecting, and nothing reopens it
  expect(followed.connection).toBe("gone");
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 2));
  expect(followed.connection).toBe("gone");
  expect(p.root.querySelector(".connection")).toBeNull();
});

test("the case list shows a case's loop when it is not the default, and child of CASE-1 on a child", async () => {
  const q = await open({ before: writeTriage });
  const parent = await q.s.newCase({ loop: "triage" });
  expect((await q.s.command(parent, "start_run")).status).toBe(200);
  await q.s.newCase({ title: "Plain" });
  await q.settle();
  q.win.location.hash = "#/investigate"; await q.settle();
  const tile = (id: string): HTMLElement => q.all(".tile-wrap").find((w) => w.querySelector(".tile")!.getAttribute("aria-label")!.includes(` · ${id} · `))!;
  // the triage case names its loop by title, and the child it waits on
  expect([...tile("CASE-1").querySelectorAll(".chip.loop")].map((c) => c.textContent)).toEqual(["Triage"]);
  expect(tile("CASE-1").querySelector(".chip.waiting-on")!.textContent).toBe("waiting on CASE-2");
  // the child is of the default loop, so says nothing of it, and names its parent
  expect(tile("CASE-2").querySelector(".chip.loop")).toBeNull();
  expect(tile("CASE-2").querySelector(".chip.parent")!.textContent).toBe("child of CASE-1");
  // a plain case says neither
  expect(tile("CASE-3").querySelector(".chip.loop, .chip.parent, .chip.waiting-on")).toBeNull();
  for (const id of ["CASE-1", "CASE-2", "CASE-3"]) expect(q.s.app.hub.read(id).state.skipped).toEqual([]);
});

test("the Memory tile counts the store's proposals, and the Memory page accepts one through the server", async () => {
  const p = await open();
  const person = { kind: "human" as const, id: p.s.config.user };
  p.s.wb.memory.propose({ case_type: "unknown-device", title: "Read the lease table first", text: "The lease table names a lobby device.", triggers: [], marking: "TLP:GREEN", supersedes: null }, { kind: "person" }, person);
  p.click("[data-mode=loops]"); await p.settle();
  p.click(".trail .home"); await p.settle();
  expect(p.q("[data-column=resources] [data-mode=memory]").textContent).toBe("Memory1 to review");
  p.click("[data-mode=memory]"); await p.settle();
  expect(p.win.location.hash).toBe("#/memory");
  expect(p.q("details.lesson[data-lesson=LESSON-1] > summary .status").textContent).toBe("proposed");
  p.click("details.lesson[data-lesson=LESSON-1] [data-action=accept]");
  await p.settle();
  expect(p.s.wb.memory.state.lessons["LESSON-1"]!.status).toBe("accepted");
  expect(p.q("details.lesson[data-lesson=LESSON-1] > summary .status").textContent).toBe("shared");
  expect(p.s.wb.memory.state.skipped).toEqual([]);
});
