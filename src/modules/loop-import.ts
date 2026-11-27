// Export and import of a loop file. Export gathers what a loop needs (its manifest, every file its lock names, and what its `uses` block
// names, a source as a shape), searches every byte for the workbench's secret values, and packs it. Import reads the file twice: a plan from
// a first pass that writes nothing, then each new file written with "wx" under a new folder of the imports directory, a root that is not
// trusted until the person says so.
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { canonical } from "../core/canonical";
import type { Json } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import { LoopFileError, loopFileName, readLoopFile, writeLoopFile } from "../core/loopfile";
import type { LoopFileEntry, LoopFileManifest } from "../core/loopfile";
import { writeAll } from "../core/tar";
import { CHECK_SCRIPT, rootRelative } from "../pipeline/components";
import type { LoopCatalog, LoopLock, ResolvedLoop } from "../pipeline/loops";
import { parseManifestFile } from "./manifests";
import type { Registry } from "./registry";

export type ExportFile = { path: string; kind: string; id: string; bytes: Uint8Array; origin: string | null };

/** The keys of a source that say where it is and how to sign in: never exported. */
const PLACE_KEYS = ["location", "credential", "user", "tls_verify", "confirmed"];
/** Kinds a loop file never holds: code and endpoints stay where the person wrote them. */
const NEVER_EXPORTED = ["model", "script"];
const MANIFEST_FILE = /\.(?:ya?ml|md)$/i;
const FRONT_MATTER = /^(---\r?\n)([\s\S]*?\r?\n)?(---(?:\r?\n|$))/;
/** The shortest value that counts as a secret value here: shorter ones would match ordinary text. */
const MIN_SECRET = 8;
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
const codeOf = (err: unknown): unknown => (typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined);
const enc = new TextEncoder();

// ---------- a source's shape ----------

/** The YAML of a source mapping with its place keys taken out and `location: "unset"`, `confirmed: false` put in; line by line. */
function shapeLines(yaml: string): string {
  const lines = yaml.split("\n");
  const out: string[] = [];
  let skipping = false;
  let placed = false;
  for (const line of lines) {
    const top = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (skipping && top === null && (line.startsWith(" ") || line.startsWith("\t") || line.startsWith("-") || line.trim() === "")) {
      if (line.trim() === "") { skipping = false; out.push(line); }
      continue;
    }
    skipping = false;
    if (top !== null && PLACE_KEYS.includes(top[1]!)) {
      skipping = true;
      if (!placed) { out.push('location: "unset"', "confirmed: false"); placed = true; }
      continue;
    }
    out.push(line);
  }
  if (!placed) {
    const end = out.length > 0 && out[out.length - 1] === "" ? out.length - 1 : out.length;
    out.splice(end, 0, 'location: "unset"', "confirmed: false");
  }
  return out.join("\n");
}

/** What the shape of `body` is: its place keys taken out, location "unset" and confirmed false. */
function shapedBody(body: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(body)) if (!PLACE_KEYS.includes(k)) out[k] = v;
  out.location = "unset";
  out.confirmed = false;
  return out;
}

const sameJson = (a: unknown, b: unknown): boolean => {
  try { return canonical(a as Json) === canonical(b as Json); } catch { return false; }
};
const isMapping = (x: unknown): x is Record<string, Json> => typeof x === "object" && x !== null && !Array.isArray(x);

/** A source manifest's text as a shape: location "unset", no credential, user or tls_verify, confirmed false; everything else as written. */
export function sourceShape(text: string): string {
  const fm = FRONT_MATTER.exec(text.replace(/^﻿/, ""));
  const plain = text.replace(/^﻿/, "");
  const yaml = fm === null ? plain : (fm[2] ?? "");
  const parsed: unknown = Bun.YAML.parse(yaml);
  if (!isMapping(parsed)) throw new LoopFileError("a source manifest is a mapping");
  const want = shapedBody(parsed);
  // the lines as written, when they read back as the shape; else the shape as JSON, which is YAML too
  const lined = shapeLines(yaml);
  let shaped: string;
  try {
    shaped = sameJson(Bun.YAML.parse(lined), want) ? lined : `${JSON.stringify(want, null, 2)}\n`;
  } catch {
    shaped = `${JSON.stringify(want, null, 2)}\n`;
  }
  if (fm === null) return shaped;
  return `${fm[1]}${shaped.endsWith("\n") ? shaped : `${shaped}\n`}${fm[3]}${plain.slice(fm[0].length)}`;
}

