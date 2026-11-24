import { afterEach, expect, test } from "bun:test";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import type { Entry } from "../../src/core/types";
import { routeTrail } from "../../src/web/trail";
import { EntryBuilder, card } from "../helpers/entries";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";

let p: Page | null = null;
afterEach(async () => {
  if (p !== null) expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]);
  await p?.close();
  p = null;
});

const state = (q: Page) => q.s.app.hub.read("CASE-1").state;
/** A case on screen with one card from a free pivot (the peers of the beacon's target), opened. */
async function open(): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  const r = await p.s.command(id, "run_pivot", { pivot: "address_to_internal_peers", value: SAMPLE_START.value, window: SAMPLE_WINDOW, why: "who talked to it" });
  expect(r.status).toBe(200);
  await p.settle();
  p.click("[data-card=c1]");
  await p.settle();
  return p;
}
/** Waits (a few ticks at a time) until `done` is true; the panel's reads go through fetch. */
async function until(q: Page, done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await q.settle();
    if (done()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never happened: ${what}`);
}
const choose = (q: Page, selector: string, value: string): void => {
  const el = q.q(selector) as HTMLSelectElement;
  el.value = value;
  el.dispatchEvent(new q.win.Event("change", { bubbles: true }) as unknown as Event);
};
const panel = "[data-card=c1] .pivot-panel";
async function wantAccount(q: Page): Promise<void> {
  q.click("[data-card=c1] button.value");
  await q.settle();
  choose(q, `${panel} [aria-label='What do you want?']`, "account");
  await until(q, () => q.all(`${panel} [data-route]`).length > 0, "routes listed");
}

test("a value chip opens the panel with that value; choosing an answer lists routes cheapest first", async () => {
  const q = await open();
  expect(q.all(".pivot-panel").length).toBe(0);
  const value = q.q("[data-card=c1] button.value").textContent!;
  q.click("[data-card=c1] button.value");
  await q.settle();
  expect(q.q(`${panel} .starting`).textContent).toContain("Starting from:");
  expect([...q.all(`${panel} .starting .chip`)].map((c) => c.textContent)).toContain(value);
  expect(q.q(`${panel} .wanted-label`).textContent).toBe("What do you want?");
  choose(q, `${panel} [aria-label='What do you want?']`, "account");
  await until(q, () => q.all(`${panel} [data-route]`).length > 1, "routes listed");
  const weights = q.all(`${panel} [data-route] .route-head`).map((e) => Number(/weight (\d+(?:\.\d+)?)/.exec(e.textContent!)![1]));
  expect(weights).toEqual([...weights].sort((a, b) => a - b));
  expect(q.q(`${panel} [data-route='0'] .route-head`).textContent).toMatch(/^\d+ hops? · weight /);
  expect(q.q(`${panel} [data-route='0'] [data-action=run]`).textContent).toMatch(/^Run: \d+ hops? to Account$/);
  expect(q.q(`${panel} [aria-label='Why']`).getAttribute("value") ?? (q.q(`${panel} [aria-label='Why']`) as HTMLInputElement).value).toBe("Pivot from c1 to Account");
});

test("a value with no route says so", async () => {
  const q = await open();
  q.click("[data-card=c1] button.value");
  await q.settle();
  choose(q, `${panel} [aria-label='What do you want?']`, "verdict");
  choose(q, `${panel} [aria-label='Max cost']`, "");
  q.fill(`${panel} [aria-label='Max cost']`, "0");
  await until(q, () => q.q(panel).textContent!.includes("No route from these values to Verdict."), "no route");
  expect(q.all(`${panel} [data-route]`).length).toBe(0);
});

test("each hop shows its source, cost class, window need and what an empty result means", async () => {
  const q = await open();
  await wantAccount(q);
  const hops = q.all(`${panel} [data-route='0'] .hop`);
  expect(hops.length).toBeGreaterThan(1);
  const text = hops.map((h) => h.textContent!).join("\n");
  expect(text).toContain("Asset list");
  expect(text).toContain("free");
  expect(text).toContain("needs a window");
  expect(text).toContain("if empty: proven negative");
  expect(text).toContain("if empty: not seen");
  // unconfirmed sources are off until allowed, and then drawn with their tag
  choose(q, `${panel} [aria-label='What do you want?']`, "asset");
  await until(q, () => q.all(`${panel} [data-route]`).length > 0, "asset routes listed");
  expect(q.all(`${panel} .unconfirmed`).length).toBe(0);
  q.click(`${panel} [aria-label='Allow unconfirmed sources']`);
  await until(q, () => q.all(`${panel} .unconfirmed`).length > 0, "unconfirmed shown");
  expect(q.q(`${panel} .unconfirmed`).textContent).toBe("unconfirmed source");
});

test("a costly hop says what a lookup costs", async () => {
  const q = await open();
  q.click("[data-card=c1] button.value");
  await q.settle();
  choose(q, `${panel} [aria-label='What do you want?']`, "verdict");
  await until(q, () => q.all(`${panel} [data-route]`).length > 0, "routes listed");
  expect(q.q(`${panel} [data-route='0']`).textContent).toContain("costly (5 per lookups)");
});

test("running a route shows the trail as it happens and ends in the answer", async () => {
  const q = await open();
  await wantAccount(q);
  q.click("[data-route='0'] [data-action=run]");
  await until(q, () => q.all(".trail .finished").length > 0, "route finished");
  expect(q.q(".trail .finished").textContent).toStartWith("answered: ");
  expect(q.q(".trail .finished").textContent).toContain("j.doe");
  expect(q.all(".trail .lookup").length).toBeGreaterThan(1);
  const jobs = Object.values(state(q).jobs);
  expect(jobs.at(-1)!.status).toBe("done");
  expect(q.all(".trail .lookup .chip").length).toBeGreaterThan(0);
});

test("a partial lookup reads partial with its reason, never as a negative", async () => {
  const q = await open();
  // a card that holds the beacon's own target: the route starts where the case did, hits the asset list's proven negative, and goes round
  q.s.app.hub.read("CASE-1").commit((_s, ids) => {
    const id = ids.next("card");
    const c = { ...card("x", { title: "Target", columns: ["address"], column_types: ["address"], rows: [[SAMPLE_START.value]], row_count: 1, query: null }), id };
    return [{ type: "card.created", actor: { kind: "system", id: "t" }, payload: { card: c } }];
  });
  await q.settle();
  q.click("[data-card=c2]");
  await q.settle();
  q.click("[data-card=c2] button.value");
  await q.settle();
  choose(q, "[data-card=c2] .pivot-panel [aria-label='What do you want?']", "account");
  await until(q, () => q.all("[data-card=c2] .pivot-panel [data-route]").length > 0, "routes listed");
  q.click("[data-card=c2] [data-route='0'] [data-action=run]");
  await until(q, () => q.all(".trail .finished").length > 0, "route finished");
  const lookups = q.all(".trail .lookup").map((l) => l.textContent!);
  const partial = lookups.filter((t) => t.includes("partial:"));
  expect(partial.length).toBeGreaterThan(0);
  expect(partial[0]).toContain("row_limit");
  for (const t of partial) expect(t).not.toContain("proven negative");
  expect(lookups.some((t) => t.includes("empty: proven negative"))).toBe(true);
});

test("a costly hop waits for a budget and shows its estimate first", async () => {
  const q = await open();
  q.click("[data-card=c1] button.value");
  await q.settle();
  choose(q, `${panel} [aria-label='What do you want?']`, "verdict");
  await until(q, () => q.all(`${panel} [data-route]`).length > 0, "routes listed");
  q.click("[data-route='0'] [data-action=run]");
  await until(q, () => q.all(".trail .finished").length > 0, "route finished");
  expect(q.q(".trail .finished").textContent).toContain("blocked");
  expect(state(q).queries.q2 === undefined || state(q).queries.q2!.status !== "running").toBe(true);
  expect(Object.values(state(q).queries).some((x) => x.source === "reputation")).toBe(false);
  const wait = q.q(".trail .needs-budget");
  expect(wait.textContent).toContain("costly (5 per lookups)");
  const run = q.q(".trail .needs-budget [data-action=run-lookup]") as HTMLButtonElement;
  expect(run.disabled).toBe(true);
  q.fill(".trail .needs-budget [aria-label='Budget']", "3");
  await q.settle();
  expect((q.q(".trail .needs-budget [data-action=run-lookup]") as HTMLButtonElement).textContent).toBe("Run this lookup: spend up to 3 lookups");
  q.click(".trail .needs-budget [data-action=run-lookup]");
  await until(q, () => Object.values(state(q).queries).some((x) => x.source === "reputation" && x.status === "done"), "the costly lookup ran");
  expect(Object.values(state(q).queries).filter((x) => x.source === "reputation").every((x) => x.by.kind === "human")).toBe(true);
});

test("All time disables a route that needs a window, and says why", async () => {
  const q = await open();
  await wantAccount(q);
  expect((q.q(`${panel} [data-route='0'] [data-action=run]`) as HTMLButtonElement).disabled).toBe(false);
  choose(q, `${panel} [aria-label='Window']`, "all");
  await q.settle();
  expect((q.q(`${panel} [data-route='0'] [data-action=run]`) as HTMLButtonElement).disabled).toBe(true);
  expect(q.q(`${panel} [data-route='0']`).textContent).toContain("needs a window");
  choose(q, `${panel} [aria-label='Window']`, "7d");
  await q.settle();
  expect((q.q(`${panel} [data-route='0'] [data-action=run]`) as HTMLButtonElement).disabled).toBe(false);
});

test("the window choices send the window they name", async () => {
  const q = await open();
  await wantAccount(q);
  const sent: Record<string, unknown>[] = [];
  const real = q.ui.api.command;
  q.ui.api.command = async (id, name, args) => { sent.push({ name, ...args }); return real(id, name, args); };
  const run = async (): Promise<Record<string, unknown>> => {
    q.click("[data-route='0'] [data-action=run]");
    await until(q, () => sent.length > 0, "command sent");
    return sent.pop()!;
  };
  expect((await run()).window).toEqual(SAMPLE_WINDOW);
  await until(q, () => q.all(".trail .finished").length > 0, "route finished");
  choose(q, `${panel} [aria-label='Window']`, "1d");
  await q.settle();
  const w = (await run()).window as { from: string; to: string };
  expect(w.to).toBe(SAMPLE_WINDOW.to!);
  expect(Date.parse(w.to) - Date.parse(w.from)).toBe(86_400_000);
  choose(q, `${panel} [aria-label='Window']`, "custom");
  await q.settle();
  q.fill(`${panel} [aria-label='From (UTC)']`, "2026-11-18T00:00:00.000Z");
  q.fill(`${panel} [aria-label='To (UTC)']`, "2026-11-19T00:00:00.000Z");
  await q.settle();
  expect((await run()).window).toEqual({ from: "2026-11-18T00:00:00.000Z", to: "2026-11-19T00:00:00.000Z" });
  q.fill(`${panel} [aria-label='To (UTC)']`, "tomorrow");
  await q.settle();
  expect((q.q(`${panel} [data-route='0'] [data-action=run]`) as HTMLButtonElement).disabled).toBe(true);
});

test("a route needs a reason: with the Why cleared, Run is disabled", async () => {
  const q = await open();
  await wantAccount(q);
  q.fill(`${panel} [aria-label='Why']`, "   ");
  await q.settle();
  expect((q.q(`${panel} [data-route='0'] [data-action=run]`) as HTMLButtonElement).disabled).toBe(true);
});

test("in replay Pivot and Verify are disabled and a value chip does not call pivot", async () => {
  const q = await open();
  q.store()!.goTo(q.store()!.live.seq);
  await q.settle();
  q.navCalls.length = 0;
  expect((q.q("[data-card=c1] [data-action=pivot]") as HTMLButtonElement).disabled).toBe(true);
  expect((q.q("[data-card=c1] [data-action=verify]") as HTMLButtonElement).disabled).toBe(true);
  q.click("[data-card=c1] button.value");
  q.click("[data-card=c1] th button");
  expect(q.navCalls.filter((c) => c[0] === "pivot")).toEqual([]);
  expect(q.all(".pivot-panel").length).toBe(0);
});

test("the Pivot action opens the panel with the card's values", async () => {
  const q = await open();
  q.click("[data-card=c1] [data-action=pivot]");
  await q.settle();
  expect(q.all(`${panel} .starting .chip`).length).toBeGreaterThan(0);
  expect(q.navCalls.some((c) => c[0] === "pivot" && c[1] === "c1")).toBe(true);
});

// ---------- the trail, from the entries ----------
const person = { kind: "human" as const, id: "ana" };
function trailEntries(): Entry[] {
  const b = new EntryBuilder();
  const issue = (query: string, job: string | null, value: string, purpose: "result" | "estimate" = "result", pivot: string | null = "address_to_asset"): void => {
    b.add("query.issued", { query, source: "assets", source_hash: "h", pivot, pivot_hash: "h", connector: "files", text: "t", bound: { value }, window: { from: null, to: null }, why: "w", estimate: null, step: null, verifies: null, purpose }, { actor: person, job });
  };
  const result = (query: string, rows: number, coverage: Entry extends never ? never : { kind: "full" } | { kind: "partial"; reason: "timeout"; detail?: string }): void => {
    b.add("query.result", { query, result: { blob: "b".repeat(64), media: "application/json", bytes: 1 } as never, rows, rows_hash: "h", coverage, duration_ms: 1, cost: null }, { job: "job-1" });
  };
  issue("q1", "job-1", "192.0.2.1"); result("q1", 2, { kind: "full" });
  issue("q2", "job-1", "192.0.2.2"); result("q2", 0, { kind: "full" });
  issue("q3", "job-1", "192.0.2.3"); result("q3", 1, { kind: "partial", reason: "timeout", detail: "slow" });
  issue("q4", "job-1", "192.0.2.4"); b.add("query.failed", { query: "q4", error: "the source is down" }, { job: "job-1" });
  issue("q5", "job-1", "192.0.2.5");
  issue("q6", "job-1", "192.0.2.6", "estimate");
  issue("q7", "job-2", "192.0.2.7");
  b.add("route.finished", { job: "job-1", want: "account", outcome: "blocked", reached: [], blocked: ["address_to_asset"], caveats: ["x: partial coverage (timeout)"], cards: [] }, { job: "job-1" });
  return b.entries;
}

test("routeTrail lists the job's lookups with their status, and the finish", () => {
  const t = routeTrail(trailEntries(), "job-1");
  expect(t.lookups.map((l) => [l.query, l.value, l.status, l.rows])).toEqual([
    ["q1", "192.0.2.1", "answered", 2], ["q2", "192.0.2.2", "empty", 0], ["q3", "192.0.2.3", "partial", 1], ["q4", "192.0.2.4", "failed", null], ["q5", "192.0.2.5", "running", null],
  ]);
  expect(t.lookups[2]!.detail).toBe("timeout (slow)");
  expect(t.lookups[3]!.detail).toBe("the source is down");
  expect(t.lookups.every((l) => l.pivot === "address_to_asset")).toBe(true);
  expect(t.finished).toMatchObject({ job: "job-1", outcome: "blocked", blocked: ["address_to_asset"] });
  expect(routeTrail(trailEntries(), "job-2").lookups.map((l) => l.query)).toEqual(["q7"]);
  expect(routeTrail(trailEntries(), "job-2").finished).toBeNull();
  expect(routeTrail([], "job-1")).toEqual({ lookups: [], finished: null });
});
