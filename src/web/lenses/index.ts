import { makeDiscarded } from "./discarded";
import { makeJobs } from "./jobs";
import { makePipeline } from "./pipeline";
import { makeSteps } from "./steps";
import { makeTimeline } from "./timeline";
import { makeWorklog } from "./worklog";
import type { LensId, Open } from "../app";
import type { Ui, View } from "../ui";

export interface LensDef { id: LensId; key: string; title: string; make(ui: Ui, open: Open, arg: string | null): View }
/** In shelf order. Each lens task adds its entry here; a lens with no entry has no button and no key. */
export const LENSES: LensDef[] = [
  { id: "steps", key: "s", title: "Steps", make: (ui, open) => makeSteps(ui, open) },
  { id: "timeline", key: "t", title: "Timeline", make: (ui, open) => makeTimeline(ui, open) },
  { id: "worklog", key: "w", title: "Worklog", make: (ui, open) => makeWorklog(ui, open) },
  { id: "discarded", key: "d", title: "Discarded", make: (ui, open) => makeDiscarded(ui, open) },
  { id: "jobs", key: "b", title: "Jobs", make: (ui, open) => makeJobs(ui, open) },
  { id: "pipeline", key: "q", title: "Pipeline", make: (ui, open, arg) => makePipeline(ui, open, arg) },
];
