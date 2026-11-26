import type {
  Actor, BlobRef, Card, Cost, Marking, Challenge, CheckFinding, Coverage, Draft, ModelChoice, Observable, Payloads,
  Place, Plan, Proposal, QueryPurpose, ReviewConflict, RunHold, StageDef, StepOutcome, TimeWindow,
} from "../types";

export type IdKind = "card" | "lane" | "query" | "job" | "proposal" | "challenge" | "request" | "call" | "turn" | "run" | "plan" | "conflict";
export const ID_PREFIX: Record<IdKind, string> = {
  card: "c", lane: "l", query: "q", job: "j", proposal: "p", challenge: "x",
  request: "r", call: "t", turn: "u", run: "run-", plan: "plan-", conflict: "k",
};

export interface CardState extends Card {
  place: Place;
  lane: string | null;
  pinned: boolean;
  created_seq: number;
  created_ts: string;
  validated: null | { outcome: "matches" | "differs" | "could_not_run"; detail: string; seq: number; ts: string };
}
export interface LaneState { id: string; title: string; subgoal: string | null; cards: string[] }
export interface UndoItem { seq: number; card: string; place: Place; lane: string | null; index: number | null }

export interface StageState extends StageDef {
  status: "idle" | "running" | "passed" | "failed" | "waiting" | "declined" | "blocked";
  attempts: number;
  last_reason: string | null;
}
export interface RunState {
  id: string | null;
  status: "none" | "running" | "paused" | "waiting" | "interrupted" | "finished";
  outcome: "published" | "stopped" | null;
  pause_reason: string | null;
  waiting: "plan" | "publish" | null;
  stages: StageState[];
  current: string | null;
  /** Keyed "from>to". */
  sendbacks: Record<string, number>;
  /**
   * Per stage, its starts on one draft (the latest when it started): `starts`, those that were send-backs (`sent_back`), and `base`, the count a person's
   * resume past the run cap set aside. A start on another draft begins the count again.
   */
  repeats: Record<string, { draft: string | null; starts: number; sent_back: number; base: number }>;
  /** Per edge "from>to", the send-backs a person's resume past the send-back cap set aside. */
  sendback_base: Record<string, number>;
  /** The stage that last sent work back to each stage (keyed by the stage sent to), until that stage finishes. */
  sent_back_to: Record<string, string>;
  /** What a person's resume of the current pause does besides resuming; null for none. */
  hold: RunHold | null;
  /** Case totals: every model.response in the case, in or out of a run. */
  usage: Usage;
  model_calls: number;
  /** The case totals when the current run started, so this run's own figures are `usage - usage_at_start` (see runUsage). */
  usage_at_start: Usage;
  calls_at_start: number;
  budget_tokens: number | null;
}
export interface Usage { input: number; output: number; reasoning: number }
export interface PlanState {
  current: Plan | null;
  status: "none" | "proposed" | "accepted" | "denied" | "replanning";
  accepted_steps: string[];
  budgets: Record<string, number>;
  /** The price a person asked for, per step of the current plan (null: asked, and none could be given). Cleared by every plan.proposed. */
  estimates: Record<string, Cost | null>;
  steps: Record<string, { status: "pending" | "running" | StepOutcome; cards: string[]; note: string }>;
}
export interface JobState {
  id: string; title: string; kind: Payloads["job.started"]["kind"]; source: string | null;
  /** The plan sub-goal the job answers, by id; null when the entry names none. */
  subgoal: string | null;
  /** The research.requested entry (its seq) the job answers; null when the entry names none. */
  request: number | null;
  status: "running" | "done" | "failed"; started_ts: string; ended_ts: string | null;
}
export interface QueryState {
  id: string; source: string; text: string; why: string; window: TimeWindow; by: Actor;
  step: string | null; verifies: string | null; purpose: QueryPurpose;
  issued_seq: number; issued_ts: string;
  status: "running" | "done" | "failed";
  rows: number | null; rows_hash: string | null; coverage: Coverage | null; result: BlobRef | null;
  error: string | null; card: string | null;
}
/**
 * A playbook run, keyed by its job. `status` is running until playbook.finished gives the outcome; a job that failed first (a stopped server,
 * a run that threw) leaves it interrupted. `steps` holds each step's entry as written, `order` the order the steps were written in.
 */
