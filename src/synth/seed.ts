// `bun run synth seed-tasks`: a seeded case of the loop synth-seed for each storyline, its gates passed by the person. A stub here; Task 15 fills it.
import type { Marking } from "../core/types";
import type { SynthContext } from "./setup";

export async function synthSeed(ctx: SynthContext, _opts: { only: string[] | null; marking: Marking }): Promise<number> {
  ctx.io.error("synth seed-tasks is not part of this build yet");
  return 1;
}
