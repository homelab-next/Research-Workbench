// Slice 14, Task 1: known answers, the improve case's record and the probe child's mark, as the fold reads them.
import { expect, test } from "bun:test";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { fold } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import {
  adoptOffer, initialImprove, plannedProbes, PROBE_ACTOR_ID, PROBE_OUTPUT_FORMAT, probeOutputOf, readAnswers, readContrasts, readProbeOutput, readScoreSheet, readTaskInputs,
  readTaskRecord, stagedCandidates,
} from "../../src/core/state/improve";
import type { Actor, Draft, Entry, ExpectedFinding, Marking, Payloads, Plan, Product, StageDef } from "../../src/core/types";
import { card, EntryBuilder } from "../helpers/entries";

const human: Actor = { kind: "human", id: "analyst" };
const engine: Actor = { kind: "system", id: "engine" };
const assembler: Actor = { kind: "agent", id: "assemble", stage: "assemble", profile: "default", model: "scripted-m", effort: null, where: "machine" };
const blob = (c: string) => ({ blob: c.repeat(64), bytes: 10 });

const created = (id: string, marking: Marking): Payloads["case.created"] => ({
  id, title: `Case ${id}`, asked: "Is 192.0.2.10 beaconing?", why: "alert", starting: [{ type: "ip", value: "192.0.2.10" }],
  window: { from: null, to: null }, objective: null, marking,
});
const investigation: StageDef[] = [
  { id: "plan", title: "Plan", phase: "direct", runs: "agent", gate: "plan", reviews: false, model: null },
  { id: "assemble", title: "Assemble", phase: "produce", runs: "agent", gate: null, reviews: false, model: null },
  { id: "checks", title: "Checks", phase: "review", runs: "script", gate: null, reviews: true, model: null },
  { id: "publish", title: "Publish", phase: "publish", runs: "human", gate: "publish", reviews: false, model: null },
];
const productOf = (marking: Marking, summary = "Regular connections every 60 s."): Product => ({
  objective: "Decide", question: "Is 192.0.2.10 beaconing?", marking, summary,
  key_findings: [{ id: "f1", statement: "192.0.2.10 connects to 198.51.100.7 every 60 s", likelihood: "likely", confidence: "moderate", confidence_basis: "one source", cites: ["c1"], assumptions: [], reasoning: "periodic" }],
  gaps_and_limits: "", alternatives: "", assessment: "Likely beaconing.", sources: [], assumptions: [], change: "",
});
const draftOf = (n: number, product: Product): Draft => ({ n, hash: sha256Hex(canonical(product as never)), author: assembler, product, reason: "first" });
const findings: ExpectedFinding[] = [{ claim: "the host beacons to the remote address each minute", likelihood: "likely", confidence: "moderate" }];
const answer = (draft_hash: string, over: Partial<Payloads["answer.known"]> = {}): Payloads["answer.known"] => ({
  product: 1, draft_hash, text: "It was beaconing.", findings, marking: "TLP:AMBER", ...over,
});

/** An investigated case: made, run, drafted and published (product 1), marked GREEN with an AMBER product. */
function investigated(caseMarking: Marking = "TLP:GREEN", productMarking: Marking = "TLP:AMBER"): { b: EntryBuilder; draft: Draft } {
  const b = new EntryBuilder("CASE-4");
  const draft = draftOf(1, productOf(productMarking));
  b.add("case.created", created("CASE-4", caseMarking), { actor: human });
  b.add("run.started", { run: "run-1", pipeline: "investigation", pipeline_hash: "a".repeat(64), stages: investigation }, { actor: engine });
  b.add("draft.revised", { draft }, { actor: assembler });
  b.add("product.published", { n: 1, draft_hash: draft.hash, head_hash: "b".repeat(64), dir: "products/1", bundle: blob("c") }, { actor: human });
  b.add("run.finished", { outcome: "published" }, { actor: engine });
  return { b, draft };
}
const reasons = (s: CaseState) => s.skipped.map((x) => x.reason);

// ---------- known answers and the request ----------

test("a ledger with none of the new entries has no answers and an empty improve", () => {
  const s = fold(investigated().b.entries);
  expect(s.answers).toEqual({});
  expect(s.improve).toEqual(initialImprove());
  expect(s.skipped).toEqual([]);
});

test("answer.known by a person on a published product is that product's known answer, with its seq, hash and time", () => {
  const { b, draft } = investigated();
  const e = b.add("answer.known", answer(draft.hash), { actor: human });
  const s = fold(b.entries);
  expect(s.skipped).toEqual([]);
  expect(s.answers).toEqual({
    "1": { product: 1, draft_hash: draft.hash, text: "It was beaconing.", findings, marking: "TLP:AMBER", by: "analyst", seq: e.seq, hash: e.hash, ts: e.ts },
  });
  // the state shares nothing with the payload
  expect(s.answers["1"]!.findings).not.toBe((e.payload as Payloads["answer.known"]).findings);
});

test("a second answer.known for the product replaces the first; answer.withdrawn removes it", () => {
  const { b, draft } = investigated();
  b.add("answer.known", answer(draft.hash), { actor: human });
  const second = b.add("answer.known", answer(draft.hash, { text: "It was a health check.", findings: [], marking: "TLP:RED" }), { actor: human });
  let s = fold(b.entries);
  expect(s.answers["1"]).toMatchObject({ text: "It was a health check.", findings: [], marking: "TLP:RED", seq: second.seq });
  b.add("answer.withdrawn", { product: 1, reason: "the answer was wrong" }, { actor: human });
  s = fold(b.entries);
  expect(s.answers).toEqual({});
  expect(s.skipped).toEqual([]);
  b.add("answer.withdrawn", { product: 1, reason: "again" }, { actor: human });
  expect(reasons(fold(b.entries))).toEqual(["there is no known answer for that product"]);
});

