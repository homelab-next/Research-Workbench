import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import type { Ledger } from "../core/ledger";
import type { Workbench } from "../core/workbench";
import { loadProviders } from "../agents/providers";
import { rootsOf } from "../modules/config";
import type { Config } from "../modules/config";
import { ConnectorPool } from "../modules/connectors";
import { Observables } from "../modules/observables";
import type { PivotManifest, Registry } from "../modules/registry";
import { GuardError } from "../modules/sqlguard";
import { loadRegistry } from "../modules/registry-record";
import { Secrets } from "../modules/secrets";
import { SEEKERS } from "../modules/seeker";
import type { BlobStore } from "../core/blobs";
import type { ResolveContext } from "../pipeline/components";
import type { EngineDeps } from "../pipeline/engine";
import { IMPLICIT_NOTE, loadLoops } from "../pipeline/loops";
import type { LoopCatalog } from "../pipeline/loops";

export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComposeError";
  }
}

/** The output a published run of `loop` last recorded on the workbench chain as `output`, or null. */
export function latestOutput(chain: Ledger, blobs: BlobStore, loop: string, output: string): ReturnType<ResolveContext["output"]> {
  let found: ReturnType<ResolveContext["output"]> = null;
  for (const e of chain.read()) {
    if (e.type !== "loop.output") continue;
    const p = e.payload;
    if (p.loop !== loop || p.output !== output || p.outcome !== "published") continue;
    const text = blobs.text(p.value.blob);
    let shown = text;
    try {
      const v = JSON.parse(text) as unknown;
      shown = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    } catch { /* plain text */ }
    found = { case: p.case, head: p.head.hash, marking: p.marking, hash: p.hash, text: shown };
  }
  return found;
}

/** Appends loop.recorded for each usable loop whose hash is not the chain's latest for that loop id; the lock is a blob of the chain. */
export function recordLoops(loops: LoopCatalog, chain: Ledger, blobs: BlobStore): void {
  const latest = new Map<string, string>();
  for (const e of chain.read()) if (e.type === "loop.recorded") latest.set(e.payload.loop, e.payload.hash);
  const inputs: Parameters<Ledger["appendMany"]>[0] = [];
  for (const { id, loop } of loops.list()) {
    if (loop === null || latest.get(id) === loop.pipeline.hash) continue;
    const lock = blobs.put(canonical(loop.lock as unknown as Json));
    inputs.push({ type: "loop.recorded", actor: { kind: "system", id: "loops" }, payload: { loop: id, version: loop.manifest.version, hash: loop.pipeline.hash, legacy_hash: loop.pipeline.legacy_hash ?? null, lock } });
  }
  if (inputs.length > 0) chain.appendMany(inputs);
}

/**
 * Every pivot `which` picks, rendered offline against the guard as preflight renders it, with why it does not render. A pool of its own,
 * with no secret, closed before it returns: only the command line builds a pool.
 */
