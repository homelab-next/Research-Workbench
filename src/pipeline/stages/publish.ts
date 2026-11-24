import type { Json } from "../../core/canonical";
import { latestDraft } from "../../core/state";
import type { StageEnd, StageEnv } from "../engine";
import { buildBundle, draftProblem } from "../publish";
import { draftPart, noSchema, stageAgent } from "./agent";

/**
 * Publish: the publisher names the reviewed product and adds a note. It adds no text to the product, so what is approved is what was reviewed.
 * The stage ends on the latest draft with the title, the note and a preview of the bundle; the engine then waits at the publish gate.
 */
export async function publishRunner(env: StageEnv): Promise<StageEnd> {
  const { session, deps, stage } = env;
  const d = latestDraft(session.state);
  const stalled = noSchema(env);
  if (stalled !== null) return stalled;
  if (d === null) return { kind: "stalled", reason: "Publish: there is no draft to publish" };
  const problem = draftProblem(d);
  if (problem !== null) return { kind: "stalled", reason: `Publish: ${problem}` };
  const task = [
    `Name draft ${d.n} for publishing and add a short note for the reader.`,
    "Reply with a title and a note. You change no part of the product.",
  ].join("\n");
  const end = await stageAgent(env, { actor_id: deps.profile.stages[stage.id]?.agent ?? "publisher", task, extras: [draftPart(d)], draft_hash: d.hash });
  if (end.kind !== "output") return end;
  const { title, note } = end.output as unknown as { title: string; note: string };
  const preview = buildBundle(session, d, { title, note }, session.head(), session.state.published.length + 1).manifest;
  return { kind: "finished", outcome: "pass", draft_hash: d.hash, output: { title, note, preview } as unknown as Json, reason: null };
}
