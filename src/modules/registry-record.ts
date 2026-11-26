import type { Ledger } from "../core/ledger";
import type { Actor } from "../core/types";
import type { RootConfig } from "./config";
import { Registry } from "./registry";

const DEFAULT_ACTOR: Actor = { kind: "system", id: "registry" };

/**
 * Kinds whose text or schema is put in front of a model or decides what a run does; an untrusted root may not supply them.
 * The workbench's full list, passed to pivot's Registry.load (whose own default holds every one: pivot's tests/catalogue/trusted-only.test.ts).
 */
export const WORKBENCH_TRUSTED_ONLY: readonly string[] = [
  "model", "script", "check", "stage", "profile", "rules", "persona", "procedure", "skill", "gate", "playbook", "inventory", "reference", "objective", "framework", "standard", "schema",
];

const key = (kind: string, id: string): string => `${kind}\0${id}`;

/** Appends module.loaded for each manifest whose content is new to the chain, and module.rejected for each problem not already recorded. */
export function recordRegistry(registry: Registry, chain: Ledger, actor: Actor = DEFAULT_ACTOR): void {
  const loadedHash = new Map<string, string>(); // kind, id, root -> latest hash
  const lastAbout = new Map<string, string>(); // root + path -> latest signature, loaded or rejected
  for (const e of chain.read()) {
    if (e.type === "module.loaded") {
      loadedHash.set(`${e.payload.root}\0${key(e.payload.kind, e.payload.id)}`, e.payload.hash);
      lastAbout.set(`${e.payload.root}\0${e.payload.path}`, "loaded");
    } else if (e.type === "module.rejected") {
      lastAbout.set(`${e.payload.root}\0${e.payload.path}`, `rejected:${e.payload.error}`);
    }
  }
  const inputs: Parameters<Ledger["appendMany"]>[0] = [];
  for (const m of registry.manifests()) {
    if (loadedHash.get(`${m.root}\0${key(m.kind, m.id)}`) === m.hash) continue;
    inputs.push({ type: "module.loaded", actor, payload: { kind: m.kind, id: m.id, hash: m.hash, root: m.root, path: m.path } });
  }
  const loadedPaths = new Set(inputs.map(i => (i.type === "module.loaded" ? `${i.payload.root}\0${i.payload.path}` : "")));
  for (const p of registry.problems) {
    const k = `${p.root}\0${p.path}`;
    if (lastAbout.get(k) === `rejected:${p.error}` && !loadedPaths.has(k)) continue;
    inputs.push({ type: "module.rejected", actor, payload: { root: p.root, path: p.path, error: p.error } });
  }
  if (inputs.length > 0) chain.appendMany(inputs);
}

/** Loads the roots with the workbench's trusted-only kinds, then records what loaded and what was refused when a chain is given. */
export function loadRegistry(roots: RootConfig[], opts: { chain?: Ledger; actor?: Actor } = {}): Registry {
  const registry = Registry.load(roots, { trustedOnlyKinds: WORKBENCH_TRUSTED_ONLY });
  if (opts.chain !== undefined) recordRegistry(registry, opts.chain, opts.actor ?? DEFAULT_ACTOR);
  return registry;
}
