import type { CaseState, StageState } from "../core/state";
import { blockers, latestDraft, publishable } from "../core/state";
import type { RunHold } from "../core/types";
import { pointsOf, reviewConflict, uncitableNote } from "./conflict";
import type { ConflictFound } from "./conflict";
import type { Pipeline, StageManifest } from "./manifests";

export const SEND_BACK_CAP = 3;
/**
 * A stage started this many times on one draft, not counting the starts that were send-backs, pauses the run. A person's resume past it grants a
 * fresh allowance of as many for that stage; a new draft begins the count again.
 */
const MAX_REPEATS = 5;

export type Step =
  | { kind: "idle" }
  | { kind: "start"; stage: string; attempt: number; sent_back: { from: string; to: string; reason: string; count: number } | null }
  | { kind: "exec"; stage: string }
  | { kind: "gate"; gate: "plan" | "publish" }
  /** `conflicts`: reviewers' disagreements found now, to be recorded with the pause; `hold`: what a person's resume of it does besides. */
  | { kind: "pause"; reason: string; conflicts?: ConflictFound[]; hold?: RunHold }
  | { kind: "finish"; outcome: "published" | "stopped" };

const IDLE: Step = { kind: "idle" };

/** The first review stage, in pipeline order, that has not passed the latest draft; null when all have, or there is no draft. */
export function firstUnpassedReview(state: Readonly<CaseState>, pipeline: Pipeline): string | null {
  const draft = latestDraft(state as CaseState);
  if (draft === null) return null;
  const passed = Object.hasOwn(state.reviews, draft.hash) ? state.reviews[draft.hash]!.passed_stages : [];
  return pipeline.stages.find((s) => s.reviews && !passed.includes(s.id))?.id ?? null;
}

/**
 * What the engine does next, from the state alone, so a restart resumes exactly where the ledger says it was.
 * Pure: it reads, never writes, and the same state gives the same step. `likelihood` is the standard's terms, least likely first, which a conflict
 * between reviewers is described with.
 */
export function nextStep(state: Readonly<CaseState>, pipeline: Pipeline, opts: { allow_capped?: boolean; likelihood?: readonly string[] } = {}): Step {
  const { run } = state;
  if (run.status !== "running") return IDLE;
  const manifest = (id: string): StageManifest | null => pipeline.stages.find((s) => s.id === id) ?? null;
  const stateOf = (id: string): StageState | null => run.stages.find((s) => s.id === id) ?? null;
  const title = (id: string): string => stateOf(id)?.title ?? id;
  const attemptsOf = (id: string): number => stateOf(id)?.attempts ?? 0;
  const latest = latestDraft(state as CaseState)?.hash ?? null;
  /** Starts of the stage on the latest draft that were not send-backs, less those a person's resume set aside; send-backs are bounded by SEND_BACK_CAP. */
  const startsWithoutSendBack = (id: string): number => {
    const r = Object.hasOwn(run.repeats, id) ? run.repeats[id]! : null;
    return r === null || r.draft !== latest ? 0 : r.starts - r.sent_back - r.base;
  };
  /** A stage the run does not know pauses; a stage started again with no send-back, five times already on this draft, pauses (a loop that goes nowhere). */
  const begin = (stage: string, sent_back: { from: string; to: string; reason: string; count: number } | null = null, again = true): Step => {
    if (stateOf(stage) === null) return { kind: "pause", reason: `the stage ${stage} is not part of this run` };
    if (again && sent_back === null && startsWithoutSendBack(stage) >= MAX_REPEATS && opts.allow_capped !== true) {
      return { kind: "pause", reason: `${title(stage)} has run ${MAX_REPEATS} times`, hold: { kind: "stage_runs", stage } };
    }
    return { kind: "start", stage, attempt: attemptsOf(stage) + 1, sent_back };
  };

  if (run.current === null) {
    const first = run.stages[0];
    return first === undefined ? IDLE : { kind: "start", stage: first.id, attempt: 1, sent_back: null };
  }
  const st = stateOf(run.current);
  const m = manifest(run.current);
  if (st === null || m === null) return { kind: "pause", reason: `the current stage ${run.current} is not in the pipeline` };

  switch (st.status) {
    case "running": return { kind: "exec", stage: st.id };
    case "idle":
    case "blocked":
    case "declined": return begin(st.id);
    case "waiting": return IDLE;
    case "failed": {
      let reason = st.last_reason ?? "";
      if (m.on_fail === null) return { kind: "pause", reason: `${st.title} failed: ${reason}` };
      // reviewers who disagree go to the person, not back to the analyst; a person's ruling goes back to the analyst
      const conflict = reviewConflict(state, pipeline, st.id, opts.likelihood ?? null);
      if (conflict !== null && conflict.kind === "conflict") return { kind: "pause", reason: conflict.reason, conflicts: conflict.fresh };
      if (conflict !== null && conflict.kind === "only_ruled") return { kind: "pause", reason: conflict.reason, hold: { kind: "ruled", stage: st.id } };
      if (conflict !== null) reason = conflict.reason;
      if (m.role === "evaluate" || m.role === "challenge") {
        const d = latestDraft(state as CaseState);
        const note = d === null ? null : uncitableNote(state, pointsOf(state, m.role, d.hash));
        if (note !== null) reason = `${reason} ${note}`;
      }
      const edge = `${st.id}>${m.on_fail}`;
      const n = Object.hasOwn(run.sendbacks, edge) ? run.sendbacks[edge]! : 0;
      // the cap counts since a person's resume past it last set the count aside
      const base = Object.hasOwn(run.sendback_base, edge) ? run.sendback_base[edge]! : 0;
      if (n - base >= SEND_BACK_CAP && opts.allow_capped !== true) {
        return { kind: "pause", reason: `${st.title} has sent work back to ${title(m.on_fail)} ${SEND_BACK_CAP} times. Last reason: ${reason}`, hold: { kind: "send_back", edge } };
      }
      return begin(m.on_fail, { from: st.id, to: m.on_fail, reason, count: n + 1 });
    }
    case "passed": break;
  }

  if (m.gate === "plan") {
    switch (state.plan.status) {
      case "proposed": return { kind: "gate", gate: "plan" };
      case "replanning": return begin(st.id, null, false);
      case "denied": return IDLE;
      case "none": return { kind: "pause", reason: "the plan stage finished without a plan" };
      case "accepted": break;
    }
  }
  const draft = latestDraft(state as CaseState);
  if (m.gate === "publish" && !(draft !== null && state.published.some((p) => p.draft_hash === draft.hash))) {
    if (draft === null) return { kind: "pause", reason: "there is no draft to review" };
    const unpassed = firstUnpassedReview(state, pipeline);
    if (unpassed !== null) return begin(unpassed);
    // every review passed; a failed check, a failed evaluation or an open must-address challenge still stops it
    return publishable(state as CaseState, draft.hash) ? { kind: "gate", gate: "publish" } : { kind: "pause", reason: `${blockers(state as CaseState, draft.hash).join(". ")}.` };
  }
  if (m.on_pass === null) return { kind: "finish", outcome: state.published.length > 0 ? "published" : "stopped" };
  const target = manifest(m.on_pass);
  if (target === null) return { kind: "pause", reason: `the stage after ${st.title} (${m.on_pass}) is not in the pipeline` };
  if (target.reviews || target.gate === "publish") {
    if (draft === null) return { kind: "pause", reason: "there is no draft to review" };
    const unpassed = firstUnpassedReview(state, pipeline);
    if (unpassed !== null) return begin(unpassed);
  }
  return begin(target.id);
}
