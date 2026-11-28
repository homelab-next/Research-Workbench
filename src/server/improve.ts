// The improve loop on the server (slice 14): a person makes an improve case, reads its view, and decides at its adopt gate. An improve case is an
// ordinary case of the loop `improve` with the person's request in its first commit; making it starts nothing. The view holds no known answer: an
// expected finding is named by its number and every score is code's. At the adopt gate the chosen candidate is accepted or rejected whole (a
// candidate is adopted all or nothing, and only the version that was probed): every file goes through the builder's own accept, in one save as the
// person, and the same commit that records the decisions passes the gate in that person's name. Code never passes the adopt gate.
import { redactSecrets } from "../core/redact";
import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import { adoptOffer, readScoreSheet } from "../core/state";
import type { CaseState, ScoreSheet } from "../core/state";
import type { Actor, BlobRef, EntryInput } from "../core/types";
import type { Workbench } from "../core/workbench";
import type { ImproveView, NewImproveInput } from "../core/wire";
import { CANDIDATES_MAX, TASKS_MAX } from "../core/state";
import { has } from "../core/state/guards";
import type { EngineDeps } from "../pipeline/engine";
import { IMPLICIT_NOTE, isImproveLoop } from "../pipeline/loops";
import { targetProblem } from "../pipeline/improve/select";
import { builderDecideAll, builderView } from "./builder";
import type { BuilderContext } from "./builder";
import type { CaseHub } from "./hub";
import { shown } from "./views";

/** An improve act the server will not carry out: nothing was written. */
export class ImproveRefused extends Refused {
  constructor(message: string, reasons?: string[]) {
    super(message, reasons);
    this.name = "ImproveRefused";
  }
}

/** The one improve loop of a workbench. */
export const IMPROVE_LOOP = "improve";
export const NOT_WAITING = "the run is not waiting at the adopt gate";
export const ADOPT_STALE = "this file changed since the candidate was proposed; run the improve loop again";
export const NOT_PROBED = "the target loop changed since the candidate was probed; run the improve loop again";
const clip = (x: unknown, n = 64): string => String(x).slice(0, n);

/** Why this workbench has no improve loop to run; null when it has one. */
function improveLoopProblem(deps: EngineDeps): string | null {
  const loops = deps.loops;
  if (loops === undefined) return "there is no loop catalogue here";
  const loop = loops.current(IMPROVE_LOOP);
  if (loop !== null) return isImproveLoop(loop) ? null : `loop "${IMPROVE_LOOP}" has no stage of an improve role`;
  if (!loops.list().some((x) => x.id === IMPROVE_LOOP)) return `there is no loop "${IMPROVE_LOOP}"`;
  return loops.problems(IMPROVE_LOOP).find((p) => p !== IMPLICIT_NOTE) ?? `loop "${IMPROVE_LOOP}" is not usable`;
}

/**
 * A new improve case for the person: of the loop `improve`, of the case type it improves for, with improve.requested in its first commit. It
 * starts nothing (the client sends start). Refused, having written nothing, when there is no usable improve loop, the target may not be improved,
 * the case type is not one, or the numbers are outside 1 to the configuration's maxima.
 */
export function createImprove(d: { hub: CaseHub; deps: EngineDeps; wb: Workbench }, input: NewImproveInput, actor: Extract<Actor, { kind: "human" }>): { id: string } {
  const { deps } = d;
  const no = improveLoopProblem(deps);
  if (no !== null) throw new ImproveRefused(`there is no usable improve loop here: ${shown(deps, no)}`);
  const problem = targetProblem(deps.loops!, input.loop);
  if (problem !== null) throw new ImproveRefused(shown(deps, problem));
  if (!(deps.case_types ?? []).some((t) => t.id === input.case_type)) throw new ImproveRefused(`there is no case type ${clip(input.case_type)}`);
  const maxTasks = Math.min(deps.config.improve.max_tasks, TASKS_MAX);
  const maxCandidates = Math.min(deps.config.improve.max_candidates, CANDIDATES_MAX);
  const within = (n: number, max: number): boolean => Number.isInteger(n) && n >= 1 && n <= max;
  if (!within(input.tasks, maxTasks)) throw new ImproveRefused(`an improve run takes 1 to ${maxTasks} tasks`);
  if (!within(input.candidates, maxCandidates)) throw new ImproveRefused(`an improve run takes 1 to ${maxCandidates} candidates`);
  const { loop: target, case_type, tasks, candidates, marking } = input;
  try {
    const session = d.wb.createCase(
      {
        title: `Improve ${target} for ${case_type}`, asked: `Which change to loop ${target} makes ${case_type} cases more correct?`, why: "an improve run the person asked for",
        starting: [], window: { from: null, to: null }, objective: null, marking,
      },
      actor, { loop: IMPROVE_LOOP, type: case_type, improve: { target, case_type, tasks, candidates } },
    );
    return { id: session.id };
  } catch (err) {
    // what the fold would skip is refused by createCase before anything is written
    if (err instanceof TypeError) throw new ImproveRefused(shown(deps, err.message));
    throw err;
  }
}

