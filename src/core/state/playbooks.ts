// The fold for playbook runs. Browser-safe: no runtime imports but the shared shape checks.
import { PLAYBOOK_LOOKUP_OUTCOMES, PLAYBOOK_STEP_STATUSES, STEP_OUTCOMES } from "../types";
import type { Entry, Payloads, PlaybookLookup } from "../types";
import { has, isBool, isObj, isOneOf, isStr, isStrList, isStrOrNull, malformed, recordSkip } from "./guards";
import { isCount, isObservable, isTimeWindow } from "./shapes";
import type { CaseState, PlaybookRunState } from "./types";

const isLookup = (x: unknown): x is PlaybookLookup =>
  isObj(x) && isStr(x.value) && isOneOf(x.outcome, PLAYBOOK_LOOKUP_OUTCOMES) && (x.rows === null || isCount(x.rows))
  && isStrOrNull(x.query) && isStrOrNull(x.card) && isBool(x.reused) && isStr(x.detail);

const isStarted = (x: unknown): x is Payloads["playbook.started"] =>
  isObj(x) && isStr(x.job) && isStr(x.playbook) && isStr(x.playbook_hash) && isStr(x.title) && Array.isArray(x.inputs) && x.inputs.every(isObservable)
  && isTimeWindow(x.window) && isStr(x.why) && isStrOrNull(x.plan_step)
  && Array.isArray(x.steps) && x.steps.every((st) => isObj(st) && isStr(st.id) && isStr(st.pivot) && isStr(st.pivot_hash));

const isStep = (x: unknown): x is Payloads["playbook.step"] =>
  isObj(x) && isStr(x.job) && isStr(x.step) && isStr(x.pivot) && isOneOf(x.status, PLAYBOOK_STEP_STATUSES) && isStr(x.reason)
  && Array.isArray(x.lookups) && x.lookups.every(isLookup) && isStrList(x.found) && isCount(x.left);

const isFinished = (x: unknown): x is Payloads["playbook.finished"] =>
  isObj(x) && isStr(x.job) && isOneOf(x.outcome, STEP_OUTCOMES) && isStrOrNull(x.end_step) && isStrList(x.cards) && isStrList(x.end_cards)
  && isStrList(x.caveats) && isCount(x.lookups) && isCount(x.reused);

const running = (s: CaseState, job: string): PlaybookRunState | null =>
  has(s.playbooks, job) && s.playbooks[job]!.status === "running" ? s.playbooks[job]! : null;

const withRun = (s: CaseState, p: PlaybookRunState): CaseState => ({ ...s, playbooks: { ...s.playbooks, [p.job]: p } });

/**
 * Playbook runs (playbook.started, playbook.step, playbook.finished), and a failed job.finished, which leaves a running playbook of that job
 * interrupted. A step or an end for a job with no running playbook is skipped as malformed: it cannot belong to any run the case holds.
 */
export function applyPlaybooks(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "playbook.started": {
      const p = entry.payload as unknown;
      if (!isStarted(p)) return malformed(s, entry);
      if (has(s.playbooks, p.job)) return recordSkip(s, entry, "a playbook run is started once");
      const run: PlaybookRunState = {
        job: p.job, playbook: p.playbook, title: p.title, inputs: p.inputs.map((o) => ({ type: o.type, value: o.value })),
        window: { from: p.window.from, to: p.window.to }, plan_step: p.plan_step, started_seq: entry.seq,
        status: "running", end_step: null, steps: {}, order: [], cards: [], end_cards: [], caveats: [],
      };
      return withRun(s, run);
    }
    case "playbook.step": {
      const p = entry.payload as unknown;
      if (!isStep(p)) return malformed(s, entry);
      const run = running(s, p.job);
      if (run === null) return malformed(s, entry);
      const step: Payloads["playbook.step"] = {
        job: p.job, step: p.step, pivot: p.pivot, status: p.status, reason: p.reason,
        lookups: p.lookups.map((l) => ({ value: l.value, outcome: l.outcome, rows: l.rows, query: l.query, card: l.card, reused: l.reused, detail: l.detail })),
        found: [...p.found], left: p.left,
      };
      const cards = [...run.cards];
      for (const l of step.lookups) if (l.card !== null && !cards.includes(l.card)) cards.push(l.card);
      // a computed key defines an own property, so a step id of "__proto__" is an ordinary key
      return withRun(s, {
        ...run, steps: { ...run.steps, [p.step]: step }, order: run.order.includes(p.step) ? run.order : [...run.order, p.step], cards,
      });
    }
    case "playbook.finished": {
      const p = entry.payload as unknown;
      if (!isFinished(p)) return malformed(s, entry);
      const run = running(s, p.job);
      if (run === null) return malformed(s, entry);
      return withRun(s, { ...run, status: p.outcome, end_step: p.end_step, cards: [...p.cards], end_cards: [...p.end_cards], caveats: [...p.caveats] });
    }
    case "job.finished": {
      // applyRun has checked the shape
      const { job, outcome } = entry.payload;
      if (outcome !== "failed" || !isStr(job)) return s;
      const run = running(s, job);
      return run === null ? s : withRun(s, { ...run, status: "interrupted" });
    }
    default:
      return s;
  }
}
