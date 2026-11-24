import type { Entry, EntryType } from "../core/types";
import type { Reference } from "../core/wire";

/** A payload read as loosely as the fold reads it: nothing here assumes a field is there. */
type Loose = Record<string, unknown>;
const loose = (x: unknown): Loose => (typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Loose) : {});
const str = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" || typeof x === "boolean" ? String(x) : "");
const cost = (x: unknown): string => { const c = loose(x); return typeof c.amount === "number" ? `${c.amount} ${str(c.unit)}` : ""; };
const join = (...parts: string[]): string => parts.filter((p) => p !== "").join(" · ");
const plural = (n: unknown, word: string): string => (typeof n === "number" ? `${n} ${word}` : "");

type Say = (p: Loose, ref: Reference) => string;
const none: Say = () => "";
/** What each entry type is called, and the particulars worth reading. The table is keyed by EntryType, so a new type that has no row is a type error. */
const TABLE: Record<EntryType, [string, Say]> = {
  "case.created": ["case opened", (p) => join(str(p.id), str(p.title))],
  "case.phase_changed": ["phase changed", (p) => str(p.phase)],
  "run.started": ["run started", (p) => join(str(p.run), str(p.pipeline))],
  "run.paused": ["run paused", (p) => str(p.reason)],
  "run.resumed": ["run resumed", none],
  "run.interrupted": ["run interrupted", none],
  "run.finished": ["run finished", (p) => join(str(p.outcome), str(p.reason))],
  "stage.model_set": ["model chosen", (p) => { const c = loose(p.choice); return join(str(p.stage), join(str(c.provider), str(c.model))); }],
  "stage.pack_limit_set": ["pack limit set", (p) => join(str(p.stage), p.max_marking === null ? "no limit" : str(p.max_marking))],
  "stage.started": ["stage started", (p) => join(str(p.stage), typeof p.attempt === "number" ? `attempt ${p.attempt}` : "")],
  "stage.finished": ["stage finished", (p) => join(str(p.stage), str(p.outcome), str(p.reason))],
  "stage.sent_back": ["stage sent back", (p) => `${str(p.from)} → ${str(p.to)}: ${str(p.reason)}`],
  "gate.waiting": ["waiting at a gate", (p) => str(p.gate)],
  "gate.passed": ["gate passed", (p) => str(p.gate)],
  "budget.set": ["token budget set", (p) => (p.tokens === null ? "no limit" : plural(p.tokens, "tokens"))],
  "job.started": ["job started", (p) => join(str(p.job), str(p.title))],
  "job.finished": ["job finished", (p) => join(str(p.job), str(p.outcome))],
  "plan.proposed": ["plan proposed", (p) => { const plan = loose(p.plan); return join(str(plan.id), str(plan.goal)); }],
  "plan.accepted": ["plan accepted", (p) => join(str(p.plan), Array.isArray(p.steps) ? `${p.steps.length} steps` : "")],
  "plan.denied": ["plan denied", (p) => join(str(p.plan), str(p.reason))],
  "plan.replan_requested": ["re-plan requested", (p) => join(str(p.plan), str(p.note))],
  "step.started": ["step started", (p) => str(p.step)],
  "step.finished": ["step finished", (p) => join(str(p.step), str(p.outcome), str(p.note))],
  "step.estimated": ["step priced", (p) => join(str(p.step), p.estimate === null ? "no estimate" : cost(p.estimate))],
  "query.issued": ["query issued", (p, ref) => {
    const source = ref.sources.find((s) => s.id === p.source);
    return `${source?.title ?? str(p.source)} · ${str(p.text)} · why: ${str(p.why)}`;
  }],
  "query.result": ["query result", (p) => {
    const c = loose(p.coverage);
    const coverage = c.kind === "full" ? "full coverage" : c.kind === "partial" ? `partial: ${str(c.reason)}${str(c.detail) === "" ? "" : ` (${str(c.detail)})`}` : "";
    const blob = str(loose(p.result).blob);
    return join(plural(p.rows, "rows"), coverage, blob === "" ? "" : `sha256 ${blob.slice(0, 4)}…`);
  }],
  "query.failed": ["query failed", (p) => join(str(p.query), str(p.error))],
  "verify.run": ["card checked again", (p) => join(str(p.card), str(p.outcome), str(p.detail))],
  "route.finished": ["route finished", (p) => join(str(p.job), str(p.outcome), Array.isArray(p.reached) ? plural(p.reached.length, "values") : "")],
  "model.request": ["model asked", (p) => join(str(p.provider), str(p.model))],
  "model.response": ["model answered", (p) => join(str(p.request), str(p.stop))],
  "model.declined": ["model declined", (p) => join(str(p.request), str(p.reason))],
  "model.blocked": ["model blocked", (p) => join(str(p.stage), str(p.model), str(p.marking))],
  "tool.called": ["tool called", (p) => join(str(p.tool), str(p.why))],
  "tool.returned": ["tool returned", (p) => join(str(p.call), str(p.summary))],
  "tool.skipped": ["tool calls skipped", (p) => join(plural(p.count, "calls"), str(p.note))],
  "card.created": ["card created", (p) => { const c = loose(p.card); return `${str(c.id)} "${str(c.title)}"`; }],
  "card.kept": ["card kept", (p) => join(str(p.card), str(p.lane))],
  "card.moved": ["card moved", (p) => join(str(p.card), str(p.lane))],
  "card.discarded": ["card discarded", (p) => str(p.card)],
  "card.restored": ["card restored", (p) => str(p.card)],
  "card.sent_back": ["card sent back to Incoming", (p) => str(p.card)],
  "card.pinned": ["card pin changed", (p) => join(str(p.card), p.pinned === true ? "pinned" : "unpinned")],
  "lane.created": ["lane added", (p) => join(str(p.lane), str(p.title))],
  "lane.renamed": ["lane renamed", (p) => join(str(p.lane), str(p.title))],
  "lane.removed": ["lane removed", (p) => str(p.lane)],
  "lane.target_set": ["keep target set", (p) => str(p.lane)],
  "undo": ["action undone", (p) => join(str(p.card), typeof p.target === "number" ? `entry ${p.target}` : "")],
  "proposal.created": ["proposal made", (p) => { const x = loose(p.proposal); return join(str(x.id), str(x.title)); }],
  "proposal.accepted": ["proposal accepted", (p) => join(str(p.proposal), typeof p.budget === "number" ? `budget ${p.budget}` : "")],
  "proposal.rejected": ["proposal rejected", (p) => join(str(p.proposal), str(p.reason))],
  "proposal.repriced": ["proposal repriced", (p) => {
    const e = loose(p.estimate);
    return join(str(p.proposal), typeof e.amount === "number" && typeof e.unit === "string" ? `${e.amount} ${e.unit}` : "", typeof p.budget === "number" ? `budget ${p.budget} not enough` : "");
  }],
  "assessment.made": ["assessment made", (p) => { const f = loose(p.finding); return join(str(f.id), str(f.statement)); }],
  "research.requested": ["more research asked for", (p) => join(str(p.question), str(p.why))],
  "draft.revised": ["draft revised", (p) => { const d = loose(p.draft); return join(typeof d.n === "number" ? `draft ${d.n}` : "", str(d.reason)); }],
  "check.run": ["check run", (p) => join(str(p.check), p.pass === true ? "passed" : p.pass === false ? "failed" : "")],
  "evaluation.made": ["evaluation made", (p) => (p.pass === true ? "passed" : p.pass === false ? "failed" : "")],
  "challenge.raised": ["challenge raised", (p) => { const c = loose(p.challenge); return join(str(c.id), str(c.severity), str(c.text)); }],
  "challenge.answered": ["challenge answered", (p) => join(str(p.challenge), str(p.action), str(p.answer))],
  "publish.rejected": ["publishing rejected", (p) => str(p.reason)],
  "product.published": ["product published", (p) => join(typeof p.n === "number" ? `product ${p.n}` : "", str(p.dir))],
  "feedback.recorded": ["feedback recorded", (p) => join(str(p.measure), str(p.value), str(p.note))],
  "agent.asked": ["question asked", (p) => str(p.text)],
  "agent.answered": ["question answered", (p) => str(p.text)],
  "agent.ended": ["question not answered", (p) => str(p.reason)],
  "module.loaded": ["module loaded", (p) => join(str(p.kind), str(p.id))],
  "module.rejected": ["module rejected", (p) => join(str(p.path), str(p.error))],
  "setting.changed": ["setting changed", (p) => str(p.key)],
  "case.anchored": ["case anchored", (p) => join(str(p.why), typeof p.seq === "number" ? `entry ${p.seq}` : "")],
};

/** One short plain sentence for an entry, and its particulars. Everything from the entry is text, and nothing here throws for an odd payload. */
export function describe(entry: Entry, ref: Reference): { what: string; detail: string } {
  const row = Object.hasOwn(TABLE, entry.type) ? TABLE[entry.type] : null;
  if (row === null) return { what: "unknown entry", detail: String(entry.type) };
  return { what: row[0], detail: row[1](loose(entry.payload), ref) };
}
