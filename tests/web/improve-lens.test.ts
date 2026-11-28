import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import type { Entry } from "../../src/core/types";
import type { ImproveView } from "../../src/core/wire";
import type { Api } from "../../src/web/api";
import { parseRoute, routeHash } from "../../src/web/app";
import type { Nav, Route } from "../../src/web/app";
import { makeImprove } from "../../src/web/lenses/improve";
import { CaseStore } from "../../src/web/store";
import type { Ui } from "../../src/web/ui";
import { page, testUi } from "../helpers/dom";
import type { Page } from "../helpers/dom";
import { improveCase, RESEARCH } from "../helpers/improve-run";
import type { ImproveRunOptions } from "../helpers/improve-run";
import { withImproveLoop } from "../helpers/served";

// Slice 14, Task 20: the Improve lens of an improve case — its request and tasks, the candidates with their diffs, the probes as a table of
// candidate by task, Compose's choice, the scores once the Judge has run, the lessons proposed, and the Adopt gate, which only its own button
// passes (ruling: the whole candidate is accepted or rejected at once). Over the served sample with an improve loop; an improve case is driven
// to its adopt gate by the test's runners. Every text is a text node.

let p: Page | null = null;
afterEach(async () => {
  if (p === null) return;
  try {
    for (const c of p.s.wb.listCases()) expect(`${c.id}: ${JSON.stringify(p.s.app.hub.read(c.id).state.skipped)}`).toBe(`${c.id}: []`);
  } finally { await p.close(); p = null; }
});
const pg = (): Page => p!;
const text = (el: Element | null): string => el?.textContent ?? "";
const settled = async (): Promise<void> => { for (let i = 0; i < 4; i++) await pg().settle(); };
const part = (name: string): HTMLElement | null => pg().root.querySelector(`.lens-improve [data-part=${name}]`);
const MARKUP = "<img src=x onerror=alert(1)>";

/** A page over the sample with an improve loop, and an improve case run to its adopt gate (or paused before the Judge). */
async function improvePage(opts: ImproveRunOptions = {}): Promise<string> {
  p = await page({ before: withImproveLoop });
  return improveCase(p.s, opts);
}
/** Opens the case and its Improve lens with the i key. */
async function openLens(id: string): Promise<void> {
  pg().win.location.hash = `#/case/${id}`;
  await pg().settle();
  pg().q(".workarea").focus();
  pg().press("i");
  await settled();
}
/** Records every send, then sends it. */
const recording = (): unknown[][] => {
  const sent: unknown[][] = [];
  const real = pg().ui.send;
  pg().ui.send = async (...a) => { sent.push(a.slice(0, 2)); return real(...a); };
  return sent;
};
const gate = (): HTMLElement | null => part("adopt");
const seqOf = (id: string, type: Entry["type"]): number => pg().s.entries(id).find((e) => e.type === type)!.seq;

/** The lens outside any page, over `entries` folded in a CaseStore, with the view `view`, for `role`. */
function lensOver(entries: Entry[], view: ImproveView, role: "analyst" | "leader" | "requester" = "analyst"): { el: HTMLElement; sent: unknown[][]; ui: Ui; done(): Promise<void> } {
  const win = new Window({ url: "http://127.0.0.1:1/" });
  const sent: unknown[][] = [];
  const base = testUi(win);
  const api = { ...base.api, improve: async () => view } as Api;
  const ui = testUi(win, { api, me: { ...base.me, role }, send: async (...a) => { sent.push(a.slice(0, 2)); return null; } });
  const store = new CaseStore(entries[0]!.case);
  for (const e of entries) store.push(e);
  const nav = { go: () => {} } as unknown as Nav;
  const lens = makeImprove(ui, { store, nav }, null);
  lens.update();
  return { el: lens.el, sent, ui, done: async () => { await new Promise((r) => setTimeout(r, 0)); lens.update(); } };
}
const viewOf = async (id: string): Promise<ImproveView> => (await (await pg().s.get(`/api/cases/${id}/improve`)).json()) as ImproveView;

