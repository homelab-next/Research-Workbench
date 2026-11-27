import type { Json } from "../../core/canonical";
import { isPlainObject } from "../../core/canonical";
import { activeOverrules, latestDraft, openMustAddress, openQuestions } from "../../core/state";
import type { Actor, Draft, Entry, EntryInput } from "../../core/types";
import type { Schema } from "../../core/schema";
import type { CaseSession } from "../../core/session";
import { ContextError, packPart } from "../../agents/context";
import type { PackPart } from "../../agents/context";
import { buildProduct, forcedProposal, lackingOf, carriedCites, composeChange, DraftWork, draftOf, termsOf } from "../../agents/draft";
import { ToolError } from "../../agents/tools/kit";
import type { StageEnd, StageEnv } from "../engine";
import { overruledFindings } from "../overrule";
import { questionMarking, withOpenQuestions } from "../questions";
import { reviewPointsPart } from "../review-points";
import { agentActor, lastPass, noSchema, requestsOfPass, stageAgent, stageOfRole, titleOf } from "./agent";

/**
 * What is wrong with the latest draft, from the ledger: failed checks and a person's rejection, as one part. The reviewers' points are a part of their own.
 * It is about that draft, so it has the draft's marking at least.
 */
function mustFix(session: CaseSession): PackPart | null {
  const state = session.state;
  const d = latestDraft(state);
  if (d === null || !Object.hasOwn(state.reviews, d.hash)) return null;
  const entries = session.entries();
  const r = state.reviews[d.hash]!;
  const out: string[] = [];
  for (const c of r.checks) {
    if (c.pass) continue;
    if (c.findings.length === 0) out.push(`Check ${c.check} failed`);
    for (const x of c.findings) out.push(`Check ${x.check} failed at ${x.where}: ${x.message}`);
  }
  // the reviewers' points are in their own part, one list labelled by reviewer (reviewPointsPart)
  if (r.rejected !== null) out.push(`The person rejected this revision: ${r.rejected.reason}`);
  if (out.length === 0) return null;
  return packPart({
    kind: "note", id: "must-fix", title: "What must be fixed in the latest draft", text: out.map((x) => `- ${x}`).join("\n"), fixed: true,
    entries, written_by: [], floor: d.product.marking,
  });
}

/** The previous draft's findings, shown as reference to an Assemble pass whose draft holds only what it proposes. As strict as that draft. */
function previousFindings(session: CaseSession, d: Draft): PackPart {
  return packPart({
    kind: "draft", id: `draft-${d.n}-findings`, title: `Draft ${d.n}'s findings, for reference: they are not carried into the new draft; restate the ones you keep`,
    text: JSON.stringify(d.product.key_findings, null, 2), fixed: true, entries: session.entries(), written_by: [], floor: d.product.marking,
  });
}

