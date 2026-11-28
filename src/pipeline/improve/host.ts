import type { BlobStore } from "../../core/blobs";
import type { CaseSession } from "../../core/session";
import type { CaseState } from "../../core/state";
import type { Entry } from "../../core/types";
import type { ChildLink, NewCase } from "../../core/workbench";
import type { ChangeCheck, ManifestFile } from "../../modules/loop-write";
import type { RunSummary } from "../engine";
import type { ResolvedLoop } from "../loops";
import type { ChildRef, ChildView } from "../subloop";

/**
 * The mark a probe child is made with: probe.child's payload and the child's token budget. Task 7 defines it as `ProbeMark` in
 * src/core/workbench.ts beside createCase's `probe` option; this is the same shape, until that lands and this becomes its import.
 */
export interface ProbeMark { improve: string; origin: string; probe: string; candidate: string; task: string; plan_gate: "accept"; max_lookups: number; max_tokens: number }

/** A task Select named: its case and the hash of that case's first entry. */
export interface TaskRef { case: string; origin: string }
/** What the improve loop reads of a task case: its state and head now, and its entries. */
export interface TaskView { ref: TaskRef; state: Readonly<CaseState>; head: { seq: number; hash: string }; entries(from?: number, to?: number): readonly Entry[] }
/** A probe child as the improve case's record names it: the child's ChildRef and its probe's id (`base/T1`, `K2/T3`). */
export interface ProbeRef extends ChildRef { probe: string }

/** What the improve loop needs of the host: the tasks, the staging store, and the probe children. The host has the workbench; the engine a session. */
export interface ImproveHost {
  /** The loaded cases of this type that have published a product, newest case first (the greater case number first). Reads; opens no engine. */
  tasks(caseType: string): TaskView[];
  /** The task Select named, when it is loaded and its first entry is that origin; null otherwise. */
  task(ref: TaskRef): TaskView | null;
  /** The staging store of an improve case: made when first asked for. */
  staged(improve: { case: string; origin: string | null }): BlobStore;
  /** stageCandidate over the roots as they are now, into this improve case's staging store. */
  stage(improve: { case: string; origin: string | null }, root: string, files: ManifestFile[], target: string): { ok: true; loop: ResolvedLoop } | { ok: false; problems: string[] };
  /** checkCandidate over the roots as they are now. */
  check(root: string, files: ManifestFile[], target: string): ChangeCheck;
  /** Removes the improve case's staging folder. Never throws. */
  clear(improve: { case: string; origin: string | null }): void;
  probes: {
    find(link: ChildLink): { id: string; origin: string } | null;
    create(input: NewCase, link: ChildLink, mark: ProbeMark, type: string): { id: string; origin: string };
    /** Starts the child on `loop` when it has no run, and carries it to where a probe ends (driveProbe). Passes no gate but the child's plan gate, by its policy. */
    drive(ref: ProbeRef, opts: { loop: ResolvedLoop }): Promise<RunSummary>;
    read(ref: ProbeRef): ChildView | null;
    /** Ends a probe child's run in progress as stopped, by improve-probe. Nothing when it has none. */
    end(ref: ProbeRef, reason: string): void;
  };
}

/** The improve case a session is, as the host's staging calls name it: its id and the hash of its first entry. */
export const improveOf = (session: Pick<CaseSession, "id" | "entries">): { case: string; origin: string | null } =>
  ({ case: session.id, origin: session.entries(0, 1)[0]?.hash ?? null });
