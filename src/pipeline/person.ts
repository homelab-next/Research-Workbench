// A statement by the person: what they know, recorded as a card of theirs in Incoming (slice 8).
import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import { BASIS_TEXT } from "../core/state";
import { MARKINGS, strictest } from "../core/types";
import type { Actor, Card, Marking, Observable, PersonBasis } from "../core/types";
import { aboutProblem, MAX_ABOUT_VALUES } from "../modules/about";
import type { RunnerDeps } from "../modules/runner";

export class PersonRefused extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "PersonRefused";
  }
}

export const MAX_STATEMENT = 4000;
export const MAX_DETAIL = 500;
export const MAX_ABOUT = MAX_ABOUT_VALUES;
const TITLE_CHARS = 80;

/** A statement's title: its first 80 characters on one line. */
export const statementTitle = (statement: string): string => `Statement: ${statement.replace(/\s+/g, " ").trim().slice(0, TITLE_CHARS)}`;

/** The card a statement becomes. Pure; the id is the caller's. why is BASIS_TEXT[basis], with ": <detail>" when there is one. */
export function personCard(id: string, input: { title: string; statement: string; basis: PersonBasis; detail: string; about: Observable[]; answers: string | null; marking: Marking }): Card {
  return {
    id, title: input.title, body: input.statement, kind: "note", made_by: "human", query: null, columns: [], column_types: [], rows: [], row_count: 0,
    coverage: null, empty: null, marking: input.marking, source: null, step: null, subgoal: null,
    why: input.detail === "" ? BASIS_TEXT[input.basis] : `${BASIS_TEXT[input.basis]}: ${input.detail}`, event_time: null, quality_notes: [],
    person: { basis: input.basis, detail: input.detail, about: input.about.map((o) => ({ type: o.type, value: o.value })), answers: input.answers },
  };
}

/** The checks every statement passes, an answer's included: text, lengths, values the root knows, and a marking no lower than the case's. Returns the marking to write. */
export function checkStatement(session: CaseSession, deps: RunnerDeps, input: { actor: Actor; statement: string; detail: string; about: Observable[]; marking: Marking | null }, floor: Marking[] = []): Marking {
  if (input.actor.kind !== "human") throw new PersonRefused("only a person may add a statement");
  if (input.statement.trim() === "") throw new PersonRefused("a statement needs text");
  if (input.statement.length > MAX_STATEMENT) throw new PersonRefused(`a statement is at most ${MAX_STATEMENT} characters`);
  if (input.detail.length > MAX_DETAIL) throw new PersonRefused(`how they know is at most ${MAX_DETAIL} characters`);
  const problem = aboutProblem(deps.registry, deps.observables, input.about);
  if (problem !== null) throw new PersonRefused(problem);
  const caseMarking = session.state.meta?.marking ?? "TLP:RED";
  if (input.marking !== null && MARKINGS.indexOf(input.marking) < MARKINGS.indexOf(caseMarking)) {
    throw new PersonRefused(`a statement cannot be marked below the case's ${caseMarking}`);
  }
  return strictest(caseMarking, ...floor, ...(input.marking === null ? [] : [input.marking]));
}

/** Records what the person knows as a card in Incoming and returns its id. Throws PersonRefused. */
export function addStatement(session: CaseSession, deps: RunnerDeps, input: { actor: Actor; statement: string; basis: PersonBasis; detail: string; about: Observable[]; marking: Marking | null }): string {
  const marking = checkStatement(session, deps, input);
  const detail = input.detail.trim();
  let id = "";
  session.commit((_s, ids) => {
    id = ids.next("card");
    const card = personCard(id, { title: statementTitle(input.statement), statement: input.statement, basis: input.basis, detail, about: input.about, answers: null, marking });
    return [{ type: "card.created", actor: input.actor, payload: { card } }];
  });
  return id;
}
