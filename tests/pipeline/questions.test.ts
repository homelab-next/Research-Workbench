import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Actor, Marking, Question, StageDef } from "../../src/core/types";
import { PersonRefused } from "../../src/pipeline/person";
import { answerQuestion, questionMarking, questionsPart, waitingReason } from "../../src/pipeline/questions";
import { fixture, person } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

const engine: Actor = { kind: "system", id: "engine" };
const agentOf = (stage: string, id: string): Extract<Actor, { kind: "agent" }> => ({ kind: "agent", id, stage, profile: "investigation", model: "m", effort: null, where: "machine" });
const researcher = agentOf("research", "researcher-g1");
const assembler = agentOf("assemble", "assembler");
const stages: StageDef[] = [
  { id: "research", title: "Research", phase: "collect", runs: "agent", gate: null, reviews: false, model: null },
  { id: "assemble", title: "Assemble", phase: "produce", runs: "agent", gate: null, reviews: false, model: null },
];
const Q1 = "Where is the access point AP-7, and is a TV expected there?";

let f: Fixture;
beforeEach(() => { f = fixture(true); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});

function startRun(): void {
  f.s.commit((_s, ids) => [{ type: "run.started", actor: engine, payload: { run: ids.next("run"), pipeline: "p", pipeline_hash: "h", stages } }]);
}
/** A model request of the agent under `marking`, then the question it asks while answering it. Returns the question's id. */
function ask(text: string, opts: { by?: Extract<Actor, { kind: "agent" }>; marking?: Marking; blocking?: boolean; about?: Question["about"] } = {}): string {
  const by = opts.by ?? researcher;
  let id = "";
  f.s.commit((st, ids) => {
    id = ids.next("question");
    return [
      { type: "model.request", actor: by, run: st.run.id, stage: by.stage, payload: { request: ids.next("request"), provider: "scripted", model: "m", effort: null, where: "machine", marking: opts.marking ?? "TLP:GREEN", pack: [], left_out: [], messages: f.s.blobs.put("{}"), tools: [] } },
      { type: "question.asked", actor: by, run: st.run.id, stage: by.stage, payload: { question: { id, text, why: "it matters", cards: [], about: opts.about ?? [], blocking: opts.blocking ?? false } } },
    ];
  });
  return id;
}
const answer = (question: string, extra: Partial<Parameters<typeof answerQuestion>[2]> = {}): string =>
  answerQuestion(f.s, f.sample.deps, { actor: person, question, answer: "In the gym. A TV is expected there.", basis: "saw", detail: "", about: null, marking: null, ...extra });
const refusal = (fn: () => unknown): string => {
  try { fn(); } catch (err) { expect(err).toBeInstanceOf(PersonRefused); return (err as Error).message; }
  throw new Error("not refused");
};

test("answerQuestion writes the person's statement card and question.answered in one commit, the card caused by the question", () => {
  startRun();
  const q = ask(Q1, { about: [{ type: "address", value: "192.0.2.17" }] });
  const before = f.s.entries().length;
  const id = answer(q);
  const written = f.s.entries().slice(before);
  expect(written.map((e) => e.type)).toEqual(["card.created", "question.answered"]);
  expect(written.every((e) => e.actor.kind === "human")).toBe(true);
  expect(written[0]!.cause).toBe(f.s.state.questions[q]!.seq);
  const card = f.s.state.cards[id]!;
  expect(card).toMatchObject({
    title: `Answer to ask-1: ${Q1}`, body: "In the gym. A TV is expected there.", kind: "note", made_by: "human", place: "incoming",
    person: { basis: "saw", detail: "", about: [{ type: "address", value: "192.0.2.17" }], answers: "ask-1" },
  });
  expect(f.s.state.questions[q]!.answer).toMatchObject({ card: id, by: "analyst" });
  // the person's own values replace the question's; a long question is cut at 60 characters
  const long = ask("Which of the three printers on the second floor was installed most recently, and by whom?");
  const id2 = answer(long, { about: [], detail: "I asked the office", basis: "told" });
  expect(f.s.state.cards[id2]).toMatchObject({ title: "Answer to ask-2: Which of the three printers on the second floor was installe…", person: { about: [], basis: "told", detail: "I asked the office" } });
});

