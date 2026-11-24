import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Json } from "../core/canonical";
import { isPlainObject } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { Ledger } from "../core/ledger";
import type { Actor } from "../core/types";
import type { RootConfig } from "./config";
import { ManifestError, parseManifestFile, toPivot, toSource, toType, validateBody } from "./manifests";
import type { LoadedManifest, PivotManifest, SourceManifest } from "./manifests";
import { compileType, MAX_VALUE_LENGTH, PATTERN_PROBE_LIMIT_MS, probePattern } from "./observables";
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

const MAX_MANIFEST_BYTES = 1048576;

/** realpath of `target`, or of its deepest existing ancestor with the missing tail put back. A dangling link is followed by hand. */
function resolveReal(target: string, hops = 0): string | null {
  let p = resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(p), ...tail.reverse());
    } catch {
      try {
        if (lstatSync(p).isSymbolicLink()) {
          if (hops > 32) return null;
          const next = resolveReal(resolve(dirname(p), readlinkSync(p)), hops + 1);
          return next === null ? null : join(next, ...tail.reverse());
        }
      } catch {
        // nothing at p: climb
      }
      const parent = dirname(p);
      if (parent === p) return null;
      tail.push(p.slice(parent.length).replace(/^[\\/]+/, ""));
      p = parent;
    }
  }
}

/**
 * True when `target` lies inside `root`, by its spelling and by where links lead. A target that does not exist yet is
 * judged by its deepest existing ancestor. Reads the file system but changes nothing; cheap enough to call on every open.
 */
export function staysInside(root: string, target: string): boolean {
  if (!inside(resolve(root), resolve(target))) return false;
  const realRoot = resolveReal(root);
  const realTarget = resolveReal(target);
  return realRoot !== null && realTarget !== null && inside(realRoot, realTarget);
}

/** True when a relative path, taken from `base`, stays inside `root`. Absolute paths are refused, and so are `..` segments when `plain` is set. */
function pathStaysInside(root: string, base: string, rel: string, plain = false): boolean {
  if (isAbsolute(rel) || (plain && rel.split(/[\\/]/).includes(".."))) return false;
  return staysInside(root, resolve(base, rel));
}

export class Registry {
  readonly problems: Problem[] = [];
  private readonly manifests = new Map<string, LoadedManifest>();
  private readonly sourceById = new Map<string, SourceManifest>();
  private readonly typeById = new Map<string, ObservableType>();
  private readonly pivotById = new Map<string, PivotManifest>();
  private roots: RootConfig[] = [];
  private readonly conflicted = new Set<string>();

  private constructor() {}

  static load(roots: RootConfig[], opts: { chain?: Ledger; actor?: Actor } = {}): Registry {
    const r = new Registry();
    r.roots = roots.map(x => ({ ...x, credentials: [...x.credentials] }));
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
    return best === null ? null : { ...best, credentials: [...best.credentials] };
  }

  private reject(root: string, path: string, error: string): void {
    this.problems.push({ root, path, error });
  }

  private readRoot(root: RootConfig): void {
    const files: string[] = [];
    try {
      walk(root.path, files);
    } catch (err) {
      this.reject(root.path, root.path, `cannot read the module root: ${(err as Error).message}`);
      return;
    }
    for (const path of files) {
      try {
        this.readFile(root, path);
      } catch (err) {
        this.reject(root.path, path, err instanceof ManifestError ? err.message : `cannot be read: ${(err as Error).message}`);
      }
    }
  }

  private add(m: LoadedManifest): boolean {
    const k = key(m.kind, m.id);
    const first = this.manifests.get(k);
    if (first !== undefined) {
      if (first.root === m.root) {
        this.reject(m.root, m.path, `duplicate ${m.kind} id "${m.id}"; the first one loaded is kept`);
        return false;
      }
      // the same id from two roots: neither loads, so a root listed first cannot take another root's id
      this.reject(m.root, m.path, `${m.kind} id "${m.id}" is defined in two module roots; neither is loaded`);
      this.reject(first.root, first.path, `${m.kind} id "${m.id}" is defined in two module roots; neither is loaded`);
      this.conflicted.add(k);
      this.drop(m.kind, m.id);
      return false;
    }
    if (this.conflicted.has(k)) {
      this.reject(m.root, m.path, `${m.kind} id "${m.id}" is defined in two module roots; neither is loaded`);
      return false;
    }
    this.manifests.set(k, m);
    return true;
  }

