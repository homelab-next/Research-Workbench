import { isPlainObject } from "./canonical";
import type { Json } from "./canonical";

// ---------- primitives ----------
// The vocabulary shared with pivot is pivot's (pivot docs/design.md §4): the same shapes, re-exported so every import here stays.
import { EMPTY_MEANS, MARKINGS, WHERES, isMarking } from "pivot/types";
import type { Coverage, Cost, EmptyMeans, Marking, Observable, Observed, TimeWindow, Where } from "pivot/types";
export { EMPTY_MEANS, MARKINGS, MAX_POINTS, MAX_SIGHTINGS, PARTIAL_REASONS, WHERES, isMarking } from "pivot/types";
export type { Coverage, Cost, EmptyMeans, Marking, Observable, Observed, Sighting, Span, TimeWindow, Where } from "pivot/types";

export type Actor =
  | { kind: "human"; id: string }
  | { kind: "system"; id: string }
  | { kind: "agent"; id: string; stage: string; profile: string; model: string; effort: string | null; where: Where };

export interface BlobRef { blob: string; bytes: number; media?: string }
export type Place = "incoming" | "lane" | "discarded";
export interface ModelChoice { provider: string; model: string; effort: string | null }

// ---------- cards ----------
export interface Card {
  id: string;
  title: string;
  body: string;
  kind: "result" | "assessment" | "note";
  made_by: "agent" | "human" | "system";
  query: string | null;
  columns: string[];
  column_types: (string | null)[];
  rows: Json[][];
  row_count: number;
  coverage: Coverage | null;
  empty: EmptyMeans | null;
  marking: Marking;
  source: string | null;
  step: string | null;
  subgoal: string | null;
  why: string;
  event_time: string | null;
  quality_notes: string[];
  /** What the pivot's result observed; only on a card made by a pivot's own query (from 6b). */
  observed?: Observed;
  /** Only on a statement by the person (slice 8): such a card is a note a person made, with no query, no source and no rows. */
  person?: PersonStatement;
  /**
   * The typed values the result's field notes extract (slice 9), read by code from every row when the card was made; absent when no
   * column of the result has an extract rule or none matched. Each carries the card's marking.
   */
  extracted?: ExtractedValue[];
}
/** A value an extract rule pulled out of a result cell: by code, never by a model; its rule, its column and the first row (from 0) it was in. */
export interface ExtractedValue { type: string; value: string; column: string; rule: string; row: number; by: "code" }
/** How the person knows what they state: they saw it, did it, were told it, or did not say. */
export type PersonBasis = "saw" | "did" | "told" | "unstated";
/** What makes a card a person's statement: how they know it, what it is about, and the question it answers (null when they volunteered it). */
export interface PersonStatement { basis: PersonBasis; detail: string; about: Observable[]; answers: string | null }
/** A question a stage puts to the person: `why` is why the answer matters; `cards` and `about` are what it is about. */
export interface Question { id: string; text: string; why: string; cards: string[]; about: Observable[]; blocking: boolean }

// ---------- plans ----------
export type StepOutcome = "answered" | "empty" | "partial" | "blocked" | "failed";
export interface PlanStep {
  id: string; subgoal: string; pivot: string; source: string;
  from: Observable; to: string; window: TimeWindow; needs_window: boolean;
  free: boolean; weight: number; estimate: Cost | null; empty_means: EmptyMeans; warnings: string[];
  /** A step that is a playbook: its id, its manifest hash when the plan was made, and the values it starts from. A step without it is a pivot. */
  playbook?: { id: string; hash: string; inputs: Observable[] };
  /** What the person accepted, as one hash (stepPins): the pivot and its inventory, or the playbook and each of its steps' pivots. A step without it is not checked. */
  pins?: string;
}
export interface SubGoal { id: string; title: string; question: string; steps: string[] }
export interface Plan { id: string; goal: string; window: TimeWindow; subgoals: SubGoal[]; steps: PlanStep[] }

