import { afterEach, expect, test } from "bun:test";
import type { Actor } from "../../src/core/types";
import type { LessonDraft } from "../../src/core/lessons";
import { CASE_TYPE_WHY } from "../../src/pipeline/memory";
import { noteMemory } from "../../src/pipeline/notes";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";
import { withMemoryLoop } from "../helpers/served";

// Task 14: a case's Memory lens (its type, its notebook, the shared lessons a run was given) and the case type on a new case, over the real
// served app with the "memo" loop, which reads the shared lessons of the case's type and the case's notes at Plan and Research.

let p: Page | null = null;
afterEach(async () => {
  if (p === null) return;
  try {
    for (const c of p.s.wb.listCases()) expect(p.s.app.hub.read(c.id).state.skipped).toEqual([]);
    expect(p.s.wb.memory.state.skipped).toEqual([]);
  } finally { await p.close(); p = null; }
});

const MARKUP = "<img src=x onerror=alert(1)>";
const open = async (opts: { case_type?: string; hash?: string } = {}): Promise<Page> => {
  p = await page({ before: (root) => withMemoryLoop(root, opts.case_type === undefined ? {} : { case_type: opts.case_type }), ...(opts.hash === undefined ? {} : { hash: opts.hash }) });
  return p;
};
const pg = (): Page => p!;
const person = (): Actor => ({ kind: "human", id: pg().s.config.user });
const agent = (stage: string): Actor => ({ kind: "agent", id: `${stage}-agent`, stage, profile: "memory-test", model: "s", effort: null, where: "machine" });
const draft = (over: Partial<LessonDraft> = {}): LessonDraft => ({
  case_type: "unknown-device", title: "Read the lease table first", text: "The lease table names a lobby device before the flows do.", triggers: [], marking: "TLP:GREEN", supersedes: null, ...over,
});
/** A lesson a person proposes and accepts in the store directly; its id. */
const share = (over: Partial<LessonDraft> = {}): string => {
  const { lesson } = pg().s.wb.memory.propose(draft(over), { kind: "person" }, person());
  pg().s.wb.memory.accept(lesson.id, { actor: person(), hash: lesson.hash });
  return lesson.id;
};
const state = (id = "CASE-1") => pg().s.app.hub.read(id).state;
const lens = (): HTMLElement => pg().q(".lens-dock .lens-memory");
const part = (name: string): HTMLElement => pg().q(`.lens-memory [data-part=${name}]`);
const text = (el: Element | null): string => el?.textContent ?? "";
/** Sets a select's value and says it changed, as a person's pick does. */
const choose = (selector: string, value: string): void => {
  const el = pg().q(selector) as HTMLSelectElement;
  el.value = value;
  el.dispatchEvent(new (pg().win.Event)("change", { bubbles: true }) as unknown as Event);
};

/** Opens the case and its Memory lens with the m key. */
async function openLens(id = "CASE-1"): Promise<void> {
  pg().win.location.hash = `#/case/${id}`;
  await pg().settle();
  pg().press("m");
  await pg().settle();
  await pg().settle();
}
/** A memo case with no type, run until Frame's question of its type holds it. */
async function heldOnType(): Promise<string> {
  const id = await pg().s.newCase({ loop: "memo" });
  expect((await pg().s.command(id, "start_run")).status).toBe(200);
  await pg().s.app.hub.idle();
  expect(state(id).run).toMatchObject({ status: "paused", hold: { kind: "question", stage: "frame" } });
  expect(Object.values(state(id).questions).some((q) => q.why === CASE_TYPE_WHY)).toBe(true);
  return id;
}
/** A memo case typed at creation, run to its plan gate (memory bound at the run's start). */
async function typedAtPlanGate(): Promise<string> {
  const id = await pg().s.newCase({ loop: "memo", type: "unknown-device" });
  await pg().s.toPlanGate(id);
  return id;
}