export interface PlaybookRunState {
  job: string; playbook: string; title: string; inputs: Observable[]; window: TimeWindow; plan_step: string | null; started_seq: number;
  status: "running" | "interrupted" | StepOutcome; end_step: string | null;
  steps: Record<string, Payloads["playbook.step"]>; order: string[]; cards: string[]; end_cards: string[]; caveats: string[];
}
export type ProposalState = Proposal & { status: "open" | "accepted" | "rejected"; seq: number; budget: number | null; reason: string | null; refused_budget: number | null };
export interface ReviewState {
  /** `blocking` is present, as false, only for a check that does not block publishing. */
  checks: { check: string; pass: boolean; findings: CheckFinding[]; blocking?: false }[];
  evaluation: { pass: boolean; findings: CheckFinding[] } | null;
  challenges: string[];
  /** Ids of stages that finished with outcome "pass" for this draft hash. */
  passed_stages: string[];
  /** Ids of stages whose latest finish on this draft hash was a fail; present only once one has failed it. */
  failed_stages?: string[];
  /** The latest publish.rejected for this hash: the person's verdict, shown in the Narrative lens. It clears passed_stages. */
  rejected: { reason: string; stop: boolean; seq: number; ts: string } | null;
}
/** `run` is the run in progress when the conflict was found; `ruling` is the person's, once made. */
export type ConflictState = ReviewConflict & { run: string | null; seq: number; ruling: { follow: string | null; note: string; by: string; seq: number; ts: string } | null };
/** `run` is the run in progress when the challenge was raised (null when none). */
export type ChallengeState = Challenge & { run: string | null; status: "open" | "answered"; answer: string | null; action: "revised" | "rebutted" | null };

export interface CaseState {
  seq: number;
  head_ts: string | null;
  /** Entries the fold could not apply (malformed or failing), most recent 100. */
  skipped: { seq: number; type: string; reason: string }[];
  meta: Payloads["case.created"] | null;
  phase: string | null;
  counters: Record<IdKind, number>;
  // cards and lanes (Task 5)
  cards: Record<string, CardState>;
  incoming: string[];
  lanes: LaneState[];
  target: string | null;
  discarded: string[];
  undoable: UndoItem[];
  // run (Task 6)
  stage_models: Record<string, ModelChoice>;
  /** The strictest marking a stage may put in front of its model; a stage with no entry has no limit. */
  pack_limits: Record<string, Marking>;
  run: RunState;
  plan: PlanState;
  jobs: Record<string, JobState>;
  queries: Record<string, QueryState>;
  proposals: Record<string, ProposalState>;
  // analysis (Task 7)
  drafts: Draft[];
  reviews: Record<string, ReviewState>;
  challenges: Record<string, ChallengeState>;
  /** For each draft hash made after a reviewer sent work back, that reviewer's stage id (the latest revision with the hash wins). */
  made_for: Record<string, string>;
  conflicts: Record<string, ConflictState>;
  /** Playbook runs, keyed by job. */
  playbooks: Record<string, PlaybookRunState>;
  published: { n: number; draft_hash: string; head_hash: string; dir: string; seq: number; ts: string }[];
  feedback: Payloads["feedback.recorded"][];
  /** `asked_seq` is the seq of the turn's agent.asked entry; `ended` is why it will not be answered (agent.ended), else null. */
  conversation: { turn: string; asked: string; answer: string | null; cites: string[]; request: string | null; asked_seq: number; ended: string | null }[];
  /** Model use by your agent (the conversation), kept apart from the run's: a question does not spend the run's budget. */
  agent_usage: { usage: Usage; calls: number };
}