// ---------- pipeline ----------
export interface StageDef {
  id: string; title: string; phase: string | null;
  runs: "agent" | "script" | "human";
  gate: "plan" | "publish" | null;
  /** True when this stage reviews the draft and must pass before publishing. */
  reviews: boolean;
  model: ModelChoice | null;
}
export interface PackItem { kind: string; id: string; title: string; hash: string; chars: number; fixed: boolean }

// ---------- analysis ----------
export type Section = "summary" | "key_findings" | "gaps_and_limits" | "alternatives" | "assessment";
export interface Finding {
  id: string; statement: string; likelihood: string;
  confidence: "low" | "moderate" | "high"; confidence_basis: string;
  cites: string[]; assumptions: string[]; reasoning: string;
}
export interface Product {
  objective: string; question: string; marking: Marking;
  summary: string; key_findings: Finding[]; gaps_and_limits: string; alternatives: string; assessment: string;
  sources: { source: string; quality: string }[]; assumptions: string[]; change: string;
}
/** `hash` is sha256Hex(canonical(product)). */
/**
 * `cited` (not part of the hashed product) is every card id a finding or a narrative section cites, sorted. A product does not store its
 * narrative's citations, so the draft does; a draft recorded without it is read as citing what its findings cite.
 */
export interface Draft { n: number; hash: string; author: Actor; product: Product; reason: string; cited?: string[] }
export interface CheckFinding { check: string; where: string; message: string }
export interface Challenge { id: string; draft_hash: string; severity: "must_address" | "consider"; text: string; cites: string[] }
/**
 * Two reviewers who disagree on a finding: `raised_by`'s point on the latest draft would move back a change the analyst made in it for `changed_for`'s
 * send-back. `asks` and `asked` are the two positions in a few words; `points` are `raised_by`'s points that name the finding; `reason` names both.
 */
export interface ReviewConflict {
  id: string; draft_hash: string; finding: string; change: "likelihood" | "confidence" | "dropped" | "added";
  earlier: string | null; now: string | null; raised_by: string; changed_for: string; asks: string; asked: string; points: string[]; reason: string;
}
/**
 * Why the engine paused, when a person's resume of that pause changes what comes next: a reviewer whose only points were on ruled findings runs
 * again; a stage at its run cap on the draft, or an edge at its send-back cap, gets a fresh allowance of that cap; a stage that passed with a
 * blocking question to the person unanswered (`question`, written after that stage's pass, before the next stage starts) has those questions
 * waived, and the run goes on without the answer.
 */
export type RunHold = { kind: "ruled"; stage: string } | { kind: "stage_runs"; stage: string } | { kind: "send_back"; edge: string } | { kind: "question"; stage: string };
/**
 * Why a query was issued: for its result, to price another query (an estimate), to re-run an earlier one (a verify), or as one lookup of a
 * playbook (no model chose it).
 */
export type QueryPurpose = "result" | "estimate" | "verify" | "playbook";
/** True for a query made for its answer: a result or a playbook lookup. */
export const isAnswerPurpose = (p: QueryPurpose): boolean => p === "result" || p === "playbook";
/** One lookup of a playbook step: the value it was on, how it ended, and the query and card that answered it (sent now, or reused). */
export interface PlaybookLookup {
  value: string; outcome: "answered" | "empty" | "partial" | "failed" | "needs_budget" | "refused"; rows: number | null;
  query: string | null; card: string | null; reused: boolean; detail: string;
}
export type Proposal =
  /**
   * A query an agent may not run until a person sets a budget. `text` is the query as given to the runner (a template
   * with its bound values and window beside it), so an accepted proposal can be run from the record alone.
   */
  | {
    id: string; kind: "costly_query"; title: string; by: string; step: string | null; subgoal: string | null; source: string;
    pivot: string | null; pivot_hash: string | null; source_hash: string; text: string; bound: Record<string, Json>; window: TimeWindow; estimate: Cost | null; why: string;
  }
  | { id: string; kind: "narrative"; title: string; by: string; section: Section; text: string; cites: string[] };