// ---------- export ----------

/** Refuses `bytes` when any secret value is in them, naming the file and never the value. */
function searchSecrets(path: string, bytes: Uint8Array, secrets: readonly string[]): void {
  const hay = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const s of secrets) {
    if (s.length < MIN_SECRET) continue;
    if (hay.includes(Buffer.from(s, "utf8"))) throw new LoopFileError(`the export is refused: ${path} holds the value of a secret the workbench holds`);
  }
}

/** The loop and every loop it runs, each once, the loop itself first; refuses a sub-loop that is not usable at the hash the lock names. */
function loopsOf(loop: ResolvedLoop, catalog: LoopCatalog): ResolvedLoop[] {
  const out: ResolvedLoop[] = [];
  const seen = new Set<string>();
  const walk = (l: ResolvedLoop): void => {
    if (seen.has(l.manifest.id)) return;
    seen.add(l.manifest.id);
    out.push(l);
    for (const s of l.lock.subloops) {
      const child = catalog.current(s.loop);
      if (child === null || child.pipeline.hash !== s.hash) throw new LoopFileError(`loop "${s.loop}", which stage "${s.stage}" runs, is not usable as loop "${l.manifest.id}" resolved it`);
      walk(child);
    }
  };
  walk(loop);
  return out;
}

/** The files a loop file would hold: the loop manifest, every lock item with a path (and each sub-loop's), and what `uses` names; a source as its shape. Throws Refused when a byte of any file holds a secret value. */
export function exportFiles(loop: ResolvedLoop, catalog: LoopCatalog, registry: Registry, secrets: readonly string[]): ExportFile[] {
  const files = new Map<string, ExportFile>();
  const add = (f: ExportFile): void => {
    if (NEVER_EXPORTED.includes(f.kind)) throw new LoopFileError(`a loop file holds no ${f.kind} manifest (${f.path})`);
    const had = files.get(f.path);
    if (had === undefined) { files.set(f.path, f); return; }
    if (sha256Hex(had.bytes) !== sha256Hex(f.bytes)) throw new LoopFileError(`two files of the loop are both at ${f.path}`);
  };
  /** The bytes of the file the registry has for this kind and id, held to the path and hash the loop resolved. */
  const fileOf = (kind: string, id: string, path: string, hash: string): Uint8Array => {
    const m = registry.get(kind === CHECK_SCRIPT ? "check" : kind, id);
    const script = kind === CHECK_SCRIPT && m !== null && typeof m.body.script === "string" ? join(dirname(m.path), m.body.script) : null;
    const file = kind === CHECK_SCRIPT ? script : m?.path ?? null;
    if (m === null || file === null || rootRelative(m.root, file) !== path) throw new LoopFileError(`${kind} "${id}" is not at ${path} in the roots now; the loop changed since it was resolved`);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(readFileSync(file));
    } catch (err) {
      throw new LoopFileError(`${path} cannot be read: ${reasonOf(err)}`);
    }
    if (sha256Hex(bytes) !== hash) throw new LoopFileError(`${kind} "${id}" (${path}) is not the version the loop resolved; the root holds other bytes there now`);
    return bytes;
  };
  const shapeOf = (id: string): void => {
    const m = registry.get("source", id);
    if (m === null) throw new LoopFileError(`uses names source "${id}", which is not loaded`);
    const path = rootRelative(m.root, m.path);
    const text = new TextDecoder().decode(fileOf("source", id, path, m.hash));
    const bytes = enc.encode(sourceShape(text));
    add({ path, kind: "source", id, bytes, origin: sha256Hex(bytes) === m.hash ? null : m.hash });
  };

  const all = loopsOf(loop, catalog);
  for (const l of all) {
    const { lock, manifest } = l;
    if (lock.manifest.path === null) throw new LoopFileError(`loop "${manifest.id}" has no manifest of its own (it is every stage manifest of its root); save it once to give it one`);
    add({ path: lock.manifest.path, kind: "loop", id: manifest.id, bytes: fileOf("loop", manifest.id, lock.manifest.path, lock.manifest.hash), origin: null });
    for (const item of lock.items) {
      if (item.path === null || item.source === "loop-output" || item.source === "inline") continue;
      add({ path: item.path, kind: item.kind, id: item.id, bytes: fileOf(item.kind, item.id, item.path, item.hash), origin: null });
    }
  }
  for (const l of all) {
    const uses = l.manifest.uses;
    for (const id of uses.playbooks) {
      const m = registry.get("playbook", id);
      if (m === null) throw new LoopFileError(`uses names playbook "${id}", which is not loaded`);
      const path = rootRelative(m.root, m.path);
      add({ path, kind: "playbook", id, bytes: fileOf("playbook", id, path, m.hash), origin: null });
    }
    for (const id of uses.pivots) {
      const m = registry.get("pivot", id);
      const p = registry.pivot(id);
      if (m === null || p === null) throw new LoopFileError(`uses names pivot "${id}", which is not loaded`);
      const path = rootRelative(m.root, m.path);
      const bytes = fileOf("pivot", id, path, m.hash);
      add({ path, kind: "pivots", id: pivotIds(path, bytes).join(","), bytes, origin: null });
      shapeOf(p.source);
    }
    for (const id of uses.sources) shapeOf(id);
  }
  const out = [...files.values()].sort((a, b) => lt(a.path, b.path));
  for (const f of out) searchSecrets(f.path, f.bytes, secrets);
  return out;
}

