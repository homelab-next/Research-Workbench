import type { CheckFinding, Draft, Entry } from "../types";
import type { CaseState, ChallengeState, ReviewState } from "./types";

const isStr = (x: unknown): x is string => typeof x === "string";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStrList = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);
const isOneOf = <T extends string>(x: unknown, set: readonly T[]): x is T => isStr(x) && (set as readonly string[]).includes(x);
const has = <T>(rec: Record<string, T>, id: unknown): id is string => isStr(id) && Object.hasOwn(rec, id);
const isFinding = (x: unknown): x is CheckFinding => isObj(x) && isStr(x.check) && isStr(x.where) && isStr(x.message);
const isFindings = (x: unknown): x is CheckFinding[] => Array.isArray(x) && x.every(isFinding);
const MARKINGS = ["TLP:CLEAR", "TLP:GREEN", "TLP:AMBER", "TLP:AMBER+STRICT", "TLP:RED"] as const;
const isFindingRecord = (x: unknown): boolean =>
  isObj(x) && isStr(x.id) && isStr(x.statement) && isStr(x.likelihood) && isOneOf(x.confidence, ["low", "moderate", "high"])
  && isStr(x.confidence_basis) && isStrList(x.cites) && isStrList(x.assumptions) && isStr(x.reasoning);
const isProduct = (x: unknown): boolean =>
  isObj(x) && isStr(x.objective) && isStr(x.question) && isOneOf(x.marking, MARKINGS) && isStr(x.summary)
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
      if (!isDraft(d)) return s;
      // a repeated hash is a new revision of bytes that were already reviewed: keep its record
      if (Object.hasOwn(s.reviews, d.hash)) return { ...s, drafts: [...s.drafts, d] };
      const review: ReviewState = { checks: [], evaluation: null, challenges: [], passed_stages: [] };
      return { ...s, drafts: [...s.drafts, d], reviews: { ...s.reviews, [d.hash]: review } };
    }
    case "check.run": {
      const { check, draft_hash, pass, findings } = entry.payload;
      if (!isStr(check) || typeof pass !== "boolean" || !isFindings(findings)) return s;
      return withReview(s, draft_hash, (r) => {
        const result = { check, pass, findings };
        const i = r.checks.findIndex((c) => c.check === check);
        return { ...r, checks: i < 0 ? [...r.checks, result] : r.checks.map((c, j) => (j === i ? result : c)) };
      });
    }
    case "evaluation.made": {
      const { draft_hash, pass, findings } = entry.payload;
      if (typeof pass !== "boolean" || !isFindings(findings)) return s;
      return withReview(s, draft_hash, (r) => ({ ...r, evaluation: { pass, findings } }));
    }
    case "stage.finished": {
      // applyRun sets the stage status; this records the verdict against the draft it examined. The latest verdict wins.
      const { stage, outcome, draft_hash } = entry.payload;
      if (!isStr(stage) || !isStr(draft_hash) || !has(s.reviews, draft_hash)) return s;
      const passed = s.reviews[draft_hash]!.passed_stages;
      if (outcome === "pass") {
        return passed.includes(stage) ? s : withReview(s, draft_hash, (r) => ({ ...r, passed_stages: [...passed, stage] }));
      }
      if (outcome === "fail" || outcome === "declined") {
        return passed.includes(stage) ? withReview(s, draft_hash, (r) => ({ ...r, passed_stages: passed.filter((x) => x !== stage) })) : s;
      }
      return s;
    }
    case "run.started": {
      // a new run reviews afresh; applyRun has already installed it. Checks, evaluations and challenges stay.
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

function applyChallenges(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "challenge.raised": {
      const c = entry.payload.challenge;
      if (!isObj(c) || !isStr(c.id) || !isStr(c.draft_hash) || !isOneOf(c.severity, ["must_address", "consider"]) || !isStr(c.text) || !isStrList(c.cites)) return s;
      if (Object.hasOwn(s.challenges, c.id) || !Object.hasOwn(s.reviews, c.draft_hash)) return s;
      const opened: ChallengeState = { ...c, status: "open", answer: null, action: null };
      const next = withReview(s, c.draft_hash, (r) => ({ ...r, challenges: [...r.challenges, c.id] }));
      return { ...next, challenges: { ...s.challenges, [c.id]: opened } };
    }
    case "challenge.answered": {
      const { challenge, answer, action } = entry.payload;
      if (!has(s.challenges, challenge) || s.challenges[challenge]!.status !== "open" || !isStr(answer) || !isOneOf(action, ["revised", "rebutted"])) return s;
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
      if (!isNum(n) || !isStr(draft_hash) || !isStr(head_hash) || !isStr(dir) || !isObj(bundle)) return s;
      return { ...s, published: [...s.published, { n, draft_hash, head_hash, dir, seq: entry.seq, ts: entry.ts }] };
    }
    case "feedback.recorded": {
      const { measure, kind, value, note } = entry.payload;
      if (!isStr(measure) || !isOneOf(kind, ["mop", "moe"]) || !(isNum(value) || isStr(value)) || !isStr(note)) return s;
      return { ...s, feedback: [...s.feedback, { measure, kind, value, note }] };
    }
    case "agent.asked": {
      const { turn, text, left_out, added } = entry.payload;
      if (!isStr(turn) || !isStr(text) || !isStrList(left_out) || !isStrList(added) || s.conversation.some((t) => t.turn === turn)) return s;
      return { ...s, conversation: [...s.conversation, { turn, asked: text, answer: null, cites: [], request: null }] };
    }
    case "agent.answered": {
      const { turn, request, text, cites } = entry.payload;
      if (!isStr(turn) || !isStr(request) || !isStr(text) || !isStrList(cites)) return s;
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
