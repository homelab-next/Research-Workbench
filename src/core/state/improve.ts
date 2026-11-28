// The fold for the improve loop (slice 14): a task case's known answers, an improve case's request and the record of its run, and a probe
// child's mark. Browser-safe: no runtime imports but the shared shape checks. An old ledger holds none of these entries: its answers stay {}
// and its improve stays initialImprove().
import { CONFIDENCES, isMarking, strictest } from "../types";
import type { BlobRef, Entry, ExpectedFinding, Marking, Observable, Payloads, Product, TimeWindow } from "../types";
import { isProduct, latestDraft } from "./analysis";
import { has, isNum, isObj, isOneOf, isStr, isStrList, isStrOrNull, malformed, recordSkip } from "./guards";
import { isBlobRefShape, isCount, isObservable, isTimeWindow } from "./shapes";
import type { CandidateState, CaseState, ImproveState, KnownAnswerState, ProbeState, TaskState } from "./types";

export const PROBE_ACTOR_ID = "improve-probe";
export const BASE = "base";
export const PROBE_OUTPUT_FORMAT = 1;
export const ANSWER_TEXT_MAX = 600;
export const ANSWER_FINDINGS_MAX = 12;
export const CLAIM_MAX = 300;
export const TASKS_MAX = 8;
export const CANDIDATES_MAX = 4;

export const probeId = (candidate: string, task: string): string => `${candidate}/${task}`;

export function initialImprove(): ImproveState {
  return {
    request: null, selected: null, tasks: {}, task_order: [], candidates: {}, candidate_order: [], probes: {}, probe_order: [], chosen: null, scored: null,
    probe_of: null,
  };
}

// ---------- shapes ----------

const isId = (x: unknown): x is string => isStr(x) && x !== "";
const isPositive = (x: unknown): x is number => isCount(x) && x >= 1;
const isTextUpTo = (x: unknown, max: number): x is string => isStr(x) && x !== "" && x.length <= max;
const isExpected = (x: unknown): x is ExpectedFinding =>
  isObj(x) && isTextUpTo(x.claim, CLAIM_MAX) && isId(x.likelihood) && isOneOf(x.confidence, CONFIDENCES);
const isExpectedList = (x: unknown): x is ExpectedFinding[] => Array.isArray(x) && x.length <= ANSWER_FINDINGS_MAX && x.every(isExpected);
const copyExpected = (f: ExpectedFinding): ExpectedFinding => ({ claim: f.claim, likelihood: f.likelihood, confidence: f.confidence });

const isKnown = (x: unknown): x is Payloads["answer.known"] =>
  isObj(x) && isPositive(x.product) && isId(x.draft_hash) && isTextUpTo(x.text, ANSWER_TEXT_MAX) && isExpectedList(x.findings) && isMarking(x.marking);
const isWithdrawn = (x: unknown): x is Payloads["answer.withdrawn"] => isObj(x) && isPositive(x.product) && isStr(x.reason);
const isRequested = (x: unknown): x is Payloads["improve.requested"] =>
  isObj(x) && isId(x.target) && isId(x.case_type) && isPositive(x.tasks) && x.tasks <= TASKS_MAX && isPositive(x.candidates) && x.candidates <= CANDIDATES_MAX;

const SCORE_MAX = 1000;
const isHash = (x: unknown): x is string => isStr(x) && /^[0-9a-f]{64}$/.test(x);
const isHead = (x: unknown): x is { seq: number; hash: string } => isObj(x) && isCount(x.seq) && isStr(x.hash);
const isScore = (x: unknown): x is number => isCount(x) && x <= SCORE_MAX;
const LEFT_OUT = ["marking", "cap"] as const;
const CANDIDATE_STATUSES = ["staged", "dropped"] as const;
const PROBE_OUTCOMES = ["drafted", "incomplete"] as const;
const MATCHERS = ["code", "code+model"] as const;

