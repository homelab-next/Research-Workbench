import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";
import type { Custody } from "../../src/core/wire";
import { card } from "../helpers/entries";

let p: Page | null = null;
let allowSkipped = false;
afterEach(async () => {
  if (p !== null && !allowSkipped) expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]);
  allowSkipped = false;
  await p?.close();
  p = null;
});

type Gate = "publish" | "plan" | "none";
/** A page on the sample case, the run driven to `gate` before the page opens it. */
async function open(gate: Gate = "publish"): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  if (gate === "publish") await p.s.toPublishGate(id);
  else if (gate === "plan") await p.s.toPlanGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  return p;
}
const st = (q: Page) => q.s.app.hub.read("CASE-1").state;
const firstIncoming = (q: Page): string => q.q("[data-area=incoming] [data-card]").dataset.card!;

test("Incoming, the brief, one lane per sub-goal and the shelf are on screen", async () => {
  const q = await open();
  expect(q.q("[data-area=incoming]").getAttribute("tabindex")).toBe("0");
  expect(q.q("[data-area=lanes]").getAttribute("tabindex")).toBe("0");
  expect(q.q(".brief")).toBeDefined();
  expect(q.all(".lane").length).toBe(st(q).lanes.length);
  expect(q.all(".lane").length).toBeGreaterThan(0);
  expect(q.all(".lane").map((l) => l.dataset.lane)).toEqual(st(q).lanes.map((l) => l.id));
  expect(q.q(".lane.target").getAttribute("aria-current")).toBe("true");
  expect(q.text()).toContain("+ New lane");
  expect(q.q(".shelf")).toBeDefined();
  expect(q.q(".incoming-bar select[aria-label='Sort by']")).toBeDefined();
  expect(q.q(".incoming-foot").textContent).toBe("J/K move · Space keep · X discard · ? keys");
  expect(q.all("[data-area=incoming] [data-card]").length).toBe(st(q).incoming.length);
});

test("the brief shows the case, its marking, what was asked, goals, plan and draft", async () => {
  const q = await open();
  expect(q.q(".brief").textContent).toContain("Brief: CASE-1 · TLP:GREEN · Sample");
  expect(q.q(".brief").textContent).toContain("Asked for: Who is behind the traffic to 198.51.100.77?");
  expect(q.q("[data-status=goals]").textContent).toMatch(/^✔ \d\/2 goals$/);
  expect(q.q("[data-status=plan]").textContent).toBe("plan accepted");
  expect(q.q("[data-status=draft]").textContent).toBe(`draft ${st(q).drafts.at(-1)!.n}`);
});

test("the phase strip groups stages under phases and marks each in words", async () => {
  const q = await open();
  const phases = q.all(".phase").map((e) => e.querySelector(".phase-title")!.textContent);
  expect(phases).toEqual(q.s.app.hub.read("CASE-1").state.run.stages.map((s) => s.phase as string).filter((x, i, a) => a.indexOf(x) === i).map((id) => q.ui.ref.phases.find((ph) => ph.id === id)?.title ?? id));
  expect(phases[0]).toBe("Direction");
  expect(q.q("[data-stage=frame]").textContent).toBe("Frame ✓ passed");
  expect(q.q("[data-stage=publish]").textContent).toBe("Publish ◌ waiting");
  expect(q.q(".phase-strip").textContent).toContain("▸");
});

test("activating a stage asks the app for the pipeline lens on that stage", async () => {
  const q = await open();
  q.click("[data-stage=frame]");
  expect(q.navCalls).toContainEqual(["openLens", "pipeline", "frame"]);
});

test("the custody chip reads chain intact with the entry count", async () => {
  const q = await open();
  expect(q.q(".custody").textContent).toBe(`chain intact · ${q.s.entries("CASE-1").length} entries`);
  expect(q.q(".custody").className).toContain("tag-done");
  expect(q.q(".custody").getAttribute("title")).toContain("checked");
});

