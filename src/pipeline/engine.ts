import { Refused } from "../core/refused";
import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import type { CaseSession } from "../core/session";
import type { CaseState, RunState } from "../core/state";
import { latestDraft } from "../core/state";
import type { Actor, Draft, EntryInput, Marking, ModelChoice, Product, RunHold } from "../core/types";
import { termsOf } from "../agents/draft";
import { mayGo, tooStrict } from "../agents/pack";
import type { Providers } from "../agents/providers";
import type { Profile } from "../agents/context";
import type { Config } from "../modules/config";
import type { Registry } from "../modules/registry";
import type { RunnerDeps, RunQueryResult } from "../modules/runner";
import type { Seeker } from "../modules/seeker";
import type { Pipeline, Role, StageManifest } from "./manifests";
import { firstUnpassedReview, nextStep } from "./next";
import { acceptPlan, denyPlan, requestReplan, spendPlanBudget } from "./plans";
import { answerChallenge, reviseDraft } from "./revise";
import { overrule } from "./overrule";
import { assembleRunner } from "./stages/assemble";
import { challengeRunner } from "./stages/challenge";
import { checksRunner } from "./stages/checks";
import { evaluateRunner } from "./stages/evaluate";
import { frameRunner } from "./stages/frame";
import { planRunner } from "./stages/plan";
import { researchRunner } from "./stages/research";
import { recoverSession } from "./recover";
import { logToStderr } from "../core/deliver";
import { approve, reject, removeTempBundles } from "./publish";
import { recordFeedback } from "./feedback";
import { feedbackRunner } from "./stages/feedback";
import { publishRunner } from "./stages/publish";

export interface EngineDeps {
  config: Config; registry: Registry; runner: RunnerDeps; seeker: Seeker; providers: Providers; pipeline: Pipeline; profile: Profile;
  /** Where problems that do not stop the work are reported (a failed anchor, a leftover folder, a missing objective); stderr when absent. */
  onError?: (error: unknown) => void;
  anchor?: (a: { case: string; seq: number; hash: string; why: "published" | "closed" }) => void;
}
export interface StageEnv {
  session: CaseSession; deps: EngineDeps; stage: StageManifest; attempt: number;
  /**
   * For a researcher's ToolContext. Called when a costly step raised a proposal; the engine runs it with the budget the person gave
   * when accepting the plan, in that person's name, once per proposal, and returns the result; null when it did not run it.
   */
  onNeedsBudget: (proposal: string, step: string | null) => Promise<RunQueryResult | null>;
}
export type StageEnd =
  | { kind: "finished"; outcome: "pass" | "fail"; draft_hash: string | null; output: Json | null; reason: string | null }
  | { kind: "declined"; reason: string }
  | { kind: "blocked"; marking: Marking }
  | { kind: "stalled"; reason: string }
  | { kind: "stopped" };
export type StageRunner = (env: StageEnv) => Promise<StageEnd>;
export interface RunSummary { status: RunState["status"]; waiting: "plan" | "publish" | null; current: string | null; pause_reason: string | null; outcome: "published" | "stopped" | null }
export class RunRefused extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "RunRefused";
  }
}

const ENGINE: Actor = { kind: "system", id: "engine" };
/** A guard against a pipeline that loops without end; real runs are far below it (every cycle is capped by the send-back rule). */
const MAX_STEPS = 500;
/** Sessions this process has already recovered, so a second engine on the same open session does not close work begun since. */
const recovered = new WeakSet<CaseSession>();

const firstLine = (text: string): string => text.split("\n")[0]!.slice(0, 300);
/** The most of a reason a stage.finished or run.paused keeps: a stage's reason can be a model's text, and an entry has a size limit. */
export const REASON_CHARS = 4000;
const clipReason = (reason: string): string => (reason.length > REASON_CHARS ? `${reason.slice(0, REASON_CHARS - 1)}…` : reason);

export class Engine {
  private inflight: Promise<RunSummary> | null = null;
  private readonly runners: Partial<Record<Role, StageRunner>>;

  /** Builds an engine and writes nothing: a read (a status, a replay) can use one. A command that acts opens it with Engine.open. */
  constructor(private readonly session: CaseSession, private readonly deps: EngineDeps, opts: { runners?: Partial<Record<Role, StageRunner>> } = {}) {
    this.runners = { frame: frameRunner, plan: planRunner, research: researchRunner, assemble: assembleRunner, checks: checksRunner, evaluate: evaluateRunner, challenge: challengeRunner, publish: publishRunner, feedback: feedbackRunner, ...opts.runners };
  }

