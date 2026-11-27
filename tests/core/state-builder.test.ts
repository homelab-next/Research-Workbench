import { expect, test } from "bun:test";
import { builderMarking, builderOpen, fold, initial, initialBuilder } from "../../src/core/state";
import type { Actor, BlobRef, Payloads } from "../../src/core/types";
import { card, EntryBuilder } from "../helpers/entries";

const person: Actor = { kind: "human", id: "analyst" };
const code: Actor = { kind: "system", id: "workbench" };
const builder: Actor = { kind: "agent", id: "builder", stage: "builder", profile: "loop-builder", model: "scripted-m", effort: null, where: "machine" };
const bundle: BlobRef = { blob: "a".repeat(64), bytes: 40, media: "application/json" };
const A = "b".repeat(64);
const B = "c".repeat(64);
const C = "d".repeat(64);

const CREATED: Payloads["case.created"] = {
  id: "BUILD-1", title: "Build a loop", asked: "Build or change a loop", why: "a builder session", starting: [],
  window: { from: null, to: null }, objective: null, marking: "TLP:GREEN",
};
const proposed = (over: Partial<Payloads["builder.proposed"]> = {}): Payloads["builder.proposed"] => ({
  change: "chg-1", title: "A triage loop", why: "the person asked for one", root: "sample",
  files: [
    { path: "loops/triage.yaml", kind: "loop", id: "triage", before: null, after: A },
    { path: "stages/triage-plan.yaml", kind: "stage", id: "triage-plan", before: B, after: C },
  ],
  bundle, ...over,
});
const decided = (over: Partial<Payloads["builder.decided"]> = {}): Payloads["builder.decided"] => ({ change: "chg-1", file: 0, accepted: true, written: A, ...over });
const asked = (over: Partial<Payloads["builder.probe_asked"]> = {}): Payloads["builder.probe_asked"] => ({
  probe: "probe-1", kind: "pivot", source: "netflow", pivot: "flows-by-ip", value: { type: "ip", value: "192.0.2.10" }, text: null,
  window: { from: "2026-11-20T00:00:00Z", to: "2026-11-21T00:00:00Z" }, why: "to see the source's fields", ...over,
});
const probeDecided = (over: Partial<Payloads["builder.probe_decided"]> = {}): Payloads["builder.probe_decided"] => ({
  probe: "probe-1", approved: true, query: "q1", outcome: "ran", detail: "12 rows", ...over,
});

function session(): EntryBuilder {
  const b = new EntryBuilder("BUILD-1");
  b.add("case.created", CREATED, { actor: person });
  return b;
}

test("builder.proposed by the builder agent opens a change with every file undecided", () => {
  const b = session();
  b.add("builder.proposed", proposed(), { actor: builder });
  const s = fold(b.entries);
  expect(s.skipped).toEqual([]);
  expect(s.counters.change).toBe(1);
  expect(s.builder.changes["chg-1"]).toEqual({
    id: "chg-1", title: "A triage loop", why: "the person asked for one", root: "sample",
    files: [
      { path: "loops/triage.yaml", kind: "loop", id: "triage", before: null, after: A, decided: null },
      { path: "stages/triage-plan.yaml", kind: "stage", id: "triage-plan", before: B, after: C, decided: null },
    ],
    bundle, by: "builder", seq: 2,
  });
  // a person may propose one too; code may not
  b.add("builder.proposed", proposed({ change: "chg-2" }), { actor: person });
  b.add("builder.proposed", proposed({ change: "chg-3" }), { actor: code });
  const t = fold(b.entries);
  expect(Object.keys(t.builder.changes)).toEqual(["chg-1", "chg-2"]);
  expect(t.skipped).toEqual([{ seq: 4, type: "builder.proposed", reason: "a change is proposed by the builder or a person" }]);
  // the same change twice is skipped, and the first stays as it was
  b.add("builder.proposed", proposed({ title: "again" }), { actor: builder });
  const u = fold(b.entries);
  expect(u.builder.changes["chg-1"]!.title).toBe("A triage loop");
  expect(u.skipped.at(-1)).toEqual({ seq: 5, type: "builder.proposed", reason: "a change is proposed once" });
});

