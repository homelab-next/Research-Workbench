import { logToStderr } from "../../core/deliver";
import { recordMops } from "../feedback";
import type { StageEnd, StageEnv } from "../engine";
import { proposeLessons, publishedOfRun } from "../lessons";

/**
 * Feedback: records the measures of performance the objective lists; the engine then finishes the run as published. A Feedback stage that runs
 * an agent with a schema, in a run that published, of a case with a type, then asks its model what would have helped and files the answers as
 * proposals (proposeLessons). Nothing is accepted here, and a model's failure never holds the run: the stage passes with the reason.
 */
export async function feedbackRunner(env: StageEnv): Promise<StageEnd> {
  recordMops(env.session, env.deps.registry, (err) => (env.deps.onError ?? logToStderr("feedback"))(err));
  const { stage, session } = env;
  if (stage.runs !== "agent" || stage.schema === null || session.state.memory.type === null || publishedOfRun(session) === null) {
    return { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
  }
  const r = await proposeLessons(env);
  if (r.stopped) return { kind: "stopped" };
  return { kind: "finished", outcome: "pass", draft_hash: null, output: r.output, reason: r.reason };
}
