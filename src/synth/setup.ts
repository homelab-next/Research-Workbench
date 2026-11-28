// A synthetic setup: a folder of its own that holds a fake lake, a root over it, the ground truth beside them, a data folder and a
// configuration, with synth.json saying what it is. Everything synthetic is built in such a folder and never in the person's own.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SynthParams } from "pivot/synth/params";
import { Refused } from "../core/refused";
import { isObj } from "../core/state/guards";
import type { Actor } from "../core/types";
import type { Config } from "../modules/config";

export const SETUP_FORMAT = 1;
export const SETUP_FILE = "synth.json";
export const SYNTH_PORT = 4757;
export const SYNTHETIC_PREFIX = "[synthetic] ";

export interface SynthSetup {
  format: 1; params: SynthParams; pivot: string; workbench: string; digest: string;
  storylines: { id: string; title: string; malicious: boolean; case_type: string }[];
  left_out: { id: string; why: string }[];
  model: "scripted" | { provider: string; model: string };
}

/** What a form of `bun run synth` that works in a setup is given: the configuration, the setup beside it, the person who runs it. */
export interface SynthContext { config: Config; dir: string; setup: SynthSetup; human: Actor; io: { log(line: string): void; error(line: string): void } }

export class SynthRefused extends Refused {
  constructor(message: string, reasons?: string[]) {
    super(message, reasons);
    this.name = "SynthRefused";
  }
}

const NOT_A_SETUP = "this configuration is not a synthetic setup's (no synth.json beside it); give --config <synth>/config.yaml";

/** True when the parsed file has the shape of a setup of this format. */
function isSetup(x: unknown): x is SynthSetup {
  if (!isObj(x) || x.format !== SETUP_FORMAT || !isObj(x.params)) return false;
  if (typeof x.pivot !== "string" || typeof x.workbench !== "string" || typeof x.digest !== "string") return false;
  if (!Array.isArray(x.storylines) || !x.storylines.every((s) => isObj(s) && typeof s.id === "string" && typeof s.case_type === "string")) return false;
  if (!Array.isArray(x.left_out)) return false;
  return x.model === "scripted" || (isObj(x.model) && typeof x.model.provider === "string" && typeof x.model.model === "string");
}

/** The setup a configuration belongs to: the synth.json beside its file. Throws SynthRefused "this configuration is not a synthetic setup's (no synth.json beside it); give --config <synth>/config.yaml" for a configuration with no file, or none beside it, or one that is not a setup of this format. */
export function setupOf(config: Config): { dir: string; setup: SynthSetup } {
  if (config.path === null) throw new SynthRefused(NOT_A_SETUP);
  const dir = dirname(config.path);
  const file = join(dir, SETUP_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new SynthRefused(NOT_A_SETUP);
  }
  if (!isSetup(parsed)) throw new SynthRefused(NOT_A_SETUP);
  return { dir, setup: parsed };
}

/** The real path of `p`, or of its nearest existing ancestor with the rest appended. */
function realish(p: string): string {
  let up = resolve(p);
  const rest: string[] = [];
  while (!existsSync(up)) {
    const parent = dirname(up);
    if (parent === up) break;
    rest.unshift(basename(up));
    up = parent;
  }
  return join(realpathSync(up), ...rest);
}

/** True when `a` is `b` or a folder inside it. */
const within = (a: string, b: string): boolean => {
  const r = relative(b, a);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

/** Why `dir` may not hold a synthetic setup; null when it may. `ambient` is the configuration the command would load with no --config, or null when none loads. */
export function placeProblem(dir: string, repo: string, ambient: Config | null): string | null {
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) return `${dir} already exists and is not empty`;
  const at = realish(dir);
  if (within(at, realish(repo))) return `${dir} is inside the repository: build the setup outside it`;
  if (ambient === null) return null;
  const kept: [string, string][] = [
    ["the data folder", ambient.data_dir],
    ...ambient.roots.map((r): [string, string] => ["a root", r.path]),
    ["the case store", ambient.cases.store],
    ["the loop store", ambient.loops.store],
    ["the imports folder", ambient.loops.imports],
    ["a memory folder", ambient.memory.store],
    ["a memory folder", ambient.memory.files],
  ];
  for (const [what, folder] of kept) {
    const p = realish(folder);
    if (within(at, p) || within(p, at)) return `${dir} shares a folder with the configuration in use (${what}): a synthetic setup has its own`;
  }
  return null;
}

/**
 * The neutral label of each storyline a setup placed or left out, by id: `story-1`, `story-2`, ... in the order of the SHA-256 of
 * `<seed>:<id>`, so the order is fixed for a setup and neither the ids' order nor grouped by verdict. Every output but `show --reveal`
 * names a storyline by its label only: an id (phish-chain, smart-tv) or a title says what the case will be found to be.
 */
export function storyLabels(setup: Pick<SynthSetup, "params" | "storylines" | "left_out">): Map<string, string> {
  const key = (id: string): string => createHash("sha256").update(`${setup.params.seed}:${id}`).digest("hex");
  const ids = [...new Set([...setup.storylines.map((s) => s.id), ...setup.left_out.map((s) => s.id)])];
  const sorted = ids.map((id) => ({ id, k: key(id) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Map(sorted.map((x, i) => [x.id, `story-${i + 1}`]));
}

/** The label of storyline `id` in `setup`; the id itself never, so a storyline the labels do not know is `story-?`. */
export function labelOf(setup: Pick<SynthSetup, "params" | "storylines" | "left_out">, id: string): string {
  return storyLabels(setup).get(id) ?? "story-?";
}

/**
 * The storyline ids that `only` names by label, of the storylines the setup placed; or the sentence that refuses it. Only a label is taken:
 * a storyline's id is refused in the sentence an unknown label gets, so no output but `show --reveal` says which ids a setup holds.
 */
export function onlyIds(setup: SynthSetup, only: string[] | null): { ids: string[] | null } | { error: string } {
  if (only === null) return { ids: null };
  const labels = storyLabels(setup);
  const placed = setup.storylines.map((s) => ({ id: s.id, label: labels.get(s.id)! })).sort((a, b) => Number(a.label.slice(6)) - Number(b.label.slice(6)));
  const unknown = only.filter((l) => !placed.some((p) => p.label === l));
  if (unknown.length > 0) return { error: `no storyline ${unknown.join(", ")} in this setup; name one by its label: ${placed.map((p) => p.label).join(", ")}` };
  return { ids: placed.filter((p) => only.includes(p.label)).map((p) => p.id) };
}
