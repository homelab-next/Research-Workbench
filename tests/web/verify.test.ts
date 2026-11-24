import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";

let p: Page | null = null;
afterEach(async () => {
  if (p !== null) expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]);
  await p?.close();
  p = null;
});
const state = (q: Page) => q.s.app.hub.read("CASE-1").state;
const csv = (q: Page): string => join(q.s.dir, "sample", "data", "assets.csv");

/** A case with one card, from the asset list for 192.0.2.17 (or the costly reputation lookup), opened. */
async function open(pivot = "address_to_asset", value = "192.0.2.17", budget?: number): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  const r = await p.s.command(id, "run_pivot", { pivot, value, window: SAMPLE_WINDOW, why: "to verify", ...(budget === undefined ? {} : { budget }) });
  expect(r.status).toBe(200);
  await p.settle();
  p.click("[data-card=c1]");
  await p.settle();
  return p;
}
async function until(q: Page, done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await q.settle();
    if (done()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`never happened: ${what}`);
}
const verify = async (q: Page): Promise<void> => { q.click("[data-card=c1] [data-action=verify]"); await until(q, () => q.all("[data-card=c1] .verify").length > 0, "verify result"); };

test("Verify on an unchanged source tags the card validated with the time", async () => {
  const q = await open();
  expect(q.all("[data-card=c1] .verify").length).toBe(0);
  await verify(q);
  const v = state(q).cards.c1!.validated!;
  expect(v.outcome).toBe("matches");
  expect(q.q("[data-card=c1] .verify").textContent).toBe(`Validated ${v.ts}: ${v.detail}`);
  expect(q.q("[data-card=c1] .verify").classList.contains("matches")).toBe(true);
  expect([...q.all("[data-card=c1] .tag")].map((t) => t.textContent)).toContainEqual(expect.stringMatching(/^validated /));
  expect(q.all("[data-card=c1] .verify table").length).toBe(0);
});

test("a changed source tags the card differs, says the source may have changed, and shows the rows", async () => {
  const q = await open();
  const rowsBefore = state(q).cards.c1!.rows;
  writeFileSync(csv(q), readFileSync(csv(q), "utf8").replace("ws-17.example.net,192.0.2.17", "ws-99.example.net,192.0.2.17"));
  await verify(q);
  await until(q, () => q.all("[data-card=c1] .verify table.removed").length > 0, "the difference");
  expect(q.q("[data-card=c1] .verify").textContent).toContain("The source may have changed since. A difference does not prove the original was wrong.");
  expect(q.all("[data-card=c1] .verify table.removed tr").length).toBeGreaterThan(0);
  expect(q.q("[data-card=c1] .verify table.removed").textContent).toContain("ws-17.example.net");
  expect(q.q("[data-card=c1] .verify table.added").textContent).toContain("ws-99.example.net");
  expect(q.q("[data-card=c1] .verify").textContent).toContain("0 rows the same");
  expect(q.q("[data-card=c1] .verify").textContent).toContain("only in the original");
  expect(q.q("[data-card=c1] .verify").textContent).toContain("only in the re-run");
  expect(q.q("[data-card=c1] .verify").classList.contains("differs")).toBe(true);
  expect(state(q).cards.c1!.validated!.outcome).toBe("differs");
  expect(state(q).cards.c1!.rows).toEqual(rowsBefore);                               // the original is not replaced
  expect([...q.all("[data-card=c1] .tag")].map((t) => t.textContent)).toContain("differs");
});

test("a source that cannot be reached tags the card could not verify, with the reason", async () => {
  const q = await open();
  rmSync(csv(q));
  await verify(q);
  const v = state(q).cards.c1!.validated!;
  expect(v.outcome).toBe("could_not_run");
  expect(q.q("[data-card=c1] .verify").textContent).toBe(`Could not verify: ${v.detail}`);
  expect(q.q("[data-card=c1] .verify").classList.contains("could-not")).toBe(true);
  expect(q.all("[data-card=c1] .verify input").length).toBe(0);
  expect([...q.all("[data-card=c1] .tag")].map((t) => t.textContent)).toContain("could not verify");
});

test("a costly re-run waits for a budget the person sets", async () => {
  const q = await open("address_to_verdict", "198.51.100.77", 3);
  await verify(q);
  expect(state(q).cards.c1!.validated!.outcome).toBe("could_not_run");
  expect(q.q("[data-card=c1] .verify").textContent).toContain("a budget is needed");
  const go = (): HTMLButtonElement => q.q("[data-card=c1] .verify [data-action=verify-budget]") as HTMLButtonElement;
  expect(go().disabled).toBe(true);
  q.fill("[data-card=c1] .verify [aria-label='Budget']", "2");
  await q.settle();
  expect(go().textContent).toBe("Verify: spend up to 2 lookups");
  expect(go().disabled).toBe(false);
  q.click(go());
  await until(q, () => state(q).cards.c1!.validated!.outcome === "matches", "verified with a budget");
  expect(q.all("[data-card=c1] .verify input").length).toBe(0);
});

test("verify c1 in the command bar does the same", async () => {
  const q = await open();
  q.fill("[aria-label=Command]", "verify c1");
  q.q("[aria-label=Command]").dispatchEvent(new q.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  await until(q, () => state(q).cards.c1!.validated !== null, "verified from the bar");
  expect(state(q).cards.c1!.validated!.outcome).toBe("matches");
  expect(q.q("[data-card=c1] .verify").textContent).toStartWith("Validated ");
});

test("in replay the Verify action is disabled and the difference is not fetched", async () => {
  const q = await open();
  await verify(q);
  q.store()!.goTo(q.store()!.live.seq);
  await q.settle();
  expect((q.q("[data-card=c1] [data-action=verify]") as HTMLButtonElement).disabled).toBe(true);
  q.click("[data-card=c1] [data-action=verify]");
  await q.settle();
  expect(Object.values(state(q).queries).filter((x) => x.purpose === "verify").length).toBe(1);
});
