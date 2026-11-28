// Select, the first stage of an improve loop (slice 14): takes the tasks the person's request names from the loaded cases of the case type, and the
// target loop's current version. Of a task it keeps what the original run did, from named fields of its state; of a known answer it keeps only the
// seq and hash of its entry. The judge is blind until it runs: no answer text and no claim passes through this file.
import { canonical } from "../../core/canonical";
import type { Json } from "../../core/canonical";
import type { MemoryLock } from "../../core/lessons";
import type { CaseState, TaskInputs, TaskRecord } from "../../core/state";
import { strictest } from "../../core/types";
import type { Actor, EntryInput, Marking, Product } from "../../core/types";
import { termsOf } from "../../agents/draft";
import { tooStrict } from "../../agents/pack";
import type { StageEnd, StageEnv, StageRunner } from "../engine";
import { IMPLICIT_NOTE, isImproveLoop, memoryUses } from "../loops";
import type { LoopCatalog } from "../loops";
import { improveLock } from "../memory";
import { answeredProducts } from "./answers";
import type { TaskView } from "./host";

const ENGINE: Actor = { kind: "system", id: "engine" };
const NOT_HERE = "this workbench cannot run an improve loop here";

/** Why `target` may not be improved here; null when it may. */
export function targetProblem(loops: LoopCatalog, target: string): string | null {
  const loop = loops.current(target);
  if (loop === null) return `there is no usable loop ${target}: ${loops.problems(target).filter((p) => p !== IMPLICIT_NOTE)[0] ?? "it is not usable"}`;
  if (isImproveLoop(loop)) return "an improve loop is not improved by an improve loop";
  if (loop.lock.subloops.length > 0 || loop.pipeline.stages.some((s) => s.runs === "loop")) return `loop ${target} runs a sub-loop; this version improves a loop with none`;
  return null;
}

/** What Select took of a task's question: named fields of its meta, copied. */
export function taskInputs(state: Readonly<CaseState>): TaskInputs {
  const m = state.meta!;
  return {
    question: m.asked, starting: m.starting.map((o) => ({ type: o.type, value: o.value })), window: { from: m.window.from, to: m.window.to },
    objective: m.objective, marking: m.marking, title: m.title,
  };
}

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/**
 * What Propose is told of a task's original run, from named fields of its state: the published product `product`, the stages' outcomes, the queries'
 * sources, pivots and row counts, the number of questions and send-backs, and the usage. It does not spread the state and never reads `answers`.
 */
export function taskRecord(view: Pick<TaskView, "state">, product: number): TaskRecord {
  const s = view.state;
  const published = s.published.find((p) => p.n === product);
  const draft = published === undefined ? undefined : s.drafts.find((d) => d.hash === published.draft_hash);
  return {
    product: draft === undefined ? (null as unknown as Product) : copy(draft.product),
    stages: s.run.stages.map((st) => ({ id: st.id, title: st.title, status: st.status, attempts: st.attempts, last_reason: st.last_reason })),
    queries: Object.values(s.queries).map((q) => ({ source: q.source, pivot: q.pivot, outcome: q.status, rows: q.rows })),
    questions: Object.keys(s.questions).length,
    sendbacks: Object.values(s.run.sendbacks).reduce((n, c) => n + c, 0),
    usage: { input: s.run.usage.input, output: s.run.usage.output, calls: s.run.model_calls },
  };
}

interface Chosen { view: TaskView; product: number; draft_hash: string; marking: Marking; stricter: (than: Marking) => boolean; answer: { seq: number; hash: string } }

/** The task a case would be: its newest answered product, marked as strictly as its case, that product and that answer; null when it is none. */
function taskOf(view: TaskView): Chosen | null {
  const s = view.state;
  if (s.meta === null || s.improve.request !== null || s.improve.probe_of !== null) return null;
  const a = answeredProducts(s).at(-1);
  if (a === undefined) return null;
  const draft = s.drafts.find((d) => d.hash === a.draft_hash);
  if (draft === undefined) return null;
  const marks = [s.meta.marking, draft.product.marking, a.marking];
  return {
    view, product: a.product, draft_hash: a.draft_hash, marking: strictest(...marks), answer: { seq: a.seq, hash: a.hash },
    stricter: (than) => marks.some((m) => tooStrict(m, than)),
  };
}

/** The stage's output for the selection a run recorded. */
function recordedOutput(s: Readonly<CaseState>): Json {
  const sel = s.improve.selected!;
  return {
    target: sel.target, version: sel.version, loop_hash: sel.loop_hash,
    tasks: s.improve.task_order.map((t) => ({ task: t, case: s.improve.tasks[t]!.case })), left_out: sel.left_out.map((l) => ({ case: l.case, why: l.why })),
  };
}
const selectedThisRun = (s: Readonly<CaseState>): boolean => s.improve.selected !== null && s.improve.selected.run === s.run.id;

