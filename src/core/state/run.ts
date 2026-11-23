import type { Entry, ModelChoice, Plan, PlanStep, Proposal, StageDef, Window } from "../types";
import type { CaseState, JobState, PlanState, ProposalState, QueryState, RunState, StageState } from "./types";

const isStr = (x: unknown): x is string => typeof x === "string";
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStrList = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);
const isOneOf = <T extends string>(x: unknown, set: readonly T[]): x is T => isStr(x) && (set as readonly string[]).includes(x);
const has = <T>(rec: Record<string, T>, id: unknown): id is string => isStr(id) && Object.hasOwn(rec, id);

const isModel = (x: unknown): x is ModelChoice => isObj(x) && isStr(x.provider) && isStr(x.model) && (x.effort === null || isStr(x.effort));
const isWindow = (x: unknown): x is Window => isObj(x) && (x.from === null || isStr(x.from)) && (x.to === null || isStr(x.to));
const isStageDef = (x: unknown): x is StageDef =>
  isObj(x) && isStr(x.id) && isStr(x.title) && (x.phase === null || isStr(x.phase)) && isOneOf(x.runs, ["agent", "script", "human"])
  && (x.gate === null || isOneOf(x.gate, ["plan", "publish"])) && typeof x.reviews === "boolean" && (x.model === null || isModel(x.model));

const isCost = (x: unknown): boolean => isObj(x) && isNum(x.amount) && isStr(x.unit);
const isStep = (x: unknown): x is PlanStep =>
  isObj(x) && isStr(x.id) && isStr(x.subgoal) && isStr(x.pivot) && isStr(x.source)
  && isObj(x.from) && isStr(x.from.type) && isStr(x.from.value) && isStr(x.to) && isWindow(x.window)
  && typeof x.needs_window === "boolean" && typeof x.free === "boolean" && isNum(x.weight) && (x.estimate === null || isCost(x.estimate))
  && isOneOf(x.empty_means, ["proven-negative", "not-seen"]) && isStrList(x.warnings);
const isSubGoal = (x: unknown): boolean => isObj(x) && isStr(x.id) && isStr(x.title) && isStr(x.question) && isStrList(x.steps);
const isPlan = (x: unknown): x is Plan =>
  isObj(x) && isStr(x.id) && isStr(x.goal) && isWindow(x.window)
  && Array.isArray(x.subgoals) && x.subgoals.every(isSubGoal) && Array.isArray(x.steps) && x.steps.every(isStep);
const SECTIONS = ["summary", "key_findings", "gaps_and_limits", "alternatives", "assessment"] as const;
const isProposal = (x: unknown): x is Proposal => {
  if (!isObj(x) || !isStr(x.id) || !isStr(x.title) || !isStr(x.by)) return false;
  if (x.kind === "costly_query") return (x.step === null || isStr(x.step)) && isStr(x.source) && isStr(x.text) && isCost(x.estimate) && isStr(x.why);
  if (x.kind === "narrative") return isOneOf(x.section, SECTIONS) && isStr(x.text) && isStrList(x.cites);
  return false;
};