// ---------- entries ----------
export interface Payloads {
  // case and run
  "case.created": { id: string; title: string; asked: string; why: string; starting: Observable[]; window: TimeWindow; objective: string | null; marking: Marking };
  "case.phase_changed": { phase: string };
  "run.started": { run: string; pipeline: string; pipeline_hash: string; stages: StageDef[] };
  /** `hold`: what a person's resume of this pause does besides resuming (see RunHold). */
  "run.paused": { reason: string; hold?: RunHold };
  "run.resumed": Record<string, never>;
  "run.interrupted": Record<string, never>;
  /** `reason` is a person's, when they stopped the run with Engine.stop. */
  "run.finished": { outcome: "published" | "stopped"; reason?: string };
  "stage.model_set": { stage: string; choice: ModelChoice };
  "stage.pack_limit_set": { stage: string; max_marking: Marking | null };
  "stage.started": { stage: string; attempt: number };
  "stage.finished": { stage: string; attempt: number; outcome: "pass" | "fail" | "declined"; draft_hash: string | null; output: BlobRef | null; reason: string | null };
  "stage.sent_back": { from: string; to: string; reason: string; count: number };
  "gate.waiting": { gate: "plan" | "publish" };
  "gate.passed": { gate: "plan" | "publish";
    /** The person's choice at the publish gate: unload the case once this run has published. */
    unload_after?: boolean };
  "budget.set": { tokens: number | null };
  "job.started": { job: string; title: string; kind: "research" | "query" | "model" | "check" | "playbook"; source: string | null;
    /** The plan sub-goal a research job answers, by id. */
    subgoal?: string | null;
    /** The seq of the research.requested entry a sent-back research job answers. */
    request?: number | null };
  "job.finished": { job: string; outcome: "done" | "failed" };
  // plans
  "plan.proposed": { plan: Plan };
  "plan.accepted": { plan: string; steps: string[]; budgets: Record<string, number> };
  "plan.denied": { plan: string; reason: string };
  "plan.replan_requested": { plan: string; note: string };
  /** `by` is "workbench" when code ran the step at the start of its job, with no model choosing the lookup. */
  "step.started": { step: string; by?: "workbench" };
  /** `reused`: the query whose recorded answer finished the step, when none was run for it. */
  "step.finished": { step: string; outcome: StepOutcome; cards: string[]; note: string; reused?: string };
  /** A person asked for the price of a costly step before accepting the plan. `query` is the estimate query the source answered, when there was one. */
  "step.estimated": { step: string; estimate: Cost | null; query: string | null };
  // queries
  "query.issued": { query: string; source: string; source_hash: string; pivot: string | null; pivot_hash: string | null; connector: string; text: string; bound: Record<string, Json>; window: TimeWindow; why: string; estimate: Cost | null; step: string | null; verifies: string | null; purpose: QueryPurpose;
    /** The inventory the pivot asks, when it asks one, and whether that inventory is complete (what an empty answer then means). */
    inventory?: { id: string; hash: string; complete: boolean } };
  "query.result": { query: string; result: BlobRef; rows: number; rows_hash: string; coverage: Coverage; duration_ms: number; cost: Cost | null };
  "query.failed": { query: string; error: string };
  /** The end of a route the person asked for: what it reached, which pivots ran dry, what the answer rests on, and the cards its lookups made. The lookups themselves are the query entries that carry `job`. */
  "route.finished": { job: string; want: string; outcome: "answered" | "blocked"; reached: Observable[]; blocked: string[]; caveats: string[]; cards: string[] };
  /** A playbook run: which playbook (and its manifest hash), on what, why, the plan step it carries out, and every step's pivot and pivot hash. */
  "playbook.started": { job: string; playbook: string; playbook_hash: string; title: string; inputs: Observable[]; window: TimeWindow; why: string; plan_step: string | null; steps: { id: string; pivot: string; pivot_hash: string }[] };
  /** One step of a playbook run: ran or skipped and why, each lookup, the values found, and how many values were left unfollowed. */
  "playbook.step": { job: string; step: string; pivot: string; status: "ran" | "skipped"; reason: string; lookups: PlaybookLookup[]; found: string[]; left: number };
  /** The end of a playbook run: its outcome and the end step it came from, the cards, the caveats, and how many lookups were sent and reused. */
  "playbook.finished": { job: string; outcome: StepOutcome; end_step: string | null; cards: string[]; end_cards: string[]; caveats: string[]; lookups: number; reused: number };
  "verify.run": { original: string; rerun: string | null; card: string; outcome: "matches" | "differs" | "could_not_run"; detail: string };
  // models
  "model.request": { request: string; provider: string; model: string; effort: string | null; where: Where; marking: Marking; pack: PackItem[]; left_out: PackItem[]; messages: BlobRef; tools: string[];
    /** What the request did other than as asked, in a line: an endpoint refused a named tool_choice, so "required" was sent. Absent otherwise. */
    note?: string };
  "model.response": { request: string; response: BlobRef; stop: "end" | "tool_calls" | "length" | "error"; usage: { input: number; output: number; reasoning: number }; served_by: string; reasoning: BlobRef | null };
  "model.declined": { request: string; reason: string };
  "model.blocked": { stage: string; marking: Marking; model: string; where: Where };
  "tool.called": { request: string; call: string; tool: string; args: Json; why: string };
  "tool.returned": { call: string; ok: boolean; summary: string; result: BlobRef | null };
  /** Tool calls in one reply past the most a reply may have run: one entry for all of them, none of which ran. */
  "tool.skipped": { request: string; count: number; note: string };
  // cards and lanes
  "card.created": { card: Card };
  "card.kept": { card: string; lane: string; index: number | null };
  "card.moved": { card: string; lane: string; index: number };
  "card.discarded": { card: string };
  "card.restored": { card: string };
  "card.sent_back": { card: string };
  "card.pinned": { card: string; pinned: boolean };
  "lane.created": { lane: string; title: string; subgoal: string | null };
  "lane.renamed": { lane: string; title: string };
  "lane.removed": { lane: string };
  "lane.target_set": { lane: string };
  "undo": { target: number; card: string; place: Place; lane: string | null; index: number | null };
  // proposals
  "proposal.created": { proposal: Proposal };
  "proposal.accepted": { proposal: string; budget: number | null };
  "proposal.rejected": { proposal: string; reason: string };
  /** A person's budget did not cover the source's fresh estimate: nothing ran and the proposal stays open at the new price. `query` is the estimate query, when the source answered one. */
  "proposal.repriced": { proposal: string; estimate: Cost; budget: number; query: string | null };
  // analysis
  "assessment.made": { finding: Finding; draft_hash: string };
  "research.requested": { question: string; why: string };
  "draft.revised": { draft: Draft };
  /** `blocking` is written only as false, for a check whose manifest says it does not block: its failure is a noted exception, not a blocker. */
  "check.run": { check: string; script_hash: string; input: BlobRef; output: BlobRef; draft_hash: string; pass: boolean; findings: CheckFinding[]; blocking?: boolean };
  "evaluation.made": { draft_hash: string; pass: boolean; findings: CheckFinding[] };
  "challenge.raised": { challenge: Challenge };
  "challenge.answered": { challenge: string; answer: string; action: "revised" | "rebutted" };
  /** The engine found the reviewers disagree and paused instead of sending the work back. */
  "review.conflict": { conflict: ReviewConflict };
  /** A person's ruling on a conflict: follow one of its two reviewers (a stage id), or none, with a note. The latest ruling on a conflict is the one that holds. */
  "review.ruled": { conflict: string; follow: string | null; note: string };
  // the person (slice 8)
  /** An agent puts a question to the person. Asking does not stop the run. */
  "question.asked": { question: Question };
  /** The person answers a question with a statement card of theirs (its `person.answers` names the question). */
  "question.answered": { question: string; card: string };
  /** A person sets a finding's likelihood, its confidence, or whether it stays. Null leaves that alone; all three null withdraws the overrule. */
  "finding.overruled": { finding: string; draft_hash: string; likelihood: string | null; confidence: Finding["confidence"] | null; stays: boolean | null; note: string };
  // product and feedback
  "publish.rejected": { draft_hash: string; reason: string; stop: boolean };
  "product.published": { n: number; draft_hash: string; head_hash: string; dir: string; bundle: BlobRef };
  "feedback.recorded": { measure: string; kind: "mop" | "moe"; value: number | string; note: string };
  // your agent (the Agent lens)
  "agent.asked": { turn: string; text: string; left_out: string[]; added: string[] };
  "agent.answered": { turn: string; request: string; text: string; cites: string[] };
  /** A question that will not be answered: `asked` is the seq of its agent.asked entry; `reason` is "interrupted" or the (scrubbed) text of what failed. */
  "agent.ended": { asked: number; reason: string };
  // workbench chain
  "module.loaded": { kind: string; id: string; hash: string; root: string; path: string };
  "module.rejected": { root: string; path: string; error: string };
  "setting.changed": { key: string; value: Json };
  /** Written on the workbench chain only: the head of a case when it was published or closed. A case fold ignores it. */
  "case.anchored": { case: string; seq: number; hash: string; why: "published" | "closed" };
  // cases in and out of the working set
  /** The case is being packed into a case file. `store` is the store folder's name only; `head` is the head before this entry. */
  "case.unloaded": { store: string; head: { seq: number; hash: string } };
  "case.unload_failed": { reason: string };
  /** The case came from a case file. `head` is the head it arrived with (the head before this entry); `id` is the id it has here, the id in the file. */
  "case.loaded": { file: string; head: { seq: number; hash: string }; id: string };
}
export type EntryType = keyof Payloads;

