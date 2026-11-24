import type { Json } from "../../core/canonical";
import { ANSWER_ACTIONS, CONFIDENCES, SECTIONS, SEVERITIES } from "../../core/types";
import type { DraftWork, TextSection } from "../draft";
import type { ToolContext, ToolDef, ToolResult } from "./index";
import { params, str, ToolError } from "./kit";

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
  for (const id of ids) if (!Object.hasOwn(ctx.session.state.cards, id)) throw new ToolError(`unknown card: ${id}`);
}

async function proposeAssessment(ctx: ToolContext, a: Record<string, Json>): Promise<ToolResult> {
  const work = drafting(ctx);
  const cites = strings(a.cites);
  cardsExist(ctx, cites);
  const id = work.setFinding({
    statement: str(a.statement), likelihood: str(a.likelihood), confidence: str(a.confidence) as "low" | "moderate" | "high",
    confidence_basis: str(a.confidence_basis), cites, assumptions: strings(a.assumptions), reasoning: str(a.reasoning),
  }, typeof a.replaces === "string" ? a.replaces : null);
  return done(`finding ${id}`, { finding: id });
}

async function proposeNarrative(ctx: ToolContext, a: Record<string, Json>): Promise<ToolResult> {
  const work = drafting(ctx);
  cardsExist(ctx, strings(a.cites));
  const section = str(a.section) as TextSection;
  work.setSection(section, str(a.text));
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
  const cites = strings(a.cites);
  cardsExist(ctx, cites);
  let id = "";
  ctx.session.commit((_s, ids) => {
    id = ids.next("challenge");
    return [{ type: "challenge.raised", actor: ctx.actor, payload: { challenge: { id, draft_hash: hash, severity: str(a.severity) as "must_address" | "consider", text: str(a.text), cites } } }];
  });
  return done(`challenge ${id}`, { challenge: id });
}

async function answerChallenge(ctx: ToolContext, a: Record<string, Json>): Promise<ToolResult> {
  const id = str(a.challenge);
  const c = Object.hasOwn(ctx.session.state.challenges, id) ? ctx.session.state.challenges[id]! : null;
  if (c === null || c.status !== "open") throw new ToolError(`challenge ${id} is not open`);
  ctx.session.commit(() => [{ type: "challenge.answered", actor: ctx.actor, payload: { challenge: id, answer: str(a.answer), action: str(a.action) as "revised" | "rebutted" } }]);
  return done(`answered ${id}`, { answered: id });
}

const text = { type: "string", minLength: 1 } as const;
const cites = { type: "array", items: text, description: "ids of cards" } as const;
const citesOne = { ...cites, minItems: 1 } as const;
export const ANALYSIS_TOOLS: ToolDef[] = [
  {
    name: "propose_assessment", description: "Propose a finding in the draft, citing the cards that support it. Say how likely it is and how confident you are, and why. Name `replaces` to change one you already proposed.",
    parameters: params({
      statement: text, likelihood: text, confidence: { type: "string", enum: [...CONFIDENCES] }, confidence_basis: text, cites: citesOne,
      assumptions: { type: "array", items: text }, reasoning: text, replaces: text,
    }, ["statement", "likelihood", "confidence", "confidence_basis", "cites", "assumptions", "reasoning"]),
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
    parameters: params({ challenge: text, answer: text, action: { type: "string", enum: [...ANSWER_ACTIONS] } }, ["challenge", "answer", "action"]), call: answerChallenge,
  },
];
