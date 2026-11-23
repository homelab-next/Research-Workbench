import type { Json } from "./canonical";

// ---------- primitives ----------
export type Marking = "TLP:CLEAR" | "TLP:GREEN" | "TLP:AMBER" | "TLP:AMBER+STRICT" | "TLP:RED";
/** Least to most restrictive. */
export const MARKINGS: readonly Marking[] = ["TLP:CLEAR", "TLP:GREEN", "TLP:AMBER", "TLP:AMBER+STRICT", "TLP:RED"];
export type Where = "machine" | "network" | "hosted";

export type Actor =
  | { kind: "human"; id: string }
  | { kind: "system"; id: string }
  | { kind: "agent"; id: string; stage: string; profile: string; model: string; effort: string | null; where: Where };

export interface BlobRef { blob: string; bytes: number; media?: string }
export interface TimeWindow { from: string | null; to: string | null }
export interface Observable { type: string; value: string }
export type Coverage =
  | { kind: "full" }
  | { kind: "partial"; reason: "row_limit" | "timeout" | "window_clipped" | "source_error" | "budget"; detail?: string };
export interface Cost { amount: number; unit: string }
export type EmptyMeans = "proven-negative" | "not-seen";
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
}

// ---------- plans ----------
export type StepOutcome = "answered" | "empty" | "partial" | "blocked" | "failed";
export interface PlanStep {
  id: string; subgoal: string; pivot: string; source: string;
  from: Observable; to: string; window: TimeWindow; needs_window: boolean;
  free: boolean; weight: number; estimate: Cost | null; empty_means: EmptyMeans; warnings: string[];
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
export interface Draft { n: number; hash: string; author: Actor; product: Product; reason: string }
export interface CheckFinding { check: string; where: string; message: string }
export interface Challenge { id: string; draft_hash: string; severity: "must_address" | "consider"; text: string; cites: string[] }
export type Proposal =
  | { id: string; kind: "costly_query"; title: string; by: string; step: string | null; source: string; text: string; estimate: Cost; why: string }
  | { id: string; kind: "narrative"; title: string; by: string; section: Section; text: string; cites: string[] };

// ---------- entries ----------
export interface Payloads {
  // case and run
  "case.created": { id: string; title: string; asked: string; why: string; starting: Observable[]; window: TimeWindow; objective: string | null; marking: Marking };
  "case.phase_changed": { phase: string };
  "run.started": { run: string; pipeline: string; pipeline_hash: string; stages: StageDef[] };
  "run.paused": { reason: string };
  "run.resumed": Record<string, never>;
  "run.interrupted": Record<string, never>;
  "run.finished": { outcome: "published" | "stopped" };
  "stage.model_set": { stage: string; choice: ModelChoice };
  "stage.started": { stage: string; attempt: number };
  "stage.finished": { stage: string; attempt: number; outcome: "pass" | "fail" | "declined"; draft_hash: string | null; output: BlobRef | null; reason: string | null };
  "stage.sent_back": { from: string; to: string; reason: string; count: number };
  "gate.waiting": { gate: "plan" | "publish" };
  "gate.passed": { gate: "plan" | "publish" };
  "budget.set": { tokens: number | null };
  "job.started": { job: string; title: string; kind: "research" | "query" | "model" | "check"; source: string | null };
  "job.finished": { job: string; outcome: "done" | "failed" };
  // plans
  "plan.proposed": { plan: Plan };
  "plan.accepted": { plan: string; steps: string[]; budgets: Record<string, number> };
  "plan.denied": { plan: string; reason: string };
  "plan.replan_requested": { plan: string; note: string };
  "step.started": { step: string };
  "step.finished": { step: string; outcome: StepOutcome; cards: string[]; note: string };
  // queries
  "query.issued": { query: string; source: string; source_hash: string; pivot: string | null; pivot_hash: string | null; connector: string; text: string; bound: Record<string, Json>; window: TimeWindow; why: string; estimate: Cost | null; step: string | null; verifies: string | null };
  "query.result": { query: string; result: BlobRef; rows: number; rows_hash: string; coverage: Coverage; duration_ms: number; cost: Cost | null };
  "query.failed": { query: string; error: string };
  "verify.run": { original: string; rerun: string; card: string; outcome: "matches" | "differs" | "could_not_run"; detail: string };
  // models
  "model.request": { request: string; provider: string; model: string; effort: string | null; where: Where; marking: Marking; pack: PackItem[]; left_out: PackItem[]; messages: BlobRef; tools: string[] };
  "model.response": { request: string; response: BlobRef; stop: "end" | "tool_calls" | "length" | "error"; usage: { input: number; output: number; reasoning: number }; served_by: string; reasoning: BlobRef | null };
  "model.declined": { request: string; reason: string };
  "model.blocked": { stage: string; marking: Marking; model: string; where: Where };
  "tool.called": { request: string; call: string; tool: string; args: Json; why: string };
  "tool.returned": { call: string; ok: boolean; summary: string; result: BlobRef | null };
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
  // analysis
  "assessment.made": { finding: Finding; draft_hash: string };
  "research.requested": { question: string; why: string };
  "draft.revised": { draft: Draft };
  "check.run": { check: string; script_hash: string; input: BlobRef; draft_hash: string; pass: boolean; findings: CheckFinding[] };
  "evaluation.made": { draft_hash: string; pass: boolean; findings: CheckFinding[] };
  "challenge.raised": { challenge: Challenge };
  "challenge.answered": { challenge: string; answer: string; action: "revised" | "rebutted" };
  // product and feedback
  "publish.rejected": { draft_hash: string; reason: string; stop: boolean };
  "product.published": { n: number; draft_hash: string; head_hash: string; dir: string; bundle: BlobRef };
  "feedback.recorded": { measure: string; kind: "mop" | "moe"; value: number | string; note: string };
  // your agent (the Agent lens)
  "agent.asked": { turn: string; text: string; left_out: string[]; added: string[] };
  "agent.answered": { turn: string; request: string; text: string; cites: string[] };
  // workbench chain
  "module.loaded": { kind: string; id: string; hash: string; root: string; path: string };
  "module.rejected": { root: string; path: string; error: string };
  "setting.changed": { key: string; value: Json };
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
  "check.run": ["input"],
  "stage.finished": ["output"],
  "product.published": ["bundle"],
};

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

export const WHERES = listOf<Where>({ machine: true, network: true, hosted: true });
export const SECTIONS = listOf<Section>({ summary: true, key_findings: true, gaps_and_limits: true, alternatives: true, assessment: true });
export const GATES = listOf<NonNullable<StageDef["gate"]>>({ plan: true, publish: true });
export const STAGE_RUNS = listOf<StageDef["runs"]>({ agent: true, script: true, human: true });
export const STAGE_OUTCOMES = listOf<Payloads["stage.finished"]["outcome"]>({ pass: true, fail: true, declined: true });
export const RUN_OUTCOMES = listOf<Payloads["run.finished"]["outcome"]>({ published: true, stopped: true });
export const STEP_OUTCOMES = listOf<StepOutcome>({ answered: true, empty: true, partial: true, blocked: true, failed: true });
export const JOB_KINDS = listOf<Payloads["job.started"]["kind"]>({ research: true, query: true, model: true, check: true });
export const JOB_OUTCOMES = listOf<Payloads["job.finished"]["outcome"]>({ done: true, failed: true });
export const VERIFY_OUTCOMES = listOf<Payloads["verify.run"]["outcome"]>({ matches: true, differs: true, could_not_run: true });
export const PLACES = listOf<Place>({ incoming: true, lane: true, discarded: true });
export const EMPTY_MEANS = listOf<EmptyMeans>({ "proven-negative": true, "not-seen": true });
export const PARTIAL_REASONS = listOf<Extract<Coverage, { kind: "partial" }>["reason"]>({ row_limit: true, timeout: true, window_clipped: true, source_error: true, budget: true });
export const CARD_KINDS = listOf<Card["kind"]>({ result: true, assessment: true, note: true });
export const CARD_MAKERS = listOf<Card["made_by"]>({ agent: true, human: true, system: true });
export const CONFIDENCES = listOf<Finding["confidence"]>({ low: true, moderate: true, high: true });
export const SEVERITIES = listOf<Challenge["severity"]>({ must_address: true, consider: true });
export const ANSWER_ACTIONS = listOf<Payloads["challenge.answered"]["action"]>({ revised: true, rebutted: true });
export const FEEDBACK_KINDS = listOf<Payloads["feedback.recorded"]["kind"]>({ mop: true, moe: true });

/** Every entry type, as a runtime list. Built from an object keyed by EntryType, so a name missing from Payloads or extra to it is a type error. */
export const ENTRY_TYPES = listOf<EntryType>({
  "case.created": true, "case.phase_changed": true, "run.started": true, "run.paused": true, "run.resumed": true,
  "run.interrupted": true, "run.finished": true, "stage.model_set": true, "stage.started": true,
  "stage.finished": true, "stage.sent_back": true, "gate.waiting": true, "gate.passed": true, "budget.set": true,
  "job.started": true, "job.finished": true, "plan.proposed": true, "plan.accepted": true, "plan.denied": true,
  "plan.replan_requested": true, "step.started": true, "step.finished": true, "query.issued": true,
  "query.result": true, "query.failed": true, "verify.run": true, "model.request": true, "model.response": true,
  "model.declined": true, "model.blocked": true, "tool.called": true, "tool.returned": true, "card.created": true,
  "card.kept": true, "card.moved": true, "card.discarded": true, "card.restored": true, "card.sent_back": true,
  "card.pinned": true, "lane.created": true, "lane.renamed": true, "lane.removed": true, "lane.target_set": true,
  "undo": true, "proposal.created": true, "proposal.accepted": true, "proposal.rejected": true,
  "assessment.made": true, "research.requested": true, "draft.revised": true, "check.run": true,
  "evaluation.made": true, "challenge.raised": true, "challenge.answered": true, "publish.rejected": true,
  "product.published": true, "feedback.recorded": true, "agent.asked": true, "agent.answered": true,
  "module.loaded": true, "module.rejected": true, "setting.changed": true,
});
const ENTRY_TYPE_SET: ReadonlySet<string> = new Set(ENTRY_TYPES);
export const isEntryType = (x: unknown): x is EntryType => typeof x === "string" && ENTRY_TYPE_SET.has(x);

const isPlainObject = (x: unknown): x is Record<string, unknown> => {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
};
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

export function isMarking(x: unknown): x is Marking {
  return typeof x === "string" && (MARKINGS as readonly string[]).includes(x);
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
