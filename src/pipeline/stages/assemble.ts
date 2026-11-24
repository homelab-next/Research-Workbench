import type { Json } from "../../core/canonical";
import { latestDraft, openMustAddress } from "../../core/state";
import type { Actor, Entry, EntryInput } from "../../core/types";
import type { CaseSession } from "../../core/session";
import { ContextError, packPart } from "../../agents/context";
import type { PackPart } from "../../agents/context";
import { buildProduct, carriedCites, DraftWork, draftOf } from "../../agents/draft";
import { ToolError } from "../../agents/tools/kit";
import type { StageEnd, StageEnv } from "../engine";
import { agentActor, lastPass, noSchema, requestsOfPass, stageAgent, stageOfRole, titleOf } from "./agent";

/**
 * What is wrong with the latest draft, from the ledger: failed checks, a failed evaluation, open challenges and a person's rejection, as one part.
 * It is about that draft, so it has the draft's marking at least, and the marking of each model request that wrote any of it.
 */
function mustFix(session: CaseSession): PackPart | null {
  const state = session.state;
  const d = latestDraft(state);
  if (d === null || !Object.hasOwn(state.reviews, d.hash)) return null;
  const entries = session.entries();
  const r = state.reviews[d.hash]!;
  const out: string[] = [];
  const by: Entry[] = [];
  for (const c of r.checks) {
    if (c.pass) continue;
    if (c.findings.length === 0) out.push(`Check ${c.check} failed`);
    for (const x of c.findings) out.push(`Check ${x.check} failed at ${x.where}: ${x.message}`);
  }
  if (r.evaluation !== null && !r.evaluation.pass) {
    for (const x of r.evaluation.findings) out.push(`Evaluation found at ${x.where}: ${x.message}`);
    const made = entries.findLast((e) => e.type === "evaluation.made" && e.payload.draft_hash === d.hash);
    if (made !== undefined) by.push(made);
  }
  for (const c of Object.values(state.challenges)) {
    if (c.status === "open" && (c.draft_hash === d.hash || (c.run === state.run.id && c.severity === "must_address"))) {
      out.push(`Open challenge ${c.id} (${c.severity}): ${c.text}`);
      const raised = entries.find((e) => e.type === "challenge.raised" && e.payload.challenge.id === c.id);
      if (raised !== undefined) by.push(raised);
    }
  }
  if (r.rejected !== null) out.push(`The person rejected this revision: ${r.rejected.reason}`);
  if (out.length === 0) return null;
  return packPart({
    kind: "note", id: "must-fix", title: "What must be fixed in the latest draft", text: out.map((x) => `- ${x}`).join("\n"), fixed: true,
    entries, written_by: by, floor: d.product.marking,
  });
}

/** The reason for the draft: why this revision exists. */
function reasonFor(env: StageEnv): string {
  const { session, stage } = env;
  const entries = session.entries();
  if (session.state.drafts.length === 0) return "first draft";
  const lastFinished = entries.reduce((n, e) => (e.type === "stage.finished" && e.payload.stage === stage.id && e.payload.outcome !== "declined" ? e.seq : n), 0);
  const back = [...entries].reverse().find((e) => e.type === "stage.sent_back" && e.payload.to === stage.id && e.seq > lastFinished);
  if (back !== undefined && back.type === "stage.sent_back") {
    const from = session.state.run.stages.find((s) => s.id === back.payload.from)?.title ?? back.payload.from;
    return `revised after ${from}: ${back.payload.reason}`;
  }
  return "revised";
}

/**
 * Assemble: the analyst proposes findings and sections into a work copy of the latest draft. Code builds the product (objective, question,
 * marking and sources are never the model's) and is the only writer of `draft.revised` here. A request for research writes no draft.
 */
