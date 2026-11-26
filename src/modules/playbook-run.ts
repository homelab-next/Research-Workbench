import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import type { Actor, EntryInput, Observable, Payloads, PlaybookLookup, StepOutcome, TimeWindow } from "../core/types";
import { bindPivot, runPivot, yielded } from "./pivots";
import { MAX_PLAYBOOK_LOOKUPS } from "./playbooks";
import type { PlaybookManifest, PlaybookStep } from "./playbooks";
import { answeredBefore, reuseNote } from "./reuse";
import type { RunnerDeps, RunQueryResult } from "./runner";

export interface PlaybookStart {
  playbook: PlaybookManifest; inputs: Observable[]; window: TimeWindow; why: string; actor: Actor;
  run?: string | null; stage?: string | null; subgoal?: string | null; plan_step?: string | null;
}
export interface PlaybookEnd { outcome: StepOutcome; end_step: string | null; cards: string[]; end_cards: string[]; caveats: string[]; lookups: number; reused: number }

const STOPPED = "stopped before every lookup was sent";
const CAPPED = `stopped after ${MAX_PLAYBOOK_LOOKUPS} lookups`;

/** Why this playbook cannot be started on these inputs and this window; null when it can. Reads the registry only. */
export function playbookProblem(deps: RunnerDeps, playbook: PlaybookManifest, inputs: Observable[], window: TimeWindow): string | null {
  for (const i of playbook.inputs) {
    const given = inputs.filter((o) => o.type === i.type);
    if (given.length !== 1) return `the playbook needs a ${i.type} for ${i.name}`;
    if (!deps.observables.matches(i.type, given[0]!.value)) return `"${given[0]!.value}" is not a ${i.type}`;
  }
  for (const o of inputs) if (!playbook.inputs.some((i) => i.type === o.type)) return `the playbook takes no ${o.type}`;
  for (const s of playbook.steps) if (deps.registry.pivot(s.pivot) === null) return `step ${s.id}: pivot ${s.pivot} is not loaded`;
  const open = window.from === null || window.to === null;
  if (open && playbook.steps.some((s) => deps.registry.pivot(s.pivot)!.needs_window)) return "this playbook needs a window with both ends set";
  return null;
}

const link = (start: PlaybookStart, job: string) => ({ run: start.run ?? null, stage: start.stage ?? null, job });

/** Writes job.started (kind "playbook") and playbook.started in one commit and returns the job id. Throws Refused with playbookProblem's words. */
export function beginPlaybook(session: CaseSession, deps: RunnerDeps, start: PlaybookStart): string {
  // a playbook is run by a person or by the workbench in code, never by an agent
  if (start.actor.kind === "agent") throw new Refused("a playbook is started by a person or by the workbench, never by an agent");
  const problem = playbookProblem(deps, start.playbook, start.inputs, start.window);
  if (problem !== null) throw new Refused(problem);
  const p = start.playbook;
  const steps = p.steps.map((s) => ({ id: s.id, pivot: s.pivot, pivot_hash: deps.registry.pivot(s.pivot)!.hash }));
  const inputs = start.inputs.map((o) => ({ type: o.type, value: o.value }));
  let job = "";
  session.commit((_state, ids) => {
    job = ids.next("job");
    const l = link(start, job);
    return [
      { type: "job.started", actor: start.actor, ...l, payload: { job, title: `Playbook: ${p.title} on ${inputs.map((o) => o.value).join(", ")}`, kind: "playbook", source: null } },
      {
        type: "playbook.started", actor: start.actor, ...l,
        payload: {
          job, playbook: p.id, playbook_hash: p.hash, title: p.title, inputs, window: { from: start.window.from, to: start.window.to }, why: start.why,
          plan_step: start.plan_step ?? null, steps,
        },
      },
    ];
  });
  return job;
}

/** A step's lookups as the rules read them: rows when any lookup has a row; empty when it was walked whole and every lookup came back empty. */
interface Walked { status: "ran" | "skipped"; lookups: PlaybookLookup[]; found: string[]; whole: boolean }
const hasRows = (w: Walked): boolean => w.lookups.some((l) => l.rows !== null && l.rows > 0);
const isEmpty = (w: Walked): boolean => w.whole && w.lookups.length > 0 && w.lookups.every((l) => l.outcome === "empty");

