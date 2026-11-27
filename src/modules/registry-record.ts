import { readFileSync } from "node:fs";
import type { BlobStore } from "../core/blobs";
import { sha256Hex } from "../core/hash";
import type { Ledger } from "../core/ledger";
import type { Actor } from "../core/types";
import type { RootConfig } from "./config";
import { Registry } from "./registry";

const DEFAULT_ACTOR: Actor = { kind: "system", id: "registry" };

/**
 * Kinds whose text or schema is put in front of a model or decides what a run does; an untrusted root may not supply them.
 * The workbench's full list, passed to pivot's Registry.load (whose own default holds every one but `loop`: pivot's
 * tests/catalogue/trusted-only.test.ts; Registry.load adds the caller's list to its own). A loop names every component its runs are given.
 */
export const WORKBENCH_TRUSTED_ONLY: readonly string[] = [
  "model", "script", "check", "stage", "profile", "rules", "persona", "procedure", "skill", "gate", "playbook", "inventory", "reference", "objective", "framework", "standard", "schema",
  "loop",
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

/**
 * Holds every hash the registry carries (module.loaded, and a source's, pivot's, playbook's or inventory's, which the ledger records
 * as source_hash, pivot_hash and the manifest hashes) to the workbench's own sha256 of the file's bytes, so the ledger's meaning of
 * those hashes does not rest on pivot's copy. Throws when one differs; a file changed after pivot read it differs too.
 */
export function checkOwnHashes(registry: Registry): void {
  const own = new Map<string, string>();
  const ownOf = (path: string): string => {
    let h = own.get(path);
    if (h === undefined) { h = sha256Hex(readFileSync(path)); own.set(path, h); }
    return h;
  };
  const refuse = (what: string, path: string): never => {
    throw new Error(`the hash of ${what} (${path}) is not the workbench's own sha256 of the file; it changed while loading, or pivot's hash differs. Nothing was recorded.`);
  };
  for (const m of registry.manifests()) if (m.hash !== ownOf(m.path)) refuse(`${m.kind} "${m.id}"`, m.path);
  const typed: [string, { id: string; hash: string }[]][] = [
    ["source", registry.sources()], ["pivot", registry.pivots()], ["playbook", registry.playbooks()], ["inventory", registry.inventories()],
  ];
  for (const [kind, items] of typed) {
    for (const x of items) {
      const m = registry.get(kind, x.id);
      if (m === null || x.hash !== ownOf(m.path)) refuse(`${kind} "${x.id}"`, m?.path ?? "no file");
    }
  }
}

/**
 * Puts every loaded manifest's bytes in `content` under the manifest's hash: each file is read once more and its sha256 held to the
 * manifest's hash before the put, so a file changed since the load throws (as checkOwnHashes does) and nothing else of it is stored.
 */
function storeManifests(registry: Registry, content: BlobStore): void {
  const read = registry.manifests().map((m) => {
    const bytes = new Uint8Array(readFileSync(m.path));
    if (sha256Hex(bytes) !== m.hash) {
      throw new Error(`the hash of ${m.kind} "${m.id}" (${m.path}) is not the workbench's own sha256 of the file; it changed while loading, or pivot's hash differs. Nothing was recorded.`);
    }
    return bytes;
  });
  for (const bytes of read) content.put(bytes);
}

/**
 * Loads the roots with the workbench's trusted-only kinds, holds its hashes to the workbench's own, puts every loaded manifest's bytes in
 * `content` when one is given, then records what loaded and what was refused when a chain is given: module.loaded is appended only for
 * bytes the content store holds.
 */
export function loadRegistry(roots: RootConfig[], opts: { chain?: Ledger; actor?: Actor; content?: BlobStore } = {}): Registry {
  const registry = Registry.load(roots, { trustedOnlyKinds: WORKBENCH_TRUSTED_ONLY });
  checkOwnHashes(registry);
  if (opts.content !== undefined) storeManifests(registry, opts.content);
  if (opts.chain !== undefined) recordRegistry(registry, opts.chain, opts.actor ?? DEFAULT_ACTOR);
  return registry;
}

/** Whether the chain holds a module.loaded of this hash, kind and id from a root in `trusted`. */
export function recordedAs(chain: Ledger, hash: string, kind: string, id: string, trusted: readonly string[]): boolean {
  for (const e of chain.read()) {
    if (e.type !== "module.loaded") continue;
    const p = e.payload;
    if (p.hash === hash && p.kind === kind && p.id === id && trusted.includes(p.root)) return true;
  }
  return false;
}