test("answer.known by an agent or by code, for a product not published, for another draft hash, or marked below the product, is skipped with its sentence", () => {
  const { b, draft } = investigated();
  b.add("answer.known", answer(draft.hash), { actor: assembler });
  b.add("answer.known", answer(draft.hash), { actor: engine });
  b.add("answer.known", answer(draft.hash, { product: 2 }), { actor: human });
  b.add("answer.known", answer("d".repeat(64)), { actor: human });
  b.add("answer.known", answer(draft.hash, { marking: "TLP:GREEN" }), { actor: human });
  b.add("answer.withdrawn", { product: 1, reason: "x" }, { actor: assembler });
  const s = fold(b.entries);
  expect(s.answers).toEqual({});
  expect(reasons(s)).toEqual([
    "a known answer is a person's", "a known answer is a person's",
    "a known answer names a product this case published", "a known answer names a product this case published",
    "a known answer is marked at least as strictly as its case and its product",
    "a known answer is a person's",
  ]);
  // marked below the case (the product is GREEN, the case AMBER)
  const c = investigated("TLP:AMBER", "TLP:GREEN");
  c.b.add("answer.known", answer(c.draft.hash, { marking: "TLP:GREEN" }), { actor: human });
  expect(reasons(fold(c.b.entries))).toEqual(["a known answer is marked at least as strictly as its case and its product"]);
});

test("a malformed answer.known is recorded as malformed", () => {
  // text "" · text of 601 characters · 13 findings · a claim of 301 characters · confidence "certain" · product 0 · marking "TLP:PINK"
  const { b, draft } = investigated();
  const f = findings[0]!;
  const bad: unknown[] = [
    answer(draft.hash, { text: "" }),
    answer(draft.hash, { text: "x".repeat(601) }),
    answer(draft.hash, { findings: Array.from({ length: 13 }, () => f) }),
    answer(draft.hash, { findings: [{ ...f, claim: "x".repeat(301) }] }),
    answer(draft.hash, { findings: [{ ...f, confidence: "certain" as never }] }),
    answer(draft.hash, { product: 0 }),
    answer(draft.hash, { marking: "TLP:PINK" as never }),
  ];
  for (const p of bad) b.add("answer.known", p as Payloads["answer.known"], { actor: human });
  const s = fold(b.entries);
  expect(s.answers).toEqual({});
  expect(reasons(s)).toEqual(bad.map(() => "malformed answer.known"));
  // at the limits it is read
  const ok = investigated();
  ok.b.add("answer.known", answer(ok.draft.hash, { text: "x".repeat(600), findings: Array.from({ length: 12 }, () => ({ ...f, claim: "y".repeat(300) })) }), { actor: human });
  expect(fold(ok.b.entries).skipped).toEqual([]);
});

/** An improve case's first commit: case.created and improve.requested, by the person. */
function improveCase(marking: Marking = "TLP:AMBER"): EntryBuilder {
  const b = new EntryBuilder("CASE-7");
  b.add("case.created", { ...created("CASE-7", marking), starting: [], loop: "improve" }, { actor: human });
  b.add("improve.requested", { target: "investigation", case_type: "beaconing", tasks: 2, candidates: 2 }, { actor: human });
  return b;
}

test("improve.requested by the person in the first commit is the request; later, by code, or a second one is skipped", () => {
  const b = improveCase();
  const s = fold(b.entries);
  expect(s.skipped).toEqual([]);
  expect(s.improve).toEqual({ ...initialImprove(), request: { target: "investigation", case_type: "beaconing", tasks: 2, candidates: 2, by: "analyst" } });
  // a second one
  b.add("improve.requested", { target: "other", case_type: "beaconing", tasks: 1, candidates: 1 }, { actor: human });
  expect(reasons(fold(b.entries))).toEqual(["an improve case is asked for by the person when it is made"]);
  // by code
  const c = new EntryBuilder("CASE-8");
  c.add("case.created", created("CASE-8", "TLP:AMBER"), { actor: human });
  c.add("improve.requested", { target: "investigation", case_type: "beaconing", tasks: 2, candidates: 2 }, { actor: engine });
  expect(fold(c.entries).improve.request).toBeNull();
  // later: after a run started, or past the first commit
  const d = investigated().b;
  d.add("improve.requested", { target: "investigation", case_type: "beaconing", tasks: 2, candidates: 2 }, { actor: human });
  const ds = fold(d.entries);
  expect(ds.improve.request).toBeNull();
  expect(reasons(ds)).toEqual(["an improve case is asked for by the person when it is made"]);
  // a known answer in an improve case is skipped
  const e = improveCase();
  e.add("answer.known", answer("d".repeat(64)), { actor: human });
  expect(reasons(fold(e.entries))).toEqual(["a known answer belongs to a case that was investigated"]);
  // malformed: no tasks, too many candidates
  for (const p of [{ target: "investigation", case_type: "beaconing", tasks: 0, candidates: 1 }, { target: "investigation", case_type: "beaconing", tasks: 1, candidates: 5 }, { target: "", case_type: "beaconing", tasks: 1, candidates: 1 }]) {
    const m = new EntryBuilder("CASE-9");
    m.add("case.created", created("CASE-9", "TLP:AMBER"), { actor: human });
    m.add("improve.requested", p, { actor: human });
    expect(reasons(fold(m.entries))).toEqual(["malformed improve.requested"]);
  }
});


// ---------- the run of an improve case ----------

