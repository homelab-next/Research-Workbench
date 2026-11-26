/**
 * What crosses between the server and the browser besides entries. Types and one constant, browser-safe: the server and src/web/ both import from here.
 */
import type { Json } from "./canonical";
import type { RunState } from "./state";
import type { EmptyMeans, Marking, ModelChoice, Observable, TimeWindow, Where } from "./types";

/** The id of the playbook the server makes on the spot for "does it belong?"; no manifest may take it. */
export const BELONGS_ID = "does-it-belong";

export interface Me { user: string; role: "analyst" | "requester" | "leader"; origin: string; markings: Marking[]; policy: Record<Marking, Where[]>; problems: string[] }
export interface CaseSummaryView { id: string; title: string; marking: Marking; created_ts: string; run_status: RunState["status"]; phase: string | null; incoming: number; kept: number }
export interface NewCaseInput { title: string; asked: string; why: string; starting: Observable[]; window: TimeWindow; objective: string | null; marking: Marking }
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