test("the lens shows the case's type, and No case type for a case with none, with the line that no shared lesson is offered", async () => {
  await open();
  const untyped = await pg().s.newCase({ loop: "memo" });
  const typed = await pg().s.newCase({ loop: "memo", type: "unknown-device" });
  await openLens(untyped);
  expect(lens().closest(".lens-dock")).not.toBeNull();
  expect(text(part("type").querySelector(".case-type"))).toBe("No case type");
  expect(text(part("type").querySelector(".no-shared"))).toBe("This case has no type, so no shared lesson is offered to it.");
  expect(text(part("lessons").querySelector(".no-binding"))).toBe("No run of this case has loaded shared lessons.");
  expect(text(lens())).not.toContain("null");
  // the select offers None and each loaded case type
  const select = part("type").querySelector("[data-field=case-type]") as HTMLSelectElement;
  expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([["", "None"], ["phishing", "Phishing"], ["unknown-device", "Unknown device"]]);
  await openLens(typed);
  expect(text(part("type").querySelector(".case-type"))).toBe("Unknown device");
  expect(part("type").querySelector(".no-shared")).toBeNull();
  expect((part("type").querySelector("[data-field=case-type]") as HTMLSelectElement).value).toBe("unknown-device");
  // Set with None clears it; Set with a type sets it
  choose(".lens-memory [data-field=case-type]", "");
  pg().click(".lens-memory [data-action=set-type]");
  await pg().settle();
  expect(state(typed).memory.type).toBeNull();
  expect(text(part("type").querySelector(".case-type"))).toBe("No case type");
});

test("Frame's proposal is shown with Confirm, which sends set_case_type with that type", async () => {
  await open();
  const id = await heldOnType();
  await openLens(id);
  const proposal = part("type").querySelector(".type-proposal")!;
  expect(text(proposal.querySelector(".suggests"))).toBe("Frame suggests: Unknown device");
  expect(text(proposal.querySelector(".why"))).toBe(state(id).memory.proposed_type!.why);
  pg().click(".lens-memory [data-action=confirm-type]");
  await pg().settle();
  expect(state(id).memory.type).toBe("unknown-device");
  expect(pg().s.entries(id).filter((e) => e.type === "case.type_set").at(-1)!.actor).toEqual(person());
  await pg().settle();
  expect(text(part("type").querySelector(".case-type"))).toBe("Unknown device");
  expect(part("type").querySelector(".type-proposal")).toBeNull();
});

test("the notebook lists live notes newest first with who noted each, and dropped ones under a closed details", async () => {
  await open();
  const id = await pg().s.newCase({ loop: "memo", type: "unknown-device" });
  expect((await pg().s.command(id, "add_statement", { statement: "The device sits by the lobby desk.", basis: "saw" })).status).toBe(200);
  const card = Object.keys(state(id).cards)[0]!;
  const session = pg().s.app.hub.read(id);
  const m1 = noteMemory(session, { kind: "fact", text: "The device answered on 192.0.2.10.", cards: [card], actor: agent("research") });
  const m2 = noteMemory(session, { kind: "decision", text: "Leave the printer range out.", actor: person() });
  const m3 = noteMemory(session, { kind: "pointer", text: "See the lease table.", actor: person() });
  expect((await pg().s.command(id, "drop_memory", { item: m2, reason: "the printers are in scope after all" })).status).toBe(200);
  await openLens(id);
  const notes = pg().all(".lens-memory [data-part=notebook] .notes .note");
  expect(notes.map((n) => n.dataset.note)).toEqual([m3, m1]);
  const first = notes[1]!;
  expect(text(first.querySelector(".kind"))).toBe("fact");
  expect(text(first.querySelector(".text"))).toBe("The device answered on 192.0.2.10.");
  expect(text(first.querySelector(".who"))).toBe("noted by research-agent at the research stage");
  expect(text(notes[0]!.querySelector(".who"))).toBe(`noted by ${pg().s.config.user}`);
  // the cards a note names are links that focus the card
  const chip = first.querySelector(".card-chip") as HTMLElement;
  expect(text(chip)).toBe(card);
  pg().click(chip);
  expect(pg().navCalls.at(-1)).toEqual(["focusCard", card]);
  const dropped = pg().q(".lens-memory details.dropped-notes") as HTMLDetailsElement;
  expect(dropped.open).toBe(false);
  expect(text(dropped.querySelector("summary"))).toBe("Dropped notes (1)");
  const row = dropped.querySelector(`.dropped-note[data-note=${m2}]`)!;
  expect(text(row.querySelector(".text"))).toBe("Leave the printer range out.");
  expect(text(row.querySelector(".dropped-why"))).toBe(`dropped by ${pg().s.config.user}: the printers are in scope after all`);
  expect(pg().root.querySelector(".lens-memory .no-notebook")).toBeNull();
});

