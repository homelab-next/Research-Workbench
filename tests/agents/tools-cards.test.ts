import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import { runQuery } from "../../src/modules/runner";
import { fixture, person, START, WINDOW } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
beforeEach(() => { f = fixture(true); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});

const view = (r: { view: Json }): Record<string, Json> => r.view as Record<string, Json>;

test("list_cards leaves out discarded cards and carries the strictest marking", async () => {
  await f.call("run_step", { step: "s1", why: "w" });
  await f.call("run_step", { step: "s2", why: "w" });
  f.sample.registry.source("assets")!.marking = "TLP:AMBER";
  const c3 = await f.call("run_pivot", { why: "w", pivot: "address_to_domains", value: START });
  expect(c3.ok).toBe(true);
  const all = await f.call("list_cards", { why: "w" });
  const cards = view(all).cards as { id: string; title: string; subgoal: string | null; validated: string | null; place: string }[];
  expect(cards.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  expect(cards[0]).toMatchObject({ subgoal: "g1", validated: null, place: "incoming" });
  expect(all.marking).toBe("TLP:GREEN");
  f.s.commit(() => [{ type: "card.discarded", actor: person, payload: { card: "c1" } }]);
  const left = await f.call("list_cards", { why: "w" });
  expect((view(left).cards as { id: string }[]).map((c) => c.id)).toEqual(["c2", "c3"]);
  const g2 = await f.call("list_cards", { why: "w", subgoal: "g2" });
  expect((view(g2).cards as { id: string }[]).map((c) => c.id)).toEqual(["c2"]);
  const none = await f.call("list_cards", { why: "w", subgoal: "zz" });
  expect(view(none).cards).toEqual([]);
  expect(none.marking).toBeNull();
  f.s.state.cards.c2!.marking = "TLP:RED";
  expect((await f.call("list_cards", { why: "w" })).marking).toBe("TLP:RED");
});

test("read_card gives the exact query, its source hash and the result's hash", async () => {
  await f.call("run_pivot", { pivot: "address_to_domains", value: START, why: "who talked to it" });
  const r = await f.call("read_card", { why: "w", card: "c1" });
  expect(r.ok).toBe(true);
  expect(r.marking).toBe("TLP:GREEN");
  const v = view(r);
  const q = f.s.state.queries.q1!;
  const issued = f.s.entries().find((e) => e.type === "query.issued")!;
  expect(v).toMatchObject({ id: "c1", columns: ["name"], coverage: { kind: "full" }, empty: null, marking: "TLP:GREEN", quality_notes: ["resolver logging was duplicated"] });
  expect((v.rows as Json[]).length).toBeLessThanOrEqual(20);
  expect(v.card).toEqual([{ id: "c1", title: f.s.state.cards.c1!.title }]);
  expect(v.provenance).toEqual({
    query: "q1", source: "dns-logs", source_hash: f.sample.registry.source("dns-logs")!.hash,
    text: "select distinct name from dns where answer = $value and ts >= $window_from and ts < $window_to",
    bound: { value: START }, window: { ...WINDOW }, why: "who talked to it", by: "researcher-g1", issued: issued.ts,
    result_sha256: q.result!.blob, rows_hash: q.rows_hash,
  });
});

test("read_card on a card from an http source does not show the service's address", async () => {
  const pivot = f.sample.registry.pivot("address_to_verdict")!;
  const done = await runQuery(f.s, f.sample.deps, { source: "reputation", text: pivot.query, bound: { value: START }, window: WINDOW, why: "w", actor: person, pivot, budget: 10 });
  expect(done.status).toBe("done");
  expect(f.sample.fixture.url).toContain("127.0.0.1");
  expect(f.s.entries().find((e) => e.type === "query.issued")!.payload).toMatchObject({ text: expect.stringContaining("127.0.0.1") });
  const r = await f.call("read_card", { why: "w", card: "c1" });
  const text = JSON.stringify(r.view);
  expect(text).not.toContain("127.0.0.1");
  expect(text).not.toContain("http://");
  expect((view(r).provenance as { text: string }).text).toBe(`GET /v1/reputation/${START}`);
});

test("verify_card re-runs the query and reports matches", async () => {
  await f.call("run_pivot", { pivot: "address_to_domains", value: START, why: "w" });
  const r = await f.call("verify_card", { why: "check it", card: "c1" });
  expect(r.ok).toBe(true);
  expect(view(r)).toMatchObject({ outcome: "matches", rerun: "q2", proposal: null });
  expect(r.summary).toStartWith("matches");
  expect(f.s.state.cards.c1!.validated).toMatchObject({ outcome: "matches" });
  const rerun = f.s.entries().filter((e) => e.type === "query.issued").map((e) => e.actor);
  expect(rerun[1]).toMatchObject({ kind: "agent" });
});

test("verify_card on an unknown card is an error result", async () => {
  const head = f.s.head().seq;
  const r = await f.call("verify_card", { why: "w", card: "c99" });
  expect(r).toMatchObject({ ok: false, summary: "unknown card: c99" });
  expect((await f.call("read_card", { why: "w", card: "c99" })).summary).toBe("unknown card: c99");
  expect(f.s.head().seq).toBe(head);
});
