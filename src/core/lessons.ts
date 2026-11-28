// The shared lessons (slice 13): what a lesson is, the fold of the memory store's ledger, and the lock a run holds. Server-side core: it hashes,
// so neither src/web nor src/core/state imports it. The store's ledger is written only through MemoryStore (memstore.ts); a case fold ignores
// these entries, and this fold ignores every other type.
import { canonical, isPlainObject } from "./canonical";
import type { Json } from "./canonical";
import { sha256Hex } from "./hash";
import { CASE_TYPE_ID, LESSON_ID } from "./state/memory";
import { isStr, isStrList, isStrOrNull } from "./state/guards";
import { isCount } from "./state/shapes";
import { MARKINGS, isMarking } from "./types";
import type { Actor, Entry, LessonOrigin, Marking, Payloads, Trigger } from "./types";

export const LESSON_TITLE_MAX = 120;
export const LESSON_TEXT_MAX = 1200;
export const MAX_TRIGGERS = 8;
export const FINDING_MIN = 3;
export const FINDING_MAX = 200;
/** The most a reason for a rejection or a retirement may hold. */
export const REASON_MAX = 500;

export interface LessonDraft { case_type: string; title: string; text: string; triggers: Trigger[]; marking: Marking; supersedes: string | null }

export const lessonHash = (d: LessonDraft): string =>
  sha256Hex(canonical({ case_type: d.case_type, title: d.title, text: d.text, triggers: d.triggers, marking: d.marking, supersedes: d.supersedes } as unknown as Json));

const TRIGGER_KEYS = ["observable", "source", "finding"] as const;
/** A line break or a control character: a title holding one could start a line of its own where it is shown to a model. */
const BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const HASH = /^[0-9a-f]{64}$/;
const isHash = (x: unknown): x is string => isStr(x) && HASH.test(x);
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const rank = (m: Marking): number => MARKINGS.indexOf(m);

/** Exactly one of the three keys, a non-empty string; a finding of 3 to 200 characters. */
export function isTrigger(x: unknown): x is Trigger {
  if (!isPlainObject(x)) return false;
  const keys = Object.keys(x);
  if (keys.length !== 1 || !(TRIGGER_KEYS as readonly string[]).includes(keys[0]!)) return false;
  const v = x[keys[0]!];
  if (!isStr(v) || v === "") return false;
  return keys[0] !== "finding" || (v.length >= FINDING_MIN && v.length <= FINDING_MAX);
}

/** "observable address is present" · "source wifi was used" · "a finding mentions "unknown device"". */
export function triggerWords(t: Trigger): string {
  if ("observable" in t) return `observable ${t.observable} is present`;
  if ("source" in t) return `source ${t.source} was used`;
  return `a finding mentions "${t.finding}"`;
}

/** A fresh copy of a trigger, so state never shares an object with an entry. */
const copyTrigger = (t: Trigger): Trigger =>
  "observable" in t ? { observable: t.observable } : "source" in t ? { source: t.source } : { finding: t.finding };

/** Why a draft is not a lesson (the first reason), or null. */
export function draftProblem(d: unknown): string | null {
  if (!isPlainObject(d)) return "a lesson is a mapping";
  if (!isStr(d.case_type) || !CASE_TYPE_ID.test(d.case_type)) return "a lesson names a case type";
  if (!isStr(d.title) || d.title.trim() === "" || d.title.length > LESSON_TITLE_MAX) return `a lesson needs a title of 1 to ${LESSON_TITLE_MAX} characters`;
  if (BREAKS.test(d.title)) return "a lesson's title is one line, with no control characters";
  if (!isStr(d.text) || d.text.trim() === "" || d.text.length > LESSON_TEXT_MAX) return `a lesson needs text of 1 to ${LESSON_TEXT_MAX} characters`;
  if (!isMarking(d.marking)) return "unknown marking";
  const TRIGGER = `a trigger is { observable: <type> }, { source: <id> } or { finding: <${FINDING_MIN} to ${FINDING_MAX} characters> }`;
  if (!Array.isArray(d.triggers)) return TRIGGER;
  if (d.triggers.length > MAX_TRIGGERS) return `a lesson has at most ${MAX_TRIGGERS} triggers`;
  if (!d.triggers.every(isTrigger)) return TRIGGER;
  const seen = new Set(d.triggers.map((t) => canonical(t as unknown as Json)));
  if (seen.size !== d.triggers.length) return "a trigger is given once";
  if (!(d.supersedes === null || (isStr(d.supersedes) && LESSON_ID.test(d.supersedes)))) return "supersedes names a lesson or is empty";
  return null;
}

/** A well-formed LessonOrigin of one of the three kinds. */
export function isLessonOrigin(x: unknown): x is LessonOrigin {
  if (!isPlainObject(x)) return false;
  switch (x.kind) {
    case "person":
      return true;
    case "seed":
      return isStr(x.manifest) && x.manifest !== "" && isStr(x.item) && x.item !== "" && isHash(x.hash);
    case "case": {
      const head = x.head;
      const product = x.product;
      return isStr(x.case) && x.case !== "" && isStr(x.origin) && isStrOrNull(x.run) && isStrOrNull(x.stage) && typeof x.model === "boolean"
        && isPlainObject(head) && isCount(head.seq) && isStr(head.hash)
        && (product === null || (isPlainObject(product) && isCount(product.n) && isStr(product.draft_hash)));
    }
    default:
      return false;
  }
}

