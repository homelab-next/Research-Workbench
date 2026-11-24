import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Entry } from "../../src/core/types";
import { changedBy, matches, step } from "../../src/web/replay";
import type { ReplayFilter } from "../../src/web/replay";
import { page, testUi } from "../helpers/dom";
import type { Page } from "../helpers/dom";
import { card, EntryBuilder } from "../helpers/entries";
import { CaseStore } from "../../src/web/store";
import { makeWorkArea } from "../../src/web/views/workarea";
import type { Nav } from "../../src/web/app";

let p: Page | null = null;
afterEach(async () => {
  if (p !== null) expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]);
  await p?.close();
  p = null;
});

const ALL: ReplayFilter = { actor: null, type: null, stage: null };

test("changedBy names the card, lane and stage an entry touched", () => {
  const b = new EntryBuilder();
  const created = b.add("card.created", { card: card("CARD-3") });
  const kept = b.add("card.kept", { card: "CARD-3", lane: "LANE-2", index: null });
  const started = b.add("stage.started", { stage: "gather", attempt: 1 });
  const finished = b.add("run.paused", { reason: "x" } as never);
  expect(changedBy(created)).toEqual({ cards: ["CARD-3"], lanes: [], stages: [] });
  expect(changedBy(kept)).toEqual({ cards: ["CARD-3"], lanes: ["LANE-2"], stages: [] });
  expect(changedBy(started)).toEqual({ cards: [], lanes: [], stages: ["gather"] });
  expect(changedBy(finished)).toEqual({ cards: [], lanes: [], stages: [] });
});

test("step skips entries the filter leaves out and stops at the ends", () => {
  const b = new EntryBuilder();
  const by = (id: string): { actor: Entry["actor"] } => ({ actor: { kind: "human", id } });
  b.add("run.resumed", true as never, by("a"));      // 1
  b.add("run.resumed", true as never, by("b"));      // 2
  b.add("run.paused", { reason: "r" } as never, by("a"));   // 3
  b.add("run.resumed", true as never, by("b"));      // 4
  const e = b.entries;
  expect(step(e, 0, 1, ALL)).toBe(1);
  expect(step(e, 4, 1, ALL)).toBeNull();
  expect(step(e, 1, -1, ALL)).toBeNull();
  const a: ReplayFilter = { actor: "a", type: null, stage: null };
  expect(step(e, 1, 1, a)).toBe(3);
  expect(step(e, 3, -1, a)).toBe(1);
  expect(step(e, 3, 1, a)).toBeNull();
  expect(step(e, 0, 1, { actor: null, type: "run.paused", stage: null })).toBe(3);
  expect(matches(e[0]!, { actor: null, type: null, stage: "gather" })).toBe(false);
  expect(step(e, 3, -1, { actor: "nobody", type: null, stage: null })).toBeNull();
});

/** The facts of the work area that must be the same live and replayed. */
const screen = (q: Page) => ({
  incoming: q.all("[data-area=incoming] [data-card]").map((e) => e.dataset.card),
  lanes: q.all(".lane").map((l) => [l.dataset.lane, [...l.querySelectorAll<HTMLElement>("[data-card]")].map((e) => e.dataset.card)]),
  strip: q.q(".phase-strip").textContent,
  status: q.all("[data-status]").map((e) => e.textContent),
  tags: q.all("[data-card] .tag").map((e) => e.textContent).filter((t) => t !== "new"),
});

/** A whole sample run, published, and a page that can open the case with the server's entries cut off at `cap`. */
async function ran(): Promise<{ q: Page; total: number; cap: { at: number } }> {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPublishGate(id);
  expect((await p.s.command(id, "approve")).status).toBe(200);
  await p.s.app.hub.idle();
  const real = p.ui.api.entries;
  const cap = { at: Infinity };
  p.ui.api.entries = { open: (c, after, on, drop) => real.open(c, after, (e) => { if (e.seq <= cap.at) on(e); }, drop) };
  return { q: p, total: p.s.entries(id).length, cap };
}
const reopen = async (q: Page): Promise<void> => {
  q.win.location.hash = "#/";
  await q.settle();
  q.win.location.hash = "#/case/CASE-1";
  await q.settle();
};