  /** An engine for a command that will act on the case: the case is recovered first (once per open session). */
  static open(session: CaseSession, deps: EngineDeps, opts: { runners?: Partial<Record<Role, StageRunner>> } = {}): Engine {
    const engine = new Engine(session, deps, opts);
    engine.recover();
    return engine;
  }

  /**
   * A case opened here that this process did not create may hold work a stopped process left half done: it is closed, and leftover bundle
   * folders are removed. Once per open session, so a second engine on it does not close work begun since.
   */
  recover(): void {
    if (recovered.has(this.session)) return;
    recovered.add(this.session);
    recoverSession(this.session);
    removeTempBundles(this.session, (err) => (this.deps.onError ?? logToStderr("publish"))(err));
  }

  start(actor: Actor): void {
    this.session.commit((state, ids) => {
      const { status } = state.run;
      if (status !== "none" && status !== "finished") throw new RunRefused(`a run is already ${status}; finish or stop it before starting another`);
      const { pipeline } = this.deps;
      const stages = pipeline.stages.map(({ id, title, phase, runs, gate, reviews, model }) => ({ id, title, phase, runs, gate, reviews, model }));
      return [{ type: "run.started", actor, payload: { run: ids.next("run"), pipeline: pipeline.id, pipeline_hash: pipeline.hash, stages } }];
    });
  }

  /** Carries the run as far as it goes without a person. A call made while another is in flight returns that one's promise. */
  advance(opts: { allow_capped?: boolean } = {}): Promise<RunSummary> {
    if (this.inflight !== null) return this.inflight;
    const p = this.drive(opts.allow_capped === true).finally(() => { this.inflight = null; });
    this.inflight = p;
    return p;
  }

  pause(actor: Actor): void {
    this.session.commit((state) => (["none", "finished", "paused"].includes(state.run.status) ? [] : [this.paused(actor, `paused by ${actor.id}`)]));
  }

  async resume(actor: Actor): Promise<RunSummary> {
    if (actor.kind !== "human") throw new RunRefused("only a person may resume a run");
    const written = this.session.commit((state) => (state.run.status === "paused" || state.run.status === "interrupted"
      ? [{ type: "run.resumed", actor, payload: {}, run: state.run.id }] : []));
    // the one more send-back is the person's resume of a stopped run; a resume that resumed nothing grants none
    const allow_capped = written.length > 0;
    // a drive still in flight ends on the stop it saw; the run is driven again once it has
    const running = this.inflight;
    return running === null ? this.advance({ allow_capped }) : running.then(() => this.advance({ allow_capped }));
  }

  /**
   * A person ends the run, whatever it is doing or waiting for: the one way out of a pause nothing else can clear (a pipeline changed since
   * the run started, say). A stage in flight stops at its next step. The case is anchored as closed.
   */
  stop(actor: Actor, reason: string): void {
    if (actor.kind !== "human") throw new RunRefused("only a person may stop a run");
    if (typeof reason !== "string" || reason.trim() === "") throw new RunRefused("stopping a run needs a reason");
    this.session.commit((state) => {
      const { status } = state.run;
      if (status === "none" || status === "finished") throw new RunRefused("there is no run in progress to stop");
      return [{ type: "run.finished", actor, run: state.run.id, payload: { outcome: "stopped", reason } }];
    });
    this.anchorCase("closed");
  }

  /** A person accepts the proposed plan, whole or in part, with budgets for its costly steps. Throws PlanRefused; advances nothing. */
  acceptPlan(input: { steps?: string[]; budgets?: Record<string, number>; actor: Actor }): void {
    acceptPlan(this.session, input);
  }

  denyPlan(input: { reason: string; actor: Actor }): void {
    denyPlan(this.session, input, () => this.anchorCase("closed"));
  }

  /** Asks the planner to plan again with the person's note. */
  replan(input: { note: string; actor: Actor }): void {
    requestReplan(this.session, input);
  }

  /** A person edits the draft: a new revision in their name, and review starts again. Throws ReviseRefused; advances nothing. */
  revise(input: { product: Product; reason: string; actor: Actor }): Draft {
    return reviseDraft(this.session, this.deps.pipeline, input);
  }

