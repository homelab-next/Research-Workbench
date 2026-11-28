import type { Entry, EntryType } from "../core/types";
import type { Reference } from "../core/wire";

/** A payload read as loosely as the fold reads it: nothing here assumes a field is there. */
type Loose = Record<string, unknown>;
const loose = (x: unknown): Loose => (typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Loose) : {});
const str = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" || typeof x === "boolean" ? String(x) : "");
const cost = (x: unknown): string => { const c = loose(x); return typeof c.amount === "number" ? `${c.amount} ${str(c.unit)}` : ""; };
const join = (...parts: string[]): string => parts.filter((p) => p !== "").join(" · ");
const plural = (n: unknown, word: string): string => (typeof n === "number" ? `${n} ${word}` : "");
/** What an overrule set, read loosely: as the fold's overruleSays says it. */
const overruled = (p: Loose): string => {
  const set = [typeof p.likelihood === "string" ? `likelihood ${p.likelihood}` : "", typeof p.confidence === "string" ? `confidence ${p.confidence}` : ""].filter((x) => x !== "");
  if (set.length > 0) return set.join(", ");
  return p.stays === true ? "must stay" : p.stays === false ? "dropped" : "overrule withdrawn";
};

type Say = (p: Loose, ref: Reference) => string;
const none: Say = () => "";
/** What each entry type is called (by its payload, for a type whose name depends on it), and the particulars worth reading. The table is keyed by EntryType, so a new type that has no row is a type error. */
const TABLE: Record<EntryType, [string | ((p: Loose) => string), Say]> = {
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
  // a step finished on a query answered before ran nothing: the line says so, so no one reads it as a lookup sent to the source
  "step.finished": [(p) => (typeof p.reused === "string" ? "step reused, no query sent" : "step finished"), (p) => join(str(p.step), str(p.outcome), str(p.note))],
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
  "playbook.started": ["playbook started", (p) => join(str(p.job), str(p.title))],
  "playbook.step": [(p) => (p.status === "skipped" ? "playbook step skipped" : "playbook step"), (p) => join(str(p.step), p.status === "skipped" ? str(p.reason) : Array.isArray(p.lookups) ? plural(p.lookups.length, "lookups") : "")],
  "playbook.finished": ["playbook finished", (p) => join(str(p.job), str(p.outcome), typeof p.lookups === "number" && typeof p.reused === "number" ? `${p.lookups} lookups, ${p.reused} reused` : "")],
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
  "review.conflict": ["reviewers disagree", (p) => { const c = loose(p.conflict); return join(str(c.id), str(c.reason)); }],
  "review.ruled": ["conflict ruled on", (p) => join(str(p.conflict), p.follow === null || p.follow === undefined ? "" : `follow ${str(p.follow)}`, str(p.note))],
  "question.asked": ["question put to the person", (p) => { const q = loose(p.question); return join(str(q.id), str(q.text)); }],
  "question.answered": ["question answered", (p) => join(str(p.question), str(p.card))],
  "finding.overruled": ["finding overruled", (p) => join(str(p.finding), overruled(p), str(p.note))],
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
  "case.unloaded": ["case unloaded", (p) => str(p.store)],
  "case.unload_failed": ["unload failed", (p) => str(p.reason)],
  "case.loaded": ["case loaded", (p) => str(p.file)],
  "case.loop_set": ["loop chosen", (p) => str(p.loop)],
  "loop.bound": ["loop version", (p) => (typeof p.version === "number" ? `${str(p.loop)} v${p.version}` : str(p.loop))],
  "subloop.child": ["child of", (p) => join(str(p.parent), str(p.stage))],
  "subloop.started": ["sub-loop started", (p) => (str(p.child) === "" ? str(p.loop) : `${str(p.loop)} as ${str(p.child)}`)],
  "subloop.finished": ["sub-loop finished", (p) => join(str(p.child), str(p.outcome))],
  "loop.recorded": ["loop recorded", (p) => (typeof p.version === "number" ? `${str(p.loop)} v${p.version}` : str(p.loop))],
  "loop.output": ["loop output recorded", (p) => join(str(p.loop), str(p.output), str(p.case))],
  "manifest.written": ["manifest written", (p) => join(str(p.kind), str(p.id), str(p.path))],
  "builder.proposed": ["change proposed", (p) => join(str(p.change), str(p.title), Array.isArray(p.files) ? plural(p.files.length, "files") : "")],
  "builder.decided": [
    (p) => (p.accepted === true ? "file of a change accepted" : p.accepted === false ? "file of a change rejected" : "decision on a change"),
    (p) => join(str(p.change), typeof p.file === "number" ? `file ${p.file + 1}` : ""),
  ],
  "builder.probe_asked": ["probe asked for", (p) => {
    const why = str(p.why);
    return join(str(p.probe), str(p.source), str(p.pivot), str(loose(p.value).value), str(p.text), why === "" ? "" : `why: ${why}`);
  }],
  "builder.probe_decided": [
    (p) => (p.approved === true ? "probe approved" : p.approved === false ? "probe rejected" : "probe decided"),
    (p) => join(str(p.probe), str(p.outcome), str(p.detail)),
  ],
  "case.type_set": ["case type set", (p) => (p.type === null ? "no type" : str(p.type))],
  "case.type_proposed": ["case type proposed", (p) => join(str(p.type), str(p.why))],
  "memory.noted": ["note added", (p) => join(str(p.item), str(p.kind), str(p.text))],
  "memory.revised": ["note revised", (p) => join(str(p.item), str(p.kind), str(p.text))],
  "memory.dropped": ["note dropped", (p) => join(str(p.item), str(p.reason))],
  "memory.bound": ["memory bound", (p) => join(str(p.case_type), Array.isArray(p.lessons) ? plural(p.lessons.length, "lessons") : "")],
  "lesson.proposed": ["lesson proposed", (p) => join(str(p.lesson), str(p.case_type), str(p.title))],
  "lesson.accepted": ["lesson accepted", (p) => join(str(p.lesson), str(p.marking))],
  "lesson.rejected": ["lesson rejected", (p) => join(str(p.lesson), str(p.reason))],
  "lesson.retired": ["lesson retired", (p) => join(str(p.lesson), str(p.reason))],
  "memory.exported": ["memory exported", (p) => join(str(p.file), plural(p.lessons, "lessons"))],
  "memory.loaded": ["memory loaded", (p) => str(p.file)],
  "answer.known": ["known answer set", (p) => join(
    typeof p.product === "number" ? `product ${p.product}` : "", Array.isArray(p.findings) ? plural(p.findings.length, p.findings.length === 1 ? "expected finding" : "expected findings") : "",
  )],
  "answer.withdrawn": ["known answer withdrawn", (p) => join(typeof p.product === "number" ? `product ${p.product}` : "", str(p.reason))],
  "improve.requested": ["improve asked", (p) => join(str(p.target), str(p.case_type), plural(p.tasks, "tasks"), plural(p.candidates, "candidates"))],
  "improve.selected": ["tasks selected", (p) => join(
    typeof p.version === "number" ? `${str(p.target)} v${p.version}` : str(p.target), Array.isArray(p.left_out) && p.left_out.length > 0 ? `${p.left_out.length} left out` : "",
  )],
  "improve.task": ["task", (p) => { const n = loose(p.product).n; return join(str(p.task), str(p.case), typeof n === "number" ? `product ${n}` : ""); }],
  "improve.candidate": [
    (p) => (p.status === "staged" ? "candidate staged" : p.status === "dropped" ? "candidate dropped" : "candidate"),
    (p) => join(str(p.candidate), str(p.change), str(p.reason)),
  ],
  "probe.child": ["probe child", (p) => join(str(p.probe), str(p.improve) === "" ? "" : `of ${str(p.improve)}`)],
  "probe.started": ["probe started", (p) => join(str(p.probe), str(p.child))],
  "probe.finished": ["probe ended", (p) => join(str(p.probe), str(p.outcome), str(p.reason))],
  "compose.chosen": [(p) => (p.candidate === null ? "no candidate chosen" : "candidate chosen"), (p) => join(str(p.candidate), str(p.why))],
  // the scores are the whole candidate's, each from 0 to 1000
  "judge.scored": ["scored", (p) => (Array.isArray(p.summary) ? p.summary.map(loose).filter((r) => typeof r.score === "number").map((r) => `${str(r.candidate)} ${str(r.score)}`).join(", ") : "")],
};

/** One short plain sentence for an entry, and its particulars. Everything from the entry is text, and nothing here throws for an odd payload. */
export function describe(entry: Entry, ref: Reference): { what: string; detail: string } {
  const row = Object.hasOwn(TABLE, entry.type) ? TABLE[entry.type] : null;
  if (row === null) return { what: "unknown entry", detail: String(entry.type) };
  const p = loose(entry.payload);
  return { what: typeof row[0] === "string" ? row[0] : row[0](p), detail: row[1](p, ref) };
}
