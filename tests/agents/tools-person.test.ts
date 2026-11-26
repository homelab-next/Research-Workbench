import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import type { Actor, StageDef } from "../../src/core/types";
import { TOOL_NAMES, TOOLS } from "../../src/agents/tools";
import { DEFAULT_MAX_OPEN } from "../../src/agents/tools/person";
import { addStatement } from "../../src/pipeline/person";
import { fixture, person } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

const engine: Actor = { kind: "system", id: "engine" };
const stages: StageDef[] = [
  { id: "research", title: "Research", phase: "collect", runs: "agent", gate: null, reviews: false, model: null },
  { id: "assemble", title: "Assemble", phase: "produce", runs: "agent", gate: null, reviews: false, model: null },
];

let f: Fixture;
beforeEach(async () => {
  f = fixture(true);
  await f.call("run_step", { step: "s1", why: "w" });
  // a run started by hand, so the questions have one
  f.s.commit((_s, ids) => [{ type: "run.started", actor: engine, payload: { run: ids.next("run"), pipeline: "p", pipeline_hash: "h", stages } }]);
});
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});
const view = (r: { view: Json }): Record<string, Json> => r.view as Record<string, Json>;
const ask = (question: string, extra: Record<string, Json> = {}) => f.call("ask_person", { why: "it matters", question, blocking: false, ...extra });
/** The person answers a question by hand: their card that answers it, and question.answered naming it. */
function answer(q: string): void {
  f.s.commit((_s, ids) => {
    const id = ids.next("card");
    return [
      { type: "card.created", actor: person, payload: { card: { id, title: "a", body: "b", kind: "note", made_by: "human", query: null, columns: [], column_types: [], rows: [], row_count: 0, coverage: null, empty: null, marking: "TLP:GREEN", source: null, step: null, subgoal: null, why: "saw it myself", event_time: null, quality_notes: [], person: { basis: "saw", detail: "", about: [], answers: q } } } },
      { type: "question.answered", actor: person, payload: { question: q, card: id } },
    ];
  });
}

test("ask_person records the question with why it matters and what it is about, and tells the agent to carry on", async () => {
  const r = await f.call("ask_person", { why: "A TV there would explain the name.", question: "Where is the access point AP-7, and is a TV expected there?", cards: ["c1"], about: [{ type: "address", value: "192.0.2.17" }], blocking: true });
  expect(r).toMatchObject({ ok: true, summary: "asked ask-1", view: { question: "ask-1", blocking: true, status: "asked; carry on with what does not depend on the answer" }, marking: null });
  expect(f.s.state.questions["ask-1"]).toMatchObject({ text: "Where is the access point AP-7, and is a TV expected there?", why: "A TV there would explain the name.", cards: ["c1"], blocking: true, by: "researcher-g1" });
  expect(f.s.state.questions["ask-1"]!.about).toEqual([{ type: "address", value: "192.0.2.17" }]);
});

test("the entry carries the stage and job the agent works in", async () => {
  f.ctx.link = { run: "run-1", stage: "research", job: "job-7" };
  await ask("Who owns the laptop?");
  const e = f.s.entries().at(-1)!;
  expect(e).toMatchObject({ type: "question.asked", run: "run-1", stage: "research", job: "job-7" });
  expect(f.s.state.questions["ask-1"]).toMatchObject({ run: "run-1", stage: "research" });
});

test("with three questions open a fourth is refused, and names them", async () => {
  expect(DEFAULT_MAX_OPEN).toBe(3);
  for (const q of ["One?", "Two?", "Three?"]) expect((await ask(q)).ok).toBe(true);
  const n = f.s.entries().length;
  const r = await ask("Four?");
  expect(r.ok).toBe(false);
  expect(view(r).error).toBe("3 questions to the person are already open (ask-1, ask-2, ask-3); go on without asking another");
  expect(f.s.entries().length).toBe(n);
});

test("an answered question frees a place; the cap is the context's when it gives one, and 0 turns asking off", async () => {
  for (const q of ["One?", "Two?", "Three?"]) await ask(q);
  answer("ask-2");
  expect(await ask("Four?")).toMatchObject({ ok: true, summary: "asked ask-4" });
  f.ctx.max_open_questions = 4;
  expect(await ask("Five?")).toMatchObject({ ok: true, summary: "asked ask-5" });
  expect(view(await ask("Six?")).error).toBe("4 questions to the person are already open (ask-1, ask-3, ask-4, ask-5); go on without asking another");
  f.ctx.max_open_questions = 1;
  answer("ask-1"); answer("ask-3"); answer("ask-4");
  expect(view(await ask("Seven?")).error).toBe("1 question to the person is already open (ask-5); go on without asking another");
  f.ctx.max_open_questions = 0;
  answer("ask-5");
  expect(view(await ask("Eight?")).error).toBe("this root does not let a stage ask the person");
});

test("the same question, in other spacing or case, is refused while the first is open", async () => {
  await ask("Where is the access point AP-7?");
  const r = await ask("  where is the  ACCESS point\nap-7? ");
  expect(view(r).error).toBe("that question is already open as ask-1");
  answer("ask-1");
  expect(await ask("where is the access point ap-7?")).toMatchObject({ ok: true, summary: "asked ask-2" });
});

test("an unknown or discarded card, an unknown type and a value that is not of its type are refused", async () => {
  expect(view(await ask("Q?", { cards: ["c99"] })).error).toBe("unknown card: c99");
  f.s.commit(() => [{ type: "card.discarded", actor: person, payload: { card: "c1" } }]);
  expect(view(await ask("Q?", { cards: ["c1"] })).error).toBe("card c1 was discarded");
  expect(view(await ask("Q?", { about: [{ type: "nonesuch", value: "x" }] })).error).toBe("there is no type nonesuch");
  expect(view(await ask("Q?", { about: [{ type: "address", value: "not an address" }] })).error).toBe("not an address is not of the type address");
  expect(f.s.state.questions).toEqual({});
});

test("after the person went on without answering a stage's blocking question, that stage's next one is recorded as not blocking, and the agent is told", async () => {
  await ask("Where is AP-7?", { blocking: true });
  f.s.commit(() => [{ type: "run.paused", actor: engine, payload: { reason: "waiting for the person's answer to ask-1", hold: { kind: "question", stage: "research" } } }]);
  f.s.commit(() => [{ type: "run.resumed", actor: person, payload: {} }]);
  const r = await ask("Is the printer new?", { blocking: true });
  expect(r).toMatchObject({ ok: true, view: { question: "ask-2", blocking: false, status: "asked, not blocking: the person went on without answering ask-1; carry on with what does not depend on the answer" } });
  expect(f.s.state.questions["ask-2"]!.blocking).toBe(false);
  // another stage's question still blocks
  f.ctx.actor = { ...f.ctx.actor, id: "assembler-g1", stage: "assemble" };
  expect(view(await ask("Who owns the laptop?", { blocking: true }))).toMatchObject({ question: "ask-3", blocking: true });
});

test("a statement by the person may be named among the cards a question is about", async () => {
  const c = addStatement(f.s, f.sample.deps, { actor: person, statement: "AP-7 is in the gym.", basis: "saw", detail: "", about: [], marking: null });
  expect((await ask("Is a TV expected in the gym?", { cards: [c] })).ok).toBe(true);
});

test("every tool has a definition: none is 'Not available yet'", () => {
  for (const n of TOOL_NAMES) expect(TOOLS[n].description).not.toBe("Not available yet.");
  expect(TOOL_NAMES).toContain("ask_person");
});
