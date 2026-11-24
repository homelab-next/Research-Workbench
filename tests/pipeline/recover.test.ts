import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseSession } from "../../src/core/session";
import type { Actor, EntryInput, StageDef } from "../../src/core/types";
import { verifyCase } from "../../src/core/verify";
import { Workbench } from "../../src/core/workbench";
import type { NewCase } from "../../src/core/workbench";
import { recoverSession } from "../../src/pipeline/recover";

const human: Actor = { kind: "human", id: "analyst" };
const agent: Actor = { kind: "agent", id: "a1", stage: "collect", profile: "p", model: "m", effort: null, where: "machine" };
const newCase: NewCase = {
  title: "Beaconing", asked: "Is 192.0.2.10 beaconing?", why: "alert", starting: [{ type: "ip", value: "192.0.2.10" }],
  window: { from: null, to: null }, objective: null, marking: "TLP:AMBER",
};
const stages: StageDef[] = [
  { id: "plan", title: "Plan", phase: "direct", runs: "agent", gate: "plan", reviews: false, model: null },
];

let dir: string;
let wb: Workbench;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recover-"));
  wb = Workbench.open(dir);
});
afterEach(() => {
  try { wb.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const issue = (query: string): EntryInput => ({
  type: "query.issued", actor: agent,
  payload: { query, source: "src", source_hash: "h", pivot: null, pivot_hash: null, connector: "c", text: "select 1", bound: {}, window: { from: null, to: null }, why: "w", estimate: null, step: null, verifies: null, purpose: "result" },
});
const startRun = (run: string): EntryInput => ({ type: "run.started", actor: human, payload: { run, pipeline: "p", pipeline_hash: "h", stages } });

/** Commits through `build`, closes the workbench, reopens the case as a new process would. */
function reopen(build: (s: CaseSession) => void): CaseSession {
  const s = wb.createCase(newCase, human);
  build(s);
  wb.close();
  wb = Workbench.open(dir);
  return wb.session("CASE-1");
}

test("a query left running is closed as failed: interrupted", () => {
  const s = reopen((c) => c.commit((_st, ids) => [issue(ids.next("query"))]));
  expect(s.state.queries.q1!.status).toBe("running");
  const r = recoverSession(s);
  expect(r).toEqual({ queries: ["q1"], jobs: [], asks: [], interrupted: false });
  expect(s.state.queries.q1).toMatchObject({ status: "failed", error: "interrupted" });
  expect(s.entries().at(-1)!.cause).toBe(s.state.queries.q1!.issued_seq);
  expect(s.entries().at(-1)!.actor).toEqual({ kind: "system", id: "recovery" });
  expect(s.state.skipped).toEqual([]);
});

test("a running job is finished as failed and a running run is marked interrupted", () => {
  const s = reopen((c) => {
    c.commit((_st, ids) => [startRun(ids.next("run"))]);
    c.commit((_st, ids) => [{ type: "job.started", actor: human, payload: { job: ids.next("job"), title: "t", kind: "research", source: null } }]);
  });
  const before = s.head().seq;
  const r = recoverSession(s);
  expect(r).toEqual({ queries: [], jobs: ["j1"], asks: [], interrupted: true });
  expect(s.state.jobs.j1!.status).toBe("failed");
  expect(s.state.run.status).toBe("interrupted");
  expect(s.head().seq).toBe(before + 2);
  expect(s.state.skipped).toEqual([]);
});

test("a waiting or paused run is left as it is", () => {
  const s = reopen((c) => {
    c.commit((_st, ids) => [startRun(ids.next("run")), { type: "gate.waiting", actor: human, payload: { gate: "plan" } }]);
  });
  const before = s.head().seq;
  expect(s.state.run.status).toBe("waiting");
  expect(recoverSession(s)).toEqual({ queries: [], jobs: [], asks: [], interrupted: false });
  expect(s.head().seq).toBe(before);

  s.commit(() => [{ type: "run.paused", actor: human, payload: { reason: "cap" } }]);
  const paused = s.head().seq;
  expect(recoverSession(s).interrupted).toBe(false);
  expect(s.head().seq).toBe(paused);
  expect(s.state.run.status).toBe("paused");
});

test("recovering twice writes nothing the second time", () => {
  const s = reopen((c) => {
    c.commit((_st, ids) => [startRun(ids.next("run"))]);
    c.commit((_st, ids) => [issue(ids.next("query")), { type: "job.started", actor: human, payload: { job: ids.next("job"), title: "t", kind: "query", source: "src" } }]);
  });
  recoverSession(s);
  const head = s.head();
  expect(recoverSession(s)).toEqual({ queries: [], jobs: [], asks: [], interrupted: false });
  expect(s.head()).toEqual(head);
});

test("the case still verifies after recovery", () => {
  const s = reopen((c) => {
    c.commit((_st, ids) => [startRun(ids.next("run"))]);
    c.commit((_st, ids) => [issue(ids.next("query")), issue(ids.next("query"))]);
  });
  expect(recoverSession(s).queries).toEqual(["q1", "q2"]);
  expect(s.state.skipped).toEqual([]);
  wb.close();
  expect(verifyCase(join(dir, "cases", "CASE-1")).ok).toBe(true);
});

test("a question left without an answer or an end is closed as interrupted, and one that was answered is left alone", () => {
  const asked = (turn: string, text: string): EntryInput => ({ type: "agent.asked", actor: human, payload: { turn, text, left_out: [], added: [] } });
  const s = reopen((c) => {
    c.commit((_st, ids) => [asked(ids.next("turn"), "one")]);
    c.commit((_st, ids) => [asked(ids.next("turn"), "two")]);
    c.commit(() => [{ type: "agent.answered", actor: agent, payload: { turn: "u2", request: "r1", text: "t", cites: [] } }]);
    c.commit((_st, ids) => [asked(ids.next("turn"), "three")]);
    c.commit((state) => [{ type: "agent.ended", actor: agent, payload: { asked: state.conversation[2]!.asked_seq, reason: "boom" } }]);
    c.commit((_st, ids) => [asked(ids.next("turn"), "four")]);
  });
  const r = recoverSession(s);
  expect(r.asks).toEqual(["u1", "u4"]);
  expect(s.state.conversation.map((t) => t.ended)).toEqual(["interrupted", null, "boom", "interrupted"]);
  const ended = s.entries().filter((e) => e.type === "agent.ended").at(-1)!;
  expect(ended.actor).toEqual({ kind: "system", id: "recovery" });
  expect(recoverSession(s).asks).toEqual([]);
  expect(s.state.skipped).toEqual([]);
});
