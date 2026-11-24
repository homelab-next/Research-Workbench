import type { Json } from "../../core/canonical";
import { latestDraft, openMustAddress } from "../../core/state";
import type { CaseState } from "../../core/state";
import type { Actor, EntryInput } from "../../core/types";
import { cardPart } from "../../agents/context";
import type { PackPart } from "../../agents/context";
import { buildProduct, carriedCites, DraftWork, draftOf } from "../../agents/draft";
import { ToolError } from "../../agents/tools/kit";
import type { StageEnd, StageEnv } from "../engine";
import { agentActor, lastOutput, noSchema, stageAgent, titleOf } from "./agent";

const note = (id: string, title: string, text: string): PackPart => ({ kind: "note", id, title, text, marking: null, fixed: true });

/** What is wrong with the latest draft, from the ledger: failed checks, a failed evaluation, open challenges and a person's rejection. */
function mustFix(state: Readonly<CaseState>): string[] {
  const d = latestDraft(state as CaseState);
  if (d === null || !Object.hasOwn(state.reviews, d.hash)) return [];
  const r = state.reviews[d.hash]!;
  const out: string[] = [];
  for (const c of r.checks) {
    if (c.pass) continue;
    if (c.findings.length === 0) out.push(`Check ${c.check} failed`);
    for (const x of c.findings) out.push(`Check ${x.check} failed at ${x.where}: ${x.message}`);
  }
  if (r.evaluation !== null && !r.evaluation.pass) for (const x of r.evaluation.findings) out.push(`Evaluation found at ${x.where}: ${x.message}`);
  for (const c of Object.values(state.challenges)) {
    if (c.status === "open" && (c.draft_hash === d.hash || (c.run === state.run.id && c.severity === "must_address"))) out.push(`Open challenge ${c.id} (${c.severity}): ${c.text}`);
  }
  if (r.rejected !== null) out.push(`The person rejected this revision: ${r.rejected.reason}`);
  return out;
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
  const fixes = mustFix(state);
  if (fixes.length > 0) extras.push(note("must-fix", "What must be fixed in the latest draft", fixes.map((x) => `- ${x}`).join("\n")));
  const research = lastOutput(session, "research");
  if (research !== null) extras.push({ kind: "research", id: "research-output", title: "Research's output", text: JSON.stringify(research, null, 2), marking: null, fixed: false });
  const live = Object.values(state.cards).filter((c) => c.place !== "discarded").sort((a, b) => b.created_seq - a.created_seq);
  for (const c of live) extras.push(cardPart(c));

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
  let product;
  try {
    product = buildProduct(work, {
      objective, question: m.asked, case_marking: m.marking, cards: now.cards, source: (id) => deps.registry.source(id),
      assumptions: output.assumptions ?? [], change: output.change ?? "",
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
    const draft = draftOf(product, s.drafts.length + 1, actor as Actor, reason, carried);
    hash = draft.hash;
    const entries: EntryInput[] = [{ type: "draft.revised", actor, run: s.run.id, stage: stage.id, payload: { draft } }];
    for (const finding of product.key_findings) entries.push({ type: "assessment.made", actor, run: s.run.id, stage: stage.id, payload: { finding, draft_hash: draft.hash } });
    return entries;
  });
  return { kind: "finished", outcome: "pass", draft_hash: hash, output: end.output as Json, reason: null };
}
