// `bun run synth answer`: a published synthetic case's known answer, set from its ground truth as the person. A stub here; Task 14 fills it.
import type { SynthContext } from "./setup";

export async function synthAnswer(ctx: SynthContext, _opts: { case: string; product: number | null }): Promise<number> {
  ctx.io.error("synth answer is not part of this build yet");
  return 1;
}