// ---------- the view ----------

/** A blob of the case as JSON, or undefined when it is not there or not JSON. */
function blobJson(session: CaseSession, ref: BlobRef): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(session.blobs.get(ref.blob)));
  } catch {
    return undefined;
  }
}

/** The lessons Reflect proposed in this run, as its recorded output names them. */
function lessonsOf(session: CaseSession, deps: EngineDeps, said: (t: string) => string): { lesson: string; title: string }[] {
  const { state } = session;
  const selected = state.improve.selected;
  if (selected === null) return [];
  const stages = new Set(deps.pipeline.stages.filter((s) => s.role === "reflect").map((s) => s.id));
  const done = session.entries(selected.seq).findLast((e) => e.type === "stage.finished" && stages.has(e.payload.stage) && e.payload.outcome === "pass" && e.payload.output !== null);
  if (done === undefined || done.type !== "stage.finished" || done.payload.output === null) return [];
  const out = blobJson(session, done.payload.output) as { lessons?: unknown } | undefined;
  const listed = out !== undefined && out !== null && Array.isArray(out.lessons) ? (out.lessons as unknown[]) : [];
  return listed.flatMap((l) => {
    const x = l as { lesson?: unknown; title?: unknown } | null;
    return x !== null && typeof x === "object" && typeof x.lesson === "string" && typeof x.title === "string" ? [{ lesson: x.lesson, title: said(x.title) }] : [];
  });
}

/** The score sheet judge.scored names, with every produced finding's text shown scrubbed; null when it cannot be read. */
function sheetOf(session: CaseSession, ref: BlobRef, said: (t: string) => string): ScoreSheet | null {
  let sheet: ScoreSheet | null;
  try {
    sheet = readScoreSheet(session.blobs.get(ref.blob));
  } catch {
    return null;
  }
  if (sheet === null) return null;
  return {
    format: sheet.format, scale: sheet.scale.map(said), summary: sheet.summary.map((r) => ({ candidate: r.candidate, score: r.score, drafted: r.drafted, tasks: r.tasks })),
    outputs: sheet.outputs.map((o) => ({
      probe: o.probe, candidate: o.candidate, task: o.task, outcome: o.outcome, score: o.score, text: o.text,
      findings: o.findings.map((f) => ({
        expected: f.expected, produced: f.produced === null ? null : said(f.produced), by: f.by, similarity: f.similarity,
        likelihood_distance: f.likelihood_distance, confidence_distance: f.confidence_distance, score: f.score,
      })),
      left_over: o.left_over.map(said),
    })),
  };
}

const waitingAtAdopt = (state: Readonly<CaseState>): boolean => state.run.status === "waiting" && state.run.waiting === "adopt";

/**
 * An improve case as its lens shows it, from its own ledger alone. Scores only once judge.scored is folded; the candidates' titles, reasons and
 * diffs from builderView; the lessons from Reflect's recorded output. Every text shown is scrubbed and holds no secret value; no known answer is in it.
 */