/** The fields of payload P whose type is a blob reference (or a blob reference or null). */
export type BlobField<P> = { [K in keyof P]-?: [P[K]] extends [never] ? never : P[K] extends BlobRef | null ? K : never }[keyof P];

/**
 * Where blob references live: for each entry type that has any, the payload fields that hold one.
 * This is the only place the verifier looks for references; anything shaped like one elsewhere (in a
 * card row, a tool argument, a setting) is source data, not a reference. The type requires every
 * entry type with a BlobRef field to be listed, allows no other, and allows only BlobRef fields.
 */
export const BLOB_FIELDS: { readonly [T in EntryType as BlobField<Payloads[T]> extends never ? never : T]: readonly BlobField<Payloads[T]>[] } = {
  "query.result": ["result"],
  "model.request": ["messages"],
  "model.response": ["response", "reasoning"],
  "tool.returned": ["result"],
  "check.run": ["input", "output"],
  "stage.finished": ["output"],
  "product.published": ["bundle"],
};

/** The blob reference fields of payload P that may hold null. */
type NullableBlobField<P> = { [K in BlobField<P>]: null extends P[K] ? K : never }[BlobField<P>];

/**
 * For each typed blob position, whether it may hold null. The type requires every BLOB_FIELDS position and
 * forces each flag to agree with the payload type, so the two cannot drift. A position that may not hold
 * null must be present and hold a reference: a result with no bytes behind it is refused by the ledger and
 * reported by the verifier.
 */
