import type { Json } from "../../core/canonical";
import { ANSWER_ACTIONS, CONFIDENCES, SECTIONS, SEVERITIES } from "../../core/types";
import type { Schema } from "../../core/schema";
import { composeStatement, likelihoodMatches } from "../draft";
import type { DraftWork, TextSection } from "../draft";
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
  // an empty result is evidence only when it is a proven negative over full coverage; anything else is a gap (check 8 reads the same rule)
  for (const c of cites) {
    const card = ctx.session.state.cards[c]!;
    if (card.row_count === 0 && !(card.empty === "proven-negative" && card.coverage !== null && card.coverage.kind === "full")) {
      throw new ToolError(`${c} is not seen (not proof of absence): put it in gaps_and_limits, not in a finding`);
    }
  }
  const id = work.setFinding({
    statement: composeStatement(likelihood, claim, terms), likelihood, confidence: str(a.confidence) as "low" | "moderate" | "high",
    confidence_basis: str(a.confidence_basis), cites, assumptions: strings(a.assumptions), reasoning: str(a.reasoning),
  }, typeof a.replaces === "string" ? a.replaces : null);
  return done(`finding ${id}`, { finding: id });
}

async function proposeNarrative(ctx: ToolContext, a: Record<string, Json>): Promise<ToolResult> {
  const work = drafting(ctx);
  const cites = strings(a.cites);
  cardsExist(ctx, cites);
  const section = str(a.section) as TextSection;
  work.setSection(section, str(a.text), cites);
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
  let id = "";
  ctx.session.commit((_s, ids) => {
    id = ids.next("challenge");
    return [{ type: "challenge.raised", actor: ctx.actor, payload: { challenge: { id, draft_hash: hash, severity: str(a.severity) as "must_address" | "consider", text: str(a.text), cites } } }];
  });
  if (!Object.hasOwn(ctx.session.state.challenges, id)) throw new ToolError("the challenge was not recorded");
  return done(`challenge ${id}`, { challenge: id });
}

async function answerChallenge(ctx: ToolContext, a: Record<string, Json>): Promise<ToolResult> {
  reviewing(ctx);
  const id = str(a.challenge);
  const c = Object.hasOwn(ctx.session.state.challenges, id) ? ctx.session.state.challenges[id]! : null;
  if (c === null || c.status !== "open") throw new ToolError(`challenge ${id} is not open`);
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
    description: "Propose a finding in the draft, citing the cards that support it. Write the claim plainly, give how likely it is as one of the standard's likelihood terms, and say how confident you are and why; the statement is worded from them. A card with no rows may be cited only when it is a proven negative with full coverage; any other empty card is a gap. Name `replaces` to change one you already proposed.",
    parameters: assessmentParameters(null),
    parametersFor: (ctx) => assessmentParameters(ctx.draft?.terms?.likelihood ?? null),
    call: proposeAssessment,
  },
  {
    name: "propose_narrative", description: "Write one section of the draft: summary, gaps_and_limits, alternatives or assessment.",
    parameters: params({ section: { type: "string", enum: SECTIONS.filter((s) => s !== "key_findings") }, text, cites }, ["section", "text", "cites"]),
    call: proposeNarrative,
  },
  { name: "request_research", description: "Ask for more research on a question the draft cannot answer yet.", parameters: params({ question: text }, ["question"]), call: requestResearch },
  {
    name: "raise_challenge", description: "Challenge the draft under review. must_address means it cannot pass until answered.",
    parameters: params({ severity: { type: "string", enum: [...SEVERITIES] }, text, cites }, ["severity", "text", "cites"]), call: raiseChallenge,
  },
  {
    name: "answer_challenge", description: "Answer an open challenge: say it was revised in the draft or rebut it.",
    parameters: params({ challenge: card, answer: text, action: { type: "string", enum: [...ANSWER_ACTIONS] } }, ["challenge", "answer", "action"]), call: answerChallenge,
  },
];
