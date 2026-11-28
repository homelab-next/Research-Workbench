import { isPlainObject } from "../core/canonical";
import { draftProblem, isTrigger, lessonHash } from "../core/lessons";
import type { LessonDraft, LessonState } from "../core/lessons";
import { MemoryRefused } from "../core/memstore";
import type { MemoryStore } from "../core/memstore";
import type { Actor, Marking, Trigger } from "../core/types";
import type { CaseType } from "./case-types";
import type { Registry } from "./registry";

/** A lesson a `lesson-seeds` manifest of a trusted root lists: its draft, the manifest and item it came from, and the hash of what it says. */
export interface SeedLesson extends LessonDraft { manifest: string; item: string; hash: string }

/** Who files a seed: the workbench, never a person or a model. */
const SEED_ACTOR: Actor = { kind: "system", id: "seed" };
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const copyTrigger = (t: Trigger): Trigger =>
  "observable" in t ? { observable: t.observable } : "source" in t ? { source: t.source } : { finding: t.finding };
const where = (manifest: string, item: string): string => `lesson-seeds "${manifest}": lesson ${item}`;

/** Every lesson of every `lesson-seeds` manifest of a trusted root; one that is not a lesson, or names no loaded case type, is a problem. */
export function loadSeeds(registry: Registry, types: readonly CaseType[]): { seeds: SeedLesson[]; problems: string[] } {
  const known = new Set(types.map((t) => t.id));
  const seeds: SeedLesson[] = [];
  const problems: string[] = [];
  for (const m of registry.all("lesson-seeds").sort((a, b) => lt(a.path, b.path))) {
    const list = m.body.lessons;
    if (!Array.isArray(list)) {
      problems.push(`lesson-seeds "${m.id}": lessons must be a list`);
      continue;
    }
    const items = new Set<string>();
    list.forEach((raw, i) => {
      const x = isPlainObject(raw) ? raw : null;
      if (x === null || typeof x.id !== "string" || x.id === "") {
        problems.push(`${where(m.id, `#${i + 1}`)}: a lesson is a mapping with an id`);
        return;
      }
      const at = where(m.id, x.id);
      const d = { case_type: x.case_type, title: x.title, text: x.text, triggers: x.triggers ?? [], marking: x.marking, supersedes: null };
      const problem = draftProblem(d);
      if (problem !== null) { problems.push(`${at}: ${problem}`); return; }
      if (!known.has(d.case_type as string)) { problems.push(`${at}: there is no case type "${String(d.case_type)}"`); return; }
      if (items.has(x.id)) { problems.push(`${at}: the item is given twice; the first is kept`); return; }
      items.add(x.id);
      const draft: LessonDraft = {
        case_type: d.case_type as string, title: d.title as string, text: d.text as string,
        triggers: (d.triggers as unknown[]).filter(isTrigger).map(copyTrigger), marking: d.marking as Marking, supersedes: null,
      };
      seeds.push({ ...draft, manifest: m.id, item: x.id, hash: lessonHash(draft) });
    });
  }
  return { seeds, problems };
}

/** The newest lesson shared from a seed's item, by its acceptance; null when none is. */
function sharedFrom(lessons: readonly LessonState[], seed: SeedLesson): LessonState | null {
  let best: LessonState | null = null;
  for (const l of lessons) {
    if (l.status !== "accepted" || l.from.kind !== "seed" || l.from.manifest !== seed.manifest || l.from.item !== seed.item) continue;
    if (best === null || (l.decided?.seq ?? 0) > (best.decided?.seq ?? 0)) best = l;
  }
  return best;
}

/**
 * Files each seed not yet filed, by the workbench ({ kind: "system", id: "seed" }); returns the ids it filed. A seed whose item was filed
 * before with another hash is filed again, superseding the lesson shared from that item when one is. Nothing is accepted: a seed is a proposal
 * like any other. A seed the store refuses (one holding a secret value) is not filed; its reason is added to `opts.problems` when given.
 */
export function fileSeeds(store: MemoryStore, seeds: readonly SeedLesson[], opts: { secrets?: readonly string[]; problems?: string[] } = {}): string[] {
  const filed: string[] = [];
  for (const seed of seeds) {
    const state = store.state;
    const lessons = state.order.map((id) => state.lessons[id]!);
    const from = { kind: "seed" as const, manifest: seed.manifest, item: seed.item, hash: seed.hash };
    if (lessons.some((l) => l.from.kind === "seed" && l.from.manifest === from.manifest && l.from.item === from.item && l.from.hash === from.hash)) continue;
    const old = sharedFrom(lessons, seed);
    const draft: LessonDraft = {
      case_type: seed.case_type, title: seed.title, text: seed.text, triggers: seed.triggers, marking: seed.marking, supersedes: old === null ? null : old.id,
    };
    try {
      const r = store.propose(draft, from, SEED_ACTOR, opts.secrets === undefined ? {} : { secrets: opts.secrets });
      if (r.fresh) filed.push(r.lesson.id);
    } catch (err) {
      if (!(err instanceof MemoryRefused)) throw err;
      opts.problems?.push(`${where(seed.manifest, seed.item)}: ${err.message}`);
    }
  }
  return filed;
}
