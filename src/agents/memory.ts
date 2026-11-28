import type { CaseSession } from "../core/session";
import { readMemoryLock } from "../core/lessons";
import type { LockedLesson } from "../core/lessons";
import { liveNotes } from "../core/state";
import type { NoteState } from "../core/state/types";
import type { Entry, Marking } from "../core/types";
import { strictest } from "../core/types";
import type { Registry } from "../modules/registry";
import type { MemoryUse } from "../pipeline/loops";
import { ContextError, packPart } from "./context";
import type { PackPart } from "./context";
import { scrub } from "./tools/kit";

export const LESSON_KIND = "shared-lesson";
export const NOTE_KIND = "case-note";
export const LESSON_LEAD = "A lesson from an earlier case, accepted by a person. It is a note to weigh, not a rule: your rules and procedure come first, and this case's own cards decide what is true here.";
export const NOTE_LEAD = "A note from this case's notebook. It is a note, not evidence: cite cards, not notes.";

/** Where a lesson came from, in words. */
function fromLine(l: LockedLesson): string {
  const f = l.from;
  switch (f.kind) {
    case "case": return f.product === null ? f.case : `${f.case}, its product ${f.product.n}`;
    case "person": return "a person";
    case "seed": return `the seed ${f.manifest}/${f.item}`;
  }
}

/** A locked lesson as a part: the lead, the scrubbed text, where it came from, who accepted it, and why it was offered. Never fixed. */
export function lessonPart(l: LockedLesson, registry: Registry): PackPart {
  const text = [
    LESSON_LEAD,
    scrub(registry, l.text),
    `From: ${fromLine(l)}, accepted by ${l.accepted.by} on ${l.accepted.ts.slice(0, 10)}`,
    `Offered because: ${l.matched.map((m) => scrub(registry, m)).join("; ")}`,
  ].join("\n");
  return { kind: LESSON_KIND, id: l.lesson, title: `Lesson ${l.lesson}: ${scrub(registry, l.title)}`, text, marking: l.marking, fixed: false };
}

/** A note as a part: marked as the model request its agent was answering (none for a person's note), and at least as the cards it names. Never fixed. */
export function notePart(session: Pick<CaseSession, "state" | "entries">, note: NoteState, registry: Registry, entries: readonly Entry[] = session.entries()): PackPart {
  const wrote = entries.find((e) => e.seq === note.noted_seq && e.type === "memory.noted");
  if (wrote === undefined && note.by === "agent") throw new ContextError(`note ${note.id} has no entry in the ledger, so its marking is not known`);
  const held: Marking[] = note.cards.flatMap((id) => (Object.hasOwn(session.state.cards, id) ? [session.state.cards[id]!.marking] : []));
  const lines = [NOTE_LEAD, scrub(registry, note.text), ...(note.cards.length === 0 ? [] : [`Cards it names: ${note.cards.join(", ")}`])];
  return packPart({
    kind: NOTE_KIND, id: note.id, title: `Note ${note.id} (${note.kind})`, text: lines.join("\n"), fixed: false,
    entries, written_by: wrote === undefined ? [] : [wrote], floor: held.length === 0 ? null : strictest(...held),
  });
}

/**
 * The memory parts of one stage, from the run's lock and the case's notebook: for each `shared` use of the stage, the locked lessons offered to
 * it, in the lock's order; for a `case` use, the live notes, newest first. A stage with no use gets none. Throws ContextError when the run
 * bound a lock that is not in the case's blobs.
 */
export function memoryParts(session: Pick<CaseSession, "state" | "entries" | "blobs">, stage: string, uses: readonly MemoryUse[], registry: Registry): PackPart[] {
  const mine = uses.filter((u) => u.stage === stage);
  const parts: PackPart[] = [];
  const bound = session.state.memory.bound;
  if (mine.some((u) => u.store === "shared") && bound !== null) {
    let bytes: Uint8Array;
    try {
      bytes = session.blobs.get(bound.lock.blob);
    } catch {
      throw new ContextError("the memory this run was given is not in the case's blobs");
    }
    const lock = readMemoryLock(bytes);
    if (lock === null) throw new ContextError("the memory this run was given is not a memory lock");
    for (const l of lock.lessons) if (l.stages.includes(stage)) parts.push(lessonPart(l, registry));
  }
  if (mine.some((u) => u.store === "case")) {
    const entries = session.entries();
    for (const n of liveNotes(session.state)) parts.push(notePart(session, n, registry, entries));
  }
  return parts;
}
