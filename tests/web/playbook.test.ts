import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { belongsLines, belongsVerdict } from "../../src/web/belongs";
import type { PlaybookRunState } from "../../src/core/state/types";

let p: Page | null = null;
afterEach(async () => {
  if (p !== null) expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]);
  await p?.close();
  p = null;
});

/** c3 holds an address that is on no list (the destinations the lab host called, by a pivot these tests add); c1 is the peers card of START and holds the lab host, a listed asset. */
const UNLISTED = "203.0.113.30";
const START_CARD = "c3", LISTED_CARD = "c1";
const block = `[data-card=${START_CARD}] .playbook-block`;
/** A case with the peers card of START (c1) and of the lab host (c2); the panel of c1 open on a value chip. */
async function open(opts: Parameters<typeof page>[0] = {}, card = START_CARD, value = UNLISTED): Promise<Page> {
  p = await page({ ...opts, before: (root) => {
    appendFileSync(join(root, "pivots.yaml"), `  - id: address_to_destinations\n    title: Addresses it connected to\n    from: address\n    to: address\n    source: flows\n    query: "select dst as peer from flows where src = {value} and ts >= {window.from} and ts < {window.to}"\n    needs_window: true\n    empty_means: not-seen\n    yields: { peer: address }\n`);
    opts.before?.(root);
  } });
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  for (const [pivot, v] of [["address_to_internal_peers", SAMPLE_START.value], ["address_to_internal_peers", "192.0.2.17"], ["address_to_destinations", "192.0.2.17"]] as const) {
    const r = await p.s.command(id, "run_pivot", { pivot, value: v, window: SAMPLE_WINDOW, why: "who talked to it" });
    expect(r.status).toBe(200);
  }
  await p.settle();
  p.click(`[data-card=${card}]`);
  await p.settle();
  p.click(`[data-card=${card}] [aria-label="address ${value}"]`);
  await p.settle();
  return p;
}
const until = async (q: Page, done: () => boolean, what: string): Promise<void> => {
  for (let i = 0; i < 300; i++) { await q.settle(); if (done()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error(`never happened: ${what}`);
};
const runs = (q: Page) => Object.values(q.s.app.hub.read("CASE-1").state.playbooks);
const finished = (q: Page, n: number) => until(q, () => runs(q).length >= n && runs(q).every((r) => r.status !== "running"), "the run to finish");

test("the panel offers the playbook the card's value can fill, saying what it will do", async () => {
  const q = await open();
  expect(q.q(`${block} button.run-playbook`).textContent).toBe(`Run Triage an address on ${UNLISTED} · up to 8 lookups, no model`);
});

test("running it shows each step as it ends, with card chips, and no model request is made", async () => {
  const q = await open();
  q.click(`${block} button.run-playbook`);
  await finished(q, 1);
  const lines = q.all(".playbook-trail .step").map((n) => n.textContent);
  expect(lines.some((t) => t!.startsWith("asset · Asset with the address"))).toBe(true);
  expect(q.all(".playbook-trail .chip.card-chip").length).toBeGreaterThan(0);
  expect(q.s.entries("CASE-1").filter((e) => e.type === "model.request")).toEqual([]);
});

test("a second run reads 'reused, no query sent' on every lookup", async () => {
  const q = await open();
  q.click(`${block} button.run-playbook`);
  await finished(q, 1);
  q.click(`${block} button.run-playbook`);
  await finished(q, 2);
  const lookups = q.all(".playbook-trail .lookup");
  expect(lookups.length).toBeGreaterThan(0);
  expect(lookups.every((n) => n.textContent!.includes("reused, no query sent"))).toBe(true);
});

test("the trail says how many values were not followed, and its caveat", async () => {
  const q = await open({ before: (root) => {
    const f = join(root, "playbooks", "address-triage.yaml");
    const y = readFileSync(f, "utf8");
    const cut = y.replace("max_values: 5", "max_values: 1").replace("from: names, when: names.rows", "from: names, when: names.rows");
    if (cut === y) throw new Error("playbook not changed");
    writeFileSync(f, cut);
  } });
  q.click(`${block} button.run-playbook`);
  await finished(q, 1);
  const run = runs(q)[0]!;
  expect(run.caveats.length).toBeGreaterThan(0);
  const text = q.q(`${block} .playbook-trail`).textContent!;
  expect(text).toContain("values not followed");
  for (const c of run.caveats) expect(text).toContain(c);
});

test("the verdict never calls an incomplete inventory's silence a proven negative", async () => {
  const q = await open({ before: (root) => {
    rmSync(join(root, "inventories", "assets.yaml"));
    const f = join(root, "pivots.yaml");
    writeFileSync(f, readFileSync(f, "utf8").replace("    inventory: assets\n", ""));
  } });
  q.click(`${block} button.belongs`);
  await finished(q, 1);
  expect(q.q(".belongs-verdict").textContent).toBe("Not seen in any inventory; none is complete, so this proves nothing");
  expect(q.q(".belongs-lines").textContent).toContain("Not in Lease records · not proof: it is not declared complete");
  expect(q.root.textContent).not.toMatch(/proven/i);
});

test("with the complete asset list it reads proven for its scope, and known for an address on the list", async () => {
  const q = await open();
  expect(q.q(`${block} button.belongs`).textContent).toBe(`Does ${UNLISTED} belong? · asks 2 inventories`);
  q.click(`${block} button.belongs`);
  await finished(q, 1);
  expect(q.q(".belongs-verdict").textContent).toBe("Not a known asset: proven for internal hosts");
  expect(q.q(".belongs-lines").textContent).toContain("Not in Asset list · proven: it is complete for internal hosts");
  // final review M8: the trail says what each empty lookup means, from the record
  const details = q.all(`${block} .playbook-trail .lookup .detail`).map((x) => x.textContent);
  expect(details).toContain(" · proven negative");
  expect(details).toContain(" · not seen");
  await q.close(); p = null;
  const r = await open({}, LISTED_CARD, "192.0.2.17");
  r.click(`[data-card=${LISTED_CARD}] .playbook-block button.belongs`);
  await until(r, () => runs(r).length === 1 && runs(r)[0]!.status !== "running", "belongs");
  expect(r.q(".belongs-verdict").textContent).toBe("Known asset");
  expect(r.q(".belongs-lines").textContent).toContain("In Asset list");
});

test("the buttons are disabled when the reason is blank, and in replay", async () => {
  const q = await open();
  const btns = (): HTMLButtonElement[] => [...q.all(`${block} button.run-playbook`), ...q.all(`${block} button.belongs`)] as HTMLButtonElement[];
  expect(btns().length).toBe(2);
  expect(btns().every((b) => !b.disabled)).toBe(true);
  q.fill(`[data-card=c3] .pivot-panel [aria-label=Why]`, "");
  await q.settle();
  expect(btns().every((b) => b.disabled && b.title !== "")).toBe(true);
  q.fill(`[data-card=c3] .pivot-panel [aria-label=Why]`, "because");
  await q.settle();
  expect(btns().every((b) => !b.disabled)).toBe(true);
});

test("in replay both buttons are disabled", async () => {
  const q = await open();
  q.store()!.goTo(q.store()!.live.seq);
  await q.settle();
  const b = q.all(`.playbook-block button`) as HTMLButtonElement[];
  expect(b.length).toBe(2);
  expect(b.every((x) => x.disabled)).toBe(true);
});

// pure: the verdict is read from the run alone
const lk = (value: string, outcome: PlaybookRunState["steps"][string]["lookups"][number]["outcome"], card: string | null = null) => ({ value, outcome, rows: outcome === "answered" ? 1 : 0, query: "q1", card, reused: false, detail: "" });
/** The cards as the record holds them: what each empty answer proves was decided when it was asked. */
const cards = { proven: { empty: "proven-negative" }, unseen: { empty: "not-seen" } } as const;
const run = (steps: [string, string, ReturnType<typeof lk>[]][]): PlaybookRunState => ({
  job: "job-1", playbook: "does-it-belong", title: "Does it belong?", inputs: [], window: SAMPLE_WINDOW, plan_step: null, started_seq: 1, status: "empty", end_step: null,
  steps: Object.fromEntries(steps.map(([id, pivot, lookups]) => [id, { job: "job-1", step: id, pivot, status: "ran", reason: "", lookups, found: [], left: 0 }])),
  order: steps.map((s) => s[0]), cards: [], end_cards: [], caveats: [],
});
const ref = {
  pivots: [{ id: "pa", inventory: "ia" }, { id: "pb", inventory: "ib" }] as never,
  inventories: [{ id: "ia", title: "A", holds: "asset", scope: "hosts", complete: true }, { id: "ib", title: "B", holds: "asset", scope: "leases", complete: false }],
};
test("belongsVerdict: a failed lookup in a complete inventory is not a negative", () => {
  expect(belongsVerdict(run([["i1", "pa", [lk("v", "failed")]], ["i2", "pb", [lk("v", "empty", "unseen")]]]), ref, cards)).toEqual({ verdict: "could not tell", text: "Could not tell" });
  expect(belongsLines(run([["i1", "pa", [lk("v", "failed")]]]), ref, cards)[0]!.line).toBe("A: could not tell (failed)");
  expect(belongsVerdict(run([["i1", "pa", [lk("v", "empty", "proven")]]]), ref, cards).verdict).toBe("not known: proven");
  expect(belongsVerdict(run([["i1", "pa", [lk("v", "empty", "proven")]], ["i2", "pb", [lk("v", "answered")]]]), ref, cards).verdict).toBe("known");
});

test("belongsVerdict: what an empty answer proves is the record's, not today's reference", () => {
  // final review I2: the lookup was recorded not seen (the inventory was not complete when it was asked); the reference now says complete
  const asked = run([["i1", "pa", [lk("v", "empty", "unseen")]]]);
  expect(belongsVerdict(asked, ref, cards)).toEqual({ verdict: "not seen", text: "Not seen in any inventory; none is complete, so this proves nothing" });
  expect(belongsLines(asked, ref, cards)[0]!.line).toBe("Not in A · not proof: it is not declared complete");
  // and the reverse: recorded proven, while the reference now says the inventory is not complete
  const proven = run([["i2", "pb", [lk("v", "empty", "proven")]]]);
  expect(belongsVerdict(proven, ref, cards)).toEqual({ verdict: "not known: proven", text: "Not a known asset: proven for leases" });
  // an empty answer with no card proves nothing
  expect(belongsVerdict(run([["i1", "pa", [lk("v", "empty")]]]), ref, cards).verdict).toBe("not seen");
});

test("belongsVerdict: a hit whose pivot has left the reference is still known; an empty one there could not be told", () => {
  const none = { pivots: [], inventories: [] };
  expect(belongsVerdict(run([["i1", "gone", [lk("v", "answered")]]]), none, cards).verdict).toBe("known");
  expect(belongsLines(run([["i1", "gone", [lk("v", "answered")]]]), none, cards)[0]!.line).toBe("In gone");
  expect(belongsVerdict(run([["i1", "gone", [lk("v", "empty", "proven")]]]), none, cards).verdict).toBe("could not tell");
});
