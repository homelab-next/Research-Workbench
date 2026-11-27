// The person overrules a finding (slice 8): code holds every draft to the overrule, whoever writes the draft.
import { canonical } from "../core/canonical";
import type { Json } from "../core/canonical";
import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import { activeOverrules, latestDraft, overruleReason, overruleText } from "../core/state";
import type { CaseState, Overrule } from "../core/state";
import { CONFIDENCES } from "../core/types";
import type { Actor, Draft, EntryInput, Finding } from "../core/types";
import { composeStatement, termsOf } from "../agents/draft";
import type { StandardTerms } from "../agents/draft";
import type { EngineDeps } from "./engine";
import type { Pipeline } from "./manifests";
import { revisionEntries } from "./revise";

export class OverruleRefused extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "OverruleRefused";
  }
}

const withdrawn = (o: Overrule): boolean => o.likelihood === null && o.confidence === null && o.stays === null;

/** The finding with the overrule's values in place: a set likelihood (and its statement, worded again when the standard has terms), a set confidence. */
function withValues(f: Finding, o: Overrule, terms: StandardTerms | null): Finding {
  const out: Finding = { ...f, cites: [...f.cites], assumptions: [...f.assumptions] };
  if (o.likelihood !== null && o.likelihood !== f.likelihood) {
    out.likelihood = o.likelihood;
    if (terms !== null) out.statement = composeStatement(o.likelihood, f.statement, terms);
  }
  if (o.confidence !== null) out.confidence = o.confidence;
  return out;
}

/**
 * The findings as the overrules leave them: a dropped one removed; a set likelihood (its statement worded again by composeStatement, when the
 * standard has terms) and a set confidence put in place; a finding that must be there and is not, restored from the latest draft that held it
 * (less its cites to cards `live` refuses), after the others, in overrule order. Pure.
 */
export function overruledFindings(findings: readonly Finding[], overrules: readonly Overrule[], drafts: readonly Draft[], terms: StandardTerms | null, live: (card: string) => boolean): Finding[] {
  const active = new Map<string, Overrule>();
  for (const o of overrules) {
    if (withdrawn(o)) active.delete(o.finding); else active.set(o.finding, o);
  }
  const out: Finding[] = [];
  for (const f of findings) {
    const o = active.get(f.id);
    if (o === undefined) { out.push(f); continue; }
    if (o.stays === false) continue;
    out.push(withValues(f, o, terms));
  }
  for (const o of active.values()) {
    if (o.stays === false || out.some((f) => f.id === o.finding)) continue;
    const held = drafts.findLast((d) => d.product.key_findings.some((f) => f.id === o.finding));
    if (held === undefined) continue;
    const f = held.product.key_findings.find((x) => x.id === o.finding)!;
    out.push(withValues({ ...f, cites: f.cites.filter(live) }, o, terms));
  }
  return out;
}

const ENGINE: Actor = { kind: "system", id: "engine" };

/**
 * The work sent back from the publish gate to the stage the gate sends work back to (Assemble), with the person's change as the reason, and that
 * stage started (controller ruling 6). Empty when the run is not waiting at the publish gate, or the gate sends work back nowhere.
 */
export function gateSendBack(state: Readonly<CaseState>, pipeline: Pipeline, reason: string): EntryInput[] {
  const { run } = state;
  if (run.status === "none" || run.status === "finished" || run.waiting !== "publish") return [];
  const gate = pipeline.stages.find((s) => s.gate === "publish");
  const to = gate?.on_fail ?? null;
  const target = to === null ? undefined : pipeline.stages.find((s) => s.id === to);
  if (gate === undefined || target === undefined) return [];
  const link = { run: run.id, stage: target.id };
  const edge = `${gate.id}>${target.id}`;
  const count = (Object.hasOwn(run.sendbacks, edge) ? run.sendbacks[edge]! : 0) + 1;
  const out: EntryInput[] = [{ type: "stage.sent_back", actor: ENGINE, ...link, payload: { from: gate.id, to: target.id, reason, count } }];
  if (target.phase !== null && target.phase !== state.phase) out.push({ type: "case.phase_changed", actor: ENGINE, ...link, payload: { phase: target.phase } });
  out.push({ type: "stage.started", actor: ENGINE, ...link, payload: { stage: target.id, attempt: (run.stages.find((x) => x.id === target.id)?.attempts ?? 0) + 1 } });
  return out;
}