test("the lens is offered in an improve case and in no other", async () => {
  const id = await improvePage();
  const plain = await pg().s.newCase();
  pg().win.location.hash = `#/case/${plain}`;
  await settled();
  expect(pg().root.querySelector(".shelf [data-lens=improve]")).toBeNull();
  pg().q(".workarea").focus();
  pg().press("i");
  await settled();
  expect(pg().root.querySelector(".lens-improve")).toBeNull();
  await openLens(id);
  expect(text(pg().q(".shelf [data-lens=improve]"))).toBe("Improve I");
  expect(pg().q(".lens-dock .lens-improve")).toBeDefined();
});

test("candidates, the probe table, the choice and the lessons are drawn from the view", async () => {
  const id = await improvePage();
  await openLens(id);
  expect(text(part("request")!.querySelector("h3"))).toBe("Improve investigation for unknown-device");
  const task = part("request")!.querySelector("[data-task=T1] button")!;
  expect(text(task)).toBe("T1 · CASE-90");
  expect(text(part("request")!.querySelector(".left-out"))).toContain("CASE-70: stricter than this case");

  const k1 = part("candidates")!.querySelector("[data-candidate=K1]")!;
  expect(text(k1.querySelector(".candidate-title"))).toBe("K1 · Say why");
  expect(text(k1.querySelector(".candidate-why"))).toBe("fewer misses");
  expect(text(k1.querySelector(".candidate-status"))).toBe("staged");
  expect([...k1.querySelectorAll(".builder-file .file-path")].map(text)).toEqual([RESEARCH, "context/procedures/assemble.md"]);
  expect([...k1.querySelectorAll(".diff-added")].map(text).some((l) => l.startsWith("+") && l.endsWith("Say what was not found, and why."))).toBe(true);
  const k2 = part("candidates")!.querySelector("[data-candidate=K2]")!;
  expect(text(k2.querySelector(".candidate-status"))).toBe("dropped");
  expect(text(k2.querySelector(".candidate-reason"))).toBe("Dropped: it gives the loop's own version");

  const table = part("probes")!.querySelector("table")!;
  expect([...table.querySelectorAll("thead th")].map(text)).toEqual(["", "T1"]);
  expect([...table.querySelectorAll("tbody th")].map(text)).toEqual(["base", "K1"]);
  expect(text(table.querySelector("[data-probe='base/T1'] button"))).toBe("drafted · 3 lookups · 1000 tokens");
  expect(text(table.querySelector("[data-probe='K1/T1'] button"))).toBe("drafted · 4 lookups · 1001 tokens");

  expect(text(part("choice")!.querySelector(".chosen"))).toBe("Compose chose K1");
  expect(text(part("choice")!.querySelector(".chosen-why"))).toBe("K1 states why nothing was found");

  const lesson = part("lessons")!.querySelector("[data-lesson=LESSON-7] button")!;
  expect(text(lesson)).toBe("LESSON-7 · Say why nothing was found");
  pg().click(lesson);
  expect(pg().win.location.hash).toBe("#/memory");
});

test("no score is drawn from a view whose scores are null", async () => {
  const id = await improvePage({ judge: false });
  expect(pg().s.app.hub.read(id).state.improve.scored).toBeNull();
  await openLens(id);
  expect(part("candidates")).not.toBeNull();
  expect(part("scores")).toBeNull();
  expect(gate()).toBeNull();
  expect(text(pg().q(".lens-improve"))).not.toContain("875");
});

