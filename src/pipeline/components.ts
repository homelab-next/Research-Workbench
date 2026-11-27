// Where a loop's components come from: the root, an exact version in the content store, a published loop output, or (later) memory.
import { readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { BlobStore } from "../core/blobs";
import type { Json } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { Ledger } from "../core/ledger";
import { Refused } from "../core/refused";
import type { Marking } from "../core/types";
import { parseManifestFile } from "../modules/manifests";
import type { LoadedManifest } from "../modules/manifests";
import type { Registry } from "../modules/registry";
import { recordedAs } from "../modules/registry-record";

export type SourceSpec = "root" | { pinned: string } | { "loop-output": string } | { memory: string };
export interface ResolvedItem {
  stage: string; kind: string; id: string; title: string; source: "root" | "pinned" | "loop-output" | "inline"; hash: string; path: string | null;
  origin?: { case: string; head: string; marking: Marking };
}
/** What the context and the checks read a loop's manifests through: the manifest of a kind and id for a stage ("*" for the profile's own), or why there is none. */
export interface Components { get(stage: string, kind: string, id: string): LoadedManifest | null; items(): ResolvedItem[] }
export interface ResolveContext {
  registry: Registry; content: BlobStore; chain: Ledger; trusted: readonly string[];
  output(loop: string, output: string): { case: string; head: string; marking: Marking; hash: string; text: string } | null;
}

export class ComponentError extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "ComponentError";
  }
}

/** The kind of a check's script file: it is exported beside its check, under the check's id. */
export const CHECK_SCRIPT = "check-script";
const HEX64 = /^[0-9a-f]{64}$/;

/** A source as written in a loop's components block, or null when it is not one. */
export function parseSource(x: unknown): SourceSpec | null {
  if (x === "root") return "root";
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const keys = Object.keys(x);
  if (keys.length !== 1) return null;
  const v = (x as Record<string, unknown>)[keys[0]!];
  if (typeof v !== "string") return null;
  switch (keys[0]) {
    case "pinned": return HEX64.test(v) ? { pinned: v } : null;
    case "loop-output": return /^[^.\s]+\.[^.\s]+$/.test(v) ? { "loop-output": v } : null;
    case "memory": return v.trim() !== "" ? { memory: v } : null;
    default: return null;
  }
}

/** A path relative to its root with `/` separators. */
export const rootRelative = (root: string, path: string): string => relative(root, path).split(sep).join("/");

const key = (stage: string, kind: string, id: string): string => `${stage}\0${kind}\0${id}`;

/** Components over a fixed set of manifests, listed by stage, kind and id; `get` falls back to the profile's own ("*"). */
export class ItemComponents implements Components {
  constructor(private readonly byKey: ReadonlyMap<string, LoadedManifest>, private readonly list: readonly ResolvedItem[]) {}
  static of(entries: readonly { manifest: LoadedManifest; item: ResolvedItem }[]): ItemComponents {
    const byKey = new Map<string, LoadedManifest>();
    for (const e of entries) byKey.set(key(e.item.stage, e.item.kind, e.item.id), e.manifest);
    const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    return new ItemComponents(byKey, entries.map((e) => e.item).sort((a, b) => lt(a.stage, b.stage) || lt(a.kind, b.kind) || lt(a.id, b.id)));
  }
  get(stage: string, kind: string, id: string): LoadedManifest | null {
    return this.byKey.get(key(stage, kind, id)) ?? this.byKey.get(key("*", kind, id)) ?? null;
  }
  items(): ResolvedItem[] {
    return this.list.map((i) => ({ ...i }));
  }
}

/** Every manifest from the registry, trusted roots only: what a pipeline with no loop reads. */
export function rootComponents(registry: Registry): Components {
  const trusted = (m: LoadedManifest): boolean => registry.rootOf(m.path)?.trusted === true;
  return {
    get(_stage: string, kind: string, id: string): LoadedManifest | null {
      const m = registry.get(kind, id);
      return m !== null && trusted(m) ? m : null;
    },
    items(): ResolvedItem[] {
      return registry.manifests().filter(trusted).map((m) => ({ stage: "*", kind: m.kind, id: m.id, title: m.title, source: "root", hash: m.hash, path: rootRelative(m.root, m.path) }));
    },
  };
}

/** A manifest from bytes the content store holds, as the registry would have read it from `path`. Throws when they do not parse or name another kind or id. */
export function manifestFromBytes(bytes: Uint8Array, at: { kind: string; id: string; root: string; path: string }): LoadedManifest {
  const parsed = parseManifestFile(at.path, bytes);
  if (parsed.kind !== at.kind) throw new Error(`the bytes are a ${parsed.kind} manifest, not a ${at.kind}`);
  if (parsed.body.id !== at.id) throw new Error(`the bytes are ${at.kind} "${String(parsed.body.id)}", not "${at.id}"`);
  const title = typeof parsed.body.title === "string" && parsed.body.title !== "" ? parsed.body.title : at.id;
  return { kind: at.kind, id: at.id, title, hash: sha256Hex(bytes), root: at.root, path: at.path, dir: dirname(at.path), body: parsed.body, text: parsed.text };
}