function outcomeOf(w: Walked): StepOutcome {
  if (w.lookups.some((l) => l.outcome === "partial")) return "partial";
  if (hasRows(w)) return "answered";
  if (isEmpty(w)) return "empty";
  if (w.lookups.some((l) => l.outcome === "failed")) return "failed";
  return "blocked";
}

/** Why the step is skipped, or null when it runs. */
function skipReason(step: PlaybookStep, done: ReadonlyMap<string, Walked>, type: string): string | null {
  if (step.when !== null) {
    const dep = step.when.step;
    const w = done.get(dep)!;
    if (w.status === "skipped") return `${dep} was skipped`;
    if (!hasRows(w) && !isEmpty(w)) return `could not tell whether ${dep} returned rows`;
    if (step.when.is === "rows" && !hasRows(w)) return `${dep} returned no rows`;
    if (step.when.is === "empty" && !isEmpty(w)) return `${dep} returned rows`;
  }
  if ("step" in step.from) {
    const dep = step.from.step;
    const w = done.get(dep)!;
    if (w.status === "skipped") return `${dep} was skipped`;
    if (w.found.length === 0) return `${dep} found no ${type}`;
  }
  return null;
}

function partialText(r: Extract<RunQueryResult, { status: "done" }>): string {
  if (r.coverage.kind !== "partial") return "";
  return `${r.coverage.reason}${r.coverage.detail === undefined || r.coverage.detail === "" ? "" : `: ${r.coverage.detail}`}`;
}

function lookupOf(session: CaseSession, value: string, r: RunQueryResult, reused: string | null): PlaybookLookup {
  switch (r.status) {
    case "done": {
      const empty = r.card !== null && Object.hasOwn(session.state.cards, r.card) ? session.state.cards[r.card]!.empty : null;
      const meaning = r.outcome === "partial" ? partialText(r) : r.outcome === "empty" ? (empty === "proven-negative" ? "proven negative" : "not seen") : "";
      // a reused lookup says where its answer came from and what that answer means
      const detail = reused === null ? meaning : meaning === "" ? reused : `${reused} · ${meaning}`;
      return { value, outcome: r.outcome, rows: r.rows, query: r.query, card: r.card, reused: reused !== null, detail };
    }
    case "failed":
      return { value, outcome: "failed", rows: null, query: r.query, card: null, reused: false, detail: r.error };
    case "needs_budget":
      return { value, outcome: "needs_budget", rows: null, query: null, card: null, reused: false, detail: "needs a budget" };
    case "refused":
      return { value, outcome: "refused", rows: null, query: null, card: null, reused: false, detail: r.reasons.join("; ") };
  }
}

/**
 * Walks the steps. Always ends the job it was given, in one commit (playbook.finished + job.finished done, or job.finished failed if it threw),
 * unless the job is no longer running; then it writes nothing and returns null. `stop` is asked before each lookup.
 */
export async function runPlaybook(session: CaseSession, deps: RunnerDeps, job: string, start: PlaybookStart, stop?: () => boolean): Promise<PlaybookEnd | null> {
  const isRunning = (): boolean => session.state.jobs[job]?.status === "running" && session.state.playbooks[job]?.status === "running";
  if (!isRunning()) return null;
  const l = link(start, job);
  try {
    const end = await walk(session, deps, job, start, stop, isRunning);
    if (end === null) return null;
    const written = session.commit((): EntryInput[] => (!isRunning() ? [] : [
      { type: "playbook.finished", actor: start.actor, ...l, payload: { job, ...end } },
      { type: "job.finished", actor: start.actor, ...l, payload: { job, outcome: "done" } },
    ]));
    return written.length === 0 ? null : end;
  } catch (err) {
    session.commit((): EntryInput[] => (session.state.jobs[job]?.status !== "running" ? [] : [
      { type: "job.finished", actor: start.actor, ...l, payload: { job, outcome: "failed" } },
    ]));
    throw err;
  }
}

