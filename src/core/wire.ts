/**
 * What crosses between the server and the browser besides entries. Types only, browser-safe: the server and src/web/ both import from here.
 */
import type { RunState } from "./state";
import type { EmptyMeans, Marking, Observable, TimeWindow, Where } from "./types";

export interface Me { user: string; role: "analyst" | "requester" | "leader"; origin: string; markings: Marking[]; policy: Record<Marking, Where[]>; problems: string[] }
export interface CaseSummaryView { id: string; title: string; marking: Marking; created_ts: string; run_status: RunState["status"]; phase: string | null; incoming: number; kept: number }
export interface NewCaseInput { title: string; asked: string; why: string; starting: Observable[]; window: TimeWindow; objective: string | null; marking: Marking }
export interface SourceView { id: string; title: string; connector: string; marking: Marking; where: Where; confirmed: boolean; adhoc: boolean; cost: { weight: number; unit: string }; quality: string }
export interface PivotView { id: string; title: string; from: string; to: string; source: string; free: boolean; weight: number; needs_window: boolean; empty_means: EmptyMeans }
export interface Reference {
  types: { id: string; title: string }[]; sources: SourceView[]; pivots: PivotView[];
  objectives: { id: string; title: string; measures: { id: string; kind: "mop" | "moe"; title: string }[] }[];
  phases: { id: string; title: string }[]; profile: { id: string; title: string };
}
export interface ModelView { provider: string; model: string; where: Where; efforts: string[]; context: number | null; allowed: boolean; reason: string | null }
