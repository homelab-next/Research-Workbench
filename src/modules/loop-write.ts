// Saving manifests into a trusted root: checked first on a copy of the root, written by a person only, recorded on the workbench chain.
import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { BlobStore } from "../core/blobs";
import type { Json } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { Ledger } from "../core/ledger";
import { Refused } from "../core/refused";
import type { Actor } from "../core/types";
import { guardProblems, latestOutput } from "../cli/compose";
import { rootsOf } from "./config";
import type { Config, RootConfig } from "./config";
import { parseManifestFile } from "./manifests";
import type { Registry } from "./registry";
import { loadRegistry } from "./registry-record";
import { MIN_SECRET_LENGTH } from "./secrets";
import { toYaml } from "./yaml-write";
import { rootRelative } from "../pipeline/components";
import type { ResolveContext } from "../pipeline/components";
import { DEFAULT_LOOP, IMPLICIT_NOTE, loadLoops } from "../pipeline/loops";
import type { LoopCatalog, LoopManifest, ResolvedLoop } from "../pipeline/loops";
import type { StageManifest } from "../pipeline/manifests";

export class WriteRefused extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "WriteRefused";
  }
}

export interface ManifestFile { path: string; text: string } // path is relative to the write root, `/` separated
/** The kinds a save may write, and where: loop → loops/<id>.yaml; the builder's other kinds keep the path given. */
export const WRITABLE_KINDS: readonly string[] = ["loop", "stage", "source", "pivots", "playbook", "skill"];
export interface ChangeCheck { ok: boolean; problems: string[]; files: { path: string; kind: string; id: string; hash: string; before: string | null }[] }
export interface SaveDeps { config: Config; chain: Ledger; content: BlobStore; secrets: readonly string[] }
/** A loop as the forms edit it: the manifest's fields, every stage inline. */
export interface LoopDraft { id: string; title: string; about: string; profile: string; entry: string; stages: Record<string, Json>[]; inputs: Json; outputs: Json; components: Json; uses: Json }

/** The first line of a loop file the workbench writes. */
export const WRITTEN_HEADER = "# written by the workbench; edit it in the Loops page or by hand";
const MANIFEST_FILE = /\.(?:ya?ml|md)$/i;
const LOOP_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const sameDir = (a: string, b: string): boolean => resolve(a) === resolve(b);

/** The root a save writes into: the trusted root that holds the loop's manifest, else the first trusted root of the configuration. Throws WriteRefused when there is none. */
export function writeRoot(config: Config, loop: LoopManifest | null): string {
  const trusted = config.roots.filter((r) => r.trusted);
  if (loop !== null && loop.root !== null) {
    const holds = trusted.find((r) => sameDir(r.path, loop.root!));
    if (holds !== undefined) return holds.path;
  }
  if (trusted.length === 0) throw new WriteRefused("the configuration has no trusted root to save into");
  return trusted[0]!.path;
}

/** Why a path may not be written, or null. */
function pathProblem(path: string): string | null {
  const segments = path.split("/");
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path) || segments.some((s) => s === "" || s === "." || s === "..")) {
    return "a path inside the root, relative and without ..";
  }
  if (segments.some((s) => s.startsWith("."))) return "the registry does not read a file or folder whose name starts with .";
  if (segments.slice(0, -1).includes("data")) return "the registry does not read a folder named data";
  if (!MANIFEST_FILE.test(segments.at(-1)!)) return "the registry reads .yaml, .yml and .md files only";
  return null;
}

/** A content store that reads the workbench's and keeps what is put in it apart, in its own folder: a check puts nothing in the real one. */
class Overlay extends BlobStore {
  constructor(dir: string, private readonly base: BlobStore) {
    super(dir);
  }
  override has(hash: string): boolean {
    return super.has(hash) || this.base.has(hash);
  }
  override check(hash: string): "ok" | "missing" | "corrupt" {
    const own = super.check(hash);
    return own === "ok" || this.base.check(hash) !== "ok" ? own : "ok";
  }
  override get(hash: string): Uint8Array {
    return super.has(hash) ? super.get(hash) : this.base.get(hash);
  }
}

