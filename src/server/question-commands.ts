// The person answers a question a stage put to them (slice 8): their answer is a card of theirs, and a run held for that stage's questions goes on once none is left.
import type { Schema } from "../core/schema";
import { waitingOn } from "../core/state";
import { MARKINGS, PERSON_BASES } from "../core/types";
import type { Marking, PersonBasis } from "../core/types";
import { answerQuestion } from "../pipeline/questions";
import { defineCommand } from "./commands";
import { ABOUT_SCHEMA, aboutArg } from "./statement-commands";

const str: Schema = { type: "string" };

defineCommand("answer_question", {
  args: {
    type: "object", additionalProperties: false, required: ["question", "answer"],
    properties: { question: str, answer: str, basis: { enum: [...PERSON_BASES] }, detail: str, about: ABOUT_SCHEMA, marking: { enum: [...MARKINGS, null] } },
  },
  then: "nothing",
  perform: ({ hub, engine, session, deps, actor }, a) => {
    answerQuestion(session, deps.runner, {
      actor, question: a.question as string, answer: a.answer as string, basis: a.basis === undefined ? "unstated" : (a.basis as PersonBasis),
      detail: a.detail === undefined ? "" : (a.detail as string),
      // no about given: the question's own values
      about: a.about === undefined ? null : aboutArg(a), marking: a.marking === undefined ? null : (a.marking as Marking | null),
    });
    // the run held for this stage's questions goes on once none is left: the person's resume, by their answer
    const { run } = session.state;
    if (run.status === "paused" && run.hold?.kind === "question" && waitingOn(session.state, run.hold.stage).length === 0) hub.background(engine.resume(actor));
  },
});