const GATES = ["plan", "publish"] as const;
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
      if (!isPlan(plan)) return s;
      // fromEntries defines own properties, so a step id of "__proto__" is an ordinary key
      const steps: PlanState["steps"] = Object.fromEntries(plan.steps.map((st) => [st.id, { status: "pending" as const, cards: [], note: "" }]));
      return { ...s, plan: { current: plan, status: "proposed", accepted_steps: [], budgets: {}, steps } };
    }
    case "plan.accepted": {
      const { plan, steps, budgets } = entry.payload;
      if (p.current?.id !== plan || !isStrList(steps) || !isObj(budgets) || !Object.values(budgets).every(isNum)) return s;
      return { ...s, plan: { ...p, status: "accepted", accepted_steps: steps, budgets: budgets as Record<string, number> } };
    }
    case "plan.denied": {
      if (p.current?.id !== entry.payload.plan || !isStr(entry.payload.reason)) return s;
      return { ...s, plan: { ...p, status: "denied" } };
    }
    case "plan.replan_requested": {
      if (p.current?.id !== entry.payload.plan || !isStr(entry.payload.note)) return s;
      return { ...s, plan: { ...p, status: "replanning" } };
    }
    case "step.started": {
      const { step } = entry.payload;
      if (!has(p.steps, step)) return s;
      return { ...s, plan: { ...p, steps: { ...p.steps, [step]: { ...p.steps[step]!, status: "running" } } } };
    }
    case "step.finished": {
      const { step, outcome, cards, note } = entry.payload;
      if (!has(p.steps, step) || !isOneOf(outcome, ["answered", "empty", "partial", "blocked", "failed"]) || !isStrList(cards) || !isStr(note)) return s;
      return { ...s, plan: { ...p, steps: { ...p.steps, [step]: { status: outcome, cards, note } } } };
    }
    default:
      return s;
  }
}
function applyQuery(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "query.issued": {
      const { query, source, text, why, window, step, verifies } = entry.payload;
      if (!isStr(query) || Object.hasOwn(s.queries, query) || !isStr(source) || !isStr(text) || !isStr(why) || !isWindow(window)) return s;
      if (!(step === null || isStr(step)) || !(verifies === null || isStr(verifies))) return s;
      const q: QueryState = {
        id: query, source, text, why, window, by: entry.actor, step, verifies,
        issued_seq: entry.seq, issued_ts: entry.ts, status: "running",
        rows: null, rows_hash: null, coverage: null, result: null, error: null, card: null,
      };
      return { ...s, queries: { ...s.queries, [query]: q } };
    }
    case "query.result": {
      const { query, result, rows, rows_hash, coverage } = entry.payload;
      if (!has(s.queries, query) || s.queries[query]!.status !== "running") return s;
      if (!isObj(result) || !isStr(result.blob) || !isNum(result.bytes) || !isNum(rows) || !isStr(rows_hash) || !isObj(coverage) || !isStr(coverage.kind)) return s;
      return { ...s, queries: { ...s.queries, [query]: { ...s.queries[query]!, status: "done", rows, rows_hash, coverage, result } } };
    }
    case "query.failed": {
      const { query, error } = entry.payload;
      if (!has(s.queries, query) || s.queries[query]!.status !== "running" || !isStr(error)) return s;
      return { ...s, queries: { ...s.queries, [query]: { ...s.queries[query]!, status: "failed", error } } };
    }
    case "card.created": {
      const c = entry.payload.card;
      // only the entry that created the card links it (applyCards ran first)
      if (!isObj(c) || !isStr(c.id) || !has(s.queries, c.query) || !Object.hasOwn(s.cards, c.id) || s.cards[c.id]!.created_seq !== entry.seq) return s;
      return { ...s, queries: { ...s.queries, [c.query]: { ...s.queries[c.query]!, card: c.id } } };
    }
    case "verify.run": {
      const { card, outcome, detail } = entry.payload;
      if (!has(s.cards, card) || !isOneOf(outcome, ["matches", "differs", "could_not_run"]) || !isStr(detail)) return s;
      return { ...s, cards: { ...s.cards, [card]: { ...s.cards[card]!, validated: { outcome, detail, seq: entry.seq, ts: entry.ts } } } };
    }
    default:
      return s;
  }
}

function applyJobsAndProposals(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "job.started": {
      const { job, title, kind, source } = entry.payload;
      if (!isStr(job) || Object.hasOwn(s.jobs, job) || !isStr(title) || !isOneOf(kind, ["research", "query", "model", "check"]) || !(source === null || isStr(source))) return s;
      const j: JobState = { id: job, title, kind, source, status: "running", started_ts: entry.ts, ended_ts: null };
      return { ...s, jobs: { ...s.jobs, [job]: j } };
    }
    case "job.finished": {
      const { job, outcome } = entry.payload;
      if (!has(s.jobs, job) || s.jobs[job]!.status !== "running" || !isOneOf(outcome, ["done", "failed"])) return s;
      return { ...s, jobs: { ...s.jobs, [job]: { ...s.jobs[job]!, status: outcome, ended_ts: entry.ts } } };
    }
    case "proposal.created": {
      const p = entry.payload.proposal;
      if (!isProposal(p) || Object.hasOwn(s.proposals, p.id)) return s;
      const state: ProposalState = { ...p, status: "open", seq: entry.seq, budget: null, reason: null };
      return { ...s, proposals: { ...s.proposals, [p.id]: state } };
    }
    case "proposal.accepted": {
      const { proposal, budget } = entry.payload;
      if (!has(s.proposals, proposal) || s.proposals[proposal]!.status !== "open" || !(budget === null || isNum(budget))) return s;
      return { ...s, proposals: { ...s.proposals, [proposal]: { ...s.proposals[proposal]!, status: "accepted", budget } } };
    }
    case "proposal.rejected": {
      const { proposal, reason } = entry.payload;
      if (!has(s.proposals, proposal) || s.proposals[proposal]!.status !== "open" || !isStr(reason)) return s;
      return { ...s, proposals: { ...s.proposals, [proposal]: { ...s.proposals[proposal]!, status: "rejected", reason } } };
    }
    default:
      return s;
  }
}

/** Entries that cannot change a finished run; only the next run.started does. */
const FROZEN_WHEN_FINISHED: readonly string[] = [
  "run.paused", "run.resumed", "run.interrupted", "run.finished", "gate.waiting", "gate.passed",
  "stage.started", "stage.finished", "stage.sent_back", "model.blocked",
];