export const BLOB_NULLABLE: { readonly [T in keyof typeof BLOB_FIELDS]: { readonly [K in BlobField<Payloads[T]>]: K extends NullableBlobField<Payloads[T]> ? true : false } } = {
  "query.result": { result: false },
  "model.request": { messages: false },
  "model.response": { response: false, reasoning: true },
  "tool.returned": { result: true },
  "check.run": { input: false, output: false },
  "stage.finished": { output: true },
  "product.published": { bundle: false },
};

/** True when the typed blob position `field` of entry type `type` may hold null (or is not a typed position at all). */
export function blobFieldNullable(type: string, field: string): boolean {
  if (!Object.hasOwn(BLOB_NULLABLE, type)) return true;
  const flags = BLOB_NULLABLE[type as keyof typeof BLOB_NULLABLE] as Readonly<Record<string, boolean>>;
  return !Object.hasOwn(flags, field) || flags[field] === true;
}

export type EntryInput = {
  [T in EntryType]: { type: T; payload: Payloads[T]; actor: Actor; cause?: number | null; run?: string | null; stage?: string | null; job?: string | null };
}[EntryType];

export type Entry = {
  [T in EntryType]: {
    seq: number; ts: string; case: string; actor: Actor; type: T; payload: Payloads[T];
    cause: number | null; run: string | null; stage: string | null; job: string | null;
    prev_hash: string; hash: string;
  };
}[EntryType];

