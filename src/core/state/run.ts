import { EMPTY_MEANS, isMarking, GATES, JOB_KINDS, JOB_OUTCOMES, QUERY_PURPOSES, ROUTE_OUTCOMES, RUN_OUTCOMES, SECTIONS, STAGE_RUNS, STEP_OUTCOMES, VERIFY_OUTCOMES } from "../types";
import type { Cost, Entry, ModelChoice, Plan, PlanStep, Proposal, StageDef, SubGoal } from "../types";
import { has, isBool, isNum, isObj, isOneOf, isStr, isStrList, isStrOrNull, malformed } from "./guards";
import { isBlobRefShape, isCard, isCount, isCoverage, isObservable, isStageFinishedShape, isTimeWindow } from "./shapes";
import type { CaseState, JobState, PlanState, ProposalState, QueryState, RunState, StageState, Usage } from "./types";

const isModel = (x: unknown): x is ModelChoice => isObj(x) && isStr(x.provider) && isStr(x.model) && (x.effort === null || isStr(x.effort));
const isStageDef = (x: unknown): x is StageDef =>
  isObj(x) && isStr(x.id) && isStr(x.title) && (x.phase === null || isStr(x.phase)) && isOneOf(x.runs, STAGE_RUNS)
  && (x.gate === null || isOneOf(x.gate, GATES)) && isBool(x.reviews) && (x.model === null || isModel(x.model));

const isCost = (x: unknown): x is Cost => isObj(x) && isNum(x.amount) && isStr(x.unit);
const isStep = (x: unknown): x is PlanStep =>
  isObj(x) && isStr(x.id) && isStr(x.subgoal) && isStr(x.pivot) && isStr(x.source)
  && isObservable(x.from) && isStr(x.to) && isTimeWindow(x.window)
  && isBool(x.needs_window) && isBool(x.free) && isNum(x.weight) && (x.estimate === null || isCost(x.estimate))
  && isOneOf(x.empty_means, EMPTY_MEANS) && isStrList(x.warnings);
const isSubGoal = (x: unknown): boolean => isObj(x) && isStr(x.id) && isStr(x.title) && isStr(x.question) && isStrList(x.steps);
const isPlan = (x: unknown): x is Plan =>
  isObj(x) && isStr(x.id) && isStr(x.goal) && isTimeWindow(x.window)
  && Array.isArray(x.subgoals) && x.subgoals.every(isSubGoal) && Array.isArray(x.steps) && x.steps.every(isStep);
const isProposal = (x: unknown): x is Proposal => {
  if (!isObj(x) || !isStr(x.id) || !isStr(x.title) || !isStr(x.by)) return false;
  if (x.kind === "costly_query") {
    return isStrOrNull(x.step) && isStrOrNull(x.subgoal) && isStr(x.source) && isStrOrNull(x.pivot) && isStrOrNull(x.pivot_hash) && isStr(x.source_hash) && isStr(x.text)
      && isObj(x.bound) && isTimeWindow(x.window) && (x.estimate === null || isCost(x.estimate)) && isStr(x.why);
  }
  if (x.kind === "narrative") return isOneOf(x.section, SECTIONS) && isStr(x.text) && isStrList(x.cites);
  return false;
};

const OUTCOME_STATUS = { pass: "passed", fail: "failed", declined: "declined" } as const;

function withStage(s: CaseState, id: unknown, change: (st: StageState) => StageState): CaseState {
  if (!isStr(id)) return s;
  const i = s.run.stages.findIndex((x) => x.id === id);
  if (i < 0) return s;
  const stages = s.run.stages.map((x, j) => (j === i ? change(x) : x));
  return { ...s, run: { ...s.run, stages } };
}

const withRun = (s: CaseState, change: Partial<RunState>): CaseState => ({ ...s, run: { ...s.run, ...change } });
const hasRun = (s: CaseState) => s.run.status !== "none";