test("builder.decided by a person records the decision on that file; by an agent or by code it is skipped: a change is decided by a person", () => {
  const b = session();
  b.add("builder.proposed", proposed(), { actor: builder });
  b.add("builder.decided", decided(), { actor: builder });
  b.add("builder.decided", decided(), { actor: code });
  let s = fold(b.entries);
  expect(s.builder.changes["chg-1"]!.files[0]!.decided).toBeNull();
  expect(s.skipped).toEqual([
    { seq: 3, type: "builder.decided", reason: "a change is decided by a person" },
    { seq: 4, type: "builder.decided", reason: "a change is decided by a person" },
  ]);
  b.add("builder.decided", decided(), { actor: person });
  b.add("builder.decided", decided({ file: 1, accepted: false, written: null }), { actor: person });
  s = fold(b.entries);
  expect(s.builder.changes["chg-1"]!.files.map((f) => f.decided)).toEqual([
    { accepted: true, written: A, by: "analyst", seq: 5 },
    { accepted: false, written: null, by: "analyst", seq: 6 },
  ]);
  expect(s.skipped.length).toBe(2);
});

test("a decision on an unknown change, a file index out of range, or a file already decided is skipped with its reason", () => {
  const b = session();
  b.add("builder.proposed", proposed(), { actor: builder });
  b.add("builder.decided", decided({ change: "chg-9" }), { actor: person });
  b.add("builder.decided", decided({ change: "__proto__" }), { actor: person });
  b.add("builder.decided", decided({ file: 2 }), { actor: person });
  b.add("builder.decided", decided({ file: 0 }), { actor: person });
  b.add("builder.decided", decided({ file: 0, accepted: false, written: null }), { actor: person });
  const s = fold(b.entries);
  expect(s.skipped).toEqual([
    { seq: 3, type: "builder.decided", reason: "a decision names a change that was proposed" },
    { seq: 4, type: "builder.decided", reason: "a decision names a change that was proposed" },
    { seq: 5, type: "builder.decided", reason: "a decision names a file of the change" },
    { seq: 7, type: "builder.decided", reason: "a file of a change is decided once" },
  ]);
  expect(s.builder.changes["chg-1"]!.files[0]!.decided).toEqual({ accepted: true, written: A, by: "analyst", seq: 6 });
});

test("builder.probe_asked opens a probe; builder.probe_decided by a person closes it with the query and the outcome; by anything else it is skipped", () => {
  const b = session();
  b.add("builder.probe_asked", asked(), { actor: builder });
  let s = fold(b.entries);
  expect(s.skipped).toEqual([]);
  expect(s.counters.probe).toBe(1);
  const { probe: _id, ...rest } = asked();
  expect(s.builder.probes["probe-1"]).toEqual({ id: "probe-1", ...rest, by: "builder", seq: 2, decided: null });
  b.add("builder.probe_decided", probeDecided(), { actor: builder });
  b.add("builder.probe_decided", probeDecided(), { actor: code });
  s = fold(b.entries);
  expect(s.builder.probes["probe-1"]!.decided).toBeNull();
  expect(s.skipped.map((x) => x.reason)).toEqual(["a probe is decided by a person", "a probe is decided by a person"]);
  b.add("builder.probe_decided", probeDecided(), { actor: person });
  s = fold(b.entries);
  expect(s.builder.probes["probe-1"]!.decided).toEqual({ approved: true, query: "q1", outcome: "ran", detail: "12 rows", by: "analyst", seq: 5 });
  // a second decision, and one on a probe never asked, are skipped
  b.add("builder.probe_decided", probeDecided({ approved: false, query: null, outcome: "rejected", detail: "no" }), { actor: person });
  b.add("builder.probe_decided", probeDecided({ probe: "probe-7" }), { actor: person });
  s = fold(b.entries);
  expect(s.skipped.slice(2)).toEqual([
    { seq: 6, type: "builder.probe_decided", reason: "a probe is decided once" },
    { seq: 7, type: "builder.probe_decided", reason: "a decision names a probe that was asked for" },
  ]);
  // a query probe, rejected by the person; a probe asked for by code is skipped
  b.add("builder.probe_asked", asked({ probe: "probe-2", kind: "query", pivot: null, value: null, text: "SHOW TABLES" }), { actor: builder });
  b.add("builder.probe_decided", probeDecided({ probe: "probe-2", approved: false, query: null, outcome: "rejected", detail: "not now" }), { actor: person });
  b.add("builder.probe_asked", asked({ probe: "probe-3" }), { actor: code });
  s = fold(b.entries);
  expect(s.builder.probes["probe-2"]).toMatchObject({ kind: "query", text: "SHOW TABLES", decided: { approved: false, query: null, outcome: "rejected", by: "analyst" } });
  expect(s.builder.probes["probe-3"]).toBeUndefined();
  expect(s.skipped.at(-1)).toEqual({ seq: 10, type: "builder.probe_asked", reason: "a probe is asked for by the builder or a person" });
});

