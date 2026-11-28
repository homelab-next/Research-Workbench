// Slice 14, Task 7: an improve case's first commit, and a probe child's: marked, capped and found by its link.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseSession } from "../../src/core/session";
import type { Actor, Marking, StageDef } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import type { ChildLink, NewCase, ProbeMark } from "../../src/core/workbench";

const person: Actor = { kind: "human", id: "analyst" };
const engine: Actor = { kind: "system", id: "engine" };
const probeActor: Actor = { kind: "system", id: "improve-probe" };
const words = (marking: Marking): NewCase => ({ title: "Improve", asked: "", why: "", starting: [], window: { from: null, to: null }, objective: null, marking });
const task: NewCase = {
  title: "Probe", asked: "Is 192.0.2.10 beaconing?", why: "probe", starting: [{ type: "ip", value: "192.0.2.10" }],
  window: { from: null, to: null }, objective: null, marking: "TLP:AMBER",
};
const REQUEST = { target: "investigation", case_type: "beaconing", tasks: 2, candidates: 2 };

let dir: string;
let wb: Workbench;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-improve-"));
  wb = Workbench.open(join(dir, "wb"), { onError: () => {} });
});
afterEach(() => {
  try { wb.close(); } finally { rmSync(dir, { recursive: true, force: true }); }
});

const improveCase = (marking: Marking = "TLP:AMBER"): CaseSession =>
  wb.createCase(words(marking), person, { loop: "improve", type: "beaconing", improve: REQUEST });
const linkOf = (parent: string, input_hash = "a".repeat(64), floor: Marking = "TLP:AMBER"): ChildLink => ({
  parent, run: "run-1", stage: "probe", attempt: 1, loop: "investigation", input_hash, depth: 1, floor,
});
const markOf = (parent: CaseSession, candidate = "base", t = "T1", over: Partial<ProbeMark> = {}): ProbeMark => ({
  improve: parent.id, origin: parent.entries()[0]!.hash, probe: `${candidate}/${t}`, candidate, task: t, plan_gate: "accept", max_lookups: 2, max_tokens: 5000, ...over,
});
/** The number the next case would take: unchanged when a refused createCase wrote nothing. */
const nextId = (): string => {
  const s = wb.createCase(words("TLP:GREEN"), person);
  return s.id;
};

test("a probe child's first commit is case.created, case.loop_set, subloop.child, case.type_set, probe.child and budget.set, and folds with nothing skipped", () => {
  const parent = improveCase();
  const mark = markOf(parent);
  const child = wb.createCase(task, engine, { loop: "investigation", link: linkOf(parent.id), type: "beaconing", probe: mark });
  const entries = child.entries();
  expect(entries.map((e) => e.type)).toEqual(["case.created", "case.loop_set", "subloop.child", "case.type_set", "probe.child", "budget.set"]);
  const { max_tokens: _tokens, ...rest } = mark;
  expect(entries[4]).toMatchObject({ actor: engine, payload: rest });
  expect(Object.keys(entries[4]!.payload).sort()).toEqual(["candidate", "improve", "max_lookups", "origin", "plan_gate", "probe", "task"]);
  expect(entries[5]).toMatchObject({ actor: engine, payload: { tokens: 5000 } });
  expect(child.state.skipped).toEqual([]);
  expect(child.state.improve.probe_of).toEqual(rest);
  expect(child.state.run.budget_tokens).toBe(5000);
  expect(child.state.loop.parent?.case).toBe(parent.id);
  expect(child.state.memory.type).toBe("beaconing");
  expect(parent.state.skipped).toEqual([]);
});

