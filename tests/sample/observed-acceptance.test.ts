import { afterEach, beforeEach, expect, test } from "bun:test";
import { apply, fold, initial } from "../../src/core/state";
import { graphOf } from "../../src/core/state/graph";
import { timelineOf } from "../../src/core/state/timeline";
import { verifyCase } from "../../src/core/verify";
import { CaseStore } from "../../src/web/store";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served;
let id: string;
beforeEach(async () => { s = await served(); id = await s.newCase(); });
afterEach(async () => { expect(s.app.hub.read(id).state.skipped).toEqual([]); await s.close(); });

async function triage(): Promise<void> {
  expect((await s.command(id, "run_playbook", { playbook: "address-triage", inputs: [SAMPLE_START], window: SAMPLE_WINDOW, why: "first look" })).status).toBe(200);
  await s.app.hub.idle();
}

test("after a playbook on the sample every pivot card says what it observed, the models replay exactly, and the record verifies", async () => {
  await triage();
  const session = s.app.hub.read(id);
  const entries = s.entries(id);
  const results = Object.values(session.state.cards).filter((c) => c.kind === "result");
  expect(results.length).toBeGreaterThan(0);
  for (const c of results) expect(c.observed).toBeDefined();
  // live is the state as each entry arrived; replay is the browser store's fold to that entry from its nearest snapshot
  const store = new CaseStore(session.id);
  let live = initial();
  for (const e of entries) {
    live = apply(live, e);
    expect(store.push(e)).toBe("applied");
    expect(timelineOf(store.stateAt(e.seq))).toEqual(timelineOf(live));
    expect(graphOf(store.stateAt(e.seq))).toEqual(graphOf(live));
  }
  for (const n of [0, 1, Math.floor(entries.length / 2)]) expect(graphOf(store.stateAt(n))).toEqual(graphOf(fold(entries, n)));
  const g = graphOf(session.state);
  expect(g.nodes[0]).toMatchObject({ key: `address|${SAMPLE_START.value}`, starting: true });
  expect(g.edges.length).toBeGreaterThan(0);
  expect(g.edges.every((e) => e.via.every((v) => Object.hasOwn(session.state.cards, v.card)))).toBe(true);
  expect(timelineOf(session.state).rows.length).toBeGreaterThan(0);
  expect(session.state.skipped).toEqual([]);
  const rep = verifyCase(session.dir);
  expect(rep.ok).toBe(true);
  expect(rep.blobs.bad).toEqual([]);
});

test("a time on the Timeline is a cell of the card that says it", async () => {
  await triage();
  const state = s.app.hub.read(id).state;
  const rows = timelineOf(state).rows;
  let checked = 0;
  for (const row of rows) {
    for (const m of row.marks.filter((m) => m.role === "found")) {
      const card = state.cards[m.card]!;
      // the sample's results are under 50 rows, so the card's preview holds every row
      expect(card.rows.length).toBe(card.row_count);
      const col = ["first_seen", "ts"].map((n) => card.columns.indexOf(n)).find((i) => i >= 0)!;
      expect(col).toBeGreaterThanOrEqual(0);
      const cells = card.rows.filter((r) => r.some((v) => v === row.value)).map((r) => r[col]);
      expect(cells).toContain(m.first);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});