test("a malformed builder entry of each of the four types is recorded as malformed", () => {
  const bad: [keyof Payloads, unknown][] = [
    ["builder.proposed", { ...proposed(), files: [] }],
    ["builder.proposed", { ...proposed(), files: [{ path: "x.yaml", kind: "loop", id: "x", before: 3, after: A }] }],
    ["builder.proposed", { ...proposed(), change: "c1" }],
    ["builder.proposed", { ...proposed(), bundle: null }],
    ["builder.decided", { ...decided(), file: -1 }],
    ["builder.decided", { ...decided(), accepted: true, written: null }],
    ["builder.decided", { ...decided(), accepted: false, written: A }],
    ["builder.probe_asked", { ...asked(), kind: "shell" }],
    ["builder.probe_asked", { ...asked(), pivot: null }],
    ["builder.probe_asked", { ...asked(), kind: "query", pivot: null, value: null, text: null }],
    ["builder.probe_asked", { ...asked(), window: null }],
    ["builder.probe_decided", { ...probeDecided(), outcome: "maybe" }],
    ["builder.probe_decided", { ...probeDecided(), approved: false, outcome: "ran" }],
    ["builder.probe_decided", { ...probeDecided(), outcome: "rejected" }],
    ["builder.probe_decided", { ...probeDecided(), detail: 4 }],
  ];
  for (const [type, payload] of bad) {
    const b = session();
    b.add("builder.proposed", proposed(), { actor: builder });
    b.add("builder.probe_asked", asked(), { actor: builder });
    const before = fold(b.entries);
    b.add(type, payload as never, { actor: person });
    const s = fold(b.entries);
    expect(s.skipped, `${type} ${JSON.stringify(payload)}`).toEqual([{ seq: 4, type, reason: `malformed ${type}` }]);
    expect(s.builder).toEqual(before.builder);
  }
});

test("builderMarking is the starting marking with no cards and the strictest card's marking once a probe's card is there", () => {
  const b = session();
  expect(builderMarking(fold(b.entries))).toBe("TLP:GREEN");
  b.add("card.created", { card: card("c1", { marking: "TLP:CLEAR" }) }, { actor: code });
  expect(builderMarking(fold(b.entries))).toBe("TLP:GREEN");
  b.add("card.created", { card: card("c2", { marking: "TLP:AMBER" }) }, { actor: code });
  expect(builderMarking(fold(b.entries))).toBe("TLP:AMBER");
  // with no case.created to say where it started, the strictest there is
  expect(builderMarking(initial())).toBe("TLP:RED");
});

test("builderOpen lists what waits for the person, oldest first, and nothing once every file and probe is decided", () => {
  const b = session();
  expect(builderOpen(fold(b.entries))).toEqual({ changes: [], probes: [] });
  b.add("builder.proposed", proposed(), { actor: builder });
  b.add("builder.probe_asked", asked(), { actor: builder });
  b.add("builder.proposed", proposed({ change: "chg-10" }), { actor: builder });
  let s = fold(b.entries);
  // oldest first by when it was proposed, not by its id as text
  expect(builderOpen(s).changes.map((c) => c.id)).toEqual(["chg-1", "chg-10"]);
  expect(builderOpen(s).probes.map((p) => p.id)).toEqual(["probe-1"]);
  b.add("builder.decided", decided(), { actor: person });
  s = fold(b.entries);
  expect(builderOpen(s).changes.map((c) => c.id)).toEqual(["chg-1", "chg-10"]);
  for (const [change, file] of [["chg-1", 1], ["chg-10", 0], ["chg-10", 1]] as const) b.add("builder.decided", decided({ change, file, accepted: false, written: null }), { actor: person });
  b.add("builder.probe_decided", probeDecided({ approved: true, query: null, outcome: "refused", detail: "the guard refused it" }), { actor: person });
  s = fold(b.entries);
  expect(s.skipped).toEqual([]);
  expect(builderOpen(s)).toEqual({ changes: [], probes: [] });
  expect(initial().builder).toEqual(initialBuilder());
  expect(initialBuilder()).toEqual({ changes: {}, probes: {} });
});