const isSelected = (x: unknown): x is Payloads["improve.selected"] =>
  isObj(x) && isId(x.target) && isPositive(x.version) && isHash(x.loop_hash) && isBlobRefShape(x.lock) && isId(x.case_type)
  && isStrList(x.scale) && x.scale.length > 0 && x.scale.every(isId)
  && Array.isArray(x.left_out) && x.left_out.every((l) => isObj(l) && isId(l.case) && isOneOf(l.why, LEFT_OUT));
const isTask = (x: unknown): x is Payloads["improve.task"] =>
  isObj(x) && isId(x.task) && isId(x.case) && isStr(x.origin) && isHead(x.head) && isObj(x.product) && isPositive(x.product.n) && isId(x.product.draft_hash)
  && isHead(x.answer) && isMarking(x.marking) && isBlobRefShape(x.inputs) && isBlobRefShape(x.record);
/** Staged exactly when it names a lock and a hash; dropped, neither. */
const isCandidate = (x: unknown): x is Payloads["improve.candidate"] =>
  isObj(x) && isId(x.candidate) && isId(x.change) && isOneOf(x.status, CANDIDATE_STATUSES) && isStr(x.reason)
  && (x.status === "staged" ? isHash(x.loop_hash) && isBlobRefShape(x.lock) : x.loop_hash === null && x.lock === null);
const isBudgets = (x: unknown): x is { lookups: number; tokens: number } => isObj(x) && isCount(x.lookups) && isCount(x.tokens);
const isProbeStarted = (x: unknown): x is Payloads["probe.started"] =>
  isObj(x) && isId(x.probe) && isId(x.candidate) && isId(x.task) && x.probe === probeId(x.candidate, x.task) && isId(x.child) && isStr(x.origin)
  && isHash(x.loop_hash) && isStr(x.input_hash) && isBudgets(x.budgets);
/** Drafted exactly when it names the draft. */
const isProbeFinished = (x: unknown): x is Payloads["probe.finished"] =>
  isObj(x) && isId(x.probe) && isId(x.child) && isStrOrNull(x.child_run) && isHead(x.head) && isOneOf(x.outcome, PROBE_OUTCOMES) && isStr(x.reason)
  && (x.outcome === "drafted" ? isId(x.draft_hash) : x.draft_hash === null) && isStr(x.output_hash) && isBlobRefShape(x.output) && isCount(x.lookups) && isCount(x.tokens);
const isChosen = (x: unknown): x is Payloads["compose.chosen"] => isObj(x) && (x.candidate === null || isId(x.candidate)) && isStr(x.why) && isBlobRefShape(x.contrasts);
const isScored = (x: unknown): x is Payloads["judge.scored"] =>
  isObj(x) && isBlobRefShape(x.answers) && isBlobRefShape(x.scores) && isOneOf(x.matcher, MATCHERS)
  && Array.isArray(x.summary) && x.summary.every((r) => isObj(r) && isId(r.candidate) && isScore(r.score) && isCount(r.drafted) && isCount(r.tasks));

const copyRef = (r: BlobRef): BlobRef => (r.media === undefined ? { blob: r.blob, bytes: r.bytes } : { blob: r.blob, bytes: r.bytes, media: r.media });
const copyHead = (h: { seq: number; hash: string }): { seq: number; hash: string } => ({ seq: h.seq, hash: h.hash });

const isMark = (x: unknown): x is Payloads["probe.child"] =>
  isObj(x) && isId(x.improve) && isStr(x.origin) && isId(x.probe) && isId(x.candidate) && isId(x.task) && x.probe === probeId(x.candidate, x.task)
  && x.plan_gate === "accept" && isPositive(x.max_lookups);

const withImprove = (s: CaseState, i: Partial<ImproveState>): CaseState => ({ ...s, improve: { ...s.improve, ...i } });
/** An improve case or a probe child: neither was investigated, so neither holds a known answer. */
const notInvestigated = (s: CaseState): boolean => s.improve.request !== null || s.improve.probe_of !== null;

