import { Refused } from "../core/refused";
import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import type { CaseSession } from "../core/session";
import type { CaseState, RunState } from "../core/state";
import { CASE_TYPE_ID, gateChanges, latestDraft, loopOf, runQuestions, waitingOn } from "../core/state";
import type { Actor, Draft, EntryInput, LessonOrigin, Marking, ModelChoice, Product, RunHold } from "../core/types";
import type { LessonDraft, StoreState } from "../core/lessons";
import type { CaseType } from "../modules/case-types";
import { termsOf } from "../agents/draft";
import { mayGo, tooStrict } from "../agents/pack";
import type { Providers } from "../agents/providers";
import type { Profile } from "../agents/context";
import type { Config } from "../modules/config";
import type { Registry } from "../modules/registry";
import type { RunnerDeps, RunQueryResult } from "../modules/runner";
import type { Seeker } from "../modules/seeker";
import type { Pipeline, Role, StageManifest } from "./manifests";
import type { Components } from "./components";
import { IMPLICIT_NOTE } from "./loops";
import type { LoopCatalog, LoopLock, LoopOutput, ResolvedLoop } from "./loops";
import type { BlobStore } from "../core/blobs";
import { firstUnpassedReview, nextStep } from "./next";
import type { Step } from "./next";
import { acceptPlan, denyPlan, requestReplan, spendPlanBudget } from "./plans";
import { answerChallenge, reviseDraft } from "./revise";
import { gateSendBack, overrule, overruleSendBack } from "./overrule";
import { preparedAnswer, waitingReason } from "./questions";
import { bindEntry, isCaseTypeQuestion, TYPE_GAP, typeOfAnswer } from "./memory";
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
import { subloopRunner } from "./stages/subloop";
import { childRefOf, childWaitReason, outputsOf } from "./subloop";
import type { ChildCases } from "./subloop";

