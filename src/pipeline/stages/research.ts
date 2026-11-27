import type { Json } from "../../core/canonical";
import { Refused } from "../../core/refused";
import type { Actor, Entry } from "../../core/types";
import type { Marking, PlanStep, StepOutcome } from "../../core/types";
import { strictest } from "../../core/types";
import { subgoalAnswered } from "../../core/state";
import { ContextError, packPart } from "../../agents/context";
import type { PackPart } from "../../agents/context";
import { execTool, TOOLS } from "../../agents/tools";
import type { ToolContext } from "../../agents/tools";
import { stepLine } from "../../agents/tools/research";
import { stepPins } from "../../modules/pins";
import { beginPlaybook, runPlaybook } from "../../modules/playbook-run";
import { spendPlanBudget } from "../plans";
import { DEFAULT_GLEAN_SENDBACKS, gleanOf, gleanSendBack } from "../glean";
import type { StageEnd, StageEnv } from "../engine";
import { frameOf, lastPass, noSchema, requestsOfPass, resolveAgent, stageAgent, stageOfRole, titleOf } from "./agent";
import type { AgentStageEnd } from "./agent";

const ENGINE: Actor = { kind: "system", id: "engine" };
const PLAYBOOK: Actor = { kind: "system", id: "playbook" };
const DONE = new Set(["answered", "empty", "partial"]);

interface Unit { sent_back?: boolean; actor_id: string; title: string; task: string; part: PackPart; subgoal: string | null; question: string | null;
  /** The seq of the research.requested entry a sent-back unit answers. */ request?: number;
  /** The sub-goal's one accepted step when it is a playbook: code runs it, with no researcher. */ playbook: PlanStep | null }
interface SubResult { id: string; title: string; outcome: "answered" | "blocked"; cards: string[]; note: string }

const noteOf = (end: AgentStageEnd | undefined): string => {
  if (end === undefined || end.kind !== "output" || end.output === null || typeof end.output !== "object" || Array.isArray(end.output)) return "";
  const note = (end.output as Record<string, Json>).note;
  return typeof note === "string" ? note : "";
};

const describeStep = (s: PlanStep): string => `- ${s.id}: ${stepLine(s)}${s.free ? "" : " (costly)"}`;

/**
 * Research: one researcher per sub-goal with an accepted step, at most `research.parallel` at once, each as its own job. When Assemble sent
 * the run back, one researcher per question asked for instead. A sub-goal is answered by what its steps finished as, not by what the
 * researcher says: its last step answered (partly, or in full), or came back empty with full coverage from a source whose empty result is a
 * proven negative (the answer is "no"). A partial or not-seen empty result is not an answer.
 * Run again in the same run under the same accepted plan (a resume), a sub-goal whose researcher already finished is not started again:
 * its recorded outcome is carried into this attempt's output.
 */
