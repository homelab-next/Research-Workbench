import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Json } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { Ledger } from "../core/ledger";
import type { Actor } from "../core/types";
import type { RootConfig } from "./config";
import { ManifestError, parseManifestFile, toPivot, toSource, toType, validateBody } from "./manifests";
import type { LoadedManifest, PivotManifest, SourceManifest } from "./manifests";
import { compileType } from "./observables";
import type { ObservableType } from "./observables";

export type { LoadedManifest, PivotManifest, QualityNote, SourceManifest, TableManifest, EndpointManifest } from "./manifests";
export type { ObservableType } from "./observables";

export interface Problem { root: string; path: string; error: string }

const DEFAULT_ACTOR: Actor = { kind: "system", id: "registry" };
const MANIFEST_FILE = /\.(?:ya?ml|md)$/i;
const key = (kind: string, id: string): string => `${kind}\0${id}`;
const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
};

/** Every regular file under a root that could be a manifest, depth-first, names sorted; dotfiles, symlinks and folders named data are skipped. */
function walk(dir: string, out: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "data") walk(full, out);
    } else if (e.isFile() && MANIFEST_FILE.test(e.name)) {
      out.push(full);
    }
  }
}

/** True when a `location` of a manifest in `dir` stays inside `root`, by its spelling and by where links lead. */
function locationStaysInside(root: string, dir: string, location: string): boolean {
  if (isAbsolute(location)) return false;
  const target = resolve(dir, location);
  if (!inside(resolve(root), target)) return false;
  try {
    return inside(realpathSync(root), realpathSync(target));
  } catch {
    return true; // nothing there to follow; the connector reports a missing location when it is used
  }
}

export class Registry {
  readonly problems: Problem[] = [];
  private readonly manifests = new Map<string, LoadedManifest>();
  private readonly sourceById = new Map<string, SourceManifest>();
  private readonly typeById = new Map<string, ObservableType>();
  private readonly pivotById = new Map<string, PivotManifest>();
  private roots: RootConfig[] = [];

  private constructor() {}

  static load(roots: RootConfig[], opts: { chain?: Ledger; actor?: Actor } = {}): Registry {
    const r = new Registry();
    r.roots = roots.map(x => ({ ...x }));
    for (const root of roots) r.readRoot(root);
    r.crossCheck();
    if (opts.chain !== undefined) r.record(opts.chain, opts.actor ?? DEFAULT_ACTOR);
    return r;
  }

  all(kind: string): LoadedManifest[] {
    return [...this.manifests.values()].filter(m => m.kind === kind);
  }
  get(kind: string, id: string): LoadedManifest | null {
    return this.manifests.get(key(kind, id)) ?? null;
  }
  sources(): SourceManifest[] {
    return [...this.sourceById.values()];
  }
  source(id: string): SourceManifest | null {
    return this.sourceById.get(id) ?? null;
  }
  types(): ObservableType[] {
    return [...this.typeById.values()];
  }
  pivots(): PivotManifest[] {
    return [...this.pivotById.values()];
  }
  pivot(id: string): PivotManifest | null {
    return this.pivotById.get(id) ?? null;
  }
  /** The root a path lies in (the longest, if roots are nested), or null. */
  rootOf(path: string): RootConfig | null {
    const target = resolve(path);
    let best: RootConfig | null = null;
    for (const root of this.roots) {
      const base = resolve(root.path);
      if (inside(base, target) && (best === null || base.length > resolve(best.path).length)) best = root;
    }
    return best === null ? null : { ...best };
  }

  private reject(root: RootConfig, path: string, error: string): void {
    this.problems.push({ root: root.path, path, error });
  }

  private readRoot(root: RootConfig): void {
    const files: string[] = [];
    try {
      walk(root.path, files);
    } catch (err) {
      this.reject(root, root.path, `cannot read the module root: ${(err as Error).message}`);
      return;
    }
    for (const path of files) {
      try {
        this.readFile(root, path);
      } catch (err) {
        this.reject(root, path, err instanceof ManifestError ? err.message : `cannot be read: ${(err as Error).message}`);
      }
    }
  }