test("adding, revising and dropping a note send note_memory, revise_memory and drop_memory; Drop sends nothing without a reason", async () => {
  await open();
  const id = await pg().s.newCase({ loop: "memo", type: "unknown-device" });
  await openLens(id);
  choose(".lens-memory [data-field=note-kind]", "decision");
  pg().fill(".lens-memory [data-field=note-text]", "Ask the lobby desk first.");
  expect(text(pg().q(".lens-memory .note-count"))).toBe("25 / 600");
  pg().click(".lens-memory [data-action=add-note]");
  await pg().settle();
  const notes = Object.values(state(id).memory.notes);
  expect(notes.map((n) => [n.id, n.kind, n.text, n.by])).toEqual([["m1", "decision", "Ask the lobby desk first.", "human"]]);
  expect(text(pg().q(".lens-memory .note[data-note=m1] .text"))).toBe("Ask the lobby desk first.");
  expect((pg().q(".lens-memory [data-field=note-text]") as HTMLTextAreaElement).value).toBe("");
  // Revise: the text in a field, saved by revise_memory
  pg().click(".lens-memory .note[data-note=m1] [data-action=revise]");
  const field = pg().q(".lens-memory .note[data-note=m1] [data-field=revise-text]") as HTMLTextAreaElement;
  expect(field.value).toBe("Ask the lobby desk first.");
  pg().fill(field, "Ask the lobby desk, then the AP-3 log.");
  pg().click(".lens-memory .note[data-note=m1] [data-action=save-revision]");
  await pg().settle();
  expect(state(id).memory.notes.m1).toMatchObject({ kind: "decision", text: "Ask the lobby desk, then the AP-3 log." });
  expect(state(id).memory.notes.m1!.revised).not.toBeNull();
  expect(text(pg().q(".lens-memory .note[data-note=m1] .text"))).toBe("Ask the lobby desk, then the AP-3 log.");
  // Drop: disabled, and sends nothing, without a reason
  const before = pg().s.entries(id).length;
  const drop = pg().q(".lens-memory .note[data-note=m1] [data-action=drop]") as HTMLButtonElement;
  expect(drop.disabled).toBe(true);
  drop.disabled = false;      // even forced on, a click with no reason sends nothing
  pg().click(drop);
  await pg().settle();
  expect(pg().s.entries(id).length).toBe(before);
  pg().fill(".lens-memory .note[data-note=m1] [data-field=drop-reason]", "the desk was asked");
  expect((pg().q(".lens-memory .note[data-note=m1] [data-action=drop]") as HTMLButtonElement).disabled).toBe(false);
  pg().click(".lens-memory .note[data-note=m1] [data-action=drop]");
  await pg().settle();
  expect(state(id).memory.notes.m1!.dropped).toMatchObject({ by: pg().s.config.user, reason: "the desk was asked" });
  expect(pg().all(".lens-memory .notes .note")).toEqual([]);
  expect(pg().q(".lens-memory .dropped-note[data-note=m1]")).not.toBeNull();
});