/** A run is in progress: started, and not finished. */
const inProgress = (s: CaseState): boolean => s.run.id !== null && s.run.status !== "none" && s.run.status !== "finished";
/** The selection of the run in progress, or null. */
const thisRun = (s: CaseState): ImproveState["selected"] => (s.improve.selected !== null && s.improve.selected.run === s.run.id ? s.improve.selected : null);

const PERSONS_ANSWER = "a known answer is a person's";
const REQUESTED = "an improve case is asked for by the person when it is made";
const BY_WORKBENCH = "recorded by the workbench";
const IN_RUN = "recorded in the run in progress of an improve case";
const AFTER_SELECTION = "recorded after the run's selection";

function applyAnswers(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "answer.known": {
      const p = entry.payload as unknown;
      if (!isKnown(p)) return malformed(s, entry);
      if (entry.actor.kind !== "human") return recordSkip(s, entry, PERSONS_ANSWER);
      if (notInvestigated(s)) return recordSkip(s, entry, "a known answer belongs to a case that was investigated");
      if (!s.published.some((x) => x.n === p.product && x.draft_hash === p.draft_hash)) return recordSkip(s, entry, "a known answer names a product this case published");
      const draft = s.drafts.find((d) => d.hash === p.draft_hash);
      if (draft === undefined || strictest(p.marking, s.meta?.marking, draft.product.marking) !== p.marking) {
        return recordSkip(s, entry, "a known answer is marked at least as strictly as its case and its product");
      }
      const known: KnownAnswerState = {
        product: p.product, draft_hash: p.draft_hash, text: p.text, findings: p.findings.map(copyExpected), marking: p.marking,
        by: entry.actor.id, seq: entry.seq, hash: entry.hash, ts: entry.ts,
      };
      // a computed key defines an own property
      return { ...s, answers: { ...s.answers, [String(p.product)]: known } };
    }
    case "answer.withdrawn": {
      const p = entry.payload as unknown;
      if (!isWithdrawn(p)) return malformed(s, entry);
      if (entry.actor.kind !== "human") return recordSkip(s, entry, PERSONS_ANSWER);
      const key = String(p.product);
      if (!has(s.answers, key)) return recordSkip(s, entry, "there is no known answer for that product");
      const { [key]: _gone, ...rest } = s.answers;
      return { ...s, answers: rest };
    }
    default:
      return s;
  }
}

/** Why the record of an improve case's run cannot take this entry from this actor now; null when it can. */
function runRefusal(s: CaseState, actorOk: boolean, actorReason: string): string | null {
  if (!actorOk) return actorReason;
  if (s.improve.request === null || !inProgress(s)) return IN_RUN;
  return null;
}

