import type { PlaybookRunState } from "../core/state/types";
import type { EmptyMeans } from "../core/types";
import type { Reference } from "../core/wire";

export type Verdict = "known" | "not known: proven" | "not seen" | "could not tell";
type Refs = Pick<Reference, "pivots" | "inventories">;
/** The run's cards as the record holds them: what each empty answer proves was decided by the runner when it was asked. */
type Cards = Readonly<Record<string, { empty: EmptyMeans | null }>>;
type Read = { kind: "in" } | { kind: "empty"; proven: boolean } | { kind: "unknown"; outcome: string };

const WORDS: Record<string, string> = { needs_budget: "waiting for a budget" };

/**
 * What one step of a run says about the value, from the record alone: it was listed, every lookup came back empty (proven only when every
 * empty lookup's card was recorded a proven negative), or nothing can be said.
 */
function read(step: PlaybookRunState["steps"][string], cards: Cards): Read {
  if (step.status === "skipped") return { kind: "unknown", outcome: "skipped" };
  if (step.lookups.length === 0) return { kind: "unknown", outcome: "not run" };
  if (step.lookups.some((l) => l.outcome === "answered")) return { kind: "in" };
  const other = step.lookups.find((l) => l.outcome !== "empty");
  if (other !== undefined) return { kind: "unknown", outcome: WORDS[other.outcome] ?? other.outcome };
  const proven = step.lookups.every((l) => l.card !== null && Object.hasOwn(cards, l.card) && cards[l.card]!.empty === "proven-negative");
  return { kind: "empty", proven };
}

interface Step { inventory: string; title: string; scope: string | null; read: Read }

/**
 * One entry per step of a does-it-belong run. What each lookup proves is the record's; the reference gives only the inventory's title and
 * scope words. A step whose inventory the reference no longer names keeps its pivot's id as its title and no scope.
 */
function stepsOf(run: PlaybookRunState, ref: Refs, cards: Cards): Step[] {
  const out: Step[] = [];
  for (const id of run.order) {
    const step = Object.hasOwn(run.steps, id) ? run.steps[id]! : null;
    if (step === null) continue;
    const pivot = ref.pivots.find((x) => x.id === step.pivot);
    const inv = pivot?.inventory == null ? undefined : ref.inventories.find((x) => x.id === pivot.inventory);
    out.push(inv === undefined
      ? { inventory: step.pivot, title: step.pivot, scope: null, read: read(step, cards) }
      : { inventory: inv.id, title: inv.title, scope: inv.scope, read: read(step, cards) });
  }
  return out;
}

export function belongsLines(run: PlaybookRunState, ref: Refs, cards: Cards): { inventory: string; title: string; line: string }[] {
  return stepsOf(run, ref, cards).map((s) => {
    const { title } = s;
    const line = s.read.kind === "in" ? `In ${title}`
      : s.read.kind === "empty"
        ? (s.scope === null ? `${title}: could not tell (its inventory is no longer loaded)`
          : s.read.proven ? `Not in ${title} · proven: it is complete for ${s.scope}` : `Not in ${title} · not proof: it is not declared complete`)
        : `${title}: could not tell (${s.read.outcome})`;
    return { inventory: s.inventory, title, line };
  });
}

export function belongsVerdict(run: PlaybookRunState, ref: Refs, cards: Cards): { verdict: Verdict; text: string } {
  const steps = stepsOf(run, ref, cards);
  if (steps.some((s) => s.read.kind === "in")) return { verdict: "known", text: "Known asset" };
  const proof = steps.find((s) => s.scope !== null && s.read.kind === "empty" && s.read.proven);
  if (proof !== undefined) return { verdict: "not known: proven", text: `Not a known asset: proven for ${proof.scope!}` };
  const unnamed = (s: Step): boolean => s.scope === null && s.read.kind === "empty";
  if (run.status === "interrupted" || steps.some((s) => s.read.kind === "unknown" || unnamed(s))) return { verdict: "could not tell", text: "Could not tell" };
  return { verdict: "not seen", text: "Not seen in any inventory; none is complete, so this proves nothing" };
}