test("a deleted blob turns the custody chip amber and names the entry", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  const e = p.s.entries(id).find((x) => x.type === "stage.finished" && (x.payload as { output: { blob: string } | null }).output !== null)!;
  rmSync(join(p.s.app.hub.read(id).dir, "blobs", (e.payload as { output: { blob: string } }).output.blob));
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  expect(p.q(".custody").className).toContain("tag-attention");
  expect(p.q(".custody").textContent).toMatch(/blob\(s\) missing or corrupt, first at entry \d+/);
});

test("the custody chip never says ok when the check could not be made", async () => {
  p = await page();
  const id = await p.s.newCase();
  p.ui.api.custody = async () => { throw new Error("down"); };
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  expect(p.q(".custody").textContent).toBe("custody not checked");
  expect(p.q(".custody").className).toContain("tag-attention");
});

test("the custody chip is checked again when activated and after a publish", async () => {
  const q = await open();
  let n = 0;
  const real = q.ui.api.custody;
  q.ui.api.custody = async (id) => { n++; return real(id); };
  q.click(".custody"); await q.settle();
  expect(n).toBe(1);
  q.click(".next-thing"); await q.settle();             // opens the Narrative lens at the gate
  q.click(".lens-dock [data-action=approve]"); await q.settle();   // the gate's own button publishes
  await q.s.app.hub.idle(); await q.settle();
  expect(n).toBe(2);
  const c: Custody = await real("CASE-1");
  expect(q.q(".custody").textContent).toBe(c.line);
});

test("entries the fold skipped are shown as a warning", async () => {
  const q = await open();
  q.s.app.hub.read("CASE-1").commit(() => [{ type: "card.kept", actor: { kind: "system", id: "t" }, payload: { card: 7 } as never }]);
  allowSkipped = true;
  await q.settle();
  expect(q.q(".skipped").textContent).toBe("1 entries not applied");
  expect(q.q(".skipped").getAttribute("title")).toMatch(/^\d+ card\.kept: /);
});

test("keeping a card moves it to the target lane and offers Undo, which puts it back", async () => {
  const q = await open();
  const c = firstIncoming(q);
  q.click(`[data-card=${c}]`); q.click(`[data-card=${c}] [data-action=keep]`);
  await q.settle();
  expect(q.q(".lane.target").querySelector(`[data-card=${c}]`)).not.toBeNull();
  expect(q.toasts()[0]).toMatch(/^Kept in /);
  expect(q.q("[role=status] .toast").textContent).toContain("Undo");
  q.click(".toast [data-action=undo]");
  await q.settle();
  expect(q.q("[data-area=incoming]").querySelector(`[data-card=${c}]`)).not.toBeNull();
  expect(q.root.querySelector(".toast [data-action=undo]")).toBeNull();
});

test("Undo names its target, and a refusal says the action can no longer be undone", async () => {
  const q = await open();
  const c = firstIncoming(q);
  q.click(`[data-card=${c}]`); q.click(`[data-card=${c}] [data-action=keep]`);
  await q.settle();
  const sent: unknown[] = [];
  const real = q.ui.api.command;
  q.ui.api.command = async (id, name, args) => { sent.push([name, args]); return name === "undo" ? { ok: false, refused: ["nothing to undo"] } : real(id, name, args); };
  q.click(".toast [data-action=undo]"); await q.settle();
  expect(sent).toEqual([["undo", { target: expect.any(Number) }]]);
  expect(q.toasts().at(-1)).toBe("that action can no longer be undone");
});

test("discard never deletes: the card is in state.discarded and Undo restores it", async () => {
  const q = await open();
  const c = firstIncoming(q);
  q.click(`[data-card=${c}]`); q.click(`[data-card=${c}] [data-action=discard]`);
  await q.settle();
  expect(st(q).discarded).toContain(c);
  expect(st(q).cards[c]).toBeDefined();
  expect(q.root.querySelector(`[data-card=${c}]`)).toBeNull();
  expect(q.toasts().at(-1)).toBe("Discarded");
  q.click(".toast [data-action=undo]"); await q.settle();
  expect(st(q).discarded).not.toContain(c);
  expect(q.q("[data-area=incoming]").querySelector(`[data-card=${c}]`)).not.toBeNull();
});