/** The ids of the pivots a pivots file holds, as it is written. */
function pivotIds(path: string, bytes: Uint8Array): string[] {
  const parsed = parseManifestFile(path, bytes);
  const list = parsed.body.pivots;
  return Array.isArray(list) ? list.filter(isMapping).map((p) => p.id).filter((x): x is string => typeof x === "string") : [];
}

/** The loop file of loop `id`, written into `toDir` under its own name. */
export async function exportLoop(deps: { loops: LoopCatalog; registry: Registry; secrets: readonly string[] }, id: string, toDir: string): Promise<{ file: string; path: string; manifest: LoopFileManifest }> {
  const loop = deps.loops.current(id);
  if (loop === null) {
    const problems = deps.loops.problems(id);
    throw new LoopFileError(`loop "${id}" cannot be exported: ${problems.length > 0 ? problems.join("; ") : "it is not usable"}`);
  }
  const files = exportFiles(loop, deps.loops, deps.registry, deps.secrets);
  const subloops: LoopLock[] = loopsOf(loop, deps.loops).slice(1).map((l) => l.lock);
  const header = {
    loop: id, version: loop.lock.version, title: loop.lock.title, about: loop.lock.about, hash: loop.pipeline.hash, legacy_hash: loop.pipeline.legacy_hash ?? null,
    lock: loop.lock as unknown as Json, subloops: subloops as unknown as Json[],
  };
  searchSecrets("loop.json", enc.encode(canonical(header as unknown as Json)), deps.secrets);
  const file = loopFileName(id, header.version, header.hash);
  const path = join(toDir, file);
  try {
    mkdirSync(toDir, { recursive: true });
  } catch (err) {
    throw new LoopFileError(`the loops folder cannot be made: ${reasonOf(err)}`);
  }
  const manifest = await writeLoopFile(path, header, files);
  return { file, path, manifest };
}

// ---------- import ----------

export interface ImportPlan { manifest: LoopFileManifest; root: string; write: LoopFileEntry[]; same: LoopFileEntry[]; conflicts: { kind: string; id: string; have: string; file: string }[] }

/** The folder a loop file is imported into. */
const folderOf = (importsDir: string, m: LoopFileManifest): { name: string; path: string } => {
  const name = `${m.loop}-${m.hash.slice(0, 12)}`;
  return { name, path: join(resolve(importsDir), name) };
};
const exists = (path: string): boolean => {
  try { lstatSync(path); return true; } catch (err) { return codeOf(err) !== "ENOENT"; }
};

/**
 * The (kind, id) pairs a file of the loop file stands for, read from its own bytes, which must be what loop.json says they are: a file
 * labelled as one thing and holding another would slip past the id rule.
 */
