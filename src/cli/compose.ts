import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import type { Ledger } from "../core/ledger";
import type { Workbench } from "../core/workbench";
import { loadProviders } from "../agents/providers";
import { loadCaseTypes } from "../modules/case-types";
import type { CaseType } from "../modules/case-types";
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
import type { Profile } from "../agents/context";
import { rootComponents } from "../pipeline/components";
import type { EngineDeps } from "../pipeline/engine";
import type { Pipeline } from "../pipeline/manifests";
import { IMPLICIT_NOTE, loadLoops } from "../pipeline/loops";
import { storeHost } from "../pipeline/memory";
import { fileSeeds, loadSeeds } from "../modules/seeds";
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

/** The problem compose reports when the default loop is not usable. */
export const defaultLoopProblem = (id: string, loops: LoopCatalog): string => `the default loop "${id}" is not usable: ${loops.problems(id).filter((p) => p !== IMPLICIT_NOTE).join("; ")}`;
/** The pipeline deps carry while the default loop is not usable: no stage, so nothing runs on it; Engine.start refuses with the loop's problem. */
const unusablePipeline = (id: string): Pipeline => ({ id, hash: "", stages: [], legacy_hash: null });
const UNUSABLE_PROFILE: Profile = { id: "", title: "no usable loop", hash: "", marking: null, rules: "", framework: null, standard: null, stages: {} };

/**
 * The value of every credential the configuration grants a root or a loaded source names, from the environment and the secrets file, so an
 * export, a save or a proposal can be searched for them. A credential that is not set, or that is refused, holds nothing to find.
 */