test("createCase with probe and no link, or with improve by code or without the type, is a TypeError and writes nothing", () => {
  const parent = improveCase();
  const first = nextId();
  const n = Number(first.slice(5));
  const mark = markOf(parent);
  const link = linkOf(parent.id);
  const refusals: [string, () => unknown][] = [
    ["probe without a link", () => wb.createCase(task, engine, { loop: "investigation", type: "beaconing", probe: mark })],
    ["probe naming another improve case", () => wb.createCase(task, engine, { loop: "investigation", link, probe: { ...mark, improve: "CASE-99" } })],
    ["probe with a probe id not its candidate's and task's", () => wb.createCase(task, engine, { loop: "investigation", link, probe: { ...mark, probe: "K1/T1" } })],
    ["probe with no lookups", () => wb.createCase(task, engine, { loop: "investigation", link, probe: { ...mark, max_lookups: 0 } })],
    ["probe with no tokens", () => wb.createCase(task, engine, { loop: "investigation", link, probe: { ...mark, max_tokens: 0 } })],
    ["probe with a fractional cap", () => wb.createCase(task, engine, { loop: "investigation", link, probe: { ...mark, max_lookups: 1.5 } })],
    ["probe with another plan gate", () => wb.createCase(task, engine, { loop: "investigation", link, probe: { ...mark, plan_gate: "wait" as never } })],
    ["probe made by improve-probe", () => wb.createCase(task, probeActor, { loop: "investigation", link, probe: mark })],
    ["probe and improve at once", () => wb.createCase(task, engine, { loop: "investigation", link, type: "beaconing", probe: mark, improve: REQUEST })],
    ["improve by code", () => wb.createCase(words("TLP:AMBER"), engine, { loop: "improve", type: "beaconing", improve: REQUEST })],
    ["improve by improve-probe", () => wb.createCase(words("TLP:AMBER"), probeActor, { loop: "improve", type: "beaconing", improve: REQUEST })],
    ["improve without the type", () => wb.createCase(words("TLP:AMBER"), person, { loop: "improve", improve: REQUEST })],
    ["improve with another type", () => wb.createCase(words("TLP:AMBER"), person, { loop: "improve", type: "phishing", improve: REQUEST })],
    ["improve without a loop", () => wb.createCase(words("TLP:AMBER"), person, { type: "beaconing", improve: REQUEST })],
    ["improve with a default loop only", () => wb.createCase(words("TLP:AMBER"), person, { default_loop: "improve", type: "beaconing", improve: REQUEST })],
    ["improve with too many tasks", () => wb.createCase(words("TLP:AMBER"), person, { loop: "improve", type: "beaconing", improve: { ...REQUEST, tasks: 9 } })],
    ["improve with no candidate", () => wb.createCase(words("TLP:AMBER"), person, { loop: "improve", type: "beaconing", improve: { ...REQUEST, candidates: 0 } })],
    ["improve with an empty target", () => wb.createCase(words("TLP:AMBER"), person, { loop: "improve", type: "beaconing", improve: { ...REQUEST, target: "" } })],
    ["improve as a child", () => wb.createCase(words("TLP:AMBER"), person, { loop: "investigation", link, type: "beaconing", improve: REQUEST })],
  ];
  for (const [what, make] of refusals) {
    try {
      make();
      throw new Error(`${what} was not refused`);
    } catch (err) {
      expect([what, err instanceof TypeError]).toEqual([what, true]);
    }
  }
  // nothing was written: the next case takes the very next number, and the improve case is as it was
  expect(nextId()).toBe(`CASE-${n + 1}`);
  expect(parent.entries().length).toBe(4);
  expect(wb.findChild(link)).toBeNull();
});