test("move, send back and pin go through the server and report in words", async () => {
  const q = await open();
  const c = firstIncoming(q);
  q.click(`[data-card=${c}]`); q.click(`[data-card=${c}] [data-action=pin]`); await q.settle();
  expect(st(q).cards[c]!.pinned).toBe(true);
  q.click(`[data-card=${c}] [data-action=keep]`); await q.settle();
  const lane = q.q(".lane.target").dataset.lane!;
  expect(q.q(`[data-card=${c}] select[aria-label=Move]`)).toBeDefined();
  q.click(`[data-card=${c}] [data-action=send_back]`); await q.settle();
  expect(q.toasts().at(-1)).toBe("Back in Incoming");
  expect(st(q).cards[c]!.place).toBe("incoming");
  expect(lane).toBeDefined();
});

test("a refusal is a toast with the server's words and changes nothing", async () => {
  const q = await open();
  const c = firstIncoming(q);
  q.click(`[data-card=${c}]`);
  await q.s.command("CASE-1", "keep", { card: c });             // a second page got there first; this one has not rendered it yet
  q.click(`[data-card=${c}] [data-action=keep]`);
  await q.settle();
  expect(q.toasts().at(-1)).toBe(`card ${c} is already kept`);
  expect(q.all(`[data-card=${c}]`).length).toBe(1);
});

test("a failed request is a toast that says the server did not answer", async () => {
  const q = await open();
  q.ui.api.command = async () => { throw new Error("offline"); };
  const c = firstIncoming(q);
  q.click(`[data-card=${c}]`); q.click(`[data-card=${c}] [data-action=discard]`); await q.settle();
  expect(q.toasts().at(-1)).toBe("The server did not answer.");
  expect(st(q).discarded).not.toContain(c);
});

test("the brief's button at the publish gate writes nothing and takes you to Approve", async () => {
  const q = await open();
  const b = q.q(".next-thing");
  expect(b.textContent).toBe("Review the draft");
  const before = q.s.entries("CASE-1").length;
  q.click(b); q.click(b);
  await q.settle(); await q.s.app.hub.idle(); await q.settle();
  expect(q.s.entries("CASE-1").length).toBe(before);
  expect(st(q).published.length).toBe(0);
  expect(q.doc.activeElement).toBe(q.q(".lens-dock [data-action=approve]"));
});

test("the brief's button at the plan gate writes nothing and takes you to Accept", async () => {
  const q = await open("plan");
  const b = q.q(".next-thing");
  // the sample's plan has a costly step: the button opens the Steps lens; with free steps only it says Review the plan and focuses Accept
  expect(["Review the plan", "Review plan: 1 steps need a budget"]).toContain(b.textContent!);
  const before = q.s.entries("CASE-1").length;
  q.click(b);
  await q.settle(); await q.s.app.hub.idle(); await q.settle();
  expect(q.s.entries("CASE-1").length).toBe(before);
  expect(q.all(".lens-steps").length).toBe(1);
});

test("at the plan gate and at the publish gate the brief holds exactly one Review button", async () => {
  for (const at of ["plan", "publish"] as const) {
    const q = await open(at);
    const names = q.all(".brief button").map((b) => b.textContent!).filter((t) => t.startsWith("Review"));
    expect(names.length).toBe(1);
    expect(q.all(".brief .next-thing").length).toBe(1);
    expect(q.all(".brief .run-button").length).toBe(0);
  }
});

test("while paused the brief holds exactly one Resume button, the run button", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  await p.s.command(id, "pause");
  p.win.location.hash = `#/case/${id}`; await p.settle();
  const resumes = p.all(".brief button").filter((b) => /^Resume/.test(b.textContent!));
  expect(resumes.length).toBe(1);
  expect(resumes[0]!.classList.contains("run-button")).toBe(true);
});