const same = (a: Overrule, b: Overrule): boolean => a.likelihood === b.likelihood && a.confidence === b.confidence && a.stays === b.stays && a.note.trim() === b.note.trim();

/** Records the overrule; when a run is in progress and the latest draft does not hold it, the same commit makes the person's revision that does. Throws OverruleRefused. */
export function overrule(session: CaseSession, deps: Pick<EngineDeps, "pipeline" | "profile" | "registry">, input: { actor: Actor; finding: string; draft_hash: string; likelihood: string | null; confidence: Finding["confidence"] | null; stays: boolean | null; note: string }): void {
  const { actor, finding, draft_hash, likelihood, confidence, stays, note } = input;
  if (actor.kind !== "human") throw new OverruleRefused("only a person may overrule a finding");
  if (typeof note !== "string" || note.trim() === "") throw new OverruleRefused("an overrule needs a note");
  const standard = deps.profile.standard === null ? null : deps.registry.get("standard", deps.profile.standard);
  const terms = termsOf(standard?.body ?? null);
  session.commit((state) => {
    const latest = latestDraft(state);
    if (latest !== null && latest.hash !== draft_hash) throw new OverruleRefused("a newer draft arrived; look at it before overruling");
    if (!state.drafts.some((d) => d.product.key_findings.some((f) => f.id === finding))) throw new OverruleRefused(`there is no finding ${finding}`);
    if (likelihood !== null && terms !== null && !terms.likelihood.includes(likelihood)) {
      throw new OverruleRefused(`"${likelihood}" is not a likelihood term of the standard: give one of ${terms.likelihood.join(", ")}`);
    }
    if (likelihood !== null && likelihood.trim() === "") throw new OverruleRefused("a likelihood needs a term");
    if (confidence !== null && !CONFIDENCES.includes(confidence)) throw new OverruleRefused(`"${String(confidence)}" is not a confidence: give one of ${CONFIDENCES.join(", ")}`);
    if (stays === false && (likelihood !== null || confidence !== null)) throw new OverruleRefused("a dropped finding has no likelihood or confidence to set");
    const was = Object.hasOwn(state.overrules, finding) ? state.overrules[finding]! : null;
    const o: Overrule = { finding, draft_hash, likelihood, confidence, stays, note, by: actor.id, seq: state.seq + 1, ts: state.head_ts ?? "" };
    const withdrawing = likelihood === null && confidence === null && stays === null;
    // an overrule a later ruling on the finding has replaced is not active: there is nothing to withdraw, and the same values may be set again
    const wasActive = was !== null && activeOverrules(state).some((x) => x.finding === finding);
    if (withdrawing && !wasActive) throw new OverruleRefused(`there is no overrule of ${finding} to withdraw`);
    if (wasActive && same(was, o)) throw new OverruleRefused(`that is already the overrule of ${finding}`);
    const { run } = state;
    const out: EntryInput[] = [{ type: "finding.overruled", actor, run: run.id, payload: { finding, draft_hash, likelihood, confidence, stays, note } }];
    if (run.status === "none" || run.status === "finished" || latest === null) return out;
    // at the publish gate the work goes back to the analyst with the overrule as the reason (controller ruling 6)
    const back = gateSendBack(state, deps.pipeline, overruleReason(o));
    if (back.length > 0) return [...out, ...back];
    // the analyst at work builds its draft with the overrule in place: no revision of the person's is written over it
    const current = run.stages.find((s) => s.id === run.current);
    const role = deps.pipeline.stages.find((s) => s.id === run.current)?.role;
    if (role === "assemble" && current?.status === "running") return out;
    const now = [...activeOverrules(state).filter((x) => x.finding !== finding), ...(withdrawing ? [] : [o])];
    const live = (id: string): boolean => Object.hasOwn(state.cards, id) && state.cards[id]!.place !== "discarded";
    const findings = overruledFindings(latest.product.key_findings, now, state.drafts, terms, live);
    if (canonical(findings as unknown as Json) === canonical(latest.product.key_findings as unknown as Json)) return out;
    const product = { ...latest.product, key_findings: findings };
    return [...out, ...revisionEntries(state, deps.pipeline, { product, reason: `overruled ${overruleText(o)}`, actor }, now).entries];
  });
}