test("replay shows at entry N exactly what the live screen showed at entry N", async () => {
  const { q, total, cap } = await ran();
  const marks = [1, 7, Math.floor(total / 4), Math.floor(total / 2), Math.floor((3 * total) / 4), total - 1, total];
  const recorded: [number, ReturnType<typeof screen>][] = [];
  for (const n of marks) {          // a fresh page whose live state is entry n
    cap.at = n;
    await reopen(q);
    expect(q.store()!.live.seq).toBe(n);
    recorded.push([n, screen(q)]);
  }
  expect(new Set(recorded.map(([, r]) => JSON.stringify(r))).size).toBeGreaterThan(3);      // the screens differ, so equality means something
  cap.at = Infinity;
  await reopen(q);
  expect(q.store()!.live.seq).toBe(total);
  for (const [n, was] of recorded) {
    q.press("e");
    q.store()!.goTo(n);
    await q.settle();
    expect(q.store()!.at).toBe(n);
    expect(screen(q)).toEqual(was);
  }
  q.press("Escape");
  await q.settle();
  expect(q.store()!.at).toBeNull();
  expect(screen(q)).toEqual(recorded.at(-1)![1]);
});

const open = async (): Promise<{ q: Page; entries: Entry[]; total: number }> => {
  const { q, total } = await ran();
  q.win.location.hash = "#/case/CASE-1";
  await q.settle();
  return { q, entries: q.s.entries("CASE-1"), total };
};
const store = (q: Page) => q.store()!;
const goto = async (q: Page, seq: number): Promise<void> => { q.press("e"); store(q).goTo(seq); await q.settle(); };

