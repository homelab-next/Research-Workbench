import type { Json } from "../../core/canonical";
import { latestDraft } from "../../core/state";
import type { CheckFinding } from "../../core/types";
import type { StageEnd, StageEnv } from "../engine";
import { agentActor, citedCardParts, draftPart, noSchema, stageAgent } from "./agent";

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
  ].join("\n");
  const actorId = deps.profile.stages[stage.id]?.agent ?? "evaluator";
  const end = await stageAgent(env, { actor_id: actorId, task, extras: [draftPart(d), ...citedCardParts(session, d)] });
  if (end.kind !== "output") return end;
  const { pass, findings } = end.output as unknown as { pass: boolean; findings: CheckFinding[] };
  const actor = agentActor(session, actorId);
  session.commit((s) => [{ type: "evaluation.made", actor, run: s.run.id, stage: stage.id, payload: { draft_hash: d.hash, pass, findings } }]);
  if (pass) return { kind: "finished", outcome: "pass", draft_hash: d.hash, output: end.output as Json, reason: null };
  if (findings.length === 0) return { kind: "stalled", reason: "Evaluate failed the draft without saying why" };
  return { kind: "finished", outcome: "fail", draft_hash: d.hash, output: end.output as Json, reason: findings[0]!.message };
}
