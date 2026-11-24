import type { StageEnd, StageEnv } from "../engine";
import { stageAgent } from "./agent";

/** Frame: turns the question into goals, a time window and limits. Finishes pass with the validated output. */
export async function frameRunner(env: StageEnv): Promise<StageEnd> {
  const m = env.session.state.meta;
  if (m === null) return { kind: "stalled", reason: "Frame: the case has no record yet" };
  const task = [
    "Frame this investigation.",
    `The question asked: ${m.asked}`,
    `Why it was asked: ${m.why}`,
    `Starting values: ${m.starting.length === 0 ? "none" : m.starting.map((o) => `${o.type} ${o.value}`).join("; ")}`,
    `The case window: ${m.window.from ?? "open"} to ${m.window.to ?? "open"}`,
    "Reply with the goals, the time window and the limits as JSON.",
  ].join("\n");
  const end = await stageAgent(env, { actor_id: env.deps.profile.stages[env.stage.id]?.agent ?? "orchestrator", task, extras: [] });
  return end.kind === "output" ? { kind: "finished", outcome: "pass", draft_hash: null, output: end.output, reason: null } : end;
}