test("the head line names the entry, its UTC time with milliseconds and who wrote it", async () => {
  const { q, entries, total } = await open();
  const e = entries.find((x) => x.actor.kind === "agent")!;
  await goto(q, e.seq);
  expect(q.q(".replay-head").textContent).toBe(`Replay · entry ${e.seq} of ${total} · ${e.ts} · agent: ${e.actor.id}`);
  expect(q.q(".replay-head").textContent).toMatch(/^Replay · entry \d+ of \d+ · \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z · agent: /);
  expect(q.q(".replay-what").textContent).toContain(e.type === "card.created" ? "card created" : "");
  expect(q.q("[data-area=replay]")).toBeDefined();
  expect(q.q(".replay-who").textContent).toContain((e.actor as { stage: string }).stage);
  const names = q.all(".lens-replay button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
  expect(names).toEqual(expect.arrayContaining(["Previous entry", "Next entry", "Play", "Live"]));
});

test("a query issued shows its exact text, source, why and hashes, and links its result's raw bytes", async () => {
  const { q, entries } = await open();
  const issued = entries.find((x) => x.type === "query.issued")! as Extract<Entry, { type: "query.issued" }>;
  await goto(q, issued.seq);
  expect(q.q("pre.query").textContent).toBe(issued.payload.text);
  const detail = q.q(".replay-detail").textContent!;
  expect(detail).toContain(q.ui.ref.sources.find((s) => s.id === issued.payload.source)!.title);
  expect(detail).toContain(issued.hash);
  expect(detail).toContain(issued.prev_hash);
  expect(detail).toContain(issued.payload.why);
  if (issued.actor.kind === "agent") expect(detail).toContain("reasoning as stated by the agent");
  const result = entries.find((x) => x.type === "query.result" && (x.payload as { query: string }).query === issued.payload.query)! as Extract<Entry, { type: "query.result" }>;
  await goto(q, result.seq);
  const links = q.all(".replay-detail a").filter((a) => a.textContent === "raw bytes");
  expect(links.map((a) => a.getAttribute("href"))).toEqual([q.ui.api.blobPath("CASE-1", result.payload.result.blob)]);
  expect(q.q(".replay-detail").textContent).toContain(result.payload.result.blob);
  // Caused by goes there
  if (result.cause !== null) {
    q.click(".replay-cause");
    expect(store(q).at).toBe(result.cause);
  }
});

test("J and K step one entry, and the cards an entry changed are highlighted", async () => {
  const { q, entries } = await open();
  const made = entries.find((x) => x.type === "card.created")!;
  const id = (made.payload as { card: { id: string } }).card.id;
  await goto(q, made.seq);
  expect(q.q(`[data-card=${id}]`).classList.contains("changed")).toBe(true);
  q.press("k"); await q.settle();
  expect(store(q).at).toBe(made.seq - 1);
  expect(q.all("[data-card].changed")).toEqual([]);
  q.press("j"); await q.settle();
  expect(store(q).at).toBe(made.seq);
  expect(q.q(`[data-card=${id}]`).classList.contains("changed")).toBe(true);
  const row = q.q(".replay-list [aria-current=true]");
  expect(row.textContent).toContain("▸");
  expect(row.dataset.seq).toBe(String(made.seq));
  const stage = entries.find((x) => x.type === "stage.started")!;
  await goto(q, stage.seq);
  expect(q.q(`[data-stage=${(stage.payload as { stage: string }).stage}]`).classList.contains("changed")).toBe(true);
});

test("filtering by actor steps only through that actor's entries", async () => {
  const { q, entries } = await open();
  const agent = entries.find((x) => x.actor.kind === "agent")!.actor.id;
  const mine = entries.filter((x) => x.actor.id === agent).map((x) => x.seq);
  await goto(q, mine[mine.length - 1]!);
  const select = q.q("select[aria-label=Actor]") as HTMLSelectElement;
  select.value = agent;
  select.dispatchEvent(new q.win.Event("change", { bubbles: true }) as unknown as Event);
  await q.settle();
  for (let i = mine.length - 2; i >= Math.max(0, mine.length - 5); i--) {
    q.q(".lens-replay").focus();
    q.press("k"); await q.settle();
    expect(store(q).at).toBe(mine[i]!);
  }
  expect(q.all(".replay-list [data-seq]").every((r) => mine.includes(Number(r.dataset.seq)))).toBe(true);
});

test("stepping by stage or gate, and jumping to an entry by number", async () => {
  const { q, entries } = await open();
  const marks = entries.filter((x) => ["stage.started", "stage.finished", "gate.waiting", "gate.passed"].includes(x.type)).map((x) => x.seq);
  await goto(q, 1);
  q.click("[aria-label='Next stage or gate']"); await q.settle();
  expect(store(q).at).toBe(marks[0]!);
  q.click("[aria-label='Next stage or gate']"); await q.settle();
  expect(store(q).at).toBe(marks[1]!);
  q.click("[aria-label='Previous stage or gate']"); await q.settle();
  expect(store(q).at).toBe(marks[0]!);
  const box = q.q("input[aria-label='Go to entry']") as HTMLInputElement;
  box.value = "17";
  box.dispatchEvent(new q.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  await q.settle();
  expect(store(q).at).toBe(17);
});

test("Play advances on a timer and stops at the end; Live and Escape return to the present", async () => {
  const { q, total } = await open();
  await goto(q, total - 2);
  q.click("[aria-label=Play]");
  await new Promise((r) => setTimeout(r, 1500));
  await q.settle();
  expect(store(q).at).toBe(total);
  expect(q.q("[data-action=play]").textContent).toBe("Play");
  q.click("[aria-label='Previous entry']"); await q.settle();
  expect(store(q).at).toBe(total - 1);
  q.click("[aria-label=Live]"); await q.settle();
  expect(store(q).at).toBeNull();
  await goto(q, 10);
  q.q(".lens-replay").focus();
  q.press("Escape"); await q.settle();
  expect(store(q).at).toBeNull();
});

test("the work area is read-only while replaying and commands are not sent", async () => {
  const { q, entries, total } = await open();
  const made = entries.find((x) => x.type === "card.created")!;
  await goto(q, made.seq);
  const id = (made.payload as { card: { id: string } }).card.id;
  q.click(`[data-card=${id}]`); await q.settle();
  const buttons = q.all(`[data-card=${id}] .actions button`);
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  expect(q.all(".brief button.run-button, .brief button.pause, .brief button.stop").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  expect(await q.ui.act("pin", { card: id, pinned: true })).toBe(false);
  expect(q.toasts()).toContain("Return to live to change the case");
  expect(q.s.entries("CASE-1").length).toBe(total);
  expect(q.q(".replay-banner").textContent).toBe(`Replay · entry ${made.seq} of ${total} · read-only`);
  // back to live: the live state returns and controls are enabled again
  q.click("[aria-label=Live]"); await q.settle();
  expect(q.root.querySelector(".replay-banner")).toBeNull();
  expect(store(q).shown).toBe(store(q).live);
});

test("entries that arrive while replaying do not move the position", async () => {
  const { q, entries, total } = await open();
  await goto(q, 30);
  const some = Object.keys(store(q).live.cards)[0]!;
  const r = await q.s.command("CASE-1", "pin", { card: some, pinned: true });
  expect(r.status).toBe(200);
  await q.settle();
  expect(q.s.entries("CASE-1").length).toBeGreaterThan(total);
  expect(store(q).at).toBe(30);
  expect(q.q(".replay-head").textContent).toStartWith(`Replay · entry 30 of ${entries.length + 1} · `);
});

test("replay 137 in the command bar opens Replay at entry 137", async () => {
  const { q } = await open();
  q.fill("[aria-label=Command]", "replay 137");
  const box = q.q("[aria-label=Command]");
  box.dispatchEvent(new q.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  await q.settle();
  expect(store(q).at).toBe(137);
  expect(q.q(".replay-head").textContent).toStartWith("Replay · entry 137 of ");
  const bare = q.q("[aria-label=Command]") as HTMLInputElement;
  bare.value = "replay";
  bare.dispatchEvent(new q.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  await q.settle();
  expect(store(q).at).toBe(store(q).live.seq);
});

test("stepping through a long case stays fast", async () => {
  const win = new Window({ url: "http://127.0.0.1:1/" });
  const ui = testUi(win);
  const b = new EntryBuilder("CASE-1");
  b.add("case.created", { id: "CASE-1", title: "Long", asked: "q", why: "w", marking: "TLP:GREEN", starting: [], window: { from: null, to: null }, objective: "o" } as never);
  for (let i = 1; i <= 500; i++) b.add("card.created", { card: card(`CARD-${i}`) });
  for (let i = 0; i < 4499; i++) b.add("card.pinned", { card: `CARD-${(i % 500) + 1}`, pinned: i % 2 === 0 });
  const s = new CaseStore("CASE-1");
  let prev = "0".repeat(64);
  for (const e of b.entries) { const hash = e.seq.toString(16).padStart(64, "0"); s.push({ ...e, prev_hash: prev, hash } as Entry); prev = hash; }
  expect(s.live.seq).toBe(5000);
  const nav = { openLens: () => {}, closeLens: () => {}, focusCard: () => {}, cite: () => {}, pivot: () => {}, ask: () => {}, go: () => {}, up: () => {} } as unknown as Nav;
  const area = makeWorkArea(ui, { store: s, nav });
  win.document.body.append(area.el as never);
  area.openLens("replay");
  expect(s.at).toBe(5000);
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) area.actions().replay_prev!();
  await win.happyDOM.waitUntilComplete();
  expect(performance.now() - t0).toBeLessThan(5000);
  expect(s.at).toBe(4900);
  area.destroy?.();
  await win.happyDOM.close();
});
