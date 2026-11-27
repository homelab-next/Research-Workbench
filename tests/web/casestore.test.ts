import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readManifest } from "../../src/core/casefile";
import type { StoreView } from "../../src/core/wire";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps } from "../../src/pipeline/engine";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";
import { rawCaseFile } from "../helpers/tar";

// Slice 11 in the interface: the Case store view (reached from "which one?"), Load and Delete on its rows, the on-complete setting, and Unload in
// each loaded case's menu.
let p: Page | null = null;
afterEach(async () => { await p?.close(); p = null; });
async function open(opts: Parameters<typeof page>[0] = {}): Promise<Page> { p = await page(opts); await p.settle(); return p; }

const FILE = "CASE-1.TLP-GREEN.tar.gz";
const storeDir = (q: Page): string => q.s.config.cases.store;
const unload = async (q: Page, id: string): Promise<void> => {
  const res = await q.s.post(`/api/cases/${id}/unload`, {});
  if (res.status !== 200) throw new Error(`unload ${id}: ${res.status} ${await res.text()}`);
};
/** Waits, a turn at a time, until `cond` holds: the store is read from disk, so its answer comes some turns after the click. */
async function until(q: Page, cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`never: ${what}; the page says: ${q.text().slice(0, 400)}`);
}
const toStore = async (q: Page): Promise<void> => {
  q.win.location.hash = "#/investigate/store";
  await q.settle();
  await until(q, () => q.root.querySelector("[data-screen=store] .store-list[data-ready]") !== null, "the store is listed");
};
const row = (q: Page, id: string): HTMLElement | null => q.root.querySelector(`.stored-case[data-id='${id}']`);
const rows = (q: Page): string[] => q.all(".stored-case").map((r) => r.dataset.id!);
const tileIds = (q: Page): string[] => q.all(".tile:not(.proposed)").map((t) => t.getAttribute("aria-label")!.split(" · ")[1]!);

test("the view lists the store's files with id, title, marking, status, entries and when they were unloaded, and names the store folder", async () => {
  const q = await open();
  await q.s.newCase({ title: "Odd traffic", marking: "TLP:GREEN" });
  await q.s.newCase({ title: "Sign-in burst", marking: "TLP:AMBER" });
  await unload(q, "CASE-1"); await unload(q, "CASE-2");
  // reached from a button on "which one?"
  q.win.location.hash = "#/investigate"; await q.settle();
  expect(q.q("[data-action=case-store]").textContent).toBe("Case store");
  q.click("[data-action=case-store]");
  await q.settle();
  expect(q.win.location.hash).toBe("#/investigate/store");
  await until(q, () => q.root.querySelector(".store-list[data-ready]") !== null, "listed");
  expect(q.q("[data-screen=store] h1").textContent).toBe("Case store");
  expect(q.q(".store-folder").textContent).toBe(`Files in ${storeDir(q)}`);
  expect(rows(q).sort()).toEqual(["CASE-1", "CASE-2"]);
  const r = row(q, "CASE-2")!;
  const view = (await (await q.s.get("/api/store")).json()) as StoreView;
  const two = view.cases.find((c) => c.id === "CASE-2")!;
  expect(r.dataset.file).toBe("CASE-2.TLP-AMBER.tar.gz");
  expect(r.querySelector(".id")!.textContent).toBe("CASE-2");
  expect(r.querySelector(".title")!.textContent).toBe("Sign-in burst");
  expect(r.querySelector(".marking")!.textContent).toBe("TLP:AMBER");
  expect(r.querySelector(".status")!.textContent).toBe(two.status);
  expect(r.querySelector(".entries")!.textContent).toBe(`${two.entries} entries`);
  expect(r.querySelector("time")!.getAttribute("datetime")).toBe(two.unloaded_ts);
  expect(r.querySelector("[data-action=load]")!.textContent).toBe("Load");
  // Escape goes back up to "which one?"
  q.actions().up!();
  await q.settle();
  expect(q.win.location.hash).toBe("#/investigate");
});

