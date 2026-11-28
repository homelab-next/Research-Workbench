import { makeAgent } from "./agent";
import { makeDiscarded } from "./discarded";
import { makeGraph } from "./graph";
import { makeImprove } from "./improve";
import { makeJobs } from "./jobs";
import { makeMemory } from "./memory";
import { makeNarrative } from "./narrative";
import { makePipeline } from "./pipeline";
import { makeReplay } from "./replay";
import { makeSteps } from "./steps";
import { makeTimeline } from "./timeline";
import { makeWorklog } from "./worklog";
import type { CaseState } from "../../core/state";
import type { LensId, Open } from "../app";
import type { Ui, View } from "../ui";

export interface LensDef {
  id: LensId; key: string; title: string; soon?: true; make(ui: Ui, open: Open, arg: string | null): View;
  /** Whether the lens is on the shelf (and opens) for this case; a lens without it is offered in every case. */
  offered?(state: Readonly<CaseState>): boolean;
}
/** In shelf order. Each lens task adds its entry here; a lens with no entry has no button and no key. */
export const LENSES: LensDef[] = [
  { id: "agent", key: "a", title: "Agent", make: (ui, open) => makeAgent(ui, open) },
  { id: "steps", key: "s", title: "Steps", make: (ui, open, arg) => makeSteps(ui, open, arg) },
  { id: "narrative", key: "r", title: "Narrative", make: (ui, open, arg) => makeNarrative(ui, open, arg) },
  { id: "timeline", key: "t", title: "Timeline", make: (ui, open) => makeTimeline(ui, open) },
  { id: "graph", key: "g", title: "Graph", make: (ui, open) => makeGraph(ui, open) },
  { id: "worklog", key: "w", title: "Worklog", make: (ui, open) => makeWorklog(ui, open) },
  { id: "memory", key: "m", title: "Memory", make: (ui, open) => makeMemory(ui, open) },
  { id: "discarded", key: "d", title: "Discarded", make: (ui, open) => makeDiscarded(ui, open) },
  { id: "jobs", key: "b", title: "Jobs", make: (ui, open) => makeJobs(ui, open) },
  { id: "pipeline", key: "q", title: "Pipeline", make: (ui, open, arg) => makePipeline(ui, open, arg) },
  // slice 14: an improve case's lens, offered only in a case made by an improve request
  { id: "improve", key: "i", title: "Improve", make: (ui, open, arg) => makeImprove(ui, open, arg), offered: (s) => s.improve.request !== null },
  { id: "replay", key: "e", title: "Replay", make: (ui, open, arg) => makeReplay(ui, open, arg) },
];