/** A fresh copy holding only the fields of its kind. */
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

export type LessonStatus = "proposed" | "accepted" | "rejected" | "retired" | "superseded";
export interface LessonState extends LessonDraft {
  id: string; hash: string; status: LessonStatus; from: LessonOrigin; proposed_marking: Marking;
  proposed: { by: Actor; seq: number; ts: string };
  decided: { by: string; seq: number; ts: string; reason: string | null } | null;
  superseded_by: string | null;
  /** The seq of every entry of the store about this lesson, in order: its history. */
  history: number[];
}
export interface StoreState { seq: number; lessons: Record<string, LessonState>; order: string[]; count: number; skipped: { seq: number; type: string; reason: string }[] }

export function initialStore(): StoreState {
  return { seq: 0, lessons: {}, order: [], count: 0, skipped: [] };
}

/** How many skipped entries the state remembers (the most recent), as a case's state does. */
const SKIP_LIMIT = 100;

const skip = (s: StoreState, e: Entry, reason: string): StoreState =>
  ({ ...s, skipped: [...s.skipped, { seq: e.seq, type: String(e.type), reason }].slice(-SKIP_LIMIT) });
const malformed = (s: StoreState, e: Entry): StoreState => skip(s, e, `malformed ${String(e.type)}`);
const lessonOf = (s: StoreState, id: unknown): LessonState | null => (isStr(id) && Object.hasOwn(s.lessons, id) ? s.lessons[id]! : null);
const withLessons = (s: StoreState, ...ls: LessonState[]): StoreState => {
  const lessons = { ...s.lessons };
  for (const l of ls) lessons[l.id] = l;
  return { ...s, lessons };
};
const isReasoned = (x: unknown): x is { lesson: string; reason: string } =>
  isPlainObject(x) && isStr(x.lesson) && isStr(x.reason) && x.reason.trim() !== "" && x.reason.length <= REASON_MAX;

/** The skip sentence, or null, for a lesson.proposed that is well formed. */
function proposedProblem(s: StoreState, actor: Actor, p: Payloads["lesson.proposed"]): string | null {
  if (actor.kind === "agent") return "a lesson is filed by the workbench or a person, never by a model";
  if (p.lesson !== `LESSON-${s.count + 1}`) return "a lesson's id is the next number";
  if (p.supersedes !== null && lessonOf(s, p.supersedes)?.status !== "accepted") return "a lesson supersedes one that is shared";
  if (p.supersedes !== null && lessonOf(s, p.supersedes)?.case_type !== p.case_type) return "a lesson supersedes one of its own case type";
  if ((p.from.kind === "person" && actor.kind !== "human") || (p.from.kind === "seed" && actor.kind !== "system")) return "a lesson's origin is recorded by who filed it";
  return null;
}

/** One entry of the store's ledger. Never throws and never changes `s` or `e`. */
export function applyLesson(s: StoreState, e: Entry): StoreState {
  const at: StoreState = { ...s, seq: e.seq };
  const actor = e.actor as unknown;
  const p = e.payload as unknown;
  switch (e.type) {
    case "lesson.proposed": {
      if (!isPlainObject(actor) || !isPlainObject(p) || draftProblem(p) !== null || !isStr(p.lesson) || !isHash(p.hash) || !isLessonOrigin(p.from)) return malformed(at, e);
      const q = p as unknown as Payloads["lesson.proposed"];
      const why = proposedProblem(at, e.actor, q);
      if (why !== null) return skip(at, e, why);
      const lesson: LessonState = {
        id: q.lesson, case_type: q.case_type, title: q.title, text: q.text, triggers: q.triggers.map(copyTrigger), marking: q.marking, supersedes: q.supersedes,
        hash: q.hash, status: "proposed", from: copyOrigin(q.from), proposed_marking: q.marking,
        proposed: { by: { ...e.actor } as Actor, seq: e.seq, ts: e.ts }, decided: null, superseded_by: null, history: [e.seq],
      };
      return { ...withLessons(at, lesson), order: [...at.order, q.lesson], count: at.count + 1 };
    }
    case "lesson.accepted": {
      if (!isPlainObject(actor) || !isPlainObject(p) || !isStr(p.lesson) || !isStr(p.hash) || !isMarking(p.marking)) return malformed(at, e);
      if (e.actor.kind !== "human") return skip(at, e, "only a person accepts a lesson");
      const l = lessonOf(at, p.lesson);
      if (l === null || l.status !== "proposed") return skip(at, e, "a lesson is accepted once, while it is proposed");
      if (p.hash !== l.hash) return skip(at, e, "the lesson accepted is the one proposed");
      if (rank(p.marking) < rank(l.proposed_marking)) return skip(at, e, "a lesson's marking is raised, never lowered");
      const now: LessonState = {
        ...l, status: "accepted", marking: p.marking, decided: { by: e.actor.id, seq: e.seq, ts: e.ts, reason: null }, history: [...l.history, e.seq],
      };
      const old = lessonOf(at, l.supersedes);
      if (old === null || old.status !== "accepted") return withLessons(at, now);
      return withLessons(at, now, { ...old, status: "superseded", superseded_by: l.id, history: [...old.history, e.seq] });
    }
    case "lesson.rejected":
    case "lesson.retired": {
      if (!isPlainObject(actor) || !isReasoned(p)) return malformed(at, e);
      const rejecting = e.type === "lesson.rejected";
      if (e.actor.kind !== "human") return skip(at, e, rejecting ? "only a person rejects a lesson" : "only a person retires a lesson");
      const l = lessonOf(at, p.lesson);
      if (l === null || l.status !== (rejecting ? "proposed" : "accepted")) {
        return skip(at, e, rejecting ? "a lesson is rejected while it is proposed" : "a lesson is retired while it is shared");
      }
      return withLessons(at, {
        ...l, status: rejecting ? "rejected" : "retired", decided: { by: e.actor.id, seq: e.seq, ts: e.ts, reason: p.reason }, history: [...l.history, e.seq],
      });
    }
    default:
      return at;
  }
}