/** The record of an improve case's run: its selection, tasks, candidates, probes, choice and scores. */
function applyRunRecord(s: CaseState, entry: Entry): CaseState {
  const i = s.improve;
  const bySystem = entry.actor.kind === "system";
  switch (entry.type) {
    case "improve.selected": {
      const p = entry.payload as unknown;
      if (!isSelected(p)) return malformed(s, entry);
      const no = runRefusal(s, bySystem, BY_WORKBENCH);
      if (no !== null) return recordSkip(s, entry, no);
      if (thisRun(s) !== null) return recordSkip(s, entry, "a run selects its tasks once");
      const sel: NonNullable<ImproveState["selected"]> = {
        target: p.target, version: p.version, loop_hash: p.loop_hash, lock: copyRef(p.lock), case_type: p.case_type, scale: [...p.scale],
        left_out: p.left_out.map((l) => ({ case: l.case, why: l.why })), run: s.run.id!, seq: entry.seq,
      };
      // a new run's selection clears the last run's record; the request stays
      return { ...s, improve: { ...initialImprove(), request: i.request, probe_of: i.probe_of, selected: sel } };
    }
    case "improve.task": {
      const p = entry.payload as unknown;
      if (!isTask(p)) return malformed(s, entry);
      const no = runRefusal(s, bySystem, BY_WORKBENCH);
      if (no !== null) return recordSkip(s, entry, no);
      if (thisRun(s) === null || p.task !== `T${i.task_order.length + 1}`) return recordSkip(s, entry, "an improve case's tasks are numbered in order after its run's selection");
      const t: TaskState = {
        task: p.task, case: p.case, origin: p.origin, head: copyHead(p.head), product: { n: p.product.n, draft_hash: p.product.draft_hash }, answer: copyHead(p.answer),
        marking: p.marking, inputs: copyRef(p.inputs), record: copyRef(p.record),
      };
      return withImprove(s, { tasks: { ...i.tasks, [p.task]: t }, task_order: [...i.task_order, p.task] });
    }
    case "improve.candidate": {
      const p = entry.payload as unknown;
      if (!isCandidate(p)) return malformed(s, entry);
      const no = runRefusal(s, bySystem, BY_WORKBENCH);
      if (no !== null) return recordSkip(s, entry, no);
      if (thisRun(s) === null) return recordSkip(s, entry, AFTER_SELECTION);
      if (p.candidate !== `K${i.candidate_order.length + 1}` || !has(s.builder.changes, p.change)) {
        return recordSkip(s, entry, "an improve case's candidates are numbered in order, each naming a change proposed in it");
      }
      const c: CandidateState = {
        candidate: p.candidate, change: p.change, status: p.status, loop_hash: p.loop_hash, lock: p.lock === null ? null : copyRef(p.lock), reason: p.reason, seq: entry.seq,
      };
      return withImprove(s, { candidates: { ...i.candidates, [p.candidate]: c }, candidate_order: [...i.candidate_order, p.candidate] });
    }
    case "probe.started": {
      const p = entry.payload as unknown;
      if (!isProbeStarted(p)) return malformed(s, entry);
      const no = runRefusal(s, bySystem, BY_WORKBENCH);
      if (no !== null) return recordSkip(s, entry, no);
      if (thisRun(s) === null) return recordSkip(s, entry, AFTER_SELECTION);
      if (has(i.probes, p.probe) || !plannedProbes(s).some((x) => x.probe === p.probe)) return recordSkip(s, entry, "a probe starts once, for a planned probe of the run");
      const probe: ProbeState = {
        probe: p.probe, candidate: p.candidate, task: p.task, child: p.child, origin: p.origin, loop_hash: p.loop_hash, input_hash: p.input_hash,
        budgets: { lookups: p.budgets.lookups, tokens: p.budgets.tokens }, started_seq: entry.seq, finished: null,
      };
      return withImprove(s, { probes: { ...i.probes, [p.probe]: probe }, probe_order: [...i.probe_order, p.probe] });
    }
    case "probe.finished": {
      const p = entry.payload as unknown;
      if (!isProbeFinished(p)) return malformed(s, entry);
      const no = runRefusal(s, bySystem, BY_WORKBENCH);
      if (no !== null) return recordSkip(s, entry, no);
      const open = has(i.probes, p.probe) ? i.probes[p.probe]! : null;
      if (open === null || open.finished !== null || open.child !== p.child) return recordSkip(s, entry, "a probe finishes once, as the child it started");
      const finished: ProbeState["finished"] = {
        child_run: p.child_run, head: copyHead(p.head), outcome: p.outcome, reason: p.reason, draft_hash: p.draft_hash, output_hash: p.output_hash,
        output: copyRef(p.output), lookups: p.lookups, tokens: p.tokens, seq: entry.seq,
      };
      return withImprove(s, { probes: { ...i.probes, [p.probe]: { ...open, finished } } });
    }
    case "compose.chosen": {
      const p = entry.payload as unknown;
      if (!isChosen(p)) return malformed(s, entry);
      const no = runRefusal(s, entry.actor.kind !== "human", "Compose chooses; the person decides at Adopt");
      if (no !== null) return recordSkip(s, entry, no);
      if (thisRun(s) === null) return recordSkip(s, entry, AFTER_SELECTION);
      if (i.chosen !== null) return recordSkip(s, entry, "Compose chooses once in a run");
      if (!plannedProbes(s).every((x) => has(i.probes, x.probe) && i.probes[x.probe]!.finished !== null)) return recordSkip(s, entry, "Compose chooses once every probe has ended");
      if (p.candidate !== null && !stagedCandidates(s).some((c) => c.candidate === p.candidate)) return recordSkip(s, entry, "Compose chooses a staged candidate or none");
      return withImprove(s, { chosen: { candidate: p.candidate, why: p.why, contrasts: copyRef(p.contrasts), by: entry.actor.id, seq: entry.seq } });
    }
    case "judge.scored": {
      const p = entry.payload as unknown;
      if (!isScored(p)) return malformed(s, entry);
      const no = runRefusal(s, bySystem, BY_WORKBENCH);
      if (no !== null) return recordSkip(s, entry, no);
      if (thisRun(s) === null) return recordSkip(s, entry, AFTER_SELECTION);
      if (i.scored !== null) return recordSkip(s, entry, "the judge scores once in a run");
      if (i.chosen === null) return recordSkip(s, entry, "the judge runs after Compose has chosen");
      const summary = p.summary.map((r) => ({ candidate: r.candidate, score: r.score, drafted: r.drafted, tasks: r.tasks }));
      return withImprove(s, { scored: { answers: copyRef(p.answers), scores: copyRef(p.scores), matcher: p.matcher, summary, seq: entry.seq } });
    }
    default:
      return s;
  }
}