test("a note's text that looks like markup is text", async () => {
  await open();
  const id = await pg().s.newCase({ loop: "memo", type: "unknown-device" });
  noteMemory(pg().s.app.hub.read(id), { kind: "fact", text: MARKUP, actor: person() });
  await openLens(id);
  expect(text(pg().q(".lens-memory .note[data-note=m1] .text"))).toBe(MARKUP);
  expect(pg().root.querySelector(".lens-memory img")).toBeNull();
  pg().click(".lens-memory .note[data-note=m1] [data-action=revise]");
  expect((pg().q(".lens-memory [data-field=revise-text]") as HTMLTextAreaElement).value).toBe(MARKUP);
  expect(pg().root.querySelector(".lens-memory img")).toBeNull();
});

test("a note over 600 characters is refused in place", async () => {
  await open();
  const id = await pg().s.newCase({ loop: "memo", type: "unknown-device" });
  await openLens(id);
  const before = pg().s.entries(id).length;
  pg().fill(".lens-memory [data-field=note-text]", "x".repeat(601));
  const count = pg().q(".lens-memory .note-count");
  expect(text(count)).toBe("601 / 600");
  expect(count.classList.contains("over")).toBe(true);
  pg().click(".lens-memory [data-action=add-note]");
  await pg().settle();
  expect(pg().s.entries(id).length).toBe(before);
  const refusal = pg().q(".lens-memory [data-act=add-note] .refusal");
  expect(text(refusal)).toBe("Refused: the note is 601 characters; a note is at most 600");
  // the text stays as typed
  expect((pg().q(".lens-memory [data-field=note-text]") as HTMLTextAreaElement).value.length).toBe(601);
});

test("the loaded lessons are listed with why each was offered and the stages it went to", async () => {
  await open();
  const given = share({ triggers: [{ observable: "address" }] });
  const id = await typedAtPlanGate();
  await openLens(id);
  const rows = pg().all(".lens-memory [data-part=lessons] .loaded-lesson");
  expect(rows.map((r) => r.dataset.lesson)).toEqual([given]);
  const r = rows[0]!;
  expect(text(r.querySelector(".id"))).toBe(given);
  expect(text(r.querySelector(".title"))).toBe("Read the lease table first");
  expect(text(r.querySelector(".marking"))).toBe("TLP:GREEN");
  expect(text(r.querySelector(".why"))).toBe("Offered because: observable address is present");
  expect(text(r.querySelector(".stages"))).toBe("Went to: plan, research");
  expect(text(r.querySelector(".from"))).toBe("From: proposed by a person");
  expect(r.querySelector(".no-longer")).toBeNull();
  expect(text(pg().q(".lens-memory .bound-at"))).toBe(`Bound at entry #${state(id).memory.bound!.seq}, from the store at entry ${pg().s.wb.memory.head().seq}`);
  expect(pg().root.querySelector(".lens-memory .left-out")).toBeNull();
});

test("what was left out is counted by reason and no title or text of a left-out lesson is on the page", async () => {
  await open();
  share();
  share({ title: "REDTITLE watched access point", text: "REDMARKER: the lobby AP-3 is watched.", marking: "TLP:AMBER" });
  share({ title: "PRINTERTITLE", text: "PRINTERMARKER: a printer's firmware phones home.", triggers: [{ finding: "printer firmware" }] });
  const id = await typedAtPlanGate();
  await openLens(id);
  expect(pg().all(".lens-memory .loaded-lesson").length).toBe(1);
  expect(text(pg().q(".lens-memory .left-out"))).toBe("1 not offered: stricter than this case · 1 not offered: their triggers did not match");
  for (const hidden of ["REDTITLE", "REDMARKER", "PRINTERTITLE", "PRINTERMARKER"]) expect(pg().text()).not.toContain(hidden);
});

test("a lesson retired since is marked no longer shared", async () => {
  await open();
  const given = share();
  const id = await typedAtPlanGate();
  pg().s.wb.memory.retire(given, { actor: person(), reason: "the lobby has a new lease table" });
  await openLens(id);
  expect(text(pg().q(`.lens-memory .loaded-lesson[data-lesson=${given}] .no-longer`))).toBe("no longer shared");
});

