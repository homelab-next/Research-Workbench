import { expect, test } from "bun:test";
import { blockers, fold, publishable } from "../../src/core/state";
import type { Draft, Product, StageDef } from "../../src/core/types";
import { EntryBuilder } from "../helpers/entries";

const stages: StageDef[] = [
  { id: "plan", title: "Plan", phase: "plan", runs: "agent", gate: "plan", reviews: false, model: null },
  { id: "checks", title: "Checks", phase: "review", runs: "script", gate: null, reviews: true, model: null },
  { id: "evaluate", title: "Evaluate", phase: "review", runs: "agent", gate: null, reviews: true, model: null },
  { id: "challenge", title: "Challenge", phase: "review", runs: "agent", gate: null, reviews: true, model: null },
];
const product: Product = {
  objective: "o", question: "q", marking: "TLP:AMBER", summary: "s", key_findings: [], gaps_and_limits: "", alternatives: "",
  assessment: "", sources: [], assumptions: [], change: "",
};
const draft = (n: number, hash: string): Draft => ({ n, hash, author: { kind: "system", id: "test" }, product, reason: "r" });
const REVIEW = ["checks", "evaluate", "challenge"];

function withDraft(): EntryBuilder {
  const b = new EntryBuilder();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  b.add("draft.revised", { draft: draft(1, "h1") });
  return b;
}
const finish = (b: EntryBuilder, stage: string, outcome: "pass" | "fail" = "pass") =>
  b.add("stage.finished", { stage, attempt: 1, outcome, draft_hash: "h1", output: null, reason: null });

// ---------- finding 10: both reducers accept the same stage.finished entries ----------
test("a pass after the run has finished counts for neither the stage strip nor publishing", () => {
  const b = withDraft();
  for (const id of REVIEW) b.add("stage.started", { stage: id, attempt: 1 });
  b.add("run.finished", { outcome: "stopped" });
  for (const id of REVIEW) finish(b, id);
  const s = fold(b.entries);
  expect(s.run.stages.filter((st) => st.reviews).map((st) => st.status)).toEqual(["running", "running", "running"]);
  expect(s.reviews.h1!.passed_stages).toEqual([]);
  expect(publishable(s, "h1")).toBe(false);
});

test("a pass with no reason field counts for neither, and is recorded as malformed", () => {
  const b = withDraft();
  for (const id of REVIEW) b.add("stage.started", { stage: id, attempt: 1 });
  for (const id of REVIEW) b.add("stage.finished", { stage: id, attempt: 1, outcome: "pass", draft_hash: "h1", output: null } as never);
  const s = fold(b.entries);
  expect(s.run.stages.filter((st) => st.reviews).map((st) => st.status)).toEqual(["running", "running", "running"]);
  expect(publishable(s, "h1")).toBe(false);
  expect(s.skipped.map((x) => x.reason)).toEqual(["malformed stage.finished", "malformed stage.finished", "malformed stage.finished"]);
});

test("a pass for a stage that is not in the run is not recorded against the draft", () => {
  const b = withDraft();
  finish(b, "ghost");
  expect(fold(b.entries).reviews.h1!.passed_stages).toEqual([]);
});

test("a pass before any run.started is not recorded", () => {
  const b = new EntryBuilder();
  b.add("draft.revised", { draft: draft(1, "h1") });
  finish(b, "checks");
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  expect(fold(b.entries).reviews.h1!.passed_stages).toEqual([]);
});

test("where the stage strip shows passed, the draft has passed that stage, and the other way round", () => {
  const b = withDraft();
  finish(b, "checks");
  finish(b, "evaluate");
  finish(b, "evaluate", "fail");
  b.add("run.finished", { outcome: "stopped" });
  finish(b, "challenge");
  const s = fold(b.entries);
  const strip = s.run.stages.filter((st) => st.status === "passed" && st.reviews).map((st) => st.id);
  expect(strip).toEqual(s.reviews.h1!.passed_stages);
  expect(strip).toEqual(["checks"]);
  expect(blockers(s, "h1")).toEqual(["Evaluate has not passed this revision", "Challenge has not passed this revision"]);
});

// ---------- finding 11: a pause survives a gate ----------
test("a run paused before a gate stays paused through gate.waiting and gate.passed", () => {
  const b = new EntryBuilder();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  b.add("stage.started", { stage: "plan", attempt: 1 });
  b.add("run.paused", { reason: "lunch" });
  b.add("gate.waiting", { gate: "plan" });
  let s = fold(b.entries);
  expect(s.run).toMatchObject({ status: "paused", waiting: "plan", pause_reason: "lunch" });
  expect(s.run.stages[0]!.status).toBe("waiting");
  b.add("gate.passed", { gate: "plan" });
  s = fold(b.entries);
  expect(s.run).toMatchObject({ status: "paused", waiting: null, pause_reason: "lunch" });
  expect(s.run.stages[0]!.status).toBe("passed");
  b.add("run.resumed", {});
  expect(fold(b.entries).run).toMatchObject({ status: "running", waiting: null, pause_reason: null });
});

test("a run paused while waiting at a gate resumes to waiting", () => {
  const b = new EntryBuilder();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages });
  b.add("gate.waiting", { gate: "plan" });
  b.add("run.paused", { reason: "r" });
  b.add("run.resumed", {});
  expect(fold(b.entries).run).toMatchObject({ status: "waiting", waiting: "plan" });
});
