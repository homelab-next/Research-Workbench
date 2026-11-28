// The Reflect stage of an improve loop (slice 14): once the Judge has scored the run, the stage's model is given Compose's choice, the
// contrasts and the scores, and asked what would make later cases of the type faster or more correct. Code checks each answered lesson, marks
// it at least the improve case's and the pass's model requests', and files it through the memory host as a proposal from the improve case's
// Reflect stage. It is given scores, never answers: the sheet names an expected finding by its number, and no part holds an answer's text or a
// claim, since a lesson reaches later cases and later Propose runs. Nothing here accepts: a lesson is shared only by a person.
import { isPlainObject } from "../../core/canonical";
import type { Json } from "../../core/canonical";
import { draftProblem } from "../../core/lessons";
import type { LessonDraft } from "../../core/lessons";
import { Refused } from "../../core/refused";
import type { CaseSession } from "../../core/session";
import { BASE, readContrasts, readScoreSheet } from "../../core/state";
import type { Contrast, ScoreSheet } from "../../core/state";
import type { Entry, LessonOrigin, Marking } from "../../core/types";
import { ContextError } from "../../agents/context";
import type { PackPart } from "../../agents/context";
import { scrub } from "../../agents/tools/kit";
import type { StageEnd, StageRunner } from "../engine";
import { MAX_PROPOSED, lessonFloor } from "../lessons";
import { stageAgent, titleOf } from "../stages/agent";

const NO_STORE = "this workbench has no memory store here";
/** The memory store's refusal of a lesson that holds a secret value: its title is not repeated. */
const SECRET = "the lesson holds a secret value";
const NOT_SCORED = "the judge has not scored this run";
const nothing = (why: string): string => `no lessons were proposed: ${why}`;
const firstLine = (t: string): string => t.split("\n")[0]!.slice(0, 300);
const pass = (output: Json, reason: string | null): StageEnd => ({ kind: "finished", outcome: "pass", draft_hash: null, output, reason });

/** The question Reflect asks, for the request's case type. */
export const reflectQuestion = (caseType: string): string =>
  `What would make later ${caseType} cases faster or more correct? Answer with at most ${MAX_PROPOSED} lessons, each from a difference between the probes that the scores bear out.`;

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

/** The run in progress has its scores: this run's selection, Compose's choice and judge.scored (the fold clears both on a new selection). */
function scoredThisRun(session: CaseSession): boolean {
  const i = session.state.improve;
  return i.selected !== null && i.selected.run === session.state.run.id && i.chosen !== null && i.scored !== null;
}

const shownPair = (p: [string, string] | null, what: string): string | null => (p === null ? null : `${what} ${p[0]} to ${p[1]}`);

/** One contrast in words: the produced findings a candidate added, removed and changed against the base's, and what each spent. */
function contrastLines(c: Contrast): string[] {
  const lines = [`${c.candidate} on ${c.task}: the base ${c.base}, ${c.candidate} ${c.now}; lookups ${c.lookups[0]} to ${c.lookups[1]}; tokens ${c.tokens[0]} to ${c.tokens[1]}.`];
  for (const a of c.added) lines.push(`  added: ${a}`);
  for (const r of c.removed) lines.push(`  removed: ${r}`);
  for (const ch of c.changed) {
    const what = [shownPair(ch.likelihood, "likelihood"), shownPair(ch.confidence, "confidence")].filter((x): x is string => x !== null).join(", ");
    lines.push(`  changed: ${ch.statement}${what === "" ? "" : ` (${what})`}`);
  }
  return lines;
}

/** The sheet in words: the summary, then each output's score and each expected finding by its number (never its claim). */
function scoreLines(sheet: ScoreSheet): string[] {
  const lines = [`Likelihood scale, least likely first: ${sheet.scale.join(", ")}.`, "Summary (each score from 0 to 1000):"];
  for (const r of sheet.summary) lines.push(`  ${r.candidate}: ${r.score} (${r.drafted} of ${r.tasks} tasks drafted)${r.candidate === BASE ? ", the unchanged loop" : ""}`);
  for (const o of sheet.outputs) {
    const text = o.text === null ? "" : `; the product ${o.text} with the answer's text`;
    lines.push(`${o.probe} (${o.outcome}): ${o.score === null ? "unscored" : o.score}${text}`);
    for (const f of o.findings) {
      if (f.produced === null) {
        lines.push(`  expected finding ${f.expected + 1}: not matched; score ${f.score}`);
        continue;
      }
      const d = [
        f.similarity === null ? null : `similarity ${f.similarity}`,
        f.likelihood_distance === null ? null : `likelihood distance ${f.likelihood_distance}`,
        f.confidence_distance === null ? null : `confidence distance ${f.confidence_distance}`,
      ].filter((x): x is string => x !== null).join(", ");
      lines.push(`  expected finding ${f.expected + 1}: matched by ${f.by ?? "code"} to "${f.produced}"${d === "" ? "" : ` (${d})`}; score ${f.score}`);
    }
    for (const l of o.left_over) lines.push(`  produced, matching no expected finding: ${l}`);
  }
  return lines;
}

/**
 * What Reflect's model is given: Compose's choice and its reason, the contrasts in words, and the score sheet's summary and outputs. The
 * answers' blob is never read here. Throws ContextError when the run has no scores or a blob of them cannot be read.
 */
