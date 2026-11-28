// A case's type and its notebook (slice 13), as the person's commands on the case. A note is added, revised or dropped in the person's name; the
// case's type is set (or cleared) by the person, and during a run the same commit binds memory again, so the stages that start afterwards read
// the lessons of the new type. When the type answers the question Frame put to the person, the run held for it goes on, as an answer does.
import type { Schema } from "../core/schema";
import { waitingOn } from "../core/state";
import { NOTE_KINDS } from "../core/types";
import type { NoteKind } from "../core/types";
import { dropMemory, noteMemory, reviseMemory } from "../pipeline/notes";
import { defineCommand } from "./commands";

const str: Schema = { type: "string" };
const kind: Schema = { enum: [...NOTE_KINDS] };
const cards: Schema = { type: "array", items: str };

defineCommand("note_memory", {
  args: { type: "object", additionalProperties: false, required: ["kind", "text"], properties: { kind, text: str, cards } },
  then: "nothing",
  perform: ({ session, deps, actor }, a) => {
    noteMemory(session, { kind: a.kind as NoteKind, text: a.text as string, ...(a.cards === undefined ? {} : { cards: a.cards as string[] }), actor, max_notes: deps.config.memory.max_notes, secrets: deps.runner.secrets?.() ?? [] });
  },
});

defineCommand("revise_memory", {
  args: { type: "object", additionalProperties: false, required: ["item", "kind", "text"], properties: { item: str, kind, text: str, cards } },
  then: "nothing",
  perform: ({ session, deps, actor }, a) => {
    reviseMemory(session, { item: a.item as string, kind: a.kind as NoteKind, text: a.text as string, ...(a.cards === undefined ? {} : { cards: a.cards as string[] }), actor, secrets: deps.runner.secrets?.() ?? [] });
  },
});

defineCommand("drop_memory", {
  args: { type: "object", additionalProperties: false, required: ["item", "reason"], properties: { item: str, reason: str } },
  then: "nothing",
  perform: ({ session, deps, actor }, a) => { dropMemory(session, { item: a.item as string, reason: a.reason as string, actor, secrets: deps.runner.secrets?.() ?? [] }); },
});

defineCommand("set_case_type", {
  args: { type: "object", additionalProperties: false, required: ["type"], properties: { type: { type: ["string", "null"] } } },
  then: "nothing",
  perform: ({ hub, case: id, engine, session, actor }, a) => {
    engine.setCaseType({ type: a.type as string | null, actor });
    // the run held for Frame's question of the case's type goes on once nothing it waits on is left: the person's resume, by their choice
    const { run } = session.state;
    if (run.status === "paused" && run.hold?.kind === "question" && waitingOn(session.state, run.hold.stage).length === 0) hub.follow(id, engine.resume(actor));
  },
});