/**
 * answer.known and answer.withdrawn (a task case's), improve.requested and the record of an improve case's run, and probe.child (a probe
 * child's mark). Last of the reducers: it reads the published products, the drafts, the run and the builder's changes as this entry left
 * them, and changes nothing but `answers` and `improve`.
 */
export function applyImprove(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "answer.known":
    case "answer.withdrawn":
      return applyAnswers(s, entry);
    case "improve.requested": {
      const p = entry.payload as unknown;
      if (!isRequested(p)) return malformed(s, entry);
      if (entry.actor.kind !== "human" || entry.seq > 3 || s.meta === null || s.run.status !== "none" || s.improve.request !== null) return recordSkip(s, entry, REQUESTED);
      return withImprove(s, { request: { target: p.target, case_type: p.case_type, tasks: p.tasks, candidates: p.candidates, by: entry.actor.id } });
    }
    case "improve.selected":
    case "improve.task":
    case "improve.candidate":
    case "probe.started":
    case "probe.finished":
    case "compose.chosen":
    case "judge.scored":
      return applyRunRecord(s, entry);
    case "probe.child": {
      const p = entry.payload as unknown;
      if (!isMark(p)) return malformed(s, entry);
      // only in the child's first commit, by code, once, before any run
      if (entry.actor.kind !== "system" || s.loop.parent === null || s.run.status !== "none" || s.improve.probe_of !== null) {
        return recordSkip(s, entry, "a probe child is marked by the workbench when it is made");
      }
      return withImprove(s, {
        probe_of: { improve: p.improve, origin: p.origin, probe: p.probe, candidate: p.candidate, task: p.task, plan_gate: p.plan_gate, max_lookups: p.max_lookups },
      });
    }
    default:
      return s;
  }
}

/**
 * Why the fold skips this entry before any reducer sees it; null for every entry an old ledger can hold. improve-probe acts only in a probe
 * child, and there writes only the five entries of a code acceptance of its plan, a resume of an interrupted run or of a run held for the person's
 * answer to a question (going on without it, as the person's resume does: no person is there to answer), and its end; only a person
 * passes the adopt gate; and a probe child never publishes.
 */
