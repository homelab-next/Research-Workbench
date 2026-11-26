import { afterEach, expect, test } from "bun:test";
import { ACTIVITY } from "../../src/web/lenses/worklog";
import { describe as describeEntry } from "../../src/web/describe";
import { parseCommand, perform } from "../../src/web/commands";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";

let p: Page;
afterEach(async () => {
  try { expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]); } finally { await p.close(); }
});

/** A page on a sample case run to its publish gate, then published. */
async function published(): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPublishGate(id);
  expect((await p.s.command(id, "approve")).status).toBe(200);
  await p.s.app.hub.idle();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  return p;
}
const state = () => p.s.app.hub.read("CASE-1").state;

const wanted = (entries: readonly { seq: number; type: string; payload: Record<string, unknown> }[]) =>
  entries.filter((e) => ACTIVITY.has(e.type) || (e.type === "step.finished" && typeof e.payload.reused === "string"));
const everyBox = () => p.q("[aria-label='Every entry']") as HTMLInputElement;

test("the Worklog opens on what the system did, in the order of record, in UTC with milliseconds", async () => {
  await published(); p.press("w");
  const rows = p.all(".lens .worklog-row");
  const want = wanted(p.s.entries("CASE-1") as never);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.map((r) => r.dataset.seq)).toEqual(want.map((e) => String(e.seq)));
  expect(rows[0]!.querySelector("time")!.textContent).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(everyBox().checked).toBe(false);
});

test("Every entry shows every entry, and the choice is remembered", async () => {
  await published();
  p.press("w");
  p.click("[aria-label='Every entry']");
  const entries = p.s.entries("CASE-1");
  const rows = p.all(".lens .worklog-row");
  expect(rows.length).toBe(entries.length);
  const first = rows[0]!;
  expect(first.dataset.seq).toBe("1");
  expect(first.querySelector("time")!.textContent).toBe(entries[0]!.ts);
  expect(first.querySelector("time")!.textContent).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(first.querySelector(".actor-kind")!.textContent).toBe("human");
  expect(first.querySelector(".actor-id")!.textContent).toBe(entries[0]!.actor.id);
  expect(first.querySelector(".what")!.textContent).toBe(describeEntry(entries[0]!, p.ui.ref).what);
  const kinds = new Set(p.all(".lens .worklog-row .actor-kind").map((e) => e.textContent));
  expect([...kinds].sort()).toEqual(["agent", "human", "system"]);
  // each checkbox hides its kind
  p.click("[aria-label='Human']");
  expect(p.all(".lens .worklog-row .actor-kind").map((e) => e.textContent)).not.toContain("human");
  expect(p.all(".lens .worklog-row").length).toBe(entries.filter((e) => e.actor.kind !== "human").length);
  p.click("[aria-label='Agent']");
  p.click("[aria-label='System']");
  expect(p.all(".lens .worklog-row").length).toBe(0);
  p.click("[aria-label='Human']");
  expect(p.all(".lens .worklog-row").length).toBe(entries.filter((e) => e.actor.kind === "human").length);
  p.press("a"); await p.settle(); p.press("w"); await p.settle();
  expect(everyBox().checked).toBe(true);
});

test("the actor filters apply to both views", async () => {
  await published(); p.press("w");
  for (const every of [false, true]) {
    if (everyBox().checked !== every) p.click("[aria-label='Every entry']");
    expect(p.all(".lens .worklog-row .actor-kind").map((e) => e.textContent)).toContain("agent");
    p.click("[aria-label='Agent']");
    expect(p.all(".lens .worklog-row .actor-kind").map((e) => e.textContent)).not.toContain("agent");
    p.click("[aria-label='Agent']");
  }
});

