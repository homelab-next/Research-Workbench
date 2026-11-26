import type { PlaybookRunState } from "../core/state/types";
import type { Reference } from "../core/wire";

export type Verdict = "known" | "not known: proven" | "not seen" | "could not tell";
type Refs = Pick<Reference, "pivots" | "inventories">;
type Read = { kind: "in" } | { kind: "empty" } | { kind: "unknown"; outcome: string };

const WORDS: Record<string, string> = { needs_budget: "waiting for a budget" };

/** What one step of a run says about the value: it was listed, every lookup came back empty, or nothing can be said. */
function read(step: PlaybookRunState["steps"][string]): Read {
  if (step.status === "skipped") return { kind: "unknown", outcome: "skipped" };
  if (step.lookups.length === 0) return { kind: "unknown", outcome: "not run" };
  if (step.lookups.some((l) => l.outcome === "answered")) return { kind: "in" };
  const other = step.lookups.find((l) => l.outcome !== "empty");
  return other === undefined ? { kind: "empty" } : { kind: "unknown", outcome: WORDS[other.outcome] ?? other.outcome };
}

/** One entry per step of a does-it-belong run, with the inventory its pivot reads: only the run's record and the reference are used. */
function stepsOf(run: PlaybookRunState, ref: Refs): { inventory: string; title: string; complete: boolean; scope: string; read: Read }[] {
  const out: { inventory: string; title: string; complete: boolean; scope: string; read: Read }[] = [];
  for (const id of run.order) {
    const step = Object.hasOwn(run.steps, id) ? run.steps[id]! : null;
    if (step === null) continue;
    const pivot = ref.pivots.find((x) => x.id === step.pivot);
    const inv = pivot?.inventory == null ? undefined : ref.inventories.find((x) => x.id === pivot.inventory);
    if (inv === undefined) continue;
    out.push({ inventory: inv.id, title: inv.title, complete: inv.complete, scope: inv.scope, read: read(step) });
  }
  return out;
}

export function belongsLines(run: PlaybookRunState, ref: Refs): { inventory: string; title: string; line: string }[] {
  return stepsOf(run, ref).map((s) => {
    const { title } = s;
    const line = s.read.kind === "in" ? `In ${title}`
      : s.read.kind === "empty"
        ? (s.complete ? `Not in ${title} · proven: it is complete for ${s.scope}` : `Not in ${title} · not proof: it is not declared complete`)
        : `${title}: could not tell (${s.read.outcome})`;
    return { inventory: s.inventory, title, line };
  });
}

export function belongsVerdict(run: PlaybookRunState, ref: Refs): { verdict: Verdict; text: string } {
  const steps = stepsOf(run, ref);
  if (steps.some((s) => s.read.kind === "in")) return { verdict: "known", text: "Known asset" };
  const proof = steps.find((s) => s.complete && s.read.kind === "empty");
  if (proof !== undefined) return { verdict: "not known: proven", text: `Not a known asset: proven for ${proof.scope}` };
  if (run.status === "interrupted" || steps.some((s) => s.read.kind === "unknown")) return { verdict: "could not tell", text: "Could not tell" };
  return { verdict: "not seen", text: "Not seen in any inventory; none is complete, so this proves nothing" };
}