/** The store's state after entry `upTo` (every entry when it is not given). */
export function foldLessons(entries: readonly Entry[], upTo?: number): StoreState {
  let s = initialStore();
  for (const e of entries) {
    if (upTo !== undefined && e.seq > upTo) break;
    s = applyLesson(s, e);
  }
  return s;
}

/** The lessons shared now: status accepted, by the seq of their acceptance, newest first, then by id with `<`. */
export function shared(s: Readonly<StoreState>): LessonState[] {
  return Object.values(s.lessons)
    .filter((l) => l.status === "accepted")
    .sort((a, b) => (b.decided?.seq ?? 0) - (a.decided?.seq ?? 0) || lt(a.id, b.id));
}

// ---------- the lock a run holds ----------

export const MEMORY_LOCK_FORMAT = 1;
export interface CaseFacts { type: string | null; marking: Marking; observables: string[]; sources: string[]; findings: string[] }
export interface LockedLesson {
  lesson: string; hash: string; case_type: string; title: string; text: string; marking: Marking; triggers: Trigger[];
  /** Each trigger that matched, in words; ["every <type> case"] for a lesson with none. */
  matched: string[];
  from: LessonOrigin; accepted: { by: string; seq: number; ts: string }; supersedes: string | null;
  /** The stages of the loop it is offered to. */
  stages: string[];
}
export interface LeftOut { lesson: string; why: "marking" | "trigger" | "cap" }
export interface MemoryLock { format: 1; store: { origin: string | null; head: { seq: number; hash: string } }; case_type: string | null; facts: CaseFacts; lessons: LockedLesson[]; left_out: LeftOut[] }

const LEFT_OUT_WHY: readonly string[] = ["marking", "trigger", "cap"];
const isCaseTypeOrNull = (x: unknown): boolean => x === null || (isStr(x) && CASE_TYPE_ID.test(x));
const isHead = (x: unknown): boolean => isPlainObject(x) && isCount(x.seq) && isStr(x.hash);
const isFacts = (x: unknown): boolean =>
  isPlainObject(x) && isCaseTypeOrNull(x.type) && isMarking(x.marking) && isStrList(x.observables) && isStrList(x.sources) && isStrList(x.findings);
const isLocked = (x: unknown): boolean =>
  isPlainObject(x) && isStr(x.lesson) && LESSON_ID.test(x.lesson) && isHash(x.hash) && isStr(x.case_type) && CASE_TYPE_ID.test(x.case_type)
  && isStr(x.title) && isStr(x.text) && isMarking(x.marking) && Array.isArray(x.triggers) && x.triggers.every(isTrigger) && isStrList(x.matched)
  && isLessonOrigin(x.from) && isPlainObject(x.accepted) && isStr(x.accepted.by) && isCount(x.accepted.seq) && isStr(x.accepted.ts)
  && (x.supersedes === null || (isStr(x.supersedes) && LESSON_ID.test(x.supersedes))) && isStrList(x.stages);
const isLeftOut = (x: unknown): boolean => isPlainObject(x) && isStr(x.lesson) && isStr(x.why) && LEFT_OUT_WHY.includes(x.why);

/** The lock a blob holds; null when it is not one. */
export function readMemoryLock(bytes: Uint8Array): MemoryLock | null {
  let x: unknown;
  try {
    x = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!isPlainObject(x) || x.format !== MEMORY_LOCK_FORMAT) return null;
  if (!isPlainObject(x.store) || !isStrOrNull(x.store.origin) || !isHead(x.store.head)) return null;
  if (!isCaseTypeOrNull(x.case_type) || !isFacts(x.facts)) return null;
  if (!Array.isArray(x.lessons) || !x.lessons.every(isLocked)) return null;
  if (!Array.isArray(x.left_out) || !x.left_out.every(isLeftOut)) return null;
  return x as unknown as MemoryLock;
}