function applyPipeline(s: CaseState, entry: Entry): CaseState {
  if (s.run.status === "finished" && FROZEN_WHEN_FINISHED.includes(entry.type)) return s;
  switch (entry.type) {
    case "run.started": {
      const { run, stages } = entry.payload;
      if (!isStr(run) || !Array.isArray(stages) || !stages.every(isStageDef)) return s;
      if (new Set(stages.map((d) => d.id)).size !== stages.length) return s;
      const built: StageState[] = stages.map((d) => ({
        ...d, model: Object.hasOwn(s.stage_models, d.id) ? s.stage_models[d.id]! : d.model, status: "idle", attempts: 0, last_reason: null,
      }));
      return withRun(s, {
        id: run, status: "running", outcome: null, pause_reason: null, waiting: null, stages: built, current: null,
        sendbacks: {},
      });
    }
    case "run.paused": {
      if (!hasRun(s) || !isStr(entry.payload.reason)) return s;
      return withRun(s, { status: "paused", pause_reason: entry.payload.reason });
    }
    case "run.resumed":
      return hasRun(s) ? withRun(s, { status: s.run.waiting ? "waiting" : "running", pause_reason: null }) : s;
    case "run.interrupted":
      return hasRun(s) ? withRun(s, { status: "interrupted" }) : s;
    case "run.finished": {
      if (!hasRun(s) || !isOneOf(entry.payload.outcome, ["published", "stopped"])) return s;
      return withRun(s, { status: "finished", outcome: entry.payload.outcome });
    }
    case "stage.model_set": {
      const { stage, choice } = entry.payload;
      if (!isStr(stage) || !isModel(choice)) return s;
      const next = { ...s, stage_models: { ...s.stage_models, [stage]: choice } };
      return withStage(next, stage, (st) => ({ ...st, model: choice }));
    }
    case "stage.started": {
      const { stage, attempt } = entry.payload;
      if (!isNum(attempt)) return s;
      const next = withStage(s, stage, (st) => ({ ...st, status: "running", attempts: attempt }));
      if (next === s) return s;
      const leaving = s.run.status === "waiting";
      return withRun(next, { current: stage as string, status: s.run.status === "paused" ? "paused" : "running", waiting: leaving ? null : s.run.waiting });
    }
    case "stage.finished": {
      const { stage, outcome, reason } = entry.payload;
      if (!isOneOf(outcome, ["pass", "fail", "declined"]) || !(reason === null || isStr(reason))) return s;
      return withStage(s, stage, (st) => ({ ...st, status: OUTCOME_STATUS[outcome], last_reason: reason }));
    }
    case "stage.sent_back": {
      const { from, to, count } = entry.payload;
      if (!isStr(from) || !isStr(to) || !isNum(count) || !isStr(entry.payload.reason)) return s;
      if (!s.run.stages.some((x) => x.id === from)) return s;
      const next = withStage(s, to, (st) => ({ ...st, status: "idle" }));
      if (next === s) return s;
      return withRun(next, { sendbacks: { ...s.run.sendbacks, [`${from}>${to}`]: count } });
    }
    case "gate.waiting": {
      const { gate } = entry.payload;
      if (!isOneOf(gate, GATES)) return s;
      const target = s.run.stages.find((x) => x.gate === gate);
      if (!target) return s;
      const next = withStage(s, target.id, (st) => ({ ...st, status: "waiting" }));
      return withRun(next, { status: "waiting", waiting: gate });
    }
    case "gate.passed": {
      const { gate } = entry.payload;
      if (!isOneOf(gate, GATES) || s.run.waiting !== gate) return s;
      const target = s.run.stages.find((x) => x.gate === gate);
      const next = target ? withStage(s, target.id, (st) => (st.status === "waiting" ? { ...st, status: "passed" } : st)) : s;
      return withRun(next, { status: s.run.status === "waiting" ? "running" : s.run.status, waiting: null });
    }
    case "budget.set": {
      const { tokens } = entry.payload;
      return tokens === null || isNum(tokens) ? withRun(s, { budget_tokens: tokens }) : s;
    }
    case "model.response": {
      const u = entry.payload.usage;
      if (!isObj(u) || !isNum(u.input) || !isNum(u.output) || !isNum(u.reasoning)) return s;
      const { usage } = s.run;
      return withRun(s, {
        usage: { input: usage.input + u.input, output: usage.output + u.output, reasoning: usage.reasoning + u.reasoning },
        model_calls: s.run.model_calls + 1,
      });
    }
    case "model.blocked":
      return withStage(s, entry.payload.stage, (st) => ({ ...st, status: "blocked" }));
    default:
      return s;
  }
}

/** Run, plan, queries, jobs and proposals. Anything malformed or pointing at something missing changes nothing. */
export function applyRun(s: CaseState, entry: Entry): CaseState {
  return applyPipeline(applyPlan(applyQuery(applyJobsAndProposals(s, entry), entry), entry), entry);
}