  /**
   * A person overrules a finding: its likelihood, its confidence, or whether it stays, with a note. Code holds every later draft to it. Off the
   * publish gate the same commit writes the person's revision that holds it (not while Assemble is working); at the gate the work goes back to
   * Assemble with the overrule as the reason. Throws OverruleRefused; advances nothing.
   */
  overrule(input: Parameters<typeof overrule>[2]): void {
    overrule(this.session, this.deps, input);
  }

  /** A person answers an open challenge. Throws ReviseRefused. */
  answerChallenge(actor: Actor, id: string, answer: string, action: "revised" | "rebutted"): void {
    answerChallenge(this.session, actor, id, answer, action);
  }

  /**
   * A person rules on reviewers who disagree: follow one of the two (its stage id), or neither, with a note. The ruling is fixed for the rest of the run:
   * it goes to the analyst, and both reviewers see it. It passes no gate and advances nothing. Throws RunRefused.
   */
  rule(actor: Actor, conflict: string, follow: string | null, note: string): void {
    if (actor.kind !== "human") throw new RunRefused("only a person may rule on a conflict");
    this.session.commit((s) => {
      const c = Object.hasOwn(s.conflicts, conflict) ? s.conflicts[conflict]! : null;
      if (c === null) throw new RunRefused(`there is no conflict ${conflict}`);
      if (c.ruling !== null) throw new RunRefused(`conflict ${conflict} has already been ruled on`);
      if (c.run !== s.run.id || s.run.status === "finished" || s.run.status === "none") throw new RunRefused(`conflict ${conflict} is from a run that is over`);
      const title = (id: string): string => s.run.stages.find((x) => x.id === id)?.title ?? id;
      if ((follow !== null && follow !== c.raised_by && follow !== c.changed_for) || (follow === null && note.trim() === "")) {
        throw new RunRefused(`a ruling follows ${title(c.raised_by)} or ${title(c.changed_for)}, or gives a note`);
      }
      return [{ type: "review.ruled", actor, run: s.run.id, payload: { conflict, follow, note } }];
    });
  }

  /** A person approves the draft at the publish gate. Throws PublishRefused and writes nothing when it may not be published. Advances nothing; the anchor is made here. */
  approve(input: { actor: Actor }): { n: number; dir: string; draft_hash: string } {
    return approve(this.session, this.deps, input);
  }

  /** A person sends the draft back to the stage the pipeline names, or stops the run. Throws PublishRefused. */
  reject(input: { reason: string; stop: boolean; actor: Actor }): void {
    reject(this.session, this.deps.pipeline, input);
    if (input.stop) this.anchorCase("closed");
  }

  /** A person's measure of effectiveness. Throws FeedbackRefused. */
  feedback(input: { measure: string; value: number | string; note: string; actor: Actor }): void {
    recordFeedback(this.session, this.deps.registry, input);
  }

  setModel(stage: string, choice: ModelChoice, actor: Actor): void {
    this.session.commit(() => [{ type: "stage.model_set", actor, payload: { stage, choice } }]);
  }

  setBudget(tokens: number | null, actor: Actor): void {
    this.session.commit(() => [{ type: "budget.set", actor, payload: { tokens } }]);
  }

  setPackLimit(stage: string, max: Marking | null, actor: Actor): void {
    this.session.commit(() => [{ type: "stage.pack_limit_set", actor, payload: { stage, max_marking: max } }]);
  }

  summary(): RunSummary {
    const { run } = this.session.state;
    return { status: run.status, waiting: run.waiting, current: run.current, pause_reason: run.pause_reason, outcome: run.outcome };
  }

  private paused(actor: Actor, reason: string, hold?: RunHold): EntryInput {
    return { type: "run.paused", actor, payload: { reason: clipReason(reason), ...(hold === undefined ? {} : { hold }) }, run: this.session.state.run.id };
  }

  /** The profile standard's likelihood terms, least likely first: what a disagreement between reviewers is described with. */
  private likelihood(): readonly string[] | undefined {
    const { profile, registry } = this.deps;
    const standard = profile.standard === null ? null : registry.get("standard", profile.standard);
    return termsOf(standard?.body ?? null)?.likelihood;
  }