test("typing in the search box asks the server and shows what matches by id, title, question or observable value; nothing matching says so", async () => {
  const q = await open();
  await q.s.newCase({ title: "Odd traffic", asked: "Who is behind the beacon?", starting: [{ type: "address", value: "198.51.100.77" }] });
  await q.s.newCase({ title: "Sign-in burst", asked: "Why so many sign-ins?", starting: [{ type: "address", value: "203.0.113.9" }] });
  await unload(q, "CASE-1"); await unload(q, "CASE-2");
  await toStore(q);
  const search = q.q("[aria-label='Search the case store']");
  const searched = async (text: string, want: string[]): Promise<void> => {
    q.fill(search, text);
    await until(q, () => q.root.querySelector(".store-list")!.getAttribute("data-ready") === text && JSON.stringify(rows(q).sort()) === JSON.stringify(want), `search ${text}`);
  };
  await searched("case-2", ["CASE-2"]);
  await searched("odd", ["CASE-1"]);
  await searched("beacon", ["CASE-1"]);
  await searched("203.0.113.9", ["CASE-2"]);
  await searched("zzz", []);
  expect(q.q(".store-none").textContent).toBe("Nothing in the case store matches");
  await searched("", ["CASE-1", "CASE-2"]);
  // only the answer to the latest text is drawn: an answer to earlier text that comes late is dropped
  const real = q.ui.api.store;
  const held: { text: string; done: () => void }[] = [];
  q.ui.api.store = (text) => new Promise((resolve, reject) => { held.push({ text, done: () => { real(text).then(resolve, reject); } }); });
  q.fill(search, "odd");
  q.fill(search, "burst");
  expect(held.map((x) => x.text)).toEqual(["odd", "burst"]);
  held[1]!.done();
  await until(q, () => q.root.querySelector(".store-list")!.getAttribute("data-ready") === "burst", "the latest answer");
  held[0]!.done();
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 2));
  expect(rows(q)).toEqual(["CASE-2"]);
  expect(q.q(".store-list").getAttribute("data-ready")).toBe("burst");
  q.ui.api.store = real;
});

test("Load on a row loads the case, opens it, and the case list has it again", async () => {
  const q = await open();
  await q.s.newCase({ title: "Odd traffic" });
  await unload(q, "CASE-1");
  await toStore(q);
  q.click(row(q, "CASE-1")!.querySelector("[data-action=load]")!);
  await until(q, () => q.win.location.hash === "#/case/CASE-1", "the case opens");
  await q.settle();
  expect(q.s.app.hub.read("CASE-1").entries(0).at(-1)!.type).toBe("case.loaded");
  expect(q.store()!.live.skipped).toEqual([]);
  q.win.location.hash = "#/investigate"; await q.settle();
  expect(tileIds(q)).toEqual(["CASE-1"]);
});

test("a row whose case is loaded says so and has no Load button", async () => {
  const q = await open();
  await q.s.newCase({ title: "Odd traffic" });
  await unload(q, "CASE-1");
  expect((await q.s.post("/api/store/load", { file: FILE })).status).toBe(200);   // loading keeps the file in the store
  await toStore(q);
  const r = row(q, "CASE-1")!;
  expect(r.querySelector("[data-action=load]")).toBeNull();
  expect(r.querySelector(".loaded")!.textContent).toBe("Loaded");
  expect(r.classList.contains("is-loaded")).toBe(true);
});

test("a refused load shows the server's reason on the row and loads nothing", async () => {
  const q = await open();
  await q.s.newCase({ title: "Odd traffic" });
  await unload(q, "CASE-1");
  const m = await readManifest(join(storeDir(q), FILE));
  rawCaseFile(join(storeDir(q), FILE), [{ name: "case.json", body: JSON.stringify(m) }, { name: "ledger.sqlite", type: "2", link: "/etc/passwd" }]);
  await toStore(q);
  q.click(row(q, "CASE-1")!.querySelector("[data-action=load]")!);
  await until(q, () => row(q, "CASE-1")?.querySelector(".refusal") !== null, "the refusal is shown");
  const why = row(q, "CASE-1")!.querySelector(".refusal")!;
  expect(why.textContent).toStartWith("Refused: ");
  expect(why.textContent).toContain("link");
  expect(why.getAttribute("role")).toBe("alert");
  expect(q.win.location.hash).toBe("#/investigate/store");
  expect(await (await q.s.get("/api/cases")).json()).toEqual([]);
});

