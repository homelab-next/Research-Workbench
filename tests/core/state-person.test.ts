import { expect, test } from "bun:test";
import { fold } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import {
  activeOverrules, holdsOverrule, openQuestions, overruleReason, overruleSays, overruleText, reopensOverrule, runQuestions, waitingOn,
} from "../../src/core/state/person";
import type { Overrule } from "../../src/core/state";
import type { Actor, Draft, Finding, Payloads, Product, Question, StageDef } from "../../src/core/types";
import { EntryBuilder, card } from "../helpers/entries";

const person: Actor = { kind: "human", id: "analyst" };
const engine: Actor = { kind: "system", id: "engine" };
const agentOf = (stage: string, id = `${stage}er-g1`): Actor => ({ kind: "agent", id, stage, profile: "default", model: "scripted-m", effort: null, where: "machine" });
const researcher = agentOf("research", "researcher-g1");
const assembler = agentOf("assemble", "assembler-g1");

const stages: StageDef[] = [
  { id: "research", title: "Research", phase: "collect", runs: "agent", gate: null, reviews: false, model: null },
  { id: "assemble", title: "Assemble", phase: "produce", runs: "agent", gate: null, reviews: false, model: null },
];

const question = (id: string, over: Partial<Question> = {}): Question => ({
  id, text: "Where is the access point AP-7?", why: "a TV there would explain the name", cards: ["c2"], about: [{ type: "address", value: "192.0.2.17" }], blocking: true, ...over,
});

function run(id = "run-1"): EntryBuilder {
  const b = new EntryBuilder();
  b.add("run.started", { run: id, pipeline: "p", pipeline_hash: "h", stages });
  return b;
}
const ask = (b: EntryBuilder, q: Question, by: Actor = researcher) => b.add("question.asked", { question: q }, { actor: by, stage: by.kind === "agent" ? by.stage : null });
const personCard = (id: string, answers: string | null) => card(id, {
  kind: "note", made_by: "human", columns: [], column_types: [], rows: [], row_count: 0, coverage: null, marking: "TLP:AMBER",
  person: { basis: "saw", detail: "in the gym", about: [], answers },
});
/** The state less what every entry moves: seq, head_ts, and the counters (which count creating entries, kept or not). */
const still = (s: CaseState) => { const { seq: _a, head_ts: _b, counters: _c, skipped: _d, ...rest } = s; return rest; };

// ---------- questions ----------

test("question.asked by an agent is recorded with its run and stage, and takes the next ask- id", () => {
  const b = run();
  ask(b, question("ask-1"));
  const s = fold(b.entries);
  expect(s.questions["ask-1"]).toMatchObject({ run: "run-1", stage: "research", by: "researcher-g1", blocking: true, answer: null, waived: null });
  expect(s.questions["ask-1"]).toMatchObject({ text: "Where is the access point AP-7?", why: "a TV there would explain the name", cards: ["c2"], about: [{ type: "address", value: "192.0.2.17" }] });
  expect(s.counters.question).toBe(1);
  expect(s.skipped).toEqual([]);
  // the state shares nothing with the payload
  const payload = b.entries.at(-1)!.payload as Payloads["question.asked"];
  expect(s.questions["ask-1"]!.cards).not.toBe(payload.question.cards);
  expect(s.questions["ask-1"]!.about[0]).not.toBe(payload.question.about[0]);
});

test("a question from a person, a second one with the same id, and a malformed one change nothing but skipped", () => {
  const b = run();
  const byPerson = b.add("question.asked", { question: question("ask-1") }, { actor: person });
  let s = fold(b.entries);
  expect(s.questions).toEqual({});
  expect(s.skipped).toEqual([{ seq: byPerson.seq, type: "question.asked", reason: "a question to the person is an agent's" }]);

  const c = run();
  ask(c, question("ask-1"));
  const before = fold(c.entries);
  ask(c, question("ask-1", { text: "Something else?" }));
  s = fold(c.entries);
  expect(still(s)).toEqual(still(before));
  expect(s.skipped).toEqual([]);

  const bad = ask(c, { ...question("ask-2"), cards: "c2" } as never);
  s = fold(c.entries);
  expect(still(s)).toEqual(still(before));
  expect(s.skipped).toEqual([{ seq: bad.seq, type: "question.asked", reason: "malformed question.asked" }]);
});