  private add(m: LoadedManifest): boolean {
    const k = key(m.kind, m.id);
    if (this.manifests.has(k)) {
      this.reject({ path: m.root, trusted_scripts: false }, m.path, `duplicate ${m.kind} id "${m.id}"; the first one loaded is kept`);
      return false;
    }
    this.manifests.set(k, m);
    return true;
  }

  private readFile(root: RootConfig, path: string): void {
    const bytes = readFileSync(path);
    const hash = sha256Hex(bytes);
    const dir = dirname(path);
    const parsed = parseManifestFile(path, bytes);
    const body = validateBody(parsed.kind, parsed.body);
    const base = { hash, root: root.path, path, dir, text: parsed.text };

    if (parsed.kind === "types" || parsed.kind === "pivots") {
      const single = parsed.kind === "types" ? "type" : "pivot";
      for (const item of body[parsed.kind] as Record<string, Json>[]) {
        const id = item.id as string;
        try {
          if (parsed.kind === "types") compileType(item.pattern as string);
        } catch {
          this.reject(root, path, `type "${id}": pattern does not compile: ${item.pattern}`);
          continue;
        }
        const title = (item.title as string | undefined) ?? id;
        if (!this.add({ ...base, kind: single, id, title, body: item, text: null })) continue;
        if (parsed.kind === "types") this.typeById.set(id, toType(item));
        else this.pivotById.set(id, toPivot(item, hash));
      }
      return;
    }

    const id = body.id;
    if (typeof id !== "string" || id === "") throw new ManifestError("missing or invalid id");
    const title = typeof body.title === "string" && body.title !== "" ? body.title : id;
    if (parsed.kind === "source") {
      const connector = body.connector as string;
      if ((connector === "sql" || connector === "files") && !locationStaysInside(root.path, dir, body.location as string)) {
        throw new ManifestError(`location "${body.location}" is outside the module root`);
      }
    }
    if (!this.add({ ...base, kind: parsed.kind, id, title, body })) return;
    if (parsed.kind === "source") this.sourceById.set(id, toSource(body, hash, dir));
  }

  private drop(kind: string, id: string): void {
    this.manifests.delete(key(kind, id));
    if (kind === "source") this.sourceById.delete(id);
    else if (kind === "pivot") this.pivotById.delete(id);
  }

  /** Checks what refers to what, once every file is read: columns to types, then pivots to sources and types. */
  private crossCheck(): void {
    const reject = (kind: string, id: string, error: string): void => {
      const m = this.manifests.get(key(kind, id))!;
      this.reject({ path: m.root, trusted_scripts: false }, m.path, error);
      this.drop(kind, id);
    };
    for (const s of this.sources()) {
      const missing = s.tables.flatMap(t => t.columns).map(c => c.type).find(t => t !== null && !this.typeById.has(t));
      if (missing !== undefined) reject("source", s.id, `source "${s.id}": a column is typed "${missing}", which is not a known observable type`);
    }
    for (const p of this.pivots()) {
      const names = [p.from, p.to, ...Object.values(p.yields)];
      const missingType = names.find(t => !this.typeById.has(t));
      if (!this.sourceById.has(p.source)) reject("pivot", p.id, `pivot "${p.id}": source "${p.source}" is not loaded`);
      else if (missingType !== undefined) reject("pivot", p.id, `pivot "${p.id}": type "${missingType}" is not a known observable type`);
    }
  }

  /** Appends module.loaded for each manifest whose content is new to the chain, and module.rejected for each problem not already recorded. */
  private record(chain: Ledger, actor: Actor): void {
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
    for (const m of this.manifests.values()) {
      if (loadedHash.get(`${m.root}\0${key(m.kind, m.id)}`) === m.hash) continue;
      inputs.push({ type: "module.loaded", actor, payload: { kind: m.kind, id: m.id, hash: m.hash, root: m.root, path: m.path } });
    }
    const loadedPaths = new Set(inputs.map(i => (i.type === "module.loaded" ? `${i.payload.root}\0${i.payload.path}` : "")));
    for (const p of this.problems) {
      const k = `${p.root}\0${p.path}`;
      if (lastAbout.get(k) === `rejected:${p.error}` && !loadedPaths.has(k)) continue;
      inputs.push({ type: "module.rejected", actor, payload: { root: p.root, path: p.path, error: p.error } });
    }
    if (inputs.length > 0) chain.appendMany(inputs);
  }
}
