import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseSession } from "../../src/core/session";
import type { Actor, Card, StageDef } from "../../src/core/types";
import { CaseRefused, Workbench } from "../../src/core/workbench";
import type { ChildLink, NewCase } from "../../src/core/workbench";
import { card as cardStub } from "../helpers/entries";

const person: Actor = { kind: "human", id: "analyst" };
const engine: Actor = { kind: "system", id: "engine" };
const sample: NewCase = {
  title: "Beaconing", asked: "Is 192.0.2.10 beaconing?", why: "alert", starting: [{ type: "ip", value: "192.0.2.10" }],
  window: { from: null, to: null }, objective: null, marking: "TLP:GREEN",
};
const looped: StageDef[] = [
  { id: "investigate", title: "Investigate", phase: "collect", runs: "loop", gate: null, reviews: false, model: null },
  { id: "assemble", title: "Assemble", phase: "produce", runs: "agent", gate: null, reviews: false, model: null },
];
const plain: StageDef[] = [
  { id: "collect", title: "Collect", phase: "collect", runs: "script", gate: null, reviews: false, model: null },
];

let dir: string;
let wb: Workbench;
const errors: unknown[] = [];
const onError = (e: unknown) => void errors.push(e);
// The ledger reads its clock once per entry, so a clock that ticks on every read would give each entry of one commit its own time. This one
// stands still, so the time equality below says only that nothing else was asked of the clock; that the first commit is one transaction is
// shown by "an input card the ledger refuses leaves nothing".
const now = () => new Date(Date.parse("2026-11-27T09:00:00.000Z")).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-loops-"));
  errors.length = 0;
  wb = Workbench.open(join(dir, "wb"), { store: join(dir, "store"), now, onError });
});
afterEach(() => {
  try { wb.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const linkTo = (parent: string, over: Partial<ChildLink> = {}): ChildLink => ({
  parent, run: "run-1", stage: "investigate", attempt: 1, loop: "investigation", input_hash: "c".repeat(64), depth: 1, floor: "TLP:GREEN", ...over,
});
const fromParent = (over: Partial<Card> = {}): Card => cardStub("x", {
  marking: "TLP:GREEN",
  kind: "note", made_by: "system", columns: [], column_types: [], rows: [], row_count: 0, coverage: null, title: "From the parent", body: "Seen.",
  from: { case: "CASE-1", loop: "triage", run: "run-1", card: "c2", head: "d".repeat(64) }, ...over,
});

/** A parent of loop `triage` whose run is at its sub-loop stage, with `child` started; `pause` also pauses it on the child. */
function parentAt(child: string, pause: boolean): CaseSession {
  const s = wb.createCase(sample, person, { loop: "triage" });
  const hash = "b".repeat(64);
  const lock = s.blobs.put(JSON.stringify({ loop: "triage", items: [] }), "application/json");
  s.commit((_st, ids) => [
    { type: "loop.bound", payload: { loop: "triage", version: 1, hash, lock }, actor: engine },
    { type: "run.started", payload: { run: ids.next("run"), pipeline: "triage", pipeline_hash: hash, stages: looped }, actor: engine },
  ]);
  s.commit(() => [{ type: "stage.started", payload: { stage: "investigate", attempt: 1 }, actor: engine, stage: "investigate" }]);
  const inputs = s.blobs.put(JSON.stringify({ question: "Is it beaconing?" }), "application/json");
  s.commit(() => [{
    type: "subloop.started", payload: { stage: "investigate", attempt: 1, child, loop: "investigation", loop_hash: "e".repeat(64), input_hash: "c".repeat(64), inputs, depth: 1 },
    actor: engine, stage: "investigate",
  }]);
  if (pause) s.commit(() => [{ type: "run.paused", payload: { reason: `waiting on child ${child}: it waits at its plan gate`, hold: { kind: "child", stage: "investigate", child } }, actor: engine }]);
  return s;
}
const startRun = (s: CaseSession): void => void s.commit((_st, ids) => [{ type: "run.started", payload: { run: ids.next("run"), pipeline: "investigation", pipeline_hash: "a".repeat(64), stages: plain }, actor: engine }]);
const summary = (id: string) => wb.listCases().find((c) => c.id === id)!;

test("createCase with no opts writes case.created alone, as before", () => {
  const s = wb.createCase(sample, person);
  expect(s.entries().map((e) => e.type)).toEqual(["case.created"]);
  expect(s.state.loop.id).toBeNull();
  expect(summary("CASE-1")).toMatchObject({ loop: null, parent: null, waiting_on: null });
  expect(s.state.skipped).toEqual([]);
});

test("createCase with a loop writes case.created and case.loop_set in one commit, and the summary names the loop", () => {
  const s = wb.createCase(sample, person, { loop: "triage" });
  expect(s.entries().map((e) => e.type)).toEqual(["case.created", "case.loop_set"]);
  expect(new Set(s.entries().map((e) => e.ts)).size).toBe(1);
  expect(s.entries()[1]).toMatchObject({ payload: { loop: "triage" }, actor: person });
  expect(s.state.loop.id).toBe("triage");
  expect(summary("CASE-1")).toMatchObject({ loop: "triage", parent: null, waiting_on: null });
  expect(s.state.skipped).toEqual([]);
});

test("createCase with a link writes case.created, case.loop_set and subloop.child in one commit; the summary names the parent", () => {
  wb.createCase(sample, person, { loop: "triage" });
  const session = wb.createCase(sample, engine, { loop: "investigation", link: linkTo("CASE-1") });
  expect(session.entries().map((e) => e.type)).toEqual(["case.created", "case.loop_set", "subloop.child"]); expect(new Set(session.entries().map((e) => e.ts)).size).toBe(1);
  expect(session.entries()[2]).toMatchObject({ actor: engine, payload: linkTo("CASE-1") });
  expect(session.state.loop.parent).toEqual({ case: "CASE-1", run: "run-1", stage: "investigate", attempt: 1, loop: "investigation", input_hash: "c".repeat(64), depth: 1, floor: "TLP:GREEN" });
  expect(summary("CASE-2")).toMatchObject({ loop: "investigation", parent: "CASE-1", waiting_on: null });
  expect(session.state.skipped).toEqual([]);
});

test("the input cards arrive in the child's incoming with their marking and their origin", () => {
  wb.createCase(sample, person, { loop: "triage" });
  const amber = fromParent({ marking: "TLP:AMBER", title: "Kept in the parent" });
  const green = fromParent({ id: "c9", marking: "TLP:GREEN", from: { case: "CASE-1", loop: "triage", run: "run-1", card: null, head: "d".repeat(64) } });
  const s = wb.createCase({ ...sample, marking: "TLP:AMBER" }, engine, { loop: "investigation", link: linkTo("CASE-1", { floor: "TLP:AMBER" }), cards: [amber, green] });
  expect(s.entries().map((e) => e.type)).toEqual(["case.created", "case.loop_set", "subloop.child", "card.created", "card.created"]);
  expect(new Set(s.entries().map((e) => e.ts)).size).toBe(1);
  expect(s.entries().slice(3).every((e) => e.actor.kind === "system" && e.actor.id === "engine")).toBe(true);
  expect(s.state.incoming).toEqual(["c1", "c2"]);
  expect(s.state.cards["c1"]).toMatchObject({ title: "Kept in the parent", marking: "TLP:AMBER", from: amber.from, place: "incoming" });
  expect(s.state.cards["c2"]).toMatchObject({ marking: "TLP:GREEN", from: green.from });
  expect(s.state.skipped).toEqual([]);
});

test("a child less strictly marked than its floor is refused and no folder is left", () => {
  wb.createCase(sample, person, { loop: "triage" });
  const before = readdirSync(join(dir, "wb", "cases")).sort();
  expect(() => wb.createCase(sample, engine, { loop: "investigation", link: linkTo("CASE-1", { floor: "TLP:AMBER" }) })).toThrow(TypeError);
  // a card more strictly marked than the case is refused the same way
  expect(() => wb.createCase(sample, engine, { loop: "investigation", link: linkTo("CASE-1"), cards: [fromParent({ marking: "TLP:RED" })] })).toThrow(TypeError);
  expect(readdirSync(join(dir, "wb", "cases")).sort()).toEqual(before);
  expect(existsSync(join(dir, "wb", "cases", "CASE-2"))).toBe(false);
  expect(wb.createCase(sample, person).id).toBe("CASE-2");
});

test("an input card the ledger refuses leaves nothing: the child's first commit is all or nothing", () => {
  wb.createCase(sample, person, { loop: "triage" });
  // a row holding NaN passes the card's shape and is refused by the ledger, which writes the commit's entries all together or not at all
  expect(() => wb.createCase(sample, engine, { loop: "investigation", link: linkTo("CASE-1"), cards: [fromParent(), fromParent({ rows: [[NaN]] })] })).toThrow();
  expect(readdirSync(join(dir, "wb", "cases")).filter((n) => n.startsWith("CASE-"))).toEqual(["CASE-1"]);
  expect(wb.findChild(linkTo("CASE-1"))).toBeNull();
});

test("findChild finds the child of a link by parent, run, stage, attempt and input hash, and none for another attempt or another input hash", () => {
  wb.createCase(sample, person, { loop: "triage" });
  const link = linkTo("CASE-1");
  expect(wb.findChild(link)).toBeNull();
  const child = wb.createCase(sample, engine, { loop: "investigation", link });
  wb.createCase(sample, person);
  expect(wb.findChild(link)).toBe(child.id);
  expect(wb.findChild({ ...link })).toBe("CASE-2");
  expect(wb.findChild({ ...link, attempt: 2 })).toBeNull();
  expect(wb.findChild({ ...link, input_hash: "f".repeat(64) })).toBeNull();
  expect(wb.findChild({ ...link, run: "run-2" })).toBeNull();
  expect(wb.findChild({ ...link, stage: "assemble" })).toBeNull();
  expect(wb.findChild({ ...link, parent: "CASE-3" })).toBeNull();
  // it reads a ledger whose session is not open, and opens none
  child.close();
  expect(wb.findChild(link)).toBe("CASE-2");
  expect(errors).toEqual([]);
});

test("the summary of a parent paused on a child names the child in waiting_on", () => {
  const parent = parentAt("CASE-2", false);
  expect(summary("CASE-1").waiting_on).toBeNull();
  parent.commit(() => [{ type: "run.paused", payload: { reason: "waiting on child CASE-2: it waits at its plan gate", hold: { kind: "child", stage: "investigate", child: "CASE-2" } }, actor: engine }]);
  expect(summary("CASE-1")).toMatchObject({ loop: "triage", parent: null, waiting_on: "CASE-2", run_status: "paused" });
  parent.commit(() => [{ type: "run.resumed", payload: {}, actor: engine }]);
  expect(summary("CASE-1").waiting_on).toBeNull();
  expect(parent.state.skipped).toEqual([]);
});

test("a link without a loop is a TypeError", () => {
  wb.createCase(sample, person);
  expect(() => wb.createCase(sample, engine, { link: linkTo("CASE-1") })).toThrow(TypeError);
  expect(() => wb.createCase(sample, engine, { loop: "", link: linkTo("CASE-1") })).toThrow(TypeError);
  expect(() => wb.createCase(sample, engine, { loop: "investigation", link: { ...linkTo("CASE-1"), attempt: 0 } })).toThrow(TypeError);
  expect(() => wb.createCase(sample, engine, { loop: "investigation", cards: [fromParent()] })).toThrow(TypeError);
  expect(readdirSync(join(dir, "wb", "cases")).filter((n) => n.startsWith("CASE-"))).toEqual(["CASE-1"]);
});

test("a child whose loop is not the loop its link names is refused, and nothing is written", () => {
  wb.createCase(sample, person, { loop: "triage" });
  expect(() => wb.createCase(sample, engine, { loop: "triage", link: linkTo("CASE-1", { loop: "investigation" }) })).toThrow(TypeError);
  expect(() => wb.createCase(sample, engine, { loop: "triage", link: linkTo("CASE-1", { loop: "investigation" }) })).toThrow(/the loop its link names/);
  expect(readdirSync(join(dir, "wb", "cases")).filter((n) => n.startsWith("CASE-"))).toEqual(["CASE-1"]);
  const child = wb.createCase(sample, engine, { loop: "investigation", link: linkTo("CASE-1") });
  expect(child.id).toBe("CASE-2");
  expect([child.state.loop.id, child.state.loop.parent!.loop]).toEqual(["investigation", "investigation"]);
});

test("a parent is not unloaded while a child it started is running; once the child is not running it may be", async () => {
  const parent = parentAt("CASE-2", true);
  const child = wb.createCase(sample, engine, { loop: "investigation", link: linkTo("CASE-1") });
  startRun(child);
  const head = parent.head();
  await expect(wb.unloadCase("CASE-1", { actor: person })).rejects.toThrow(new CaseRefused("CASE-2, a child of this case, is running; wait for it or pause it first"));
  expect(parent.head()).toEqual(head);
  child.commit(() => [{ type: "run.paused", payload: { reason: "the person paused it" }, actor: person }]);
  const r = await wb.unloadCase("CASE-1", { actor: person });
  expect(r.ok).toBe(true);
  expect(errors).toEqual([]);
});

test("a child is not unloaded alone while its parent waits on it; with the parent unloaded it may be, and each loads on its own", async () => {
  parentAt("CASE-2", true);
  wb.createCase(sample, engine, { loop: "investigation", link: linkTo("CASE-1") });
  await expect(wb.unloadCase("CASE-2", { actor: person })).rejects.toThrow(new CaseRefused("CASE-1 waits on this case; unload CASE-1 first"));
  expect(existsSync(join(dir, "wb", "cases", "CASE-2"))).toBe(true);
  const p = await wb.unloadCase("CASE-1", { actor: person });
  if (!p.ok) throw new Error(p.reason);
  const c = await wb.unloadCase("CASE-2", { actor: person });
  if (!c.ok) throw new Error(c.reason);
  // a child loads without its parent, and a parent without its child
  const child = await wb.loadCase(c.path, { actor: person });
  expect(child.session.state.loop.parent?.case).toBe("CASE-1");
  const parent = await wb.loadCase(p.path, { actor: person });
  expect(parent.session.state.run.hold).toEqual({ kind: "child", stage: "investigate", child: "CASE-2" });
  expect(child.session.state.skipped).toEqual([]);
  expect(parent.session.state.skipped).toEqual([]);
  expect(errors).toEqual([]);
});

test("a child whose parent is not waiting on it is unloaded alone", async () => {
  const parent = parentAt("CASE-2", true);
  wb.createCase(sample, engine, { loop: "investigation", link: linkTo("CASE-1") });
  parent.commit(() => [{ type: "run.finished", payload: { outcome: "stopped" }, actor: person }]);
  const r = await wb.unloadCase("CASE-2", { actor: person });
  expect(r.ok).toBe(true);
});
