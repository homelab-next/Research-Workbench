import { ANSWER_ACTIONS, CONFIDENCES, FEEDBACK_KINDS, isMarking, SEVERITIES } from "../types";
import type { Challenge, CheckFinding, Draft, Entry, Marking, Payloads } from "../types";
import { canonical } from "../canonical";
import type { Json } from "../canonical";
import { has, isBool, isNum, isObj, isOneOf, isStr, isStrList, malformed, recordSkip } from "./guards";
import { applyConflicts } from "./conflicts";
import { unheld } from "./person";
import { stageFinishedCounts } from "./run";
import { isBlobRefShape } from "./shapes";
import type { CaseState, ChallengeState, ReviewState } from "./types";

const isFinding = (x: unknown): x is CheckFinding => isObj(x) && isStr(x.check) && isStr(x.where) && isStr(x.message);
const isFindings = (x: unknown): x is CheckFinding[] => Array.isArray(x) && x.every(isFinding);
const isFindingRecord = (x: unknown): boolean =>
  isObj(x) && isStr(x.id) && isStr(x.statement) && isStr(x.likelihood) && isOneOf(x.confidence, CONFIDENCES)
  && isStr(x.confidence_basis) && isStrList(x.cites) && isStrList(x.assumptions) && isStr(x.reasoning);
const isProduct = (x: unknown): boolean =>
  isObj(x) && isStr(x.objective) && isStr(x.question) && isMarking(x.marking) && isStr(x.summary)
  && Array.isArray(x.key_findings) && x.key_findings.every(isFindingRecord)
  && isStr(x.gaps_and_limits) && isStr(x.alternatives) && isStr(x.assessment)
  && Array.isArray(x.sources) && x.sources.every((v) => isObj(v) && isStr(v.source) && isStr(v.quality))
  && isStrList(x.assumptions) && isStr(x.change);
const isDraft = (x: unknown): x is Draft =>
  isObj(x) && isNum(x.n) && isStr(x.hash) && isObj(x.author) && isProduct(x.product) && isStr(x.reason) && (x.cited === undefined || isStrList(x.cited));

function withReview(s: CaseState, hash: unknown, change: (r: ReviewState) => ReviewState): CaseState {
  if (!has(s.reviews, hash)) return s;
  return { ...s, reviews: { ...s.reviews, [hash]: change(s.reviews[hash]!) } };
}

function applyDrafts(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "draft.revised": {
      const d = entry.payload.draft;
      if (!isDraft(d)) return malformed(s, entry);
      // A repeated hash is a new revision of bytes that were already reviewed, and keeps its record,
      // but only if it carries those same bytes: what is published must be what was reviewed.
      if (Object.hasOwn(s.reviews, d.hash)) {
        const earlier = s.drafts.find((x) => x.hash === d.hash);
        if (earlier !== undefined && canonical(earlier.product as unknown as Json) !== canonical(d.product as unknown as Json)) {
          return recordSkip(s, entry, `draft hash ${d.hash} already names a different product`);
        }
        return { ...s, drafts: [...s.drafts, d] };
      }
      const review: ReviewState = { checks: [], evaluation: null, challenges: [], passed_stages: [], rejected: null };
      return { ...s, drafts: [...s.drafts, d], reviews: { ...s.reviews, [d.hash]: review } };
    }
    case "check.run": {
      const { check, script_hash, input, output, draft_hash, pass, findings, blocking } = entry.payload;
      if (!isStr(check) || !isStr(script_hash) || !isBlobRefShape(input) || !isBlobRefShape(output) || !isStr(draft_hash) || !isBool(pass) || !isFindings(findings)
        || (blocking !== undefined && !isBool(blocking))) {
        return malformed(s, entry);
      }
      return withReview(s, draft_hash, (r) => {
        const result = blocking === false ? { check, pass, findings, blocking: false as const } : { check, pass, findings };
        const i = r.checks.findIndex((c) => c.check === check);
        return { ...r, checks: i < 0 ? [...r.checks, result] : r.checks.map((c, j) => (j === i ? result : c)) };
      });
    }
    case "evaluation.made": {
      const { draft_hash, pass, findings } = entry.payload;
      if (!isStr(draft_hash) || !isBool(pass) || !isFindings(findings)) return malformed(s, entry);
      return withReview(s, draft_hash, (r) => ({ ...r, evaluation: { pass, findings } }));
    }
    case "stage.finished": {
      // applyRun sets the stage status; this records the verdict against the draft it examined. The latest verdict wins.
      const verdict = stageFinishedCounts(s, entry.payload);
      if (verdict !== "counts") return verdict === "malformed" ? malformed(s, entry) : s;
      const { stage, outcome, draft_hash } = entry.payload as Payloads["stage.finished"];
      if (draft_hash === null || !has(s.reviews, draft_hash)) return s;
      const passed = s.reviews[draft_hash]!.passed_stages;
      const failed = s.reviews[draft_hash]!.failed_stages ?? [];
      // the stages that failed this draft, so the page can tell a fail on this draft from one on an earlier draft
      const marked = outcome === "fail"
        ? (failed.includes(stage) ? s : withReview(s, draft_hash, (r) => ({ ...r, failed_stages: [...failed, stage] })))
        : (failed.includes(stage) ? withReview(s, draft_hash, (r) => ({ ...r, failed_stages: failed.filter((x) => x !== stage) })) : s);
      if (outcome === "pass") {
        return passed.includes(stage) ? marked : withReview(marked, draft_hash, (r) => ({ ...r, passed_stages: [...passed, stage] }));
      }
      return passed.includes(stage) ? withReview(marked, draft_hash, (r) => ({ ...r, passed_stages: passed.filter((x) => x !== stage) })) : marked;
    }
    case "run.started": {
      // a new run reviews afresh; applyRun has already installed it (or recorded it malformed). Checks, evaluations and challenges stay.
      if (!isStr(entry.payload.run) || s.run.id !== entry.payload.run) return s;
      const hashes = Object.keys(s.reviews).filter((h) => s.reviews[h]!.passed_stages.length > 0);
      if (hashes.length === 0) return s;
      const reviews = { ...s.reviews };
      for (const h of hashes) reviews[h] = { ...reviews[h]!, passed_stages: [] };
      return { ...s, reviews };
    }
    default:
      return s;
  }
}

