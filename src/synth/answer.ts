// `bun run synth answer`: a published synthetic case's known answer, set from its ground truth as the person, through slice 14's setKnownAnswer.
// The truth is read from <data>/synth-truth/<case>/ground-truth.json and taken only when it was written for this case (its id and the hash of
// its first entry).
import { existsSync, readFileSync } from "node:fs";
import { readGroundTruth } from "pivot/synth/truth";
import type { GroundTruth } from "pivot/synth/truth";
import { compose } from "../cli/compose";
import type { CaseSession } from "../core/session";
import { isObj } from "../core/state/guards";
import { strictest } from "../core/types";
import type { Actor, Marking } from "../core/types";
import { CaseNotFoundError, Workbench } from "../core/workbench";
import type { Config } from "../modules/config";
import { Engine } from "../pipeline/engine";
import type { EngineDeps } from "../pipeline/engine";
import { AnswerRefused, answerScale, setKnownAnswer } from "../pipeline/improve/answers";
import { labelOf, SynthRefused } from "./setup";
import type { SynthContext } from "./setup";
import { truthPath } from "./tasks";
import type { TruthFile } from "./tasks";

/** The truth file beside the case, checked to be a ground truth written for this very case. Throws SynthRefused with the sentence. */
export function truthOfCase(session: CaseSession, config: Config): TruthFile {
  const file = truthPath(config, session.id);
  if (!existsSync(file)) throw new SynthRefused(`there is no ground truth beside ${session.id}`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { parsed = null; }
  if (!isObj(parsed)) throw new SynthRefused(`the ground truth beside ${session.id} is not a ground truth`);
  const { case: id, origin, made_by, ...rest } = parsed;
  const truth: GroundTruth | null = readGroundTruth(new TextEncoder().encode(JSON.stringify(rest)));
  if (truth === null || (made_by !== "tasks" && made_by !== "seed-tasks")) throw new SynthRefused(`the ground truth beside ${session.id} is not a ground truth`);
  const first = session.entries(0, 1)[0];
  if (id !== session.id || first === undefined || origin !== first.hash) throw new SynthRefused(`the ground truth beside ${session.id} was written for another case`);
  return { ...truth, case: id, origin, made_by };
}

/** Sets the known answer of the case's product from its truth file, as the person. Shared with seed-tasks. Throws Refused with the sentence. */
export function answerFromTruth(
  session: CaseSession, deps: Pick<EngineDeps, "runner" | "profile" | "registry" | "components">, config: Config, human: Actor, product: number | null,
): { product: number; marking: Marking } {
  const truth = truthOfCase(session, config);
  const state = session.state;
  const latest = state.published.reduce<number | null>((m, p) => (m === null || p.n > m ? p.n : m), null);
  const n = product ?? latest;
  if (n === null) throw new SynthRefused(`${session.id} has published no product; publish it first`);
  // the floor improve answer uses: the strictest of the case's marking and the product's
  const published = state.published.find((x) => x.n === n);
  const draft = published === undefined ? undefined : state.drafts.find((d) => d.hash === published.draft_hash);
  const marking = strictest(state.meta?.marking ?? "TLP:RED", draft?.product.marking);
  try {
    setKnownAnswer(session, { runner: deps.runner }, { product: n, text: truth.summary, findings: truth.findings, marking, actor: human }, answerScale(deps));
  } catch (err) {
    if (err instanceof AnswerRefused) throw new SynthRefused(err.message);
    throw err;
  }
  return { product: n, marking };
}

export async function synthAnswer(ctx: SynthContext, opts: { case: string; product: number | null }): Promise<number> {
  const { config, io, human } = ctx;
  const wb = Workbench.open(config.data_dir, { store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store, onError: (e) => io.error(`workbench: ${e instanceof Error ? e.message : String(e)}`) });
  try {
    let session: CaseSession;
    try {
      session = wb.session(opts.case);
    } catch (err) {
      if (err instanceof CaseNotFoundError) { io.error(err.message); return 1; }
      throw err;
    }
    const composed = compose(config, wb);
    // the likelihood scale is the case's bound loop's, as improve answer reads it
    const looking = new Engine(session, composed.deps);
    try {
      const set = answerFromTruth(session, looking.bound, config, human, opts.product);
      io.log(`known answer set for product ${set.product} of ${session.id} from ${labelOf(ctx.setup, truthOfCase(session, config).storyline)} (${set.marking})`);
      return 0;
    } catch (err) {
      if (err instanceof SynthRefused) { io.error(err.message); return 1; }
      throw err;
    } finally {
      looking.close();
      composed.close();
    }
  } finally {
    wb.close();
  }
}
