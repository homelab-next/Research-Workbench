// The person adds what they know (slice 8): a statement becomes a card of theirs in Incoming. No query is sent and nothing moves.
import type { Json } from "../core/canonical";
import type { Schema } from "../core/schema";
import { MARKINGS, PERSON_BASES } from "../core/types";
import type { Marking, Observable, PersonBasis } from "../core/types";
import { addStatement } from "../pipeline/person";
import { defineCommand } from "./commands";

const str: Schema = { type: "string" };
const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({ type: "object", properties, required, additionalProperties: false });

/** The `about` argument as observables: a fresh list of fresh values. */
export const aboutArg = (a: Record<string, Json>): Observable[] =>
  a.about === undefined ? [] : (a.about as { type: string; value: string }[]).map((o): Observable => ({ type: o.type, value: o.value }));

/** The schema of an `about` list: values with a type and a value. Its length and the types are checked against the root by aboutProblem. */
export const ABOUT_SCHEMA: Schema = { type: "array", items: obj({ type: str, value: str }) };

defineCommand("add_statement", {
  args: obj({
    statement: str, basis: { enum: [...PERSON_BASES] }, detail: str, about: ABOUT_SCHEMA, marking: { enum: [...MARKINGS, null] },
  }, ["statement", "basis"]),
  then: "nothing",
  perform: ({ session, deps, actor }, a) => {
    addStatement(session, deps.runner, {
      actor, statement: a.statement as string, basis: a.basis as PersonBasis, detail: a.detail === undefined ? "" : (a.detail as string),
      about: aboutArg(a), marking: a.marking === undefined ? null : (a.marking as Marking | null),
    });
  },
});