function applyPlan(s: CaseState, entry: Entry): CaseState {
  const p = s.plan;
  switch (entry.type) {
    case "plan.proposed": {
      const plan = entry.payload.plan;
      if (!isPlan(plan)) return malformed(s, entry);
      // fromEntries defines own properties, so a step id of "__proto__" is an ordinary key
      const steps: PlanState["steps"] = Object.fromEntries(plan.steps.map((st) => [st.id, { status: "pending" as const, cards: [], note: "" }]));
      return { ...s, plan: { current: plan, status: "proposed", accepted_steps: [], budgets: {}, estimates: {}, steps } };
    }
    case "plan.accepted": {
      const { plan, steps, budgets } = entry.payload;
      if (!isStr(plan) || !isStrList(steps) || !isObj(budgets) || !Object.values(budgets).every(isNum)) return malformed(s, entry);
      if (p.current?.id !== plan) return s;
      return { ...s, plan: { ...p, status: "accepted", accepted_steps: steps, budgets: budgets as Record<string, number> } };
    }
    case "plan.denied": {
      if (!isStr(entry.payload.plan) || !isStr(entry.payload.reason)) return malformed(s, entry);
      if (p.current?.id !== entry.payload.plan) return s;
      return { ...s, plan: { ...p, status: "denied" } };
    }
    case "plan.replan_requested": {
      if (!isStr(entry.payload.plan) || !isStr(entry.payload.note)) return malformed(s, entry);
      if (p.current?.id !== entry.payload.plan) return s;
      return { ...s, plan: { ...p, status: "replanning" } };
    }
    case "step.estimated": {
      const { step, estimate, query } = entry.payload;
      if (!isStr(step) || !(estimate === null || isCost(estimate)) || !isStrOrNull(query)) return malformed(s, entry);
      if (!has(p.steps, step)) return s;
      return { ...s, plan: { ...p, estimates: Object.fromEntries([...Object.entries(p.estimates), [step, estimate]]) } };
    }
    case "step.started": {
      const { step } = entry.payload;
      if (!isStr(step)) return malformed(s, entry);
      if (!has(p.steps, step)) return s;
      return { ...s, plan: { ...p, steps: { ...p.steps, [step]: { ...p.steps[step]!, status: "running" } } } };
    }
    case "step.finished": {
      const { step, outcome, cards, note } = entry.payload;
      if (!isStr(step) || !isOneOf(outcome, STEP_OUTCOMES) || !isStrList(cards) || !isStr(note)) return malformed(s, entry);
      if (!has(p.steps, step)) return s;
      return { ...s, plan: { ...p, steps: { ...p.steps, [step]: { status: outcome, cards, note } } } };
    }
    default:
      return s;
  }
}

function applyQuery(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "query.issued": {
      const { query, source, text, why, window, step, verifies, purpose } = entry.payload;
      if (!isStr(query) || !isStr(source) || !isStr(text) || !isStr(why) || !isTimeWindow(window) || !isStrOrNull(step) || !isStrOrNull(verifies)
        || !isOneOf(purpose, QUERY_PURPOSES)) {
        return malformed(s, entry);
      }
      if (Object.hasOwn(s.queries, query)) return s;
      const q: QueryState = {
        id: query, source, text, why, window, by: entry.actor, step, verifies, purpose,
        issued_seq: entry.seq, issued_ts: entry.ts, status: "running",
        rows: null, rows_hash: null, coverage: null, result: null, error: null, card: null,
      };
      return { ...s, queries: { ...s.queries, [query]: q } };
    }
    case "query.result": {
      const { query, result, rows, rows_hash, coverage } = entry.payload;
      if (!isStr(query) || !isBlobRefShape(result) || !isCount(rows) || !isStr(rows_hash) || !isCoverage(coverage)) return malformed(s, entry);
      if (!has(s.queries, query) || s.queries[query]!.status !== "running") return s;
      return { ...s, queries: { ...s.queries, [query]: { ...s.queries[query]!, status: "done", rows, rows_hash, coverage, result } } };
    }
    case "query.failed": {
      const { query, error } = entry.payload;
      if (!isStr(query) || !isStr(error)) return malformed(s, entry);
      if (!has(s.queries, query) || s.queries[query]!.status !== "running") return s;
      return { ...s, queries: { ...s.queries, [query]: { ...s.queries[query]!, status: "failed", error } } };
    }
    case "card.created": {
      const c = entry.payload.card;
      // applyCards ran first and recorded a malformed card; only the entry that created the card links it
      if (!isCard(c) || !has(s.queries, c.query) || !Object.hasOwn(s.cards, c.id) || s.cards[c.id]!.created_seq !== entry.seq) return s;
      return { ...s, queries: { ...s.queries, [c.query]: { ...s.queries[c.query]!, card: c.id } } };
    }
    case "verify.run": {
      const { original, rerun, card, outcome, detail } = entry.payload;
      if (!isStr(original) || !isStrOrNull(rerun) || !isStr(card) || !isOneOf(outcome, VERIFY_OUTCOMES) || !isStr(detail)) return malformed(s, entry);
      if (!has(s.cards, card)) return s;
      return { ...s, cards: { ...s.cards, [card]: { ...s.cards[card]!, validated: { outcome, detail, seq: entry.seq, ts: entry.ts } } } };
    }
    case "route.finished": {
      // the trail is read from the entries; the fold only checks the shape
      const { job, want, outcome, reached, blocked, caveats, cards } = entry.payload;
      if (!isStr(job) || !isStr(want) || !isOneOf(outcome, ROUTE_OUTCOMES) || !Array.isArray(reached) || !reached.every(isObservable)
        || !isStrList(blocked) || !isStrList(caveats) || !isStrList(cards)) return malformed(s, entry);
      return s;
    }
    default:
      return s;
  }
}

