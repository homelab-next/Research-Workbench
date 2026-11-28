// Which shared lessons a run is given (slice 13): chosen by code over structured fields, never by a model, and locked into the run.
// The case's type, its marking, the observable types, sources and finding statements it holds decide; no text similarity, no embedding.
// The lock holds each selected lesson whole (its text, hash, marking, provenance and the triggers that matched), so a stage and a replay
// read it from the case and never from the store; a lesson left out is named by id and reason only.
import { MEMORY_LOCK_FORMAT, shared, triggerWords } from "../core/lessons";
import type { CaseFacts, LeftOut, LessonState, LockedLesson, MemoryLock, StoreState } from "../core/lessons";
import type { CaseState } from "../core/state";
import { MARKINGS } from "../core/types";
import type { LessonOrigin, Marking, Trigger } from "../core/types";
import { tooStrict } from "../agents/pack";
import type { MemoryUse } from "./loops";

const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedOnce = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(lt);

/** A case with no case.created has no marking to compare with: the least that may be shown, so only what anyone may see is selected. */
const NO_MARKING: Marking = MARKINGS[0]!;

/** What selection reads of a case: from its state alone, and the sources its loop says it uses. */
export function factsOf(state: Readonly<CaseState>, loopSources: readonly string[]): CaseFacts {
  const observables: string[] = (state.meta?.starting ?? []).map((o) => o.type);
  for (const c of Object.values(state.cards)) {
    if (c.place === "discarded") continue;
    for (const x of c.extracted ?? []) observables.push(x.type);
    for (const o of c.person?.about ?? []) observables.push(o.type);
  }
  const latest = state.drafts.length === 0 ? null : state.drafts[state.drafts.length - 1]!;
  return {
    type: state.memory.type,
    marking: state.meta?.marking ?? NO_MARKING,
    observables: sortedOnce(observables),
    sources: sortedOnce([...Object.values(state.queries).map((q) => q.source), ...loopSources]),
    findings: latest === null ? [] : latest.product.key_findings.map((f) => f.statement),
  };
}

/** Whether one trigger holds for the case: an observable by type, a source by id, a finding's words in some statement (lower case, as text). */
export function matches(t: Trigger, facts: CaseFacts): boolean {
  if ("observable" in t) return facts.observables.includes(t.observable);
  if ("source" in t) return facts.sources.includes(t.source);
  const words = t.finding.toLowerCase();
  return facts.findings.some((s) => s.toLowerCase().includes(words));
}

const copyTrigger = (t: Trigger): Trigger =>
  "observable" in t ? { observable: t.observable } : "source" in t ? { source: t.source } : { finding: t.finding };

function copyOrigin(o: LessonOrigin): LessonOrigin {
  switch (o.kind) {
    case "person":
      return { kind: "person" };
    case "seed":
      return { kind: "seed", manifest: o.manifest, item: o.item, hash: o.hash };
    case "case":
      return {
        kind: "case", case: o.case, origin: o.origin, run: o.run, head: { seq: o.head.seq, hash: o.head.hash },
        product: o.product === null ? null : { n: o.product.n, draft_hash: o.product.draft_hash }, stage: o.stage, model: o.model,
      };
  }
}

/** A shared lesson as the lock holds it: whole, with the hash the person accepted, so a replay reads exactly what was given. */
function locked(l: LessonState, decided: NonNullable<LessonState["decided"]>, type: string, stages: string[]): LockedLesson {
  return {
    lesson: l.id, hash: l.hash, case_type: l.case_type, title: l.title, text: l.text, marking: l.marking,
    triggers: l.triggers.map(copyTrigger),
    matched: l.triggers.length === 0 ? [`every ${type} case`] : l.triggers.map(triggerWords),
    from: copyOrigin(l.from), accepted: { by: decided.by, seq: decided.seq, ts: decided.ts }, supersedes: l.supersedes, stages,
  };
}

/**
 * The accepted lessons of the case's type that a shared use takes, whose marking is not stricter than the case's and whose every trigger
 * holds: newest acceptance first, then id, cut at `max`. Each lesson a use takes and that was not kept is in `left_out`, by id and its first
 * reason (marking, trigger, cap), sorted by id; a lesson of another type, or one no use takes, is not listed.
 */
export function selectLessons(store: Readonly<StoreState>, facts: CaseFacts, uses: readonly MemoryUse[], opts: { max: number }): { lessons: LockedLesson[]; left_out: LeftOut[] } {
  const type = facts.type;
  if (type === null) return { lessons: [], left_out: [] };
  const stages = sortedOnce(uses.filter((u) => u.store === "shared" && (u.selector === "*" || u.selector === type)).map((u) => u.stage));
  if (stages.length === 0) return { lessons: [], left_out: [] };
  const lessons: LockedLesson[] = [];
  const left_out: LeftOut[] = [];
  // shared() is status accepted only (never proposed, rejected, retired or superseded), newest acceptance first, then id
  for (const l of shared(store)) {
    if (l.case_type !== type || l.decided === null) continue;
    if (tooStrict(l.marking, facts.marking)) left_out.push({ lesson: l.id, why: "marking" });
    else if (!l.triggers.every((t) => matches(t, facts))) left_out.push({ lesson: l.id, why: "trigger" });
    else if (lessons.length >= opts.max) left_out.push({ lesson: l.id, why: "cap" });
    else lessons.push(locked(l, l.decided, type, [...stages]));
  }
  return { lessons, left_out: left_out.sort((a, b) => lt(a.lesson, b.lesson)) };
}

/** The lock a run holds: the store's origin and head, the facts selection read, the lessons it kept and those it left out. */
export function buildMemoryLock(
  store: { state: Readonly<StoreState>; origin: string | null; head: { seq: number; hash: string } }, facts: CaseFacts, uses: readonly MemoryUse[], opts: { max: number },
): MemoryLock {
  const { lessons, left_out } = selectLessons(store.state, facts, uses, opts);
  return {
    format: MEMORY_LOCK_FORMAT,
    store: { origin: store.origin, head: { seq: store.head.seq, hash: store.head.hash } },
    case_type: facts.type,
    facts: { type: facts.type, marking: facts.marking, observables: [...facts.observables], sources: [...facts.sources], findings: [...facts.findings] },
    lessons,
    left_out,
  };
}