  /** The hash of the pipeline the current run started with. */
  private startedWith(): string | null {
    const e = [...this.session.entries()].reverse().find((x) => x.type === "run.started");
    return e !== undefined && e.type === "run.started" ? e.payload.pipeline_hash : null;
  }

  private async drive(allowCapped: boolean): Promise<RunSummary> {
    let allow = allowCapped;
    const { status } = this.session.state.run;
    if (status === "running" && this.startedWith() !== this.deps.pipeline.hash) {
      this.session.commit(() => [this.paused(ENGINE, "the pipeline has changed since this run started")]);
      return this.summary();
    }
    const likelihood = this.likelihood();
    for (let i = 0; i < MAX_STEPS; i++) {
      const step = nextStep(this.session.state, this.deps.pipeline, { allow_capped: allow, ...(likelihood === undefined ? {} : { likelihood }) });
      allow = false;
      switch (step.kind) {
        case "idle": return this.summary();
        case "start": this.begin(step); break;
        case "exec": if (!(await this.exec(step.stage))) return this.summary(); break;
        case "gate": this.session.commit((s) => [{ type: "gate.waiting", actor: ENGINE, payload: { gate: step.gate }, run: s.run.id }]); break;
        case "pause": this.pauseFor(step); break;
        case "finish": this.finish(step.outcome); return this.summary();
      }
    }
    this.session.commit(() => [this.paused(ENGINE, "the run took more steps than expected and was paused")]);
    return this.summary();
  }

  /** The pause, and the disagreements between reviewers that made it, in one commit: what the person rules on is there when the run stops. */
  private pauseFor(step: Extract<ReturnType<typeof nextStep>, { kind: "pause" }>): void {
    this.session.commit((s, ids) => [
      ...(step.conflicts ?? []).map((c): EntryInput => ({ type: "review.conflict", actor: ENGINE, run: s.run.id, stage: c.raised_by, payload: { conflict: { id: ids.next("conflict"), ...c } } })),
      this.paused(ENGINE, step.reason, step.hold),
    ]);
  }

  private begin(step: Extract<ReturnType<typeof nextStep>, { kind: "start" }>): void {
    const manifest = this.deps.pipeline.stages.find((s) => s.id === step.stage)!;
    // one commit, so a stop between the send-back and the start cannot count the send-back twice
    this.session.commit((state) => {
      const link = { run: state.run.id, stage: step.stage };
      const out: EntryInput[] = [];
      if (step.sent_back !== null) out.push({ type: "stage.sent_back", actor: ENGINE, payload: step.sent_back, ...link });
      if (manifest.phase !== null && manifest.phase !== state.phase) out.push({ type: "case.phase_changed", actor: ENGINE, payload: { phase: manifest.phase }, ...link });
      out.push({ type: "stage.started", actor: ENGINE, payload: { stage: step.stage, attempt: step.attempt }, ...link });
      return out;
    });
  }