test("Delete opens a box that asks for the id; the button is off until the id is typed exactly, and then the row goes", async () => {
  const q = await open();
  await q.s.newCase({ title: "Odd traffic" });
  await q.s.newCase({ title: "Sign-in burst" });
  await unload(q, "CASE-1"); await unload(q, "CASE-2");
  await toStore(q);
  expect(row(q, "CASE-1")!.querySelector(".delete-box")).toBeNull();
  q.click(row(q, "CASE-1")!.querySelector("[data-action=delete]")!);
  const box = row(q, "CASE-1")!.querySelector(".delete-box") as HTMLElement;
  expect(box.textContent).toContain("Type CASE-1 to delete its file from the case store. This cannot be undone.");
  const typed = box.querySelector("[aria-label='Type CASE-1 to delete']") as HTMLInputElement;
  expect(q.doc.activeElement).toBe(typed);
  const confirm = (): HTMLButtonElement => row(q, "CASE-1")!.querySelector("[data-action=confirm-delete]") as HTMLButtonElement;
  expect(confirm().disabled).toBe(true);
  for (const wrong of ["case-1", "CASE-", "CASE-12", " CASE-1"]) { q.fill(typed, wrong); expect(confirm().disabled).toBe(true); }
  q.fill(typed, "CASE-1");
  expect(confirm().disabled).toBe(false);
  q.click(confirm());
  await until(q, () => row(q, "CASE-1") === null, "the row goes");
  expect(rows(q)).toEqual(["CASE-2"]);
  expect(existsSync(join(storeDir(q), FILE))).toBe(false);
  expect(readFileSync(join(storeDir(q), "deleted.log"), "utf8")).toContain("\"id\":\"CASE-1\"");
  // Cancel closes the box and deletes nothing
  q.click(row(q, "CASE-2")!.querySelector("[data-action=delete]")!);
  q.click(row(q, "CASE-2")!.querySelector("[data-action=cancel-delete]")!);
  expect(row(q, "CASE-2")!.querySelector(".delete-box")).toBeNull();
  expect(rows(q)).toEqual(["CASE-2"]);
});

test("a title and a question that look like markup are drawn as text", async () => {
  const q = await open();
  await q.s.newCase({ title: "<img src=x onerror=1>", asked: "<script>alert(1)</script> who?" });
  await unload(q, "CASE-1");
  await toStore(q);
  const r = row(q, "CASE-1")!;
  expect(r.querySelectorAll("img, script").length).toBe(0);
  expect(q.root.querySelectorAll("img, script").length).toBe(0);
  expect(r.querySelector(".title")!.textContent).toBe("<img src=x onerror=1>");
  expect(r.querySelector(".asked")!.textContent).toBe("<script>alert(1)</script> who?");
});

test("an unreadable file is listed with its reason and no button", async () => {
  const q = await open();
  mkdirSync(storeDir(q), { recursive: true });
  writeFileSync(join(storeDir(q), "CASE-7.TLP-GREEN.tar.gz"), "not a case file");
  await toStore(q);
  const bad = q.q(".stored-unreadable[data-file='CASE-7.TLP-GREEN.tar.gz']");
  expect(bad.querySelector(".file")!.textContent).toBe("CASE-7.TLP-GREEN.tar.gz");
  expect(bad.querySelector(".reason")!.textContent!.length).toBeGreaterThan(0);
  expect(bad.querySelectorAll("button").length).toBe(0);
  expect(rows(q)).toEqual([]);
});

test("the setting is a checkbox, off by default: ticking it saves cases.on_complete as unload, and it is ticked on the next visit", async () => {
  const q = await open();
  await toStore(q);
  const box = (): HTMLInputElement => q.q("[aria-label='Unload a case to the store when it is published']") as HTMLInputElement;
  expect(box().type).toBe("checkbox");
  expect(box().checked).toBe(false);
  expect(q.q(".store-setting").textContent).toContain("Unload a case to the store when it is published");
  box().checked = true;
  box().dispatchEvent(new q.win.Event("change", { bubbles: true }) as unknown as Event);
  await until(q, () => q.ui.me.cases.on_complete === "unload", "the setting is saved");
  expect((await q.ui.api.me()).cases.on_complete).toBe("unload");
  expect(q.ui.me.cases.on_complete).toBe("unload");
  expect(readFileSync(q.s.config.write_path, "utf8")).toContain("on_complete: unload");
  q.win.location.hash = "#/investigate"; await q.settle();
  await toStore(q);
  expect(box().checked).toBe(true);
  // cleared, it saves keep
  box().checked = false;
  box().dispatchEvent(new q.win.Event("change", { bubbles: true }) as unknown as Event);
  await until(q, () => q.ui.me.cases.on_complete === "keep", "keep is saved");
  expect((await q.ui.api.me()).cases.on_complete).toBe("keep");
});

