// The fold for loops (slice 12): the loop a case is for, the version a run is bound to, the parent of a child case, and the children a case's
// runs made. Browser-safe: no runtime imports but the shared shape checks.
import { isMarking, SUBLOOP_OUTCOMES } from "../types";
import type { BlobRef, Entry, Payloads } from "../types";
import { isObj, isOneOf, isStr, isStrList, malformed, recordSkip } from "./guards";
import { isRunStartedShape } from "./run";
import { isBlobRefShape, isCount } from "./shapes";
import type { CaseState, LoopState, SubloopState } from "./types";

export function initialLoop(): LoopState {
  return { id: null, pending: null, bound: null, parent: null, children: {}, child_count: 0 };
}

export const subloopKey = (run: string, stage: string, attempt: number): string => `${run}/${stage}/${attempt}`;

/** The id of the loop a case is for: its own, or `fallback` for a ledger that names none. */
export function loopOf(state: Readonly<CaseState>, fallback: string): string {
  return state.loop.id ?? fallback;
}

/** How deep a case is below one no case started: 0 without a parent. */
export function depthOf(state: Readonly<CaseState>): number {
  return state.loop.parent === null ? 0 : state.loop.parent.depth;
}

const isId = (x: unknown): x is string => isStr(x) && x !== "";
const isAttempt = (x: unknown): x is number => isCount(x) && x >= 1;
const isHead = (x: unknown): x is { seq: number; hash: string } => isObj(x) && isCount(x.seq) && isStr(x.hash);
const copyRef = (r: BlobRef): BlobRef => (r.media === undefined ? { blob: r.blob, bytes: r.bytes } : { blob: r.blob, bytes: r.bytes, media: r.media });

const isLoopSet = (x: unknown): x is Payloads["case.loop_set"] => isObj(x) && isId(x.loop);
const isBound = (x: unknown): x is Payloads["loop.bound"] =>
  isObj(x) && isId(x.loop) && isCount(x.version) && isStr(x.hash) && isBlobRefShape(x.lock);
const isChild = (x: unknown): x is Payloads["subloop.child"] =>
  isObj(x) && isId(x.parent) && isId(x.run) && isId(x.stage) && isAttempt(x.attempt) && isId(x.loop) && isStr(x.input_hash) && isCount(x.depth) && isMarking(x.floor);
const isStarted = (x: unknown): x is Payloads["subloop.started"] =>
  isObj(x) && isId(x.stage) && isAttempt(x.attempt) && isId(x.child) && isId(x.loop) && isStr(x.loop_hash) && isStr(x.input_hash)
  && isBlobRefShape(x.inputs) && isCount(x.depth);
const isFinished = (x: unknown): x is Payloads["subloop.finished"] =>
  isObj(x) && isId(x.stage) && isAttempt(x.attempt) && isId(x.child) && isStr(x.child_run) && isHead(x.head) && isOneOf(x.outcome, SUBLOOP_OUTCOMES)
  && isStr(x.output_hash) && isBlobRefShape(x.output) && isStrList(x.cards);

const withLoop = (s: CaseState, l: Partial<LoopState>): CaseState => ({ ...s, loop: { ...s.loop, ...l } });
/** A run is in progress: started, and not finished. */
const inProgress = (s: CaseState): boolean => s.run.id !== null && s.run.status !== "none" && s.run.status !== "finished";

const CHILD_ONLY = "a child's parent is recorded by the workbench when the case is made";
const BY_WORKBENCH = "a sub-loop is recorded by the workbench";

/**
 * case.loop_set, loop.bound, subloop.child, subloop.started and subloop.finished, and run.started (which moves a pending loop.bound to `bound`
 * when it names that hash). Runs before applyRun, so it sees the run as it was before this entry. Nothing here changes the run, the cards, the
 * plan or the counters: the cards a finished child returned are card.created entries of their own.
 */