const isChallenge = (c: unknown): c is Challenge =>
  isObj(c) && isStr(c.id) && isStr(c.draft_hash) && isOneOf(c.severity, SEVERITIES) && isStr(c.text) && isStrList(c.cites);

function applyChallenges(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "challenge.raised": {
      const c = entry.payload.challenge;
      if (!isChallenge(c)) return malformed(s, entry);
      if (Object.hasOwn(s.challenges, c.id) || !Object.hasOwn(s.reviews, c.draft_hash)) return s;
      const { id, draft_hash, severity, text, cites } = c;
      const opened: ChallengeState = { id, draft_hash, severity, text, cites, run: s.run.id, status: "open", answer: null, action: null };
      const next = withReview(s, draft_hash, (r) => ({ ...r, challenges: [...r.challenges, id] }));
      return { ...next, challenges: { ...s.challenges, [id]: opened } };
    }
    case "challenge.answered": {
      const { challenge, answer, action } = entry.payload;
      if (!isStr(challenge) || !isStr(answer) || !isOneOf(action, ANSWER_ACTIONS)) return malformed(s, entry);
      if (!has(s.challenges, challenge) || s.challenges[challenge]!.status !== "open") return s;
      return { ...s, challenges: { ...s.challenges, [challenge]: { ...s.challenges[challenge]!, status: "answered", answer, action } } };
    }
    default:
      return s;
  }
}

function applyOutputs(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "publish.rejected": {
      // The person's rejection is the latest and most authoritative verdict: the hash must pass review again.
      const { draft_hash, reason, stop } = entry.payload;
      if (!isStr(draft_hash) || !isStr(reason) || !isBool(stop)) return malformed(s, entry);
      return withReview(s, draft_hash, (r) => ({ ...r, passed_stages: [], rejected: { reason, stop, seq: entry.seq, ts: entry.ts } }));
    }
    case "product.published": {
      const { n, draft_hash, head_hash, dir, bundle } = entry.payload;
      if (!isNum(n) || !isStr(draft_hash) || !isStr(head_hash) || !isStr(dir) || !isBlobRefShape(bundle)) return malformed(s, entry);
      return { ...s, published: [...s.published, { n, draft_hash, head_hash, dir, seq: entry.seq, ts: entry.ts }] };
    }
    case "feedback.recorded": {
      const { measure, kind, value, note } = entry.payload;
      if (!isStr(measure) || !isOneOf(kind, FEEDBACK_KINDS) || !(isNum(value) || isStr(value)) || !isStr(note)) return malformed(s, entry);
      return { ...s, feedback: [...s.feedback, { measure, kind, value, note }] };
    }
    case "agent.asked": {
      const { turn, text, left_out, added } = entry.payload;
      if (!isStr(turn) || !isStr(text) || !isStrList(left_out) || !isStrList(added)) return malformed(s, entry);
      if (s.conversation.some((t) => t.turn === turn)) return s;
      return { ...s, conversation: [...s.conversation, { turn, asked: text, answer: null, cites: [], request: null, asked_seq: entry.seq, ended: null }] };
    }
    case "agent.answered": {
      const { turn, request, text, cites } = entry.payload;
      if (!isStr(turn) || !isStr(request) || !isStr(text) || !isStrList(cites)) return malformed(s, entry);
      const i = s.conversation.findIndex((t) => t.turn === turn);
      if (i < 0 || s.conversation[i]!.answer !== null) return s;
      return { ...s, conversation: s.conversation.map((t, j) => (j === i ? { ...t, answer: text, cites, request } : t)) };
    }
    case "agent.ended": {
      const { asked, reason } = entry.payload;
      if (!isNum(asked) || !isStr(reason)) return malformed(s, entry);
      const i = s.conversation.findIndex((t) => t.asked_seq === asked);
      if (i < 0 || s.conversation[i]!.answer !== null || s.conversation[i]!.ended !== null) return s;
      return { ...s, conversation: s.conversation.map((t, j) => (j === i ? { ...t, ended: reason } : t)) };
    }
    default:
      return s;
  }
}