/** Said when an answer carries a change kind the record rules out. `first` is the standard's first change term. */
export const nothingPublished = (first: string): string => `nothing has been published in this case before, so the change is '${first}'`;
/** The answer schema with change_kind allowing exactly the standard's change terms. A schema with no change_kind is unchanged. */
export function changeKinds(schema: Schema, terms: readonly string[]): Schema {
  const kind = schema.properties?.change_kind;
  if (kind === undefined) return schema;
  return { ...schema, properties: { ...schema.properties, change_kind: { ...kind, enum: [...terms] } } };
}
/** The answer schema with change_kind allowing only the first change term: what a case with no earlier publication allows. Other schemas are unchanged. */
export function firstJudgmentOnly(schema: Schema, first: string): Schema {
  const kind = schema.properties?.change_kind;
  if (kind === undefined || !Array.isArray(kind.enum) || !kind.enum.includes(first)) return schema;
  return { ...schema, properties: { ...schema.properties, change_kind: { ...kind, enum: [first] } } };
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
  // a finding's wording is composed from the profile standard's terms, read from the standard: one place
  const standard = deps.profile.standard === null ? null : deps.registry.get("standard", deps.profile.standard);
  const terms = termsOf(standard?.body ?? null);
  // a new finding takes an id no draft of the case has held and no overrule names: a dropped finding's id is never a new claim's (final review I1)
  const reserved = [...new Set([...state.drafts.flatMap((d) => d.product.key_findings.map((f) => f.id)), ...Object.keys(state.overrules)])];
  const work = new DraftWork(latest?.product ?? null, terms, reserved);

  const extras: PackPart[] = [];
  let fixes: PackPart | null;
  let research: ReturnType<typeof lastPass> = null;
  try {
    fixes = mustFix(session);
    const points = reviewPointsPart(session, deps.pipeline, "assemble");
    const researchStage = stageOfRole(env, "research");
    research = researchStage === null ? null : lastPass(session, researchStage);
    if (fixes !== null) extras.push(fixes);
    if (points !== null) extras.push(points);
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
  // the previous draft's findings are reference: this pass's draft holds only the findings proposed in it
  if (latest !== null && latest.product.key_findings.length > 0) extras.push(previousFindings(session, latest));
  const live = Object.values(state.cards).filter((c) => c.place !== "discarded").sort((a, b) => b.created_seq - a.created_seq);
  for (const c of live) extras.push(packPart({ card: c, registry: deps.registry }));

  const task = [
    "Assemble the draft.",
    `The question asked: ${m.asked}`,
    latest === null ? "There is no draft yet." : `Start from draft ${latest.n}; change only what needs changing. Its sections are kept unless you set them again. Its findings are not kept: this draft holds only the findings you propose now, so propose again each one you keep (name it in replaces to keep its id).`,
    "Propose one finding at a time, set each section, answer each open challenge, then reply with the output.",
    "A finding's claim is the plain assertion; its likelihood is one of the standard's terms; the statement is worded from them by code. The change from earlier judgments is a change_kind and a change_detail.",
  ].join("\n");
  const actorId = deps.profile.stages[stage.id]?.agent ?? "analyst";
  // the change follows the record: with nothing published in this case, the only change is a first judgment
  // the kinds are the standard's change terms; its first is the only one while nothing is published
  const nothing = state.published.length === 0;
  const narrowing = terms === null ? {} : {
    narrow: (s: Schema): Schema => (nothing ? firstJudgmentOnly(changeKinds(s, terms.change_terms), terms.first_change) : changeKinds(s, terms.change_terms)),
    ...(nothing ? { explain: (a: Json): string[] => (isPlainObject(a) && typeof a.change_kind === "string" && a.change_kind !== terms.first_change ? [nothingPublished(terms.first_change)] : []) } : {}),
  };
  // an answer over an empty required section or no finding is not accepted; a request for research is not a draft, so it is not held to it
  const lacking = (): string[] => (work.research.length > 0 ? [] : lackingOf(work));
  const lackingAsk = (missing: string[]): string => {
    const sections = missing.filter((x) => x !== "findings");
    const tools = sections.length === 0 ? "propose_assessment" : sections.length === missing.length ? "propose_narrative" : "propose_narrative and propose_assessment";
    return `The draft still has no ${missing.join(", ")}; propose ${sections.length === 0 && missing.length === 1 ? "one" : "them"} with ${tools}, then answer`;
  };
  const end = await stageAgent(env, { actor_id: actorId, task, extras, draft: work, draft_hash: latest?.hash ?? null, lacking, lackingAsk, force: forcedProposal, ...narrowing });
  if (end.kind !== "output") return end;
  const output = end.output as { change_kind?: string; change_detail?: string; assumptions?: string[] };

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
  // the person's overrules hold in every draft, whatever the analyst proposed: code puts them in place
  const held = overruledFindings(work.findings, activeOverrules(now), now.drafts, terms, (id) => Object.hasOwn(now.cards, id) && now.cards[id]!.place !== "discarded");
  work.findings.splice(0, work.findings.length, ...held);
  // a question the person has not answered is a gap, named by code; its text is a model's, so the draft is as strict as the request that wrote it
  const unanswered = openQuestions(now);
  work.setSection("gaps_and_limits", withOpenQuestions(work.sections.gaps_and_limits, unanswered), work.narrativeCites.gaps_and_limits);
  for (const q of unanswered) {
    const marking = questionMarking(session, q);
    if (marking !== null) written_at.push(marking);
  }
  let product;
  try {
    product = buildProduct(work, {
      objective, question: m.asked, case_marking: m.marking, cards: now.cards, source: (id) => deps.registry.source(id),
      untrusted: (id) => { const src = deps.registry.source(id); return src === null || deps.registry.rootOf(src.dir)?.trusted !== true; },
      assumptions: output.assumptions ?? [], change: output.change_kind === undefined ? "" : composeChange(output.change_kind, output.change_detail ?? "", terms?.first_change ?? ""), written_at,
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
