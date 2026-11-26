import { expect, test } from "bun:test";
import { ENTRY_TYPES } from "../../src/core/types";
import type { Entry, EntryType, Payloads } from "../../src/core/types";
import type { Reference } from "../../src/core/wire";
import { describe } from "../../src/web/describe";
import { EntryBuilder } from "../helpers/entries";

const ref: Reference = {
  types: [], pivots: [], objectives: [], phases: [], profile: { id: "p", title: "p" }, send_back_cap: 3, playbooks: [], inventories: [],
  sources: [{ id: "reputation", title: "Reputation service", connector: "http", marking: "TLP:GREEN", where: "machine", confirmed: true, adhoc: false, cost: { weight: 5, unit: "lookups" }, quality: "" }],
};
const sampleOf = (type: EntryType, payload: unknown = {}): Entry => new EntryBuilder().add(type, payload as never);

test("every entry type has a description", () => {
  for (const type of ENTRY_TYPES) {
    const d = describe(sampleOf(type), ref);
    expect([type, d.what]).not.toEqual([type, ""]);
    expect(typeof d.detail).toBe("string");
  }
});

test("a description never throws on a payload of the wrong shape", () => {
  for (const type of ENTRY_TYPES) {
    for (const payload of [null, [], 5, { query: 1, card: 2, text: 3, rows: "x", coverage: 4, result: 5, from: 1 }]) {
      expect(() => describe(sampleOf(type, payload), ref)).not.toThrow();
      expect(describe(sampleOf(type, payload), ref).what).not.toBe("");
    }
  }
});

test("the plain sentences the brief names", () => {
  expect(describe(sampleOf("query.issued"), ref).what).toBe("query issued");
  expect(describe(sampleOf("card.created"), ref).what).toBe("card created");
  expect(describe(sampleOf("plan.accepted"), ref).what).toBe("plan accepted");
  expect(describe(sampleOf("stage.sent_back"), ref).what).toBe("stage sent back");
});

test("a query issued gives the source's title, the text and why", () => {
  const p: Payloads["query.issued"] = { query: "q1", source: "reputation", source_hash: "h", pivot: null, pivot_hash: null, connector: "http", text: "GET /v1/ip", bound: {}, window: { from: null, to: null }, why: "to see its record", estimate: null, step: null, verifies: null, purpose: "result" };
  expect(describe(sampleOf("query.issued", p), ref).detail).toBe("Reputation service · GET /v1/ip · why: to see its record");
  expect(describe(sampleOf("query.issued", { ...p, source: "unlisted" }), ref).detail).toBe("unlisted · GET /v1/ip · why: to see its record");
});

test("a query result says its rows, its coverage and the start of its hash", () => {
  const base = { query: "q1", result: { blob: "abcd1234ef", bytes: 10 }, rows: 3, rows_hash: "h", duration_ms: 5, cost: null };
  expect(describe(sampleOf("query.result", { ...base, coverage: { kind: "full" } }), ref).detail).toBe("3 rows · full coverage · sha256 abcd…");
  const partial = describe(sampleOf("query.result", { ...base, coverage: { kind: "partial", reason: "row_limit" } }), ref);
  expect(partial.detail).toBe("3 rows · partial: row_limit · sha256 abcd…");
  expect(partial.detail).toContain("partial");
});

test("a card, a send-back and a plan decision give their particulars", () => {
  expect(describe(sampleOf("card.created", { card: { id: "c3", title: "Accounts" } }), ref).detail).toBe('c3 "Accounts"');
  expect(describe(sampleOf("stage.sent_back", { from: "evaluate", to: "assemble", reason: "a claim has no card", count: 1 }), ref).detail).toBe("evaluate → assemble: a claim has no card");
  expect(describe(sampleOf("plan.denied", { plan: "plan-1", reason: "wrong question" }), ref).detail).toContain("wrong question");
  expect(describe(sampleOf("step.estimated", { step: "s3", estimate: { amount: 1, unit: "lookups" }, query: "q2" }), ref).detail).toBe("s3 · 1 lookups");
});

test("text from an entry is returned as plain text, never changed", () => {
  const evil = '<img src=x onerror="alert(1)">';
  expect(describe(sampleOf("card.created", { card: { id: "c1", title: evil } }), ref).detail).toBe(`c1 "${evil}"`);
});

test("a repriced proposal says what the source now estimates and the budget that did not cover it", () => {
  const d = describe(sampleOf("proposal.repriced", { proposal: "P1", estimate: { amount: 900, unit: "rows" }, budget: 100, query: null }), ref);
  expect(d).toMatchObject({ what: "proposal repriced", detail: "P1 · 900 rows · budget 100 not enough" });
});

test("a step finished on a reused query says reused, and that no query was sent", () => {
  const p: Payloads["step.finished"] = { step: "s4", outcome: "empty", cards: ["c1"], note: "reused q1 from 2026-11-20T10:00:00.000Z; same pivot, value and window", reused: "q1" };
  expect(describe(sampleOf("step.finished", p), ref)).toEqual({
    what: "step reused, no query sent", detail: "s4 · empty · reused q1 from 2026-11-20T10:00:00.000Z; same pivot, value and window",
  });
  const { reused: _, ...ran } = p;
  expect(describe(sampleOf("step.finished", { ...ran, note: "1 row" }), ref)).toEqual({ what: "step finished", detail: "s4 · empty · 1 row" });
  expect(describe(sampleOf("step.finished", { ...ran, reused: 7 }), ref).what).toBe("step finished");
});