export function probeVeto(s: Readonly<CaseState>, entry: Entry): string | null {
  const p = entry.payload as unknown as Record<string, unknown>;
  const child = s.improve.probe_of !== null;
  if (entry.actor.kind === "system" && entry.actor.id === PROBE_ACTOR_ID) {
    if (!child) return "improve-probe acts only in a probe child";
    const allowed = entry.type === "plan.accepted" || entry.type === "lane.created" || (entry.type === "gate.passed" && p.gate === "plan")
      || (entry.type === "run.resumed" && (s.run.status === "interrupted" || (s.run.status === "paused" && s.run.hold?.kind === "question")))
      || (entry.type === "run.finished" && p.outcome === "stopped");
    if (!allowed) return "improve-probe accepts a probe's plan, resumes an interrupted probe or ends it, and nothing else";
  }
  if (entry.type === "gate.passed" && p.gate === "adopt" && entry.actor.kind !== "human") return "only a person passes the adopt gate";
  if (child && (entry.type === "product.published" || (entry.type === "gate.passed" && p.gate === "publish"))) return "a probe child never publishes";
  return null;
}

/** The staged candidates, in order. */
export function stagedCandidates(state: Readonly<CaseState>): CandidateState[] {
  const i = state.improve;
  return i.candidate_order.filter((k) => has(i.candidates, k)).map((k) => i.candidates[k]!).filter((c) => c.status === "staged");
}

/** The probes a run needs: base and each staged candidate, for each task, base first, then candidate order, tasks in order. */
export function plannedProbes(state: Readonly<CaseState>): { probe: string; candidate: string; task: string }[] {
  const out: { probe: string; candidate: string; task: string }[] = [];
  for (const candidate of [BASE, ...stagedCandidates(state).map((c) => c.candidate)]) {
    for (const task of state.improve.task_order) out.push({ probe: probeId(candidate, task), candidate, task });
  }
  return out;
}

/** The change Adopt offers (the chosen candidate's) and whether a file of it is undecided; null when nothing was chosen. */
export function adoptOffer(state: Readonly<CaseState>): { candidate: string; change: string; undecided: number } | null {
  const chosen = state.improve.chosen;
  if (chosen === null || chosen.candidate === null || !has(state.improve.candidates, chosen.candidate)) return null;
  const c = state.improve.candidates[chosen.candidate]!;
  if (!has(state.builder.changes, c.change)) return null;
  const undecided = state.builder.changes[c.change]!.files.filter((f) => f.decided === null).length;
  return { candidate: c.candidate, change: c.change, undecided };
}


// ---------- the blobs of an improve case ----------

/** What Select took of a task's question: the words and values its Probe children start from. */
export interface TaskInputs { question: string; starting: Observable[]; window: TimeWindow; objective: string | null; marking: Marking; title: string }
/** What Select took of a task's run, from named fields of its state: never its known answer. */
export interface TaskRecord {
  product: Product; stages: { id: string; title: string; status: string; attempts: number; last_reason: string | null }[];
  queries: { source: string; pivot: string | null; outcome: string; rows: number | null }[]; questions: number; sendbacks: number; usage: { input: number; output: number; calls: number };
}
/** What a probe child gave, from its state alone. */
export interface ProbeOutput {
  format: 1; outcome: "drafted" | "incomplete"; reason: string; draft_hash: string | null; product: Product | null;
  stats: { lookups: number; tokens: number; model_calls: number; stages: { id: string; status: string; attempts: number }[] };
}
/** How a candidate's output on a task differs from the base's. */
export interface Contrast {
  task: string; candidate: string; base: "drafted" | "incomplete"; now: "drafted" | "incomplete"; added: string[]; removed: string[];
  changed: { statement: string; likelihood: [string, string] | null; confidence: [string, string] | null }[]; lookups: [number, number]; tokens: [number, number];
}
/** A known answer as the Judge copied it into the improve case. */
export interface AnswerCopy { task: string; seq: number; hash: string; text: string; findings: ExpectedFinding[]; marking: Marking }
export interface FindingScore {
  expected: number; produced: string | null; by: "code" | "model" | null; similarity: number | null; likelihood_distance: number | null; confidence_distance: number | null; score: number;
}
export interface OutputScore {
  probe: string; candidate: string; task: string; outcome: "drafted" | "incomplete"; score: number | null; text: "agrees" | "partly" | "disagrees" | null; findings: FindingScore[];
  left_over: string[];
}
export interface ScoreSheet { format: 1; scale: string[]; outputs: OutputScore[]; summary: { candidate: string; score: number; drafted: number; tasks: number }[] }

