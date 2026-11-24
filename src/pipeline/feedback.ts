import type { CaseSession } from "../core/session";
import { runUsage } from "../core/state";
import type { CaseState } from "../core/state";
import type { Actor, Entry, EntryInput } from "../core/types";
import type { Registry } from "../modules/registry";

export const MOP_IDS = ["elapsed_seconds", "queries_run", "query_cost", "model_tokens", "steps_blocked", "send_backs", "checks_failed"] as const;

const FEEDBACK: Actor = { kind: "system", id: "feedback" };

/** Measures of performance from the entries of the current run (from its run.started), and the case's usage figures for the run. */
export function computeMops(entries: readonly Entry[], state: Readonly<CaseState>): { measure: string; value: number | string; note: string }[] {
  let from = 0;
  entries.forEach((e, i) => { if (e.type === "run.started") from = i; });
  const run = entries.slice(from);
  const started = run.find((e) => e.type === "run.started");
  const published = [...run].reverse().find((e) => e.type === "product.published");
  const end = published ?? run.at(-1);
  const seconds = started === undefined || end === undefined ? 0 : Math.max(0, Math.floor((Date.parse(end.ts) - Date.parse(started.ts)) / 1000));
  const count = (pick: (e: Entry) => boolean): number => run.filter(pick).length;
  const cost = new Map<string, number>();
  for (const e of run) if (e.type === "query.result" && e.payload.cost !== null) cost.set(e.payload.cost.unit, (cost.get(e.payload.cost.unit) ?? 0) + e.payload.cost.amount);
  const spent = cost.size === 0 ? "0" : [...cost].map(([unit, amount]) => `${amount} ${unit}`).join(", ");
  const { usage } = runUsage(state as CaseState);
  return [
    { measure: "elapsed_seconds", value: seconds, note: "from the start of the run to the product being published" },
    { measure: "queries_run", value: count((e) => e.type === "query.issued"), note: "queries issued in this run" },
    { measure: "query_cost", value: spent, note: "the cost the sources reported, by unit" },
    { measure: "model_tokens", value: usage.input + usage.output, note: "input and output tokens of this run" },
    { measure: "steps_blocked", value: count((e) => e.type === "step.finished" && (e.payload.outcome === "blocked" || e.payload.outcome === "failed")), note: "plan steps that ended blocked or failed" },
    { measure: "send_backs", value: count((e) => e.type === "stage.sent_back"), note: "times work was sent back to an earlier stage" },
    { measure: "checks_failed", value: count((e) => e.type === "check.run" && !e.payload.pass), note: "check results that did not pass" },
  ];
}

/** The ids of the objective's measures of one kind; null when the case has no objective, or its manifest is not loaded. */
function measuresOf(state: Readonly<CaseState>, registry: Registry, kind: "mop" | "moe"): string[] | null {
  const id = state.meta?.objective ?? null;
  if (id === null) return null;
  const m = registry.get("objective", id);
  if (m === null) return null;
  const list = m.body.measures;
  if (!Array.isArray(list)) return [];
  return list.flatMap((x) => (typeof x === "object" && x !== null && !Array.isArray(x) && x.kind === kind && typeof x.id === "string" ? [x.id] : []));
}

/** Records this run's measures of performance, once each, as the feedback stage. All of them when the case has no objective. */
export function recordMops(session: CaseSession, registry: Registry, onError: (error: unknown) => void): void {
  session.commit((state) => {
    const named = state.meta?.objective ?? null;
    if (named !== null && registry.get("objective", named) === null) onError(new Error(`the objective "${named}" is not loaded, so every measure of performance is recorded`));
    const listed = measuresOf(state, registry, "mop");
    const entries = session.entries();
    let from = 0;
    entries.forEach((e, i) => { if (e.type === "run.started") from = i; });
    const done = new Set(entries.slice(from).flatMap((e) => (e.type === "feedback.recorded" && e.payload.kind === "mop" ? [e.payload.measure] : [])));
    const out: EntryInput[] = [];
    for (const m of computeMops(entries, state)) {
      if (done.has(m.measure) || (listed !== null && !listed.includes(m.measure))) continue;
      out.push({ type: "feedback.recorded", actor: FEEDBACK, run: state.run.id, stage: "feedback", payload: { measure: m.measure, kind: "mop", value: m.value, note: m.note } });
    }
    return out;
  });
}

export class FeedbackRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedbackRefused";
  }
}

/** A person's measure of effectiveness. It may be given after the run has finished. */
export function recordFeedback(session: CaseSession, registry: Registry, input: { measure: string; value: number | string; note: string; actor: Actor }): void {
  const { actor, measure, value, note } = input;
  if (actor.kind !== "human") throw new FeedbackRefused("only a person may record a measure of effectiveness");
  if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) throw new FeedbackRefused("a measure's value must be a number or text");
  if (typeof note !== "string") throw new FeedbackRefused("a measure's note must be text");
  session.commit((state) => {
    const listed = measuresOf(state, registry, "moe");
    if (listed === null || !listed.includes(measure)) throw new FeedbackRefused(`${measure} is not a measure of effectiveness of this case's objective`);
    return [{ type: "feedback.recorded", actor, payload: { measure, kind: "moe", value, note } }];
  });
}