test("in replay at a seq before judge.scored the scores section is absent, and at the end it is there", async () => {
  const id = await improvePage();
  await openLens(id);
  const store = pg().store()!;
  store.goTo(seqOf(id, "judge.scored") - 1);
  await settled();
  expect(part("scores")).toBeNull();
  expect(part("choice")).not.toBeNull();
  expect(gate()).toBeNull();
  store.goTo(seqOf(id, "compose.chosen") - 1);
  await settled();
  expect(part("choice")).toBeNull();
  expect(part("probes")).not.toBeNull();
  store.goTo(null);
  await settled();
  const scores = part("scores")!;
  expect([...scores.querySelectorAll(".score-summary tbody tr")].map((r) => [...r.children].map(text))).toEqual([["base", "500", "1 of 1"], ["K1", "875", "1 of 1"]]);
  const k1 = scores.querySelector("[data-output='K1/T1']")!;
  expect(text(k1.querySelector(".output-score"))).toBe("K1/T1 · drafted · 875");
  expect(text(k1.querySelector("[data-expected='1']"))).toBe("expected finding 1: matched by code to “the device is a printer” · similarity 800 · likelihood distance 0 · confidence distance 500 · score 875");
  expect(text(scores.querySelector("[data-output='base/T1'] [data-expected='1']"))).toBe("expected finding 1: not matched · score 0");
  expect(text(scores.querySelector("[data-output='base/T1'] .left-over"))).toBe("Also stated, matching no expected finding: a statement no answer expects");
});

test("a probe's cell links to its child at the recorded head", async () => {
  const id = await improvePage();
  await openLens(id);
  const cell = part("probes")!.querySelector("[data-probe='K1/T1'] button") as HTMLElement;
  expect(cell.getAttribute("title")).toBe("Open CASE-81 at entry 41");
  pg().click(cell);
  expect(pg().win.location.hash).toBe("#/case/CASE-81/at/41");
  const route: Route = { screen: "case", id: "CASE-81", at: 41 };
  expect(parseRoute("#/case/CASE-81/at/41")).toEqual(route);
  expect(routeHash(route)).toBe("#/case/CASE-81/at/41");
  expect(parseRoute("#/case/CASE-81")).toEqual({ screen: "case", id: "CASE-81" });
  for (const bad of ["#/case/CASE-81/at/", "#/case/CASE-81/at/-1", "#/case/CASE-81/at/01", "#/case/CASE-81/at/x"]) expect(parseRoute(bad)).toEqual({ screen: "home" });
});

test("at the adopt gate each file has Accept and Reject, which send adopt_decide with the change, the file and the choice", async () => {
  // ruling: Adopt is all or nothing, so the gate shows each file of the chosen change and one Accept and one Reject for the whole candidate
  const id = await improvePage();
  await openLens(id);
  const g = gate()!;
  expect(text(g.querySelector("h3"))).toBe("Adopt K1 · Say why");
  expect(text(g.querySelector(".adopt-whole"))).toBe("The score shown is the whole candidate's: K1 scored 875 of 1000, the unchanged loop 500. Its 2 files are accepted or rejected together.");
  expect([...g.querySelectorAll(".adopt-file .file-path")].map(text)).toEqual([RESEARCH, "context/procedures/assemble.md"]);
  expect(g.querySelectorAll("[data-action=adopt-accept]").length).toBe(1);
  expect(g.querySelectorAll("[data-action=adopt-reject]").length).toBe(1);
  expect(g.querySelector("[data-action=adopt-finish]")).toBeNull();
  const sent = recording();
  pg().click(g.querySelector("[data-action=adopt-accept]")!);
  await settled();
  expect(sent).toEqual([["adopt_decide", { change: "chg-1", accept: true }]]);
  const s = pg().s.app.hub.read(id).state;
  expect(s.run).toMatchObject({ status: "finished", outcome: "completed" });
  expect(readFileSync(join(pg().s.config.roots[0]!.path, ...RESEARCH.split("/")), "utf8")).toContain("Say what was not found, and why.");
  expect(gate()).toBeNull();
  expect([...pg().root.querySelectorAll(".lens-improve [data-candidate=K1] .file-decided")].map(text)).toEqual(["Accepted", "Accepted"]);

  // Reject sends the same command with accept false
  const other = await improveCase(pg().s);
  await openLens(other);
  const rejects = recording();
  pg().click(gate()!.querySelector("[data-action=adopt-reject]")!);
  await settled();
  expect(rejects).toEqual([["adopt_decide", { change: "chg-1", accept: false }]]);
  expect(pg().s.app.hub.read(other).state.run).toMatchObject({ status: "finished", outcome: "completed" });
});