function applyJobsAndProposals(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "job.started": {
      const { job, title, kind, source } = entry.payload;
      if (!isStr(job) || !isStr(title) || !isOneOf(kind, JOB_KINDS) || !isStrOrNull(source)) return malformed(s, entry);
      if (Object.hasOwn(s.jobs, job)) return s;
      const j: JobState = { id: job, title, kind, source, status: "running", started_ts: entry.ts, ended_ts: null };
      return { ...s, jobs: { ...s.jobs, [job]: j } };
    }
    case "job.finished": {
      const { job, outcome } = entry.payload;
      if (!isStr(job) || !isOneOf(outcome, JOB_OUTCOMES)) return malformed(s, entry);
      if (!has(s.jobs, job) || s.jobs[job]!.status !== "running") return s;
      return { ...s, jobs: { ...s.jobs, [job]: { ...s.jobs[job]!, status: outcome, ended_ts: entry.ts } } };
    }
    case "proposal.created": {
      const p = entry.payload.proposal;
      if (!isProposal(p)) return malformed(s, entry);
      if (Object.hasOwn(s.proposals, p.id)) return s;
      const state: ProposalState = { ...p, status: "open", seq: entry.seq, budget: null, reason: null };
      return { ...s, proposals: { ...s.proposals, [p.id]: state } };
    }
    case "proposal.accepted": {
      const { proposal, budget } = entry.payload;
      if (!isStr(proposal) || !(budget === null || isNum(budget))) return malformed(s, entry);
      if (!has(s.proposals, proposal) || s.proposals[proposal]!.status !== "open") return s;
      return { ...s, proposals: { ...s.proposals, [proposal]: { ...s.proposals[proposal]!, status: "accepted", budget } } };
    }
    case "proposal.rejected": {
      const { proposal, reason } = entry.payload;
      if (!isStr(proposal) || !isStr(reason)) return malformed(s, entry);
      if (!has(s.proposals, proposal) || s.proposals[proposal]!.status !== "open") return s;
      return { ...s, proposals: { ...s.proposals, [proposal]: { ...s.proposals[proposal]!, status: "rejected", reason } } };
    }
    default:
      return s;
  }
}

/**
 * Whether a stage.finished counts. Both reducers that read it (the stage strip here, the verdict on
 * the draft in analysis.ts) call this, so they cannot disagree: it counts only when it is well
 * formed, a run is in progress (started and not finished) and the stage is one of that run's stages.
 */
export function stageFinishedCounts(s: CaseState, payload: unknown): "malformed" | "ignored" | "counts" {
  if (!isStageFinishedShape(payload)) return "malformed";
  if (!hasRun(s) || s.run.status === "finished" || !s.run.stages.some((st) => st.id === payload.stage)) return "ignored";
  return "counts";
}

