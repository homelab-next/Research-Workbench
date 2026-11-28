import type { Json } from "../../core/canonical";
import type { CaseSession } from "../../core/session";
import { runQuestions } from "../../core/state";
import type { Actor, EntryInput } from "../../core/types";
import { ContextError, schemaOf } from "../../agents/context";
import type { CaseType } from "../../modules/case-types";
import type { StageEnd, StageEnv } from "../engine";
import { CASE_TYPE_WHY, caseTypeQuestion, isCaseTypeQuestion, readsShared } from "../memory";
import { agentActor, contextFrom, noSchema, stageAgent, windowProblem } from "./agent";

const ENGINE: Actor = { kind: "system", id: "engine" };
/** Why the workbench records Frame's proposal. */
export const PROPOSED_WHY = "Frame read the question as this type";

/** True when the stage's output schema has a case_type property; false when it has none or cannot be read (the stage stalls on that itself). */
function schemaHasCaseType(env: StageEnv): boolean {
  if (env.stage.schema === null) return false;
  try {
    const props = (schemaOf(contextFrom(env.deps), env.stage.schema, env.stage.id) as { properties?: Record<string, unknown> }).properties;
    return props !== undefined && props !== null && typeof props === "object" && Object.hasOwn(props, "case_type");
  } catch (err) {
    if (err instanceof ContextError) return false;
    throw err;
  }
}

/** The lines Frame's task gains when the case has no type: the loaded case types, and what to give. */
const typeLines = (types: readonly CaseType[]): string[] => [
  `Case types: ${types.map((t) => (t.about === "" ? `${t.id} (${t.title})` : `${t.id} (${t.title}: ${t.about})`)).join("; ")}`,
  "If the question is plainly one of them, give its id as case_type; otherwise null.",
];

/**
 * After a passing output, while the case still has no type: case.type_proposed by the workbench when Frame named a loaded case type, and, when
 * the run's loop reads shared lessons, a blocking question to the person proposing it (controller ruling 3), so the run waits after Frame and
 * Plan is given the lessons of the type the person confirms. Asked once a run. Frame never writes case.type_set.
 */
function proposeType(session: CaseSession, env: StageEnv, types: readonly CaseType[], proposed: string | null, asker: Actor | null): void {
  const ask = asker !== null && types.length > 0 && readsShared(env.deps.lock);
  session.commit((s, ids) => {
    if (s.memory.type !== null) return [];
    const link = { run: s.run.id, stage: env.stage.id };
    const out: EntryInput[] = [];
    if (proposed !== null) out.push({ type: "case.type_proposed", actor: ENGINE, payload: { type: proposed, why: PROPOSED_WHY }, ...link });
    if (ask && !runQuestions(s).some(isCaseTypeQuestion)) {
      const question = { id: ids.next("question"), text: caseTypeQuestion(types, proposed), why: CASE_TYPE_WHY, cards: [], about: [], blocking: true };
      out.push({ type: "question.asked", actor: asker, ...link, payload: { question } });
    }
    return out;
  });
}

/** Frame: turns the question into goals, a time window and limits. Finishes pass with the validated output. */
export async function frameRunner(env: StageEnv): Promise<StageEnd> {
  const stalled = noSchema(env);
  if (stalled !== null) return stalled;
  const m = env.session.state.meta;
  if (m === null) return { kind: "stalled", reason: "Frame: the case has no record yet" };
  const types = env.deps.case_types ?? [];
  const untyped = env.session.state.memory.type === null && types.length > 0;
  const asksType = untyped && schemaHasCaseType(env);
  const task = [
    "Frame this investigation.",
    `The question asked: ${m.asked}`,
    `Why it was asked: ${m.why}`,
    `Starting values: ${m.starting.length === 0 ? "none" : m.starting.map((o) => `${o.type} ${o.value}`).join("; ")}`,
    `The case window: ${m.window.from ?? "open"} to ${m.window.to ?? "open"}`,
    ...(asksType ? typeLines(types) : []),
    "Reply with the goals, the time window and the limits as JSON.",
  ].join("\n");
  const actorId = env.deps.profile.stages[env.stage.id]?.agent ?? "orchestrator";
  const end = await stageAgent(env, { actor_id: actorId, task, extras: [] });
  if (end.kind !== "output") return end;
  const w = (end.output as { window?: { from?: string; to?: string } } | null)?.window;
  const problem = w?.from === undefined || w.to === undefined ? null : windowProblem({ from: w.from, to: w.to }, m.window);
  if (problem !== null) return { kind: "finished", outcome: "fail", draft_hash: null, output: null, reason: `Frame chose a bad window: ${problem}` };
  let reason: string | null = null;
  if (untyped) {
    const named = asksType ? (end.output as { case_type?: Json } | null)?.case_type : undefined;
    let proposed: string | null = null;
    if (typeof named === "string") {
      if (types.some((t) => t.id === named)) proposed = named;
      else reason = `Frame named "${named.slice(0, 64)}", which is no case type here; it was ignored`;
    }
    let asker: Actor | null = null;
    try {
      asker = agentActor(env.session, actorId);
    } catch { /* no request of Frame's agent to ask as: nothing is asked */ }
    proposeType(env.session, env, types, proposed, asker);
  }
  return { kind: "finished", outcome: "pass", draft_hash: null, output: end.output, reason };
}
