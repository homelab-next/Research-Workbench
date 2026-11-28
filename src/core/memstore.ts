// The shared lessons store (slice 13): a ledger of its own (chain id "memory") at <store>/ledger.sqlite, with an empty blobs/ beside it. Only
// this class writes it. A lesson is shared only by a person: accept, reject and retire refuse any actor that is not { kind: "human" }, and the
// fold (lessons.ts) skips those entries from anyone else. Every refusal writes nothing.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { MIN_SECRET_LENGTH } from "pivot/secrets";
import { BlobStore } from "./blobs";
import { Ledger } from "./ledger";
import { applyLesson, draftProblem, initialStore, isLessonOrigin, lessonHash } from "./lessons";
import type { LessonDraft, LessonState, StoreState } from "./lessons";
import { Refused } from "./refused";
import { MARKINGS, isMarking } from "./types";
import type { Actor, Entry, EntryInput, LessonOrigin, Marking, Trigger } from "./types";

export const MEMORY_CHAIN = "memory";

export class MemoryRefused extends Refused {}

const CLOSED = "the memory store is closed";
const rank = (m: Marking): number => MARKINGS.indexOf(m);
const triggerValue = (t: Trigger): string => ("observable" in t ? t.observable : "source" in t ? t.source : t.finding);

/** True when the two origins name the same filing: the same case, its first entry and run; or the same seed item at the same hash. */
function sameFiling(a: LessonOrigin, b: LessonOrigin): boolean {
  if (a.kind === "case" && b.kind === "case") return a.case === b.case && a.origin === b.origin && a.run === b.run;
  if (a.kind === "seed" && b.kind === "seed") return a.manifest === b.manifest && a.item === b.item && a.hash === b.hash;
  return false;
}

export class MemoryStore {
  readonly dir: string;
  private readonly ledger: Ledger;
  private current: StoreState;
  private closed = false;

  private constructor(dir: string, ledger: Ledger) {
    this.dir = dir;
    this.ledger = ledger;
    this.current = initialStore();
    this.sync();
  }

  /** Opens (making it) the store folder: ledger.sqlite, chain id "memory", and an empty blobs/ beside it. */
  static open(dir: string, opts: { now?: () => string; onError?: (error: unknown, entry?: Entry) => void } = {}): MemoryStore {
    mkdirSync(dir, { recursive: true });
    new BlobStore(join(dir, "blobs"));
    const ledger = Ledger.open(join(dir, "ledger.sqlite"), MEMORY_CHAIN, { ...(opts.now ? { now: opts.now } : {}), ...(opts.onError ? { onError: opts.onError } : {}) });
    return new MemoryStore(dir, ledger);
  }

  get state(): Readonly<StoreState> {
    if (!this.closed) this.sync();
    return this.current;
  }

  get open(): boolean {
    return !this.closed;
  }

  head(): { seq: number; hash: string } {
    return this.ledger.head();
  }

  /** The hash of entry 1; null for an empty store. */
  origin(): string | null {
    return this.ledger.get(1)?.hash ?? null;
  }

  entries(after = 0, limit = -1): Entry[] {
    return this.ledger.read(after, limit);
  }

  /** Files a proposal and returns it with `fresh` true; a proposal from a case or a seed whose hash and origin are already filed is returned with `fresh` false and nothing is written. Throws MemoryRefused. */
  propose(
    draft: LessonDraft, from: LessonOrigin, actor: Actor,
    opts: { secrets?: readonly string[]; case_types?: readonly string[]; observables?: readonly string[] } = {},
  ): { lesson: LessonState; fresh: boolean } {
    const s = this.writable();
    if (actor.kind === "agent") throw new MemoryRefused("a lesson is filed by the workbench or a person, never by a model");
    const problem = draftProblem(draft);
    if (problem !== null) throw new MemoryRefused(problem);
    if (!isLessonOrigin(from)) throw new MemoryRefused("a lesson's origin is a case, a person or a seed");
    if ((from.kind === "person" && actor.kind !== "human") || (from.kind === "seed" && actor.kind !== "system")) {
      throw new MemoryRefused("a lesson's origin is recorded by who filed it");
    }
    const secrets = (opts.secrets ?? []).filter((v) => v.length >= MIN_SECRET_LENGTH);
    const texts = [draft.title, draft.text, ...draft.triggers.map(triggerValue)];
    if (secrets.some((v) => texts.some((t) => t.includes(v)))) throw new MemoryRefused("the lesson holds a secret value");
    if (opts.case_types !== undefined && !opts.case_types.includes(draft.case_type)) throw new MemoryRefused(`there is no case type "${draft.case_type}"`);
    if (opts.observables !== undefined) {
      for (const t of draft.triggers) {
        if ("observable" in t && !opts.observables.includes(t.observable)) throw new MemoryRefused(`"${t.observable}" is not an observable type here`);
      }
    }
    const hash = lessonHash(draft);
    const lessons = s.order.map((id) => s.lessons[id]!);
    const filed = lessons.find((l) => (from.kind === "seed" || l.hash === hash) && sameFiling(l.from, from));
    if (filed !== undefined) return { lesson: filed, fresh: false };
    if (actor.kind === "human") {
      const same = lessons.find((l) => l.hash === hash && (l.status === "proposed" || l.status === "accepted"));
      if (same !== undefined) throw new MemoryRefused(`that lesson is already ${same.id}`);
    }
    const id = `LESSON-${s.count + 1}`;
    if (draft.supersedes !== null) this.mustBeShared(s, id, draft.supersedes);
    const entry = this.write({
      type: "lesson.proposed", actor,
      payload: {
        lesson: id, case_type: draft.case_type, title: draft.title, text: draft.text, triggers: draft.triggers, marking: draft.marking,
        supersedes: draft.supersedes, hash, from,
      },
    });
    return { lesson: this.lessonAfter(entry, id), fresh: true };
  }