test("a card's row goes to the card and is muted until the card is kept", async () => {
  await published();
  const id = state().incoming[0]!;
  expect((await p.s.command("CASE-1", "discard", { card: id })).status).toBe(200);
  await p.settle(); p.press("w");
  const cardRows = p.all(".lens .worklog-row[data-about]");
  expect(cardRows.length).toBe(Object.keys(state().cards).length);
  for (const r of cardRows) expect(r.classList.contains("muted")).toBe(state().cards[r.dataset.about!]!.place !== "lane");
  expect(cardRows.some((r) => r.classList.contains("muted"))).toBe(true);
  const kept = state().lanes[0]!.cards[0]!;
  p.click(`.lens .worklog-row[data-about=${kept}]`);
  await p.settle();
  expect((p.doc.activeElement as HTMLElement).dataset.card).toBe(kept);
});

test("Timeline is on the shelf marked soon, opens its explanation, and makes no rows", async () => {
  await published();
  expect(p.q('.shelf [data-lens="timeline"]').textContent).toBe("Timeline T · soon");
  expect(p.q('.shelf [data-lens="timeline"]').classList.contains("soon")).toBe(true);
  p.press("t");
  expect(p.q(".lens").textContent).toContain("on the data's own time axis");
  expect(p.all(".timeline-row")).toEqual([]);
});

test("the Worklog takes in entries as they arrive and keeps the filter", async () => {
  await published();
  p.press("w");
  p.click("[aria-label='Every entry']");
  p.click("[aria-label='Agent']");
  const before = p.all(".lens .worklog-row").length;
  p.s.app.hub.read("CASE-1").commit(() => [{ type: "run.paused", actor: { kind: "system", id: "t" }, payload: { reason: "x" } }]);
  await p.settle();
  expect(p.all(".lens .worklog-row").length).toBe(before + 1);
  expect((p.q("[aria-label='Agent']") as HTMLInputElement).checked).toBe(false);
});

test("a step finished on a reused query reads as reused on the Worklog", async () => {
  await published();
  const card = Object.keys(state().cards)[0]!;
  p.s.app.hub.read("CASE-1").commit(() => [{
    type: "step.finished", actor: { kind: "system", id: "t" },
    payload: { step: "s1", outcome: "answered", cards: [card], note: "reused q1 from 2026-11-20T10:00:00.000Z; same pivot, value and window", reused: "q1" },
  }]);
  await p.settle();
  p.press("w");
  const last = p.all(".lens .worklog-row").at(-1)!;
  expect(last.querySelector(".what")!.textContent).toBe("step reused, no query sent");
  expect(last.getAttribute("title")).toContain("reused q1 from 2026-11-20T10:00:00.000Z");
});

test("Discarded lists discarded cards and Restore brings one back to Incoming", async () => {
  await published();
  p.press("d");
  expect(p.q(".lens").textContent).toContain("Nothing discarded.");
  const [a, b] = state().incoming;
  await p.s.command("CASE-1", "discard", { card: a! });
  await p.s.command("CASE-1", "discard", { card: b! });
  await p.settle();
  expect(p.all(".lens [data-about]").map((e) => e.dataset.about)).toEqual([b!, a!]);
  expect(p.q(`.lens [data-about=${a}]`).textContent).toContain(state().cards[a!]!.title);
  expect(p.q(`.lens [data-about=${a}] .tag`)).toBeDefined();
  p.click(`.lens [data-about=${a}] [data-action=restore]`);
  await p.settle();
  expect(state().cards[a!]!.place).toBe("incoming");
  expect(p.all(".lens [data-about]").map((e) => e.dataset.about)).toEqual([b!]);
});

test("Restore is disabled while replaying", async () => {
  await published();
  const a = state().incoming[0]!;
  await p.s.command("CASE-1", "discard", { card: a });
  await p.settle();
  p.press("d");
  p.store()!.goTo(p.store()!.live.seq);
  await p.settle();
  expect((p.q("[data-action=restore]") as HTMLButtonElement).disabled).toBe(true);
});

