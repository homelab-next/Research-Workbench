import type { Json } from "../../core/canonical";
import { latestDraft } from "../../core/state";
import type { PackPart } from "../../agents/context";
import type { StageEnd, StageEnv } from "../engine";
import { ContextError, packPart } from "../../agents/context";
import { reviewPointsPart } from "../review-points";
import { citedCardParts, draftPart, noSchema, stageAgent, titleOf } from "./agent";

/** Challenge: the adversary argues against the draft pinned at the start. A must-address challenge still open against that hash fails the stage. */
export async function challengeRunner(env: StageEnv): Promise<StageEnd> {
  const d = latestDraft(env.session.state);
  const stalled = noSchema(env);
  if (stalled !== null) return stalled;
  if (d === null) return { kind: "stalled", reason: "Challenge: there is no draft to challenge" };
  const { session, deps, stage } = env;
  const extras: PackPart[] = [draftPart(session, d), ...citedCardParts(session, deps.registry, d)];
  const earlier = Object.values(session.state.challenges).filter((c) => c.draft_hash === d.hash || c.run === session.state.run.id);
  if (earlier.length > 0) {
    const text = earlier.map((c) => `- ${c.id} (on draft ${session.state.drafts.find((x) => x.hash === c.draft_hash)?.n ?? "?"}, ${c.severity}, ${c.status === "open" ? "open" : `answered: ${c.action}`}): ${c.text}${c.answer === null ? "" : ` Answer: ${c.answer}`}`).join("\n");
    // each challenge and each answer is as strict as the model request it was written in answer to
    const entries = session.entries();
    const ids = new Set(earlier.map((c) => c.id));
    const by = entries.filter((e) => (e.type === "challenge.raised" && ids.has(e.payload.challenge.id)) || (e.type === "challenge.answered" && ids.has(e.payload.challenge)));
    try {
      extras.push(packPart({ kind: "challenges", id: "earlier-challenges", title: "Challenges raised in this run", text, fixed: true, entries, written_by: by, floor: null }));
    } catch (err) {
      if (err instanceof ContextError) return { kind: "stalled", reason: `${titleOf(env)}: ${err.message}` };
      throw err;
    }
  }
  try {
    // the other reviewer's latest points and the analyst's answer
    const other = reviewPointsPart(session, deps.pipeline, "challenge");
    if (other !== null) extras.push(other);
  } catch (err) {
    if (err instanceof ContextError) return { kind: "stalled", reason: `${titleOf(env)}: ${err.message}` };
    throw err;
  }
  const task = [
    `Challenge draft ${d.n}.`,
    "Argue against it: look for what the cards do not show, other explanations and weak confidence. Verify a card where it matters.",
    "Raise a challenge for each objection (must_address if the draft cannot stand without an answer), then reply with the output.",
  ].join("\n");
  const end = await stageAgent(env, { actor_id: deps.profile.stages[stage.id]?.agent ?? "adversary", task, extras, draft_hash: d.hash });
  if (end.kind !== "output") return end;
  const open = Object.values(session.state.challenges).find((c) => c.draft_hash === d.hash && c.severity === "must_address" && c.status === "open");
  if (open !== undefined) return { kind: "finished", outcome: "fail", draft_hash: d.hash, output: end.output as Json, reason: `challenge ${open.id} must be addressed: ${open.text}` };
  return { kind: "finished", outcome: "pass", draft_hash: d.hash, output: end.output as Json, reason: null };
}