export const selectRunner: StageRunner = async (env: StageEnv): Promise<StageEnd> => {
  const { session, deps, stage } = env;
  const host = deps.improve;
  const first = session.state;
  const request = first.improve.request;
  if (host === undefined || request === null || first.meta === null) return { kind: "stalled", reason: NOT_HERE };
  const pass = (output: Json): StageEnd => ({ kind: "finished", outcome: "pass", draft_hash: null, output, reason: null });
  // a restart of the process after the commit: what is recorded is the answer, and nothing is written twice
  if (selectedThisRun(first)) return pass(recordedOutput(first));
  if (deps.loops === undefined) return { kind: "stalled", reason: NOT_HERE };
  const problem = targetProblem(deps.loops, request.target);
  if (problem !== null) return { kind: "stalled", reason: problem };
  const target = deps.loops.current(request.target)!;

  // the scale of the target's standard, through its components, least likely first
  const standard = target.profile.standard === null ? null : target.components.get("*", "standard", target.profile.standard);
  const scale = termsOf(standard?.body ?? null)?.likelihood ?? [];
  if (scale.length === 0) return { kind: "stalled", reason: `the standard of loop ${request.target} lists no likelihood terms, so a task's findings cannot be scored` };

  // the tasks, newest first; one stricter than this case is left out for its marking, the rest beyond the number asked for the cap
  const marking = first.meta.marking;
  const kept: Chosen[] = [];
  const left_out: { case: string; why: "marking" | "cap" }[] = [];
  for (const view of host.tasks(request.case_type)) {
    const t = taskOf(view);
    if (t === null) continue;
    if (t.stricter(marking)) left_out.push({ case: view.ref.case, why: "marking" });
    else if (kept.length >= request.tasks) left_out.push({ case: view.ref.case, why: "cap" });
    else kept.push(t);
  }
  if (kept.length === 0) {
    return { kind: "finished", outcome: "fail", draft_hash: null, output: null, reason: `there is no ${request.case_type} case with a known answer on a published product here` };
  }

  // when the improve loop reads shared memory, every shared lesson of the type is bound for the stages that read it
  const shared = deps.lock === undefined ? [] : memoryUses(deps.lock).filter((u) => u.store === "shared");
  const read = shared.length > 0 && deps.memory !== undefined ? deps.memory.read() : null;
  const run = first.run.id;

  const written = session.commit((state) => {
    if (state.run.id !== run || state.run.status === "finished" || selectedThisRun(state)) return [];
    const link = { run, stage: stage.id };
    const out: EntryInput[] = [];
    if (state.run.budget_tokens === null) out.push({ type: "budget.set", actor: ENGINE, ...link, payload: { tokens: deps.config.improve.own_tokens } });
    out.push({
      type: "improve.selected", actor: ENGINE, ...link,
      payload: {
        target: request.target, version: target.lock.version, loop_hash: target.lock.hash, lock: session.blobs.put(canonical(target.lock as unknown as Json)),
        case_type: request.case_type, scale: [...scale], left_out: left_out.map((l) => ({ case: l.case, why: l.why })),
      },
    });
    kept.forEach((t, i) => {
      const v = t.view;
      out.push({
        type: "improve.task", actor: ENGINE, ...link,
        payload: {
          task: `T${i + 1}`, case: v.ref.case, origin: v.ref.origin, head: { seq: v.head.seq, hash: v.head.hash }, product: { n: t.product, draft_hash: t.draft_hash },
          answer: { seq: t.answer.seq, hash: t.answer.hash }, marking: t.marking,
          inputs: session.blobs.put(canonical(taskInputs(v.state) as unknown as Json)), record: session.blobs.put(canonical(taskRecord(v, t.product) as unknown as Json)),
        },
      });
    });
    if (read !== null) {
      const lock: MemoryLock = improveLock(read, request.case_type, marking, [...new Set(shared.map((u) => u.stage))], { max: deps.config.memory.max_lessons });
      out.push({
        type: "memory.bound", actor: ENGINE, ...link,
        payload: {
          lock: session.blobs.put(canonical(lock as unknown as Json)), store: { origin: lock.store.origin, head: { ...lock.store.head } }, case_type: lock.case_type,
          lessons: lock.lessons.map((l) => ({ lesson: l.lesson, hash: l.hash })),
        },
      });
    }
    return out;
  });
  // the run ended (a person stopped it) between the reading and the commit: nothing was written
  if (written.length === 0 && !selectedThisRun(session.state)) return { kind: "stopped" };
  return pass(recordedOutput(session.state));
};