const TEXT_VERDICTS = ["agrees", "partly", "disagrees"] as const;
const BY = ["code", "model"] as const;
const isPair = (x: unknown, item: (y: unknown) => boolean): boolean => Array.isArray(x) && x.length === 2 && x.every(item);
const isDistance = (x: unknown): x is number | null => x === null || (isNum(x) && x >= 0);
const isCountOrNull = (x: unknown): x is number | null => x === null || isCount(x);

const isTaskInputs = (x: unknown): x is TaskInputs =>
  isObj(x) && isStr(x.question) && Array.isArray(x.starting) && x.starting.every(isObservable) && isTimeWindow(x.window) && isStrOrNull(x.objective)
  && isMarking(x.marking) && isStr(x.title);
const isTaskRecord = (x: unknown): x is TaskRecord =>
  isObj(x) && isProduct(x.product)
  && Array.isArray(x.stages) && x.stages.every((st) => isObj(st) && isStr(st.id) && isStr(st.title) && isStr(st.status) && isCount(st.attempts) && isStrOrNull(st.last_reason))
  && Array.isArray(x.queries) && x.queries.every((q) => isObj(q) && isStr(q.source) && isStrOrNull(q.pivot) && isStr(q.outcome) && isCountOrNull(q.rows))
  && isCount(x.questions) && isCount(x.sendbacks) && isObj(x.usage) && isCount(x.usage.input) && isCount(x.usage.output) && isCount(x.usage.calls);
const isProbeOutput = (x: unknown): x is ProbeOutput =>
  isObj(x) && x.format === PROBE_OUTPUT_FORMAT && isOneOf(x.outcome, PROBE_OUTCOMES) && isStr(x.reason)
  && (x.outcome === "drafted" ? isId(x.draft_hash) && isProduct(x.product) : x.draft_hash === null && x.product === null)
  && isObj(x.stats) && isCount(x.stats.lookups) && isCount(x.stats.tokens) && isCount(x.stats.model_calls)
  && Array.isArray(x.stats.stages) && x.stats.stages.every((st) => isObj(st) && isStr(st.id) && isStr(st.status) && isCount(st.attempts));
const isContrast = (x: unknown): x is Contrast =>
  isObj(x) && isId(x.task) && isId(x.candidate) && isOneOf(x.base, PROBE_OUTCOMES) && isOneOf(x.now, PROBE_OUTCOMES) && isStrList(x.added) && isStrList(x.removed)
  && Array.isArray(x.changed) && x.changed.every((c) => isObj(c) && isStr(c.statement) && (c.likelihood === null || isPair(c.likelihood, isStr)) && (c.confidence === null || isPair(c.confidence, isStr)))
  && isPair(x.lookups, isCount) && isPair(x.tokens, isCount);
const isAnswerCopy = (x: unknown): x is AnswerCopy =>
  isObj(x) && isId(x.task) && isCount(x.seq) && isStr(x.hash) && isTextUpTo(x.text, ANSWER_TEXT_MAX) && isExpectedList(x.findings) && isMarking(x.marking);