export async function improveView(session: CaseSession, deps: EngineDeps, opts: { secrets: readonly string[] }): Promise<ImproveView> {
  const { state } = session;
  const i = state.improve;
  const said = (t: string): string => shown(deps, redactSecrets(t, opts.secrets));
  const builder = i.candidate_order.length === 0 ? null : await builderView(session, deps, { secrets: opts.secrets });
  const offer = adoptOffer(state);
  return {
    request: i.request === null ? null : { target: i.request.target, case_type: i.request.case_type, tasks: i.request.tasks, candidates: i.request.candidates },
    selected: i.selected === null ? null : {
      target: i.selected.target, version: i.selected.version, loop_hash: i.selected.loop_hash,
      tasks: i.task_order.filter((t) => has(i.tasks, t)).map((t) => ({ task: t, case: i.tasks[t]!.case, marking: i.tasks[t]!.marking })),
      left_out: i.selected.left_out.map((l) => ({ case: l.case, why: l.why })),
    },
    candidates: i.candidate_order.filter((k) => has(i.candidates, k)).map((k) => {
      const c = i.candidates[k]!;
      const change = builder?.changes.find((x) => x.id === c.change);
      return { candidate: c.candidate, change: c.change, title: change?.title ?? "", why: change?.why ?? "", status: c.status, reason: said(c.reason), files: change?.files ?? [] };
    }),
    probes: i.probe_order.filter((p) => has(i.probes, p)).map((p) => {
      const x = i.probes[p]!;
      const f = x.finished;
      return {
        probe: x.probe, candidate: x.candidate, task: x.task, child: x.child, head: f === null ? null : { seq: f.head.seq, hash: f.head.hash },
        outcome: f === null ? null : f.outcome, reason: f === null ? "" : said(f.reason), lookups: f === null ? null : f.lookups, tokens: f === null ? null : f.tokens,
      };
    }),
    chosen: i.chosen === null ? null : { candidate: i.chosen.candidate, why: said(i.chosen.why) },
    scores: i.scored === null ? null : sheetOf(session, i.scored.scores, said),
    lessons: lessonsOf(session, deps, said),
    adopt: offer === null ? null : { waiting: waitingAtAdopt(state), candidate: offer.candidate, change: offer.change, undecided: offer.undecided },
  };
}

// ---------- the adopt gate ----------

/** gate.passed { gate: adopt }, by the person the server names, in the run that waits there. */
const passAdopt = (ctx: BuilderContext, s: Readonly<CaseState>): EntryInput => {
  if (!waitingAtAdopt(s)) throw new ImproveRefused(NOT_WAITING);
  return { type: "gate.passed", actor: ctx.actor, payload: { gate: "adopt" }, ...(s.run.id === null ? {} : { run: s.run.id }) };
};

/** The offer the run waits on, or the refusal. */
function offered(ctx: BuilderContext): NonNullable<ReturnType<typeof adoptOffer>> {
  const { state } = ctx.session;
  if (!waitingAtAdopt(state)) throw new ImproveRefused(NOT_WAITING);
  const offer = adoptOffer(state);
  if (offer === null) throw new ImproveRefused(NOT_WAITING);
  return offer;
}

/**
 * The person's decision on the chosen candidate at the adopt gate, whole: an accept writes every file of its change through the builder's accept
 * (the stale check, the bundle's text, one saveManifests as the person with why builder, builder.decided, the reload), and only when the root with
 * those files laid over it gives the version the probes ran; a rejection decides every file rejected. The same commit passes the gate in that
 * person's name. Refused, having written nothing, unless the run waits at the adopt gate and `change` is the change Adopt offers.
 */
export function adoptDecide(ctx: BuilderContext, change: string, accept: boolean): void {
  const offer = offered(ctx);
  if (offer.change !== change) throw new ImproveRefused(`${clip(change, 40)} is not the change Adopt offers`);
  const { state } = ctx.session;
  const candidate = state.improve.candidates[offer.candidate]!;
  const target = state.improve.selected?.target ?? null;
  if (accept && (candidate.loop_hash === null || target === null)) throw new ImproveRefused(NOT_PROBED);
  builderDecideAll(ctx, change, accept, {
    stale: ADOPT_STALE,
    ...(accept ? { expect: { loop: target!, hash: candidate.loop_hash!, refusal: NOT_PROBED } } : {}),
    with: (s) => [passAdopt(ctx, s)],
  });
}

/** Rejects every file still undecided and passes the gate, in one commit. Nothing is written into a root. */
export function adoptFinish(ctx: BuilderContext): void {
  const offer = offered(ctx);
  builderDecideAll(ctx, offer.change, false, { with: (s) => [passAdopt(ctx, s)] });
}