export function secretValues(config: Config, registry: Registry): string[] {
  const names = new Set<string>();
  for (const r of config.roots) for (const n of r.credentials) names.add(n);
  for (const src of registry.sources()) if (typeof src.credential === "string" && src.credential !== "") names.add(src.credential);
  let secrets: Secrets;
  try {
    secrets = new Secrets(process.env, config.secrets_file);
  } catch {
    secrets = new Secrets(process.env, null);
  }
  const out: string[] = [];
  for (const n of [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    try {
      const v = secrets.get(n);
      if (v !== null) out.push(v);
    } catch { /* a value the workbench refuses is never used */ }
  }
  return out;
}

/** What compose builds from the roots, and reload builds again. */
type Built = Pick<EngineDeps, "registry" | "runner" | "seeker" | "providers" | "loops" | "components" | "pipeline" | "profile" | "case_types">;

/**
 * Files the seeds of the roots' lesson-seeds manifests into the workbench's store, each once (fileSeeds); a seed that is not a lesson, or that
 * the store refuses, is one of the problems, and a store that cannot be opened now (an export packing it) is one too: the workbench starts.
 */
function seedStore(config: Config, wb: Workbench, registry: Registry, types: readonly CaseType[], problems: string[]): void {
  const seeds = loadSeeds(registry, types);
  problems.push(...seeds.problems);
  if (seeds.seeds.length === 0) return;
  try {
    fileSeeds(wb.memory, seeds.seeds, { secrets: secretValues(config, registry), problems });
  } catch (err) {
    problems.push(`the lesson seeds were not filed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
    const caseTypes = loadCaseTypes(registry);
    problems.push(...caseTypes.problems);
    const ctx: ResolveContext = {
      registry, content: wb.chainBlobs, chain: wb.chain, trusted: roots.filter((r) => r.trusted).map((r) => r.path),
      output: (loop, output) => latestOutput(wb.chain, wb.chainBlobs, loop, output), caseTypes: caseTypes.types.map((t) => t.id),
    };
    const loops = loadLoops(registry, ctx, { max_depth: config.loops.max_depth, max_children: config.loops.max_children });
    const id = config.loops.default;
    const loop = loops.current(id);
    // an unusable default loop does not stop the workbench: it is a problem, new cases of it are refused, and everything else works
    if (loop === null) problems.push(defaultLoopProblem(id, loops));
    for (const x of loops.list()) problems.push(...x.problems.filter((p) => p !== IMPLICIT_NOTE).map((p) => `loop "${x.id}": ${p}`));
    recordLoops(loops, wb.chain, wb.chainBlobs);
    seedStore(config, wb, registry, caseTypes.types, problems);
    const built: Built = {
      case_types: caseTypes.types,
      registry, runner: { registry, pool, observables }, seeker: makeSeeker(registry), providers: loaded.providers,
      pipeline: loop?.pipeline ?? unusablePipeline(id), profile: loop?.profile ?? UNUSABLE_PROFILE, loops, components: loop?.components ?? rootComponents(registry),
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
 * usable loop whose version is new to the chain is recorded as loop.recorded. Throws ComposeError when there is no seeker; every manifest
 * problem short of that is returned in `problems`. A default loop that is not usable is one of them (`defaultLoopProblem`): the deps then carry
 * a pipeline with no stage, so a run on it is refused with the loop's problem, while reads, loads, unloads and fixing the loop all work.
 *
 * `reload()` loads the roots again and replaces, in place on the same deps object, the registry, the runner, the seeker, the providers, the
 * loops, the components, the pipeline and the profile. The old connector pool is closed once nothing holds it: each run bound to the deps it
 * replaced holds that pool (`deps.retain`, a count) until the run ends, and runQuery leases it (`deps.runner.lease`, the same count) for each
 * query in flight on it until the query ends (whoever asked: a person, a playbook, a run from before slice 12), so a query in flight across a
 * reload completes; with no holder it is closed at once. `close()` closes every pool still open.
 * It returns the new problems; a default loop that is not usable after it is one. Copy on write:
 * nothing a reload replaces is changed, so whoever holds the old objects (a run's own copy of the deps it bound) goes on with them as they were.
 */
export function compose(config: Config, wb: Workbench, opts: { refuse_hosts?: () => readonly string[] } = {}): { deps: EngineDeps; problems: string[]; close(): void; reload(): string[]; secrets(): string[] } {
  const first = build(config, wb, opts);
  /** A pool, how many runs hold it, and whether a reload has replaced it (then it is closed when the last holder lets go). */
  interface Held { pool: ConnectorPool; holders: number; replaced: boolean; closed: boolean }
  const shut = (h: Held): void => {
    if (h.closed) return;
    h.closed = true;
    open.delete(h);
    h.pool.closeAll();
  };
  const open = new Set<Held>();
  /** Holds a pool: `retain` takes a hold on it, for a bound run and (as the runner's `lease`) for each query in flight on it. */
  const hold = (pool: ConnectorPool): { held: Held; retain: () => () => void } => {
    const held: Held = { pool, holders: 0, replaced: false, closed: false };
    open.add(held);
    const retain = (): (() => void) => {
      held.holders++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        held.holders--;
        if (held.replaced && held.holders === 0) shut(held);
      };
    };
    return { held, retain };
  };
  /** The built deps with a runner that leases its pool for each query (runQuery takes and lets go of the hold). */
  const holdingRunner = (built: Built, retain: () => () => void): Built => ({ ...built, runner: { ...built.runner, lease: retain } });
  let current = hold(first.pool);
  const deps: EngineDeps = {
    config, ...holdingRunner(first.built, current.retain), content: wb.chainBlobs, retain: current.retain,
    anchor: (a) => {
      wb.chain.append({ type: "case.anchored", actor: { kind: "system", id: "engine" }, payload: { case: a.case, seq: a.seq, hash: a.hash, why: a.why } });
    },
  };
  // the store is taken from the workbench each time (an export or a load reopens it); what a proposal is checked against is the deps' now
  deps.memory = storeHost(() => wb.memory, {
    secrets: () => secretValues(config, deps.registry),
    case_types: () => (deps.case_types ?? []).map((t) => t.id),
    observables: () => deps.registry.types().map((t) => t.id),
  });
  return {
    deps, problems: first.problems,
    close: () => { for (const h of [...open]) shut(h); },
    secrets: () => secretValues(config, deps.registry),
    reload: () => {
      const next = build(config, wb, opts);
      const old = current;
      current = hold(next.pool);
      Object.assign(deps, holdingRunner(next.built, current.retain), { retain: current.retain });
      old.held.replaced = true;
      if (old.held.holders === 0) shut(old.held);
      return next.problems;
    },
  };
}