test("a change with a file decided already offers only Reject, sent as adopt_decide; there is no Finish; a reader has no button", async () => {
  const id = await improvePage();
  const entries = pg().s.entries(id);
  const view = await viewOf(id);
  // a change with one file decided already (as a ledger from before the ruling could hold): the only act left is to reject the rest
  const last = entries.at(-1)!;
  const decided: Entry = { ...last, seq: last.seq + 1, prev_hash: last.hash, hash: "7".repeat(64), type: "builder.decided", actor: { kind: "human", id: "analyst" }, payload: { change: "chg-1", file: 1, accepted: false, written: null }, run: last.run, stage: null, cause: null, job: null } as Entry;
  const partly = lensOver([...entries, decided], { ...view, adopt: { ...view.adopt!, undecided: 1 } });
  await partly.done();
  expect(partly.el.querySelector("[data-action=adopt-accept]")).toBeNull();
  expect(partly.el.querySelector("[data-action=adopt-finish]")).toBeNull();
  const reject = partly.el.querySelector("[data-action=adopt-reject]") as HTMLButtonElement;
  expect(text(reject)).toBe("Reject");
  reject.click();
  expect(partly.sent).toEqual([["adopt_decide", { change: "chg-1", accept: false }]]);

  for (const role of ["leader", "requester"] as const) {
    const read = lensOver(entries, view, role);
    await read.done();
    expect(read.el.querySelector("[data-part=adopt]")).not.toBeNull();
    expect(read.el.querySelectorAll("[data-part=adopt] button").length).toBe(0);
  }
});

test("a stale file's Accept is disabled and says why", async () => {
  const id = await improvePage();
  const path = join(pg().s.config.roots[0]!.path, ...RESEARCH.split("/"));
  writeFileSync(path, `${readFileSync(path, "utf8")}A line a person added since.\n`);
  await openLens(id);
  const g = gate()!;
  const accept = g.querySelector("[data-action=adopt-accept]") as HTMLButtonElement;
  expect(accept.disabled).toBe(true);
  expect(text(g.querySelector(`.adopt-file[data-file='0'] .file-stale`))).toBe("This file changed on disk since it was proposed, so the candidate cannot be accepted.");
  expect(g.querySelector(`.adopt-file[data-file='1'] .file-stale`)).toBeNull();
  expect(text(g.querySelector(".adopt-stale"))).toBe("Accept is off: 1 file changed on disk since the candidate was proposed. Run the improve loop again.");
  expect((g.querySelector("[data-action=adopt-reject]") as HTMLButtonElement).disabled).toBe(false);
});

test("a title, a reason and a diff line that look like markup are text", async () => {
  const id = await improvePage({ title: MARKUP, why: MARKUP, reason: MARKUP });
  await openLens(id);
  const lens = pg().q(".lens-improve");
  expect(text(lens.querySelector("[data-candidate=K1] .candidate-title"))).toBe(`K1 · ${MARKUP}`);
  expect(text(lens.querySelector("[data-candidate=K1] .candidate-why"))).toBe(MARKUP);
  expect(text(lens.querySelector(".chosen-why"))).toBe(MARKUP);
  expect(lens.querySelectorAll("img").length).toBe(0);
  // a diff line that looks like markup, drawn outside the page
  const entries = pg().s.entries(id);
  const view = await viewOf(id);
  const marked: ImproveView = { ...view, candidates: view.candidates.map((c) => ({ ...c, files: c.files.map((f) => ({ ...f, lines: [{ op: "+", text: MARKUP }] })) })) };
  const out = lensOver(entries, marked);
  await out.done();
  expect([...out.el.querySelectorAll("[data-candidate=K1] .diff-added")].map(text)).toEqual([`+${MARKUP}`, `+${MARKUP}`]);
  expect(out.el.querySelectorAll("img").length).toBe(0);
});
