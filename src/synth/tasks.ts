// `bun run synth tasks`: a case for each storyline's public task, made by the person, its ground truth beside the cases folder. It starts no run.
// The truth is written to <data>/synth-truth/<case>/ground-truth.json, never into a case's own folder: a case's folder is packed whole when the
// case is unloaded, and a known answer's source must not travel in a case file.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readGroundTruth } from "pivot/synth/truth";
import type { GroundTruth } from "pivot/synth/truth";
import { compose } from "../cli/compose";
import type { CaseSession } from "../core/session";
import { isObj } from "../core/state/guards";
import type { Marking } from "../core/types";
import { Workbench } from "../core/workbench";
import type { NewCase } from "../core/workbench";
import type { Config } from "../modules/config";
import { labelOf, onlyIds, SYNTHETIC_PREFIX } from "./setup";
import type { SynthContext } from "./setup";

export type { SynthContext } from "./setup";

export interface TruthFile extends GroundTruth { case: string; origin: string; made_by: "tasks" | "seed-tasks" }
export interface TruthIndex { format: 1; cases: { storyline: string; case: string; origin: string; made_by: "tasks" | "seed-tasks" }[] }

/** The folder beside the cases that holds each synthetic case's ground truth: `<data>/synth-truth/`. Named here only, where it is read. */
export const TRUTH_DIR = "synth-truth";

const MADE_BY = ["tasks", "seed-tasks"];
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `<data>/synth-truth/<case>/ground-truth.json`. */
export function truthPath(config: Config, id: string): string {
  return join(config.data_dir, TRUTH_DIR, id, "ground-truth.json");
}

const indexPath = (config: Config): string => join(config.data_dir, TRUTH_DIR, "index.json");

const isRow = (x: unknown): x is TruthIndex["cases"][number] =>
  isObj(x) && typeof x.storyline === "string" && typeof x.case === "string" && typeof x.origin === "string" && MADE_BY.includes(x.made_by as string);

/** The index of the cases a setup's truth was written for: `<data>/synth-truth/index.json`; empty when there is none. A file that is not one is an error that names it. */
export function readIndex(config: Config): TruthIndex {
  const file = indexPath(config);
  if (!existsSync(file)) return { format: 1, cases: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, "utf8")); } catch { parsed = null; }
  if (!isObj(parsed) || parsed.format !== 1 || !Array.isArray(parsed.cases) || !parsed.cases.every(isRow)) throw new Error(`${file} is not an index of synthetic cases`);
  return { format: 1, cases: parsed.cases };
}