test("question.answered by a person names the statement card that answers it; a second answer changes nothing", () => {
  const b = run();
  ask(b, question("ask-1"));
  b.add("card.created", { card: card("c1") });
  b.add("card.created", { card: card("c2") });
  b.add("card.created", { card: personCard("c3", "ask-1") }, { actor: person });
  const answered = b.add("question.answered", { question: "ask-1", card: "c3" }, { actor: person });
  b.add("card.created", { card: personCard("c4", "ask-1") }, { actor: person });
  b.add("question.answered", { question: "ask-1", card: "c4" }, { actor: person });
  const s = fold(b.entries);
  expect(s.questions["ask-1"]!.answer).toEqual({ card: "c3", by: "analyst", seq: answered.seq, ts: answered.ts });
  expect(openQuestions(s)).toEqual([]);
  expect(s.skipped).toEqual([]);
});

test("an answer not by a person, or naming a card that is not the person's answer to that question, is skipped with its reason", () => {
  const b = run();
  ask(b, question("ask-1"));
  b.add("card.created", { card: card("c1") });
  b.add("card.created", { card: personCard("c2", "ask-2") }, { actor: person });
  b.add("card.created", { card: personCard("c3", "ask-1") }, { actor: person });
  const byAgent = b.add("question.answered", { question: "ask-1", card: "c3" }, { actor: researcher });
  const resultCard = b.add("question.answered", { question: "ask-1", card: "c1" }, { actor: person });
  const otherQuestion = b.add("question.answered", { question: "ask-1", card: "c2" }, { actor: person });
  const missing = b.add("question.answered", { question: "ask-1", card: "c9" }, { actor: person });
  const before = fold(b.entries);
  b.add("question.answered", { question: "ask-7", card: "c3" }, { actor: person });
  const s = fold(b.entries);
  expect(s.questions["ask-1"]!.answer).toBeNull();
  expect(still(s)).toEqual(still(before));
  expect(s.skipped.map((x) => [x.seq, x.reason])).toEqual([
    [byAgent.seq, "an answer is a person's"],
    [resultCard.seq, "an answer names the person's card that answers the question"],
    [otherQuestion.seq, "an answer names the person's card that answers the question"],
    [missing.seq, "an answer names the person's card that answers the question"],
  ]);
  const malformed = run();
  const bad = malformed.add("question.answered", { question: 1, card: "c3" } as never, { actor: person });
  expect(fold(malformed.entries).skipped).toEqual([{ seq: bad.seq, type: "question.answered", reason: "malformed question.answered" }]);
});

test("a person's resume of a pause held for a question waives that stage's open blocking questions, and no others", () => {
  const b = run();
  ask(b, question("ask-1"));
  ask(b, question("ask-2", { blocking: false }));
  ask(b, question("ask-3"), assembler);
  b.add("stage.finished", { stage: "research", attempt: 1, outcome: "pass", draft_hash: null, output: null, reason: null }, { actor: engine });
  b.add("run.paused", { reason: "waiting for the person's answer to ask-1", hold: { kind: "question", stage: "research" } }, { actor: engine });
  let s = fold(b.entries);
  expect(s.run).toMatchObject({ status: "paused", hold: { kind: "question", stage: "research" } });
  expect(waitingOn(s, "research").map((q) => q.id)).toEqual(["ask-1"]);
  const resumed = b.add("run.resumed", {}, { actor: person });
  s = fold(b.entries);
  expect([s.questions["ask-1"]!.waived, s.questions["ask-2"]!.waived, s.questions["ask-3"]!.waived]).toEqual([{ by: "analyst", seq: resumed.seq, ts: resumed.ts }, null, null]);
  expect(waitingOn(s, "research")).toEqual([]);
  expect(waitingOn(s, "assemble").map((q) => q.id)).toEqual(["ask-3"]);
  expect(openQuestions(s).map((q) => q.id)).toEqual(["ask-1", "ask-2", "ask-3"]);
  expect(s.run).toMatchObject({ status: "running", hold: null });
  // the stage's pass stands: the hold comes after it, and a resume does not run the stage again
  expect(s.run.stages.find((x) => x.id === "research")!.status).toBe("passed");
  expect(s.skipped).toEqual([]);
});

test("a resume by the engine, or of a pause with another hold, waives nothing", () => {
  const b = run();
  ask(b, question("ask-1"));
  b.add("run.paused", { reason: "waiting", hold: { kind: "question", stage: "research" } }, { actor: engine });
  b.add("run.resumed", {}, { actor: engine });
  expect(fold(b.entries).questions["ask-1"]!.waived).toBeNull();
  b.add("run.paused", { reason: "ruled", hold: { kind: "ruled", stage: "research" } }, { actor: engine });
  b.add("run.resumed", {}, { actor: person });
  b.add("run.paused", { reason: "coffee" }, { actor: person });
  b.add("run.resumed", {}, { actor: person });
  const s = fold(b.entries);
  expect(s.questions["ask-1"]!.waived).toBeNull();
  expect(waitingOn(s, "research").map((q) => q.id)).toEqual(["ask-1"]);
  expect(s.skipped).toEqual([]);
});