// ---------- runtime lists ----------
// Each list is built from an object with one key per member of its union, so a missing or extra
// name is a type error and the list cannot drift from the type beside it.

function listOf<T extends string>(members: { readonly [K in T]: true }): readonly T[] {
  return Object.freeze(Object.keys(members) as T[]);
}

export const SECTIONS = listOf<Section>({ summary: true, key_findings: true, gaps_and_limits: true, alternatives: true, assessment: true });
export const GATES = listOf<NonNullable<StageDef["gate"]>>({ plan: true, publish: true });
export const STAGE_RUNS = listOf<StageDef["runs"]>({ agent: true, script: true, human: true });
export const STAGE_OUTCOMES = listOf<Payloads["stage.finished"]["outcome"]>({ pass: true, fail: true, declined: true });
export const RUN_OUTCOMES = listOf<Payloads["run.finished"]["outcome"]>({ published: true, stopped: true });
export const STEP_OUTCOMES = listOf<StepOutcome>({ answered: true, empty: true, partial: true, blocked: true, failed: true });
export const JOB_KINDS = listOf<Payloads["job.started"]["kind"]>({ research: true, query: true, model: true, check: true, playbook: true });
export const JOB_OUTCOMES = listOf<Payloads["job.finished"]["outcome"]>({ done: true, failed: true });
export const QUERY_PURPOSES = listOf<QueryPurpose>({ result: true, estimate: true, verify: true, playbook: true });
export const PLAYBOOK_LOOKUP_OUTCOMES = listOf<PlaybookLookup["outcome"]>({ answered: true, empty: true, partial: true, failed: true, needs_budget: true, refused: true });
export const PLAYBOOK_STEP_STATUSES = listOf<Payloads["playbook.step"]["status"]>({ ran: true, skipped: true });
export const ROUTE_OUTCOMES = listOf<Payloads["route.finished"]["outcome"]>({ answered: true, blocked: true });
export const VERIFY_OUTCOMES = listOf<Payloads["verify.run"]["outcome"]>({ matches: true, differs: true, could_not_run: true });
export const PLACES = listOf<Place>({ incoming: true, lane: true, discarded: true });
export const CARD_KINDS = listOf<Card["kind"]>({ result: true, assessment: true, note: true });
export const CARD_MAKERS = listOf<Card["made_by"]>({ agent: true, human: true, system: true });
export const CONFIDENCES = listOf<Finding["confidence"]>({ low: true, moderate: true, high: true });
export const SEVERITIES = listOf<Challenge["severity"]>({ must_address: true, consider: true });
export const CONFLICT_CHANGES = listOf<ReviewConflict["change"]>({ likelihood: true, confidence: true, dropped: true, added: true });
export const ANSWER_ACTIONS = listOf<Payloads["challenge.answered"]["action"]>({ revised: true, rebutted: true });
export const FEEDBACK_KINDS = listOf<Payloads["feedback.recorded"]["kind"]>({ mop: true, moe: true });
export const PERSON_BASES = listOf<PersonBasis>({ saw: true, did: true, told: true, unstated: true });

