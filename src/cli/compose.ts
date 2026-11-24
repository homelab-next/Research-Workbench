import type { Workbench } from "../core/workbench";
import { loadProfile } from "../agents/context";
import { loadProviders } from "../agents/providers";
import type { Config } from "../modules/config";
import { ConnectorPool } from "../modules/connectors";
import { Observables } from "../modules/observables";
import { Registry } from "../modules/registry";
import { Secrets } from "../modules/secrets";
import { SEEKERS } from "../modules/seeker";
import type { EngineDeps } from "../pipeline/engine";
import { loadPipeline } from "../pipeline/manifests";

export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeError";
  }
}

/**
 * Everything the pipeline needs, built from the configuration: the registry (its loading recorded on the workbench chain), the
 * observable types, the secrets, the connector pool, the seeker the configuration names, the providers, the pipeline and the
 * `investigation` profile. `opts.refuse_hosts` names the hosts (the server's own) no source or model endpoint may point at. `deps.anchor` appends `case.anchored` to the workbench chain. Throws ComposeError when there is no
 * usable pipeline, profile or seeker; every manifest problem short of that is returned in `problems`.
 */
export function compose(config: Config, wb: Workbench, opts: { refuse_hosts?: () => readonly string[] } = {}): { deps: EngineDeps; problems: string[]; close(): void } {
  const registry = Registry.load(config.roots, { chain: wb.chain });
  const problems = registry.problems.map((p) => `${p.path}: ${p.error}`);
  const makeSeeker = Object.hasOwn(SEEKERS, config.seeker) ? SEEKERS[config.seeker] : undefined;
  if (makeSeeker === undefined) throw new ComposeError(`the seeker "${config.seeker}" is not one this build has`);
  const secrets = new Secrets(process.env, config.secrets_file);
  const observables = new Observables(registry.types());
  const pool = new ConnectorPool({ secrets, observables, ...(opts.refuse_hosts ? { refuse_hosts: opts.refuse_hosts } : {}) });
  try {
    const loaded = loadProviders(registry, secrets, opts.refuse_hosts ? { refuse_hosts: opts.refuse_hosts } : {});
    problems.push(...loaded.problems.map((p) => `${p.path}: ${p.error}`));
    const { pipeline, problems: pipelineProblems } = loadPipeline(registry);
    problems.push(...pipelineProblems);
    if (pipeline === null) throw new ComposeError(`there is no usable pipeline: ${pipelineProblems.join("; ")}`);
    let profile;
    try {
      profile = loadProfile(registry, "investigation");
    } catch (err) {
      throw new ComposeError(`there is no usable profile: ${err instanceof Error ? err.message : String(err)}`);
    }
    const deps: EngineDeps = {
      config, registry, runner: { registry, pool, observables }, seeker: makeSeeker(registry), providers: loaded.providers, pipeline, profile,
      anchor: (a) => {
        wb.chain.append({ type: "case.anchored", actor: { kind: "system", id: "engine" }, payload: { case: a.case, seq: a.seq, hash: a.hash, why: a.why } });
      },
    };
    return { deps, problems, close: () => pool.closeAll() };
  } catch (err) {
    pool.closeAll();
    throw err;
  }
}
