import type { Json } from "../../core/canonical";
import { latestDraft } from "../../core/state";
import type { CheckFinding } from "../../core/types";
import type { StageEnd, StageEnv } from "../engine";
import { ContextError } from "../../agents/context";
import { reviewPointsPart } from "../review-points";
import { agentActor, citedCardParts, citedGoneLine, draftPart, noSchema, stageAgent, titleOf } from "./agent";

/** Evaluate: checks the draft pinned at the start of the stage against the cards it cites. The verdict is recorded against that draft's hash. */
export async function evaluateRunner(env: StageEnv): Promise<StageEnd> {
  // pinned before anything is awaited: a person's edit made while the model works is a different draft, reviewed from the start
  const d = latestDraft(env.session.state);
  const stalled = noSchema(env);
  if (stalled !== null) return stalled;
  if (d === null) return { kind: "stalled", reason: "Evaluate: there is no draft to evaluate" };
  const { session, deps, stage } = env;
  const task = [
    `Evaluate draft ${d.n}.`,
    "Check that every finding is supported by what its cited cards say. Verify a card where it matters.",
    "Reply with pass, and for each problem the check, where it is and what is wrong.",
    ...[citedGoneLine(session, d)].filter((x) => x !== null),
  ].join("\n");
  const actorId = deps.profile.stages[stage.id]?.agent ?? "evaluator";
  const extras = [draftPart(session, d), ...citedCardParts(session, deps.registry, d)];
  try {
    // the other reviewer's points and the analyst's answers
    const other = reviewPointsPart(session, deps.pipeline, "evaluate");
    if (other !== null) extras.push(other);
  } catch (err) {
    if (err instanceof ContextError) return { kind: "stalled", reason: `${titleOf(env)}: ${err.message}` };
    throw err;
  }
  const end = await stageAgent(env, { actor_id: actorId, task, extras });
  if (end.kind !== "output") return end;
  const { pass, findings } = end.output as unknown as { pass: boolean; findings: CheckFinding[] };
  const actor = agentActor(session, actorId);
  const run = session.state.run.id;
  // a person stopped the run while the model was answering: no verdict is recorded
  const written = session.commit((s) => (s.run.id !== run || s.run.status === "finished" ? [] : [{ type: "evaluation.made", actor, run: s.run.id, stage: stage.id, payload: { draft_hash: d.hash, pass, findings } }]));
  if (written.length === 0) return { kind: "stopped" };
  if (pass) return { kind: "finished", outcome: "pass", draft_hash: d.hash, output: end.output as Json, reason: null };
  if (findings.length === 0) return { kind: "stalled", reason: "Evaluate failed the draft without saying why" };
  return { kind: "finished", outcome: "fail", draft_hash: d.hash, output: end.output as Json, reason: findings[0]!.message };
}