test("a probe child is marked at least as strictly as its improve case and as the task it probes, or it is a TypeError", () => {
  const parent = improveCase("TLP:AMBER");
  const stages: StageDef[] = [{ id: "select", title: "Select", phase: null, runs: "script", gate: null, reviews: false, model: null }];
  const blob = (c: string) => ({ blob: c.repeat(64), bytes: 10 });
  parent.commit((_st, ids) => [{ type: "run.started", actor: engine, payload: { run: ids.next("run"), pipeline: "improve", pipeline_hash: "a".repeat(64), stages } }]);
  parent.commit((st) => [
    { type: "improve.selected", actor: engine, run: st.run.id, payload: { target: "investigation", version: 1, loop_hash: "e".repeat(64), lock: blob("1"), case_type: "beaconing", scale: ["unlikely", "likely"], left_out: [] } },
    { type: "improve.task", actor: engine, run: st.run.id, payload: {
      task: "T1", case: "CASE-40", origin: "f".repeat(64), head: { seq: 9, hash: "9".repeat(64) }, product: { n: 1, draft_hash: "d".repeat(64) },
      answer: { seq: 8, hash: "8".repeat(64) }, marking: "TLP:RED", inputs: blob("2"), record: blob("3"),
    } },
  ]);
  expect(parent.state.skipped).toEqual([]);
  const plain = wb.createCase(words("TLP:GREEN"), person);
  const before = nextId();
  // weaker than the improve case (the link's floor let it through)
  expect(() => wb.createCase({ ...task, marking: "TLP:GREEN" }, engine, { loop: "investigation", link: linkOf(parent.id, "b".repeat(64), "TLP:GREEN"), probe: markOf(parent, "base", "T2") })).toThrow(TypeError);
  // weaker than the task it probes
  expect(() => wb.createCase({ ...task, marking: "TLP:AMBER" }, engine, { loop: "investigation", link: linkOf(parent.id), probe: markOf(parent) })).toThrow(TypeError);
  // a parent that is loaded and is no improve case
  expect(() => wb.createCase(task, engine, { loop: "investigation", link: linkOf(plain.id), probe: markOf(plain) })).toThrow(TypeError);
  expect(nextId()).toBe(`CASE-${Number(before.slice(5)) + 1}`);
  const child = wb.createCase({ ...task, marking: "TLP:RED" }, engine, { loop: "investigation", link: linkOf(parent.id, "a".repeat(64), "TLP:AMBER"), probe: markOf(parent) });
  expect(child.state.skipped).toEqual([]);
  expect(child.state.improve.probe_of?.task).toBe("T1");
});

test("an improve case's first commit holds improve.requested by the person, and its fold has the request", () => {
  const s = improveCase();
  const entries = s.entries();
  expect(entries.map((e) => e.type)).toEqual(["case.created", "case.loop_set", "improve.requested", "case.type_set"]);
  expect(entries[2]).toMatchObject({ seq: 3, actor: person, payload: REQUEST });
  expect(Object.keys(entries[2]!.payload).sort()).toEqual(["candidates", "case_type", "target", "tasks"]);
  expect(s.state.skipped).toEqual([]);
  expect(s.state.improve.request).toEqual({ ...REQUEST, by: "analyst" });
  expect(s.state.improve.probe_of).toBeNull();
  expect(s.state.memory.type).toBe("beaconing");
  expect(s.state.loop.parent).toBeNull();
});

test("findChild finds a probe child by its link; two probes of one stage attempt differ by their input hash", () => {
  const parent = improveCase();
  const l1 = linkOf(parent.id, "1".repeat(64));
  const l2 = linkOf(parent.id, "2".repeat(64));
  const c1 = wb.createCase(task, engine, { loop: "investigation", link: l1, type: "beaconing", probe: markOf(parent, "base", "T1") });
  const c2 = wb.createCase(task, engine, { loop: "investigation", link: l2, type: "beaconing", probe: markOf(parent, "K1", "T1") });
  expect(c1.id).not.toBe(c2.id);
  expect(wb.findChild(l1)).toBe(c1.id);
  expect(wb.findChild(l2)).toBe(c2.id);
  expect(wb.findChild(linkOf(parent.id, "3".repeat(64)))).toBeNull();
  expect(c1.state.improve.probe_of?.probe).toBe("base/T1");
  expect(c2.state.improve.probe_of?.probe).toBe("K1/T1");
  expect([c1.state.skipped, c2.state.skipped]).toEqual([[], []]);
});