test("a setting the server refuses puts the box back and says why", async () => {
  const q = await open();
  mkdirSync(dirname(q.s.config.write_path), { recursive: true });
  writeFileSync(q.s.config.write_path, "cases: { on_complete: keep }\n");      // a flow-style block cannot be edited line by line
  await toStore(q);
  const box = q.q("[aria-label='Unload a case to the store when it is published']") as HTMLInputElement;
  box.checked = true;
  box.dispatchEvent(new q.win.Event("change", { bubbles: true }) as unknown as Event);
  await until(q, () => q.root.querySelector(".store-setting .refusal") !== null, "the refusal is shown");
  expect(box.checked).toBe(false);
  expect(q.q(".store-setting .refusal").textContent).toStartWith("Refused: ");
  expect(q.q(".store-setting .refusal").textContent).toContain("by hand");
  expect(q.ui.me.cases.on_complete).toBe("keep");
  expect((await q.ui.api.me()).cases.on_complete).toBe("keep");
});

// ---- the loaded list: Unload in each case's menu

test("each loaded case has a menu with Unload; choosing it unloads the case and the tile goes", async () => {
  const q = await open();
  await q.s.newCase({ title: "Odd traffic" });
  await q.s.newCase({ title: "Sign-in burst" });
  q.win.location.hash = "#/investigate"; await q.settle();
  expect(tileIds(q).sort()).toEqual(["CASE-1", "CASE-2"]);
  const menu = q.q(".tile-menu[data-case='CASE-1']");
  expect(menu.querySelector("summary")!.getAttribute("aria-label")).toBe("More for CASE-1");
  const btn = menu.querySelector("[data-action=unload]") as HTMLButtonElement;
  expect(btn.textContent).toBe("Unload");
  expect(btn.disabled).toBe(false);
  q.click(btn);
  await until(q, () => !tileIds(q).includes("CASE-1"), "the tile goes");
  expect(tileIds(q)).toEqual(["CASE-2"]);
  expect(q.toasts()).toContain("CASE-1 was unloaded to the case store");
  expect(existsSync(join(storeDir(q), FILE))).toBe(true);
});

test("Unload is off, with the reason as its title, while the case's run is running", async () => {
  const q = await open();
  const id = await q.s.newCase();
  const deps = (q.s.app.hub as unknown as { deps: EngineDeps }).deps;
  new Engine(q.s.wb.session(id), deps).start({ kind: "human", id: q.s.config.user });   // running, and not driven
  q.win.location.hash = "#/investigate"; await q.settle();
  const btn = q.q(".tile-menu[data-case='CASE-1'] [data-action=unload]") as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(btn.getAttribute("title")).toBe("a run is running; pause or stop it first");
});

test("a refused unload leaves the tile and says why", async () => {
  const q = await open();
  const id = await q.s.newCase();
  q.win.location.hash = "#/investigate"; await q.settle();
  let release: () => void = () => {};
  q.s.app.hub.follow(id, new Promise<void>((r) => { release = r; }));      // the workbench is still working on the case
  q.click(q.q(".tile-menu[data-case='CASE-1'] [data-action=unload]"));
  await until(q, () => q.root.querySelector(".tile-menu[data-case='CASE-1'] .refusal") !== null, "the refusal is shown");
  expect(q.q(".tile-menu[data-case='CASE-1'] .refusal").textContent).toBe("Refused: the workbench is still working on this case");
  release();
  await q.settle();
  expect(tileIds(q)).toEqual(["CASE-1"]);
  expect(existsSync(join(storeDir(q), FILE))).toBe(false);
});

test("a case whose unload failed shows an unload failed chip whose title is the reason", async () => {
  const q = await open();
  const id = await q.s.newCase();
  q.s.app.hub.read(id).commit(() => [{ type: "case.unload_failed", payload: { reason: "the case file could not be written: the disk is full" }, actor: { kind: "system", id: "workbench" } }]);
  q.win.location.hash = "#/investigate"; await q.settle();
  const chip = q.q(".tile .chip.unload-failed");
  expect(chip.textContent).toBe("unload failed");
  expect(chip.getAttribute("title")).toBe("the case file could not be written: the disk is full");
  expect(q.s.app.hub.read(id).state.skipped).toEqual([]);
});