export function applyLoops(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "case.loop_set": {
      const p = entry.payload as unknown;
      if (!isLoopSet(p)) return malformed(s, entry);
      if (entry.actor.kind === "agent") return recordSkip(s, entry, "a case's loop is chosen by a person or the workbench");
      if (s.run.status !== "none") return recordSkip(s, entry, "a case's loop is set before its first run");
      return withLoop(s, { id: p.loop });
    }
    case "loop.bound": {
      const p = entry.payload as unknown;
      if (!isBound(p)) return malformed(s, entry);
      if (entry.actor.kind === "agent") return recordSkip(s, entry, "a run's loop version is recorded by a person or the workbench");
      return withLoop(s, { pending: { loop: p.loop, version: p.version, hash: p.hash, lock: copyRef(p.lock), seq: entry.seq } });
    }
    case "run.started": {
      // a start applyRun refuses as malformed starts no run, and binds nothing
      if (!isRunStartedShape(entry.payload)) return s;
      const pending = s.loop.pending;
      const bound = pending !== null && pending.hash === entry.payload.pipeline_hash ? pending : null;
      return pending === null && s.loop.bound === null ? s : withLoop(s, { pending: null, bound });
    }
    case "subloop.child": {
      const p = entry.payload as unknown;
      if (!isChild(p)) return malformed(s, entry);
      // only in the child's first commit (case.created, case.loop_set, subloop.child), by code, once, before any run
      if (entry.actor.kind !== "system" || entry.seq > 3 || s.meta === null || s.run.status !== "none" || s.loop.parent !== null) {
        return recordSkip(s, entry, CHILD_ONLY);
      }
      return withLoop(s, {
        parent: { case: p.parent, run: p.run, stage: p.stage, attempt: p.attempt, loop: p.loop, input_hash: p.input_hash, depth: p.depth, floor: p.floor },
      });
    }
    case "subloop.started": {
      const p = entry.payload as unknown;
      if (!isStarted(p)) return malformed(s, entry);
      if (entry.actor.kind === "agent") return recordSkip(s, entry, BY_WORKBENCH);
      if (!inProgress(s) || !s.run.stages.some((st) => st.id === p.stage)) return recordSkip(s, entry, "a sub-loop starts at a stage of the run in progress");
      const run = s.run.id!;
      const key = subloopKey(run, p.stage, p.attempt);
      if (Object.hasOwn(s.loop.children, key)) return recordSkip(s, entry, "a sub-loop starts once for a stage's attempt");
      const child: SubloopState = {
        key, run, stage: p.stage, attempt: p.attempt, child: p.child, loop: p.loop, loop_hash: p.loop_hash, input_hash: p.input_hash,
        inputs: copyRef(p.inputs), depth: p.depth, started_seq: entry.seq, finished: null,
      };
      // a computed key defines an own property, so a key holding "__proto__" is an ordinary key
      return withLoop(s, { children: { ...s.loop.children, [key]: child }, child_count: s.loop.child_count + 1 });
    }
    case "subloop.finished": {
      const p = entry.payload as unknown;
      if (!isFinished(p)) return malformed(s, entry);
      if (entry.actor.kind === "agent") return recordSkip(s, entry, BY_WORKBENCH);
      const key = s.run.id === null ? null : subloopKey(s.run.id, p.stage, p.attempt);
      const open = key !== null && Object.hasOwn(s.loop.children, key) ? s.loop.children[key]! : null;
      if (open === null || open.finished !== null || open.child !== p.child) return recordSkip(s, entry, "a sub-loop finishes once, as the child it started");
      const finished: SubloopState["finished"] = {
        child_run: p.child_run, head: { seq: p.head.seq, hash: p.head.hash }, outcome: p.outcome, output_hash: p.output_hash,
        output: copyRef(p.output), cards: [...p.cards], seq: entry.seq,
      };
      return withLoop(s, { children: { ...s.loop.children, [open.key]: { ...open, finished } } });
    }
    default:
      return s;
  }
}
