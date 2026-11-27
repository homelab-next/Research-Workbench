// The sub-loop stage: runs another loop as a child case, linked both ways, and records what came back in one commit of the parent.
import type { Json } from "../../core/canonical";
import { canonical } from "../../core/canonical";
import { Refused } from "../../core/refused";
import { depthOf, subloopKey } from "../../core/state";
import type { CaseState, SubloopState } from "../../core/state";
import type { Actor, EntryInput } from "../../core/types";
import type { ChildLink } from "../../core/workbench";
import type { StageEnd, StageRunner } from "../engine";
import { childWaitReason, inputsOf, outputHash, outputsOf, returnsOf } from "../subloop";

const ENGINE: Actor = { kind: "system", id: "engine" };
export const NO_CHILDREN = "this workbench cannot run a sub-loop here";
const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300);

/** What a recorded finish gives the stage: a pass, or a fail with the child's reason when the child was stopped. */
function endOf(rec: SubloopState, reason: string | null): StageEnd {
  const f = rec.finished!;
  const output: Json = { child: rec.child, child_run: f.child_run, outcome: f.outcome, output_hash: f.output_hash, cards: [...f.cards] };
  if (f.outcome !== "stopped") return { kind: "finished", outcome: "pass", draft_hash: null, output, reason: null };
  return { kind: "finished", outcome: "fail", draft_hash: null, output, reason: `child ${rec.child} was stopped${reason === null || reason === "" ? "" : `: ${reason}`}` };
}

/**
 * A stage that runs a loop. Reads the record first: a finished child's result is returned as recorded, and nothing is written. Otherwise, within the caps,
 * it finds the child a stopped process already made for this link or makes one, records subloop.started, drives the child, and when the child has finished
 * records subloop.finished with the cards and proposals that came back, in one commit. A child that waits for a person makes the stage wait on it.
 * It never passes a gate, in the parent or the child.
 */
export const subloopRunner: StageRunner = async (env) => {
  const { session, deps, stage, attempt } = env;
  const spec = stage.subloop ?? null;
  if (spec === null) return { kind: "stalled", reason: `${stage.title} names no loop to run` };
  const children = deps.children;
  if (children === undefined) return { kind: "stalled", reason: NO_CHILDREN };
  const s0 = session.state;
  const run = s0.run.id;
  if (run === null) return { kind: "stalled", reason: `${stage.title} runs only inside a run` };
  const key = subloopKey(run, stage.id, attempt);
  const recorded = (s: Readonly<CaseState>): SubloopState | null => (Object.hasOwn(s.loop.children, key) ? s.loop.children[key]! : null);

  let rec = recorded(s0);
  if (rec?.finished != null) return endOf(rec, children.read(rec.child)?.stop_reason ?? null);

  if (rec === null) {
    const { max_depth, max_children } = deps.config.loops;
    const depth = depthOf(s0) + 1;
    if (depth > max_depth) return { kind: "stalled", reason: `sub-loop depth cap of ${max_depth} reached` };
    if (s0.loop.child_count >= max_children) return { kind: "stalled", reason: `this case has started ${max_children} sub-loops, the cap` };
    const loop = deps.loops?.current(spec.loop) ?? null;
    if (loop === null) {
      const why = deps.loops?.problems(spec.loop)[0];
      return { kind: "stalled", reason: `${stage.title}: the loop "${spec.loop}" is not usable here${why === undefined ? "" : `: ${why}`}` };
    }
    let made: ReturnType<typeof inputsOf>;
    try {
      made = inputsOf(s0, spec, loop.manifest.inputs, session.head().hash);
    } catch (err) {
      if (err instanceof Refused) return { kind: "stalled", reason: `${stage.title}: ${err.message}` };
      throw err;
    }
    // the floor is the parent's case marking; the child's own marking is at least it and at least each card it is given
    const link: ChildLink = { parent: session.id, run, stage: stage.id, attempt, loop: spec.loop, input_hash: made.input_hash, depth, floor: s0.meta!.marking };
    // a child a stopped process made for this very link, and the parent never recorded, is adopted: never a second one
    const child = children.find(link) ?? children.create(made.case, link, made.cards);
    session.commit((s) => {
      if (s.run.id !== run || s.run.status === "finished" || recorded(s) !== null) return [];
      return [{
        type: "subloop.started", actor: ENGINE, run, stage: stage.id,
        payload: { stage: stage.id, attempt, child, loop: spec.loop, loop_hash: loop.pipeline.hash, input_hash: made.input_hash, inputs: session.blobs.put(canonical(made.inputs as Json)), depth },
      }];
    });
    rec = recorded(session.state);
    if (rec === null) return { kind: "stopped" };
  }

  const child = rec.child;
  const before = children.read(child);
  if (before === null) return { kind: "waiting_child", child, reason: "it is not loaded here" };
  if (before.state.run.status !== "finished") {
    try {
      await children.drive(child);
    } catch (err) {
      return { kind: "waiting_child", child, reason: `it could not be carried on: ${firstLine(err)}` };
    }
  }
  const view = children.read(child);
  if (view === null) return { kind: "waiting_child", child, reason: "it is not loaded here" };
  const { state: cs, head } = view;
  if (cs.run.status !== "finished" || cs.run.id === null) return { kind: "waiting_child", child, reason: childWaitReason(cs) };

  const outcome = cs.run.outcome ?? "stopped";
  const outputs = outcome === "stopped" ? {} : outputsOf(cs, view.outputs);
  const output_hash = outputHash(outputs);
  const childRun = cs.run.id;
  session.commit((s, ids) => {
    const open = recorded(s);
    if (s.run.id !== run || s.run.status === "finished" || open === null || open.finished !== null) return [];
    const back = outcome === "stopped" ? { entries: [] as EntryInput[], cards: [] as string[] }
      : returnsOf(outputs, spec, { case: child, loop: spec.loop, run: childRun, head: head.hash }, ids);
    const finished: EntryInput = {
      type: "subloop.finished", actor: ENGINE, run, stage: stage.id,
      payload: { stage: stage.id, attempt, child, child_run: childRun, head: { seq: head.seq, hash: head.hash }, outcome, output_hash, output: session.blobs.put(canonical(outputs as Json)), cards: back.cards },
    };
    return [finished, ...back.entries.map((e) => ({ ...e, run, stage: stage.id }))];
  });
  const done = recorded(session.state);
  if (done?.finished == null) return { kind: "stopped" };
  return endOf(done, view.stop_reason ?? null);
};
