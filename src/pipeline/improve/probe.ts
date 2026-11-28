// The Probe stage of an improve loop: every selected task run once under the base and once under each staged candidate, each as a probe child bound to
// that version. What each child gave is recorded in the improve case from the child's state at a head; the improve case is replayed from that record,
// never by running a child again.
import type { Json } from "../../core/canonical";
import { canonical } from "../../core/canonical";
import { sha256Hex } from "../../core/hash";
import type { CaseSession } from "../../core/session";
import { BASE, depthOf, plannedProbes, probeOutputOf, readTaskInputs } from "../../core/state";
import { has } from "../../core/state/guards";
import type { CaseState, ProbeState, TaskInputs } from "../../core/state";
import type { Actor, EntryInput } from "../../core/types";
import type { ChildLink, NewCase, ProbeMark } from "../../core/workbench";
import type { Config } from "../../modules/config";
import type { ManifestFile } from "../../modules/loop-write";
import type { Engine, RunSummary, StageEnd, StageEnv, StageRunner } from "../engine";
import type { ResolvedLoop } from "../loops";
import { PROBE_ACTOR, PlanRefused, probeAcceptPlan } from "../plans";
import { notTheChild } from "../subloop";
import { improveOf } from "./host";
import type { ImproveHost, ProbeRef } from "./host";

/** The most times code accepts one probe child's plan: a child that plans again is accepted again, up to this. */
export const PROBE_PLAN_ACCEPTS = 4;
/** The most times code goes on past a question to the person in one probe child. */
export const PROBE_PASS_OVERS = 8;
const ENGINE: Actor = { kind: "system", id: "engine" };
/** Why a probe child is ended once its output is recorded. */
const PROBE_ENDS = "a probe ends at its publish gate";
export const NO_IMPROVE_HOST = "this workbench cannot run probe children here";
const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 300);

/** What each child of this run may spend; the sentence when the budget does not cover the children. */
export function probeBudgets(config: Config["improve"], children: number): { lookups: number; tokens: number } | string {
  const n = Math.max(1, children);
  const lookups = Math.floor(config.probe_lookups / n);
  const tokens = Math.floor(config.probe_tokens / n);
  if (lookups < 1) return `the probe budget of ${config.probe_lookups} lookups does not cover ${n} children`;
  if (tokens < 1) return `the probe budget of ${config.probe_tokens} tokens does not cover ${n} children`;
  return { lookups, tokens };
}

/** A probe's link: the improve case, its run, the Probe stage, attempt 1, and an input hash over the probe's id, the loop's hash and the task's inputs. */
export function probeLink(state: Readonly<CaseState>, stage: string, probe: { probe: string; loop_hash: string }, inputs: TaskInputs): ChildLink {
  const target = state.improve.selected?.target ?? state.improve.request?.target ?? "";
  const input_hash = sha256Hex(canonical({ probe: probe.probe, loop_hash: probe.loop_hash, inputs } as unknown as Json));
  // the floor is the improve case's marking (with no case made yet, the task's inputs' marking)
  return { parent: state.meta?.id ?? "", run: state.run.id ?? "", stage, attempt: 1, loop: target, input_hash, depth: depthOf(state) + 1, floor: state.meta?.marking ?? inputs.marking };
}

/** How many times code has accepted this child's plan: counted from its ledger, so a restart does not start the count again. */
const codeAccepts = (session: CaseSession): number =>
  session.entries().filter((e) => e.type === "plan.accepted" && e.actor.kind === PROBE_ACTOR.kind && e.actor.id === PROBE_ACTOR.id).length;

/**
 * How many times code has gone on past a question to the person in this child: improve-probe's run.resumed of a run paused on a question,
 * counted from its ledger. A run interrupted while so paused is resumed as interrupted, which is not a pass-over.
 */
export function probePassOvers(session: CaseSession): number {
  let n = 0;
  let held = false;
  for (const e of session.entries()) {
    if (e.type === "run.paused") held = e.payload.hold?.kind === "question";
    else if (e.type === "run.interrupted") held = false;
    else if (e.type === "run.resumed") {
      if (held && e.actor.kind === PROBE_ACTOR.kind && e.actor.id === PROBE_ACTOR.id) n += 1;
      held = false;
    }
  }
  return n;
}

/**
 * Carries a probe child to where a probe ends: starts it on `loop` when it has no run, resumes it once when interrupted, accepts its plan by its
 * policy (at most PROBE_PLAN_ACCEPTS times) each time it waits there, and goes on past a question to the person (at most PROBE_PASS_OVERS times) each
 * time the run is held for its answer: no person is there to answer, and asking is what the investigation should do, so the question is passed over
 * as the person's resume without the answer would, and stays asked. Returns when it waits at its publish gate, is paused otherwise, has finished,
 * or waits at a plan that cannot be accepted. A host's `probes.drive` is this.
 */
