// Which shared lessons a run is given (slice 13): chosen by code over structured fields, never by a model, and locked into the run.
// The case's type, its marking, the observable types, sources and finding statements it holds decide; no text similarity, no embedding.
// The lock holds each selected lesson whole (its text, hash, marking, provenance and the triggers that matched), so a stage and a replay
// read it from the case and never from the store; a lesson left out is named by id and reason only.
import { canonical } from "../core/canonical";
import type { Json } from "../core/canonical";
import { initialStore, MEMORY_LOCK_FORMAT, shared, triggerWords } from "../core/lessons";
import type { CaseFacts, LeftOut, LessonState, LockedLesson, MemoryLock, StoreState } from "../core/lessons";
import type { CaseState } from "../core/state";
import { MARKINGS } from "../core/types";
import type { Actor, EntryInput, LessonOrigin, Marking, Trigger } from "../core/types";
import type { CaseSession } from "../core/session";
import type { CaseType } from "../modules/case-types";
import { tooStrict } from "../agents/pack";
import type { MemoryStore } from "../core/memstore";
import { memoryUses } from "./loops";
import type { LoopCatalog, MemoryUse, ResolvedLoop } from "./loops";
import type { EngineDeps, MemoryHost } from "./engine";

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

/** What an improve run's lock says of why each lesson is in it. */
const IMPROVE_MATCHED = "every lesson of the type: an improve run reads them all";

/**
 * The lock an improve run reads: every shared lesson of the type that is not stricter than the case, newest acceptance first, cut at `max`; a
 * trigger is not asked (an improve case has no observables of its own to meet it). `stages` are those that read shared memory.
 */
export function improveLock(
  store: { state: Readonly<StoreState>; origin: string | null; head: { seq: number; hash: string } }, type: string, marking: Marking, stages: readonly string[], opts: { max: number },
): MemoryLock {
  const at = sortedOnce(stages);
  const lessons: LockedLesson[] = [];
  const left_out: LeftOut[] = [];
  for (const l of shared(store.state)) {
    if (l.case_type !== type || l.decided === null) continue;
    if (tooStrict(l.marking, marking)) left_out.push({ lesson: l.id, why: "marking" });
    else if (lessons.length >= opts.max) left_out.push({ lesson: l.id, why: "cap" });
    else lessons.push({ ...locked(l, l.decided, type, [...at]), matched: [IMPROVE_MATCHED] });
  }
  return {
    format: MEMORY_LOCK_FORMAT,
    store: { origin: store.origin, head: { seq: store.head.seq, hash: store.head.hash } },
    case_type: type,
    facts: { type, marking, observables: [], sources: [], findings: [] },
    lessons,
    left_out: left_out.sort((a, b) => lt(a.lesson, b.lesson)),
  };
}

/** What a run binds when there is no store to read: no origin, an empty head, so no lesson. */
const NO_STORE = { origin: null, head: { seq: 0, hash: "" } } as const;

/** True when the loop's lock reads shared lessons at some stage. */
export const readsShared = (lock: Pick<ResolvedLoop["lock"], "items"> | undefined): boolean => lock !== undefined && memoryUses(lock).some((u) => u.store === "shared");

/**
 * The memory.bound a run of this loop version starts with, its lock put in the case's blobs; null when the loop reads no shared memory. `type`
 * overrides the state's (a type being set in the same commit). With no memory host the lock is empty: no origin, head 0, no lesson.
 */
export function bindEntry(session: CaseSession, state: Readonly<CaseState>, loop: ResolvedLoop, deps: Pick<EngineDeps, "memory" | "config">, actor: Actor, type?: string | null): EntryInput | null {
  const uses = memoryUses(loop.lock);
  if (!uses.some((u) => u.store === "shared")) return null;
  const store = deps.memory?.read() ?? { state: initialStore(), ...NO_STORE };
  const facts = factsOf(state, loop.manifest.uses.sources);
  const lock = buildMemoryLock(store, type === undefined ? facts : { ...facts, type }, uses, { max: deps.config.memory.max_lessons });
  const ref = session.blobs.put(canonical(lock as unknown as Json));
  return {
    type: "memory.bound", actor,
    payload: { lock: ref, store: { origin: lock.store.origin, head: { ...lock.store.head } }, case_type: lock.case_type, lessons: lock.lessons.map((l) => ({ lesson: l.lesson, hash: l.hash })) },
  };
}