const proposer: Actor = { kind: "agent", id: "propose", stage: "propose", profile: "improver", model: "scripted-m", effort: null, where: "machine" };
const composer: Actor = { kind: "agent", id: "compose", stage: "compose", profile: "improver", model: "scripted-m", effort: null, where: "machine" };
const improveStages: StageDef[] = [
  { id: "select", title: "Select", phase: null, runs: "script", gate: null, reviews: false, model: null },
  { id: "propose", title: "Propose", phase: null, runs: "agent", gate: null, reviews: false, model: null },
  { id: "probe", title: "Probe", phase: null, runs: "script", gate: null, reviews: false, model: null },
  { id: "compose", title: "Compose", phase: null, runs: "agent", gate: null, reviews: false, model: null },
  { id: "judge", title: "Judge", phase: null, runs: "script", gate: null, reviews: false, model: null },
  { id: "reflect", title: "Reflect", phase: null, runs: "agent", gate: null, reviews: false, model: null },
  { id: "adopt", title: "Adopt", phase: null, runs: "human", gate: "adopt", reviews: false, model: null },
];
const selected = (over: Partial<Payloads["improve.selected"]> = {}): Payloads["improve.selected"] => ({
  target: "investigation", version: 3, loop_hash: "e".repeat(64), lock: blob("1"), case_type: "beaconing", scale: ["unlikely", "even chance", "likely"],
  left_out: [{ case: "CASE-2", why: "marking" }], ...over,
});
const task = (t: string, c: string): Payloads["improve.task"] => ({
  task: t, case: c, origin: "f".repeat(64), head: { seq: 9, hash: "9".repeat(64) }, product: { n: 1, draft_hash: "d".repeat(64) },
  answer: { seq: 8, hash: "8".repeat(64) }, marking: "TLP:AMBER", inputs: blob("2"), record: blob("3"),
});
const proposed = (change: string): Payloads["builder.proposed"] => ({
  change, title: `Change ${change}`, why: "fewer misses", root: "sample",
  files: [{ path: "skills/assemble.md", kind: "skill", id: "assemble", before: "4".repeat(64), after: "5".repeat(64) }, { path: "skills/plan.md", kind: "skill", id: "plan", before: "6".repeat(64), after: "7".repeat(64) }],
  bundle: blob("4"),
});
const staged = (k: string, change: string): Payloads["improve.candidate"] => ({ candidate: k, change, status: "staged", loop_hash: "a1".repeat(32), lock: blob("5"), reason: "" });
const dropped = (k: string, change: string): Payloads["improve.candidate"] => ({ candidate: k, change, status: "dropped", loop_hash: null, lock: null, reason: "its hash is the base's" });
const started = (candidate: string, t: string, child: string): Payloads["probe.started"] => ({
  probe: `${candidate}/${t}`, candidate, task: t, child, origin: "0a".repeat(32), loop_hash: "e".repeat(64), input_hash: "0b".repeat(32), budgets: { lookups: 60, tokens: 300000 },
});
const finished = (probe: string, child: string, outcome: "drafted" | "incomplete" = "drafted"): Payloads["probe.finished"] => ({
  probe, child, child_run: "run-1", head: { seq: 30, hash: "0c".repeat(32) }, outcome, reason: outcome === "drafted" ? "" : "it waits for a person at its plan gate",
  draft_hash: outcome === "drafted" ? "0d".repeat(32) : null, output_hash: "0e".repeat(32), output: blob("6"), lookups: 4, tokens: 1200,
});
const chosen = (candidate: string | null): Payloads["compose.chosen"] => ({ candidate, why: "fewer misses", contrasts: blob("7") });
const scored = (): Payloads["judge.scored"] => ({
  answers: blob("8"), scores: blob("9"), matcher: "code",
  summary: [{ candidate: "base", score: 333, drafted: 2, tasks: 2 }, { candidate: "K1", score: 1000, drafted: 2, tasks: 2 }],
});

/** An improve case's run up to its probes: two tasks, K1 staged and K2 dropped. */
function improveRun(run = "run-1"): EntryBuilder {
  const b = improveCase();
  b.add("run.started", { run, pipeline: "improve", pipeline_hash: "a".repeat(64), stages: improveStages }, { actor: engine });
  b.add("improve.selected", selected(), { actor: engine });
  b.add("improve.task", task("T1", "CASE-4"), { actor: engine });
  b.add("improve.task", task("T2", "CASE-5"), { actor: engine });
  b.add("builder.proposed", proposed("chg-1"), { actor: proposer });
  b.add("builder.proposed", proposed("chg-2"), { actor: proposer });
  b.add("improve.candidate", staged("K1", "chg-1"), { actor: engine });
  b.add("improve.candidate", dropped("K2", "chg-2"), { actor: engine });
  return b;
}
/** Every planned probe started and finished. */
function probed(b: EntryBuilder): EntryBuilder {
  let n = 10;
  for (const [c, t] of [["base", "T1"], ["base", "T2"], ["K1", "T1"], ["K1", "T2"]] as const) {
    const child = `CASE-${n++}`;
    b.add("probe.started", started(c, t, child), { actor: engine });
    b.add("probe.finished", finished(`${c}/${t}`, child), { actor: engine });
  }
  return b;
}