test("the lens reads the case's memory again when a new memory.bound arrives", async () => {
  await open();
  const given = share();
  const id = await heldOnType();
  const real = pg().ui.api.caseMemory.bind(pg().ui.api);
  let reads = 0;
  pg().ui.api.caseMemory = (c) => { reads++; return real(c); };
  await openLens(id);
  expect(reads).toBe(1);
  expect(pg().all(".lens-memory .loaded-lesson")).toEqual([]);
  expect(text(pg().q(".lens-memory .no-lessons"))).toBe("No shared lesson was offered to this run.");
  const boundBefore = state(id).memory.bound!.seq;
  pg().click(".lens-memory [data-action=confirm-type]");
  await pg().settle();
  await pg().settle();
  expect(state(id).memory.bound!.seq).toBeGreaterThan(boundBefore);
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(pg().all(".lens-memory .loaded-lesson").map((r) => r.dataset.lesson)).toEqual([given]);
});

test("in replay the notebook is the one of the replayed entry", async () => {
  await open();
  const given = share();
  const id = await typedAtPlanGate();
  const session = pg().s.app.hub.read(id);
  const boundAt = state(id).memory.bound!.seq;
  noteMemory(session, { kind: "fact", text: "First note.", actor: person() });
  const at = state(id).seq;
  expect((await pg().s.command(id, "drop_memory", { item: "m1", reason: "no longer true" })).status).toBe(200);
  noteMemory(session, { kind: "fact", text: "Second note.", actor: person() });
  await openLens(id);
  expect(pg().all(".lens-memory .notes .note").map((n) => n.dataset.note)).toEqual(["m2"]);
  pg().store()!.goTo(at);
  await pg().settle();
  expect(pg().all(".lens-memory .notes .note").map((n) => n.dataset.note)).toEqual(["m1"]);
  expect(text(pg().q(".lens-memory .note[data-note=m1] .text"))).toBe("First note.");
  expect(pg().root.querySelector(".lens-memory .dropped-note")).toBeNull();
  // a person's controls are off while replaying
  expect((pg().q(".lens-memory [data-action=add-note]") as HTMLButtonElement).disabled).toBe(true);
  expect((pg().q(".lens-memory .note[data-note=m1] [data-action=revise]") as HTMLButtonElement).disabled).toBe(true);
  expect(text(pg().q(".lens-memory .replay-binding"))).toBe(`At entry #${at} the binding of entry #${boundAt} was in force: the lessons below.`);
  expect(pg().all(".lens-memory .loaded-lesson").map((r) => r.dataset.lesson)).toEqual([given]);
  // before the run bound memory, no binding was in force
  pg().store()!.goTo(1);
  await pg().settle();
  expect(text(pg().q(".lens-memory .replay-binding"))).toBe("At entry #1 no binding of shared lessons was in force.");
  // the type is the one of that entry too: entry 1 is case.created, before its case.type_set
  expect(text(pg().q(".lens-memory .case-type"))).toBe("No case type");
  pg().store()!.goTo(null);
  await pg().settle();
  expect(text(pg().q(".lens-memory .case-type"))).toBe("Unknown device");
  await pg().settle();
  expect(pg().root.querySelector(".lens-memory .replay-binding")).toBeNull();
});