export async function driveProbe(engine: Engine, session: CaseSession, loop: ResolvedLoop): Promise<RunSummary> {
  if (session.state.run.status === "none") engine.start(ENGINE, { loop });
  // a stopped process left it interrupted: resumed once, by code. A pause the engine or a person made is left as it is
  if (session.state.run.status === "interrupted") engine.resumeProbe();
  let summary = await engine.advance();
  for (;;) {
    const run = session.state.run;
    if (summary.status === "waiting" && summary.waiting === "plan" && codeAccepts(session) < PROBE_PLAN_ACCEPTS) {
      let accepted: boolean;
      try {
        accepted = probeAcceptPlan(session);
      } catch (err) {
        if (err instanceof PlanRefused) return engine.summary();
        throw err;
      }
      if (!accepted) return engine.summary();
    } else if (run.status === "paused" && run.hold?.kind === "question" && probePassOvers(session) < PROBE_PASS_OVERS) {
      if (!engine.passOverQuestion()) return engine.summary();
    } else {
      return summary;
    }
    summary = await engine.advance();
  }
}

/** The files of a change, from its bundle blob ({ files: [{ path, text }] }); null when the bundle cannot be read. */
function bundleFiles(session: CaseSession, blob: string): ManifestFile[] | null {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(session.blobs.get(blob))) as { files?: unknown };
    if (!Array.isArray(parsed.files)) return null;
    const out: ManifestFile[] = [];
    for (const f of parsed.files as { path?: unknown; text?: unknown }[]) {
      if (typeof f?.path !== "string" || typeof f.text !== "string") return null;
      out.push({ path: f.path, text: f.text });
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The version a probe runs: for base, the version Select recorded; for a candidate, its lock rebuilt over the staging store, staged again from its
 * bundle when that store no longer holds it (the result must be the recorded hash). The reason when it cannot be had.
 */
function probeLoop(env: StageEnv, host: ImproveHost, candidate: string, loopHash: string): ResolvedLoop | string {
  const { session, deps } = env;
  const s = session.state;
  const selected = s.improve.selected!;
  const loops = deps.loops;
  if (loops === undefined) return `the loop "${selected.target}" is not usable here`;
  if (candidate === BASE) return loops.atHash(selected.target, selected.loop_hash);
  const c = has(s.improve.candidates, candidate) ? s.improve.candidates[candidate]! : null;
  if (c === null || c.status !== "staged" || c.lock === null) return "the candidate was not staged";
  const me = improveOf(session);
  let made: ResolvedLoop | string;
  try {
    const lock = loops.readLock(session.blobs.get(c.lock.blob));
    made = lock === null ? "its lock cannot be read" : loops.fromLock(lock, host.staged(me));
  } catch (err) {
    made = firstLine(err);
  }
  if (typeof made !== "string" && made.pipeline.hash === loopHash) return made;
  // the staging store is a cache: the candidate's own text is in its bundle, staged again over the roots as they are now
  const change = has(s.builder.changes, c.change) ? s.builder.changes[c.change]! : null;
  const files = change === null ? null : bundleFiles(session, change.bundle.blob);
  if (change === null || files === null) return `the change ${c.change} cannot be read to stage it again`;
  let again: ReturnType<ImproveHost["stage"]>;
  try {
    again = host.stage(me, change.root, files, selected.target);
  } catch (err) {
    return `staged again: ${firstLine(err)}`;
  }
  if (!again.ok) return `staged again: ${again.problems[0] ?? "it does not resolve"}`;
  if (again.loop.pipeline.hash !== loopHash) return `staged again, it gives version ${again.loop.pipeline.hash.slice(0, 12)}; this run recorded ${loopHash.slice(0, 12)}`;
  return again.loop;
}

/** The child a probe's record names, as the host's calls name it. */
const refOf = (session: CaseSession, run: string, stage: string, p: ProbeState): ProbeRef =>
  ({ id: p.child, origin: p.origin, parent: session.id, run, stage, attempt: 1, input_hash: p.input_hash, probe: p.probe });

/**
 * The Probe stage. Stalls without the host, without this run's selection, at the depth cap, or when the budget does not cover the children. Ends every
 * child of a probe this run has finished; then, for each planned probe not finished, in order: the version, the child (found for its link, or made)
 * and probe.started, the drive, and probe.finished with the child's head and output, then the child's end. A run that is no longer running between two
 * probes ends the stage stopped. Never waits on a child and never passes a gate itself.
 */
export const probeRunner: StageRunner = async (env): Promise<StageEnd> => {
  const { session, deps, stage } = env;
  const host = deps.improve;
  if (host === undefined) return { kind: "stalled", reason: NO_IMPROVE_HOST };
  const s0 = session.state;
  const run = s0.run.id;
  const selected = s0.improve.selected;
  if (run === null || selected === null || selected.run !== run) return { kind: "stalled", reason: `${stage.title}: this run has selected no tasks` };
  const { max_depth } = deps.config.loops;
  if (depthOf(s0) + 1 > max_depth) return { kind: "stalled", reason: `sub-loop depth cap of ${max_depth} reached` };
  const planned = plannedProbes(s0);
  const budgets = probeBudgets(deps.config.improve, planned.length);
  if (typeof budgets === "string") return { kind: "stalled", reason: budgets };
  const me = improveOf(session);
  const recorded = (id: string): ProbeState | null => (has(session.state.improve.probes, id) ? session.state.improve.probes[id]! : null);
  const still = (): boolean => session.state.run.id === run && session.state.run.status === "running";

  // a stopped process may have recorded a probe and not ended its child: each child of a finished probe is ended (nothing when it has ended)
  for (const p of planned) {
    const rec = recorded(p.probe);
    if (rec?.finished != null) host.probes.end(refOf(session, run, stage.id, rec), PROBE_ENDS);
  }

  for (const p of planned) {
    if (recorded(p.probe)?.finished != null) continue;
    if (!still()) return { kind: "stopped" };
    const loopHash = p.candidate === BASE ? selected.loop_hash : session.state.improve.candidates[p.candidate]?.loop_hash ?? "";
    const loop = probeLoop(env, host, p.candidate, loopHash);
    if (typeof loop === "string") return { kind: "stalled", reason: `${p.probe}: ${loop}` };

    let rec = recorded(p.probe);
    if (rec === null) {
      const t = session.state.improve.tasks[p.task]!;
      let inputs: TaskInputs | null;
      try { inputs = readTaskInputs(session.blobs.get(t.inputs.blob)); } catch { inputs = null; }
      if (inputs === null) return { kind: "stalled", reason: `${p.probe}: the inputs Select took of ${p.task} cannot be read` };
      const link = probeLink(session.state, stage.id, { probe: p.probe, loop_hash: loopHash }, inputs);
      const marking = session.state.meta!.marking;
      const made: NewCase = {
        title: `${inputs.title} (probe ${p.probe} of ${session.id})`, asked: inputs.question, why: `probe ${p.probe} of ${session.id}, run ${run}`,
        starting: inputs.starting.map((o) => ({ ...o })), window: { ...inputs.window }, objective: inputs.objective, marking,
      };
      const mark: ProbeMark = {
        improve: session.id, origin: me.origin ?? "", probe: p.probe, candidate: p.candidate, task: p.task, plan_gate: "accept", max_lookups: budgets.lookups, max_tokens: budgets.tokens,
      };
      let child: { id: string; origin: string };
      try {
        // a child a stopped process made for this very link, and the improve case never recorded, is taken: never a second one
        child = host.probes.find(link) ?? host.probes.create(made, link, mark, selected.case_type);
      } catch (err) {
        return { kind: "stalled", reason: `${p.probe}: ${firstLine(err)}` };
      }
      session.commit((s) => {
        if (s.run.id !== run || s.run.status === "finished" || has(s.improve.probes, p.probe)) return [];
        return [{
          type: "probe.started", actor: ENGINE, run, stage: stage.id,
          payload: { probe: p.probe, candidate: p.candidate, task: p.task, child: child.id, origin: child.origin, loop_hash: loopHash, input_hash: link.input_hash, budgets: { ...budgets } },
        }];
      });
      rec = recorded(p.probe);
      if (rec === null) return { kind: "stopped" };
    }

    const ref = refOf(session, run, stage.id, rec);
    let thrown: string | null = null;
    try {
      await host.probes.drive(ref, { loop });
    } catch (err) {
      thrown = firstLine(err);
    }
    const view = host.probes.read(ref);
    if (view === null) return { kind: "stalled", reason: `${p.probe}: ${notTheChild(ref)}` };
    const { state: cs, head } = view;
    // the child runs the version this probe names, or its output is not that version's
    const ran = cs.loop.bound?.hash ?? null;
    if (cs.run.status !== "none" && ran !== rec.loop_hash) {
      return { kind: "stalled", reason: `${stage.title}: child ${rec.child} runs version ${(ran ?? "none").slice(0, 12)} of loop "${selected.target}"; probe ${p.probe} names ${rec.loop_hash.slice(0, 12)}` };
    }
    const output = probeOutputOf(cs);
    const bytes = canonical(output as unknown as Json);
    const reason = output.outcome === "incomplete" && thrown !== null ? thrown : output.reason;
    const done = rec;
    const written = session.commit((s) => {
      const open = has(s.improve.probes, p.probe) ? s.improve.probes[p.probe]! : null;
      if (s.run.id !== run || s.run.status === "finished" || open === null || open.finished !== null) return [];
      const finished: EntryInput = {
        type: "probe.finished", actor: ENGINE, run, stage: stage.id,
        payload: {
          probe: p.probe, child: done.child, child_run: cs.run.id, head: { seq: head.seq, hash: head.hash }, outcome: output.outcome, reason, draft_hash: output.draft_hash,
          output_hash: sha256Hex(bytes), output: session.blobs.put(bytes), lookups: output.stats.lookups, tokens: output.stats.tokens,
        },
      };
      return [finished];
    });
    if (written.length === 0 && recorded(p.probe)?.finished == null) return { kind: "stopped" };
    host.probes.end(ref, PROBE_ENDS);
  }

  const out = plannedProbes(session.state).map((p) => {
    const rec = recorded(p.probe)!;
    return { probe: p.probe, child: rec.child, outcome: rec.finished!.outcome };
  });
  return { kind: "finished", outcome: "pass", draft_hash: null, output: out as unknown as Json, reason: null };
};