export function guardProblems(registry: Registry, which: (pv: PivotManifest) => boolean): { id: string; problem: string }[] {
  const out: { id: string; problem: string }[] = [];
  const pool = new ConnectorPool({ secrets: new Secrets({}, null), observables: new Observables(registry.types()), client_name: "research-workbench" });
  try {
    for (const pv of registry.pivots()) {
      if (!which(pv)) continue;
      const source = registry.source(pv.source);
      if (source === null) { out.push({ id: pv.id, problem: `the source ${pv.source} is not loaded` }); continue; }
      try {
        pool.for(source).render({
          text: pv.query, bound: { value: "probe" },
          window: pv.needs_window ? { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T01:00:00.000Z" } : { from: null, to: null },
          max_rows: source.limits.max_rows, timeout_ms: source.limits.timeout_ms, budget: null,
        });
      } catch (err) {
        out.push({ id: pv.id, problem: err instanceof GuardError ? err.violations.join("; ") : err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    pool.closeAll();
  }
  return out;
}

/** What compose builds from the roots, and reload builds again. */
type Built = Pick<EngineDeps, "registry" | "runner" | "seeker" | "providers" | "loops" | "components" | "pipeline" | "profile">;

function build(config: Config, wb: Workbench, opts: { refuse_hosts?: () => readonly string[] }): { built: Built; pool: ConnectorPool; problems: string[] } {
  const roots = rootsOf(config);
  const registry = loadRegistry(roots, { chain: wb.chain, content: wb.chainBlobs });
  const problems = registry.problems.map((p) => `${p.path}: ${p.error}`);
  const makeSeeker = Object.hasOwn(SEEKERS, config.seeker) ? SEEKERS[config.seeker] : undefined;
  if (makeSeeker === undefined) throw new ComposeError(`the seeker "${config.seeker}" is not one this build has`);
  const secrets = new Secrets(process.env, config.secrets_file);
  const observables = new Observables(registry.types());
  const pool = new ConnectorPool({ secrets, observables, client_name: "research-workbench", ...(opts.refuse_hosts ? { refuse_hosts: opts.refuse_hosts } : {}) });
  try {
    const loaded = loadProviders(registry, secrets, opts.refuse_hosts ? { refuse_hosts: opts.refuse_hosts } : {});
    problems.push(...loaded.problems.map((p) => `${p.path}: ${p.error}`));
    const ctx: ResolveContext = {
      registry, content: wb.chainBlobs, chain: wb.chain, trusted: roots.filter((r) => r.trusted).map((r) => r.path),
      output: (loop, output) => latestOutput(wb.chain, wb.chainBlobs, loop, output),
    };
    const loops = loadLoops(registry, ctx, { max_depth: config.loops.max_depth, max_children: config.loops.max_children });
    const id = config.loops.default;
    const loop = loops.current(id);
    if (loop === null) throw new ComposeError(`the default loop "${id}" is not usable: ${loops.problems(id).join("; ")}`);
    for (const x of loops.list()) problems.push(...x.problems.filter((p) => p !== IMPLICIT_NOTE).map((p) => `loop "${x.id}": ${p}`));
    recordLoops(loops, wb.chain, wb.chainBlobs);
    const built: Built = {
      registry, runner: { registry, pool, observables }, seeker: makeSeeker(registry), providers: loaded.providers, pipeline: loop.pipeline, profile: loop.profile,
      loops, components: loop.components,
    };
    return { built, pool, problems };
  } catch (err) {
    pool.closeAll();
    throw err;
  }
}

/**
 * Everything the pipeline needs, built from the configuration: the registry over the configured and imported roots (its loading recorded
 * on the workbench chain, every manifest's bytes in the content store), the observable types, the secrets, the connector pool, the seeker
 * the configuration names, the providers, every loop, and the pipeline and profile of the default loop. `opts.refuse_hosts` names the
 * hosts (the server's own) no source or model endpoint may point at. `deps.anchor` appends `case.anchored` to the workbench chain. Each
 * usable loop whose version is new to the chain is recorded as loop.recorded. Throws ComposeError when the default loop is not usable or
 * there is no seeker; every manifest problem short of that is returned in `problems`.
 *
 * `reload()` loads the roots again and replaces, in place on the same deps object, the registry, the runner, the seeker, the providers, the
 * loops, the components, the pipeline and the profile; the old connector pool is closed
 * (a pool opens a connector again when it is next asked for one, so a run that holds the old runner can still query).
 * It returns the new problems. It throws ComposeError and changes nothing on deps when the default loop would not be usable. Copy on write:
 * nothing a reload replaces is changed, so whoever holds the old objects (a run's own copy of the deps it bound) goes on with them as they were.
 */
export function compose(config: Config, wb: Workbench, opts: { refuse_hosts?: () => readonly string[] } = {}): { deps: EngineDeps; problems: string[]; close(): void; reload(): string[] } {
  const first = build(config, wb, opts);
  let pool = first.pool;
  const deps: EngineDeps = {
    config, ...first.built, content: wb.chainBlobs,
    anchor: (a) => {
      wb.chain.append({ type: "case.anchored", actor: { kind: "system", id: "engine" }, payload: { case: a.case, seq: a.seq, hash: a.hash, why: a.why } });
    },
  };
  return {
    deps, problems: first.problems,
    close: () => pool.closeAll(),
    reload: () => {
      const next = build(config, wb, opts);
      Object.assign(deps, next.built);
      const old = pool;
      pool = next.pool;
      old.closeAll();
      return next.problems;
    },
  };
}
