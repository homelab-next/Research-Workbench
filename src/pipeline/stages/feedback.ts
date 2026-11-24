import { recordMops } from "../feedback";
import type { StageEnd, StageEnv } from "../engine";

/** Feedback: run by code for the person. Records the measures of performance the objective lists; the engine then finishes the run as published. */
export async function feedbackRunner(env: StageEnv): Promise<StageEnd> {
  recordMops(env.session, env.deps.registry);
  return { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
}
