// note_memory (slice 13): an agent writes a short note into the case's notebook for the stages and runs after it. It writes memory.noted
// as the agent; the notebook's rules are src/pipeline/notes.ts's. This file does not import the shared store.
import type { Json } from "../../core/canonical";
import { liveNotes, NOTE_CARDS_MAX, NOTE_TEXT_MAX } from "../../core/state";
import type { NoteKind } from "../../core/types";
import { noteMemory } from "../../pipeline/notes";
import type { ToolContext, ToolDef, ToolResult } from "./index";
import { idArg, params, str } from "./kit";

async function noteTool(ctx: ToolContext, a: Record<string, Json>): Promise<ToolResult> {
  const cards = Array.isArray(a.cards) ? a.cards.filter((c): c is string => typeof c === "string") : [];
  const id = noteMemory(ctx.session, { kind: str(a.kind) as NoteKind, text: str(a.text), cards, actor: ctx.actor, link: ctx.link, max_notes: ctx.max_notes, secrets: ctx.deps.secrets?.() ?? [] });
  const notes = liveNotes(ctx.session.state).length;
  return { ok: true, summary: `noted ${id}`, view: { noted: id, notes }, marking: null };
}

export const MEMORY_TOOLS: ToolDef[] = [
  {
    name: "note_memory",
    description: "Write a short note into this case's notebook for the stages and runs that come after you: a fact learned, a decision made, or a pointer to a card. A note is not evidence; cite cards, not notes.",
    parameters: params({
      kind: { type: "string", enum: ["fact", "decision", "pointer"], description: "what the note is" },
      text: { type: "string", minLength: 1, maxLength: NOTE_TEXT_MAX, description: "the note, as a later stage will read it" },
      cards: { type: "array", items: idArg, maxItems: NOTE_CARDS_MAX, description: "ids of the cards the note is about" },
    }, ["kind", "text"]),
    call: noteTool,
  },
];