function idsOf(entry: LoopFileEntry, bytes: Uint8Array): { kind: string; id: string }[] {
  if (NEVER_EXPORTED.includes(entry.kind)) throw new LoopFileError(`${entry.path}: a loop file holds no ${entry.kind} manifest`);
  const manifestPath = MANIFEST_FILE.test(entry.path);
  if (entry.kind === CHECK_SCRIPT) {
    if (manifestPath) throw new LoopFileError(`${entry.path}: a check's script is not a manifest file`);
    return [];
  }
  if (!manifestPath) throw new LoopFileError(`${entry.path} is not a manifest file and not a check's script`);
  let parsed: ReturnType<typeof parseManifestFile>;
  try {
    parsed = parseManifestFile(entry.path, bytes);
  } catch (err) {
    throw new LoopFileError(`${entry.path} is not a manifest: ${reasonOf(err)}`);
  }
  if (parsed.kind !== entry.kind) throw new LoopFileError(`${entry.path} is a ${parsed.kind} manifest, and loop.json lists it as a ${entry.kind}`);
  if (NEVER_EXPORTED.includes(parsed.kind)) throw new LoopFileError(`${entry.path}: a loop file holds no ${parsed.kind} manifest`);
  if (parsed.kind === "pivots" || parsed.kind === "types") {
    const list = parsed.body[parsed.kind];
    const single = parsed.kind === "pivots" ? "pivot" : "type";
    return (Array.isArray(list) ? list : []).filter(isMapping).map((x) => x.id).filter((x): x is string => typeof x === "string").map((id) => ({ kind: single, id }));
  }
  if (parsed.body.id !== entry.id) throw new LoopFileError(`${entry.path} is ${parsed.kind} "${String(parsed.body.id)}", and loop.json lists it as "${entry.id}"`);
  // a source travels as a shape: it names no place, no credential and no user, and is not confirmed, so it reads nothing until the person says where
  if (parsed.kind === "source" && !isShape(parsed.body)) throw new LoopFileError(`${entry.path} is not a source's shape: an imported source has location "unset", confirmed false, and no credential, user or tls_verify`);
  return [{ kind: parsed.kind, id: entry.id }];
}

/** Whether a source's body is a shape as an export writes one. */
function isShape(body: Record<string, unknown>): boolean {
  return body.location === "unset" && body.confirmed === false && !["credential", "user", "tls_verify"].some((k) => Object.hasOwn(body, k));
}

/** Refuses a check's script that no check of the same loop file names as a plain file beside it (a check script is the only member that is not a manifest). */
function checkScriptsNamed(held: readonly { entry: LoopFileEntry; bytes: Uint8Array }[]): void {
  const named = new Set<string>();
  for (const { entry, bytes } of held) {
    if (entry.kind !== "check" || !MANIFEST_FILE.test(entry.path)) continue;
    let body: Record<string, unknown>;
    try { body = parseManifestFile(entry.path, bytes).body; } catch { continue; }
    const script = body.script;
    if (typeof script !== "string" || script === "" || /[\\/]/.test(script) || script.startsWith(".")) continue;
    const dir = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/") + 1) : "";
    named.add(`${entry.id}\0${dir}${script}`);
  }
  for (const { entry } of held) {
    if (entry.kind === CHECK_SCRIPT && !named.has(`${entry.id}\0${entry.path}`)) throw new LoopFileError(`${entry.path} is listed as a check's script, and no check of this loop file names it as its script`);
  }
}

/** What an import would do, from checkLoopFile and the registry; writes nothing. */
export async function planImport(file: string, registry: Registry, importsDir: string): Promise<ImportPlan> {
  const held: { entry: LoopFileEntry; bytes: Uint8Array }[] = [];
  const manifest = await readLoopFile(file, (entry, bytes) => void held.push({ entry, bytes }));
  const folder = folderOf(importsDir, manifest);
  if (exists(folder.path)) throw new LoopFileError(`this loop file is already imported as ${folder.name}`);
  const write: LoopFileEntry[] = [];
  const same: LoopFileEntry[] = [];
  const conflicts: ImportPlan["conflicts"] = [];
  const matches = (have: string, entry: LoopFileEntry): boolean => have === entry.sha256 || (entry.origin !== null && have === entry.origin);
  for (const { entry, bytes } of held.sort((a, b) => lt(a.entry.path, b.entry.path))) {
    const ids = idsOf(entry, bytes);
    if (entry.kind === CHECK_SCRIPT) {
      // a check's script goes with its check: the person's check with this id keeps its own script
      const check = registry.get("check", entry.id);
      if (check === null) { write.push(entry); continue; }
      const script = typeof check.body.script === "string" ? join(dirname(check.path), check.body.script) : null;
      let have = "";
      try { have = script === null ? "" : sha256Hex(readFileSync(script)); } catch { have = ""; }
      if (have === entry.sha256) same.push(entry);
      else conflicts.push({ kind: CHECK_SCRIPT, id: entry.id, have, file: entry.path });
      continue;
    }
    let anySame = false;
    let anyConflict = false;
    for (const { kind, id } of ids) {
      const m = registry.get(kind, id);
      if (m === null) continue;
      if (matches(m.hash, entry)) anySame = true;
      else { anyConflict = true; conflicts.push({ kind, id, have: m.hash, file: entry.path }); }
    }
    if (anyConflict) continue;
    (anySame ? same : write).push(entry);
  }
  checkScriptsNamed(held);
  return { manifest, root: folder.path, write, same, conflicts };
}

