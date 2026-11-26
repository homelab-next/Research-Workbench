import { afterEach, beforeEach, expect, test } from "bun:test";
import { addStatement, MAX_ABOUT, MAX_DETAIL, MAX_STATEMENT, PersonRefused, personCard } from "../../src/pipeline/person";
import { aboutProblem } from "../../src/modules/about";
import { agent, fixture, person } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
beforeEach(() => { f = fixture(); });
afterEach(() => {
  try { expect(f.s.state.skipped).toEqual([]); } finally { f.close(); }
});

const TV = "The device at 192.0.2.17 is the meeting-room TV.";
const base = { actor: person, statement: TV, basis: "did" as const, detail: "I installed it", about: [{ type: "address", value: "192.0.2.17" }], marking: null };
const refusal = (fn: () => unknown): string => {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(PersonRefused);
    return (e as Error).message;
  }
  throw new Error("not refused");
};

test("addStatement records one card.created in the person's name: a note with no rows, the case's marking, and how they know", () => {
  const before = f.s.entries().length;
  const id = addStatement(f.s, f.sample.deps, base);
  const written = f.s.entries().slice(before);
  expect(written.map((e) => e.type)).toEqual(["card.created"]);
  expect(written[0]!.actor).toEqual(person);
  expect(f.s.state.cards[id]).toMatchObject({
    kind: "note", made_by: "human", title: "Statement: The device at 192.0.2.17 is the meeting-room TV.", body: TV, row_count: 0, query: null, source: null,
    marking: "TLP:GREEN", why: "did it myself: I installed it", place: "incoming",
    person: { basis: "did", detail: "I installed it", about: [{ type: "address", value: "192.0.2.17" }], answers: null },
  });
  expect(f.s.state.cards[id]!.rows).toEqual([]);
  expect(f.s.state.incoming).toContain(id);
});

test("a title is the statement's first 80 characters on one line", () => {
  const long = `First line\nsecond   line ${"x".repeat(100)}`;
  const id = addStatement(f.s, f.sample.deps, { ...base, statement: long });
  const title = f.s.state.cards[id]!.title;
  expect(title).toBe(`Statement: ${`First line second line ${"x".repeat(100)}`.slice(0, 80)}`);
  expect(title.includes("\n")).toBe(false);
  expect(f.s.state.cards[id]!.body).toBe(long);
  // with no detail, why is how they know alone
  const plain = addStatement(f.s, f.sample.deps, { ...base, basis: "told", detail: "" });
  expect(f.s.state.cards[plain]!.why).toBe("was told");
});

test("a stricter marking is taken; one below the case's is refused", () => {
  const id = addStatement(f.s, f.sample.deps, { ...base, marking: "TLP:AMBER" });
  expect(f.s.state.cards[id]!.marking).toBe("TLP:AMBER");
  const n = f.s.entries().length;
  expect(refusal(() => addStatement(f.s, f.sample.deps, { ...base, marking: "TLP:CLEAR" }))).toBe("a statement cannot be marked below the case's TLP:GREEN");
  expect(f.s.entries().length).toBe(n);
});

test("an empty statement, one past 4000 characters, an unknown type and a value that is not of its type are refused, and nothing is written", () => {
  const n = f.s.entries().length;
  const deps = f.sample.deps;
  expect(refusal(() => addStatement(f.s, deps, { ...base, statement: "  \n " }))).toBe("a statement needs text");
  expect(refusal(() => addStatement(f.s, deps, { ...base, statement: "x".repeat(MAX_STATEMENT + 1) }))).toBe("a statement is at most 4000 characters");
  expect(refusal(() => addStatement(f.s, deps, { ...base, detail: "x".repeat(MAX_DETAIL + 1) }))).toBe("how they know is at most 500 characters");
  expect(refusal(() => addStatement(f.s, deps, { ...base, about: [{ type: "colour", value: "red" }] }))).toBe("there is no type colour");
  expect(refusal(() => addStatement(f.s, deps, { ...base, about: [{ type: "address", value: "not-an-address" }] }))).toBe("not-an-address is not of the type address");
  const many = Array.from({ length: MAX_ABOUT + 1 }, (_, i) => ({ type: "address", value: `192.0.2.${i}` }));
  expect(refusal(() => addStatement(f.s, deps, { ...base, about: many }))).toBe("at most 20 values");
  expect(f.s.entries().length).toBe(n);
  // the full length is allowed
  addStatement(f.s, deps, { ...base, statement: "x".repeat(MAX_STATEMENT) });
});

test("only a person may add a statement", () => {
  const n = f.s.entries().length;
  expect(refusal(() => addStatement(f.s, f.sample.deps, { ...base, actor: agent }))).toBe("only a person may add a statement");
  expect(f.s.entries().length).toBe(n);
});

test("aboutProblem is null for values the root knows", () => {
  expect(aboutProblem(f.sample.deps.registry, f.sample.deps.observables, [{ type: "address", value: "192.0.2.17" }])).toBeNull();
  expect(aboutProblem(f.sample.deps.registry, f.sample.deps.observables, [])).toBeNull();
});

test("personCard is pure: the same input gives the same card, with a fresh about list", () => {
  const about = [{ type: "address", value: "192.0.2.17" }];
  const input = { title: "Statement: x", statement: "x", basis: "saw" as const, detail: "", about, answers: "ask-1", marking: "TLP:GREEN" as const };
  const a = personCard("c9", input);
  expect(a).toEqual(personCard("c9", input));
  expect(a.person!.about).not.toBe(about);
  expect(a).toMatchObject({ id: "c9", why: "saw it myself", person: { basis: "saw", detail: "", answers: "ask-1" } });
});