export function reflectParts(session: CaseSession): PackPart[] {
  const { state } = session;
  const i = state.improve;
  if (!scoredThisRun(session)) throw new ContextError(NOT_SCORED);
  const chosen = i.chosen!;
  const scored = i.scored!;
  const contrasts = readContrasts(session.blobs.get(chosen.contrasts.blob));
  if (contrasts === null) throw new ContextError("the contrasts of this run cannot be read");
  const sheet = readScoreSheet(session.blobs.get(scored.scores.blob));
  if (sheet === null) throw new ContextError("the scores of this run cannot be read");
  const marking: Marking | null = state.meta?.marking ?? null;
  const choice = chosen.candidate === null
    ? `Compose chose no candidate: ${chosen.why}`
    : `Compose chose ${chosen.candidate} (the change ${i.candidates[chosen.candidate]?.change ?? "unknown"}): ${chosen.why}`;
  const candidates = i.candidate_order.map((k) => i.candidates[k]!).map((c) => `  ${c.candidate}: ${c.status}${c.reason === "" ? "" : ` (${c.reason})`}`);
  return [
    { kind: "improve-choice", id: "improve-choice", title: "Compose's choice", text: [choice, ...(candidates.length === 0 ? [] : ["Candidates:", ...candidates])].join("\n"), marking, fixed: true },
    {
      kind: "improve-contrasts", id: "improve-contrasts", title: "How each candidate's output differs from the base's",
      text: contrasts.length === 0 ? "No candidate was probed beside the base." : contrasts.flatMap(contrastLines).join("\n"), marking, fixed: true,
    },
    {
      kind: "improve-scores", id: "improve-scores", title: `The scores (matched ${scored.matcher === "code" ? "by code" : "by code and the Judge's model"})`,
      text: scoreLines(sheet).join("\n"), marking, fixed: true,
    },
  ];
}

/** One answered lesson as the model gave it: its title as given, and the draft code builds from it (draftProblem decides whether it is one). */
function draftOf(x: unknown, caseType: string, marking: Marking): { title: string; draft: unknown } {
  if (!isPlainObject(x)) return { title: "", draft: null };
  return {
    title: typeof x.title === "string" ? x.title : "",
    draft: { case_type: caseType, title: x.title, text: x.text, triggers: x.triggers, marking, supersedes: null },
  };
}

/**
 * Reflect: stalls unless this run has its scores. Then asks the stage's model and files what it answers as proposals of the request's case
 * type. A model that fails, declines or is blocked, a workbench with no store, or a refusal files nothing and the stage passes with the reason.
 * Filing is idempotent: the origin's head is the stage's start, so a resumed stage files the same origin and the store answers it is filed.
 */
export const reflectRunner: StageRunner = async (env) => {
  const { session, deps, stage } = env;
  const title = titleOf(env);
  const state = session.state;
  const request = state.improve.request;
  if (request === null || state.meta === null) return { kind: "stalled", reason: `${title}: this case is not an improve case` };
  if (!scoredThisRun(session)) return { kind: "stalled", reason: `${title}: ${NOT_SCORED}` };
  let extras: PackPart[];
  try {
    extras = reflectParts(session).map((p) => ({ ...p, title: scrub(deps.registry, p.title), text: scrub(deps.registry, p.text) }));
  } catch (err) {
    if (err instanceof ContextError) return { kind: "stalled", reason: `${title}: ${firstLine(err.message)}` };
    throw err;
  }
  const host = deps.memory;
  if (host === undefined) return pass(null, NO_STORE);
  const caseType = request.case_type;
  const typeTitle = deps.case_types?.find((t) => t.id === caseType)?.title ?? caseType;
  const started = startedOf(session, stage.id);
  const head = started === null ? session.head() : { seq: started.seq, hash: started.hash };
  const task = [
    reflectQuestion(caseType),
    `Each lesson is for later cases of type ${caseType} (${typeTitle}): a short title, the text of the lesson (what to do, and which difference between the probes and which scores bear it out), and when it applies: an observable type, a source, or words a finding contains. Write nothing that names a case's people, hosts or addresses. A lesson is a note for a later analyst and agent, not a rule.`,
  ].join("\n");
  const end = await stageAgent(env, { actor_id: deps.profile.stages[stage.id]?.agent ?? "analyst", task, extras });
  switch (end.kind) {
    case "output": break;
    case "stopped": return { kind: "stopped" };
    case "blocked": return pass(null, nothing(`the stage's model may not receive data marked ${end.marking}`));
    case "declined": case "stalled": case "waiting_child": return pass(null, nothing(end.reason));
  }
  const answered = isPlainObject(end.output) && Array.isArray(end.output.lessons) ? end.output.lessons : null;
  if (answered === null) return pass(null, nothing("the answer holds no list of lessons"));
  if (answered.length > MAX_PROPOSED) return pass(null, nothing(`the answer holds more than ${MAX_PROPOSED} lessons`));

  // read after the model answered: the pass's requests are part of the floor, with the improve case's own marking
  const marking = lessonFloor(session, stage.id);
  const from: LessonOrigin = {
    kind: "case", case: state.meta.id, origin: session.entries(0, 1)[0]!.hash, run: session.state.run.id, head, product: null, stage: stage.id, model: true,
  };
  const lessons: Json[] = [];
  const dropped: Json[] = [];
  answered.forEach((x, n) => {
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
      // a store that fails other than by refusing is a fault: the engine pauses the run on it, and a resume files the rest once
      if (!(err instanceof Refused)) throw err;
      // a lesson refused for a secret value is not named by its own title, which may hold the value
      dropped.push({ title: err.message === SECRET ? `lesson ${n + 1} of the answer` : shown, why: err.message });
    }
  });
  return pass({ lessons, dropped }, null);
};
