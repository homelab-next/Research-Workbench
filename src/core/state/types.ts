import type {
  Actor, BlobRef, Card, Cost, Marking, Challenge, CheckFinding, Coverage, Draft, Finding, ModelChoice, Observable, Payloads,
  Place, Plan, ProposedFile, Proposal, Question, QueryPurpose, ReviewConflict, RunHold, StageDef, StepOutcome, TimeWindow,
} from "../types";

export type IdKind = "card" | "lane" | "query" | "job" | "proposal" | "challenge" | "request" | "call" | "turn" | "run" | "plan" | "conflict" | "question" | "change" | "probe";
export const ID_PREFIX: Record<IdKind, string> = {
  card: "c", lane: "l", query: "q", job: "j", proposal: "p", challenge: "x",
  request: "r", call: "t", turn: "u", run: "run-", plan: "plan-", conflict: "k", question: "ask-", change: "chg-", probe: "probe-",
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
  outcome: "published" | "stopped" | "completed" | null;
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
  /** `by` is "workbench" when the step was last started by code, not by a model. */
  steps: Record<string, { status: "pending" | "running" | StepOutcome; cards: string[]; note: string; by?: "workbench" }>;
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
  /** The pivot the query ran, and the value it was bound to (when that is a string); null otherwise. */
  pivot: string | null; value: string | null;
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
/** A person's ruling on a conflict. */
export interface Ruling { follow: string | null; note: string; by: string; seq: number; ts: string }
/**
 * `run` is the run in progress when the conflict was found; `ruling` is the person's latest, once made. `earlier_rulings` is present only once a
 * ruling was replaced: those it replaced, oldest first.
 */
export type ConflictState = ReviewConflict & { run: string | null; seq: number; ruling: Ruling | null; earlier_rulings?: Ruling[] };
/** A question put to the person: the run and stage that asked it (null outside one), who asked, the answer once given, and the waiver once the person went on without it. */
export type QuestionState = Question & {
  run: string | null; stage: string | null; by: string; seq: number; ts: string;
  answer: { card: string; by: string; seq: number; ts: string } | null;
  /** The person resumed the run without answering: the stage went on. */
  waived: { by: string; seq: number; ts: string } | null;
};
/** A person's overrule of a finding, as written, with who made it and when. */
export interface Overrule {
  finding: string; draft_hash: string; likelihood: string | null; confidence: Finding["confidence"] | null; stays: boolean | null; note: string;
  by: string; seq: number; ts: string;
}
/** The latest overrule of a finding, and those it replaced, oldest first. */
export type OverruleState = Overrule & { earlier: Overrule[] };
/** `run` is the run in progress when the challenge was raised (null when none). */
export type ChallengeState = Challenge & { run: string | null; status: "open" | "answered"; answer: string | null; action: "revised" | "rebutted" | null };

/** A case's moves out of and into the working set (case.unloaded, case.unload_failed, case.loaded), and the person's choice to unload it after publishing. */
export interface ArchiveState {
  /** The latest case.unloaded with no case.loaded or case.unload_failed after it: an unload under way, or one a stopped process left. */
  pending: { store: string; head: { seq: number; hash: string }; by: string; seq: number; ts: string } | null;
  /** The latest failed unload, until an unload or a load after it. */
  failed: { reason: string; seq: number; ts: string } | null;
  /** The latest load. */
  loaded: { file: string; head: { seq: number; hash: string }; id: string; by: string; seq: number; ts: string } | null;
  /** The person ticked "Unload after publishing" when they passed the publish gate of the current run, and no unload has been tried since. */
  unload_after: boolean;
  unloads: number;
  loads: number;
}

/** A child case one stage attempt of this case's run made, keyed `run/stage/attempt` (subloopKey), and what it gave back once it finished. */
export interface SubloopState {
  key: string; run: string; stage: string; attempt: number; child: string; loop: string; loop_hash: string; input_hash: string; inputs: BlobRef; depth: number; started_seq: number;
  finished: null | { child_run: string; head: { seq: number; hash: string }; outcome: "published" | "completed" | "stopped"; output_hash: string; output: BlobRef; cards: string[]; seq: number };
}
/** The loop a case is for, the version its run is bound to, its parent when it is a child, and the children its runs made (slice 12). */
export interface LoopState {
  /** The loop the case was made for; null on a ledger from before slice 12 (read as the default loop). */
  id: string | null;
  /** A loop.bound not yet followed by its run.started. */
  pending: { loop: string; version: number; hash: string; lock: BlobRef; seq: number } | null;
  /** What the current run started with; null for a run with no loop.bound (one from before slice 12). */
  bound: { loop: string; version: number; hash: string; lock: BlobRef; seq: number } | null;
  /** Set on a child case: the stage of the parent's run that made it. */
  parent: { case: string; run: string; stage: string; attempt: number; loop: string; input_hash: string; depth: number; floor: Marking } | null;
  children: Record<string, SubloopState>;
  /** Every subloop.started of the case, over all its runs. */
  child_count: number;
}

/** A change the builder proposed (builder.proposed), with each file's decision by a person once made. */
export interface BuilderChange {
  id: string; title: string; why: string; root: string;
  files: (ProposedFile & { decided: null | { accepted: boolean; written: string | null; by: string; seq: number } })[];
  bundle: BlobRef; by: string; seq: number;
}
/** A probe the builder asked for (builder.probe_asked), with the person's decision once made. */
export interface BuilderProbe {
  id: string; kind: "pivot" | "query"; source: string; pivot: string | null; value: Observable | null; text: string | null; window: TimeWindow; why: string; by: string; seq: number;
  decided: null | { approved: boolean; query: string | null; outcome: "ran" | "refused" | "rejected"; detail: string; by: string; seq: number };
}
/** What a builder session proposed and probed, and what the person decided (slice 12, part B). Empty in a case's ledger. */
export interface BuilderState { changes: Record<string, BuilderChange>; probes: Record<string, BuilderProbe> }

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
  // the person (slice 8)
  /** Questions put to the person, keyed by id. */
  questions: Record<string, QuestionState>;
  /** The person's overrules, keyed by finding id: case-wide, not per run. */
  overrules: Record<string, OverruleState>;
  /** Playbook runs, keyed by job. */
  playbooks: Record<string, PlaybookRunState>;
  published: { n: number; draft_hash: string; head_hash: string; dir: string; seq: number; ts: string }[];
  feedback: Payloads["feedback.recorded"][];
  /** `asked_seq` is the seq of the turn's agent.asked entry; `ended` is why it will not be answered (agent.ended), else null. */
  conversation: { turn: string; asked: string; answer: string | null; cites: string[]; request: string | null; asked_seq: number; ended: string | null }[];
  /** Model use by your agent (the conversation), kept apart from the run's: a question does not spend the run's budget. */
  agent_usage: { usage: Usage; calls: number };
  /** Unloads and loads of the case, and the choice to unload it after publishing (slice 11). */
  archive: ArchiveState;
  /** The case's loop, its bound version, its parent and its children (slice 12). */
  loop: LoopState;
  /** A builder session's changes and probes (slice 12, part B); empty for a case. */
  builder: BuilderState;
}