test("improve.selected and its tasks, then candidates, then probes, fold in order with the ids T1, K1 and base/T1", () => {
  const b = improveRun();
  b.add("probe.started", started("base", "T1", "CASE-10"), { actor: engine });
  const fin = b.add("probe.finished", finished("base/T1", "CASE-10"), { actor: engine });
  const s = fold(b.entries);
  expect(s.skipped).toEqual([]);
  const i = s.improve;
  expect(i.selected).toEqual({ ...selected(), run: "run-1", seq: 4 });
  expect(i.task_order).toEqual(["T1", "T2"]);
  expect(i.tasks.T1).toEqual(task("T1", "CASE-4"));
  expect(i.candidate_order).toEqual(["K1", "K2"]);
  expect(i.candidates.K1).toEqual({ ...staged("K1", "chg-1"), seq: 9 });
  expect(i.candidates.K2).toMatchObject({ status: "dropped", lock: null, loop_hash: null });
  expect(i.probe_order).toEqual(["base/T1"]);
  const { probe: _p, child: _c, ...rest } = finished("base/T1", "CASE-10");
  expect(i.probes["base/T1"]).toEqual({ ...started("base", "T1", "CASE-10"), started_seq: 11, finished: { ...rest, seq: fin.seq } });
  expect(stagedCandidates(s).map((c) => c.candidate)).toEqual(["K1"]);
  // out of order, or by a person or an agent, is skipped
  const bad = improveRun();
  bad.add("improve.task", task("T4", "CASE-6"), { actor: engine });
  bad.add("improve.task", task("T3", "CASE-6"), { actor: human });
  bad.add("improve.candidate", staged("K4", "chg-1"), { actor: engine });
  bad.add("improve.candidate", staged("K3", "chg-9"), { actor: engine });
  bad.add("improve.candidate", { ...staged("K3", "chg-1"), lock: null }, { actor: engine });
  bad.add("probe.started", started("K2", "T1", "CASE-10"), { actor: engine });
  bad.add("probe.finished", finished("base/T1", "CASE-10"), { actor: engine });
  bad.add("improve.selected", selected(), { actor: engine });
  const bs = fold(bad.entries);
  expect(reasons(bs)).toEqual([
    "an improve case's tasks are numbered in order after its run's selection",
    "recorded by the workbench",
    "an improve case's candidates are numbered in order, each naming a change proposed in it",
    "an improve case's candidates are numbered in order, each naming a change proposed in it",
    "malformed improve.candidate",
    "a probe starts once, for a planned probe of the run",
    "a probe finishes once, as the child it started",
    "a run selects its tasks once",
  ]);
  expect(bs.improve).toEqual(fold(improveRun().entries).improve);
  // outside a run, or in a case with no request
  const none = improveCase();
  none.add("improve.selected", selected(), { actor: engine });
  const other = investigated().b;
  other.add("run.started", { run: "run-2", pipeline: "investigation", pipeline_hash: "a".repeat(64), stages: investigation }, { actor: engine });
  other.add("improve.selected", selected(), { actor: engine });
  expect(reasons(fold(none.entries))).toEqual(["recorded in the run in progress of an improve case"]);
  expect(reasons(fold(other.entries))).toEqual(["recorded in the run in progress of an improve case"]);
});

test("plannedProbes is base and each staged candidate for each task; a dropped candidate has none", () => {
  const s = fold(improveRun().entries);
  expect(plannedProbes(s).map((p) => p.probe)).toEqual(["base/T1", "base/T2", "K1/T1", "K1/T2"]);
  expect(plannedProbes(s)[2]).toEqual({ probe: "K1/T1", candidate: "K1", task: "T1" });
  expect(plannedProbes(fold(improveCase().entries))).toEqual([]);
});

test("compose.chosen before every planned probe has finished is skipped; after, it is the choice", () => {
  const b = improveRun();
  b.add("probe.started", started("base", "T1", "CASE-10"), { actor: engine });
  b.add("compose.chosen", chosen("K1"), { actor: composer });
  let s = fold(b.entries);
  expect(s.improve.chosen).toBeNull();
  expect(reasons(s)).toEqual(["Compose chooses once every probe has ended"]);
  const c = probed(improveRun());
  const e = c.add("compose.chosen", chosen("K1"), { actor: composer });
  s = fold(c.entries);
  expect(s.skipped).toEqual([]);
  expect(s.improve.chosen).toEqual({ ...chosen("K1"), by: "compose", seq: e.seq });
  // the engine records none when nothing was staged
  const d = probed(improveRun());
  d.add("compose.chosen", chosen(null), { actor: engine });
  expect(fold(d.entries).improve.chosen).toMatchObject({ candidate: null, by: "engine" });
});

test("compose.chosen by a person, naming a dropped candidate, or a second one, is skipped", () => {
  const b = probed(improveRun());
  b.add("compose.chosen", chosen("K1"), { actor: human });
  b.add("compose.chosen", chosen("K2"), { actor: composer });
  b.add("compose.chosen", chosen("K9"), { actor: composer });
  b.add("compose.chosen", chosen("K1"), { actor: composer });
  b.add("compose.chosen", chosen(null), { actor: composer });
  const s = fold(b.entries);
  expect(s.improve.chosen).toMatchObject({ candidate: "K1", by: "compose" });
  expect(reasons(s)).toEqual([
    "Compose chooses; the person decides at Adopt",
    "Compose chooses a staged candidate or none",
    "Compose chooses a staged candidate or none",
    "Compose chooses once in a run",
  ]);
});