/** Writes `text` to `file` through a temporary file beside it and a rename, so a reader sees the old file or the new one. */
function writeWhole(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Writes the truth beside the case and adds it to the index (a temporary file, then a rename). Shared with seed-tasks. */
export function recordTruth(config: Config, truth: GroundTruth, session: CaseSession, made_by: TruthFile["made_by"]): void {
  const origin = session.entries(0, 1)[0]!.hash;
  const file: TruthFile = { ...truth, case: session.id, origin, made_by };
  writeWhole(truthPath(config, session.id), `${JSON.stringify(file, null, 2)}\n`);
  const index = readIndex(config);
  const cases = [...index.cases.filter((c) => c.case !== session.id), { storyline: truth.storyline, case: session.id, origin, made_by }];
  writeWhole(indexPath(config), `${JSON.stringify({ format: 1, cases }, null, 2)}\n`);
}

/** The objective every synthetic case carries, the overlay's `synth/root/context/synth-objective.yaml`: the checks ask that a product state one. It names no verdict and no storyline. */
export const SYNTH_OBJECTIVE = "synth-objective";

/**
 * The case input of a storyline's task, as both forms make it, with the setup's objective. Every agent of the case is told its title, question
 * and why, so none of them names the storyline: its id (phish-chain, smart-tv) or its title would say what the case will be found to be.
 */
export function caseInput(truth: GroundTruth, marking: Marking): NewCase {
  const { task } = truth;
  return {
    title: SYNTHETIC_PREFIX + task.title, asked: task.question, why: `synthetic task, seed ${truth.seed}`,
    starting: task.starting.map((o) => ({ type: o.type, value: o.value })), window: { from: task.window.from, to: task.window.to }, objective: SYNTH_OBJECTIVE, marking,
  };
}

/** The ground truths of the setup's storylines by id, each `<synth>/truth/<id>.json`; a file that is not one is in `bad`, with what is wrong with it. Shared with seed-tasks. */
export function readTruths(ctx: Pick<SynthContext, "dir" | "setup">): { truths: GroundTruth[]; bad: { storyline: string; why: string; file: string }[] } {
  const truths: GroundTruth[] = [];
  const bad: { storyline: string; why: string; file: string }[] = [];
  for (const id of ctx.setup.storylines.map((s) => s.id).sort(byText)) {
    const file = join(ctx.dir, "truth", `${id}.json`);
    let bytes: Uint8Array;
    try { bytes = readFileSync(file); } catch { bad.push({ storyline: id, why: "cannot be read", file }); continue; }
    const truth = readGroundTruth(bytes);
    if (truth === null || truth.storyline !== id) { bad.push({ storyline: id, why: "is not a ground truth", file }); continue; }
    truths.push(truth);
  }
  return { truths, bad };
}

/** The line that names a truth file that is not one, by the storyline's label: the file's name is the storyline's id, so only show --reveal prints it. Shared with seed-tasks. */
export function badLine(setup: SynthContext["setup"], b: { storyline: string; why: string }): string {
  return `${labelOf(setup, b.storyline)}: its truth file ${b.why}; synth show --reveal names the file`;
}

/** `opts.only` names storylines by their labels (story-1, ...), as every output but show --reveal does. */
export async function synthTasks(ctx: SynthContext, opts: { only: string[] | null; marking: Marking }): Promise<number> {
  const { config, io, human } = ctx;
  const only = onlyIds(ctx.setup, opts.only);
  if ("error" in only) { io.error(only.error); return 1; }
  const asked = (id: string): boolean => only.ids === null || only.ids.includes(id);
  const label = (id: string): string => labelOf(ctx.setup, id);
  const { truths, bad } = readTruths(ctx);
  let code = 0;
  for (const b of bad.filter((x) => asked(x.storyline))) { io.error(badLine(ctx.setup, b)); code = 1; }
  const made = new Set(readIndex(config).cases.filter((c) => c.made_by === "tasks").map((c) => c.storyline));
  const wanted = truths.filter((t) => asked(t.storyline) && !made.has(t.storyline));
  let count = 0;
  if (wanted.length > 0) {
    const wb = Workbench.open(config.data_dir, { store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store, onError: (e) => io.error(`workbench: ${e instanceof Error ? e.message : String(e)}`) });
    try {
      const composed = compose(config, wb);
      try {
        const deps = composed.deps;
        const types = (deps.case_types ?? []).map((t) => t.id);
        for (const truth of wanted) {
          const { task } = truth;
          if (!types.includes(task.case_type)) {
            io.error(`${label(truth.storyline)}: "${task.case_type}" is not a case type${types.length === 0 ? "; none is loaded" : `; one of ${types.join(", ")}`}`);
            code = 1;
            continue;
          }
          const wrong = task.starting.find((o) => !deps.runner.observables.matches(o.type, o.value));
          if (wrong !== undefined) { io.error(`${label(truth.storyline)}: ${wrong.value} is not a ${wrong.type}`); code = 1; continue; }
          const session = wb.createCase(caseInput(truth, opts.marking), human, { default_loop: config.loops.default, type: task.case_type });
          recordTruth(config, truth, session, "tasks");
          count++;
          io.log(`${session.id} ${label(truth.storyline)} (${task.case_type}): ${task.question}`);
        }
      } finally {
        composed.close();
      }
    } finally {
      wb.close();
    }
  }
  if (count === 0) io.log("no case made: every storyline asked for already has a task case");
  const cfg = config.path ?? "<synth>/config.yaml";
  io.log("next:");
  io.log(`  bun run serve --config ${cfg}`);
  io.log(`  bun run synth answer <case> --config ${cfg}   (once the case is published)`);
  return code;
}