test("lanes can be renamed in place, added, and removed only when empty", async () => {
  const q = await open();
  const lane = q.q(".lane");
  const id = lane.dataset.lane!;
  const title = lane.querySelector(".lane-title") as HTMLElement;
  title.focus(); q.press("F2");
  const input = q.q(`[data-lane=${id}] input`) as HTMLInputElement;
  q.fill(input, "Renamed"); q.press("Enter"); await q.settle();
  expect(st(q).lanes.find((l) => l.id === id)!.title).toBe("Renamed");
  expect(q.q(`[data-lane=${id}] .lane-title`).textContent).toBe("Renamed");
  // Esc cancels
  q.q(`[data-lane=${id}] .lane-title`).dispatchEvent(new q.win.MouseEvent("dblclick", { bubbles: true }) as unknown as Event);
  const again = q.q(`[data-lane=${id}] input`) as HTMLInputElement;
  q.fill(again, "No"); q.press("Escape");
  expect(q.root.querySelector(`[data-lane=${id}] input`)).toBeNull();
  expect(st(q).lanes.find((l) => l.id === id)!.title).toBe("Renamed");
  // add
  q.click(".new-lane"); q.fill(q.q(".new-lane-form input"), "Extra"); q.press("Enter"); await q.settle();
  const extra = st(q).lanes.find((l) => l.title === "Extra")!;
  expect(q.q(`[data-lane=${extra.id}]`)).toBeDefined();
  // remove only when empty
  expect(q.q(`[data-lane=${extra.id}] [aria-label='Remove lane Extra']`)).toBeDefined();
  const full = st(q).lanes.find((l) => l.cards.length > 0);
  if (full !== undefined) expect(q.root.querySelector(`[data-lane=${full.id}] [aria-label^='Remove lane']`)).toBeNull();
  q.click(`[data-lane=${extra.id}] [aria-label='Remove lane Extra']`); await q.settle();
  expect(q.root.querySelector(`[data-lane=${extra.id}]`)).toBeNull();
});

test("activating a lane header makes it the keep target", async () => {
  const q = await open();
  const other = q.all(".lane").find((l) => !l.classList.contains("target"))!;
  q.click(other.querySelector(".lane-title")!); await q.settle();
  expect(st(q).target).toBe(other.dataset.lane!);
  expect(q.q(".lane.target").dataset.lane).toBe(other.dataset.lane!);
  expect(q.all(".lane[aria-current=true]").length).toBe(1);
});

test("a paused run shows why, and Resume is the run button", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  await p.s.command(id, "pause");
  p.win.location.hash = `#/case/${id}`; await p.settle();
  expect(p.q(".paused").textContent).toBe(`Paused: ${st(p).run.pause_reason}`);
  expect(p.q(".run-button").textContent).toBe("Resume");
  expect((p.q(".pause") as HTMLButtonElement).disabled).toBe(true);
});

test("an interrupted run says so and offers Resume", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  p.s.app.hub.read(id).commit(() => [{ type: "run.interrupted", actor: { kind: "system", id: "t" }, payload: {} }]);
  p.win.location.hash = `#/case/${id}`; await p.settle();
  expect(p.q(".interrupted").textContent).toContain("Interrupted: the server stopped during this run.");
  expect(p.q(".interrupted button").textContent).toBe("Resume");
  expect(p.q(".run-button").textContent).toBe("Resume");
});

test("Stop asks for a reason first and then sends stop", async () => {
  const q = await open("plan");
  const sent: unknown[] = [];
  q.ui.act = async (c, a) => { sent.push([c, a]); return true; };
  q.click(".stop");
  q.fill(q.q(".stop-reason"), "no longer needed"); q.press("Enter"); await q.settle();
  expect(sent).toEqual([["stop", { reason: "no longer needed" }]]);
});