test("judge.scored before compose.chosen is skipped: the judge runs after Compose has chosen", () => {
  const b = probed(improveRun());
  b.add("judge.scored", scored(), { actor: engine });
  let s = fold(b.entries);
  expect(s.improve.scored).toBeNull();
  expect(reasons(s)).toEqual(["the judge runs after Compose has chosen"]);
  b.add("compose.chosen", chosen("K1"), { actor: composer });
  const e = b.add("judge.scored", scored(), { actor: engine });
  b.add("judge.scored", scored(), { actor: engine });
  b.add("judge.scored", scored(), { actor: composer });
  s = fold(b.entries);
  expect(s.improve.scored).toEqual({ ...scored(), seq: e.seq });
  expect(reasons(s)).toEqual(["the judge runs after Compose has chosen", "the judge scores once in a run", "recorded by the workbench"]);
  // a score out of range is malformed
  const m = probed(improveRun());
  m.add("compose.chosen", chosen("K1"), { actor: composer });
  m.add("judge.scored", { ...scored(), summary: [{ candidate: "base", score: 1001, drafted: 0, tasks: 2 }] }, { actor: engine });
  expect(reasons(fold(m.entries))).toEqual(["malformed judge.scored"]);
});

test("a second run's improve.selected clears the first run's tasks, candidates, probes, choice and scores, and keeps the request", () => {
  const b = probed(improveRun());
  b.add("compose.chosen", chosen("K1"), { actor: composer });
  b.add("judge.scored", scored(), { actor: engine });
  b.add("run.finished", { outcome: "completed" }, { actor: engine });
  b.add("run.started", { run: "run-2", pipeline: "improve", pipeline_hash: "a".repeat(64), stages: improveStages }, { actor: engine });
  // run.started clears nothing here
  expect(fold(b.entries).improve.scored).not.toBeNull();
  const e = b.add("improve.selected", selected({ version: 4 }), { actor: engine });
  const s = fold(b.entries);
  expect(s.skipped).toEqual([]);
  expect(s.improve).toEqual({ ...initialImprove(), request: fold(improveCase().entries).improve.request, selected: { ...selected({ version: 4 }), run: "run-2", seq: e.seq } });
  // the second run numbers from T1 and K1 again; the builder's changes stay
  b.add("improve.task", task("T1", "CASE-4"), { actor: engine });
  b.add("improve.candidate", staged("K1", "chg-2"), { actor: engine });
  expect(fold(b.entries).skipped).toEqual([]);
});

test("adoptOffer is the chosen candidate's change with its undecided files, and null when nothing was chosen", () => {
  const b = probed(improveRun());
  expect(adoptOffer(fold(b.entries))).toBeNull();
  b.add("compose.chosen", chosen("K1"), { actor: composer });
  expect(adoptOffer(fold(b.entries))).toEqual({ candidate: "K1", change: "chg-1", undecided: 2 });
  b.add("builder.decided", { change: "chg-1", file: 0, accepted: true, written: "5".repeat(64) }, { actor: human });
  expect(adoptOffer(fold(b.entries))).toEqual({ candidate: "K1", change: "chg-1", undecided: 1 });
  const n = probed(improveRun());
  n.add("compose.chosen", chosen(null), { actor: composer });
  expect(adoptOffer(fold(n.entries))).toBeNull();
});

test("gate.waiting and gate.passed with gate adopt make the Adopt stage wait and pass; gate.passed adopt by code is skipped: only a person passes the adopt gate", () => {
  const b = probed(improveRun());
  b.add("compose.chosen", chosen("K1"), { actor: composer });
  b.add("stage.started", { stage: "adopt", attempt: 1 }, { actor: engine });
  b.add("gate.waiting", { gate: "adopt" }, { actor: engine });
  let s = fold(b.entries);
  expect(s.run).toMatchObject({ status: "waiting", waiting: "adopt" });
  expect(s.run.stages.find((x) => x.id === "adopt")!.status).toBe("waiting");
  const before = s;
  const e = b.add("gate.passed", { gate: "adopt" }, { actor: engine });
  b.add("gate.passed", { gate: "adopt" }, { actor: composer });
  s = fold(b.entries);
  expect(reasons(s)).toEqual(["only a person passes the adopt gate", "only a person passes the adopt gate"]);
  expect({ ...s, seq: before.seq, head_ts: before.head_ts, skipped: before.skipped }).toEqual(before);
  expect(e.seq).toBe(s.seq - 1);
  b.add("gate.passed", { gate: "adopt" }, { actor: human });
  s = fold(b.entries);
  expect(s.run).toMatchObject({ status: "running", waiting: null });
  expect(s.run.stages.find((x) => x.id === "adopt")!.status).toBe("passed");
});

test("none of the eleven entries changes the run, the cards, the plan, the loop, the memory or the meta", () => {
  const b = probed(improveRun());
  b.add("compose.chosen", chosen("K1"), { actor: composer });
  b.add("judge.scored", scored(), { actor: engine });
  const t = investigated();
  t.b.add("answer.known", answer(t.draft.hash), { actor: human });
  t.b.add("answer.withdrawn", { product: 1, reason: "wrong" }, { actor: human });
  for (const entries of [b.entries, t.b.entries]) {
    let prev = fold([]);
    for (const e of entries) {
      const next = fold(entries, e.seq);
      if (NEW_TYPES.includes(e.type)) {
        expect(next.skipped, `${e.seq} ${e.type}`).toEqual(prev.skipped);
        for (const k of ["run", "cards", "plan", "loop", "memory", "meta", "counters", "builder", "drafts", "published", "lanes"] as const) expect(next[k], `${e.seq} ${e.type} ${k}`).toEqual(prev[k]);
      }
      prev = next;
    }
  }
});

const NEW_TYPES: string[] = [
  "answer.known", "answer.withdrawn", "improve.requested", "improve.selected", "improve.task", "improve.candidate", "probe.child", "probe.started", "probe.finished", "compose.chosen", "judge.scored",
];

// ---------- the probe child, the veto, and what a probe gives ----------

