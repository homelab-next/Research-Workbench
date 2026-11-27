/**
 * What crosses between the server and the browser besides entries. Types and one constant, browser-safe: the server and src/web/ both import from here.
 */
import type { Json } from "./canonical";
import type { RunState } from "./state";
import type { EmptyMeans, Marking, ModelChoice, Observable, StageDef, TimeWindow, Where } from "./types";

/** The id of the playbook the server makes on the spot for "does it belong?"; no manifest may take it. pivot owns the name. */
export { BELONGS_ID } from "pivot/types";

export interface Me {
  user: string; role: "analyst" | "requester" | "leader"; origin: string; markings: Marking[]; policy: Record<Marking, Where[]>; problems: string[];
  /** The case store's folder, and cases.on_complete: the default of "Unload after publishing". */
  cases: { store: string; on_complete: "keep" | "unload" };
  /** The configuration's default loop (`loops.default`): a case of it says nothing of its loop on the case list. */
  loops: { default: string };
}
export interface CaseSummaryView { id: string; title: string; marking: Marking; created_ts: string; run_status: RunState["status"]; phase: string | null; incoming: number; kept: number;
  /** Why the last unload of this case failed, or that one did not finish; null when none did. */
  unload_failed: string | null;
  /** The loop the case is for (the default loop when its ledger names none); the case that made it, for a child; the child its paused run waits on. */
  loop: string; parent: string | null; waiting_on: string | null }
/** A case file in the store, as its case.json describes it. */
export interface StoredCaseView {
  file: string; bytes: number; id: string; title: string; asked: string; marking: Marking; starting: Observable[]; status: string;
  outcome: "published" | "completed" | "stopped" | null; published: number; head: string; entries: number; unloaded_ts: string; workbench: string;
  /** This case is in the working set now. */
  loaded: boolean;
}
/** The case store: its folder, the files in it newest first, the files named like case files that could not be read, and how many temporary files a stopped unload left. */
export interface StoreView { store: string; cases: StoredCaseView[]; unreadable: { file: string; reason: string }[]; leftovers: number }
export interface NewCaseInput { title: string; asked: string; why: string; starting: Observable[]; window: TimeWindow; objective: string | null; marking: Marking;
  /** A usable loop's id; omitted: the default loop. */
  loop?: string }

/** One component, check or built-in rule of a loop's stage: where it comes from and its hash (null for what is built in). */
export interface ItemView { kind: string; id: string; title: string; source: "root" | "pinned" | "loop-output" | "inline" | "built-in"; hash: string | null }
export interface LoopStageView {
  id: string; title: string; runs: StageDef["runs"]; role: string; gate: StageDef["gate"]; reviews: boolean; on_pass: string | null; on_fail: string | null; hash: string; inline: boolean;
  /** persona, rules, goal, procedure, skills, references, gate guides, schema, framework, standard, memory sources (none in this slice) */
  context: ItemView[];
  /** checks and their scripts; built in: the query guard, the marking policy, the citation check of a review stage */
  middleware: ItemView[];
  orchestration: { tools: string[]; model: ModelChoice | null; fast_model: ModelChoice | null; max_turns: number | null; send_back_cap: number; subloop: { loop: string; hash: string | null; inputs: Record<string, string>; returns: Record<string, string> } | null };
}
/** A loop as the Loops page lists it. `root` is the folder name of the root it comes from; `problems` say why it is not usable. */
export interface LoopSummaryView { id: string; title: string; about: string; version: number | null; hash: string | null; stages: string[]; usable: boolean; problems: string[]; implicit: boolean; trusted: boolean; root: string }
export interface LoopView extends LoopSummaryView {
  entry: string | null; profile: string | null; inputs: Record<string, { type: string; required: boolean }>; outputs: Record<string, { from: string }>; stage_views: LoopStageView[];
  caps: { max_depth: number; max_children: number };
  /** The loop as the forms edit it (every stage inline); null when it is not usable. */
  draft: Json | null;
}
/** A loop file in the loop store, and what importing it would do now (null with `problem` when it cannot be imported). */
export interface LoopFileView { file: string; loop: string; version: number; title: string; hash: string; files: number; bytes: number; plan: { write: number; same: number; conflicts: string[] } | null; problem: string | null }
export interface SourceView { id: string; title: string; connector: string; marking: Marking; where: Where; confirmed: boolean; adhoc: boolean; cost: { weight: number; unit: string }; quality: string }
export interface PivotView { id: string; title: string; from: string; to: string; source: string; free: boolean; weight: number; needs_window: boolean; empty_means: EmptyMeans; inventory: string | null }
/** A list a source keeps, and whether it is declared complete for its scope (only then is an empty answer from it a proven negative). */
export interface InventoryView { id: string; title: string; holds: string; scope: string; complete: boolean }
export interface Reference {
  types: { id: string; title: string }[]; sources: SourceView[]; pivots: PivotView[];
  objectives: { id: string; title: string; measures: { id: string; kind: "mop" | "moe"; title: string }[] }[];
  phases: { id: string; title: string }[]; profile: { id: string; title: string };
  /** The most times one stage is sent back to before the run pauses (a person may allow more). */
  send_back_cap: number;
  playbooks: PlaybookView[];
  inventories: InventoryView[];
  /** The profile standard's likelihood terms, least likely first; [] when it names none. */
  likelihood: string[];
  /** The tool names a stage manifest may list, in the fixed list's order (the loop forms' checkboxes). */
  stage_tools: string[];
  /** Every model a stage of a loaded loop names, as model or fast model, once each (the loop forms' choice of model). */
  stage_models: ModelChoice[];
}
export interface PlaybookView {
  id: string; title: string; about: string; inputs: { name: string; type: string }[];
  steps: { id: string; pivot: string; from: string; when: string | null; max_values: number }[];
  end: string[]; free: boolean; max_lookups: number;
}
export interface ModelView { provider: string; model: string; where: Where; efforts: string[]; context: number | null; allowed: boolean; reason: string | null }
/** What a command returns: where the ledger now ends, or why it was refused. Never state. */
export type CommandResult = { ok: true; seq: number } | { ok: false; refused: string[] };