export async function assembleRunner(env: StageEnv): Promise<StageEnd> {
  const stalled = noSchema(env);
  if (stalled !== null) return stalled;
  const { session, deps, stage } = env;
  const state = session.state;
  const m = state.meta;
  if (m === null) return { kind: "stalled", reason: "Assemble: the case has no record yet" };
  const latest = latestDraft(state);
  const work = new DraftWork(latest?.product ?? null);

  const extras: PackPart[] = [];
  let fixes: PackPart | null;
  let research: ReturnType<typeof lastPass> = null;
  try {
    fixes = mustFix(session);
    const researchStage = stageOfRole(env, "research");
    research = researchStage === null ? null : lastPass(session, researchStage);
    if (fixes !== null) extras.push(fixes);
    if (research !== null) {
      // the researchers' notes are text models wrote: as strict as the requests of that pass
      const entries = session.entries();
      extras.push(packPart({
        kind: "research", id: "research-output", title: "Research's output", text: JSON.stringify(research.output, null, 2), fixed: false,
        entries, written_by: requestsOfPass(entries, research.entry), floor: null,
      }));
    }
  } catch (err) {
    if (err instanceof ContextError) return { kind: "stalled", reason: `${titleOf(env)}: ${err.message}` };
    throw err;
  }
  const live = Object.values(state.cards).filter((c) => c.place !== "discarded").sort((a, b) => b.created_seq - a.created_seq);
  for (const c of live) extras.push(packPart({ card: c, registry: deps.registry }));

  const task = [
    "Assemble the draft.",
    `The question asked: ${m.asked}`,
    latest === null ? "There is no draft yet." : `Start from draft ${latest.n}; change only what needs changing.`,
    "Propose one finding at a time, set each section, answer each open challenge, then reply with the output.",
  ].join("\n");
  const actorId = deps.profile.stages[stage.id]?.agent ?? "analyst";
  const end = await stageAgent(env, { actor_id: actorId, task, extras, draft: work, draft_hash: latest?.hash ?? null });
  if (end.kind !== "output") return end;
  const output = end.output as { change?: string; assumptions?: string[] };

  if (work.research.length > 0) {
    return { kind: "finished", outcome: "fail", draft_hash: null, output: end.output, reason: `more research is needed: ${work.research.map((r) => r.question).join("; ")}` };
  }
  // a must-address challenge left open would be lost in the new revision: the work is not accepted until it is answered
  const open = openMustAddress(session.state);
  if (open.length > 0) return { kind: "finished", outcome: "fail", draft_hash: null, output: end.output, reason: `challenge ${open[0]!.id} is still open` };
  // a person edited the draft while the analyst worked from the one before; theirs is not overwritten
  if ((latestDraft(session.state)?.hash ?? null) !== (latest?.hash ?? null)) {
    return { kind: "stalled", reason: `${titleOf(env)}: the draft was edited while it was being assembled. Resume to assemble again.` };
  }

  const now = session.state;
  const objective = m.objective === null ? "" : deps.registry.get("objective", m.objective)?.title ?? m.objective;
  // the requests of this pass wrote the text: those made in this stage since its latest start
  const entries = session.entries();
  const started = entries.reduce((n, e) => (e.type === "stage.started" && e.payload.stage === stage.id ? e.seq : n), 0);
  const written_at = entries.flatMap((e) => (e.type === "model.request" && e.stage === stage.id && e.seq > started ? [e.payload.marking] : []));
  let product;
  try {
    product = buildProduct(work, {
      objective, question: m.asked, case_marking: m.marking, cards: now.cards, source: (id) => deps.registry.source(id),
      assumptions: output.assumptions ?? [], change: output.change ?? "", written_at,
    });
  } catch (err) {
    if (err instanceof ToolError) return { kind: "stalled", reason: `${titleOf(env)}: ${err.message}` };
    throw err;
  }
  const actor = agentActor(session, actorId);
  const reason = reasonFor(env);
  // a section carried over from the draft before keeps the cards it cited by tool only
  const carried = carriedCites(latest, product, now.cards);
  let hash = "";
  session.commit((s) => {
    // a person stopped the run while the model was answering: the work is not recorded
    if (s.run.id !== state.run.id || s.run.status === "finished") return [];
    const draft = draftOf(product, s.drafts.length + 1, actor as Actor, reason, carried);
    hash = draft.hash;
    const entries: EntryInput[] = [{ type: "draft.revised", actor, run: s.run.id, stage: stage.id, payload: { draft } }];
    for (const finding of product.key_findings) entries.push({ type: "assessment.made", actor, run: s.run.id, stage: stage.id, payload: { finding, draft_hash: draft.hash } });
    return entries;
  });
  if (hash === "") return { kind: "stopped" };
  return { kind: "finished", outcome: "pass", draft_hash: hash, output: end.output as Json, reason: null };
}