const isFindingScore = (x: unknown): x is FindingScore =>
  isObj(x) && isCount(x.expected) && isStrOrNull(x.produced) && (x.by === null || isOneOf(x.by, BY)) && (x.similarity === null || isScore(x.similarity))
  && isDistance(x.likelihood_distance) && isDistance(x.confidence_distance) && isScore(x.score);
const isOutputScore = (x: unknown): x is OutputScore =>
  isObj(x) && isId(x.probe) && isId(x.candidate) && isId(x.task) && isOneOf(x.outcome, PROBE_OUTCOMES) && (x.score === null || isScore(x.score))
  && (x.text === null || isOneOf(x.text, TEXT_VERDICTS)) && Array.isArray(x.findings) && x.findings.every(isFindingScore) && isStrList(x.left_over);
const isScoreSheet = (x: unknown): x is ScoreSheet =>
  isObj(x) && x.format === 1 && isStrList(x.scale) && Array.isArray(x.outputs) && x.outputs.every(isOutputScore)
  && Array.isArray(x.summary) && x.summary.every((r) => isObj(r) && isId(r.candidate) && isScore(r.score) && isCount(r.drafted) && isCount(r.tasks));

/** The JSON in `b`, or undefined when the bytes are not UTF-8 JSON. */
function parsed(b: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
  } catch {
    return undefined;
  }
}
const reader = <T>(is: (x: unknown) => x is T) => (b: Uint8Array): T | null => { const x = parsed(b); return is(x) ? x : null; };

export const readTaskInputs: (b: Uint8Array) => TaskInputs | null = reader(isTaskInputs);
export const readTaskRecord: (b: Uint8Array) => TaskRecord | null = reader(isTaskRecord);
export const readProbeOutput: (b: Uint8Array) => ProbeOutput | null = reader(isProbeOutput);
export const readContrasts: (b: Uint8Array) => Contrast[] | null = reader((x): x is Contrast[] => Array.isArray(x) && x.every(isContrast));
export const readAnswers: (b: Uint8Array) => AnswerCopy[] | null = reader((x): x is AnswerCopy[] => Array.isArray(x) && x.every(isAnswerCopy));
export const readScoreSheet: (b: Uint8Array) => ScoreSheet | null = reader(isScoreSheet);

/** Why a child gave no draft, from its run as it stands. */
function incompleteReason(child: Readonly<CaseState>): string {
  const { run } = child;
  switch (run.status) {
    case "none": return "its run has not started";
    case "paused": return run.pause_reason ?? "it is paused";
    case "waiting": return run.waiting === null ? "it waits for a person" : `it waits for a person at its ${run.waiting} gate`;
    case "interrupted": return "its run was interrupted";
    case "running": return "it is still running";
    case "finished": return run.outcome === "stopped" ? "its run was stopped" : "it finished with no draft";
  }
}

/** What a probe child gives, from its state alone: drafted when it has a draft and its run waits at its publish gate or finished completed; else incomplete, with why. */
export function probeOutputOf(child: Readonly<CaseState>): ProbeOutput {
  const { run } = child;
  const stats: ProbeOutput["stats"] = {
    lookups: Object.keys(child.queries).length, tokens: run.usage.input + run.usage.output, model_calls: run.model_calls,
    stages: run.stages.map((st) => ({ id: st.id, status: st.status, attempts: st.attempts })),
  };
  const draft = latestDraft(child as CaseState);
  const ended = (run.status === "waiting" && run.waiting === "publish") || (run.status === "finished" && run.outcome === "completed");
  if (draft !== null && ended) return { format: PROBE_OUTPUT_FORMAT, outcome: "drafted", reason: "", draft_hash: draft.hash, product: draft.product, stats };
  return { format: PROBE_OUTPUT_FORMAT, outcome: "incomplete", reason: incompleteReason(child), draft_hash: null, product: null, stats };
}
