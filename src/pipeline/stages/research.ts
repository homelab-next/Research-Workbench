import type { Json } from "../../core/canonical";
import type { Actor } from "../../core/types";
import type { PlanStep } from "../../core/types";
import { spendPlanBudget } from "../plans";
import type { StageEnd, StageEnv } from "../engine";
import { stageAgent } from "./agent";
import type { AgentStageEnd } from "./agent";

const ENGINE: Actor = { kind: "system", id: "engine" };
const DONE = new Set(["answered", "empty", "partial"]);

interface Unit { actor_id: string; title: string; task: string; subgoal: string | null; question: string | null }
interface SubResult { id: string; title: string; outcome: "answered" | "blocked"; cards: string[]; note: string }

const noteOf = (end: AgentStageEnd | undefined): string => {
  if (end === undefined || end.kind !== "output" || end.output === null || typeof end.output !== "object" || Array.isArray(end.output)) return "";
  const note = (end.output as Record<string, Json>).note;
  return typeof note === "string" ? note : "";
};

const describeStep = (s: PlanStep): string =>
  `- ${s.id}: ${s.pivot} on ${s.source}, from ${s.from.type} ${s.from.value === "" ? "(the value an earlier step found)" : s.from.value} to ${s.to}${s.free ? "" : " (costly)"}`;

/**
 * Research: one researcher per sub-goal with an accepted step, at most `research.parallel` at once, each as its own job. When Assemble sent
 * the run back, one researcher per question asked for instead. A sub-goal is answered by what its steps finished as, not by what the
 * researcher says.
 */
export async function researchRunner(env: StageEnv): Promise<StageEnd> {
  const { session, deps, stage } = env;
  const plan = session.state.plan;
  if (plan.current === null || plan.status !== "accepted") return { kind: "stalled", reason: "Research: there is no accepted plan" };
  const current = plan.current;
  const entries = session.entries();
  const lastFinished = entries.reduce((n, e) => (e.type === "stage.finished" && e.payload.stage === stage.id ? e.seq : n), 0);
  const sentBack = entries.some((e) => e.type === "stage.sent_back" && e.payload.to === stage.id && e.seq > lastFinished);

  const accepted = (g: { steps: string[] }): string[] => g.steps.filter((s) => plan.accepted_steps.includes(s));
  const statusOf = (step: string): string => (Object.hasOwn(session.state.plan.steps, step) ? session.state.plan.steps[step]!.status : "pending");
  const goals = current.subgoals.filter((g) => accepted(g).length > 0);
  const actorId = (suffix: string): string => `${deps.profile.stages[stage.id]?.agent ?? "researcher"}-${suffix}`;

  const units: Unit[] = [];
  if (sentBack) {
    let n = 0;
    for (const e of entries) {
      if (e.type !== "research.requested") continue;
      n++;
      if (e.seq > lastFinished) {
        units.push({ actor_id: actorId(`r${n}`), title: `Research: ${e.payload.question}`, subgoal: null, question: e.payload.question, task: e.payload.question });
      }
    }
  } else {
    for (const g of goals) {
      if (accepted(g).every((s) => DONE.has(statusOf(s)))) continue;
      const steps = current.steps.filter((s) => accepted(g).includes(s.id));
      units.push({
        actor_id: actorId(g.id), title: `Research: ${g.title}`, subgoal: g.id, question: null,
        task: [`Research sub-goal ${g.id}: ${g.title}`, `Question: ${g.question}`, "Run these accepted steps with run_step, in order, then report what each returned:", ...steps.map(describeStep)].join("\n"),
      });
    }
  }

  const results: (AgentStageEnd | undefined)[] = units.map(() => undefined);
  const runUnit = async (u: Unit): Promise<AgentStageEnd> => {
    let job = "";
    session.commit((s, ids) => {
      job = ids.next("job");
      return [{ type: "job.started", actor: ENGINE, run: s.run.id, stage: stage.id, job, payload: { job, title: u.title, kind: "research", source: null } }];
    });
    const close = (outcome: "done" | "failed"): void => {
      session.commit((s) => [{ type: "job.finished", actor: ENGINE, run: s.run.id, stage: stage.id, job, payload: { job, outcome } }]);
    };
    let end: AgentStageEnd;
    try {
      end = await stageAgent(env, {
        actor_id: u.actor_id, task: u.task, extras: [], subgoal: u.subgoal, job,
        onNeedsBudget: (p, step) => spendPlanBudget(session, deps.runner, p, step),
      });
    } catch (err) {
      close("failed");
      throw err;
    }
    close(end.kind === "output" ? "done" : "failed");
    return end;
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (session.state.run.status === "paused") return;
      const i = next++;
      if (i >= units.length) return;
      results[i] = await runUnit(units[i]!);
    }
  };
  const settled = await Promise.allSettled(Array.from({ length: Math.min(Math.max(1, deps.config.research.parallel), units.length) }, worker));
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failure !== undefined) throw failure.reason;

  if (results.some((r) => r === undefined)) return { kind: "stopped" };
  const ends = results as AgentStageEnd[];
  for (const kind of ["stopped", "declined", "blocked", "stalled"] as const) {
    const hit = ends.find((e) => e.kind === kind);
    if (hit !== undefined && hit.kind !== "output") return hit;
  }

  const noteFor = (subgoal: string): string => noteOf(results[units.findIndex((u) => u.subgoal === subgoal)]);
  const subgoals: SubResult[] = goals.map((g) => {
    const steps = accepted(g);
    const last = steps[steps.length - 1]!;
    const cards = [...new Set(steps.flatMap((s) => (Object.hasOwn(session.state.plan.steps, s) ? session.state.plan.steps[s]!.cards : [])))];
    const outcome = statusOf(last) === "answered" || statusOf(last) === "partial" ? "answered" : "blocked";
    return { id: g.id, title: g.title, outcome, cards, note: noteFor(g.id) };
  });
  const requested = units.flatMap((u, i) => (u.question === null ? [] : [{ question: u.question, note: noteOf(results[i]) }]));
  const output = { subgoals, requested } as unknown as Json;
  if (subgoals.some((g) => g.outcome === "answered") || requested.length > 0) return { kind: "finished", outcome: "pass", draft_hash: null, output, reason: null };
  const notes = subgoals.map((g) => `${g.title}: ${g.note === "" ? "no note" : g.note}`).join("; ");
  return { kind: "finished", outcome: "fail", draft_hash: null, output, reason: `no sub-goal could be answered: ${notes}` };
}