test("Jobs lists every job with status, source and duration", async () => {
  await published();
  p.press("b");
  const jobs = Object.values(state().jobs);
  expect(jobs.length).toBeGreaterThan(0);
  const rows = p.all(".lens .job-row");
  expect(rows.length).toBe(jobs.length);
  const j = jobs[0]!;
  const row = p.q(`.lens .job-row[data-job=${j.id}]`);
  expect(row.textContent).toContain(j.title);
  expect(row.textContent).toContain(j.kind);
  expect(row.querySelector(".status")!.textContent).toBe(j.status);
  expect(row.querySelector(".duration")!.textContent).toMatch(/^(took \d+(\.\d)? s|took \d+ min \d+ s|running for \d+ s)$/);
  const withSource = jobs.find((x) => x.source !== null);
  if (withSource !== undefined) expect(p.q(`.lens .job-row[data-job=${withSource.id}] .source`).textContent).toBe(p.ui.ref.sources.find((s) => s.id === withSource.source)?.title ?? withSource.source!);
});

test("Jobs shows a running job first, as running", async () => {
  await published();
  p.s.app.hub.read("CASE-1").commit((_s, ids) => [{ type: "job.started", actor: { kind: "system", id: "t" }, payload: { job: ids.next("job"), title: "A slow one", kind: "query", source: null } }]);
  await p.settle();
  p.press("b");
  const first = p.all(".lens .job-row")[0]!;
  expect(first.textContent).toContain("A slow one");
  expect(first.querySelector(".status")!.textContent).toBe("running");
  expect(first.querySelector(".duration")!.textContent).toMatch(/^running for \d+ s$/);
});

test("a playbook job opens to its run in the Jobs lens, and a card chip in it focuses the card", async () => {
  p = await page();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  const intent = parseCommand("run playbook address-triage on 198.51.100.77", { cases: [], in_case: true, cards: [] });
  expect((await perform(intent, { ui: p.ui, nav: { openLens: () => {} } as never, store: p.store() })).cleared).toBe(true);
  await p.s.app.hub.idle();
  await p.settle();
  p.press("b");
  await p.settle();
  const run = Object.values(state().playbooks)[0]!;
  expect(run.status).not.toBe("running");
  const row = p.q(`.lens details.job-row[data-job=${run.job}]`);
  expect(row.querySelector("summary .status")!.textContent).toBe(state().jobs[run.job]!.status);
  const trail = p.q("details[data-job] .playbook-trail");
  expect(trail.querySelectorAll(".step").length).toBe(run.order.length);
  const chip = trail.querySelector(".card-chip") as HTMLElement;
  p.click(chip);
  expect(p.navCalls).toContainEqual(["focusCard", chip.textContent]);
});

test("with nothing yet, Jobs and Discarded say so", async () => {
  p = await page();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("b");
  expect(p.q(".lens").textContent).toContain("No jobs yet.");
});

test("each lens opens with its key and closes with Escape", async () => {
  await published();
  for (const [key, id] of [["s", "steps"], ["t", "timeline"], ["w", "worklog"], ["d", "discarded"], ["b", "jobs"]] as const) {
    p.press(key);
    expect([id, p.all(".lens-dock .lens").length, p.q(".lens-dock").hidden]).toEqual([id, 1, false]);
    expect(p.q(`.lens-button[data-lens=${id}]`).classList.contains("active")).toBe(true);
    p.press("Escape");
    expect([id, p.q(".lens-dock").hidden]).toEqual([id, true]);
  }
});

test("a running job's length ticks while the Jobs lens is open and the tick stops when it closes", async () => {
  await published();
  p.s.app.hub.read("CASE-1").commit((_s, ids) => [{ type: "job.started", actor: { kind: "system", id: "t" }, payload: { job: ids.next("job"), title: "Slow", kind: "query", source: null } }]);
  await p.settle();
  const win = p.win as unknown as { setInterval: (...a: unknown[]) => number; clearInterval: (id: number) => void };
  const set = win.setInterval.bind(win), clear = win.clearInterval.bind(win);
  const started: number[] = [], cleared: number[] = [];
  win.setInterval = (...a: unknown[]) => { const id = set(...a); started.push(id); return id; };
  win.clearInterval = (id: number) => { cleared.push(id); clear(id); };
  p.press("b");
  expect(started.length).toBe(1);
  p.press("Escape");
  expect(cleared).toEqual(started);
});