test("in replay at entry N the lens lists the lessons of the binding in force at N, not the latest binding's", async () => {
  await open();
  const first = share({ title: "The first lesson" });
  const id = await typedAtPlanGate();
  const boundAt = state(id).memory.bound!.seq;
  const mid = state(id).seq;
  // a second lesson is shared, and the person sets the case's type again during the run: memory is bound again, with both
  const second = share({ title: "The second lesson" });
  expect((await pg().s.command(id, "set_case_type", { type: null })).status).toBe(200);
  expect((await pg().s.command(id, "set_case_type", { type: "unknown-device" })).status).toBe(200);
  const latest = state(id).memory.bound!;
  expect(latest.seq).toBeGreaterThan(boundAt);
  expect(latest.lessons.map((l) => l.lesson)).toEqual([second, first]);
  await openLens(id);
  await pg().settle();
  expect(pg().all(".lens-memory .loaded-lesson").map((r) => r.dataset.lesson)).toEqual([second, first]);
  // at an entry before the second binding, the lessons listed are the first binding's
  pg().store()!.goTo(mid);
  await pg().settle();
  await pg().settle();
  expect(text(pg().q(".lens-memory .replay-binding"))).toBe(`At entry #${mid} the binding of entry #${boundAt} was in force: the lessons below.`);
  expect(text(pg().q(".lens-memory .bound-at"))).toStartWith(`Bound at entry #${boundAt},`);
  expect(pg().all(".lens-memory .loaded-lesson").map((r) => r.dataset.lesson)).toEqual([first]);
  expect(text(lens())).not.toContain("The second lesson");
  // back to live: the latest binding's
  pg().store()!.goTo(null);
  await pg().settle();
  await pg().settle();
  expect(pg().root.querySelector(".lens-memory .replay-binding")).toBeNull();
  expect(pg().all(".lens-memory .loaded-lesson").map((r) => r.dataset.lesson)).toEqual([second, first]);
});

test("the m key opens the lens, and the help card lists it", async () => {
  await open();
  const id = await pg().s.newCase({ loop: "memo", type: "unknown-device" });
  await openLens(id);
  expect(pg().q(".lens-dock").hidden).toBe(false);
  expect(pg().q(".lens-button[data-lens=memory]").classList.contains("active")).toBe(true);
  expect(text(pg().q(".lens-button[data-lens=memory]"))).toContain("Memory");
  pg().press("Escape");
  expect(pg().q(".lens-dock").hidden).toBe(true);
  pg().press("?");
  const rows = pg().all(".help tr").map((r) => text(r));
  expect(rows).toContain("mMemory");
  pg().press("Escape");
});

test("the new-case form posts the type chosen, and is preset from the loop's case type", async () => {
  await open({ case_type: "unknown-device", hash: "#/investigate/new/memo" });
  await pg().settle();
  const select = pg().q("[data-screen=new] #nc-type") as HTMLSelectElement;
  expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([["", "None"], ["phishing", "Phishing"], ["unknown-device", "Unknown device"]]);
  expect(select.value).toBe("unknown-device");
  pg().fill("#nc-title", "Typed from the loop");
  pg().fill("[aria-label='Starting value 1']", "198.51.100.77");
  pg().click("[data-screen=new] .primary");
  await pg().settle();
  expect(state("CASE-1").memory.type).toBe("unknown-device");
  // a type chosen on the form of the default loop is posted
  pg().win.location.hash = "#/investigate/new";
  await pg().settle();
  const plain = pg().q("[data-screen=new] #nc-type") as HTMLSelectElement;
  expect(plain.value).toBe("");
  choose("[data-screen=new] #nc-type", "phishing");
  pg().fill("#nc-title", "Typed by hand");
  pg().fill("[aria-label='Starting value 1']", "198.51.100.77");
  pg().click("[data-screen=new] .primary");
  await pg().settle();
  expect(state("CASE-2").memory.type).toBe("phishing");
  expect(pg().s.entries("CASE-2").find((e) => e.type === "case.type_set")!.actor).toEqual(person());
});