function applyPipeline(s: CaseState, entry: Entry): CaseState {
  // Entries that cannot change a finished run are ignored (after their shape is checked); only the next run.started does.
  const finished = s.run.status === "finished";
  switch (entry.type) {
    case "run.started": {
      const { run, stages } = entry.payload;
      if (!isStr(run) || !Array.isArray(stages) || !stages.every(isStageDef) || new Set(stages.map((d) => d.id)).size !== stages.length) {
        return malformed(s, entry);
      }
      const built: StageState[] = stages.map((d) => ({
        ...d, model: Object.hasOwn(s.stage_models, d.id) ? s.stage_models[d.id]! : d.model, status: "idle", attempts: 0, last_reason: null,
      }));
      return withRun(s, {
        id: run, status: "running", outcome: null, pause_reason: null, waiting: null, stages: built, current: null,
        sendbacks: {}, usage_at_start: s.run.usage, calls_at_start: s.run.model_calls,
      });
    }
    case "run.paused": {
      if (!isStr(entry.payload.reason)) return malformed(s, entry);
      if (finished || !hasRun(s)) return s;
      return withRun(s, { status: "paused", pause_reason: entry.payload.reason });
    }
    case "run.resumed":
      return !finished && hasRun(s) ? withRun(s, { status: s.run.waiting ? "waiting" : "running", pause_reason: null }) : s;
    case "run.interrupted":
      return !finished && hasRun(s) ? withRun(s, { status: "interrupted" }) : s;
    case "run.finished": {
      if (!isOneOf(entry.payload.outcome, RUN_OUTCOMES) || (entry.payload.reason !== undefined && !isStr(entry.payload.reason))) return malformed(s, entry);
      if (finished || !hasRun(s)) return s;
      // a finished run waits for nothing, whatever gate it was stopped at
      return withRun(s, { status: "finished", outcome: entry.payload.outcome, waiting: null });
    }
    case "stage.model_set": {
      const { stage, choice } = entry.payload;
      if (!isStr(stage) || !isModel(choice)) return malformed(s, entry);
      const next = { ...s, stage_models: { ...s.stage_models, [stage]: choice } };
      return withStage(next, stage, (st) => ({ ...st, model: choice }));
    }
    case "stage.pack_limit_set": {
      const { stage, max_marking } = entry.payload;
      if (!isStr(stage) || !(max_marking === null || isMarking(max_marking))) return malformed(s, entry);
      const { [stage]: _removed, ...rest } = s.pack_limits;
      // a computed key defines an own property, so a stage id of "__proto__" is an ordinary key
      return { ...s, pack_limits: max_marking === null ? rest : { ...rest, [stage]: max_marking } };
    }
    case "stage.started": {
      const { stage, attempt } = entry.payload;
      if (!isStr(stage) || !isNum(attempt)) return malformed(s, entry);
      if (finished) return s;
      const next = withStage(s, stage, (st) => ({ ...st, status: "running", attempts: attempt }));
      if (next === s) return s;
      // starting any stage but the gate's own takes the run out of its gate, waiting or paused there
      const leaving = s.run.waiting !== null && s.run.stages.find((x) => x.id === stage)?.gate !== s.run.waiting;
      return withRun(next, { current: stage, status: s.run.status === "paused" ? "paused" : "running", waiting: leaving ? null : s.run.waiting });
    }
    case "stage.finished": {
      const verdict = stageFinishedCounts(s, entry.payload);
      if (verdict !== "counts") return verdict === "malformed" ? malformed(s, entry) : s;
      const { stage, outcome, reason } = entry.payload;
      return withStage(s, stage, (st) => ({ ...st, status: OUTCOME_STATUS[outcome], last_reason: reason }));
    }
    case "stage.sent_back": {
      const { from, to, count, reason } = entry.payload;
      if (!isStr(from) || !isStr(to) || !isNum(count) || !isStr(reason)) return malformed(s, entry);
      if (finished || !s.run.stages.some((x) => x.id === from)) return s;
      const next = withStage(s, to, (st) => ({ ...st, status: "idle" }));
      if (next === s) return s;
      return withRun(next, { sendbacks: { ...s.run.sendbacks, [`${from}>${to}`]: count } });
    }
    case "gate.waiting": {
      const { gate } = entry.payload;
      if (!isOneOf(gate, GATES)) return malformed(s, entry);
      if (finished) return s;
      const target = s.run.stages.find((x) => x.gate === gate);
      if (!target) return s;
      const next = withStage(s, target.id, (st) => ({ ...st, status: "waiting" }));
      // a paused run stays paused: gate.passed and run.resumed take it on from there
      return withRun(next, { status: s.run.status === "paused" ? "paused" : "waiting", waiting: gate });
    }
    case "gate.passed": {
      const { gate } = entry.payload;
      if (!isOneOf(gate, GATES)) return malformed(s, entry);
      if (finished || s.run.waiting !== gate) return s;
      const target = s.run.stages.find((x) => x.gate === gate);
      const next = target ? withStage(s, target.id, (st) => (st.status === "waiting" ? { ...st, status: "passed" } : st)) : s;
      return withRun(next, { status: s.run.status === "waiting" ? "running" : s.run.status, waiting: null });
    }
    case "budget.set": {
      const { tokens } = entry.payload;
      if (!(tokens === null || isNum(tokens))) return malformed(s, entry);
      return withRun(s, { budget_tokens: tokens });
    }
    case "model.response": {
      const u = entry.payload.usage;
      if (!isObj(u) || !isNum(u.input) || !isNum(u.output) || !isNum(u.reasoning)) return malformed(s, entry);
      // what your agent says in the conversation is counted apart: a question does not spend the run's budget
      if (entry.actor.kind === "agent" && entry.actor.stage === "agent") {
        const a = s.agent_usage;
        return { ...s, agent_usage: { usage: { input: a.usage.input + u.input, output: a.usage.output + u.output, reasoning: a.usage.reasoning + u.reasoning }, calls: a.calls + 1 } };
      }
      const { usage } = s.run;
      return withRun(s, {
        usage: { input: usage.input + u.input, output: usage.output + u.output, reasoning: usage.reasoning + u.reasoning },
        model_calls: s.run.model_calls + 1,
      });
    }
    case "tool.skipped": {
      const { request, count, note } = entry.payload;
      return isStr(request) && isNum(count) && isStr(note) ? s : malformed(s, entry);
    }
    case "model.blocked": {
      if (!isStr(entry.payload.stage)) return malformed(s, entry);
      if (finished) return s;
      return withStage(s, entry.payload.stage, (st) => ({ ...st, status: "blocked" }));
    }
    default:
      return s;
  }
}