export interface PublishedReport {
  ok: boolean;
  /** One per product.published entry, in order. "missing": no folder (the bundle is still in the blob). "differs": a file or the manifest is not what the blob holds. "bad_head": the head the manifest names is not an entry of this ledger. "bad_blob": the bundle blob is missing, corrupt or unreadable. */
  bundles: { n: number; seq: number; state: "ok" | "missing" | "differs" | "bad_head" | "bad_blob"; detail: string }[];
  /** Folders under published/ that no entry records (names starting ".tmp-" are leftovers and are listed too). */
  unrecorded: string[];
}

/** The custody report: what the check of the record found, in words. `line` is the one sentence the screen shows. */
export interface Custody {
  ok: boolean; entries: number; head: string; first_bad: { seq: number; reason: string } | null;
  bad_blobs: { blob: string; state: string; seq: number }[]; published: PublishedReport; skipped: number; line: string;
}
/** The bundle `approve` would write now, or why there is none. Computed from the ledger; it writes nothing. */
export type Preview =
  | { manifest: { n: number; draft: number; draft_hash: string; marking: Marking; title: string; note: string; files: { name: string; sha256: string; bytes: number }[] }; files: Record<string, string> }
  | { reasons: string[] };

/** One thing in the context the conversational agent would be given: `key` is `<kind>:<id>`; `excerpt` is the first 600 characters of its text. */
export interface PartView { key: string; kind: string; id: string; title: string; chars: number; fixed: boolean; marking: Marking | null; excerpt: string }
/** What the Agent lens shows besides the conversation (which it reads from the entries): computed from the ledger and the registry, and written nowhere. */
export interface AgentView {
  agent: string; profile: string; objective: string | null; model: ModelChoice | null; budget_chars: number | null;
  parts: PartView[]; addable: { key: string; title: string }[];
}

/** What a re-run of a card's query found against the original, row by row: `removed` is in the original only, `added` in the re-run only. Each list is cut at 200 rows (`cut`). Computed from the two recorded results; it writes nothing. */
export interface Difference { original: string; rerun: string; columns: string[]; removed: Json[][]; added: Json[][]; same: number; cut: boolean }
/** A route the finder offers: its hops in order, cheapest route first. */
export interface RouteView {
  weight: number;
  hops: { pivot: string; title: string; source: string; source_title: string; from: string; to: string; free: boolean; weight: number; unit: string; needs_window: boolean; empty_means: EmptyMeans; confirmed: boolean }[];
}