const probeActor: Actor = { kind: "system", id: PROBE_ACTOR_ID };
const planner: Actor = { kind: "agent", id: "plan", stage: "plan", profile: "default", model: "scripted-m", effort: null, where: "machine" };
const mark = (over: Partial<Payloads["probe.child"]> = {}): Payloads["probe.child"] => ({
  improve: "CASE-7", origin: "0a".repeat(32), probe: "K1/T2", candidate: "K1", task: "T2", plan_gate: "accept", max_lookups: 60, ...over,
});
const plan: Plan = {
  id: "plan-1", goal: "Establish periodicity", window: { from: null, to: null },
  subgoals: [{ id: "g1", title: "Flows", question: "Are there periodic flows?", steps: ["s1"] }],
  steps: [{
    id: "s1", subgoal: "g1", pivot: "ip", source: "netflow", from: { type: "ip", value: "192.0.2.10" }, to: "flows", window: { from: null, to: null },
    needs_window: true, free: true, weight: 1, estimate: null, empty_means: "not-seen", warnings: [],
  }],
};

/** A probe child's first commit (case.created, subloop.child, probe.child, budget.set) and its run up to the plan gate. */
function probeChild(over: Partial<Payloads["probe.child"]> = {}): EntryBuilder {
  const b = new EntryBuilder("CASE-11");
  b.add("case.created", { ...created("CASE-11", "TLP:AMBER"), loop: "investigation" }, { actor: engine });
  b.add("subloop.child", { parent: "CASE-7", run: "run-1", stage: "probe", attempt: 1, loop: "investigation", input_hash: "0b".repeat(32), depth: 1, floor: "TLP:AMBER" }, { actor: engine });
  b.add("probe.child", mark(over), { actor: engine });
  b.add("budget.set", { tokens: 300000 }, { actor: engine });
  return b;
}
function atPlanGate(b: EntryBuilder): EntryBuilder {
  b.add("run.started", { run: "run-1", pipeline: "investigation", pipeline_hash: "a".repeat(64), stages: investigation }, { actor: engine });
  b.add("stage.started", { stage: "plan", attempt: 1 }, { actor: engine });
  b.add("plan.proposed", { plan }, { actor: planner });
  b.add("stage.finished", { stage: "plan", attempt: 1, outcome: "pass", draft_hash: null, output: null, reason: null }, { actor: engine });
  b.add("gate.waiting", { gate: "plan" }, { actor: engine });
  return b;
}
/** Through the plan gate, as `by`, to a draft waiting at the publish gate. */
function atPublishGate(b: EntryBuilder, by: Actor = probeActor): { b: EntryBuilder; draft: Draft } {
  b.add("plan.accepted", { plan: "plan-1", steps: ["s1"], budgets: {} }, { actor: by });
  b.add("lane.created", { lane: "l1", title: "Flows", subgoal: "g1" }, { actor: by });
  b.add("gate.passed", { gate: "plan" }, { actor: by });
  b.add("stage.started", { stage: "assemble", attempt: 1 }, { actor: engine });
  const draft = draftOf(1, productOf("TLP:AMBER"));
  b.add("draft.revised", { draft }, { actor: assembler });
  b.add("stage.finished", { stage: "assemble", attempt: 1, outcome: "pass", draft_hash: draft.hash, output: null, reason: null }, { actor: engine });
  b.add("stage.started", { stage: "publish", attempt: 1 }, { actor: engine });
  b.add("gate.waiting", { gate: "publish" }, { actor: engine });
  return { b, draft };
}
/** The state after `e`, but for seq, head time and what was skipped, must be the state before it. */
function unchangedBy(entries: Entry[], e: Entry, reason: string): void {
  const before = fold(entries, e.seq - 1);
  const after = fold(entries, e.seq);
  expect(after.skipped.slice(before.skipped.length)).toEqual([{ seq: e.seq, type: e.type, reason }]);
  expect({ ...after, seq: before.seq, head_ts: before.head_ts, skipped: before.skipped }).toEqual(before);
}

test("probe.child in a child's first commit marks it; in a case with no parent, after a run started, or by a person, it is skipped", () => {
  const s = fold(probeChild().entries);
  expect(s.skipped).toEqual([]);
  expect(s.improve).toEqual({ ...initialImprove(), probe_of: mark() });
  expect(s.run.budget_tokens).toBe(300000);
  const MARK = "a probe child is marked by the workbench when it is made";
  // no parent
  const orphan = new EntryBuilder("CASE-12");
  orphan.add("case.created", created("CASE-12", "TLP:AMBER"), { actor: engine });
  orphan.add("probe.child", mark(), { actor: engine });
  expect(reasons(fold(orphan.entries))).toEqual([MARK]);
  // after a run started
  const late = atPlanGate(probeChild());
  late.add("probe.child", mark({ probe: "base/T2", candidate: "base" }), { actor: engine });
  const ls = fold(late.entries);
  expect(reasons(ls)).toEqual([MARK]);
  expect(ls.improve.probe_of).toEqual(mark());
  // by a person, in a child not yet marked
  const byPerson = new EntryBuilder("CASE-13");
  byPerson.add("case.created", created("CASE-13", "TLP:AMBER"), { actor: engine });
  byPerson.add("subloop.child", { parent: "CASE-7", run: "run-1", stage: "probe", attempt: 1, loop: "investigation", input_hash: "0b".repeat(32), depth: 1, floor: "TLP:AMBER" }, { actor: engine });
  byPerson.add("probe.child", mark(), { actor: human });
  expect(reasons(fold(byPerson.entries))).toEqual([MARK]);
  expect(fold(byPerson.entries).improve.probe_of).toBeNull();
  // malformed: another plan gate policy, a probe id that is not its candidate's and task's, no lookups
  for (const bad of [mark({ plan_gate: "person" as never }), mark({ probe: "K2/T2" }), mark({ max_lookups: 0 })]) {
    const m = new EntryBuilder("CASE-14");
    m.add("case.created", created("CASE-14", "TLP:AMBER"), { actor: engine });
    m.add("subloop.child", { parent: "CASE-7", run: "run-1", stage: "probe", attempt: 1, loop: "investigation", input_hash: "0b".repeat(32), depth: 1, floor: "TLP:AMBER" }, { actor: engine });
    m.add("probe.child", bad, { actor: engine });
    expect(reasons(fold(m.entries))).toEqual(["malformed probe.child"]);
  }
  // a known answer in a probe child is skipped
  const { b, draft } = atPublishGate(atPlanGate(probeChild()));
  b.add("answer.known", answer(draft.hash), { actor: human });
  expect(reasons(fold(b.entries))).toEqual(["a known answer belongs to a case that was investigated"]);
});

