import { latestDraft, namesFinding, ruledFindings, rulingText, runConflicts } from "../core/state";
import type { CaseState } from "../core/state";
import { CONFIDENCES } from "../core/types";
import type { ReviewConflict } from "../core/types";
import type { Pipeline, Role } from "./manifests";
import { findingChanges } from "./review-points";

/** A conflict found and not yet recorded: what `review.conflict` will hold, less its id. */
export type ConflictFound = Omit<ReviewConflict, "id">;

/**
 * What a failed review means when the reviewers disagree:
 * - conflict: the failing reviewer's point would reverse a change the analyst made for the other reviewer. The run pauses for the person; `fresh`
 *   are the conflicts not yet recorded.
 * - ruled: the person has ruled on this draft's conflict; the work goes back to the analyst with the ruling as the reason.
 * - only_ruled: every point the reviewer raised is on a finding the person has ruled on; it is not sent back.
 */
export type ConflictStep =
  | { kind: "conflict"; fresh: ConflictFound[]; reason: string }
  | { kind: "ruled"; reason: string }
  | { kind: "only_ruled"; reason: string };

const REVIEWERS: readonly Role[] = ["evaluate", "challenge"];

/** The points a review stage holds against a draft: a failed evaluation's findings, or the must-address challenges open on it. */
export function pointsOf(state: Readonly<CaseState>, role: Role, hash: string): string[] {
  if (role === "evaluate") {
    const ev = Object.hasOwn(state.reviews, hash) ? state.reviews[hash]!.evaluation : null;
    return ev === null || ev.pass ? [] : ev.findings.map((f) => `${f.where}: ${f.message}`);
  }
  if (role === "challenge") {
    return Object.values(state.challenges).filter((c) => c.draft_hash === hash && c.status === "open" && c.severity === "must_address").map((c) => `${c.id}: ${c.text}`);
  }
  return [];
}

const titleOf = (state: Readonly<CaseState>, pipeline: Pipeline, id: string): string =>
  state.run.stages.find((s) => s.id === id)?.title ?? pipeline.stages.find((s) => s.id === id)?.title ?? id;

/** Which way a value moved along an ordered scale: "lower", "higher", or the value itself when the scale does not hold both. */
function direction(scale: readonly string[] | null, from: string, to: string, unit = ""): string {
  const a = scale === null ? -1 : scale.indexOf(from);
  const b = scale === null ? -1 : scale.indexOf(to);
  const tail = unit === "" ? "" : ` ${unit}`;
  if (a < 0 || b < 0) return `${to}${tail}`;
  return `${b < a ? "lower" : "higher"}${tail}`;
}

/**
 * Whether the failure of review stage `stage` on the latest draft is a disagreement between the reviewers, from the state alone (nextStep calls it).
 * A conflict: the latest draft was made for the other reviewer's send-back, it moved a finding (likelihood or confidence changed, the finding dropped
 * or added), and this reviewer's point names that same finding, so following it would move the finding back. A finding the person has ruled on is
 * not a conflict again. `likelihood` is the standard's terms, least likely first, to say which way a likelihood moved.
 */
export function reviewConflict(state: Readonly<CaseState>, pipeline: Pipeline, stage: string, likelihood: readonly string[] | null): ConflictStep | null {
  const m = pipeline.stages.find((s) => s.id === stage);
  if (m === undefined || !REVIEWERS.includes(m.role)) return null;
  const d = latestDraft(state as CaseState);
  if (d === null) return null;
  const points = pointsOf(state, m.role, d.hash);
  if (points.length === 0) return null;
  const conflicts = runConflicts(state);
  const onDraft = conflicts.filter((c) => c.draft_hash === d.hash && c.raised_by === stage);
  const open = onDraft.filter((c) => c.ruling === null);
  if (open.length > 0) return { kind: "conflict", fresh: [], reason: pauseReason(open.map((c) => c.reason)) };
  const ruledHere = onDraft.filter((c) => c.ruling !== null);
  if (ruledHere.length > 0) {
    return { kind: "ruled", reason: ruledHere.map((c) => `the person ruled on ${c.finding} (${c.reason}): ${rulingText(state, c)}`).join("; ") };
  }
  const ruled = new Set(ruledFindings(state).keys());

  const madeFor = Object.hasOwn(state.made_for, d.hash) ? state.made_for[d.hash]! : null;
  const other = madeFor === null ? undefined : pipeline.stages.find((s) => s.id === madeFor);
  const before = state.drafts.length >= 2 ? state.drafts[state.drafts.length - 2]! : null;
  if (other !== undefined && other.id !== stage && REVIEWERS.includes(other.role) && before !== null) {
    const R = titleOf(state, pipeline, stage);
    const O = titleOf(state, pipeline, other.id);
    const fresh: ConflictFound[] = [];
    for (const c of findingChanges(before.product, d.product)) {
      if (c.change === "reworded" || ruled.has(c.finding)) continue;
      const named = points.filter((p) => namesFinding(p, c.finding));
      if (named.length === 0) continue;
      let asks: string;
      let asked: string;
      switch (c.change) {
        case "likelihood": asks = c.earlier!; asked = direction(likelihood, c.earlier!, c.now!); break;
        case "confidence": asks = `${c.earlier} confidence`; asked = direction(CONFIDENCES, c.earlier!, c.now!, "confidence"); break;
        case "dropped": asks = `to restore ${c.finding}`; asked = "to drop it"; break;
        case "added": asks = `to drop ${c.finding}`; asked = "to add it"; break;
      }
      fresh.push({
        draft_hash: d.hash, finding: c.finding, change: c.change, earlier: c.earlier, now: c.now, raised_by: stage, changed_for: other.id, asks, asked, points: named,
        reason: `${R} and ${O} disagree on ${c.finding}: ${R} asks ${asks}, ${O} asked ${asked}`,
      });
    }
    if (fresh.length > 0) return { kind: "conflict", fresh, reason: pauseReason(fresh.map((c) => c.reason)) };
  }
  // a point on a ruled finding is not sent back: when that is all the reviewer raised, the run waits for the person
  const onRuled = [...ruled].filter((f) => points.some((p) => namesFinding(p, f)));
  if (onRuled.length > 0 && points.every((p) => onRuled.some((f) => namesFinding(p, f)))) {
    const R = titleOf(state, pipeline, stage);
    return { kind: "only_ruled", reason: `${R} objects only to ${onRuled.join(", ")}, which the person has ruled on; a ruled point is not sent back. Edit the draft, or resume for ${R} to review it again.` };
  }
  return null;
}

const pauseReason = (reasons: string[]): string => `${reasons.join(". ")}. The person rules on it in the Narrative lens: follow one reviewer, or write a note.`;
