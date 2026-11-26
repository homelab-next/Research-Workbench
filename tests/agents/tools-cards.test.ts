import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import { startStandin } from "../helpers/http-standin";
import { runQuery } from "../../src/modules/runner";
import { fixture, person, START, WINDOW } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";
import { addStatement } from "../../src/pipeline/person";

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
  expect(v).toMatchObject({ id: "c1", columns: ["name", "first_seen", "last_seen", "events"], coverage: { kind: "full" }, empty: null, marking: "TLP:GREEN", quality_notes: ["resolver logging was duplicated"] });
  expect((v.rows as Json[]).length).toBeLessThanOrEqual(20);
  expect(v.card).toEqual([{ id: "c1", title: f.s.state.cards.c1!.title }]);
  expect(v.provenance).toEqual({
    query: "q1", source: "dns-logs", source_hash: f.sample.registry.source("dns-logs")!.hash,
    text: "select name, min(ts) as first_seen, max(ts) as last_seen, count(*) as events from dns where answer = $value and ts >= $window_from and ts < $window_to group by name order by first_seen, name",
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

test("read_card strips the whole location of an http source, base path included", async () => {
  const standin = startStandin({ [`GET /base/path/v1/reputation/${START}`]: () => Response.json({ results: [{ address: START, verdict: "suspicious", first_seen: "2026-11-01" }] }) });
  try {
    const src = f.sample.registry.source("reputation")!;
    Object.assign(src, { location: `${standin.url}/base/path/` });
    const pivot = f.sample.registry.pivot("address_to_verdict")!;
    const done = await runQuery(f.s, f.sample.deps, { source: "reputation", text: pivot.query, bound: { value: START }, window: WINDOW, why: "w", actor: person, pivot, budget: 10 });
    expect(done.status).toBe("done");
    expect(JSON.stringify(f.s.entries().find((e) => e.type === "query.issued")!.payload)).toContain("/base/path");
    const r = await f.call("read_card", { why: "w", card: "c1" });
    const text = JSON.stringify(r.view);
    expect(text).not.toContain("/base/path");
    expect(text).not.toContain("127.0.0.1");
    expect((view(r).provenance as { text: string }).text).toBe(`GET /v1/reputation/${START}`);
  } finally {
    standin.stop();
  }
});

test("verify_card scrubs a refusal's text", async () => {
  await f.call("run_pivot", { pivot: "address_to_domains", value: START, why: "w" });
  const { rmSync } = await import("node:fs");
  rmSync(`${f.sample.root}/data/dns.jsonl`);
  const r = await f.call("verify_card", { why: "w", card: "c1" });
  expect(JSON.stringify(r)).not.toContain(f.sample.root);
  expect(JSON.stringify(r)).toContain("[hidden]");
});

test("list_cards marks a statement and read_card says how the person knows; other cards' views are as before", async () => {
  await f.call("run_step", { step: "s1", why: "w" });
  const other = await f.call("read_card", { why: "w", card: "c1" });
  const id = addStatement(f.s, f.sample.deps, {
    actor: person, statement: "The device at 192.0.2.17 is the meeting-room TV.", basis: "did", detail: "I installed it", about: [{ type: "address", value: "192.0.2.17" }], marking: null,
  });
  const listed = view(await f.call("list_cards", { why: "w" })).cards as Record<string, Json>[];
  const brief = listed.find((c) => c.id === id)!;
  const otherBrief = listed.find((c) => c.id === "c1")!;
  expect(brief.person).toBe(true);
  expect("person" in otherBrief).toBe(false);
  const r = await f.call("read_card", { why: "w", card: id });
  expect(r.ok).toBe(true);
  expect(view(r).person).toEqual({ basis: "did", how: "did it myself: I installed it", about: [{ type: "address", value: "192.0.2.17" }], answers: null });
  expect(view(r).provenance).toBeNull();
  // the result card reads as it did before the statement was added
  expect(await f.call("read_card", { why: "w", card: "c1" })).toEqual(other);
  expect("person" in view(other)).toBe(false);
});