test("runQuestions holds only the current run's questions", () => {
  const b = run();
  ask(b, question("ask-1"));
  b.add("run.finished", { outcome: "stopped" }, { actor: engine });
  b.add("run.started", { run: "run-2", pipeline: "p", pipeline_hash: "h", stages });
  ask(b, question("ask-2"));
  const s = fold(b.entries);
  expect(runQuestions(s).map((q) => q.id)).toEqual(["ask-2"]);
  expect(Object.keys(s.questions)).toEqual(["ask-1", "ask-2"]);
  expect(s.questions["ask-1"]!.run).toBe("run-1");
});

// ---------- overrules ----------

const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
  id, statement: `We assess it is likely that ${id} holds.`, likelihood: "likely", confidence: "moderate", confidence_basis: "one source", cites: ["c1"], assumptions: [], reasoning: "r", ...over,
});
const productOf = (findings: Finding[]): Product => ({
  objective: "o", question: "q", marking: "TLP:AMBER", summary: "s", key_findings: findings, gaps_and_limits: "", alternatives: "", assessment: "", sources: [], assumptions: [], change: "",
});
const draft = (n: number, findings: Finding[]): Draft => ({ n, hash: `h${n}`, author: { kind: "system", id: "test" }, product: productOf(findings), reason: "r" });
const overrulePayload = (over: Partial<Payloads["finding.overruled"]> = {}): Payloads["finding.overruled"] => ({
  finding: "f1", draft_hash: "h1", likelihood: null, confidence: null, stays: null, note: "It is the TV I installed.", ...over,
});
const overrule = (over: Partial<Overrule> = {}): Overrule => ({ ...overrulePayload(), by: "analyst", seq: 9, ts: "t", ...over });
function drafted(): EntryBuilder {
  const b = run();
  b.add("draft.revised", { draft: draft(1, [finding("f1"), finding("f2")]) });
  return b;
}

test("finding.overruled by a person is the overrule of that finding; a later one replaces it and keeps the earlier", () => {
  const b = drafted();
  const first = b.add("finding.overruled", overrulePayload({ likelihood: "almost certain" }), { actor: person });
  const second = b.add("finding.overruled", overrulePayload({ confidence: "high" }), { actor: person });
  const s = fold(b.entries);
  expect(s.overrules.f1).toMatchObject({ likelihood: null, confidence: "high", seq: second.seq, by: "analyst", earlier: [{ likelihood: "almost certain", seq: first.seq }] });
  expect("earlier" in s.overrules.f1!.earlier[0]!).toBe(false);
  expect(activeOverrules(s).map((o) => o.finding)).toEqual(["f1"]);
  expect(s.skipped).toEqual([]);
});

test("an overrule not by a person, without a note, or dropping a finding while setting a value, is skipped with its reason", () => {
  const b = drafted();
  const byAgent = b.add("finding.overruled", overrulePayload({ likelihood: "almost certain" }), { actor: researcher });
  const noNote = b.add("finding.overruled", overrulePayload({ likelihood: "almost certain", note: "  " }), { actor: person });
  const dropSet = b.add("finding.overruled", overrulePayload({ confidence: "high", stays: false }), { actor: person });
  const bad = b.add("finding.overruled", overrulePayload({ confidence: "sure" as never }), { actor: person });
  const s = fold(b.entries);
  expect(s.overrules).toEqual({});
  expect(s.skipped.map((x) => [x.seq, x.reason])).toEqual([
    [byAgent.seq, "an overrule is a person's"], [noNote.seq, "an overrule gives a note"], [dropSet.seq, "a dropped finding has no likelihood or confidence to set"],
    [bad.seq, "malformed finding.overruled"],
  ]);
});

test("an overrule of a finding no draft has ever held changes nothing", () => {
  const b = drafted();
  const before = fold(b.entries);
  b.add("finding.overruled", overrulePayload({ finding: "f9", likelihood: "almost certain" }), { actor: person });
  const s = fold(b.entries);
  expect(still(s)).toEqual(still(before));
  expect(s.skipped).toEqual([]);
});