/** Every entry type, as a runtime list. Built from an object keyed by EntryType, so a name missing from Payloads or extra to it is a type error. */
export const ENTRY_TYPES = listOf<EntryType>({
  "case.created": true, "case.phase_changed": true, "run.started": true, "run.paused": true, "run.resumed": true,
  "run.interrupted": true, "run.finished": true, "stage.model_set": true, "stage.pack_limit_set": true, "stage.started": true,
  "stage.finished": true, "stage.sent_back": true, "gate.waiting": true, "gate.passed": true, "budget.set": true,
  "job.started": true, "job.finished": true, "plan.proposed": true, "plan.accepted": true, "plan.denied": true,
  "plan.replan_requested": true, "step.started": true, "step.finished": true, "step.estimated": true, "query.issued": true,
  "query.result": true, "query.failed": true, "verify.run": true, "route.finished": true,
  "playbook.started": true, "playbook.step": true, "playbook.finished": true, "model.request": true, "model.response": true,
  "model.declined": true, "model.blocked": true, "tool.called": true, "tool.returned": true, "tool.skipped": true, "card.created": true,
  "card.kept": true, "card.moved": true, "card.discarded": true, "card.restored": true, "card.sent_back": true,
  "card.pinned": true, "lane.created": true, "lane.renamed": true, "lane.removed": true, "lane.target_set": true,
  "undo": true, "proposal.created": true, "proposal.accepted": true, "proposal.rejected": true, "proposal.repriced": true,
  "assessment.made": true, "research.requested": true, "draft.revised": true, "check.run": true,
  "evaluation.made": true, "challenge.raised": true, "challenge.answered": true, "review.conflict": true, "review.ruled": true,
  "question.asked": true, "question.answered": true, "finding.overruled": true, "publish.rejected": true,
  "product.published": true, "feedback.recorded": true, "agent.asked": true, "agent.answered": true, "agent.ended": true,
  "module.loaded": true, "module.rejected": true, "setting.changed": true, "case.anchored": true,
  "case.unloaded": true, "case.unload_failed": true, "case.loaded": true,
});
const ENTRY_TYPE_SET: ReadonlySet<string> = new Set(ENTRY_TYPES);
export const isEntryType = (x: unknown): x is EntryType => typeof x === "string" && ENTRY_TYPE_SET.has(x);

const AGENT_KEYS = ["effort", "id", "kind", "model", "profile", "stage", "where"].join();

/** A well-formed Actor: one of the three kinds, with exactly the fields that kind has, each of the right type. */
export function isActor(x: unknown): x is Actor {
  if (!isPlainObject(x)) return false;
  const keys = Object.keys(x).sort().join();
  if (x.kind === "human" || x.kind === "system") return keys === "id,kind" && typeof x.id === "string";
  if (x.kind !== "agent" || keys !== AGENT_KEYS) return false;
  return typeof x.id === "string" && typeof x.stage === "string" && typeof x.profile === "string" && typeof x.model === "string"
    && (x.effort === null || typeof x.effort === "string") && (WHERES as readonly unknown[]).includes(x.where);
}

/**
 * The most restrictive of the given markings; "TLP:CLEAR" when none are given. Anything that is not
 * one of MARKINGS (a typo, a stray space, a missing field) counts as the most restrictive, so a
 * mistake can only raise the result, never lower it.
 */
export function strictest(...markings: unknown[]): Marking {
  let best = 0;
  for (const m of markings) best = Math.max(best, isMarking(m) ? MARKINGS.indexOf(m) : MARKINGS.length - 1);
  return MARKINGS[best]!;
}
