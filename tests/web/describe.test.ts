import { expect, test } from "bun:test";
import { ENTRY_TYPES } from "../../src/core/types";
import type { Entry, EntryType, Payloads } from "../../src/core/types";
import type { Reference } from "../../src/core/wire";
import { describe } from "../../src/web/describe";
import { EntryBuilder } from "../helpers/entries";

const ref: Reference = {
  types: [], pivots: [], objectives: [], phases: [], profile: { id: "p", title: "p" }, send_back_cap: 3, playbooks: [], inventories: [], likelihood: [],
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

test("a ruling, a question to the person, its answer and an overrule give their particulars", () => {
  expect(describe(sampleOf("review.ruled", { conflict: "k1", follow: "challenge", note: "one event" }), ref)).toEqual({ what: "conflict ruled on", detail: "k1 · follow challenge · one event" });
  const q: Payloads["question.asked"] = { question: { id: "ask-1", text: "Where is the access point AP-7?", why: "w", cards: [], about: [], blocking: true } };
  expect(describe(sampleOf("question.asked", q), ref)).toEqual({ what: "question put to the person", detail: "ask-1 · Where is the access point AP-7?" });
  expect(describe(sampleOf("question.answered", { question: "ask-1", card: "c3" }), ref)).toEqual({ what: "question answered", detail: "ask-1 · c3" });
  const o: Payloads["finding.overruled"] = { finding: "f1", draft_hash: "h", likelihood: "almost certain", confidence: "high", stays: null, note: "It is the TV I installed." };
  expect(describe(sampleOf("finding.overruled", o), ref)).toEqual({ what: "finding overruled", detail: "f1 · likelihood almost certain, confidence high · It is the TV I installed." });
  expect(describe(sampleOf("finding.overruled", { ...o, likelihood: null, confidence: null, stays: false }), ref).detail).toBe("f1 · dropped · It is the TV I installed.");
  expect(describe(sampleOf("finding.overruled", { ...o, likelihood: null, confidence: null, stays: true }), ref).detail).toBe("f1 · must stay · It is the TV I installed.");
  expect(describe(sampleOf("finding.overruled", { ...o, likelihood: null, confidence: null, stays: null }), ref).detail).toBe("f1 · overrule withdrawn · It is the TV I installed.");
  expect(describe(sampleOf("finding.overruled", { finding: "f1", likelihood: 5 }), ref).detail).toBe("f1 · overrule withdrawn");
});

test("an unload, a failed unload and a load give their particulars", () => {
  const head = { seq: 41, hash: "a".repeat(64) };
  expect(describe(sampleOf("case.unloaded", { store: "store", head }), ref)).toEqual({ what: "case unloaded", detail: "store" });
  expect(describe(sampleOf("case.unload_failed", { reason: "the store folder is not there" }), ref)).toEqual({ what: "unload failed", detail: "the store folder is not there" });
  expect(describe(sampleOf("case.loaded", { file: "CASE-1.TLP-GREEN.tar.gz", head, id: "CASE-1" }), ref)).toEqual({ what: "case loaded", detail: "CASE-1.TLP-GREEN.tar.gz" });
  expect(describe(sampleOf("case.loaded", { file: 7 }), ref)).toEqual({ what: "case loaded", detail: "7" });
  expect(describe(sampleOf("case.unloaded", { store: null }), ref)).toEqual({ what: "case unloaded", detail: "" });
});

test("a loop chosen, a loop version, a child's parent and a sub-loop started and finished give their particulars", () => {
  const lock = { blob: "a".repeat(64), bytes: 10 };
  expect(describe(sampleOf("case.loop_set", { loop: "triage" }), ref)).toEqual({ what: "loop chosen", detail: "triage" });
  expect(describe(sampleOf("loop.bound", { loop: "triage", version: 3, hash: "b".repeat(64), lock }), ref)).toEqual({ what: "loop version", detail: "triage v3" });
  expect(describe(sampleOf("subloop.child", { parent: "CASE-1", run: "run-1", stage: "investigate", attempt: 1, loop: "investigation", input_hash: "c", depth: 1, floor: "TLP:AMBER" }), ref))
    .toEqual({ what: "child of", detail: "CASE-1 · investigate" });
  expect(describe(sampleOf("subloop.started", { stage: "investigate", attempt: 1, child: "CASE-2", loop: "investigation", loop_hash: "h", input_hash: "c", inputs: lock, depth: 1 }), ref))
    .toEqual({ what: "sub-loop started", detail: "investigation as CASE-2" });
  expect(describe(sampleOf("subloop.finished", { stage: "investigate", attempt: 1, child: "CASE-2", child_run: "run-1", head: { seq: 8, hash: "d" }, outcome: "published", output_hash: "e", output: lock, cards: [] }), ref))
    .toEqual({ what: "sub-loop finished", detail: "CASE-2 · published" });
  // read loosely: a missing or odd field is left out, never thrown on
  expect(describe(sampleOf("loop.bound", { loop: 7 }), ref)).toEqual({ what: "loop version", detail: "7" });
  expect(describe(sampleOf("subloop.child", {}), ref).what).toBe("child of");
});
