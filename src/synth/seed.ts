// `bun run synth seed-tasks`: for each storyline, a case of the scripted seed loop synth-seed, run as the person who runs the command: the plan
// accepted with no budget and the product approved, through the engine calls `investigate accept-plan` and `investigate approve` use, then the
// known answer set from the ground truth. The product judges nothing (it is not the answer); only the known answer holds the truth.
import { hostsFor } from "../cli/improve";
import { compose } from "../cli/compose";
import type { CaseSession } from "../core/session";
import { blockers, latestDraft } from "../core/state";
import type { Marking } from "../core/types";
import { Workbench, WorkbenchLockedError } from "../core/workbench";
import type { Engine } from "../pipeline/engine";
import { answerFromTruth } from "./answer";
import { SynthRefused } from "./setup";
import type { SynthContext } from "./setup";
import { caseInput, readIndex, readTruths, recordTruth, unknownOnly } from "./tasks";

export const SEED_LOOP = "synth-seed";
/** The objective of a seeded case, the overlay's: the checks ask that a product state one. */
export const SEED_OBJECTIVE = "synth-objective";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
type Stopped = { where: string; why: string };

/** Null when the run waits at `gate` (at publish, with no blocker); else where it is and why it is not there. */
function notAt(session: CaseSession, gate: "plan" | "publish"): Stopped | null {
  const { run } = session.state;
  if (run.status === "waiting" && run.waiting === gate) {
    if (gate === "plan") return null;
    const draft = latestDraft(session.state);
    if (draft === null) return { where: "the publish gate", why: "there is no draft" };
    const b = blockers(session.state, draft.hash);
    return b.length === 0 ? null : { where: "the publish gate", why: b.map(oneLine).join("; ") };
  }
  const where = run.status === "waiting" && run.waiting !== null ? `the ${run.waiting} gate` : run.current !== null ? `stage ${run.current} (${run.status})` : run.status;
  const why = run.pause_reason !== null ? oneLine(run.pause_reason) : `the run is ${run.status}, not waiting at its ${gate} gate`;
  return { where, why };
}

/** One case: its plan accepted and its product approved as the person, then its known answer. A run anywhere else is not pushed on. */
async function seedOne(engine: Engine, session: CaseSession, ctx: SynthContext, anchor: (s: CaseSession) => void): Promise<Stopped | { product: number }> {
  const { human, config } = ctx;
  engine.start(human);
  await engine.advance();
  const atPlan = notAt(session, "plan");
  if (atPlan !== null) return atPlan;
  // no budget: the seed's one step is free, so nothing costly runs
  engine.acceptPlan({ actor: human });
  await engine.advance();
  const atPublish = notAt(session, "publish");
  if (atPublish !== null) return atPublish;
  engine.approve({ actor: human, unload_after: false });
  await engine.advance();
  const { run } = session.state;
  if (run.status !== "finished" || run.outcome !== "published") {
    return { where: run.current === null ? run.status : `stage ${run.current} (${run.status})`, why: oneLine(run.pause_reason ?? `the run is ${run.status}, not published`) };
  }
  anchor(session);
  try {
    return { product: answerFromTruth(session, engine.bound, config, human, null).product };
  } catch (err) {
    if (err instanceof SynthRefused) return { where: "the known answer", why: err.message };
    throw err;
  }
}

export async function synthSeed(ctx: SynthContext, opts: { only: string[] | null; marking: Marking }): Promise<number> {
  const { config, io, human } = ctx;
  const unknown = unknownOnly(ctx, opts.only);
  if (unknown !== null) { io.error(unknown); return 1; }
  const asked = (id: string): boolean => opts.only === null || opts.only.includes(id);
  const { truths, bad } = readTruths(ctx);
  let code = 0;
  for (const b of bad.filter((x) => asked(x.storyline))) { io.error(`${b.storyline}: ${b.why}`); code = 1; }
  const seeded = new Set(readIndex(config).cases.filter((c) => c.made_by === "seed-tasks").map((c) => c.storyline));
  const wanted = truths.filter((t) => asked(t.storyline) && !seeded.has(t.storyline));
  if (wanted.length === 0) {
    io.log("no case seeded: every storyline asked for already has a seeded case");
    return code;
  }
  let wb: Workbench | null = null;
  let composed: ReturnType<typeof compose> | null = null;
  let host: ReturnType<typeof hostsFor> | null = null;
  try {
    wb = Workbench.open(config.data_dir, { store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store, onError: (e) => io.error(`workbench: ${messageOf(e)}`) });
    composed = compose(config, wb);
    const base = composed.deps;
    // what the engine anchored, so a run this command finished is anchored at its last entry once, as `investigate approve` does
    const anchoredAt = new Map<string, number>();
    const deps = { ...base, anchor: (a: Parameters<NonNullable<typeof base.anchor>>[0]) => { base.anchor?.(a); anchoredAt.set(a.case, a.seq); } };
    host = hostsFor(wb, deps, (e) => io.error(`seed-tasks: ${messageOf(e)}`));
    const anchor = (s: CaseSession): void => {
      const head = s.head();
      if (anchoredAt.get(s.id) === head.seq) return;
      try { deps.anchor({ case: s.id, seq: head.seq, hash: head.hash, why: "published" }); } catch (err) { io.error(`the case head could not be anchored: ${messageOf(err)}`); }
    };
    if (deps.loops === undefined || deps.loops.current(SEED_LOOP) === null) {
      io.error(`there is no usable loop ${SEED_LOOP}: ${deps.loops?.problems(SEED_LOOP).join("; ") || "it is not loaded"}`);
      return 1;
    }
    const types = (deps.case_types ?? []).map((t) => t.id);
    for (const truth of wanted) {
      const { task } = truth;
      if (!types.includes(task.case_type)) {
        io.error(`${truth.storyline}: "${task.case_type}" is not a case type${types.length === 0 ? "; none is loaded" : `; one of ${types.join(", ")}`}`);
        code = 1;
        continue;
      }
      const wrong = task.starting.find((o) => !deps.runner.observables.matches(o.type, o.value));
      if (wrong !== undefined) { io.error(`${truth.storyline}: ${wrong.value} is not a ${wrong.type}`); code = 1; continue; }
      const session = wb.createCase({ ...caseInput(truth, opts.marking), objective: SEED_OBJECTIVE }, human, { loop: SEED_LOOP, type: task.case_type });
      recordTruth(config, truth, session, "seed-tasks");
      const done = await seedOne(host.engine(session.id), session, ctx, anchor);
      if ("product" in done) {
        io.log(`seeded ${session.id} for ${truth.storyline}: product ${done.product} published, known answer set (synthetic)`);
      } else {
        io.error(`${session.id} for ${truth.storyline} stopped at ${done.where}: ${done.why}`);
        code = 1;
      }
    }
    return code;
  } catch (err) {
    if (err instanceof WorkbenchLockedError) {
      io.error(`${err.message}; stop the server or the command that holds it, then try again`);
      return 1;
    }
    throw err;
  } finally {
    try { host?.close(); } catch { /* closed */ }
    try { composed?.close(); } catch { /* the pool is already closed */ }
    try { wb?.close(); } catch (err) { io.error(`closing the workbench failed: ${messageOf(err)}`); }
  }
}
