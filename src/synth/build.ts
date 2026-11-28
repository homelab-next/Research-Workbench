// Builds a self-contained synthetic setup: pivot's fake lake and root over it, the generic half of the sample, this repository's overlay,
// a configuration of its own and synth.json. Nothing is written outside the folder it is given; a refusal part-way leaves nothing.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { buildSynth, SynthRefused as PivotRefused } from "pivot/synth/build";
import type { SynthParams } from "pivot/synth/params";
import { VERSION as PIVOT_VERSION } from "pivot/version";
import { compose } from "../cli/compose";
import { canonical } from "../core/canonical";
import type { Json } from "../core/canonical";
import { WORKBENCH_VERSION } from "../core/casefile";
import type { Where } from "../core/types";
import { Workbench } from "../core/workbench";
import { loadCaseTypes } from "../modules/case-types";
import { ConfigError, loadConfig } from "../modules/config";
import type { Config } from "../modules/config";
import { loadRegistry } from "../modules/registry-record";
import { newRoot, pointLoop, pointStage } from "../../scripts/new-root";
import { SEED_SCRIPT, seedScript } from "./seed-script";
import { placeProblem, SETUP_FILE, SETUP_FORMAT, SYNTH_PORT, SynthRefused } from "./setup";
import type { SynthSetup } from "./setup";

const REPO = resolve(import.meta.dir, "..", "..");
/** The scripted model every stage of a --scripted setup names; no script of that name is shipped. */
export const SYNTH_RUN = "synth-run";
const CASE_TYPES = ["cloud-activity", "large-transfer", "suspicious-process", "suspicious-signin", "unknown-device"];

export interface BuildOptions { params: Partial<SynthParams>; model: "scripted" | { base_url: string; model: string; provider?: string; where?: Where }; port?: number; only?: string[]; sample?: string; overlay?: string }
export interface Built { dir: string; config: string; setup: SynthSetup; tables: { name: string; rows: number; bytes: number }[]; files: number }

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Throws naming the first entry under `dir` that is not a regular file or a folder: a root is copied from regular files only. */
function regularOnly(dir: string, what: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) regularOnly(p, what);
    else if (!st.isFile()) throw new SynthRefused(`${what} holds ${p}, which is not a regular file; it is copied from regular files only`);
  }
}

