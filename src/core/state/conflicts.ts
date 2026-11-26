import { CONFLICT_CHANGES } from "../types";
import type { Entry, Product, ReviewConflict } from "../types";
import { has, isObj, isOneOf, isStr, isStrList, isStrOrNull, malformed, recordSkip } from "./guards";
import type { CaseState, ConflictState, Ruling } from "./types";

const isConflict = (c: unknown): c is ReviewConflict =>
  isObj(c) && isStr(c.id) && isStr(c.draft_hash) && isStr(c.finding) && isOneOf(c.change, CONFLICT_CHANGES) && isStrOrNull(c.earlier) && isStrOrNull(c.now)
  && isStr(c.raised_by) && isStr(c.changed_for) && isStr(c.asks) && isStr(c.asked) && isStrList(c.points) && isStr(c.reason);

/**
 * Reviewers who disagree (review.conflict, review.ruled), and which reviewer each revision answered (draft.revised made after a send-back).
 * A ruling is a person's, for one of the two reviewers in the conflict or with a note. A later ruling replaces it, and the one it replaced is
 * kept in `earlier_rulings` (present only once a ruling was replaced, so a conflict ruled once folds as it did before slice 8).
 */
export function applyConflicts(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "draft.revised": {
      // applyDrafts has recorded it (or skipped it); only a revision it recorded, made in a stage someone sent work back to, answered a reviewer
      const d = entry.payload.draft as unknown;
      if (!isObj(d) || !isStr(d.hash) || s.drafts[s.drafts.length - 1]?.hash !== d.hash) return s;
      const stage = entry.stage;
      const from = isStr(stage) && has(s.run.sent_back_to, stage) ? s.run.sent_back_to[stage]! : null;
      const { [d.hash]: _was, ...rest } = s.made_for;
      // a computed key defines an own property, so a hash of "__proto__" is an ordinary key
      return { ...s, made_for: from === null ? rest : { ...rest, [d.hash]: from } };
    }
    case "review.conflict": {
      const c = entry.payload.conflict;
      if (!isConflict(c)) return malformed(s, entry);
      if (Object.hasOwn(s.conflicts, c.id)) return s;
      const { id, draft_hash, finding, change, earlier, now, raised_by, changed_for, asks, asked, points, reason } = c;
      const state: ConflictState = { id, draft_hash, finding, change, earlier, now, raised_by, changed_for, asks, asked, points, reason, run: s.run.id, seq: entry.seq, ruling: null };
      return { ...s, conflicts: { ...s.conflicts, [id]: state } };
    }
    case "review.ruled": {
      const { conflict, follow, note } = entry.payload;
      if (!isStr(conflict) || !isStrOrNull(follow) || !isStr(note)) return malformed(s, entry);
      if (entry.actor.kind !== "human") return recordSkip(s, entry, "a ruling is a person's");
      if (!has(s.conflicts, conflict)) return s;
      const c = s.conflicts[conflict]!;
      if (follow !== null && follow !== c.raised_by && follow !== c.changed_for) return recordSkip(s, entry, "a ruling follows one of the two reviewers in the conflict");
      if (follow === null && note.trim() === "") return recordSkip(s, entry, "a ruling follows one of the two reviewers, or gives a note");
      const ruling: Ruling = { follow, note, by: entry.actor.id, seq: entry.seq, ts: entry.ts };
      const next: ConflictState = c.ruling === null ? { ...c, ruling } : { ...c, ruling, earlier_rulings: [...(c.earlier_rulings ?? []), c.ruling] };
      return { ...s, conflicts: { ...s.conflicts, [conflict]: next } };
    }
    default:
      return s;
  }
}

/** The conflicts of the current run, in the order they were found. */
export const runConflicts = (state: Readonly<CaseState>): ConflictState[] =>
  Object.values(state.conflicts).filter((c) => state.run.id !== null && c.run === state.run.id).sort((a, b) => a.seq - b.seq);

/**
 * The findings the person has ruled on in the current run, each with its ruled conflict (the latest, if more than one). A ruling that an overrule
 * of the same finding, made after it and not withdrawn, has replaced is left out: the overrule holds instead.
 */
export function ruledFindings(state: Readonly<CaseState>): Map<string, ConflictState> {
  const out = new Map<string, ConflictState>();
  for (const c of runConflicts(state)) if (c.ruling !== null) out.set(c.finding, c);
  for (const [finding, c] of out) {
    const o = has(state.overrules, finding) ? state.overrules[finding]! : null;
    const active = o !== null && (o.likelihood !== null || o.confidence !== null || o.stays !== null);
    if (active && o.seq > c.ruling!.seq) out.delete(finding);
  }
  return out;
}

const WORD = /\w/;
/** True when the text names the finding, as a whole word in any case. */
export function namesFinding(text: string, id: string): boolean {
  const t = text.toLowerCase();
  const k = id.toLowerCase();
  if (k === "") return false;
  for (let i = t.indexOf(k); i >= 0; i = t.indexOf(k, i + 1)) {
    if (!WORD.test(t[i - 1] ?? "") && !WORD.test(t[i + k.length] ?? "")) return true;
  }
  return false;
}

const titleOf = (state: Readonly<CaseState>, id: string): string => state.run.stages.find((x) => x.id === id)?.title ?? id;

/** What a ruling says: "follow Challenge: keep likely. Note: …"; "not ruled yet" before it is made. */
export function rulingText(state: Readonly<CaseState>, c: ConflictState): string {
  if (c.ruling === null) return "not ruled yet";
  const parts: string[] = [];
  if (c.ruling.follow === c.raised_by) parts.push(`follow ${titleOf(state, c.raised_by)}: ${c.asks}`);
  else if (c.ruling.follow === c.changed_for) parts.push(`follow ${titleOf(state, c.changed_for)}: ${keepText(c)}`);
  if (c.ruling.note.trim() !== "") parts.push(`Note: ${c.ruling.note.trim()}`);
  return parts.join(". ");
}

/**
 * Why the work goes back when the person revises a ruling (controller ruling 6: at the publish gate a revision sends the work back to the analyst).
 * Null for a conflict ruled once or not at all.
 */
export function revisedRulingReason(state: Readonly<CaseState>, c: ConflictState): string | null {
  if (c.ruling === null || c.earlier_rulings === undefined || c.earlier_rulings.length === 0) return null;
  return `the person revised the ruling on ${c.finding} (${c.reason}): ${rulingText(state, c)}`;
}

/** What following the reviewer the analyst's change was made for means: keep the change. */
export function keepText(c: ReviewConflict): string {
  switch (c.change) {
    case "dropped": return `keep ${c.finding} dropped`;
    case "added": return `keep ${c.finding}`;
    case "confidence": return `keep ${c.now} confidence`;
    case "likelihood": return `keep ${c.now}`;
  }
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