export interface EngineDeps {
  config: Config; registry: Registry; runner: RunnerDeps; seeker: Seeker; providers: Providers; pipeline: Pipeline; profile: Profile;
  /** Every loop of the roots, resolved; the components of the default loop; the content store (the workbench chain's blobs). Set by compose. */
  loops?: LoopCatalog; components?: Components; content?: BlobStore;
  /** Where problems that do not stop the work are reported (a failed anchor, a leftover folder, a missing objective); stderr when absent. */
  onError?: (error: unknown) => void;
  anchor?: (a: { case: string; seq: number; hash: string; why: "published" | "closed" }) => void;
  /** Called once when a run ends published or completed, with the outputs its loop declares (outputsOf the case's state at its end). */
  onOutputs?: (o: { case: string; loop: string; run: string; head: { seq: number; hash: string }; outcome: "published" | "completed"; marking: Marking; outputs: Record<string, Json> }) => void;
  /**
   * Keeps what this deps' runner uses (its connector pool) open until the returned release is called, even after a reload has replaced it.
   * Set by compose. A bound run holds it from the time it binds until it ends, so a query in flight across a reload completes.
   */
  retain?: () => () => void;
  /** How a stage that runs a loop reaches its child cases: the host's (the hub's, run.ts's). Without it such a stage stalls. */
  children?: ChildCases;
  /**
   * The lock of the version the case's run is bound to (or a new run would bind), set by Engine.bound: a sub-loop stage runs its child on the
   * version of the child's loop that this lock names.
   */
  lock?: LoopLock;
  memory?: MemoryHost;
  case_types?: readonly CaseType[];
}
/** How the engine reaches the shared store: the host's. It reads at a bind and files proposals; it never accepts. */
export interface MemoryHost {
  read(): { state: Readonly<StoreState>; origin: string | null; head: { seq: number; hash: string } };
  /** Files a proposal by the workbench ({ kind: "system", id: "feedback" }). Throws Refused. */
  propose(draft: LessonDraft, from: LessonOrigin): { lesson: string; fresh: boolean };
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
  /** A sub-loop stage's child has not finished and waits on something the engine cannot do (a person, most often): the run waits on it. */
  | { kind: "waiting_child"; child: string; reason: string }
  | { kind: "stopped" };
export type StageRunner = (env: StageEnv) => Promise<StageEnd>;
export interface RunSummary { status: RunState["status"]; waiting: "plan" | "publish" | null; current: string | null; pause_reason: string | null; outcome: RunState["outcome"] }
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
/** Why a bound run cannot be rebuilt here: its lock, or a hash the lock names, is not in this workbench's content store. */
export const NOT_IN_WORKBENCH = "this run's loop version is not in this workbench; import its loop file";
/** A run is in progress: started, and not finished. */
const inProgress = (s: Readonly<CaseState>): boolean => s.run.id !== null && s.run.status !== "none" && s.run.status !== "finished";
/** The first problem that stops a loop, for a refusal or a pause. */
const firstProblem = (loops: LoopCatalog, id: string): string => loops.problems(id).filter((p) => p !== IMPLICIT_NOTE)[0] ?? `the loop "${id}" is not usable`;
/** The most of a reason a stage.finished or run.paused keeps: a stage's reason can be a model's text, and an entry has a size limit. */
export const REASON_CHARS = 4000;
const clipReason = (reason: string): string => (reason.length > REASON_CHARS ? `${reason.slice(0, REASON_CHARS - 1)}…` : reason);

/** The detail of the answer card a person's set_case_type writes: the sentence is the workbench's, the type the person's. */
export const WORDED = "the workbench worded this answer from the case type the person set";

export class Engine {
  private inflight: Promise<RunSummary> | null = null;
  private readonly runners: Partial<Record<Role, StageRunner>>;
  /**
   * The run in progress that bound a loop version, with its own copy of the deps taken when it bound: the pipeline, profile and components of
   * its lock, and the registry, runner and the rest as they were then. A reload changes nothing here. `release` lets go of the connector pool.
   */
  private held: { run: string; deps: EngineDeps; loop: ResolvedLoop; release: (() => void) | null } | null = null;
  /** The run in progress that bound a version this workbench cannot rebuild. */
  private lost: { run: string; why: string } | null = null;

  /** Builds an engine and writes nothing: a read (a status, a replay) can use one. A command that acts opens it with Engine.open. */
  constructor(private readonly session: CaseSession, private readonly deps: EngineDeps, opts: { runners?: Partial<Record<Role, StageRunner>> } = {}) {
    this.runners = { frame: frameRunner, plan: planRunner, research: researchRunner, assemble: assembleRunner, checks: checksRunner, evaluate: evaluateRunner, challenge: challengeRunner, publish: publishRunner, feedback: feedbackRunner, subloop: subloopRunner, ...opts.runners };
    this.bind();
  }

  /**
   * The deps this engine works with now: the given ones with pipeline, profile and components those of the case's run (its bound version, or
   * the current version of its loop). A run that bound a version keeps the copy it bound with until it ends. A run from before slice 12 (no
   * loop.bound) gets the current version's pipeline and profile and no components, so its stages read the registry as they did. With no
   * `deps.loops`, the given deps.
   */
  get bound(): EngineDeps {
    if (this.deps.loops === undefined) return this.deps;
    this.bind();
    if (this.held !== null) return this.held.deps;
    if (this.lost !== null) return this.deps;
    const loop = this.current();
    if (loop === null) return this.deps;
    if (inProgress(this.session.state)) {
      const { components: _components, ...rest } = this.deps;
      return { ...rest, pipeline: loop.pipeline, profile: loop.profile };
    }
    return { ...this.deps, pipeline: loop.pipeline, profile: loop.profile, components: loop.components, lock: loop.lock };
  }

  /** Why the engine cannot use the case's loop (a lock whose content is missing, a loop that is not usable); null when it can. */
  get unusable(): string | null {
    const loops = this.deps.loops;
    if (loops === undefined) return null;
    this.bind();
    if (this.held !== null) return null;
    if (this.lost !== null) return this.lost.why;
    const id = loopOf(this.session.state, this.deps.config.loops.default);
    return loops.current(id) === null ? firstProblem(loops, id) : null;
  }