test("the case list shows a case's type; a loop's outline shows a memory item by its selector and the loop's case type", async () => {
  await open({ case_type: "unknown-device" });
  await pg().s.newCase({ loop: "memo", type: "phishing" });
  await pg().s.newCase();
  pg().win.location.hash = "#/investigate";
  await pg().settle();
  await pg().settle();
  const tile = (id: string): HTMLElement => pg().q(`.tile[title*='${id} ']`);
  expect(text(tile("CASE-1").querySelector(".chip.case-type"))).toBe("Phishing");
  expect(tile("CASE-2").querySelector(".chip.case-type")).toBeNull();
  pg().win.location.hash = "#/loops/memo";
  await pg().settle();
  await pg().settle();
  expect(text(pg().q("[data-screen=loop] .case-type-line"))).toBe("Case type: Unknown device");
  const plan = pg().q("[data-screen=loop] details.stage[data-stage=plan]");
  const memoryRows = [...plan.querySelectorAll("[data-group=context] .item")].filter((r) => r.querySelector(".memory-selector") !== null);
  expect(memoryRows.map((r) => text(r.querySelector(".memory-selector")))).toEqual(["memory: case/notes", "memory: shared/*"]);
  for (const r of memoryRows) expect(r.querySelector(".chip.hash")).toBeNull();
});

test("Propose as a lesson opens the Memory page with the form filled from the note, and files it from the case", async () => {
  await open();
  const id = await pg().s.newCase({ loop: "memo", type: "unknown-device" });
  noteMemory(pg().s.app.hub.read(id), { kind: "fact", text: "The lease table names the device.", actor: person() });
  await openLens(id);
  pg().click(".lens-memory .note[data-note=m1] [data-action=propose-lesson]");
  await pg().settle();
  expect(pg().win.location.hash).toBe("#/memory");
  const form = pg().q("[data-screen=memory] .memory-propose");
  expect((form.querySelector("[data-field=case-type]") as HTMLSelectElement).value).toBe("unknown-device");
  expect((form.querySelector("[data-field=text]") as HTMLTextAreaElement).value).toBe("The lease table names the device.");
  expect(text(form.querySelector(".from-note"))).toBe(`From note m1 of ${id}`);
  pg().fill("[data-screen=memory] [data-field=title]", "Read the lease table");
  pg().click("[data-screen=memory] [data-action=propose]");
  await pg().settle();
  const filed = Object.values(pg().s.wb.memory.state.lessons);
  expect(filed.map((l) => [l.status, l.title, l.text, l.from.kind])).toEqual([["proposed", "Read the lease table", "The lease table names the device.", "case"]]);
  expect(filed[0]!.from).toMatchObject({ kind: "case", case: id });
});

test("saving a loop from the edit form keeps its case type and its memory components", async () => {
  await open({ case_type: "unknown-device", hash: "#/loops/memo/edit" });
  await pg().settle();
  await pg().settle();
  const before = (await (await pg().s.get("/api/loops/memo")).json()) as { version: number; draft: Record<string, unknown> };
  expect(before.draft.case_type).toBe("unknown-device");
  pg().fill("[aria-label=\"About\"]", "The memo loop, edited.");
  pg().click("[data-action=save]");
  await pg().settle();
  await pg().settle();
  const after = (await (await pg().s.get("/api/loops/memo")).json()) as { version: number; about: string; case_type: string | null; draft: Record<string, unknown> };
  expect(after.version).toBe(before.version + 1);
  expect(after.about).toBe("The memo loop, edited.");
  expect(after.case_type).toBe("unknown-device");
  expect(after.draft.case_type).toBe("unknown-device");
  expect(after.draft.components).toEqual(before.draft.components);
  expect(JSON.stringify(after.draft.components)).toContain("\"memory\":\"shared/*\"");
  expect(JSON.stringify(after.draft.components)).toContain("\"memory\":\"case/notes\"");
});

test("after a resume that waived the question of the case's type, the lens says what the run went on without", async () => {
  await open();
  const id = await heldOnType();
  expect((await pg().s.command(id, "resume")).status).toBe(200);
  await pg().s.app.hub.idle();
  await openLens(id);
  expect(text(part("type").querySelector(".type-gap"))).toBe("The run went on without the case's type: no case type confirmed; no shared lessons loaded.");
});