async function walk(
  session: CaseSession, deps: RunnerDeps, job: string, start: PlaybookStart, stop: (() => boolean) | undefined, isRunning: () => boolean,
): Promise<PlaybookEnd | null> {
  const p = start.playbook;
  const l = link(start, job);
  const done = new Map<string, Walked>();
  const caveats: string[] = [];
  const caveat = (c: string): void => { if (!caveats.includes(c)) caveats.push(c); };
  let lookups = 0, reusedCount = 0;
  let halted = false;

  for (const step of p.steps) {
    const pivot = deps.registry.pivot(step.pivot);
    const type = pivot?.from ?? step.pivot;
    const reason = skipReason(step, done, type);
    const payload = (w: Walked, why: string, left: number): Payloads["playbook.step"] =>
      ({ job, step: step.id, pivot: step.pivot, status: w.status, reason: why, lookups: w.lookups, found: w.found, left });
    const record = (w: Walked, why: string, left: number): boolean =>
      session.commit((): EntryInput[] => (!isRunning() ? [] : [{ type: "playbook.step", actor: start.actor, ...l, payload: payload(w, why, left) }])).length > 0;

    if (reason !== null) {
      const w: Walked = { status: "skipped", lookups: [], found: [], whole: true };
      if (!record(w, reason, 0)) return null;
      done.set(step.id, w);
      continue;
    }
    let values: string[];
    if ("input" in step.from) {
      const name = step.from.input;
      const input = p.inputs.find((i) => i.name === name)!;
      values = start.inputs.filter((o) => o.type === input.type).map((o) => o.value);
    } else {
      values = done.get(step.from.step)!.found;
    }
    const followed = values.slice(0, step.max_values);
    const left = values.length - followed.length;
    if (left > 0) caveat(`${step.id}: ${left} values not followed (limit ${step.max_values})`);

    const w: Walked = { status: "ran", lookups: [], found: [], whole: false };
    const results: RunQueryResult[] = [];
    for (const value of followed) {
      if (!isRunning()) return null;
      if (stop?.() === true) { caveat(STOPPED); halted = true; break; }
      if (lookups >= MAX_PLAYBOOK_LOOKUPS) { caveat(CAPPED); halted = true; break; }
      // the same lookup answered in full before in this case (by anyone) is read back, not sent again
      const before = pivot !== null && deps.observables.matches(pivot.from, value)
        ? answeredBefore(session, deps, pivot, bindPivot(pivot, value, deps.observables).bound, start.window) : null;
      let r: RunQueryResult;
      if (before !== null) {
        r = before;
        w.lookups.push(lookupOf(session, value, r, reuseNote(before)));
        lookups++;
        reusedCount++;
      } else {
        r = await runPivot(session, deps, {
          pivot: step.pivot, value, window: start.window, why: `${start.why} — ${p.title}: ${pivot?.title ?? step.pivot}`, actor: start.actor,
          step: start.plan_step ?? null, subgoal: start.subgoal ?? null, run: l.run, stage: l.stage, job, purpose: "playbook",
        });
        w.lookups.push(lookupOf(session, value, r, null));
        if (r.status === "done" || r.status === "failed") lookups++;
      }
      results.push(r);
      if (r.status === "needs_budget") caveat(`${step.id}: ${step.pivot} needs a budget`);
      if (r.status === "done" && r.coverage.kind === "partial") caveat(`${step.id}: partial coverage (${partialText(r)})`);
    }
    w.whole = !halted;
    if (pivot !== null) {
      for (const r of results) for (const o of yielded(pivot, r, deps.observables)) if (!w.found.includes(o.value)) w.found.push(o.value);
    }
    // a step stopped before its first lookup did not run: it leaves no entry
    if (w.lookups.length > 0 || !halted) {
      if (!record(w, halted ? (caveats.includes(CAPPED) ? CAPPED : STOPPED) : "", left)) return null;
      done.set(step.id, w);
    }
    if (halted) break;
  }

  const endStep = p.end.find((id) => done.get(id)?.status === "ran") ?? null;
  const cards: string[] = [];
  for (const w of done.values()) for (const x of w.lookups) if (x.card !== null && !cards.includes(x.card)) cards.push(x.card);
  const endWalk = endStep === null ? null : done.get(endStep)!;
  const endCards = endWalk === null ? [] : [...new Set(endWalk.lookups.flatMap((x) => (x.card === null ? [] : [x.card])))];
  return {
    outcome: endWalk === null ? "blocked" : outcomeOf(endWalk), end_step: endStep, cards, end_cards: endCards, caveats, lookups, reused: reusedCount,
  };
}