export async function researchRunner(env: StageEnv): Promise<StageEnd> {
  const { session, deps, stage } = env;
  const stalled = noSchema(env);
  if (stalled !== null) return stalled;
  const plan = session.state.plan;
  if (plan.current === null || plan.status !== "accepted") return { kind: "stalled", reason: "Research: there is no accepted plan" };
  const current = plan.current;
  const entries = session.entries();
  // a declined stage has not finished its work: a restart is still the same pass
  const lastFinished = entries.reduce((n, e) => (e.type === "stage.finished" && e.payload.stage === stage.id && e.payload.outcome !== "declined" ? e.seq : n), 0);
  const sentBack = entries.some((e) => e.type === "stage.sent_back" && e.payload.to === stage.id && e.seq > lastFinished);

  const accepted = (g: { steps: string[] }): string[] => g.steps.filter((s) => plan.accepted_steps.includes(s));
  const statusOf = (step: string): string => (Object.hasOwn(session.state.plan.steps, step) ? session.state.plan.steps[step]!.status : "pending");
  const goals = current.subgoals.filter((g) => accepted(g).length > 0);
  const actorId = (suffix: string): string => `${deps.profile.stages[stage.id]?.agent ?? "researcher"}-${suffix}`;

  const units: Unit[] = [];
  /** The question a researcher answers. It is text a model wrote, so it is a pack part carrying the marking of the request that produced it, never task text. */
  const questionPart = (id: string, text: string, written_by: Entry[]): PackPart =>
    packPart({ kind: "question", id, title: "The question", text, fixed: false, entries, written_by, floor: null });
  const TASK = 'Answer the question in the part titled "The question".';
  const planStage = stageOfRole(env, "plan");
  const planPass = planStage === null ? null : lastPass(session, planStage);
  const planRequests = planPass === null ? [] : requestsOfPass(entries, planPass.entry);
  /** Questions asked for whose researcher already finished in this pass: not asked again. */
  const answeredBefore: { question: string }[] = [];
  const doneJobs = new Set(entries.filter((e) => e.type === "job.finished" && e.payload.outcome === "done").map((e) => (e.type === "job.finished" ? e.payload.job : "")));
  // a finished job answers a request by the request's seq; a job recorded before that was written answers it by title
  const doneStarts = entries.filter((e): e is Extract<Entry, { type: "job.started" }> => e.type === "job.started" && e.seq > lastFinished && doneJobs.has(e.payload.job));
  const doneRequests = new Set(doneStarts.flatMap((e) => (typeof e.payload.request === "number" ? [e.payload.request] : [])));
  const doneTitles = new Set(doneStarts.filter((e) => e.payload.request === undefined).map((e) => e.payload.title));
  /**
   * Sub-goals of the accepted plan whose researcher already finished (done) in this run since that plan was accepted, with that job: a resume
   * continues the stage, it does not start them again. Their outcome and cards are the steps' as recorded. A new plan starts fresh.
   */
  const carried = new Map<string, string>();
  if (!sentBack) {
    const acceptedAt = entries.reduce((n, e) => (e.type === "plan.accepted" && e.payload.plan === current.id ? e.seq : n), 0);
    const runId = session.state.run.id;
    for (const e of entries) {
      if (e.type !== "job.started" || e.seq <= acceptedAt || e.run !== runId || e.stage !== stage.id || e.payload.kind !== "research" || !doneJobs.has(e.payload.job)) continue;
      // a job names its sub-goal by id; one recorded without the field is matched by its title
      const g = e.payload.subgoal !== undefined ? goals.find((x) => x.id === e.payload.subgoal) : goals.find((x) => `Research: ${x.title}` === e.payload.title);
      if (g !== undefined && !carried.has(g.id)) carried.set(g.id, e.payload.job);
    }
  }
  try {
    if (sentBack) {
      let n = 0;
      for (const e of entries) {
        if (e.type !== "research.requested") continue;
        n++;
        if (e.seq > lastFinished && (doneRequests.has(e.seq) || doneTitles.has(`Research: ${e.payload.question}`))) answeredBefore.push({ question: e.payload.question });
        else if (e.seq > lastFinished) {
          units.push({ sent_back: true, playbook: null, actor_id: actorId(`r${n}`), title: `Research: ${e.payload.question}`, subgoal: null, question: e.payload.question, request: e.seq, task: TASK, part: questionPart(`question-r${n}`, e.payload.question, [e]) });
        }
      }
    } else {
      for (const g of goals) {
        if (accepted(g).every((s) => DONE.has(statusOf(s)))) continue;
        if (carried.has(g.id)) continue;
        const steps = current.steps.filter((s) => accepted(g).includes(s.id));
        const playbook = steps.length === 1 && steps[0]!.playbook !== undefined ? steps[0]! : null;
        units.push({
          playbook, actor_id: actorId(g.id), title: `Research: ${g.title}`, subgoal: g.id, question: null,
          task: `Research sub-goal ${g.id}. ${TASK} The accepted steps it lists were run before you were asked, where they could be: what each returned is in the part titled "What the accepted steps returned", with their cards. Run with run_step, by its id, only a step that part says is not yet run, then report what the steps found.`,
          // the steps carry the planner's values, source and pivot: they are as strict as the question
          part: questionPart(`question-${g.id}`, [`Sub-goal ${g.id}: ${g.title}`, g.question, "Accepted steps:", ...steps.map(describeStep)].join("\n"), planRequests),
        });
      }
    }
  } catch (err) {
    if (err instanceof ContextError) return { kind: "stalled", reason: `${titleOf(env)}: ${err.message}` };
    throw err;
  }

  const results: (AgentStageEnd | undefined)[] = units.map(() => undefined);
  /**
   * A sub-goal's accepted steps, run in code in plan order at the start of its job, before its researcher is asked: each step whose value
   * the plan gives and that has not finished (pending, or left running by an interrupted attempt), through run_step as the researcher's actor (an answered query is reused; a costly step spends only
   * the plan's budget). Returns the parts the researcher reads: what each step returned, then the cards. A step whose value an earlier step
   * finds is left to the researcher. Nothing is run when the researcher's model cannot be resolved (the agent then stalls with the reason).
   */
  const runStepsInCode = async (u: Unit, job: string): Promise<PackPart[]> => {
    if (u.subgoal === null) return [];
    const g = current.subgoals.find((x) => x.id === u.subgoal)!;
    const steps = current.steps.filter((s) => accepted(g).includes(s.id));
    const who = await resolveAgent(env, u.actor_id);
    if ("stalled" in who) return [];
    const { window, limits } = frameOf(env);
    const ctx: ToolContext = {
      session, deps: deps.runner, seeker: deps.seeker, actor: who.actor, link: { run: session.state.run.id, stage: stage.id, job },
      draft: null, draft_hash: null, subgoal: u.subgoal, window, limits, onNeedsBudget: (p, step) => spendPlanBudget(session, deps.runner, p, step), in_code: true,
    };
    const lines: string[] = [];
    const markings: Marking[] = [];
    for (const step of steps) {
      // a step left running is one an interrupted attempt started: at the start of its sub-goal's job no other job owns it, so it runs again
      // (an answered lookup is read back, not sent again)
      const unrun = statusOf(step.id) === "pending" || statusOf(step.id) === "running";
      if (unrun && step.from.value !== "" && session.state.run.status !== "paused" && session.state.run.status !== "finished") {
        const args = { step: step.id, why: `accepted plan step ${step.id}, run by the workbench before the researcher was asked` };
        const r = await execTool(ctx, { tool: TOOLS.run_step, name: "run_step", args, why: args.why, error: null });
        if (r.marking !== null) markings.push(r.marking);
      }
      const st = Object.hasOwn(session.state.plan.steps, step.id) ? session.state.plan.steps[step.id]! : null;
      const status = st === null ? "pending" : st.status;
      if (status === "pending") lines.push(`${step.id}: not yet run${step.from.value === "" ? " (it needs the value an earlier step found)" : ""}`);
      else if (status === "running") lines.push(`${step.id}: running`);
      else {
        lines.push(`${step.id}: ${st!.note === "" ? status : st!.note}`);
        // a note listed, from this job or an earlier one, is the source's words: as strict as that source
        const source = deps.registry.source(deps.registry.pivot(step.pivot)?.source ?? step.source);
        if (source !== null) markings.push(source.marking);
      }
    }
    const fresh = session.entries();
    const cards = [...new Set(steps.flatMap((s) => (Object.hasOwn(session.state.plan.steps, s.id) ? session.state.plan.steps[s.id]!.cards : [])))]
      .flatMap((c) => (Object.hasOwn(session.state.cards, c) ? [packPart({ card: session.state.cards[c]!, registry: deps.registry })] : []));
    // the notes are the tools' words on what the source returned: as strict as the planner's values and the sources of every step listed
    const said = packPart({
      kind: "note", id: `steps-${g.id}`, title: "What the accepted steps returned", text: lines.join("\n"), fixed: false,
      entries: fresh, written_by: planRequests, floor: markings.length === 0 ? null : strictest(...markings),
    });
    return [said, ...cards];
  };

  const runUnit = async (u: Unit): Promise<AgentStageEnd> => {
    if (u.playbook !== null) return runPlaybookUnit(u.playbook, current.subgoals.find((g) => g.id === u.subgoal)!.question);
    let job = "";
    session.commit((s, ids) => {
      job = ids.next("job");
      return [{ type: "job.started", actor: ENGINE, run: s.run.id, stage: stage.id, job, payload: { job, title: u.title, kind: "research", source: null, subgoal: u.subgoal, request: u.request ?? null } }];
    });
    const close = (outcome: "done" | "failed"): void => {
      session.commit((s) => [{ type: "job.finished", actor: ENGINE, run: s.run.id, stage: stage.id, job, payload: { job, outcome } }]);
    };
    let end: AgentStageEnd;
    try {
      const ran = u.sent_back === true ? [] : await runStepsInCode(u, job);
      if (session.state.run.status === "paused" || session.state.run.status === "finished") {
        close("failed");
        return { kind: "stopped" };
      }
      end = await stageAgent(env, {
        actor_id: u.actor_id, task: u.task, extras: [u.part, ...ran], subgoal: u.subgoal, job,
        // a researcher sent back for a question has no sub-goal: it may not run plan steps or spend a plan budget
        ...(u.sent_back === true ? { omit_tools: ["run_step"] as const } : { onNeedsBudget: (p: string, step: string | null) => spendPlanBudget(session, deps.runner, p, step) }),
      });
    } catch (err) {
      close("failed");
      throw err;
    }
    close(end.kind === "output" ? "done" : "failed");
    return end;
  };

  /**
   * A playbook step runs in code, as the workbench: no researcher, no model call. A playbook changed since the plan was accepted is not run.
   * Pausing or finishing the run stops it before its next lookup; the step then finishes blocked and the stage stops.
   */
  const runPlaybookUnit = async (step: PlanStep, question: string): Promise<AgentStageEnd> => {
    const ref = step.playbook!;
    const link = { run: session.state.run.id, stage: stage.id };
    const output = (note: string): AgentStageEnd => ({ kind: "output", output: { note }, calls: [] });
    const p = deps.registry.playbook(ref.id);
    // a step recorded with pins is checked against them: a pivot or inventory the playbook uses that changed (or cannot be pinned now) blocks it
    const pinsMoved = step.pins !== undefined && stepPins(deps.registry, step) !== step.pins;
    if (p === null || p.hash !== ref.hash || pinsMoved) {
      const changed = p === null || p.hash !== ref.hash ? `the playbook ${ref.id} changed since the plan was accepted; re-plan to use it`
        : `a pivot of the playbook ${ref.id} changed since the plan was accepted; re-plan to use it`;
      session.commit(() => [
        { type: "step.started", actor: PLAYBOOK, ...link, payload: { step: step.id, by: "workbench" } },
        { type: "step.finished", actor: PLAYBOOK, ...link, payload: { step: step.id, outcome: "blocked", cards: [], note: changed } },
      ]);
      return output(changed);
    }
    const start = { playbook: p, inputs: ref.inputs, window: step.window, why: question, actor: PLAYBOOK, ...link, subgoal: step.subgoal, plan_step: step.id };
    let job: string;
    try {
      job = beginPlaybook(session, deps.runner, start);
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      // a playbook that no longer fits (a pivot that now needs a window, say) is not run: its step finishes blocked with the reason
      const note = `the playbook ${ref.id} cannot run: ${err.message}`;
      session.commit(() => [
        { type: "step.started", actor: PLAYBOOK, ...link, payload: { step: step.id, by: "workbench" } },
        { type: "step.finished", actor: PLAYBOOK, ...link, payload: { step: step.id, outcome: "blocked", cards: [], note } },
      ]);
      return output(note);
    }
    session.commit(() => [{ type: "step.started", actor: PLAYBOOK, ...link, job, payload: { step: step.id, by: "workbench" } }]);
    let stopped = false;
    const stop = (): boolean => {
      const { status } = session.state.run;
      if (status === "paused" || status === "finished") stopped = true;
      return stopped;
    };
    const finish = (outcome: StepOutcome, cards: string[], note: string): void => {
      session.commit(() => [{ type: "step.finished", actor: PLAYBOOK, ...link, job, payload: { step: step.id, outcome, cards, note } }]);
    };
    let end: Awaited<ReturnType<typeof runPlaybook>>;
    try {
      end = await runPlaybook(session, deps.runner, job, start, stop);
    } catch (err) {
      finish("failed", [], `playbook ${ref.id}: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
      throw err;
    }
    if (end === null) {
      finish("blocked", [], `playbook ${ref.id}: its job ended before the playbook finished; stopped`);
      return { kind: "stopped" };
    }
    const said = [`playbook ${ref.id}: ${end.lookups} lookups (${end.reused} reused), ${stopped ? "blocked" : end.outcome}`, ...end.caveats];
    if (stopped) {
      finish("blocked", end.end_cards, [...said, "stopped"].join("; "));
      return { kind: "stopped" };
    }
    const note = said.join("; ");
    finish(end.outcome, end.end_cards, note);
    return output(note);
  };

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (session.state.run.status === "paused" || session.state.run.status === "finished") return;
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

  const noteFor = (subgoal: string): string => {
    const job = carried.get(subgoal);
    if (job === undefined) return noteOf(results[units.findIndex((u) => u.subgoal === subgoal)]);
    const g = goals.find((x) => x.id === subgoal)!;
    const notes = accepted(g).flatMap((s) => (Object.hasOwn(session.state.plan.steps, s) && session.state.plan.steps[s]!.note !== "" ? [`${s}: ${session.state.plan.steps[s]!.note}`] : []));
    return [`carried from ${job}, which finished earlier in this run`, ...notes].join("; ");
  };
  const subgoals: SubResult[] = goals.map((g) => {
    const steps = accepted(g);
    const cards = [...new Set(steps.flatMap((s) => (Object.hasOwn(session.state.plan.steps, s) ? session.state.plan.steps[s]!.cards : [])))];
    const outcome = subgoalAnswered(session.state, g) ? "answered" : "blocked";
    return { id: g.id, title: g.title, outcome, cards, note: noteFor(g.id) };
  });
  const requested = [...answeredBefore.map((a) => ({ question: a.question, note: "" })), ...units.flatMap((u, i) => (u.question === null ? [] : [{ question: u.question, note: noteOf(results[i]) }]))];
  const output = { subgoals, requested } as unknown as Json;
  // a value the workbench extracted that opens a route to an open sub-goal, with no accepted step from it, goes back to Plan (at most the cap a run)
  if (!sentBack) {
    const g = gleanOf(session.state, session.entries(), { registry: deps.registry, seeker: deps.seeker }, frameOf(env).limits);
    const cap = deps.config.glean?.max_sendbacks ?? DEFAULT_GLEAN_SENDBACKS;
    const reason = g === null ? null : gleanSendBack(session.state, session.entries(), g.openings, { cap, stage: stage.id });
    if (reason !== null) return { kind: "finished", outcome: "fail", draft_hash: null, output, reason };
  }
  if (subgoals.some((g) => g.outcome === "answered") || requested.length > 0) return { kind: "finished", outcome: "pass", draft_hash: null, output, reason: null };
  const notes = subgoals.map((g) => `${g.title}: ${g.note === "" ? "no note" : g.note}`).join("; ");
  return { kind: "finished", outcome: "fail", draft_hash: null, output, reason: `no sub-goal could be answered: ${notes}` };
}
