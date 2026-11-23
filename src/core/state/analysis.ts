import { ANSWER_ACTIONS, CONFIDENCES, FEEDBACK_KINDS, isMarking, SEVERITIES } from "../types";
import type { Challenge, CheckFinding, Draft, Entry, Payloads } from "../types";
import { has, isBool, isNum, isObj, isOneOf, isStr, isStrList, malformed } from "./guards";
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
  isObj(x) && isNum(x.n) && isStr(x.hash) && isObj(x.author) && isProduct(x.product) && isStr(x.reason);

function withReview(s: CaseState, hash: unknown, change: (r: ReviewState) => ReviewState): CaseState {
  if (!has(s.reviews, hash)) return s;
  return { ...s, reviews: { ...s.reviews, [hash]: change(s.reviews[hash]!) } };
}

function applyDrafts(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "draft.revised": {
      const d = entry.payload.draft;
      if (!isDraft(d)) return malformed(s, entry);
      // a repeated hash is a new revision of bytes that were already reviewed: keep its record
      if (Object.hasOwn(s.reviews, d.hash)) return { ...s, drafts: [...s.drafts, d] };
      const review: ReviewState = { checks: [], evaluation: null, challenges: [], passed_stages: [] };
      return { ...s, drafts: [...s.drafts, d], reviews: { ...s.reviews, [d.hash]: review } };
    }
    case "check.run": {
      const { check, script_hash, input, draft_hash, pass, findings } = entry.payload;
      if (!isStr(check) || !isStr(script_hash) || !isBlobRefShape(input) || !isStr(draft_hash) || !isBool(pass) || !isFindings(findings)) {
        return malformed(s, entry);
      }
      return withReview(s, draft_hash, (r) => {
        const result = { check, pass, findings };
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
      if (outcome === "pass") {
        return passed.includes(stage) ? s : withReview(s, draft_hash, (r) => ({ ...r, passed_stages: [...passed, stage] }));
      }
      return passed.includes(stage) ? withReview(s, draft_hash, (r) => ({ ...r, passed_stages: passed.filter((x) => x !== stage) })) : s;
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
      const opened: ChallengeState = { id, draft_hash, severity, text, cites, status: "open", answer: null, action: null };
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
      return { ...s, conversation: [...s.conversation, { turn, asked: text, answer: null, cites: [], request: null }] };
    }
    case "agent.answered": {
      const { turn, request, text, cites } = entry.payload;
      if (!isStr(turn) || !isStr(request) || !isStr(text) || !isStrList(cites)) return malformed(s, entry);
      const i = s.conversation.findIndex((t) => t.turn === turn);
      if (i < 0 || s.conversation[i]!.answer !== null) return s;
      return { ...s, conversation: s.conversation.map((t, j) => (j === i ? { ...t, answer: text, cites, request } : t)) };
    }
    default:
      return s;
  }
}

export function applyAnalysis(s: CaseState, entry: Entry): CaseState {
  return applyOutputs(applyChallenges(applyDrafts(s, entry), entry), entry);
}

export function latestDraft(state: CaseState): Draft | null {
  return state.drafts.length ? state.drafts[state.drafts.length - 1]! : null;
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
  for (const c of Object.values(state.challenges)) {
    if (c.draft_hash === draftHash && c.severity === "must_address" && c.status === "open") out.push(`Challenge ${c.id} must be addressed`);
  }
  return out;
}

/** True only when `draftHash` is the latest draft and every review stage passed that exact hash. */
export function publishable(state: CaseState, draftHash: string): boolean {
  return blockers(state, draftHash).length === 0;
}