  private readFile(root: RootConfig, path: string): void {
    const size = statSync(path).size;
    if (size > MAX_MANIFEST_BYTES) throw new ManifestError(`file is ${size} bytes, over the ${MAX_MANIFEST_BYTES} byte limit; not read`);
    const bytes = readFileSync(path);
    if (bytes.length > MAX_MANIFEST_BYTES) throw new ManifestError(`file is ${bytes.length} bytes, over the ${MAX_MANIFEST_BYTES} byte limit`);
    const hash = sha256Hex(bytes);
    const dir = dirname(path);
    const parsed = parseManifestFile(path, bytes);
    const body = validateBody(parsed.kind, parsed.body);
    const base = { hash, root: root.path, path, dir, text: parsed.text };

    if (parsed.kind === "types" && !root.trusted) {
      throw new ManifestError("observable types are accepted only from a trusted root (a type's pattern runs on every result)");
    }
    if (parsed.kind === "types" || parsed.kind === "pivots") {
      const single = parsed.kind === "types" ? "type" : "pivot";
      for (const item of body[parsed.kind] as Record<string, Json>[]) {
        const id = item.id as string;
        try {
          if (parsed.kind === "types") {
            compileType(item.pattern as string);
            const took = probePattern(item.pattern as string);
            if (took > PATTERN_PROBE_LIMIT_MS) throw new Error(`it took ${Math.round(took)} ms on a probe string of at most ${MAX_VALUE_LENGTH} characters (the limit is ${PATTERN_PROBE_LIMIT_MS} ms)`);
          }
        } catch (err) {
          this.reject(root.path, path, `type "${id}": pattern ${JSON.stringify(item.pattern)} refused: ${(err as Error).message}`);
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
      const credential = typeof body.credential === "string" ? body.credential : null;
      if (!root.trusted) {
        if (connector === "http" || connector === "trino") throw new ManifestError(`a ${connector} source is accepted only from a trusted root`);
        if (credential !== null) throw new ManifestError(`source names credential "${credential}"; only a trusted root may name a credential`);
      } else if (credential !== null && !root.credentials.includes(credential)) {
        throw new ManifestError(`source names credential "${credential}", which the configuration does not grant to this root`);
      }
      // the runner compares a trino estimate, which is in rows, with a budget in the source's unit
      const unit = isPlainObject(body.cost) && typeof body.cost.unit === "string" ? body.cost.unit : "seconds";
      if (connector === "trino" && unit !== "rows") throw new ManifestError(`a trino source's cost unit must be rows (the engine estimates in rows), not ${unit}`);
      if (connector === "sql" || connector === "files") {
        if (!pathStaysInside(root.path, dir, body.location as string)) throw new ManifestError(`location "${body.location}" is outside the module root`);
        const where = resolve(dir, body.location as string);
        for (const t of (body.tables ?? []) as { name: string; file?: string }[]) {
          if (t.file !== undefined && !pathStaysInside(root.path, where, t.file, true)) throw new ManifestError(`table "${t.name}": file "${t.file}" is outside the module root`);
        }
      }
    }
    if (!this.add({ ...base, kind: parsed.kind, id, title, body })) return;
    if (parsed.kind === "source") this.sourceById.set(id, toSource(body, hash, dir, resolve(root.path)));
  }

  private isTrusted(root: string): boolean {
    return this.roots.some(r => r.path === root && r.trusted);
  }

  private drop(kind: string, id: string): void {
    this.manifests.delete(key(kind, id));
    if (kind === "source") this.sourceById.delete(id);
    else if (kind === "pivot") this.pivotById.delete(id);
    else if (kind === "type") this.typeById.delete(id);
  }

  /** Checks what refers to what, once every file is read: columns to types, then pivots to sources and types. */
  private crossCheck(): void {
    const reject = (kind: string, id: string, error: string): void => {
      const m = this.manifests.get(key(kind, id))!;
      this.reject(m.root, m.path, error);
      this.drop(kind, id);
    };
    for (const s of this.sources()) {
      const missing = s.tables.flatMap(t => t.columns).map(c => c.type).find(t => t !== null && !this.typeById.has(t));
      if (missing !== undefined) reject("source", s.id, `source "${s.id}": a column is typed "${missing}", which is not a known observable type`);
    }
    for (const p of this.pivots()) {
      const names = [p.from, p.to, ...Object.values(p.yields)];
      const missingType = names.find(t => !this.typeById.has(t));
      const home = this.manifests.get(key("pivot", p.id))!;
      const owner = this.manifests.get(key("source", p.source));
      if (!this.sourceById.has(p.source)) reject("pivot", p.id, `pivot "${p.id}": source "${p.source}" is not loaded`);
      else if (owner !== undefined && owner.root !== home.root && !(this.isTrusted(home.root) && this.isTrusted(owner.root))) {
        reject("pivot", p.id, `pivot "${p.id}": source "${p.source}" belongs to another root; only a pivot from a trusted root may use it`);
      }
      else if (missingType !== undefined) reject("pivot", p.id, `pivot "${p.id}": type "${missingType}" is not a known observable type`);
      else if (!Object.values(p.yields).includes(p.to)) reject("pivot", p.id, `pivot "${p.id}": yields maps no column to its target type "${p.to}"`);
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