  /** `hash` is the proposal the person saw. `marking`, when given, is at least the proposed one. */
  accept(lesson: string, by: { actor: Actor; hash: string; marking?: Marking }): LessonState {
    const s = this.writable();
    if (by.actor.kind !== "human") throw new MemoryRefused("only a person accepts a lesson");
    const l = this.lessonOf(s, lesson);
    if (l.status !== "proposed") throw new MemoryRefused(`${l.id} is ${l.status}; only a proposed lesson is accepted`);
    if (by.hash !== l.hash) throw new MemoryRefused("the proposal changed since you opened it");
    const marking = by.marking ?? l.proposed_marking;
    if (!isMarking(marking)) throw new MemoryRefused("unknown marking");
    if (rank(marking) < rank(l.proposed_marking)) throw new MemoryRefused("a lesson's marking is raised, never lowered");
    if (l.supersedes !== null) this.mustBeShared(s, l.id, l.supersedes);
    const entry = this.write({ type: "lesson.accepted", actor: by.actor, payload: { lesson: l.id, hash: l.hash, marking } });
    return this.lessonAfter(entry, l.id);
  }

  reject(lesson: string, by: { actor: Actor; reason: string }): LessonState {
    const s = this.writable();
    if (by.actor.kind !== "human") throw new MemoryRefused("only a person rejects a lesson");
    if (typeof by.reason !== "string" || by.reason.trim() === "") throw new MemoryRefused("a rejection needs a reason");
    const l = this.lessonOf(s, lesson);
    if (l.status !== "proposed") throw new MemoryRefused(`${l.id} is ${l.status}; only a proposed lesson is rejected`);
    const entry = this.write({ type: "lesson.rejected", actor: by.actor, payload: { lesson: l.id, reason: by.reason } });
    return this.lessonAfter(entry, l.id);
  }

  retire(lesson: string, by: { actor: Actor; reason: string }): LessonState {
    const s = this.writable();
    if (by.actor.kind !== "human") throw new MemoryRefused("only a person retires a lesson");
    if (typeof by.reason !== "string" || by.reason.trim() === "") throw new MemoryRefused("retiring a lesson needs a reason");
    const l = this.lessonOf(s, lesson);
    if (l.status !== "accepted") throw new MemoryRefused(`${l.id} is ${l.status}; only a shared lesson is retired`);
    const entry = this.write({ type: "lesson.retired", actor: by.actor, payload: { lesson: l.id, reason: by.reason } });
    return this.lessonAfter(entry, l.id);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ledger.close();
  }

  /** The state, brought up to the ledger's head, for a write; a closed store refuses. */
  private writable(): StoreState {
    if (this.closed) throw new MemoryRefused(CLOSED);
    this.sync();
    return this.current;
  }

  /** Folds in whatever the ledger holds past the state (another handle on the same folder may have written). */
  private sync(): void {
    for (const e of this.ledger.read(this.current.seq)) this.current = applyLesson(this.current, e);
  }

  private lessonOf(s: StoreState, id: string): LessonState {
    if (typeof id !== "string" || !Object.hasOwn(s.lessons, id)) throw new MemoryRefused(`there is no lesson ${String(id)}`);
    return s.lessons[id]!;
  }

  private mustBeShared(s: StoreState, id: string, other: string): void {
    if (!Object.hasOwn(s.lessons, other)) throw new MemoryRefused(`there is no lesson ${other}`);
    if (s.lessons[other]!.status !== "accepted") throw new MemoryRefused(`${id} supersedes ${other}, which is not shared`);
  }

  private write(input: EntryInput): Entry {
    const entry = this.ledger.append(input);
    this.current = applyLesson(this.current, entry);
    return entry;
  }

  /** The lesson after `entry`; the fold must have taken the entry, as every check above is the fold's. */
  private lessonAfter(entry: Entry, id: string): LessonState {
    const skipped = this.current.skipped.find((k) => k.seq === entry.seq);
    if (skipped !== undefined) throw new Error(`the memory store wrote entry ${entry.seq}, which its fold skipped: ${skipped.reason}`);
    return this.current.lessons[id]!;
  }
}
