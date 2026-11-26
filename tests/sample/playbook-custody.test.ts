import { afterEach, beforeEach, expect, test } from "bun:test";
import { fold } from "../../src/core/state";
import { verifyCase } from "../../src/core/verify";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served;
let id: string;
beforeEach(async () => { s = await served(); id = await s.newCase(); });
afterEach(async () => { expect(s.app.hub.read(id).state.skipped).toEqual([]); await s.close(); });

test("after a playbook and a does-it-belong, every card traces to its query, result and bytes; the chain verifies; replay equals live", async () => {
  expect((await s.command(id, "run_playbook", { playbook: "address-triage", inputs: [SAMPLE_START], window: SAMPLE_WINDOW, why: "first look" })).status).toBe(200);
  await s.app.hub.idle();
  expect((await s.command(id, "check_belongs", { type: "address", value: SAMPLE_START.value, window: SAMPLE_WINDOW, why: "is it ours" })).status).toBe(200);
  await s.app.hub.idle();
  const session = s.app.hub.read(id);
  const entries = s.entries(id);
  const state = session.state;
  const cards = Object.values(state.cards);
  expect(cards.length).toBeGreaterThan(0);
  for (const c of cards) {
    const q = state.queries[c.query!]!;
    expect(q.purpose).toBe("playbook");
    expect(entries.some((e) => e.type === "query.issued" && e.payload.query === q.id && e.job !== null)).toBe(true);
    expect(entries.some((e) => e.type === "query.result" && e.payload.query === q.id)).toBe(true);
    expect(session.blobs.check(q.result!.blob)).toBe("ok");
  }
  // the second job reused the two inventory lookups the first had already answered
  const runs = Object.values(state.playbooks);
  expect(runs).toHaveLength(2);
  expect(runs.at(-1)!.steps.i1!.lookups[0]!.reused).toBe(true);
  expect(entries.filter((e) => e.type === "model.request")).toEqual([]);
  // verify: the chain and every blob
  const rep = verifyCase(session.dir);
  expect(rep.ok).toBe(true);
  expect(rep.blobs.bad).toEqual([]);
  // replay: fold every prefix; the last equals the live state, and none skips an entry
  for (let n = 1; n <= entries.length; n++) expect(fold(entries.slice(0, n)).skipped).toEqual([]);
  expect(fold(entries)).toEqual(state);
});
