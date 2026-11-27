import type { CaseSession } from "../core/session";
import { activeOverrules, latestDraft, overruleReason, overruleText, runConflicts, rulingText } from "../core/state";
import type { CaseState } from "../core/state";
import type { CheckFinding, Entry, Finding, Product } from "../core/types";
import { packPart } from "../agents/context";
import type { PackPart } from "../agents/context";
import type { Pipeline, Role } from "./manifests";

/** How one finding moved from one draft to the next. */
export interface FindingChange {
  finding: string;
  change: "likelihood" | "confidence" | "dropped" | "added" | "reworded";
  earlier: string | null;
  now: string | null;
}

/** What changed in the findings from `before` to `after`, by finding id: likelihood, confidence, a finding dropped or added, or only its other fields. */
export function findingChanges(before: Product, after: Product): FindingChange[] {
  const was = new Map(before.key_findings.map((f) => [f.id, f]));
  const is = new Map(after.key_findings.map((f) => [f.id, f]));
  const out: FindingChange[] = [];
  for (const [id, a] of was) {
    const b = is.get(id);
    if (b === undefined) { out.push({ finding: id, change: "dropped", earlier: a.likelihood, now: null }); continue; }
    const moved = changesOf(a, b);
    out.push(...moved);
  }
  for (const [id, b] of is) if (!was.has(id)) out.push({ finding: id, change: "added", earlier: null, now: b.likelihood });
  return out;
}

function changesOf(a: Finding, b: Finding): FindingChange[] {
  const out: FindingChange[] = [];
  if (a.likelihood !== b.likelihood) out.push({ finding: a.id, change: "likelihood", earlier: a.likelihood, now: b.likelihood });
  if (a.confidence !== b.confidence) out.push({ finding: a.id, change: "confidence", earlier: a.confidence, now: b.confidence });
  if (out.length === 0 && JSON.stringify(a) !== JSON.stringify(b)) out.push({ finding: a.id, change: "reworded", earlier: null, now: null });
  return out;
}

/** A change in a few words: "f25 likelihood almost certain → likely", "f2 dropped". */
export function sayChange(c: FindingChange): string {
  switch (c.change) {
    case "likelihood": return `${c.finding} likelihood ${c.earlier} → ${c.now}`;
    case "confidence": return `${c.finding} confidence ${c.earlier} → ${c.now}`;
    case "dropped": return `${c.finding} dropped`;
    case "added": return `${c.finding} added`;
    case "reworded": return `${c.finding} reworded`;
  }
}

/** The id of the pipeline's stage with this role, and its title as the run knows it; null when the pipeline has none. */
export function reviewer(state: Readonly<CaseState>, pipeline: Pipeline, role: Role): { id: string; title: string } | null {
  const m = pipeline.stages.find((s) => s.role === role);
  if (m === undefined) return null;
  return { id: m.id, title: state.run.stages.find((s) => s.id === m.id)?.title ?? m.title };
}

interface EvalRound { n: number; hash: string; findings: CheckFinding[]; entry: Entry; answered: { n: number; changes: FindingChange[] } | null }

/** The failed evaluations of the current run, in order, each with the draft that answered it (the next revision), if one has. */
function evalRounds(state: Readonly<CaseState>, entries: readonly Entry[]): EvalRound[] {
  const run = state.run.id;
  const rounds: EvalRound[] = [];
  let current: { n: number; hash: string; product: Product } | null = null;
  const products = new Map<string, Product>();
  for (const e of entries) {
    if (e.type === "draft.revised") {
      const d = e.payload.draft;
      for (const r of rounds) {
        if (r.answered === null) r.answered = { n: d.n, changes: findingChanges(products.get(r.hash)!, d.product) };
      }
      current = { n: d.n, hash: d.hash, product: d.product };
      products.set(d.hash, d.product);
    } else if (e.type === "evaluation.made" && e.run === run && run !== null && !e.payload.pass && products.has(e.payload.draft_hash)) {
      const n = current !== null && current.hash === e.payload.draft_hash ? current.n : state.drafts.findLast((d) => d.hash === e.payload.draft_hash)?.n ?? 0;
      // a later verdict on the same draft replaces the earlier one
      const at = rounds.findIndex((r) => r.hash === e.payload.draft_hash && r.answered === null);
      const round: EvalRound = { n, hash: e.payload.draft_hash, findings: e.payload.findings, entry: e, answered: null };
      if (at >= 0) rounds[at] = round; else rounds.push(round);
    }
  }
  return rounds;
}

const evalLines = (title: string, r: EvalRound, withAnswer: boolean): string[] => r.findings.map((x) => {
  const answer = !withAnswer || r.answered === null ? "" : `. Answered in draft ${r.answered.n}: ${r.answered.changes.length === 0 ? "no finding changed" : r.answered.changes.map(sayChange).join("; ")}`;
  return `- ${title}, on draft ${r.n}, at ${x.where}: ${x.message}${answer}`;
});

const draftN = (state: Readonly<CaseState>, hash: string): string => String(state.drafts.find((d) => d.hash === hash)?.n ?? "?");

/** The challenges of the current run (and any still open against the latest draft), each as a line with its answer when it has one. */
function challengeLines(state: Readonly<CaseState>, title: string, latest: string | null, which: "open" | "answered" | "all"): { lines: string[]; ids: string[] } {
  const run = state.run.id;
  const lines: string[] = [];
  const ids: string[] = [];
  for (const c of Object.values(state.challenges)) {
    const open = c.status === "open" && (c.draft_hash === latest || (run !== null && c.run === run && c.severity === "must_address"));
    const answered = c.status === "answered" && run !== null && c.run === run;
    if (!((which !== "answered" && open) || (which !== "open" && answered))) continue;
    const answer = c.status === "answered" ? `. Answered (${c.action}): ${c.answer}` : "";
    lines.push(`- ${title} ${c.id} (${c.severity}, on draft ${draftN(state, c.draft_hash)}): ${c.text}${answer}`);
    ids.push(c.id);
  }
  return { lines, ids };
}