/**
 * The current run's own model usage and call count: the case totals less the totals when it started.
 * Before any run.started this is the whole case. The per-run budget (budget_tokens) is measured against this.
 */
export function runUsage(s: CaseState): { usage: Usage; model_calls: number } {
  const { usage, usage_at_start: at, model_calls, calls_at_start } = s.run;
  return {
    usage: { input: usage.input - at.input, output: usage.output - at.output, reasoning: usage.reasoning - at.reasoning },
    model_calls: model_calls - calls_at_start,
  };
}

/** Run, plan, queries, jobs and proposals. A payload of the wrong shape is recorded in `skipped`; one pointing at something missing changes nothing. */
export function applyRun(s: CaseState, entry: Entry): CaseState {
  return applyPipeline(applyPlan(applyQuery(applyJobsAndProposals(s, entry), entry), entry), entry);
}

/**
 * True when the sub-goal's last accepted step finished answered or partial, or came back empty as a proven negative with full coverage on
 * every card (the answer is "no"). A partial or not-seen empty result is not an answer, and a sub-goal with no accepted step is not answered.
 */
export function subgoalAnswered(state: Readonly<CaseState>, subgoal: SubGoal): boolean {
  const steps = subgoal.steps.filter((id) => state.plan.accepted_steps.includes(id));
  const last = steps[steps.length - 1];
  if (last === undefined) return false;
  const st = Object.hasOwn(state.plan.steps, last) ? state.plan.steps[last]! : null;
  if (st === null) return false;
  if (st.status === "answered" || st.status === "partial") return true;
  if (st.status !== "empty" || st.cards.length === 0) return false;
  return st.cards.every((id) => {
    const c = Object.hasOwn(state.cards, id) ? state.cards[id]! : null;
    return c !== null && c.row_count === 0 && c.empty === "proven-negative" && c.coverage !== null && c.coverage.kind === "full";
  });
}