/** A check's script as a manifest-shaped item: its text is the script. */
export function scriptManifest(checkId: string, bytes: Uint8Array, root: string, path: string): LoadedManifest {
  return { kind: CHECK_SCRIPT, id: checkId, title: checkId, hash: sha256Hex(bytes), root, path, dir: dirname(path), body: {}, text: new TextDecoder().decode(bytes) };
}

/** The bytes of a loaded manifest, in the content store: put there (after its hash is held to the file) when the registry did not. */
function stored(ctx: ResolveContext, m: LoadedManifest): void {
  if (ctx.content.has(m.hash)) return;
  const bytes = new Uint8Array(readFileSync(m.path));
  if (sha256Hex(bytes) !== m.hash) throw new ComponentError(`${m.kind} "${m.id}" changed since it was loaded`);
  ctx.content.put(bytes);
}

/** The module.loaded entry of this hash, kind and id from a root trusted now, or null. */
function loadedEntry(ctx: ResolveContext, hash: string, kind: string, id: string): { root: string; path: string } | null {
  if (!recordedAs(ctx.chain, hash, kind, id, ctx.trusted)) return null;
  for (const e of ctx.chain.read()) {
    if (e.type !== "module.loaded") continue;
    const p = e.payload;
    if (p.hash === hash && p.kind === kind && p.id === id && ctx.trusted.includes(p.root)) return { root: p.root, path: p.path };
  }
  return null;
}

/** One component from its source. Throws ComponentError with the reason of the table in "The version-2 pipeline hash". */
export function resolveComponent(ctx: ResolveContext, stage: string, kind: string, id: string, spec: SourceSpec): { manifest: LoadedManifest; item: ResolvedItem } {
  const what = `${kind} "${id}"`;
  if (typeof spec === "object" && "memory" in spec) throw new ComponentError(`${what}: memory sources arrive in slice 13`);
  if ((kind === "check" || kind === CHECK_SCRIPT) && spec !== "root") throw new ComponentError(`${what}: a check and its script are read from a trusted root`);
  if (spec === "root") {
    if (kind === CHECK_SCRIPT) return rootScript(ctx, stage, id);
    const m = ctx.registry.get(kind, id);
    if (m === null) throw new ComponentError(`${what} is not loaded`);
    if (ctx.registry.rootOf(m.path)?.trusted !== true) throw new ComponentError(`${what} comes from a root that is not trusted`);
    stored(ctx, m);
    return { manifest: m, item: { stage, kind, id, title: m.title, source: "root", hash: m.hash, path: rootRelative(m.root, m.path) } };
  }
  if ("pinned" in spec) {
    const hash = spec.pinned;
    const at = `${what} pinned at ${hash.slice(0, 12)}`;
    const entry = loadedEntry(ctx, hash, kind, id);
    if (entry === null) throw new ComponentError(`${at}: the workbench never loaded that hash for this ${kind} from a root it trusts now`);
    if (!ctx.content.has(hash)) throw new ComponentError(`${at}: the content store does not hold its bytes`);
    let m: LoadedManifest;
    try {
      m = manifestFromBytes(ctx.content.get(hash), { kind, id, root: entry.root, path: entry.path });
    } catch (err) {
      throw new ComponentError(`${at}: its bytes do not parse: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { manifest: m, item: { stage, kind, id, title: m.title, source: "pinned", hash, path: rootRelative(entry.root, entry.path) } };
  }
  const named = spec["loop-output"];
  if (kind !== "reference") throw new ComponentError(`${what}: a loop's output may only be a reference`);
  const dot = named.indexOf(".");
  const out = ctx.output(named.slice(0, dot), named.slice(dot + 1));
  if (out === null) throw new ComponentError(`${what}: there is no published output "${named.slice(dot + 1)}" of loop "${named.slice(0, dot)}"`);
  const ref = ctx.content.put(out.text);
  const body: Record<string, Json> = { kind: "reference", id, title: id, marking: out.marking };
  const m: LoadedManifest = { kind: "reference", id, title: id, hash: ref.blob, root: "", path: "", dir: "", body, text: out.text };
  return { manifest: m, item: { stage, kind, id, title: id, source: "loop-output", hash: ref.blob, path: null, origin: { case: out.case, head: out.head, marking: out.marking } } };
}

/** A root check's script: the file its manifest names, beside it, its bytes put in the content store. */
function rootScript(ctx: ResolveContext, stage: string, id: string): { manifest: LoadedManifest; item: ResolvedItem } {
  const m = ctx.registry.get("check", id);
  if (m === null || ctx.registry.rootOf(m.path)?.trusted !== true) throw new ComponentError(`check "${id}" is not loaded from a trusted root`);
  const script = m.body.script;
  if (typeof script !== "string") throw new ComponentError(`check "${id}" names no script`);
  const path = join(dirname(m.path), script);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch {
    throw new ComponentError(`check "${id}": its script "${script}" cannot be read`);
  }
  ctx.content.put(bytes);
  const manifest = scriptManifest(id, bytes, m.root, path);
  return { manifest, item: { stage, kind: CHECK_SCRIPT, id, title: script, source: "root", hash: manifest.hash, path: rootRelative(m.root, path) } };
}