  /** The resolved loop behind `bound`: its manifest (inputs, outputs), its lock. Null when deps.loops is absent. */
  get loop(): ResolvedLoop | null {
    if (this.deps.loops === undefined) return null;
    this.bind();
    return this.held?.loop ?? (this.lost !== null ? null : this.current());
  }

  /** Lets go of what the bound run holds (its connector pool). The host calls it when it forgets this engine. */
  close(): void {
    this.held?.release?.();
    this.held = null;
    this.lost = null;
  }

  /** The current version of the case's loop, or null when it is not usable. */
  private current(): ResolvedLoop | null {
    return this.deps.loops?.current(loopOf(this.session.state, this.deps.config.loops.default)) ?? null;
  }

  /**
   * Binds the run in progress to the version its loop.bound names, rebuilt from its lock and the content store, once per run; lets go of a run
   * that has ended. A run with no loop.bound is legacy and binds nothing.
   */
  private bind(): void {
    const loops = this.deps.loops;
    if (loops === undefined) return;
    const s = this.session.state;
    const run = inProgress(s) ? s.run.id : null;
    if (run !== null && (this.held?.run === run || this.lost?.run === run)) return;
    this.close();
    if (run === null || s.loop.bound === null) return;
    let made: ResolvedLoop | string;
    try {
      const lock = loops.readLock(this.session.blobs.get(s.loop.bound.lock.blob));
      made = lock === null ? NOT_IN_WORKBENCH : loops.fromLock(lock);
    } catch {
      made = NOT_IN_WORKBENCH;
    }
    if (typeof made === "string") {
      this.lost = { run, why: NOT_IN_WORKBENCH };
      return;
    }
    const deps: EngineDeps = { ...this.deps, pipeline: made.pipeline, profile: made.profile, components: made.components, lock: made.lock };
    this.held = { run, deps, loop: made, release: this.deps.retain?.() ?? null };
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

  /**
   * Starts a run. With loops, it binds the current version of the case's loop, or `opts.loop` (a child's run binds the version its parent's lock
   * names): the lock goes in the case's blobs, and loop.bound and run.started are one commit. Throws RunRefused, writing nothing, when a run is in
   * progress, the loop is not usable (its first problem), or `opts.loop` is another loop's.
   */
  start(actor: Actor, opts: { loop?: ResolvedLoop } = {}): void {
    const loops = this.deps.loops;
    this.session.commit((state, ids) => {
      const { status } = state.run;
      if (status !== "none" && status !== "finished") throw new RunRefused(`a run is already ${status}; finish or stop it before starting another`);
      const stagesOf = (pipeline: Pipeline) => pipeline.stages.map(({ id, title, phase, runs, gate, reviews, model }) => ({ id, title, phase, runs, gate, reviews, model }));
      if (loops === undefined) {
        const { pipeline } = this.deps;
        return [{ type: "run.started", actor, payload: { run: ids.next("run"), pipeline: pipeline.id, pipeline_hash: pipeline.hash, stages: stagesOf(pipeline) } }];
      }
      const id = loopOf(state, this.deps.config.loops.default);
      if (opts.loop !== undefined && opts.loop.lock.loop !== id) throw new RunRefused(`this case is for loop "${id}", not "${opts.loop.lock.loop}"`);
      const loop = opts.loop ?? loops.current(id);
      if (loop === null) throw new RunRefused(firstProblem(loops, id));
      const { pipeline } = loop;
      const lock = this.session.blobs.put(canonical(loop.lock as unknown as Json));
      // what the run is given from the shared store, chosen in code and locked into the case: read once, here
      const memory = bindEntry(this.session, state, loop, this.deps, actor);
      return [
        { type: "loop.bound", actor, payload: { loop: id, version: loop.manifest.version, hash: pipeline.hash, lock } },
        ...(memory === null ? [] : [memory]),
        { type: "run.started", actor, payload: { run: ids.next("run"), pipeline: id, pipeline_hash: pipeline.hash, stages: stagesOf(pipeline) } },
      ];
    });
    this.bind();
  }

  /**
   * A person sets the case's type (null clears it). During a run in progress whose loop reads shared memory, the same commit binds memory again,
   * so the stages that start afterwards read the lessons of the new type. When the run waits on Frame's question of the case's type, the same
   * commit answers it. Advances nothing. Throws RunRefused.
   */
  setCaseType(input: { type: string | null; actor: Actor }): void {
    const { type, actor } = input;
    this.mayType(actor, type);
    const open = this.openTypeQuestion();
    const statement = type === null ? "This case has no case type." : `This is a ${this.deps.case_types?.find((t) => t.id === type)?.title ?? type} case (case type ${type}).`;
    const answer = open === null ? null : preparedAnswer(this.session, this.deps.runner, { actor, question: open, answer: statement, basis: "unstated", detail: WORDED, about: null, marking: null });
    this.bind();
    this.session.commit((s, ids) => {
      if (s.memory.type === type) throw new RunRefused("that is already this case's type");
      return [...this.typed(s, type, actor), ...(answer === null ? [] : answer.entries(s, ids).entries)];
    });
  }

  /**
   * A person answers Frame's question of the case's type: a case type's id, yes for the type Frame proposed, or none. The answer, and the type
   * when it changes (with memory bound again), are one commit. Advances nothing. Throws RunRefused, or PersonRefused as an answer does.
   */
  answerCaseType(input: { question: string; answer: string; actor: Actor }): void {
    const { actor } = input;
    if (actor.kind !== "human") throw new RunRefused("only a person sets a case's type");
    const state = this.session.state;
    const q = Object.hasOwn(state.questions, input.question) ? state.questions[input.question]! : null;
    if (q === null || !isCaseTypeQuestion(q)) throw new RunRefused(`${input.question.slice(0, 40)} is not the question of this case's type`);
    const named = typeOfAnswer(input.answer, this.deps.case_types ?? [], state.memory.proposed_type?.type ?? null);
    if (typeof named === "string") throw new RunRefused(named);
    if (named.type !== state.memory.type) this.mayType(actor, named.type);
    const answer = preparedAnswer(this.session, this.deps.runner, { actor, question: q.id, answer: input.answer.trim(), basis: "unstated", detail: "", about: null, marking: null });
    this.bind();
    this.session.commit((s, ids) => [...(s.memory.type === named.type ? [] : this.typed(s, named.type, actor)), ...answer.entries(s, ids).entries]);
  }

  /** Refuses a type a person may not set here: by anyone but a person, or a type that is not loaded. */
  private mayType(actor: Actor, type: string | null): void {
    if (actor.kind !== "human") throw new RunRefused("only a person sets a case's type");
    if (type !== null && (!CASE_TYPE_ID.test(type) || (this.deps.case_types !== undefined && !this.deps.case_types.some((t) => t.id === type)))) {
      throw new RunRefused(`there is no case type "${type.slice(0, 64)}"`);
    }
  }

  /** The open question of the case's type in the run in progress, not answered and not waived; null when there is none. */
  private openTypeQuestion(): string | null {
    const s = this.session.state;
    if (!inProgress(s)) return null;
    return runQuestions(s).find((q) => isCaseTypeQuestion(q) && q.answer === null && q.waived === null)?.id ?? null;
  }

  /** case.type_set by the person and, during a run bound to a loop that reads shared memory, memory.bound for the new type. */
  private typed(s: Readonly<CaseState>, type: string | null, actor: Actor): EntryInput[] {
    if (!inProgress(s)) return [{ type: "case.type_set", actor, payload: { type } }];
    const link = { run: s.run.id };
    const loop = this.held?.run === s.run.id ? this.held.loop : null;
    const memory = loop === null ? null : bindEntry(this.session, s, loop, this.deps, actor, type);
    return [{ type: "case.type_set", actor, payload: { type }, ...link }, ...(memory === null ? [] : [{ ...memory, ...link }])];
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
   * Code's resume of a pause that waits on this child. Writes run.resumed by the engine only when the run is paused with hold { kind: "child", child };
   * then advances. Passes no gate. A child that is still where the pause says it was (the same reason) changes nothing, and nothing is written.
   */
  async childSettled(child: string): Promise<RunSummary> {
    const children = this.deps.children;
    // the child the run waits on, as its record names it: a case here with that id that is not that child settled nothing of this run's
    const s0 = this.session.state;
    const hold0 = s0.run.status === "paused" ? s0.run.hold : null;
    const rec = hold0?.kind === "child" ? Object.values(s0.loop.children).find((c) => c.run === s0.run.id && c.stage === hold0.stage && c.child === child && c.finished === null) : undefined;
    const ref = rec === undefined ? null : childRefOf(this.session.id, rec);
    const view = children === undefined || ref === null ? null : (() => { try { return children.read(ref); } catch { return null; } })();
    if (children !== undefined && ref !== null && view === null) return this.summary();
    const written = this.session.commit((s) => {
      const hold = s.run.status === "paused" ? s.run.hold : null;
      if (hold?.kind !== "child" || hold.child !== child) return [];
      if (view !== null && view.state.run.status !== "finished" && s.run.pause_reason === clipReason(`waiting on child ${child}: ${childWaitReason(view.state)}`)) return [];
      return [{ type: "run.resumed", actor: ENGINE, payload: {}, run: s.run.id }];
    });
    if (written.length === 0) return this.summary();
    const running = this.inflight;
    return running === null ? this.advance() : running.then(() => this.advance());
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
    this.bind();
  }

  /** A person accepts the proposed plan, whole or in part, with budgets for its costly steps. Throws PlanRefused; advances nothing. */
  acceptPlan(input: { steps?: string[]; budgets?: Record<string, number>; actor: Actor }): void {
    acceptPlan(this.session, input);
  }

  denyPlan(input: { reason: string; actor: Actor }): void {
    denyPlan(this.session, input, () => this.anchorCase("closed"));
    this.bind();
  }

  /** Asks the planner to plan again with the person's note. */
  replan(input: { note: string; actor: Actor }): void {
    requestReplan(this.session, input);
  }

  /** A person edits the draft: a new revision in their name, and review starts again. Throws ReviseRefused; advances nothing. */
  revise(input: { product: Product; reason: string; actor: Actor }): Draft {
    return reviseDraft(this.session, this.bound.pipeline, input);
  }

  /**
   * A person overrules a finding: its likelihood, its confidence, or whether it stays, with a note. Code holds every later draft to it. At the
   * publish gate it waits for sendBackChanges; elsewhere in a run the work goes back when the current stage ends.
   * Throws OverruleRefused; advances nothing.
   */
  overrule(input: Parameters<typeof overrule>[2]): void {
    overrule(this.session, this.bound, input);
  }

  /** A person answers an open challenge. Throws ReviseRefused. */
  answerChallenge(actor: Actor, id: string, answer: string, action: "revised" | "rebutted"): void {
    answerChallenge(this.session, actor, id, answer, action);
  }

  /**
   * A person rules on reviewers who disagree: follow one of the two (its stage id), or neither, with a note. A ruling holds until it is replaced:
   * it goes to the analyst, and both reviewers see it. The person may rule again while the run is in progress; at the publish gate a revised
   * ruling waits for sendBackChanges (slice 10, reversing controller ruling 6). It passes no gate. Throws RunRefused.
   */
  rule(actor: Actor, conflict: string, follow: string | null, note: string): void {
    if (actor.kind !== "human") throw new RunRefused("only a person may rule on a conflict");
    this.session.commit((s) => {
      const c = Object.hasOwn(s.conflicts, conflict) ? s.conflicts[conflict]! : null;
      if (c === null) throw new RunRefused(`there is no conflict ${conflict}`);
      if (c.run !== s.run.id || s.run.status === "finished" || s.run.status === "none") throw new RunRefused(`conflict ${conflict} is from a run that is over`);
      const title = (id: string): string => s.run.stages.find((x) => x.id === id)?.title ?? id;
      if ((follow !== null && follow !== c.raised_by && follow !== c.changed_for) || (follow === null && note.trim() === "")) {
        throw new RunRefused(`a ruling follows ${title(c.raised_by)} or ${title(c.changed_for)}, or gives a note`);
      }
      if (c.ruling !== null && c.ruling.follow === follow && c.ruling.note.trim() === note.trim()) throw new RunRefused(`that is already the ruling on ${conflict}`);
      return [{ type: "review.ruled", actor, run: s.run.id, payload: { conflict, follow, note } }];
    });
  }

  /**
   * "Send back to Assemble with my changes": at the publish gate, the person sends the draft on screen back to the stage the gate sends work back to,
   * with every change of theirs since it was made (gateChanges: overrules, revised rulings, answers) as the reason, in their name. It passes no gate;
   * the server advances after it. Throws RunRefused.
   */
  sendBackChanges(actor: Actor, draft_hash: string): void {
    if (actor.kind !== "human") throw new RunRefused("only a person may send the draft back with their changes");
    const entries = this.session.entries();
    this.session.commit((s) => {
      if (s.run.status === "none" || s.run.status === "finished" || s.run.waiting !== "publish") throw new RunRefused("the run is not waiting at the publish gate");
      const d = latestDraft(s);
      if (d === null || d.hash !== draft_hash) throw new RunRefused("a newer draft arrived; look at it before sending it back");
      const changes = gateChanges(s, entries);
      if (changes.length === 0) throw new RunRefused(`there is no change of yours since draft ${d.n} was made: nothing to send back`);
      const back = gateSendBack(s, this.bound.pipeline, changes.map((c) => c.reason).join("\n"), actor);
      if (back.length === 0) throw new RunRefused("the publish gate sends work back nowhere");
      return back;
    });
  }

  /**
   * A person approves the draft at the publish gate. Throws PublishRefused and writes nothing when it may not be published. Advances nothing; the anchor is
   * made here. `unload_after` is recorded, not acted on: the engine holds a session, not the workbench, so the host unloads once `unloadDue(state)`.
   */
  approve(input: { actor: Actor; unload_after?: boolean }): { n: number; dir: string; draft_hash: string } {
    return approve(this.session, this.bound, input);
  }

  /** A person sends the draft back to the stage the pipeline names, or stops the run. Throws PublishRefused. */
  reject(input: { reason: string; stop: boolean; actor: Actor }): void {
    reject(this.session, this.bound.pipeline, input);
    if (input.stop) this.anchorCase("closed");
    this.bind();
  }

  /** A person's measure of effectiveness. Throws FeedbackRefused. */
  feedback(input: { measure: string; value: number | string; note: string; actor: Actor }): void {
    recordFeedback(this.session, this.bound.registry, input);
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
  private likelihood(d: EngineDeps): readonly string[] | undefined {
    const { profile, registry, components } = d;
    const standard = profile.standard === null ? null : components !== undefined ? components.get("*", "standard", profile.standard) : registry.get("standard", profile.standard);
    return termsOf(standard?.body ?? null)?.likelihood;
  }

  /** The hash of the pipeline the current run started with. */
  private startedWith(): string | null {
    const e = [...this.session.entries()].reverse().find((x) => x.type === "run.started");
    return e !== undefined && e.type === "run.started" ? e.payload.pipeline_hash : null;
  }

  private async drive(allowCapped: boolean): Promise<RunSummary> {
    let allow = allowCapped;
    const d = this.bound;
    const { status } = this.session.state.run;
    if (status === "running") {
      // fail closed: a run whose loop cannot be used (a lock whose content is missing, a component that cannot load) does nothing
      const why = this.unusable;
      if (why !== null) {
        this.session.commit(() => [this.paused(ENGINE, why)]);
        return this.summary();
      }
      // a bound run reads its lock and never meets a changed pipeline. A run started before slice 12 recorded the old formula's hash of the
      // same stages, which a loop keeps as legacy_hash, and is held to its loop as the root has it now
      const started = this.startedWith();
      if (this.held === null && (started === null || (started !== d.pipeline.hash && started !== d.pipeline.legacy_hash))) {
        this.session.commit(() => [this.paused(ENGINE, "the pipeline has changed since this run started")]);
        return this.summary();
      }
    }
    const likelihood = this.likelihood(d);
    for (let i = 0; i < MAX_STEPS; i++) {
      const next = nextStep(this.session.state, d.pipeline, { allow_capped: allow, ...(likelihood === undefined ? {} : { likelihood }) });
      const step = this.overruled(next, d);
      allow = false;
      switch (step.kind) {
        case "idle": return this.summary();
        case "start": this.begin(step, d); break;
        case "exec": if (!(await this.exec(step.stage, d))) return this.summary(); break;
        case "gate": this.session.commit((s) => [{ type: "gate.waiting", actor: ENGINE, payload: { gate: step.gate }, run: s.run.id }]); break;
        case "pause": this.pauseFor(step); break;
        case "finish": this.finish(step.outcome, d); return this.summary();
      }
    }
    this.session.commit(() => [this.paused(ENGINE, "the run took more steps than expected and was paused")]);
    return this.summary();
  }

  /**
   * The step an overrule made during the run takes in place of `step` once the current stage has ended (controller ruling on I4): the work goes
   * back to Assemble with the overrule as the reason, as at the publish gate. A stage still working, and a run that finishes, are left as they are.
   */
  private overruled(step: Step, d: EngineDeps): Step {
    if (step.kind !== "start" && step.kind !== "gate" && step.kind !== "pause") return step;
    const s = this.session.state;
    const current = s.run.stages.find((x) => x.id === s.run.current);
    if (current === undefined || (current.status !== "passed" && current.status !== "failed")) return step;
    const back = overruleSendBack(s, this.session.entries(), d.pipeline);
    return back === null ? step : { kind: "start", ...back };
  }

  /** The pause, and the disagreements between reviewers that made it, in one commit: what the person rules on is there when the run stops. */
  private pauseFor(step: Extract<ReturnType<typeof nextStep>, { kind: "pause" }>): void {
    this.session.commit((s, ids) => [
      ...(step.conflicts ?? []).map((c): EntryInput => ({ type: "review.conflict", actor: ENGINE, run: s.run.id, stage: c.raised_by, payload: { conflict: { id: ids.next("conflict"), ...c } } })),
      this.paused(ENGINE, step.reason, step.hold),
    ]);
  }

  private begin(step: Extract<ReturnType<typeof nextStep>, { kind: "start" }>, d: EngineDeps): void {
    const manifest = d.pipeline.stages.find((s) => s.id === step.stage)!;
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
  private async exec(stageId: string, d: EngineDeps): Promise<boolean> {
    const manifest = d.pipeline.stages.find((s) => s.id === stageId)!;
    const state = this.session.state;
    const title = state.run.stages.find((s) => s.id === stageId)?.title ?? manifest.title;
    const attempt = state.run.stages.find((s) => s.id === stageId)?.attempts ?? 1;
    // a stage that runs a loop is a sub-loop stage, whatever its role
    const runner = manifest.runs === "loop" ? this.runners.subloop : this.runners[manifest.role];
    let end: StageEnd;
    try {
      if (runner === undefined) end = { kind: "stalled", reason: `${title} has no runner for the role ${manifest.role}.` };
      else end = await runner({ session: this.session, deps: d, stage: manifest, attempt, onNeedsBudget: (p, s) => spendPlanBudget(this.session, d.runner, p, s) });
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
      case "finished": {
        const written = this.session.commit((s) => {
          if (gone(s)) return [];
          const out = [finish(end.outcome, end.draft_hash, end.output, end.reason)];
          if (supersededBy !== null) {
            const first = firstUnpassedReview(s, d.pipeline);
            if (first !== null) out.push({ type: "stage.started", actor: ENGINE, ...link, stage: first, payload: { stage: first, attempt: (s.run.stages.find((x) => x.id === first)?.attempts ?? 0) + 1 } });
          }
          // a pass with a blocking question of this stage unanswered stands, and the run waits for the answer before the next stage (controller
          // ruling 4): an answer or a person's resume takes it on, and a resume without the answer waives the question; the stage does not run again
          const waiting = end.outcome === "pass" ? waitingOn(s, stageId) : [];
          // a resume that waives the question of the case's type goes on with no lessons: the pause says so
          const gap = waiting.some(isCaseTypeQuestion) ? ` A resume without the case's type goes on with ${TYPE_GAP}.` : "";
          if (waiting.length > 0) out.push(this.paused(ENGINE, `${waitingReason(waiting)}${gap}`, { kind: "question", stage: stageId }));
          return out;
        });
        return written.length > 0 && written.at(-1)!.type !== "run.paused";
      }
      case "declined":
        return this.session.commit((s) => (gone(s) ? [] : [
          finish("declined", null, null, end.reason),
          this.paused(ENGINE, `The model declined at ${title}: ${end.reason}. Choose another model and resume.`),
        ])).length > 0;
      case "blocked":
        return this.session.commit((s) => (gone(s) ? [] : [this.paused(ENGINE, this.blockedReason(s, stageId, title, end.marking))])).length > 0;
      case "stalled":
        return this.session.commit((s) => (gone(s) ? [] : [this.paused(ENGINE, end.reason)])).length > 0;
      case "waiting_child": {
        const hold: RunHold = { kind: "child", stage: stageId, child: end.child };
        const reason = clipReason(`waiting on child ${end.child}: ${end.reason}`);
        // written only over a running run: a run already paused (with this same hold and reason, or by a person while the child was driven) keeps its pause,
        // so childSettled never lifts a person's own pause
        this.session.commit((s) => (gone(s) || s.run.status !== "running" ? [] : [this.paused(ENGINE, reason, hold)]));
        return false;
      }
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

  private finish(outcome: "published" | "completed" | "stopped", d: EngineDeps): void {
    const before = this.session.state;
    // the outputs the run's loop declares: its bound version's, else the current version's
    const declared = this.deps.loops === undefined ? {} : (this.held?.loop ?? this.current())?.manifest.outputs ?? {};
    const loop = this.deps.loops === undefined ? d.pipeline.id : loopOf(before, this.deps.config.loops.default);
    const written = this.session.commit((s) => [{ type: "run.finished", actor: ENGINE, payload: { outcome }, run: s.run.id }]);
    // a published run was anchored when the person approved the product; only a run that ends without one is anchored here
    if (outcome === "stopped") this.anchorCase("closed");
    else if (written.length > 0) this.outputs(d, loop, written[0]!.run ?? before.run.id ?? "", outcome, declared);
    this.bind();
  }

  /** Tells the host what a run that ended published or completed gives, once. A failure of the host's is reported and changes nothing here. */
  private outputs(d: EngineDeps, loop: string, run: string, outcome: "published" | "completed", declared: Record<string, LoopOutput>): void {
    const marking = this.session.state.meta?.marking;
    if (d.onOutputs === undefined || marking === undefined) return;
    try {
      d.onOutputs({ case: this.session.id, loop, run, head: this.session.head(), outcome, marking, outputs: outputsOf(this.session.state, declared) });
    } catch (err) {
      (d.onError ?? logToStderr("outputs"))(err);
    }
  }

  private anchorCase(why: "published" | "closed"): void {
    const head = this.session.head();
    this.deps.anchor?.({ case: this.session.id, seq: head.seq, hash: head.hash, why });
  }
}
