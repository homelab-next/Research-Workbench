// The Feedback stage's question (slice 13): what would have made this case faster or more correct. The model's answer is at most three lessons;
// code checks each, marks it at least the case's, the product's and the pass's model requests', and files it through the memory host as a
// proposal from the case. Nothing here accepts: a lesson is shared only by a person. A published run never waits on lessons, so a model that
// fails, declines or is blocked files nothing and the stage passes with the reason.
import { isPlainObject } from "../core/canonical";
import type { Json } from "../core/canonical";
import { draftProblem } from "../core/lessons";
import type { LessonDraft } from "../core/lessons";
import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import { isMarking, strictest } from "../core/types";
import type { Draft, Entry, LessonOrigin, Marking } from "../core/types";
import { ContextError } from "../agents/context";
import type { PackPart } from "../agents/context";
import { citedOf } from "../agents/draft";
import { scrub } from "../agents/tools/kit";
import type { StageEnv } from "./engine";
import { citedCardParts, draftPart, stageAgent, titleOf } from "./stages/agent";

export const LESSONS_QUESTION = "What would have made this case faster or more correct?";
export const MAX_PROPOSED = 3;

const NO_STORE = "this workbench has no memory store here";
const SECRET = "the lesson holds a secret value";
const nothing = (why: string): string => `no lessons were proposed: ${why}`;
const firstLine = (t: string): string => t.split("\n")[0]!.slice(0, 300);

/** The stage's latest stage.started in the case's current run; null before it starts. */
function startedOf(session: CaseSession, stage: string): Entry | null {
  const run = session.state.run.id;
  const entries = session.entries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === "stage.started" && e.payload.stage === stage && e.run === run) return e;
  }
  return null;
}

/** The latest product published in the case's current run, with its number and draft; null when the run published none. */
export function publishedOfRun(session: CaseSession): { n: number; draft: Draft } | null {
  const { state } = session;
  if (state.run.id === null) return null;
  const entries = session.entries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === "run.started" && e.payload.run === state.run.id) return null;
    if (e.type !== "product.published" || e.run !== state.run.id) continue;
    const draft = state.drafts.find((d) => d.hash === e.payload.draft_hash);
    return draft === undefined ? null : { n: e.payload.n, draft };
  }
  return null;
}

/** The marking a lesson written in this stage pass has at least: the case's, its latest published product's, and each model request's of the pass. */
export function lessonFloor(session: CaseSession, stage: string): Marking {
  const { state } = session;
  const markings: Marking[] = [];
  if (state.meta !== null) markings.push(state.meta.marking);
  const latest = state.published.at(-1);
  const product = latest === undefined ? undefined : state.drafts.find((d) => d.hash === latest.draft_hash)?.product.marking;
  if (isMarking(product)) markings.push(product);
  const started = startedOf(session, stage)?.seq ?? 0;
  for (const e of session.entries()) {
    if (e.type === "model.request" && e.stage === stage && e.seq > started && isMarking(e.payload.marking)) markings.push(e.payload.marking);
  }
  // a case with no record has nothing to compare with: the strictest there is
  return markings.length === 0 ? strictest(null) : strictest(...markings);
}

/** One answered lesson as the model gave it: its title as given, and the draft code builds from it (draftProblem decides whether it is one). */
function draftOf(x: unknown, caseType: string, marking: Marking): { title: string; draft: unknown } {
  if (!isPlainObject(x)) return { title: "", draft: null };
  return {
    title: typeof x.title === "string" ? x.title : "",
    draft: { case_type: caseType, title: x.title, text: x.text, triggers: x.triggers, marking, supersedes: null },
  };
}

/** Asks the stage's model the question and files what it answers. Returns the stage's output. Never throws for a model's failure. */
export async function proposeLessons(env: StageEnv): Promise<{ output: Json; reason: string | null; stopped: boolean }> {
  const { session, deps, stage } = env;
  const host = deps.memory;
  if (host === undefined) return { output: null, reason: NO_STORE, stopped: false };
  const state = session.state;
  const caseType = state.memory.type;
  const published = publishedOfRun(session);
  if (caseType === null || published === null || state.meta === null) return { output: null, reason: null, stopped: false };
  const meta = state.meta;
  const run = state.run.id;
  const title = deps.case_types?.find((t) => t.id === caseType)?.title ?? caseType;
  // the head when the stage started: a resumed stage files the same origin, and the store answers that it is filed already
  const started = startedOf(session, stage.id);
  const head = started === null ? session.head() : { seq: started.seq, hash: started.hash };
  const d = published.draft;

  let extras: PackPart[];
  try {
    extras = [draftPart(session, d), ...citedCardParts(session, deps.registry, d)];
  } catch (err) {
    if (err instanceof ContextError) return { output: null, reason: nothing(`${titleOf(env)}: ${firstLine(err.message)}`), stopped: false };
    throw err;
  }
  const task = [
    LESSONS_QUESTION,
    `Answer with at most ${MAX_PROPOSED} lessons for later cases of type ${caseType} (${title}). Each is a short title, the text of the lesson (what to do, and why it would have helped here), and when it applies: an observable type the case holds, a source it used, or words a finding contains. Write nothing that names this case's people, hosts or addresses. A lesson is a note for a later analyst and agent, not a rule.`,
  ].join("\n");
  const end = await stageAgent(env, { actor_id: deps.profile.stages[stage.id]?.agent ?? "reviewer", task, extras, draft_hash: d.hash, cited: citedOf(d) });
  switch (end.kind) {
    case "output": break;
    case "stopped": return { output: null, reason: null, stopped: true };
    case "blocked": return { output: null, reason: nothing(`the stage's model may not receive data marked ${end.marking}`), stopped: false };
    case "declined": case "stalled": case "waiting_child": return { output: null, reason: nothing(end.reason), stopped: false };
  }
  const answered = isPlainObject(end.output) && Array.isArray(end.output.lessons) ? end.output.lessons : null;
  if (answered === null) return { output: null, reason: nothing("the answer holds no list of lessons"), stopped: false };
  // the schema holds the answer to three; a root whose schema does not is held to it here
  if (answered.length > MAX_PROPOSED) return { output: null, reason: nothing(`the answer holds more than ${MAX_PROPOSED} lessons`), stopped: false };

  // read after the model answered: the pass's requests are part of the floor
  const marking = lessonFloor(session, stage.id);
  const from: LessonOrigin = {
    kind: "case", case: meta.id, origin: session.entries()[0]!.hash, run, head,
    product: { n: published.n, draft_hash: d.hash }, stage: stage.id, model: true,
  };
  const lessons: Json[] = [];
  const dropped: Json[] = [];
  answered.forEach((x, i) => {
    const { title: given, draft } = draftOf(x, caseType, marking);
    const shown = scrub(deps.registry, given);
    const problem = draftProblem(draft);
    if (problem !== null) {
      dropped.push({ title: shown, why: problem });
      return;
    }
    try {
      const r = host.propose(draft as LessonDraft, from);
      lessons.push({ lesson: r.lesson, title: shown, fresh: r.fresh });
    } catch (err) {
      // a store that fails other than by refusing is a fault, not a model's: the engine pauses the run on it, and a resume files the rest once
      if (!(err instanceof Refused)) throw err;
      // a lesson refused for a secret value is not named by its own title, which may hold the value
      dropped.push({ title: err.message === SECRET ? `lesson ${i + 1} of the answer` : shown, why: err.message });
    }
  });
  return { output: { lessons, dropped }, reason: null, stopped: false };
}
