import type {
  Actor, BlobRef, Card, Challenge, CheckFinding, Coverage, Draft, ModelChoice, Payloads,
  Place, Plan, Proposal, StageDef, StepOutcome, TimeWindow,
} from "../types";

export type IdKind = "card" | "lane" | "query" | "job" | "proposal" | "challenge" | "request" | "call" | "turn" | "run" | "plan";
export const ID_PREFIX: Record<IdKind, string> = {
  card: "c", lane: "l", query: "q", job: "j", proposal: "p", challenge: "x",
  request: "r", call: "t", turn: "u", run: "run-", plan: "plan-",
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
  steps: Record<string, { status: "pending" | "running" | StepOutcome; cards: string[]; note: string }>;
}
export interface JobState {
  id: string; title: string; kind: "research" | "query" | "model" | "check"; source: string | null;
  status: "running" | "done" | "failed"; started_ts: string; ended_ts: string | null;
}
export interface QueryState {
  id: string; source: string; text: string; why: string; window: TimeWindow; by: Actor;
  step: string | null; verifies: string | null;
  issued_seq: number; issued_ts: string;
  status: "running" | "done" | "failed";
  rows: number | null; rows_hash: string | null; coverage: Coverage | null; result: BlobRef | null;
  error: string | null; card: string | null;
}
export type ProposalState = Proposal & { status: "open" | "accepted" | "rejected"; seq: number; budget: number | null; reason: string | null };
export interface ReviewState {
  checks: { check: string; pass: boolean; findings: CheckFinding[] }[];
  evaluation: { pass: boolean; findings: CheckFinding[] } | null;
  challenges: string[];
  /** Ids of stages that finished with outcome "pass" for this draft hash. */
  passed_stages: string[];
  /** The latest publish.rejected for this hash: the person's verdict, shown in the Narrative lens. It clears passed_stages. */
  rejected: { reason: string; stop: boolean; seq: number; ts: string } | null;
}
export type ChallengeState = Challenge & { status: "open" | "answered"; answer: string | null; action: "revised" | "rebutted" | null };

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
  run: RunState;
  plan: PlanState;
  jobs: Record<string, JobState>;
  queries: Record<string, QueryState>;
  proposals: Record<string, ProposalState>;
  // analysis (Task 7)
  drafts: Draft[];
  reviews: Record<string, ReviewState>;
  challenges: Record<string, ChallengeState>;
  published: { n: number; draft_hash: string; head_hash: string; dir: string; seq: number; ts: string }[];
  feedback: Payloads["feedback.recorded"][];
  conversation: { turn: string; asked: string; answer: string | null; cites: string[]; request: string | null }[];
}
