// The person overrules a finding (slice 8): code holds every draft to the overrule, whoever writes the draft.
import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import { activeOverrules, holdsOverrule, latestDraft, overruleReason } from "../core/state";
import type { CaseState, Overrule } from "../core/state";
import { CONFIDENCES } from "../core/types";
import type { Actor, Draft, Entry, EntryInput, Finding } from "../core/types";
import { composeStatement, termsOf } from "../agents/draft";
import type { StandardTerms } from "../agents/draft";
import type { EngineDeps } from "./engine";
import type { Pipeline } from "./manifests";

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
 * The work sent back from the publish gate to the stage the gate sends work back to (Assemble), with the person's changes as the reason, and that
 * stage started: what the person's "Send back to Assemble with my changes" writes, the send-back in their name (slice 10). Empty when the run is not
 * waiting at the publish gate, or the gate sends work back nowhere.
 */
export function gateSendBack(state: Readonly<CaseState>, pipeline: Pipeline, reason: string, by: Actor = ENGINE): EntryInput[] {
  const { run } = state;
  if (run.status === "none" || run.status === "finished" || run.waiting !== "publish") return [];
  const gate = pipeline.stages.find((s) => s.gate === "publish");
  const to = gate?.on_fail ?? null;
  const target = to === null ? undefined : pipeline.stages.find((s) => s.id === to);
  if (gate === undefined || target === undefined) return [];
  const link = { run: run.id, stage: target.id };
  const edge = `${gate.id}>${target.id}`;
  const count = (Object.hasOwn(run.sendbacks, edge) ? run.sendbacks[edge]! : 0) + 1;
  // as publish.ts's reject does, the gate's own stage ends as failed on the draft it was sent back with, so it is not shown waiting while the target works
  const draft = latestDraft(state);
  const out: EntryInput[] = [];
  if (draft !== null) out.push({ type: "stage.finished", actor: ENGINE, run: run.id, stage: gate.id, payload: { stage: gate.id, attempt: run.stages.find((x) => x.id === gate.id)?.attempts ?? 1, outcome: "fail", draft_hash: draft.hash, output: null, reason } });
  out.push({ type: "stage.sent_back", actor: by, ...link, payload: { from: gate.id, to: target.id, reason, count } });
  if (target.phase !== null && target.phase !== state.phase) out.push({ type: "case.phase_changed", actor: ENGINE, ...link, payload: { phase: target.phase } });
  out.push({ type: "stage.started", actor: ENGINE, ...link, payload: { stage: target.id, attempt: (run.stages.find((x) => x.id === target.id)?.attempts ?? 0) + 1 } });
  return out;
}

/**
 * The send-back an overrule made while a run is active calls for once the current stage has ended (controller ruling on I4): to the stage the
 * publish gate sends work back to (Assemble), from the gate, with the overrules' reasons. An overrule calls for it when it was made in this run
 * after Assemble last started, a draft exists, and the latest draft does not hold it or Assemble built that draft while the overrule was new to it
 * (code put the values in place, but the basis and reasoning are the analyst's for its own values). An overrule made while the run waits at the
 * publish gate is the person's to send back with their other changes (slice 10): it is left out here. Null when none does.
 */
export function overruleSendBack(state: Readonly<CaseState>, entries: readonly Entry[], pipeline: Pipeline): { stage: string; attempt: number; sent_back: { from: string; to: string; reason: string; count: number } } | null {
  const { run } = state;
  const latest = latestDraft(state);
  if (run.status !== "running" || run.id === null || latest === null) return null;
  const gate = pipeline.stages.find((s) => s.gate === "publish");
  const to = gate?.on_fail ?? null;
  if (gate === undefined || to === null || !run.stages.some((s) => s.id === to)) return null;
  let runStart = 0;
  let asmStart = 0;
  let drafted: Entry | null = null;
  for (const e of entries) {
    if (e.type === "run.started") { runStart = e.seq; asmStart = 0; drafted = null; }
    else if (e.type === "stage.started") { if (e.payload.stage === to) asmStart = e.seq; }
    else if (e.type === "draft.revised") drafted = e;
  }
  const since = Math.max(runStart, asmStart);
  const due = activeOverrules(state).filter((o) => o.seq > since
    && (holdsOverrule(latest.product, o) === false || (drafted !== null && drafted.seq > o.seq && drafted.stage === to)));
  if (due.length === 0) return null;
  const edge = `${gate.id}>${to}`;
  const count = (Object.hasOwn(run.sendbacks, edge) ? run.sendbacks[edge]! : 0) + 1;
  return { stage: to, attempt: (run.stages.find((x) => x.id === to)?.attempts ?? 0) + 1, sent_back: { from: gate.id, to, reason: due.map(overruleReason).join("\n"), count } };
}

const same = (a: Overrule, b: Overrule): boolean => a.likelihood === b.likelihood && a.confidence === b.confidence && a.stays === b.stays && a.note.trim() === b.note.trim();

/**
 * Records the overrule. At the publish gate nothing more: the person sends it back with their other changes (slice 10, reversing controller ruling 6);
 * elsewhere in a run the engine sends the work back when the current stage ends (overruleSendBack). Throws OverruleRefused.
 */
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
    // at the publish gate it waits for the person's send-back with their changes (slice 10); anywhere else in a run the engine sends it back when
    // the current stage ends (overruleSendBack; controller ruling on I4)
    return [{ type: "finding.overruled", actor, run: state.run.id, payload: { finding, draft_hash, likelihood, confidence, stays, note } }];
  });
}