  /** Runs the stage; false when a person stopped it mid-way, which ends the drive. */
  private async exec(stageId: string): Promise<boolean> {
    const manifest = this.deps.pipeline.stages.find((s) => s.id === stageId)!;
    const state = this.session.state;
    const title = state.run.stages.find((s) => s.id === stageId)?.title ?? manifest.title;
    const attempt = state.run.stages.find((s) => s.id === stageId)?.attempts ?? 1;
    const runner = this.runners[manifest.role];
    let end: StageEnd;
    try {
      if (runner === undefined) end = { kind: "stalled", reason: `${title} has no runner for the role ${manifest.role}.` };
      else end = await runner({ session: this.session, deps: this.deps, stage: manifest, attempt, onNeedsBudget: (p, s) => spendPlanBudget(this.session, this.deps.runner, p, s) });
    } catch (err) {
      end = { kind: "stalled", reason: `${title} failed unexpectedly: ${firstLine(err instanceof Error ? err.message : String(err))}` };
    }
    const link = { run: state.run.id, stage: stageId };
    const finish = (outcome: "pass" | "fail" | "declined", draft_hash: string | null, output: Json | null, reason: string | null): EntryInput => ({
      type: "stage.finished", actor: ENGINE, ...link,
      payload: { stage: stageId, attempt, outcome, draft_hash, output: output === null ? null : this.session.blobs.put(canonical(output)), reason: reason === null ? null : clipReason(reason) },
    });
    // a review that does not name the draft it reviewed has reviewed nothing: it fails, rather than being run again for ever
    let supersededBy: string | null = null;
    if (end.kind === "finished" && end.outcome === "pass" && manifest.reviews) {
      const latestD = latestDraft(this.session.state);
      const latest = latestD?.hash ?? null;
      // the one exception: a person edited the draft while the stage worked. Its verdict stays on the hash it examined, and review of the edit starts over
      const named = end.draft_hash;
      const edited = latestD !== null && latestD.author.kind === "human" && named !== null && this.session.state.drafts.some((d) => d.hash === named);
      if (named !== null && named !== latest && edited) supersededBy = latest;
      else if (end.draft_hash === null || end.draft_hash !== latest) end = { kind: "finished", outcome: "fail", draft_hash: latest, output: end.output, reason: `${title} did not review the latest draft` };
    } else if (end.kind === "finished" && end.outcome === "fail" && manifest.reviews) {
      const latestD = latestDraft(this.session.state);
      const named = end.draft_hash;
      if (latestD !== null && latestD.author.kind === "human" && named !== null && named !== latestD.hash && this.session.state.drafts.some((d) => d.hash === named)) supersededBy = latestD.hash;
    }
    // a stage that ends after a person stopped the run (or after another run began) writes nothing
    const gone = (s: Readonly<CaseState>): boolean => s.run.id !== state.run.id || s.run.status === "finished";
    switch (end.kind) {
      case "finished":
        return this.session.commit((s) => {
          if (gone(s)) return [];
          const out = [finish(end.outcome, end.draft_hash, end.output, end.reason)];
          if (supersededBy !== null) {
            const first = firstUnpassedReview(s, this.deps.pipeline);
            if (first !== null) out.push({ type: "stage.started", actor: ENGINE, ...link, stage: first, payload: { stage: first, attempt: (s.run.stages.find((x) => x.id === first)?.attempts ?? 0) + 1 } });
          }
          return out;
        }).length > 0;
      case "declined":
        return this.session.commit((s) => (gone(s) ? [] : [
          finish("declined", null, null, end.reason),
          this.paused(ENGINE, `The model declined at ${title}: ${end.reason}. Choose another model and resume.`),
        ])).length > 0;
      case "blocked":
        return this.session.commit((s) => (gone(s) ? [] : [this.paused(ENGINE, this.blockedReason(s, stageId, title, end.marking))])).length > 0;
      case "stalled":
        return this.session.commit((s) => (gone(s) ? [] : [this.paused(ENGINE, end.reason)])).length > 0;
      case "stopped":
        return false;
    }
  }

  /** Why a blocked stage paused the run: the case itself when its own marking may not go to the stage's model, else the stricter items. */
  private blockedReason(s: Readonly<CaseState>, stageId: string, title: string, marking: Marking): string {
    // this stage's own block: your agent writes model.blocked too (stage "agent"), and its model is not this stage's
    const blocked = [...this.session.entries()].reverse().find((e) => e.type === "model.blocked" && e.payload.stage === stageId);
    const caseMarking = s.meta?.marking ?? null;
    if (blocked !== undefined && blocked.type === "model.blocked" && caseMarking !== null) {
      const limit = Object.hasOwn(s.pack_limits, stageId) ? s.pack_limits[stageId]! : null;
      if (!mayGo(caseMarking, blocked.payload.where, this.deps.config.marking_policy) || tooStrict(caseMarking, limit)) {
        return `${title}: this case is marked ${caseMarking}, which this stage's model may not receive. Choose a model that may receive ${caseMarking} and resume.`;
      }
    }
    return `${title}: the chosen model may not receive data marked ${marking}. Choose an allowed model, or leave the stricter items out, and resume.`;
  }

  private finish(outcome: "published" | "stopped"): void {
    this.session.commit((s) => [{ type: "run.finished", actor: ENGINE, payload: { outcome }, run: s.run.id }]);
    // a published run was anchored when the person approved the product; only a run that ends without one is anchored here
    if (outcome === "stopped") this.anchorCase("closed");
  }

  private anchorCase(why: "published" | "closed"): void {
    const head = this.session.head();
    this.deps.anchor?.({ case: this.session.id, seq: head.seq, hash: head.hash, why });
  }
}