test("in a probe child, plan.accepted, lane.created and gate.passed plan by improve-probe fold as a person's do", () => {
  const byProbe = atPublishGate(atPlanGate(probeChild()), probeActor).b;
  const byPerson = atPublishGate(atPlanGate(probeChild()), human).b;
  const s = fold(byProbe.entries);
  expect(s.skipped).toEqual([]);
  expect(s.plan).toMatchObject({ status: "accepted", accepted_steps: ["s1"] });
  expect(s.lanes.map((l) => l.id)).toEqual(["l1"]);
  expect(s.run).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(s).toEqual(fold(byPerson.entries));
});

test("in a case that is not a probe child, an entry by improve-probe is skipped and changes nothing: improve-probe acts only in a probe child", () => {
  const ONLY = "improve-probe acts only in a probe child";
  const b = atPlanGate(investigated().b.also((x) => x.add("run.started", { run: "run-2", pipeline: "investigation", pipeline_hash: "a".repeat(64), stages: investigation }, { actor: engine })));
  for (const [type, payload] of [
    ["plan.accepted", { plan: "plan-1", steps: ["s1"], budgets: {} }], ["lane.created", { lane: "l1", title: "Flows", subgoal: "g1" }], ["gate.passed", { gate: "plan" }],
  ] as const) {
    const e = b.add(type, payload as never, { actor: probeActor });
    unchangedBy(b.entries, e, ONLY);
  }
  // nor in an improve case
  const i = probed(improveRun());
  const e = i.add("run.finished", { outcome: "stopped" }, { actor: probeActor });
  unchangedBy(i.entries, e, ONLY);
});

test("in a probe child, improve-probe may not pass the publish gate, approve, answer a question or write a card", () => {
  const ONLY = "improve-probe accepts a probe's plan, resumes an interrupted probe or ends it, and nothing else";
  const { b, draft } = atPublishGate(atPlanGate(probeChild()));
  for (const [type, payload] of [
    ["gate.passed", { gate: "publish" }],
    ["product.published", { n: 1, draft_hash: draft.hash, head_hash: "b".repeat(64), dir: "products/1", bundle: blob("c") }],
    ["question.answered", { question: "ask-1", card: "c1" }],
    ["card.created", { card: card("c1") }],
    ["plan.proposed", { plan: { ...plan, id: "plan-2" } }],
    ["probe.child", mark()],
    ["gate.passed", { gate: "adopt" }],
  ] as const) {
    const e = b.add(type, payload as never, { actor: probeActor });
    unchangedBy(b.entries, e, ONLY);
  }
});

test("run.resumed by improve-probe is read only while the run is interrupted; run.finished by it only as stopped", () => {
  const ONLY = "improve-probe accepts a probe's plan, resumes an interrupted probe or ends it, and nothing else";
  const b = atPublishGate(atPlanGate(probeChild())).b;
  b.add("run.paused", { reason: "a person paused it" }, { actor: human });
  const paused = b.add("run.resumed", {}, { actor: probeActor });
  unchangedBy(b.entries, paused, ONLY);
  expect(fold(b.entries).run.status).toBe("paused");
  b.add("run.resumed", {}, { actor: human });
  b.add("run.interrupted", {}, { actor: engine });
  b.add("run.resumed", {}, { actor: probeActor });
  let s = fold(b.entries);
  expect(s.run.status).toBe("waiting");
  expect(s.skipped).toHaveLength(1);
  for (const outcome of ["published", "completed"] as const) {
    const e = b.add("run.finished", { outcome }, { actor: probeActor });
    unchangedBy(b.entries, e, outcome === "published" ? ONLY : ONLY);
  }
  b.add("run.finished", { outcome: "stopped" }, { actor: probeActor });
  s = fold(b.entries);
  expect(s.run).toMatchObject({ status: "finished", outcome: "stopped" });
});

test("product.published and gate.passed publish by a person in a probe child are skipped: a probe child never publishes", () => {
  const NEVER = "a probe child never publishes";
  const { b, draft } = atPublishGate(atPlanGate(probeChild()));
  const g = b.add("gate.passed", { gate: "publish" }, { actor: human });
  unchangedBy(b.entries, g, NEVER);
  const p = b.add("product.published", { n: 1, draft_hash: draft.hash, head_hash: "b".repeat(64), dir: "products/1", bundle: blob("c") }, { actor: human });
  unchangedBy(b.entries, p, NEVER);
  expect(fold(b.entries).published).toEqual([]);
});

