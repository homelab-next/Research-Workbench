// A synthetic setup: a folder of its own that holds a fake lake, a root over it, the ground truth beside them, a data folder and a
// configuration, with synth.json saying what it is. Everything synthetic is built in such a folder and never in the person's own.
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