/** Writes one checked member under `root`, a folder this import made: "wx", inside `root`, flushed before it is closed. */
function writeMember(root: string, path: string, bytes: Uint8Array): void {
  const target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw new LoopFileError(`${path}: a path that leaves the loop file`);
  let fd: number;
  try {
    mkdirSync(dirname(target), { recursive: true });
    fd = openSync(target, "wx");
  } catch (err) {
    throw new LoopFileError(`the loop could not be written: ${reasonOf(err)}`);
  }
  try {
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch (err) {
    throw new LoopFileError(`the loop could not be written: ${reasonOf(err)}`);
  } finally {
    closeSync(fd);
  }
}

/** Carries a plan out: refuses one with conflicts; writes each file with `wx` under a new folder of the imports directory, removing the folder on any failure. Returns the new root. */
export async function importLoop(file: string, registry: Registry, importsDir: string): Promise<{ root: string; written: LoopFileEntry[]; same: LoopFileEntry[] }> {
  const plan = await planImport(file, registry, importsDir);
  if (plan.conflicts.length > 0) {
    const named = plan.conflicts.map((c) => `${c.kind} "${c.id}" (${c.file}) is already loaded with other content`);
    throw new LoopFileError(`nothing was imported: ${named.join("; ")}`);
  }
  const folder = folderOf(importsDir, plan.manifest);
  try {
    mkdirSync(resolve(importsDir), { recursive: true });
    mkdirSync(folder.path);
  } catch (err) {
    if (codeOf(err) === "EEXIST") throw new LoopFileError(`this loop file is already imported as ${folder.name}`);
    throw new LoopFileError(`the loop could not be written: ${reasonOf(err)}`);
  }
  const want = new Map(plan.write.map((e) => [e.path, e]));
  const written = new Set<string>();
  try {
    // the second pass checks every member again: only bytes that are still what the plan approved are written
    const again = await readLoopFile(file, (entry, bytes) => {
      const w = want.get(entry.path);
      if (w === undefined) return;
      if (w.sha256 !== entry.sha256) throw new LoopFileError("the loop file changed while it was imported");
      writeMember(folder.path, entry.path, bytes);
      written.add(entry.path);
    });
    if (canonical(again as unknown as Json) !== canonical(plan.manifest as unknown as Json) || written.size !== want.size) {
      throw new LoopFileError("the loop file changed while it was imported");
    }
  } catch (err) {
    rmSync(folder.path, { recursive: true, force: true });
    throw err instanceof LoopFileError ? err : new LoopFileError(`the loop could not be written: ${reasonOf(err)}`);
  }
  return { root: folder.path, written: plan.write, same: plan.same };
}

// ---------- trust ----------

/** Every manifest file under `dir` (no link followed), root-relative with "/", sorted with `<`. */
function manifestFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const at = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...manifestFiles(dir, at));
    else if (e.isFile() && MANIFEST_FILE.test(e.name)) out.push(at);
  }
  return out.sort(lt);
}

/**
 * Why an imported folder may not be trusted now, from the live registry: each kind and id a manifest of the folder names that the registry already
 * holds from another root (two roots that define one id unload both, so the person's own would vanish). Empty when it may. Writes nothing.
 */
export function trustProblems(folder: string, registry: Registry): string[] {
  const out: string[] = [];
  for (const path of manifestFiles(folder)) {
    let parsed: ReturnType<typeof parseManifestFile>;
    try { parsed = parseManifestFile(path, readFileSync(join(folder, path))); } catch { continue; }
    const ids = parsed.kind === "pivots" || parsed.kind === "types"
      ? (Array.isArray(parsed.body[parsed.kind]) ? (parsed.body[parsed.kind] as unknown[]) : []).filter(isMapping).map((x) => x.id).filter((x): x is string => typeof x === "string").map((id) => ({ kind: parsed.kind === "pivots" ? "pivot" : "type", id }))
      : typeof parsed.body.id === "string" ? [{ kind: parsed.kind, id: parsed.body.id }] : [];
    for (const { kind, id } of ids) {
      const have = registry.get(kind, id);
      if (have === null || resolve(have.root) === resolve(folder)) continue;
      out.push(`${kind} "${id}" (${path}) is already loaded from another root; trusting this folder would unload both`);
    }
  }
  return out;
}