test("an overrule with nothing set withdraws: it is the latest, and it is not active", () => {
  const b = drafted();
  b.add("finding.overruled", overrulePayload({ likelihood: "almost certain" }), { actor: person });
  b.add("finding.overruled", overrulePayload({ note: "I was wrong about the room." }), { actor: person });
  const s = fold(b.entries);
  expect(activeOverrules(s)).toEqual([]); expect(s.overrules.f1!.earlier.length).toBe(1); expect(overruleText(s.overrules.f1!)).toBe("f1: overrule withdrawn. Note: I was wrong about the room.");
});

test("activeOverrules are in the order they were last made", () => {
  const b = drafted();
  b.add("finding.overruled", overrulePayload({ likelihood: "almost certain" }), { actor: person });
  b.add("finding.overruled", overrulePayload({ finding: "f2", stays: true }), { actor: person });
  b.add("finding.overruled", overrulePayload({ confidence: "high" }), { actor: person });
  expect(activeOverrules(fold(b.entries)).map((o) => o.finding)).toEqual(["f2", "f1"]);
});

test("overruleSays and overruleText", () => {
  expect(overruleSays(overrule({ likelihood: "almost certain", confidence: "high" }))).toBe("likelihood almost certain, confidence high");
  expect(overruleSays(overrule({ stays: true }))).toBe("must stay");
  expect(overruleSays(overrule({ stays: false }))).toBe("dropped");
  expect(overruleSays(overrule())).toBe("overrule withdrawn");
  expect(overruleText(overrule({ likelihood: "almost certain", note: " It is the TV I installed. " }))).toBe("f1: likelihood almost certain. Note: It is the TV I installed.");
});

test("overruleReason asks the analyst to rest the finding's basis and reasoning on the person's note", () => {
  expect(overruleReason(overrule({ likelihood: "almost certain" }))).toBe(
    "the person overruled f1: likelihood almost certain. Note: It is the TV I installed. Code holds f1 to it; rewrite f1's confidence_basis and reasoning to rest on the person's note.",
  );
  expect(overruleReason(overrule({ stays: false }))).toBe("the person overruled f1: dropped. Note: It is the TV I installed. Code leaves f1 out.");
  expect(overruleReason(overrule({ note: "I was wrong." }))).toBe("the person withdrew the overrule of f1. Note: I was wrong. f1 is the analyst's to assess again.");
});

test("holdsOverrule: a set value must be there, a kept finding must be present, a dropped one absent", () => {
  const p = productOf([finding("f1", { likelihood: "almost certain" })]);
  expect(holdsOverrule(p, overrule({ likelihood: "almost certain" }))).toBe(true);
  expect(holdsOverrule(p, overrule({ likelihood: "almost certain", confidence: "high" }))).toBe(false);
  expect(holdsOverrule(productOf([]), overrule({ likelihood: "almost certain" }))).toBe(false);
  expect(holdsOverrule(p, overrule({ stays: true }))).toBe(true);
  expect(holdsOverrule(productOf([]), overrule({ stays: true }))).toBe(false);
  expect(holdsOverrule(p, overrule({ stays: false }))).toBe(false);
  expect(holdsOverrule(productOf([]), overrule({ stays: false }))).toBe(true);
  expect(holdsOverrule(p, overrule())).toBeNull();
});

test("reopensOverrule: a point that names the finding and speaks to what was set", () => {
  const o = overrule({ likelihood: "almost certain" });
  expect(reopensOverrule("f1 overstates the likelihood: one event", o)).toBe(true);
  expect(reopensOverrule("f1 should be dropped: it rests on one card", o)).toBe(true);        // a set value keeps the finding
  expect(reopensOverrule("f1 cites c2, which is empty", o)).toBe(false);
  expect(reopensOverrule("f2 overstates the likelihood", o)).toBe(false);
  expect(reopensOverrule("f1 is overconfident", o)).toBe(false);                              // confidence was not set
  expect(reopensOverrule("f1 is overconfident", overrule({ confidence: "high" }))).toBe(true);
  expect(reopensOverrule("f1's confidence_basis names no card", overrule({ confidence: "high" }))).toBe(false);
  expect(reopensOverrule("f1 is missing and should be restored", overrule({ stays: false }))).toBe(true);
  expect(reopensOverrule("f1 should be dropped", overrule({ stays: false }))).toBe(false);
  expect(reopensOverrule("f1 should be dropped", overrule({ stays: true }))).toBe(true);
  expect(reopensOverrule("f1 should be dropped", overrule())).toBe(false);                      // withdrawn: nothing is settled
});