/** The case type a loop gives a case that names none; null when the loop has none or is not usable. */
export function loopCaseType(loops: LoopCatalog | undefined, loop: string): string | null {
  return loops?.current(loop)?.manifest.case_type ?? null;
}

// ---- the question Frame puts to the person when the case has no type (controller ruling 3)

/** The `why` of the question Frame puts to the person when the case has no type: what marks it as the case-type question. */
export const CASE_TYPE_WHY = "The stages after Frame are given the shared lessons of the case's type: Plan waits for the type the person confirms.";
/** How many case type ids the question lists before it says how many more there are. */
const LISTED = 12;

/** What a run goes on without when the person resumes it without answering the question of the case's type. */
export const TYPE_GAP = "no case type confirmed; no shared lessons loaded";

/** True for the question of the case's type. */
export const isCaseTypeQuestion = (q: { why: string }): boolean => q.why === CASE_TYPE_WHY;

const idList = (types: readonly CaseType[]): string => {
  const ids = types.map((t) => t.id);
  return ids.length <= LISTED ? ids.join(", ") : `${ids.slice(0, LISTED).join(", ")} and ${ids.length - LISTED} more`;
};

/** The text of the question of the case's type: the type Frame proposes, when it proposes one, and how to answer. */
export function caseTypeQuestion(types: readonly CaseType[], proposed: string | null): string {
  const t = proposed === null ? undefined : types.find((x) => x.id === proposed);
  const ask = t === undefined
    ? `What is this case's type? Answer with a case type's id (${idList(types)}), or none.`
    : `Frame reads this case as ${t.title} (${t.id}). Is that its case type? Answer yes, another case type's id (${idList(types)}), or none.`;
  return `${ask} Plan waits for your answer: it is given the shared lessons of the type you confirm.`;
}

/** The type a person's answer to the question names: an id, yes for Frame's proposal, none for no type; or why it names none. */
export function typeOfAnswer(answer: string, types: readonly CaseType[], proposed: string | null): { type: string | null } | string {
  const a = answer.trim().toLowerCase();
  if (types.some((t) => t.id === a)) return { type: a };
  if (proposed !== null && (a === "yes" || a === "y")) return { type: proposed };
  if (a === "none" || a === "no type") return { type: null };
  return `answer with a case type's id (${idList(types)})${proposed === null ? "" : `, yes for ${proposed}`}, or none`;
}

/** A MemoryHost over a workbench's store, read through `get` each time (a load replaces the store). */
export function storeHost(get: () => MemoryStore, opts: { secrets?: () => readonly string[]; case_types?: () => readonly string[]; observables?: () => readonly string[] } = {}): MemoryHost {
  return {
    read: () => {
      const store = get();
      return { state: store.state, origin: store.origin(), head: store.head() };
    },
    propose: (draft, from) => {
      // a store that cannot be reached now (an export packing it, a load replacing it) is a fault the run pauses on, not a refusal of the lesson
      let store: MemoryStore;
      try {
        store = get();
      } catch (err) {
        throw new Error(`the memory store could not be reached to file a lesson: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
      }
      if (!store.open) throw new Error("the memory store could not be reached to file a lesson: it is closed");
      const r = store.propose(draft, from, { kind: "system", id: "feedback" }, {
        ...(opts.secrets === undefined ? {} : { secrets: opts.secrets() }),
        ...(opts.case_types === undefined ? {} : { case_types: opts.case_types() }),
        ...(opts.observables === undefined ? {} : { observables: opts.observables() }),
      });
      return { lesson: r.lesson.id, fresh: r.fresh };
    },
  };
}
