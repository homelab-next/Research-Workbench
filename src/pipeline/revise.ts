import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import { latestDraft } from "../core/state";
import { isObj, isOneOf, isStr, isStrList } from "../core/state/guards";
import { CONFIDENCES, isMarking, strictest } from "../core/types";
import type { Actor, Draft, EntryInput, Product } from "../core/types";
import { canonical } from "../core/canonical";
import type { Json } from "../core/canonical";
import { carriedCites, draftOf } from "../agents/draft";
import type { Pipeline } from "./manifests";

export class ReviseRefused extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "ReviseRefused";
  }
}

const ENGINE: Actor = { kind: "system", id: "engine" };

const PRODUCT_KEYS = ["objective", "question", "marking", "summary", "key_findings", "gaps_and_limits", "alternatives", "assessment", "sources", "assumptions", "change"];
const FINDING_KEYS = ["id", "statement", "likelihood", "confidence", "confidence_basis", "cites", "assumptions", "reasoning"];

/** The shape the fold requires of a product. */
function shapeProblem(p: unknown): string | null {
  if (!isObj(p)) return "the product is not an object";
  const extra = Object.keys(p).find((k) => !PRODUCT_KEYS.includes(k));
  if (extra !== undefined) return `the product has a field it should not have: ${extra}`;
  for (const k of ["objective", "question", "summary", "gaps_and_limits", "alternatives", "assessment", "change"]) if (!isStr(p[k])) return `the product's ${k} must be text`;
  if (!isMarking(p.marking)) return "the product's marking is not a known marking";
  if (!Array.isArray(p.key_findings)) return "the product's key_findings must be a list";
  for (const f of p.key_findings) {
    const ok = isObj(f) && isStr(f.id) && isStr(f.statement) && isStr(f.likelihood) && isOneOf(f.confidence, CONFIDENCES)
      && isStr(f.confidence_basis) && isStrList(f.cites) && isStrList(f.assumptions) && isStr(f.reasoning);
    if (ok && Object.keys(f).some((k) => !FINDING_KEYS.includes(k))) return "a key finding has a field it should not have";
    if (!ok) return "a key finding is not in the shape a finding must have";
  }
  if (!Array.isArray(p.sources) || !p.sources.every((v) => isObj(v) && isStr(v.source) && isStr(v.quality) && Object.keys(v).length === 2)) return "the product's sources must be a list of source and quality";
  if (!isStrList(p.assumptions)) return "the product's assumptions must be a list of text";
  return null;
}

/**
 * A person's edit of the draft: a new numbered revision in their name. When the run waits at the publish gate, or is stopped on a stage that
 * failed, the same commit starts the first review stage the new revision has not passed, so review begins again from there. An edit is not a
 * send-back, and does not count against the cap.
 */
export function reviseDraft(session: CaseSession, pipeline: Pipeline, input: { product: Product; reason: string; actor: Actor }): Draft {
  const { product, reason, actor } = input;
  if (actor.kind !== "human") throw new ReviseRefused("only a person may edit the draft");
  const problem = shapeProblem(product);
  if (problem !== null) throw new ReviseRefused(problem);
  if (!isStr(reason) || reason.trim() === "") throw new ReviseRefused("an edit needs a reason");
  try {
    canonical(product as unknown as Json);
  } catch (err) {
    throw new ReviseRefused(`the product cannot be recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
  let made: Draft | null = null;
  session.commit((state) => {
    const { run } = state;
    if (run.status === "none" || run.status === "finished") throw new ReviseRefused("there is no run in progress to edit a draft in");
    const latest = latestDraft(state);
    // a person's edit cannot lower the marking below the previous draft's
    const floor = latest === null ? product : { ...product, marking: strictest(product.marking, latest.product.marking) };
    // what the person left unchanged keeps the cards it cited, so a lowered marking is still checked against them
    const draft = draftOf(floor, state.drafts.length + 1, actor, reason, carriedCites(latest, floor, state.cards));
    if (latest !== null && latest.hash === draft.hash) throw new ReviseRefused("the edit changes nothing in the latest draft");
    made = draft;
    const out: EntryInput[] = [{ type: "draft.revised", actor, run: run.id, payload: { draft } }];
    const current = run.stages.find((s) => s.id === run.current) ?? null;
    const atGate = run.waiting === "publish";
    const stopped = run.status === "paused" && current !== null && current.status === "failed";
    if (atGate || stopped) {
      const passed = Object.hasOwn(state.reviews, draft.hash) ? state.reviews[draft.hash]!.passed_stages : [];
      const first = pipeline.stages.find((s) => s.reviews && !passed.includes(s.id));
      if (first !== undefined) {
        const attempts = run.stages.find((s) => s.id === first.id)?.attempts ?? 0;
        out.push({ type: "stage.started", actor: ENGINE, run: run.id, stage: first.id, payload: { stage: first.id, attempt: attempts + 1 } });
      }
    }
    return out;
  });
  return made!;
}

/** A person answers an open challenge. The only way a challenge closes outside the analyst's own Assemble stage; an edit never does. */
export function answerChallenge(session: CaseSession, actor: Actor, id: string, answer: string, action: "revised" | "rebutted"): void {
  if (actor.kind !== "human") throw new ReviseRefused("only a person may answer a challenge here");
  if (answer.trim() === "") throw new ReviseRefused("an answer needs text");
  session.commit((state) => {
    const c = Object.hasOwn(state.challenges, id) ? state.challenges[id]! : null;
    if (c === null || c.status !== "open") throw new ReviseRefused(`challenge ${id} is not open`);
    return [{ type: "challenge.answered", actor, payload: { challenge: id, answer, action } }];
  });
}