test("probeOutputOf is drafted with the latest draft's product for a child waiting at its publish gate or finished completed, and incomplete with the reason for any other", () => {
  const { b, draft } = atPublishGate(atPlanGate(probeChild()));
  b.add("query.issued", { query: "q1", source: "netflow", text: "flows", why: "w", window: { from: null, to: null }, step: "s1", verifies: null, purpose: "result" } as never, { actor: engine });
  b.add("model.response", { request: "r1", response: blob("1"), stop: "end", usage: { input: 100, output: 40, reasoning: 10 }, served_by: "m", reasoning: null }, { actor: assembler });
  const s = fold(b.entries);
  expect(s.skipped).toEqual([]);
  expect(probeOutputOf(s)).toEqual({
    format: PROBE_OUTPUT_FORMAT, outcome: "drafted", reason: "", draft_hash: draft.hash, product: draft.product,
    stats: {
      lookups: 1, tokens: 140, model_calls: 1,
      stages: [{ id: "plan", status: "passed", attempts: 1 }, { id: "assemble", status: "passed", attempts: 1 }, { id: "checks", status: "idle", attempts: 0 }, { id: "publish", status: "waiting", attempts: 1 }],
    },
  });
  // finished completed, with a draft
  const done = atPublishGate(atPlanGate(probeChild())).b;
  done.add("run.finished", { outcome: "completed" }, { actor: engine });
  expect(probeOutputOf(fold(done.entries))).toMatchObject({ outcome: "drafted", reason: "" });
  const incomplete = (entries: Entry[]) => { const o = probeOutputOf(fold(entries)); expect(o.product).toBeNull(); expect(o.draft_hash).toBeNull(); expect(o.outcome).toBe("incomplete"); return o.reason; };
  expect(incomplete(probeChild().entries)).toBe("its run has not started");
  expect(incomplete(atPlanGate(probeChild()).entries)).toBe("it waits for a person at its plan gate");
  const paused = atPlanGate(probeChild());
  paused.add("run.paused", { reason: "a question for the person is unanswered" }, { actor: engine });
  expect(incomplete(paused.entries)).toBe("a question for the person is unanswered");
  const interrupted = atPlanGate(probeChild());
  interrupted.add("run.interrupted", {}, { actor: engine });
  expect(incomplete(interrupted.entries)).toBe("its run was interrupted");
  const stopped = atPublishGate(atPlanGate(probeChild())).b;
  stopped.add("run.finished", { outcome: "stopped" }, { actor: probeActor });
  expect(incomplete(stopped.entries)).toBe("its run was stopped");
  const empty = atPlanGate(probeChild());
  empty.add("run.finished", { outcome: "completed" }, { actor: engine });
  expect(incomplete(empty.entries)).toBe("it finished with no draft");
});

test("probeOutputOf of the same state is the same bytes: canonical(probeOutputOf(s)) twice", () => {
  const s = fold(atPublishGate(atPlanGate(probeChild())).b.entries);
  expect(canonical(probeOutputOf(s) as never)).toBe(canonical(probeOutputOf(fold(atPublishGate(atPlanGate(probeChild())).b.entries)) as never));
  expect(canonical(probeOutputOf(s) as never)).toBe(canonical(probeOutputOf(s) as never));
  // and it reads back as a probe output
  const bytes = new TextEncoder().encode(canonical(probeOutputOf(s) as never));
  expect(readProbeOutput(bytes)).toEqual(probeOutputOf(s));
});

test("each blob of an improve case has a reader that gives null for bytes that are not one", () => {
  const enc = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
  const product = productOf("TLP:AMBER");
  const inputs = { question: "q", starting: [{ type: "ip", value: "192.0.2.10" }], window: { from: null, to: null }, objective: null, marking: "TLP:AMBER", title: "t" };
  const record = {
    product, stages: [{ id: "plan", title: "Plan", status: "passed", attempts: 1, last_reason: null }], queries: [{ source: "netflow", pivot: "ip", outcome: "done", rows: 3 }],
    questions: 0, sendbacks: 1, usage: { input: 10, output: 5, calls: 1 },
  };
  const contrasts = [{ task: "T1", candidate: "K1", base: "drafted", now: "drafted", added: ["f2"], removed: [], changed: [{ statement: "s", likelihood: ["likely", "very likely"], confidence: null }], lookups: [4, 3], tokens: [100, 90] }];
  const answers = [{ task: "T1", seq: 8, hash: "8".repeat(64), text: "It was beaconing.", findings, marking: "TLP:AMBER" }];
  const sheet = {
    format: 1, scale: ["unlikely", "likely"],
    outputs: [{ probe: "base/T1", candidate: "base", task: "T1", outcome: "drafted", score: 875, text: null, findings: [{ expected: 0, produced: "f1", by: "code", similarity: 600, likelihood_distance: 0, confidence_distance: 1, score: 875 }], left_over: [] }],
    summary: [{ candidate: "base", score: 875, drafted: 1, tasks: 1 }],
  };
  expect(readTaskInputs(enc(inputs))).toEqual(inputs as never);
  expect(readTaskRecord(enc(record))).toEqual(record as never);
  expect(readContrasts(enc(contrasts))).toEqual(contrasts as never);
  expect(readAnswers(enc(answers))).toEqual(answers as never);
  expect(readScoreSheet(enc(sheet))).toEqual(sheet as never);
  const bad = [new Uint8Array([0xff, 0xfe]), enc("x"), enc({}), enc(null)];
  for (const read of [readTaskInputs, readTaskRecord, readProbeOutput, readContrasts, readAnswers, readScoreSheet]) for (const b of bad) expect(read(b)).toBeNull();
  expect(readTaskInputs(enc({ ...inputs, marking: "TLP:PINK" }))).toBeNull();
  expect(readScoreSheet(enc({ ...sheet, format: 2 }))).toBeNull();
  expect(readAnswers(enc([{ ...answers[0], findings: [{ claim: "", likelihood: "likely", confidence: "low" }] }]))).toBeNull();
});
