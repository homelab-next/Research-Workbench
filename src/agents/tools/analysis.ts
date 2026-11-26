import type { Json } from "../../core/canonical";
import { isPersonCard, namesFinding, ruledFindings, rulingText } from "../../core/state";
import { ANSWER_ACTIONS, CONFIDENCES, SECTIONS, SEVERITIES } from "../../core/types";
import type { Schema } from "../../core/schema";
import { composeStatement, likelihoodMatches } from "../draft";
import type { DraftWork, TextSection } from "../draft";
import { escapeRe } from "../../modules/sqlguard";
import type { ToolContext, ToolDef, ToolResult } from "./index";
import { idArg, MAX_TEXT, params, str, ToolError } from "./kit";

const done = (summary: string, view: Json): ToolResult => ({ ok: true, summary, view, marking: null });
const strings = (v: Json | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function drafting(ctx: ToolContext): DraftWork {
  if (ctx.draft === null) throw new ToolError("no draft is being assembled in this stage");
  return ctx.draft;
}
function reviewing(ctx: ToolContext): string {
  if (ctx.draft_hash === null) throw new ToolError("no draft is under review in this stage");
  return ctx.draft_hash;
}
function cardsExist(ctx: ToolContext, ids: string[]): void {
  for (const id of ids) {
    if (!Object.hasOwn(ctx.session.state.cards, id)) throw new ToolError(`unknown card: ${id}`);
    if (ctx.session.state.cards[id]!.place === "discarded") throw new ToolError(`card ${id} was discarded`);
  }
}

/** An empty result is evidence only when it is a proven negative over full coverage; anything else is a gap (check 8 reads the same rule). */
function notSeen(ctx: ToolContext, id: string): boolean {
  const card = ctx.session.state.cards[id]!;
  // a statement by the person has no rows by nature: it is their word, not an empty result
  if (isPersonCard(card)) return false;
  return card.row_count === 0 && !(card.empty === "proven-negative" && card.coverage !== null && card.coverage.kind === "full");
}
/** True when the text names the card, as a whole word in any case (as check 8 reads a section). */
const names = (text: string, id: string): boolean => new RegExp(`(?<![\\w])${escapeRe(id)}(?![\\w])`, "i").test(text);

async function proposeAssessment(ctx: ToolContext, a: Record<string, Json>): Promise<ToolResult> {
  const work = drafting(ctx);
  const terms = work.terms;
  if (terms === null) throw new ToolError("the profile names no standard with likelihood terms, so a finding cannot be worded");
  const likelihood = str(a.likelihood);
  if (!terms.likelihood.includes(likelihood)) throw new ToolError(`"${likelihood}" is not a likelihood term of the standard: give one of ${terms.likelihood.join(", ")}`);
  const claim = str(a.claim);
  // the likelihood is said once, in the composed sentence: a claim with a term of its own would hold two
  const held = likelihoodMatches(claim, terms);
  if (held.length > 0) {
    const m = held[0]!;
    throw new ToolError(`the claim holds the likelihood term "${m.term}"${m.text === m.term ? "" : ` (as "${m.text}")`}: state the claim plainly and give how likely it is only in likelihood`);
  }
  const cites = strings(a.cites);
  cardsExist(ctx, cites);
  for (const c of cites) {
    if (notSeen(ctx, c)) throw new ToolError(`${c} is not seen (not proof of absence): put it in gaps_and_limits, not in a finding`);
  }
  const id = work.setFinding({
    statement: composeStatement(likelihood, claim, terms), likelihood, confidence: str(a.confidence) as "low" | "moderate" | "high",
    confidence_basis: str(a.confidence_basis), cites, assumptions: strings(a.assumptions), reasoning: str(a.reasoning),
  }, typeof a.replaces === "string" ? a.replaces : null);
  return done(`finding ${id}`, { finding: id });
}

/** What the draft being assembled holds, in a line: "the draft now has findings f1, f3 and gaps_and_limits set". */
export function draftState(work: DraftWork): string {
  const ids = work.findings.map((x) => x.id);
  const findings = ids.length === 0 ? "no findings" : `${ids.length === 1 ? "finding" : "findings"} ${ids.join(", ")}`;
  const set = (Object.keys(work.sections) as TextSection[]).filter((k) => work.sections[k].trim() !== "");
  return `the draft now has ${findings} and ${set.length === 0 ? "no section set" : `${set.join(", ")} set`}`;
}
/** A refused proposal says why and what the draft now holds, so the model does not propose again blindly. Outside a drafting stage, the reason alone. */
const refusedProposal = (ctx: ToolContext, reason: string): string => (ctx.draft === null ? reason : `refused: ${reason}; ${draftState(ctx.draft)}`);

async function proposeNarrative(ctx: ToolContext, a: Record<string, Json>): Promise<ToolResult> {
  const work = drafting(ctx);
  const cites = strings(a.cites);
  cardsExist(ctx, cites);
  const section = str(a.section) as TextSection;
  const said = str(a.text);
  // a section other than gaps_and_limits that names a card not seen would use it as evidence (check 8 fails it)
  if (section !== "gaps_and_limits") {
    for (const c of Object.values(ctx.session.state.cards)) {
      if (c.place !== "discarded" && notSeen(ctx, c.id) && names(said, c.id)) throw new ToolError(`${c.id} is not seen (not proof of absence): name it only in gaps_and_limits`);
    }
  }
  work.setSection(section, said, cites);
  return done(`section ${section}`, { section });
}

async function requestResearch(ctx: ToolContext, a: Record<string, Json>): Promise<ToolResult> {
  const work = drafting(ctx);
  const question = str(a.question);
  const why = str(a.why);
  ctx.session.commit(() => [{ type: "research.requested", actor: ctx.actor, payload: { question, why } }]);
  work.research.push({ question, why });
  return done("research requested", { requested: true });
}

async function raiseChallenge(ctx: ToolContext, a: Record<string, Json>): Promise<ToolResult> {
  const hash = reviewing(ctx);
  if (!Object.hasOwn(ctx.session.state.reviews, hash)) throw new ToolError("no draft is under review in this stage");
  const cites = strings(a.cites);
  cardsExist(ctx, cites);
  // a finding the person has ruled on is fixed for the run: neither reviewer reopens it
  const said = str(a.text);
  for (const [finding, c] of ruledFindings(ctx.session.state)) {
    if (namesFinding(said, finding)) throw new ToolError(`the person has ruled on ${finding} (${rulingText(ctx.session.state, c)}): it may not be reopened`);
  }
  let id = "";
  ctx.session.commit((_s, ids) => {
    id = ids.next("challenge");
    return [{ type: "challenge.raised", actor: ctx.actor, payload: { challenge: { id, draft_hash: hash, severity: str(a.severity) as "must_address" | "consider", text: str(a.text), cites } } }];
  });
  if (!Object.hasOwn(ctx.session.state.challenges, id)) throw new ToolError("the challenge was not recorded");
  return done(`challenge ${id}`, { challenge: id });
}

const OPEN_LISTED = 20;
const QUESTION_CHARS = 200;
/** A text on one line and at most `n` characters, for a refusal the model reads. */
const oneLine = (t: string, n: number): string => {
  const flat = t.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
};

async function answerChallenge(ctx: ToolContext, a: Record<string, Json>): Promise<ToolResult> {
  reviewing(ctx);
  const given = str(a.challenge);
  const open = Object.values(ctx.session.state.challenges).filter((c) => c.status === "open");
  // the challenge's id, or else its exact text (a model often answers a challenge by its question)
  const byId = open.find((c) => c.id === given);
  const byText = byId === undefined ? open.filter((c) => c.text.trim() === given.trim()) : [];
  const c = byId ?? (byText.length === 1 ? byText[0]! : null);
  if (c === null) {
    const listed = open.slice(0, OPEN_LISTED).map((o) => `${o.id}: ${oneLine(o.text, QUESTION_CHARS)}`);
    const more = open.length > OPEN_LISTED ? `, and ${open.length - OPEN_LISTED} more` : "";
    const why = byText.length > 1 ? "; several open challenges have that text: answer by id" : "";
    throw new ToolError(`${oneLine(given, QUESTION_CHARS)} is not an open challenge${why}; ${open.length === 0 ? "there is no open challenge" : `open challenges: ${listed.join(", ")}${more}`}`);
  }
  const id = c.id;
  ctx.session.commit(() => [{ type: "challenge.answered", actor: ctx.actor, payload: { challenge: id, answer: str(a.answer), action: str(a.action) as "revised" | "rebutted" } }]);
  return done(`answered ${id}`, { answered: id });
}

const text = { type: "string", minLength: 1, maxLength: MAX_TEXT, pattern: "\\S" } as const;
const card = idArg;
const cites = { type: "array", items: card, description: "ids of cards" } as const;
const citesOne = { ...cites, minItems: 1 } as const;

/** propose_assessment's parameters. While a draft is assembled the likelihood is an enum of the profile standard's terms, read from the standard. */
function assessmentParameters(likelihood: readonly string[] | null): Schema {
  return params({
    claim: { ...text, description: "the plain assertion, without how likely it is (that goes in likelihood); it is worded as \"We assess it is <likelihood> that <claim>.\"" },
    likelihood: likelihood === null ? text : { type: "string", enum: [...likelihood] },
    confidence: { type: "string", enum: [...CONFIDENCES] }, confidence_basis: text, cites: citesOne,
    assumptions: { type: "array", items: text }, reasoning: text, replaces: card,
  }, ["claim", "likelihood", "confidence", "confidence_basis", "cites", "assumptions", "reasoning"]);
}
export const ANALYSIS_TOOLS: ToolDef[] = [
  {
    name: "propose_assessment",
    description: "Propose a finding in the draft, citing the cards that support it. Write the claim plainly, give how likely it is as one of the standard's likelihood terms, and say how confident you are and why; the statement is worded from them. A card with no rows may be cited only when it is a proven negative with full coverage; any other empty card is a gap. A statement by the person may be cited; say in confidence_basis that the finding rests on the person's word. Name `replaces` to change one you already proposed.",
    parameters: assessmentParameters(null),
    parametersFor: (ctx) => assessmentParameters(ctx.draft?.terms?.likelihood ?? null),
    call: proposeAssessment, refused: refusedProposal,
  },
  {
    name: "propose_narrative", description: "Write one section of the draft: summary, gaps_and_limits, alternatives or assessment. A card with no rows that is not a proven negative with full coverage is a gap: name it only in gaps_and_limits.",
    parameters: params({ section: { type: "string", enum: SECTIONS.filter((s) => s !== "key_findings") }, text, cites }, ["section", "text", "cites"]),
    call: proposeNarrative, refused: refusedProposal,
  },
  { name: "request_research", description: "Ask for more research on a question the draft cannot answer yet.", parameters: params({ question: text }, ["question"]), call: requestResearch },
  {
    name: "raise_challenge", description: "Challenge the draft under review. must_address means it cannot pass until answered.",
    parameters: params({ severity: { type: "string", enum: [...SEVERITIES] }, text, cites }, ["severity", "text", "cites"]), call: raiseChallenge,
  },
  {
    name: "answer_challenge", description: "Answer an open challenge, named by its id (or its exact text): say it was revised in the draft or rebut it.",
    parameters: params({ challenge: { ...text, description: "the challenge's id, or its exact text" }, answer: text, action: { type: "string", enum: [...ANSWER_ACTIONS] } }, ["challenge", "answer", "action"]), call: answerChallenge,
  },
];
