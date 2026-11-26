import { latestDraft, namesFinding, ruledFindings, rulingText, runConflicts } from "../core/state";
import type { CaseState, ConflictState } from "../core/state";
import { CONFIDENCES } from "../core/types";
import type { Product, ReviewConflict } from "../core/types";
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
  const rulings = [...ruledFindings(state).values()];
  // a draft that does not hold a ruling goes back with the ruling, beside the reviewer's other points
  const unheld = rulings.filter((c) => holds(d.product, c) === false);
  if (unheld.length > 0) {
    const said = unheld.map((c) => `the draft does not hold the person's ruling on ${c.finding} (${c.reason}): ${rulingText(state, c)}`).join("; ");
    const rest = points.filter((p) => !rulings.some((c) => reopens(p, c)));
    return { kind: "ruled", reason: rest.length === 0 ? said : `${said}. Also: ${rest.join("; ")}` };
  }
  // a point that would move a ruled finding back is not sent back: when that is all the reviewer raised, the run waits for the person.
  // a ruling settles only what it was about: another point on the same finding (its cards, its wording) goes back as usual
  const onRuled = rulings.filter((c) => points.some((p) => reopens(p, c))).map((c) => c.finding);
  if (onRuled.length > 0 && points.every((p) => rulings.some((c) => reopens(p, c)))) {
    const R = titleOf(state, pipeline, stage);
    return { kind: "only_ruled", reason: `${R} objects only to ${onRuled.join(", ")}, which the person has ruled on; a ruled point is not sent back. Edit the draft, or resume for ${R} to review it again.` };
  }
  return null;
}

/** The value the person's ruling keeps: the reviewer they followed asked for it. Null for a ruling that follows neither (a note only). */
function ruledValue(c: ConflictState): { present: boolean; value: string | null } | null {
  if (c.ruling === null) return null;
  const keep = c.ruling.follow === c.changed_for ? true : c.ruling.follow === c.raised_by ? false : null;
  if (keep === null) return null;
  switch (c.change) {
    case "dropped": return { present: !keep, value: null };
    case "added": return { present: keep, value: null };
    case "likelihood":
    case "confidence": return { present: true, value: keep ? c.now : c.earlier };
  }
}

/** Whether the draft holds the ruling on its finding; null when the ruling keeps no value to check. */
export function holds(product: Product, c: ConflictState): boolean | null {
  const want = ruledValue(c);
  if (want === null) return null;
  const f = product.key_findings.find((x) => x.id === c.finding);
  if (!want.present || f === undefined) return want.present === (f !== undefined);
  if (c.change === "likelihood") return f.likelihood === want.value;
  if (c.change === "confidence") return f.confidence === want.value;
  return true;
}

const ABOUT: Record<ReviewConflict["change"], RegExp> = {
  likelihood: /likel|probab|chance|certain|overclaim|overstat|understat/i,
  // whole words only: "confidence_basis" is a field, not a confidence to change
  confidence: /\b(?:over|under|un)?confiden(?:ce|t)\b/i,
  dropped: /restor|reinstat|drop|remov|delet|omit|missing/i,
  added: /restor|reinstat|drop|remov|delet|omit|missing|should not|add/i,
};

/** Whether a reviewer's point is about what the person ruled on: it names the finding and speaks to the change ruled on (its likelihood, its confidence, or whether it stays). */
export function reopens(point: string, c: ConflictState): boolean {
  return namesFinding(point, c.finding) && ABOUT[c.change].test(point);
}

const pauseReason = (reasons: string[]): string => `${reasons.join(". ")}. The person rules on it in the Narrative lens: follow one reviewer, or write a note.`;

/**
 * What a reviewer's send-back must also say when its points name a card that cannot be cited: an empty card that is not a proven negative over full
 * coverage proves nothing (the tools refuse to cite it). Without this, a reviewer that asks for such a card to be cited sends the draft back for good
 * (dev CASE-3: Evaluate asked f10 to cite the empty flow and DNS cards). Null when no point names one.
 */
export function uncitableNote(state: Readonly<CaseState>, points: readonly string[]): string | null {
  const ids = Object.keys(state.cards).filter((id) => {
    const c = state.cards[id]!;
    if (c.place === "discarded" || c.row_count !== 0) return false;
    if (c.empty === "proven-negative" && c.coverage !== null && c.coverage.kind === "full") return false;
    return points.some((p) => new RegExp(`(?<![\\w])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "i").test(p));
  }).sort();
  if (ids.length === 0) return null;
  const list = ids.join(", ");
  return `Note: ${list} returned no rows and prove nothing (not a proven negative over full coverage), so ${ids.length === 1 ? "it cannot" : "they cannot"} be cited. A claim that rests on ${ids.length === 1 ? "its" : "their"} absence is not supported: weaken or drop it, and name ${list} under gaps_and_limits.`;
}