/** Every regular manifest file of a root, as the registry walks it (no dot-file, no link, no folder named data), and every check's script in the root. */
function copyRoot(from: string, to: string, registry: Registry): void {
  const copy = (src: string): void => {
    const dest = join(to, rootRelative(from, src));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  };
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "data") walk(full); }
      else if (e.isFile() && MANIFEST_FILE.test(e.name)) copy(full);
    }
  };
  walk(from);
  for (const m of registry.all("check")) {
    if (!sameDir(m.root, from) || typeof m.body.script !== "string") continue;
    const script = resolve(dirname(m.path), m.body.script);
    if (!script.startsWith(resolve(from) + sep)) continue;
    try {
      if (lstatSync(script).isFile()) copy(script);
    } catch { /* a missing script is the registry's and the loops' problem, the same before and after */ }
  }
}

interface Planned { path: string; text: string; kind: string; id: string; hash: string; before: string | null }

/** A file's kind and id, or why it cannot be written. */
function inspect(path: string, text: string, secrets: readonly string[]): { kind: string; id: string } | string {
  const problem = pathProblem(path);
  if (problem !== null) return problem;
  if (secrets.some((s) => s.length >= MIN_SECRET_LENGTH && text.includes(s))) return "it holds the value of a secret the workbench keeps; it is not saved";
  let parsed: ReturnType<typeof parseManifestFile>;
  try {
    parsed = parseManifestFile(path, new TextEncoder().encode(text));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (!WRITABLE_KINDS.includes(parsed.kind)) return `a save may not write a ${parsed.kind}`;
  if (parsed.kind === "pivots") {
    const ids = Array.isArray(parsed.body.pivots) ? parsed.body.pivots.map((p) => (typeof p === "object" && p !== null && !Array.isArray(p) && typeof p.id === "string" ? p.id : "")) : [];
    return { kind: "pivots", id: ids.filter((i) => i !== "").join(",") };
  }
  const id = parsed.body.id;
  if (typeof id !== "string" || id === "") return "missing or invalid id";
  return { kind: parsed.kind, id };
}

/** The text of the explicit loop that names the implicit loop's stages in order, so a save does not change it under the person. */
function implicitText(loop: ResolvedLoop): string {
  const m = loop.manifest;
  const stages = loop.pipeline.stages.map((s) => s.id);
  return `${WRITTEN_HEADER}\n${toYaml({
    kind: "loop", id: m.id, title: m.title, about: m.about, version: 1, profile: m.profile, entry: stages[0]!, stages,
    inputs: m.inputs as unknown as Json, outputs: m.outputs as unknown as Json,
  })}`;
}

/** checkChange, and the texts a save writes. */
function plan(deps: SaveDeps, root: string, files: ManifestFile[]): { check: ChangeCheck; planned: Planned[] } {
  const refused = (problems: string[], planned: Planned[] = []): { check: ChangeCheck; planned: Planned[] } => ({
    check: { ok: false, problems, files: planned.map(({ text: _t, ...f }) => f) }, planned,
  });
  const rootConfig = deps.config.roots.find((r) => r.trusted && sameDir(r.path, root));
  if (rootConfig === undefined) return refused(["the folder to save into is not a trusted root of the configuration"]);
  if (files.length === 0) return refused(["there is nothing to save"]);

  const problems: string[] = [];
  const seen = new Set<string>();
  const inspected: { path: string; text: string; kind: string; id: string }[] = [];
  for (const f of files) {
    if (typeof f.path !== "string" || typeof f.text !== "string") { problems.push("a file is a path and a text"); continue; }
    if (seen.has(f.path)) { problems.push(`${f.path}: the file is given twice`); continue; }
    seen.add(f.path);
    const got = inspect(f.path, f.text, deps.secrets);
    if (typeof got === "string") problems.push(`${f.path}: ${got}`);
    else inspected.push({ path: f.path, text: f.text, ...got });
  }
  if (problems.length > 0) return refused(problems);

  const roots = rootsOf(deps.config);
  const caps = { max_depth: deps.config.loops.max_depth, max_children: deps.config.loops.max_children };
  const trusted = roots.filter((r) => r.trusted).map((r) => r.path);
  mkdirSync(join(deps.config.data_dir, "tmp"), { recursive: true });
  const scratch = mkdtempSync(join(deps.config.data_dir, "tmp", "check-"));
  try {
    const content = new Overlay(join(scratch, "blobs"), deps.content);
    const ctx = (registry: Registry): ResolveContext => ({
      registry, content, chain: deps.chain, trusted, output: (loop, output) => latestOutput(deps.chain, deps.content, loop, output),
    });
    const before = loadRegistry(roots);
    const beforeLoops = loadLoops(before, ctx(before), caps);

    // a loop is written where it is, or as loops/<id>.yaml
    for (const f of inspected) {
      if (f.kind !== "loop") continue;
      const held = before.all("loop").find((m) => m.id === f.id && sameDir(m.root, root));
      const where = held === undefined ? `loops/${f.id}.yaml` : rootRelative(held.root, held.path);
      if (f.path !== where) problems.push(`${f.path}: loop "${f.id}" is saved as ${where}`);
    }
    // the implicit loop becomes an explicit one in the same save
    const implicit = beforeLoops.list().find((x) => x.manifest?.implicit === true && x.loop !== null);
    if (implicit !== undefined && !inspected.some((f) => f.kind === "loop" && f.id === DEFAULT_LOOP)) {
      inspected.push({ path: `loops/${DEFAULT_LOOP}.yaml`, text: implicitText(implicit.loop!), kind: "loop", id: DEFAULT_LOOP });
    }
    const planned: Planned[] = [];
    for (const f of inspected) {
      const at = join(root, ...f.path.split("/"));
      let before: string | null = null;
      try {
        const st = lstatSync(at);
        if (!st.isFile()) { problems.push(`${f.path}: there is something there that is not a file`); continue; }
        before = sha256Hex(new Uint8Array(readFileSync(at)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") { problems.push(`${f.path}: ${(err as Error).message}`); continue; }
      }
      planned.push({ ...f, hash: sha256Hex(new TextEncoder().encode(f.text)), before });
    }
    if (problems.length > 0) return refused(problems, planned);

    // the copy, with the files laid over it, loaded in the root's place
    const copy = join(scratch, "root");
    mkdirSync(copy);
    copyRoot(root, copy, before);
    for (const f of planned) {
      const at = join(copy, ...f.path.split("/"));
      mkdirSync(dirname(at), { recursive: true });
      writeText(at, f.text);
    }
    const swapped: RootConfig[] = roots.map((r) => (sameDir(r.path, root) ? { ...r, path: copy } : r));
    const after = loadRegistry(swapped);
    const afterLoops = loadLoops(after, ctx(after), caps);
    const shown = (s: string): string => s.split(copy + sep).join("").split(copy).join("").split(resolve(root) + sep).join("").split(resolve(root)).join("");

    const keyOf = (p: { root: string; path: string; error: string }, from: string, as: string): string => {
      const at = sameDir(p.root, from) ? as : p.root;
      return `${at}\0${rootRelative(p.root, p.path)}\0${p.error.split(p.root).join("")}`;
    };
    const had = new Set(before.problems.map((p) => keyOf(p, root, root)));
    const writtenPaths = new Set(planned.map((f) => f.path));
    for (const p of after.problems) {
      const inRoot = sameDir(p.root, copy);
      const rel = rootRelative(p.root, p.path);
      if (had.has(keyOf(p, copy, root)) && !(inRoot && writtenPaths.has(rel))) continue;
      problems.push(`${rel}: ${shown(p.error)}`);
    }

    // every loop usable before is usable after, and every loop the files write is usable
    const usable = new Map(beforeLoops.list().map((x) => [x.id, x.loop !== null]));
    const writes = new Set(planned.filter((f) => f.kind === "loop").map((f) => f.id));
    for (const x of afterLoops.list()) {
      if (x.loop !== null || !(usable.get(x.id) === true || writes.has(x.id))) continue;
      const own = x.problems.filter((p) => p !== IMPLICIT_NOTE);
      problems.push(...(own.length === 0 ? ["it is not usable"] : own).map((p) => `loop "${x.id}": ${shown(p)}`));
    }
    for (const id of writes) if (!afterLoops.list().some((x) => x.id === id)) problems.push(`loop "${id}": it is not loaded`);

    // every pivot the files write, or that reads a source they write, renders against the guard
    const sources = new Set(planned.filter((f) => f.kind === "source").map((f) => f.id));
    for (const pv of guardProblems(after, (pv) => {
      const m = after.get("pivot", pv.id);
      return (m !== null && sameDir(m.root, copy) && writtenPaths.has(rootRelative(m.root, m.path))) || sources.has(pv.source);
    })) {
      const m = after.get("pivot", pv.id);
      problems.push(`${m === null ? "" : `${rootRelative(m.root, m.path)}: `}pivot "${pv.id}": ${shown(pv.problem)}`);
    }
    return problems.length > 0 ? refused(problems, planned) : { check: { ok: true, problems: [], files: planned.map(({ text: _t, ...f }) => f) }, planned };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Writes a file whole under a name the registry does not read, flushes it and renames it into place. */
function writeText(at: string, text: string): void {
  const tmp = join(dirname(at), `.${randomUUID()}.tmp`);
  try {
    const fd = openSync(tmp, "wx", 0o644);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, at);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * What a save of these files would leave: a copy of every manifest file (and every check script) of the write root is made under a temporary
 * directory, the files are laid over it, and the roots are loaded with that copy in the root's place (loadRegistry, then loadLoops with the same caps).
 * Refused: a path outside the root, a path the registry would not read, a kind not in WRITABLE_KINDS, a file that holds a secret value, any registry
 * problem the root did not have before, and any loop that was usable and is not now or that the files add and is not usable. Writes nothing in the root.
 */
export function checkChange(deps: SaveDeps, root: string, files: ManifestFile[]): ChangeCheck {
  return plan(deps, root, files).check;
}

/** Runs checkChange, then writes each file (temporary name, fsync, rename), then appends manifest.written per file to the chain. Only for a person: any other actor is refused before anything is read. */
export function saveManifests(deps: SaveDeps, root: string, files: ManifestFile[], by: { actor: Actor; why: "save" | "copy" | "builder"; session: string | null }): ChangeCheck {
  if (by.actor.kind !== "human") throw new WriteRefused("only a person may write a manifest into a root");
  const { check, planned } = plan(deps, root, files);
  if (!check.ok) return check;
  // every text is written beside its place first; only then is each renamed into place
  const staged: { tmp: string; at: string }[] = [];
  try {
    for (const f of planned) {
      const at = join(root, ...f.path.split("/"));
      mkdirSync(dirname(at), { recursive: true });
      const tmp = join(dirname(at), `.${randomUUID()}.tmp`);
      staged.push({ tmp, at });
      const fd = openSync(tmp, "wx", 0o644);
      try {
        writeSync(fd, f.text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  } catch (err) {
    for (const s of staged) rmSync(s.tmp, { force: true });
    throw new WriteRefused(`the files could not be written; none was: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const s of staged) renameSync(s.tmp, s.at);
  for (const d of new Set(staged.map((s) => dirname(s.at)))) {
    try {
      const fd = openSync(d, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    } catch { /* some file systems refuse fsync on a folder; the renames are done */ }
  }
  const rootPath = deps.config.roots.find((r) => r.trusted && sameDir(r.path, root))!.path;
  deps.chain.appendMany(planned.map((f) => ({
    type: "manifest.written" as const, actor: by.actor,
    payload: { root: rootPath, path: f.path, kind: f.kind, id: f.id, hash: f.hash, before: f.before, why: by.why, session: by.session },
  })));
  return check;
}

/** A parsed stage as the body that parses to it. */
function stageBody(s: StageManifest): Record<string, Json> {
  const b: Record<string, Json> = {
    id: s.id, title: s.title, order: s.order, phase: s.phase, runs: s.runs, role: s.role, gate: s.gate, reviews: s.reviews, tools: [...s.tools],
    schema: s.schema, model: s.model === null ? null : { ...s.model }, on_pass: s.on_pass, on_fail: s.on_fail,
  };
  if (s.fast_model != null) b.fast_model = { ...s.fast_model };
  if (s.sampling != null) b.sampling = JSON.parse(JSON.stringify(s.sampling)) as Json;
  if (s.max_output_tokens != null) b.max_output_tokens = s.max_output_tokens;
  if (s.max_turns != null) b.max_turns = s.max_turns;
  if (s.request_extra != null) b.request_extra = JSON.parse(JSON.stringify(s.request_extra)) as Json;
  if (s.subloop != null) {
    b.loop = s.subloop.loop;
    b.inputs = { ...s.subloop.inputs };
    b.returns = JSON.parse(JSON.stringify(s.subloop.returns)) as Json;
  }
  return b;
}

/** The loop with every stage written inline and a new id, title and version 1. */
export function copyOf(loop: ResolvedLoop, id: string, title: string): LoopDraft {
  const m = loop.manifest;
  const inline = new Map<string, Record<string, Json>>();
  for (const raw of m.stages) if (typeof raw !== "string") inline.set(String(raw.id), raw);
  const stages = loop.pipeline.stages.map((s) => {
    const raw = inline.get(s.id);
    if (raw === undefined) return stageBody(s);
    const { kind: _k, ...body } = JSON.parse(JSON.stringify(raw)) as Record<string, Json>;
    return body;
  });
  const clone = (x: unknown): Json => JSON.parse(JSON.stringify(x)) as Json;
  return {
    id, title, about: m.about, profile: m.profile, entry: loop.pipeline.stages[0]!.id, stages,
    inputs: clone(m.inputs), outputs: clone(m.outputs), components: clone(m.components), uses: clone(m.uses),
  };
}

/** The loop as the forms edit it: its own id and title, every stage inline. */
export function draftOf(loop: ResolvedLoop): LoopDraft {
  return copyOf(loop, loop.manifest.id, loop.manifest.title);
}

/** The loop file's text for a draft, with `version`. */
export function loopText(draft: LoopDraft, version: number): string {
  return `${WRITTEN_HEADER}\n${toYaml({
    kind: "loop", id: draft.id, title: draft.title, about: draft.about, version, profile: draft.profile, entry: draft.entry, stages: draft.stages,
    inputs: draft.inputs, outputs: draft.outputs, components: draft.components, uses: draft.uses,
  })}`;
}

const checkId = (id: string): void => {
  if (typeof id !== "string" || !LOOP_ID.test(id) || id.includes("..")) throw new WriteRefused(`a loop id is 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or digit`);
};

/** Saves a form-edited loop as its next version. `version` is the one the person's screen loaded (null for a new loop): another current version is refused. */
export function saveLoop(deps: SaveDeps & { loops: LoopCatalog }, draft: LoopDraft, version: number | null, by: { actor: Actor }): ChangeCheck {
  checkId(draft.id);
  const man = deps.loops.list().find((x) => x.id === draft.id)?.manifest ?? null;
  const current = man === null ? null : man.version;
  if (version !== current) throw new WriteRefused("the loop changed since you opened it");
  const root = writeRoot(deps.config, man);
  const path = man !== null && !man.implicit && man.root !== null && man.path !== null && sameDir(man.root, root) ? man.path : `loops/${draft.id}.yaml`;
  return saveManifests(deps, root, [{ path, text: loopText(draft, (current ?? 0) + 1) }], { actor: by.actor, why: "save", session: null });
}

/** Saves a copy of a usable loop under a new id, every stage inline, version 1. Refused when a loop of that id exists. */
export function copyLoop(deps: SaveDeps & { loops: LoopCatalog }, from: string, id: string, title: string, by: { actor: Actor }): ChangeCheck {
  checkId(id);
  if (deps.loops.list().some((x) => x.id === id)) throw new WriteRefused(`there is already a loop "${id}"`);
  const source = deps.loops.current(from);
  if (source === null) throw new WriteRefused(`loop "${from}" is not usable: ${deps.loops.problems(from).filter((p) => p !== IMPLICIT_NOTE).join("; ")}`);
  const root = writeRoot(deps.config, source.manifest);
  return saveManifests(deps, root, [{ path: `loops/${id}.yaml`, text: loopText(copyOf(source, id, title), 1) }], { actor: by.actor, why: "copy", session: null });
}