test("the answer card is at least as strict as the case, the person's choice and the request that wrote the question", () => {
  startRun();
  const amber = ask("Is the printer new?", { marking: "TLP:AMBER" });
  expect(questionMarking(f.s, f.s.state.questions[amber]!)).toBe("TLP:AMBER");
  const markingOf = (id: string): Marking => f.s.state.cards[id]!.marking;
  expect(markingOf(answer(amber))).toBe("TLP:AMBER");
  const green = ask("Who owns the laptop?");
  expect(markingOf(answer(green))).toBe("TLP:GREEN");
  const chosen = ask("Who set up the switch?");
  expect(markingOf(answer(chosen, { marking: "TLP:RED" }))).toBe("TLP:RED");
});

test("an answer is refused: an unknown question, one already answered, no text, a marking below the case's, not by a person", () => {
  startRun();
  const q = ask(Q1);
  expect(refusal(() => answer("ask-9"))).toBe("there is no question ask-9");
  expect(refusal(() => answer(q, { answer: "  " }))).toBe("an answer needs text");
  expect(refusal(() => answer(q, { marking: "TLP:CLEAR" }))).toBe("an answer cannot be marked below the case's TLP:GREEN");
  expect(refusal(() => answer(q, { actor: researcher }))).toBe("only a person may answer a question");
  expect(refusal(() => answer(q, { about: [{ type: "address", value: "not an address" }] }))).toBe("not an address is not of the type address");
  const n = f.s.entries().length;
  const card = answer(q);
  expect(f.s.entries().length).toBe(n + 2);
  expect(refusal(() => answer(q))).toBe(`ask-1 is already answered (card ${card}); add a statement to correct it`);
  expect(f.s.entries().length).toBe(n + 2);
});

test("a question from an earlier run can still be answered", () => {
  startRun();
  const q = ask(Q1);
  f.s.commit(() => [{ type: "run.finished", actor: engine, payload: { outcome: "stopped", reason: "done" } }]);
  startRun();
  expect(f.s.state.run.id).toBe("run-2");
  const id = answer(q);
  expect(f.s.state.questions[q]!.answer!.card).toBe(id);
});

test("questionsPart lists the run's questions with who asked and what came of each, and carries the questions' and answers' markings", () => {
  startRun();
  ask("Where is the access point AP-7?", { blocking: true, marking: "TLP:AMBER" });
  ask("Who owns the laptop?", { by: assembler });
  ask("Is the printer new?", { blocking: true });
  answer("ask-1");
  f.s.commit(() => [{ type: "run.paused", actor: engine, payload: { reason: "waiting for the person's answer to ask-3", hold: { kind: "question", stage: "research" } } }]);
  f.s.commit(() => [{ type: "run.resumed", actor: person, payload: {} }]);
  const c = f.s.state.questions["ask-1"]!.answer!.card;
  const part = questionsPart(f.s, f.sample.registry);
  expect(part!.text).toBe([
    "Questions put to the person in this run. An answer is a card: cite it like any card, and say the finding rests on the person's word.",
    `- ask-1 (asked by Research; blocking): Where is the access point AP-7? Answered in card ${c}: In the gym. A TV is expected there.`,
    "- ask-2 (asked by Assemble): Who owns the laptop? Not answered yet.",
    "- ask-3 (asked by Research; blocking): Is the printer new? Not answered; the person went on without answering: name this under gaps_and_limits.",
  ].join("\n"));
  expect(part).toMatchObject({ kind: "note", id: "questions", fixed: true, marking: "TLP:AMBER" });
  // an answer stricter than every question makes the part as strict
  ask("Is the switch new?");
  answer("ask-4", { marking: "TLP:RED" });
  expect(questionsPart(f.s, f.sample.registry)!.marking).toBe("TLP:RED");
});

test("questionsPart is null for a run with no question", () => {
  expect(questionsPart(f.s, f.sample.registry)).toBeNull();
  startRun();
  ask(Q1);
  startRunAfter();
  expect(questionsPart(f.s, f.sample.registry)).toBeNull();
});
function startRunAfter(): void {
  f.s.commit(() => [{ type: "run.finished", actor: engine, payload: { outcome: "stopped", reason: "done" } }]);
  startRun();
}

test("waitingReason names the question, or the questions, the run waits for", () => {
  startRun();
  ask(Q1, { blocking: true });
  ask("Who owns the laptop?", { blocking: true });
  const [a, b] = [f.s.state.questions["ask-1"]!, f.s.state.questions["ask-2"]!];
  expect(waitingReason([a])).toBe("waiting for the person's answer to ask-1. Answer it in the Narrative lens, or resume to go on without it.");
  expect(waitingReason([a, b])).toBe("waiting for the person's answer to ask-1 and ask-2. Answer them in the Narrative lens, or resume to go on without them.");
});