/** Drafts and their review, challenges, reviewers who disagree, and what comes out. */
export function applyAnalysis(s: CaseState, entry: Entry): CaseState {
  return applyOutputs(applyConflicts(applyChallenges(applyDrafts(s, entry), entry), entry), entry);
}

export function latestDraft(state: CaseState): Draft | null {
  return state.drafts.length ? state.drafts[state.drafts.length - 1]! : null;
}

/**
 * Must-address challenges still open that bear on `draftHash`: those raised against it, and those raised in the current run against any
 * earlier draft (a revision that ignores a challenge does not close it). With no hash, only the current run's.
 */
export function openMustAddress(state: CaseState, draftHash: string | null = null): ChallengeState[] {
  return Object.values(state.challenges).filter((c) => c.severity === "must_address" && c.status === "open" && (c.draft_hash === draftHash || (state.run.status !== "none" && c.run === state.run.id)));
}

/** Why `draftHash` may not be published yet, in plain language; empty when it may. */
export function blockers(state: CaseState, draftHash: string): string[] {
  if (latestDraft(state)?.hash !== draftHash) return ["This is not the latest revision"];
  const review = Object.hasOwn(state.reviews, draftHash) ? state.reviews[draftHash]! : null;
  const reviewing = state.run.stages.filter((st) => st.reviews);
  if (reviewing.length === 0) return ["This run has no review stages"];
  const out: string[] = [];
  for (const st of reviewing) {
    if (!review || !review.passed_stages.includes(st.id)) out.push(`${st.title} has not passed this revision`);
  }
  // The latest recorded result of each check, and the latest evaluation, are verdicts too.
  for (const c of review?.checks ?? []) {
    if (!c.pass && c.blocking !== false) out.push(`${c.check} failed on this revision`);
  }
  if (review?.evaluation?.pass === false) out.push("Evaluation failed on this revision");
  for (const c of openMustAddress(state, draftHash)) out.push(`Challenge ${c.id} must be addressed`);
  // the person's rulings of this run and their overrules: a draft that does not hold them is not published
  out.push(...unheld(state, latestDraft(state)!.product));
  return out;
}

/** The failed checks on `draftHash` whose manifests say they do not block: listed at the publish gate, never blockers. */
export function notedExceptions(state: CaseState, draftHash: string): string[] {
  const review = Object.hasOwn(state.reviews, draftHash) ? state.reviews[draftHash]! : null;
  return (review?.checks ?? []).filter((c) => !c.pass && c.blocking === false)
    .map((c) => `${c.check} failed on this revision (noted, not blocking)${c.findings.length === 0 ? "" : `: ${c.findings.map((x) => x.message).join("; ")}`}`);
}

/**
 * True only when `draftHash` is the latest draft, every review stage passed that exact hash, no recorded
 * blocking check or evaluation of it failed, and no must-address challenge against it is open.
 */
export function publishable(state: CaseState, draftHash: string): boolean {
  return blockers(state, draftHash).length === 0;
}

/**
 * The marking of a narrative proposal's text: the marking of the model request that wrote it (text a model wrote is as strict as everything that
 * model had seen). An agent's proposal: its latest request before it, by the same agent and stage. A person's proposal of an answer: the request
 * the answer it was caused by names. Null when no such request is recorded, so the marking is unknown.
 */
export function proposalMarking(entries: readonly Entry[], proposalSeq: number): Marking | null {
  const at = entries.findLast((e) => e.seq === proposalSeq);
  if (at === undefined || at.type !== "proposal.created") return null;
  const marking = (e: Entry | undefined): Marking | null => (e !== undefined && e.type === "model.request" && isMarking(e.payload.marking) ? e.payload.marking : null);
  const a = at.actor;
  if (a.kind === "agent") {
    return marking(entries.findLast((x) => x.seq < at.seq && x.type === "model.request" && x.actor.kind === "agent" && x.actor.id === a.id && x.actor.stage === a.stage));
  }
  if (at.cause === undefined || at.cause === null) return null;
  const cause = entries.findLast((x) => x.seq === at.cause);
  if (cause === undefined || cause.type !== "agent.answered") return null;
  const request = cause.payload.request;
  return marking(entries.findLast((x) => x.seq < cause.seq && x.type === "model.request" && x.payload.request === request));
}