/** The configuration a command would load with no --config, or null when none loads. */
export function ambientConfig(): Config | null {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

/** Builds a self-contained synthetic setup in `dir`. Throws SynthRefused, leaving nothing behind, when the place or the parameters are refused or the root it made does not load clean. */
export function buildSetup(dir: string, opts: BuildOptions, ambient: Config | null = ambientConfig()): Built {
  const problem = placeProblem(dir, REPO, ambient);
  if (problem !== null) throw new SynthRefused(problem);
  const port = opts.port ?? SYNTH_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new SynthRefused(`the port must be a whole number from 1 to 65535, not ${port}`);
  const sample = resolve(opts.sample ?? join(REPO, "sample"));
  const overlay = resolve(opts.overlay ?? join(REPO, "synth", "root"));
  for (const need of ["context", "checks", "stages", "models/scripted.yaml", "loops/investigation.yaml", "loops/improve.yaml"]) {
    if (!existsSync(join(sample, need))) throw new SynthRefused(`${join(sample, need)}: the sample has no ${need}`);
  }
  for (const need of ["context", "checks", "stages"]) regularOnly(join(sample, need), "the sample");
  if (!existsSync(overlay) || !statSync(overlay).isDirectory()) throw new SynthRefused(`${overlay}: there is no overlay folder`);
  regularOnly(overlay, "the overlay");

  const model = opts.model === "scripted" ? { provider: "scripted", model: SYNTH_RUN } : { provider: opts.model.provider ?? "local", model: opts.model.model };
  const made = !existsSync(dir);
  let built;
  try {
    built = buildSynth(dir, opts.params, opts.only === undefined ? {} : { only: opts.only });
  } catch (err) {
    if (err instanceof PivotRefused) throw new SynthRefused(err.message);
    throw err;
  }
  try {
    const root = join(dir, "root");
    // the generic half of the sample
    cpSync(join(sample, "context"), join(root, "context"), { recursive: true });
    cpSync(join(sample, "checks"), join(root, "checks"), { recursive: true });
    mkdirSync(join(root, "stages"));
    for (const f of readdirSync(join(sample, "stages")).sort()) {
      const p = join(sample, "stages", f);
      writeFileSync(join(root, "stages", f), pointStage(p, readFileSync(p, "utf8"), model));
    }
    mkdirSync(join(root, "loops"));
    for (const f of ["investigation.yaml", "improve.yaml"]) {
      const p = join(sample, "loops", f);
      writeFileSync(join(root, "loops", f), pointLoop(p, readFileSync(p, "utf8"), model));
    }
    mkdirSync(join(root, "models"));
    writeFileSync(join(root, "models", "scripted.yaml"), readFileSync(join(sample, "models", "scripted.yaml")));
    if (opts.model !== "scripted") {
      // the model manifest newRoot writes, made in a scratch folder of the setup's own and taken from it
      const scratch = join(dir, ".model-scratch");
      try {
        newRoot(scratch, {
          base_url: opts.model.base_url, model: opts.model.model, sample,
          ...(opts.model.provider === undefined ? {} : { provider: opts.model.provider }),
          ...(opts.model.where === undefined ? {} : { where: opts.model.where }),
        });
        writeFileSync(join(root, "models", `${model.provider}.yaml`), readFileSync(join(scratch, "models", `${model.provider}.yaml`)));
      } catch (err) {
        throw err instanceof SynthRefused ? err : new SynthRefused((err as Error).message);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    // this repository's overlay, over it
    for (const f of walk(overlay)) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), readFileSync(join(overlay, f)));
    }
    // the seed loop's script, from the public tasks of the storylines placed (never a ground truth)
    const pivots = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", `${SEED_SCRIPT}.yaml`), seedScript(built.tasks, (id) => pivots.pivot(id)?.title ?? null, (id) => pivots.pivot(id)?.to ?? null));

    const config = join(dir, "config.yaml");
    writeFileSync(config, ["data_dir: ./data", "roots:", "  - { path: ./root, trusted: true, credentials: [] }", `server: { port: ${port} }`, "research: { parallel: 1 }", ""].join("\n"));
    mkdirSync(join(dir, "data"));
    const setup: SynthSetup = {
      format: SETUP_FORMAT, params: built.params, pivot: PIVOT_VERSION, workbench: WORKBENCH_VERSION, digest: built.digest,
      storylines: built.storylines, left_out: built.left_out, model: opts.model === "scripted" ? "scripted" : model,
    };
    writeFileSync(join(dir, SETUP_FILE), `${canonical(setup as unknown as Json)}\n`);

    check(dir, config, opts.model === "scripted");
    return { dir, config, setup, tables: built.tables, files: walk(root).length };
  } catch (err) {
    if (made) rmSync(dir, { recursive: true, force: true });
    else for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true });
    throw err instanceof SynthRefused ? err : new SynthRefused(`the setup was not built: ${(err as Error).message}`);
  }
}

/** The root loads clean, has the five case types, and composes with no problem but, scripted, the ones that name the missing script. */
function check(dir: string, configFile: string, scripted: boolean): void {
  const problems: string[] = [];
  const registry = loadRegistry([{ path: join(dir, "root"), trusted: true, credentials: [] }]);
  problems.push(...registry.problems.map((p) => `${p.path}: ${p.error}`));
  const types = loadCaseTypes(registry);
  problems.push(...types.problems);
  const ids = types.types.map((t) => t.id);
  if (ids.join(",") !== CASE_TYPES.join(",")) problems.push(`the case types are ${ids.join(", ") || "none"}, not ${CASE_TYPES.join(", ")}`);
  if (problems.length === 0) {
    // the setup's own configuration, read with nothing of the person's: no environment, the setup's folder as the home
    const config = loadConfig({ path: configFile, env: {}, home: dir });
    const wb = Workbench.open(config.data_dir, { store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store });
    try {
      const composed = compose(config, wb);
      composed.close();
      problems.push(...composed.problems.filter((p) => !(scripted && p.includes(SYNTH_RUN))));
    } finally {
      wb.close();
    }
  }
  if (problems.length > 0) throw new SynthRefused(`the setup does not load clean: ${problems.join("; ")}`, problems);
}