/** The entries that wrote these challenges and their answers. */
const challengeEntries = (entries: readonly Entry[], ids: string[]): Entry[] => {
  const set = new Set(ids);
  return entries.filter((e) => (e.type === "challenge.raised" && set.has(e.payload.challenge.id)) || (e.type === "challenge.answered" && set.has(e.payload.challenge)));
};

export type PointsView = "assemble" | "evaluate" | "challenge";

/**
 * The review points as one pack part, from the ledger. For Assemble: every open point of Evaluate (the latest draft's failed evaluation) and of
 * Challenge (open challenges), each labelled by reviewer, then the points answered earlier in this run with the analyst's answers. For Evaluate: Challenge's
 * points and the analyst's answers. For Challenge: Evaluate's latest points and the analyst's answer. Text reviewers wrote: as strict as the requests that
 * wrote it, and at least as strict as the latest draft. Null when there is nothing to show. Throws ContextError as packPart does.
 */
export function reviewPointsPart(session: CaseSession, pipeline: Pipeline, view: PointsView): PackPart | null {
  const state = session.state;
  const d = latestDraft(state);
  if (d === null) return null;
  const entries = session.entries();
  const ev = reviewer(state, pipeline, "evaluate");
  const ch = reviewer(state, pipeline, "challenge");
  const rounds = ev === null ? [] : evalRounds(state, entries);
  const by: Entry[] = [];
  const sections: string[] = [];
  let title: string;
  let id: string;
  if (view === "assemble") {
    title = "Open review points, by reviewer";
    id = "review-points";
    const open: string[] = [];
    const earlier: string[] = [];
    const review = Object.hasOwn(state.reviews, d.hash) ? state.reviews[d.hash]! : null;
    if (ev !== null && review !== null && review.evaluation !== null && !review.evaluation.pass) {
      const made = entries.findLast((e) => e.type === "evaluation.made" && e.payload.draft_hash === d.hash);
      if (made !== undefined) by.push(made);
      open.push(...evalLines(ev.title, { n: d.n, hash: d.hash, findings: review.evaluation.findings, entry: made!, answered: null }, false));
    }
    if (ch !== null) {
      const o = challengeLines(state, ch.title, d.hash, "open");
      open.push(...o.lines);
      const a = challengeLines(state, ch.title, d.hash, "answered");
      earlier.push(...a.lines);
      by.push(...challengeEntries(entries, [...o.ids, ...a.ids]));
    }
    if (ev !== null) {
      for (const r of rounds) {
        if (r.hash === d.hash || r.answered === null) continue;
        earlier.push(...evalLines(ev.title, r, true));
        by.push(r.entry);
      }
    }
    // why this pass exists: the send-back's reason carries what code adds to the reviewer's point (a ruling the draft does not hold, a card
    // that cannot be cited); it labelled the draft but never reached the model (dev CASE-3)
    const asm = pipeline.stages.find((s) => s.role === "assemble");
    if (asm !== undefined) {
      const lastFinished = entries.reduce((n, e) => (e.type === "stage.finished" && e.payload.stage === asm.id && e.payload.outcome !== "declined" ? e.seq : n), 0);
      const back = entries.findLast((e) => e.type === "stage.sent_back" && e.payload.to === asm.id && e.seq > lastFinished);
      if (back !== undefined && back.type === "stage.sent_back") {
        const from = state.run.stages.find((s) => s.id === back.payload.from)?.title ?? back.payload.from;
        sections.push(`Why the work came back to you (from ${from}): ${back.payload.reason}`);
      }
    }
    if (open.length > 0) sections.push(["Open (answer each):", ...open].join("\n"));
    if (earlier.length > 0) sections.push(["Answered earlier in this run:", ...earlier].join("\n"));
  } else if (view === "evaluate") {
    if (ch === null) return null;
    title = `${ch.title}'s points and the analyst's answers`;
    id = "other-review";
    const all = challengeLines(state, ch.title, d.hash, "all");
    if (all.lines.length > 0) sections.push(all.lines.join("\n"));
    by.push(...challengeEntries(entries, all.ids));
  } else {
    if (ev === null) return null;
    title = `${ev.title}'s latest points and the analyst's answers`;
    id = "other-review";
    const last = rounds.at(-1);
    if (last !== undefined) {
      sections.push(evalLines(ev.title, last, true).join("\n"));
      by.push(last.entry);
    }
  }
  // the person's rulings are fixed, for the analyst and for both reviewers
  const rulings = runConflicts(state).filter((c) => c.ruling !== null).map((c) => `- ${c.finding}: ${c.reason}. Ruled: ${rulingText(state, c)}`);
  if (rulings.length > 0) sections.push(["Rulings by the person (fixed; neither reviewer may reopen them):", ...rulings].join("\n"));
  // the person's overrules are fixed too: code holds every draft to them (controller ruling 5: the analyst rewrites the basis and reasoning)
  const overrules = activeOverrules(state);
  if (overrules.length > 0) {
    sections.push(["Overrules by the person (fixed: code holds every draft to them, and neither reviewer may reopen them):", ...overrules.map((o) => `- ${overruleText(o)}`)].join("\n"));
    if (view === "assemble") sections.push(["What the overrules ask of the analyst:", ...overrules.map((o) => `- ${overruleReason(o)}`)].join("\n"));
  }
  if (sections.length === 0) return null;
  return packPart({ kind: "note", id, title, text: sections.join("\n\n"), fixed: true, entries, written_by: by, floor: d.product.marking });
}
