import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import type { CaseSession } from "../core/session";
import type { RunState } from "../core/state";
import { latestDraft } from "../core/state";
import type { Actor, Draft, EntryInput, Marking, ModelChoice, Product } from "../core/types";
import type { Providers, } from "../agents/providers";
import type { Profile } from "../agents/context";
import type { Config } from "../modules/config";
import type { Registry } from "../modules/registry";
import type { RunnerDeps, RunQueryResult } from "../modules/runner";
import type { Seeker } from "../modules/seeker";
import type { Pipeline, Role, StageManifest } from "./manifests";
import { firstUnpassedReview, nextStep } from "./next";
import { acceptPlan, denyPlan, requestReplan, spendPlanBudget } from "./plans";
import { answerChallenge, reviseDraft } from "./revise";
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
export class RunRefused extends Error {
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

export class Engine {
  private inflight: Promise<RunSummary> | null = null;
  private readonly runners: Partial<Record<Role, StageRunner>>;

  constructor(private readonly session: CaseSession, private readonly deps: EngineDeps, opts: { runners?: Partial<Record<Role, StageRunner>> } = {}) {
    this.runners = { frame: frameRunner, plan: planRunner, research: researchRunner, assemble: assembleRunner, checks: checksRunner, evaluate: evaluateRunner, challenge: challengeRunner, publish: publishRunner, feedback: feedbackRunner, ...opts.runners };
    // A case opened here that this process did not create may hold work a stopped process left half done.
    if (!recovered.has(session)) {
      recovered.add(session);
      recoverSession(session);
      removeTempBundles(session, (err) => (deps.onError ?? logToStderr("publish"))(err));
    }
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
    this.session.commit((state) => (state.run.status === "paused" || state.run.status === "interrupted"
      ? [{ type: "run.resumed", actor, payload: {}, run: state.run.id }] : []));
    // a drive still in flight ends on the stop it saw; the run is driven again once it has
    const running = this.inflight;
    return running === null ? this.advance({ allow_capped: true }) : running.then(() => this.advance({ allow_capped: true }));
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

  /** A person answers an open challenge. Throws ReviseRefused. */
  answerChallenge(actor: Actor, id: string, answer: string, action: "revised" | "rebutted"): void {
    answerChallenge(this.session, actor, id, answer, action);
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

  private paused(actor: Actor, reason: string): EntryInput {
    return { type: "run.paused", actor, payload: { reason }, run: this.session.state.run.id };
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
    for (let i = 0; i < MAX_STEPS; i++) {
      const step = nextStep(this.session.state, this.deps.pipeline, { allow_capped: allow });
      allow = false;
      switch (step.kind) {
        case "idle": return this.summary();
        case "start": this.begin(step); break;
        case "exec": if (!(await this.exec(step.stage))) return this.summary(); break;
        case "gate": this.session.commit((s) => [{ type: "gate.waiting", actor: ENGINE, payload: { gate: step.gate }, run: s.run.id }]); break;
        case "pause": this.session.commit(() => [this.paused(ENGINE, step.reason)]); break;
        case "finish": this.finish(step.outcome); return this.summary();
      }
    }
    this.session.commit(() => [this.paused(ENGINE, "the run took more steps than expected and was paused")]);
    return this.summary();
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
      payload: { stage: stageId, attempt, outcome, draft_hash, output: output === null ? null : this.session.blobs.put(canonical(output)), reason },
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
    switch (end.kind) {
      case "finished":
        this.session.commit((s) => {
          const out = [finish(end.outcome, end.draft_hash, end.output, end.reason)];
          if (supersededBy !== null) {
            const first = firstUnpassedReview(s, this.deps.pipeline);
            if (first !== null) out.push({ type: "stage.started", actor: ENGINE, ...link, stage: first, payload: { stage: first, attempt: (s.run.stages.find((x) => x.id === first)?.attempts ?? 0) + 1 } });
          }
          return out;
        });
        return true;
      case "declined":
        this.session.commit(() => [
          finish("declined", null, null, end.reason),
          this.paused(ENGINE, `The model declined at ${title}: ${end.reason}. Choose another model and resume.`),
        ]);
        return true;
      case "blocked":
        this.session.commit(() => [this.paused(ENGINE, `${title}: the chosen model may not receive data marked ${end.marking}. Choose an allowed model, or leave the stricter items out, and resume.`)]);
        return true;
      case "stalled":
        this.session.commit(() => [this.paused(ENGINE, end.reason)]);
        return true;
      case "stopped":
        return false;
    }
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