test("while replaying, controls are disabled and commands are not sent", async () => {
  const q = await open();
  const c = firstIncoming(q);
  q.click(`[data-card=${c}]`);
  const head = q.s.entries("CASE-1").length;
  q.store()!.goTo(5); await q.settle();
  expect(q.q(".replay-banner .banner-text").textContent).toBe(`Replay · entry 5 of ${head} · read-only`);
  expect((q.q(".run-button") as HTMLButtonElement).disabled).toBe(true);
  expect(q.all(".brief button").filter((b) => (b as HTMLButtonElement).disabled).length).toBeGreaterThan(0);
  expect(q.all(".brief .stop, .brief .pause").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  expect((await q.ui.act("pause"))).toBe(false);
  expect(q.toasts().at(-1)).toBe("Return to live to change the case");
  expect(q.s.entries("CASE-1").length).toBe(head);
  q.store()!.goTo(null); await q.settle();
  expect(q.root.querySelector(".replay-banner")).toBeNull();
});

test("the dock side and the collapsed brief are remembered", async () => {
  const q = await open();
  q.click(".brief .hide-toggle"); await q.settle();
  expect(q.ui.prefs.get("brief", false)).toBe(true);
  expect(q.q(".brief .hide-toggle").textContent).toBe("Show");
  expect(q.q(".brief").classList.contains("collapsed")).toBe(true);
  q.click(".dock-side");
  expect(q.ui.prefs.get("dock", "")).toBe("right");
  expect(q.q(".dock-side").textContent).toBe("Dock bottom");
});

test("sort, reverse and group are remembered and reorder Incoming", async () => {
  const q = await open();
  const ids = (): string[] => q.all("[data-area=incoming] [data-card]").map((e) => e.dataset.card!);
  const before = ids();
  q.click("[aria-label='Reverse order']"); await q.settle();
  expect(ids()).toEqual([...before].reverse());
  expect(q.ui.prefs.get<{ reverse: boolean }>("incoming", { reverse: false }).reverse).toBe(true);
  const group = q.q("[aria-label='Group by']") as HTMLSelectElement;
  group.value = "source"; group.dispatchEvent(new q.win.Event("change", { bubbles: true }) as unknown as Event); await q.settle();
  expect(q.all("[data-area=incoming] .group").length).toBeGreaterThan(0);
  expect(q.ui.prefs.get<{ group: string }>("incoming", { group: "none" }).group).toBe("source");
});

test("five hundred cards arrive without rebuilding the list", async () => {
  const q = await open("none");
  const session = q.s.app.hub.read("CASE-1");
  const sys = { kind: "system" as const, id: "t" };
  session.commit((_s, ids) => [{ type: "card.created", actor: sys, payload: { card: card(ids.next("card")) } }]);
  await q.settle();
  const firstNode = q.q("[data-card=c1]");
  session.commit((_s, ids) => Array.from({ length: 499 }, () => ({ type: "card.created" as const, actor: sys, payload: { card: card(ids.next("card")) } })));
  await q.settle();
  expect(q.all("[data-area=incoming] [data-card]").length).toBe(500);
  expect(q.q("[data-card=c1]")).toBe(firstNode);
});

test("an Undo does not outlive its case: leaving dismisses it, and a stale click sends nothing", async () => {
  const q = await open();
  await q.s.newCase();
  const c = firstIncoming(q);
  q.click(`[data-card=${c}]`); q.click(`[data-card=${c}] [data-action=keep]`); await q.settle();
  const undo = q.q(".toast [data-action=undo]");
  const sent: string[] = [];
  const real = q.ui.api.command;
  q.ui.api.command = async (id, name, args) => { sent.push(`${id} ${name}`); return real(id, name, args); };
  q.win.location.hash = "#/case/CASE-2"; await q.settle();
  expect(q.root.querySelector(".toast [data-action=undo]")).toBeNull();
  q.click(undo); await q.settle();                // a click on the detached button's handler, as a late one would be
  expect(sent).toEqual([]);
});

test("Undo bound to a case refuses when another case is open", async () => {
  const q = await open();
  await q.s.newCase();
  q.win.location.hash = "#/case/CASE-2"; await q.settle();
  expect(await q.ui.send("undo", { target: 1 }, undefined, "CASE-1")).toBeNull();
  expect(q.toasts().at(-1)).toBe("That undo belongs to CASE-1");
});

test("the Stop reason stays typed when the server refuses it", async () => {
  const q = await open("plan");
  q.ui.act = async () => false;
  q.click(".stop");
  q.fill(q.q(".stop-reason"), "because"); q.press("Enter"); await q.settle();
  expect((q.q(".stop-reason") as HTMLInputElement).value).toBe("because");
});
