// `bun run synth tasks`: a case for each storyline's public task, its ground truth beside the cases. A stub here; slice 15's Task 14 fills it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Marking } from "../core/types";
import type { Config } from "../modules/config";
import { TRUTH_DIR } from "./setup";
import type { SynthContext } from "./setup";

export type { SynthContext } from "./setup";

export interface TruthIndex { format: 1; cases: { storyline: string; case: string; origin: string; made_by: "tasks" | "seed-tasks" }[] }

/** The index of the cases a setup's truth was written for: `<data>/synth-truth/index.json`; empty when there is none. */
export function readIndex(config: Config): TruthIndex {
  const file = join(config.data_dir, TRUTH_DIR, "index.json");
  if (!existsSync(file)) return { format: 1, cases: [] };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as TruthIndex;
  return { format: 1, cases: Array.isArray(parsed.cases) ? parsed.cases : [] };
}

export async function synthTasks(ctx: SynthContext, _opts: { only: string[] | null; marking: Marking }): Promise<number> {
  ctx.io.error("synth tasks is not part of this build yet");
  return 1;
}
