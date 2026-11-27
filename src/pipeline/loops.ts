// A loop: a pipeline named by a manifest, with where each of its stages' components comes from, and its two hashes.
import { readFileSync } from "node:fs";
import type { Json } from "../core/canonical";
import { canonical, isPlainObject } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { Schema } from "../core/schema";
import { validate } from "../core/schema";
import type { Marking } from "../core/types";
import { loadProfile } from "../agents/context";
import type { Profile } from "../agents/context";
import { describeErrors, parseManifestFile } from "../modules/manifests";
import type { LoadedManifest } from "../modules/manifests";
import type { Registry } from "../modules/registry";
import { CHECK_SCRIPT, ComponentError, ItemComponents, manifestFromBytes, parseSource, resolveComponent, rootRelative, scriptManifest } from "./components";
import type { Components, ResolveContext, ResolvedItem, SourceSpec } from "./components";
import { INPUT_SELECTORS, legacyHash, loadChecks, loadPipeline, pipelineProblem, stageFrom } from "./manifests";
import type { Pipeline, StageManifest } from "./manifests";

export const DEFAULT_LOOP = "investigation";
export const LOCK_FORMAT = 1;

export interface LoopInput { type: "question" | "observables" | "window" | "cards" | "findings" | "product"; required: boolean }
export interface LoopOutput { from: "product" | "findings" | "cards.kept" }
export interface LoopManifest {
  id: string; title: string; about: string; version: number; hash: string; path: string | null; root: string | null; implicit: boolean;
  profile: string; entry: string; stages: (string | Record<string, Json>)[]; inputs: Record<string, LoopInput>; outputs: Record<string, LoopOutput>;
  components: Record<string, Record<string, SourceSpec>>; // stage (or "*") → "kind:id" → source
  uses: { playbooks: string[]; pivots: string[]; sources: string[] };
}
export interface LoopLock {
  format: 1; loop: string; version: number; title: string; about: string; hash: string; legacy_hash: string | null;
  manifest: { path: string | null; hash: string }; profile: string; entry: string; items: ResolvedItem[]; subloops: { stage: string; loop: string; hash: string }[];
}
export interface ResolvedLoop { manifest: LoopManifest; pipeline: Pipeline; profile: Profile; components: Components; lock: LoopLock }
export interface LoopCaps { max_depth: number; max_children: number }
export interface LoopCatalog {
  /** Every loop manifest and the implicit one, by id with `<`: resolved, or with the problems that stop it. */
  list(): { id: string; manifest: LoopManifest | null; loop: ResolvedLoop | null; problems: string[] }[];
  current(id: string): ResolvedLoop | null;
  problems(id: string): string[];
  /** The loop a lock describes, built from the content store alone; the reason when a hash it names is not there. */
  fromLock(lock: LoopLock): ResolvedLoop | string;
  /** The lock a blob holds; null when it is not one. */
  readLock(bytes: Uint8Array): LoopLock | null;
}

/** The note an implicit loop carries: it is usable, and says where it came from. */
export const IMPLICIT_NOTE = "no loop manifest: every stage manifest is the investigation loop";
const INPUT_TYPES = ["question", "observables", "window", "cards", "findings", "product"] as const;
const OUTPUT_FROM = ["product", "findings", "cards.kept"] as const;
const IMPLICIT_IO: Pick<LoopManifest, "inputs" | "outputs"> = {
  inputs: { question: { type: "question", required: true }, observables: { type: "observables", required: true }, window: { type: "window", required: true } },
  outputs: { product: { from: "product" }, findings: { from: "findings" }, cards: { from: "cards.kept" } },
};
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const strList: Schema = { type: "array", items: { type: "string", minLength: 1 } };

const LOOP_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "title", "version", "profile", "entry", "stages"],
  properties: {
    kind: { type: "string", enum: ["loop"] },
    id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    about: { type: "string" },
    version: { type: "integer", minimum: 1 },
    profile: { type: "string", minLength: 1 },
    entry: { type: "string", minLength: 1 },
    stages: { type: "array", minItems: 1, items: { anyOf: [{ type: "string", minLength: 1 }, { type: "object" }] } },
    inputs: {
      type: "object",
      additionalProperties: { type: "object", additionalProperties: false, required: ["type"], properties: { type: { type: "string", enum: [...INPUT_TYPES] }, required: { type: "boolean" } } },
    },
    outputs: { type: "object", additionalProperties: { type: "object", additionalProperties: false, required: ["from"], properties: { from: { type: "string", enum: [...OUTPUT_FROM] } } } },
    components: { type: "object", additionalProperties: { type: "object" } },
    uses: { type: "object", additionalProperties: false, properties: { playbooks: strList, pivots: strList, sources: strList } },
  },
};

/** An inline stage: a stage body without kind, validated as a stage manifest is; its hash is that of its canonical body. */
function inlineStage(body: Record<string, Json>): StageManifest | string {
  if (body.kind !== undefined && body.kind !== "stage") return "an inline stage is a stage body without kind";
  const made = stageFrom({ ...body, kind: "stage" }, sha256Hex(canonical(body)), typeof body.id === "string" ? body.id : "", true);
  if (typeof made === "string") return made;
  made.inline = true;
  return made;
}
const stageIdOf = (s: string | Record<string, Json>): string => (typeof s === "string" ? s : String(s.id));

export function parseLoop(m: LoadedManifest): LoopManifest | string {
  const errors = validate(LOOP_SCHEMA, m.body as Json);
  if (errors.length > 0) return describeErrors(errors);
  const b = m.body as unknown as {
    id: string; title: string; about?: string; version: number; profile: string; entry: string; stages: (string | Record<string, Json>)[];
    inputs?: Record<string, { type: LoopInput["type"]; required?: boolean }>; outputs?: Record<string, LoopOutput>; components?: Record<string, Record<string, Json>>;
    uses?: { playbooks?: string[]; pivots?: string[]; sources?: string[] };
  };
  const ids: string[] = [];
  for (const s of b.stages) {
    if (typeof s !== "string") {
      const made = inlineStage(s);
      if (typeof made === "string") return `stage ${typeof s.id === "string" ? `"${s.id}"` : `${ids.length + 1}`}: ${made}`;
    }
    const id = stageIdOf(s);
    if (ids.includes(id)) return `stage "${id}" is listed twice`;
    ids.push(id);
  }
  if (!ids.includes(b.entry)) return `entry "${b.entry}" is not a stage of this loop`;
  if (ids[0] !== b.entry) return `the entry "${b.entry}" must be the first stage listed`;
  const components: Record<string, Record<string, SourceSpec>> = {};
  for (const [stage, raw] of Object.entries(b.components ?? {})) {
    if (stage !== "*" && !ids.includes(stage)) return `components: "${stage}" is not a stage of this loop`;
    components[stage] = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!/^[^:\s]+:[^:\s]+$/.test(k)) return `components.${stage}: "${k}" is not kind:id`;
      const spec = parseSource(v);
      if (spec === null) return `components.${stage}.${k}: a source is root, { pinned: <sha256> }, { loop-output: <loop>.<output> } or { memory: <store>/<selector> }`;
      components[stage]![k] = spec;
    }
  }
  const inputs: Record<string, LoopInput> = {};
  for (const [k, v] of Object.entries(b.inputs ?? {})) inputs[k] = { type: v.type, required: v.required ?? true };
  return {
    id: b.id, title: b.title, about: b.about ?? "", version: b.version, hash: m.hash, path: m.root === "" ? null : rootRelative(m.root, m.path), root: m.root === "" ? null : m.root,
    implicit: false, profile: b.profile, entry: b.entry, stages: b.stages, inputs, outputs: { ...(b.outputs ?? {}) }, components,
    uses: { playbooks: [...(b.uses?.playbooks ?? [])], pivots: [...(b.uses?.pivots ?? [])], sources: [...(b.uses?.sources ?? [])] },
  };
}

/** The version-2 hash of "How the hard questions are answered". */
export function loopHash(parts: { loop: string; manifest: string; entry: string; stages: [string, string][]; components: [string, string, string, string, string][]; subloops: [string, string, string][] }): string {
  const components = [...parts.components].sort((a, b) => lt(a[0], b[0]) || lt(a[1], b[1]) || lt(a[2], b[2]));
  return sha256Hex(canonical({ v: 2, loop: parts.loop, manifest: parts.manifest, entry: parts.entry, stages: parts.stages, components, subloops: parts.subloops } as unknown as Json));
}

const byItem = (a: ResolvedItem, b: ResolvedItem): number => lt(a.stage, b.stage) || lt(a.kind, b.kind) || lt(a.id, b.id);

/** The hash of a lock's own content, as loopHash computes it. */
function hashOfLock(lock: Pick<LoopLock, "loop" | "manifest" | "entry" | "items" | "subloops">, stages: StageManifest[]): string {
  return loopHash({
    loop: lock.loop, manifest: lock.manifest.hash, entry: lock.entry, stages: stages.map((s): [string, string] => [s.id, s.hash]),
    components: lock.items.filter((i) => i.kind !== "stage").map((i): [string, string, string, string, string] => [i.stage, i.kind, i.id, i.source, i.hash]),
    subloops: lock.subloops.map((x): [string, string, string] => [x.stage, x.loop, x.hash]),
  });
}

/** A profile from its manifest, by the context's own reader (which reads a registry; this one holds the one manifest). */
function profileFrom(m: LoadedManifest): Profile {
  const one = { get: (kind: string, id: string) => (kind === "profile" && id === m.id ? m : null), rootOf: () => ({ path: m.root, trusted: true, credentials: [] }) };
  return loadProfile(one as unknown as Registry, m.id);
}

/** The components a stage has, as kind and id: its profile entry's, its schema, and a checks stage's checks with their scripts. */
function componentsOf(stage: StageManifest, profile: Profile, checks: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  const entry = stage.runs === "loop" || !Object.hasOwn(profile.stages, stage.id) ? null : profile.stages[stage.id]!;
  if (entry !== null) {
    out.push(["persona", entry.persona]);
    if (entry.procedure !== null) out.push(["procedure", entry.procedure]);
    for (const id of entry.skills) out.push(["skill", id]);
    for (const id of entry.references) out.push(["reference", id]);
    for (const id of entry.gates) out.push(["gate", id]);
  }
  if (stage.schema !== null) out.push(["schema", stage.schema]);
  if (stage.role === "checks") for (const id of checks) out.push(["check", id], [CHECK_SCRIPT, id]);
  return out;
}
const profileComponents = (profile: Profile): [string, string][] => [
  ["rules", profile.rules], ...(profile.framework === null ? [] : [["framework", profile.framework] as [string, string]]),
  ...(profile.standard === null ? [] : [["standard", profile.standard] as [string, string]]),
];

interface Slot { id: string; manifest: LoopManifest | null; m: LoadedManifest | null; problems: string[]; loop: ResolvedLoop | null; done: boolean }

export function loadLoops(registry: Registry, ctx: ResolveContext, caps: LoopCaps): LoopCatalog {
  const slots = new Map<string, Slot>();
  const slot = (id: string): Slot => {
    let s = slots.get(id);
    if (s === undefined) { s = { id, manifest: null, m: null, problems: [], loop: null, done: false }; slots.set(id, s); }
    return s;
  };
  const loaded = registry.all("loop");
  for (const m of loaded) {
    const s = slot(m.id);
    s.m = m;
    const parsed = parseLoop(m);
    if (typeof parsed === "string") { s.problems.push(`${rootRelative(m.root, m.path)}: ${parsed}`); s.done = true; }
    else s.manifest = parsed;
  }
  // a loop file the registry refused is listed with its reason
  let refused = 0;
  for (const p of registry.problems) {
    let parsed: ReturnType<typeof parseManifestFile>;
    try { parsed = parseManifestFile(p.path, readFileSync(p.path)); } catch { continue; }
    if (parsed.kind !== "loop") continue;
    refused++;
    const id = typeof parsed.body.id === "string" && parsed.body.id !== "" ? parsed.body.id : rootRelative(p.root, p.path);
    const s = slot(id);
    s.problems.push(`${rootRelative(p.root, p.path)}: ${p.error.split(p.root).join("")}`);
    if (s.manifest === null) s.done = true;
  }
  const implicit = loaded.length === 0 && refused === 0 && registry.all("stage").length > 0;
  if (implicit) {
    const s = slot(DEFAULT_LOOP);
    s.manifest = {
      id: DEFAULT_LOOP, title: "Investigation", about: "", version: 1, hash: sha256Hex(canonical({ implicit: DEFAULT_LOOP })), path: null, root: null, implicit: true,
      profile: DEFAULT_LOOP, entry: "", stages: [], ...IMPLICIT_IO, components: {}, uses: { playbooks: [], pivots: [], sources: [] },
    };
    s.problems.push(IMPLICIT_NOTE);
  }

  const checkIds = loadChecks(registry).checks.map((c) => c.id);
  const trustedStage = (m: LoadedManifest): boolean => registry.rootOf(m.path)?.trusted === true;
  /** The loop a stage of a parsed loop runs, from its inline body or its stage manifest. */
  const childOf = (s: string | Record<string, Json>): string | null => {
    const body = typeof s === "string" ? registry.get("stage", s)?.body ?? null : s;
    return body !== null && body.runs === "loop" && typeof body.loop === "string" ? body.loop : null;
  };
  const children = (id: string): string[] => {
    const man = slots.get(id)?.manifest ?? null;
    return man === null ? [] : man.stages.map(childOf).filter((c): c is string => c !== null);
  };
  /** A path back to `id` through the loops its stages run, or null. */
  const cycleFrom = (id: string): string[] | null => {
    const seen = new Set<string>();
    const walk = (at: string, path: string[]): string[] | null => {
      for (const c of children(at)) {
        if (c === id) return [...path, c];
        if (seen.has(c)) continue;
        seen.add(c);
        const found = walk(c, [...path, c]);
        if (found !== null) return found;
      }
      return null;
    };
    return walk(id, [id]);
  };
  /** The longest chain of sub-loops from `id`, cycles aside. */
  const longest = (id: string, on: Set<string> = new Set()): string[] => {
    let best = [id];
    on.add(id);
    for (const c of children(id)) {
      if (on.has(c)) continue;
      const down = longest(c, on);
      if (down.length + 1 > best.length) best = [id, ...down];
    }
    on.delete(id);
    return best;
  };

  const resolve = (id: string): Slot => {
    const s = slot(id);
    if (s.done) return s;
    s.done = true; // set first: a loop met again while it resolves is a cycle, already refused below
    if (s.manifest === null) { s.problems.push(`there is no loop "${id}"`); return s; }
    const cycle = cycleFrom(id);
    if (cycle !== null) { s.problems.push(`a loop may not run itself: ${cycle.join(" > ")}`); return s; }
    const chain = longest(id);
    if (chain.length - 1 > caps.max_depth) {
      s.problems.push(`the chain of sub-loops ${chain.join(" > ")} is ${chain.length - 1} deep; loops.max_depth is ${caps.max_depth}`);
      return s;
    }
    // each sub-loop stage makes at least one child a run
    const subs = children(id).length;
    if (subs > caps.max_children) {
      s.problems.push(`loop "${id}" has ${subs} sub-loop stages; loops.max_children is ${caps.max_children}`);
      return s;
    }
    let made: ResolvedLoop | string[];
    try {
      made = resolveLoop(s.manifest, s.problems);
    } catch (err) {
      made = [`loop "${id}" cannot be resolved: ${err instanceof Error ? err.message : String(err)}`];
    }
    if (Array.isArray(made)) s.problems.push(...made);
    else s.loop = made;
    return s;
  };

  /** The loop resolved, or the problems that stop it; `notes` takes what does not (an implicit loop's left-out stage manifests). */
  const resolveLoop = (man: LoopManifest, notes: string[]): ResolvedLoop | string[] => {
    const problems: string[] = [];
    // the stages, in the order listed
    let stages: StageManifest[] = [];
    const stageItems: { manifest: LoadedManifest | null; item: ResolvedItem; body: Json }[] = [];
    if (man.implicit) {
      const built = loadPipeline(registry);
      if (built.pipeline === null) return built.problems;
      stages = built.pipeline.stages;
      notes.push(...built.problems);
      man.entry = stages[0]!.id;
      man.stages = stages.map((x) => x.id);
    } else {
      for (const raw of man.stages) {
        if (typeof raw !== "string") { stages.push(inlineStage(raw) as StageManifest); continue; }
        const m = registry.get("stage", raw);
        if (m === null) { problems.push(`stage "${raw}" is no stage manifest and no inline stage`); continue; }
        const made = stageFrom(m.body, m.hash, m.title, trustedStage(m));
        if (typeof made === "string") problems.push(`stage "${raw}" (${rootRelative(m.root, m.path)}): ${made}`);
        else stages.push(made);
      }
      if (problems.length > 0) return problems;
      const problem = pipelineProblem(stages);
      if (problem !== null) return [problem];
    }
    for (const [i, st] of stages.entries()) {
      const raw = man.implicit ? st.id : man.stages[i]!;
      if (typeof raw === "string") {
        const m = registry.get("stage", st.id)!;
        stageItems.push({ manifest: m, item: { stage: st.id, kind: "stage", id: st.id, title: st.title, source: "root", hash: st.hash, path: rootRelative(m.root, m.path) }, body: null });
      } else {
        stageItems.push({ manifest: null, item: { stage: st.id, kind: "stage", id: st.id, title: st.title, source: "inline", hash: st.hash, path: null }, body: raw });
      }
    }

    // sub-loops: the child resolves first, and what this stage hands it and takes back must fit it
    const subloops: { stage: string; loop: string; hash: string }[] = [];
    for (const st of stages) {
      if (st.subloop == null) continue;
      const child = st.subloop.loop;
      const c = slots.has(child) ? resolve(child) : null;
      if (c === null || c.manifest === null) { problems.push(`stage "${st.id}" runs loop "${child}", which is not a loop here`); continue; }
      if (c.loop === null) { problems.push(`stage "${st.id}": sub-loop "${child}" is not usable: ${c.problems.filter((p) => p !== IMPLICIT_NOTE)[0] ?? "it has problems"}`); continue; }
      const cm = c.loop.manifest;
      for (const [name, input] of Object.entries(cm.inputs)) {
        if (input.required && !Object.hasOwn(st.subloop.inputs, name)) problems.push(`stage "${st.id}": loop "${child}" needs input "${name}"`);
      }
      for (const [name, sel] of Object.entries(st.subloop.inputs)) {
        if (!Object.hasOwn(cm.inputs, name)) { problems.push(`stage "${st.id}": loop "${child}" has no input "${name}"`); continue; }
        const want = cm.inputs[name]!.type;
        if (INPUT_SELECTORS[sel] !== want) problems.push(`stage "${st.id}": input "${name}" is a ${want}, and ${sel} gives a ${INPUT_SELECTORS[sel]}`);
      }
      for (const [name, r] of Object.entries(st.subloop.returns)) {
        if (!Object.hasOwn(cm.outputs, name)) { problems.push(`stage "${st.id}": loop "${child}" has no output "${name}"`); continue; }
        const from = cm.outputs[name]!.from;
        if (r.as === "draft_section" && from !== "product" && from !== "findings") problems.push(`stage "${st.id}": returns.${name}: a draft section takes a product or findings output, and "${name}" is ${from}`);
      }
      subloops.push({ stage: st.id, loop: child, hash: c.loop.pipeline.hash });
    }

    // the profile, then every component of every stage, each from its source
    const specOf = (stage: string, kind: string, id: string): SourceSpec => man.components[stage]?.[`${kind}:${id}`] ?? "root";
    const resolved: { manifest: LoadedManifest; item: ResolvedItem }[] = [];
    let profile: Profile;
    try {
      const p = resolveComponent(ctx, "*", "profile", man.profile, specOf("*", "profile", man.profile));
      profile = profileFrom(p.manifest);
      resolved.push(p);
    } catch (err) {
      return [...problems, `profile "${man.profile}": ${err instanceof Error ? err.message : String(err)}`];
    }
    const named = new Map<string, Set<string>>([["*", new Set([`profile:${man.profile}`])]]);
    const want: [string, string, string][] = profileComponents(profile).map(([k, i]) => ["*", k, i]);
    for (const st of stages) {
      if (st.runs === "agent" && !Object.hasOwn(profile.stages, st.id)) problems.push(`stage "${st.id}" runs an agent, and profile "${profile.id}" has no entry for it`);
      for (const [k, i] of componentsOf(st, profile, checkIds)) want.push([st.id, k, i]);
    }
    for (const [stage, kind, id] of want) {
      const set = named.get(stage) ?? new Set<string>();
      if (set.has(`${kind}:${id}`)) continue;
      set.add(`${kind}:${id}`);
      named.set(stage, set);
      try {
        resolved.push(resolveComponent(ctx, stage, kind, id, specOf(stage, kind, id)));
      } catch (err) {
        if (!(err instanceof ComponentError)) throw err;
        problems.push(`${stage === "*" ? `profile "${profile.id}"` : `stage "${stage}"`}: ${err.message}`);
      }
    }
    for (const [stage, given] of Object.entries(man.components)) {
      for (const k of Object.keys(given)) if (!(named.get(stage)?.has(k) ?? false)) problems.push(`components.${stage}: "${k}" is not a component of stage ${stage}`);
    }
    if (problems.length > 0) return problems;

    // the bytes of everything the lock names are in the content store
    if (man.path !== null && !ctx.content.has(man.hash)) {
      const m = registry.get("loop", man.id);
      if (m !== null) ctx.content.put(new Uint8Array(readFileSync(m.path)));
    }
    for (const x of stageItems) {
      if (x.manifest !== null && !ctx.content.has(x.item.hash)) ctx.content.put(new Uint8Array(readFileSync(x.manifest.path)));
      if (x.body !== null) ctx.content.put(canonical(x.body));
    }
    const items = [...stageItems.map((x) => x.item), ...resolved.map((r) => r.item)].sort(byItem);
    const legacy = stages.every((x) => x.inline !== true && x.runs !== "loop") ? legacyHash(stages) : null;
    const draft = { loop: man.id, manifest: { path: man.path, hash: man.hash }, entry: man.entry, items, subloops };
    const lock: LoopLock = {
      format: LOCK_FORMAT, loop: man.id, version: man.version, title: man.title, about: man.about, hash: hashOfLock(draft, stages), legacy_hash: legacy,
      manifest: draft.manifest, profile: man.profile, entry: man.entry, items, subloops,
    };
    ctx.content.put(canonical(lock as unknown as Json));
    return {
      manifest: man, pipeline: { id: man.id, hash: lock.hash, legacy_hash: legacy, stages }, profile, components: ItemComponents.of(resolved), lock,
    };
  };

  for (const id of [...slots.keys()]) resolve(id);
  const ids = [...slots.keys()].sort(lt);

  return {
    list: () => ids.map((id) => { const s = slots.get(id)!; return { id, manifest: s.manifest, loop: s.loop, problems: [...s.problems] }; }),
    current: (id) => slots.get(id)?.loop ?? null,
    problems: (id) => (slots.has(id) ? [...slots.get(id)!.problems] : [`there is no loop "${id}"`]),
    fromLock: (lock) => fromLock(ctx, lock),
    readLock,
  };
}

class Missing extends Error {}

/** The loop a lock describes, from the content store alone. */
function fromLock(ctx: ResolveContext, lock: LoopLock): ResolvedLoop | string {
  const bytesOf = (hash: string, what: string): Uint8Array => {
    if (ctx.content.check(hash) !== "ok") throw new Missing(`the content store does not hold ${what} (${hash})`);
    return ctx.content.get(hash);
  };
  try {
    const stageItem = new Map(lock.items.filter((i) => i.kind === "stage").map((i) => [i.id, i]));
    let man: LoopManifest;
    let listed: (string | Record<string, Json>)[];
    if (lock.manifest.path !== null) {
      const m = manifestFromBytes(bytesOf(lock.manifest.hash, `loop "${lock.loop}"`), { kind: "loop", id: lock.loop, root: "", path: lock.manifest.path });
      const parsed = parseLoop(m);
      if (typeof parsed === "string") return `loop "${lock.loop}" in the content store: ${parsed}`;
      man = { ...parsed, path: lock.manifest.path, root: null };
      listed = parsed.stages;
    } else {
      man = {
        id: lock.loop, title: lock.title, about: lock.about, version: lock.version, hash: lock.manifest.hash, path: null, root: null, implicit: true,
        profile: lock.profile, entry: lock.entry, stages: [], ...IMPLICIT_IO, components: {}, uses: { playbooks: [], pivots: [], sources: [] },
      };
      listed = [...stageItem.keys()];
    }
    const stages: StageManifest[] = [];
    for (const raw of listed) {
      let made: StageManifest | string;
      if (typeof raw !== "string") made = inlineStage(raw);
      else {
        const item = stageItem.get(raw);
        if (item === undefined || item.path === null) return `the lock names no stage "${raw}"`;
        const m = manifestFromBytes(bytesOf(item.hash, `stage "${raw}"`), { kind: "stage", id: raw, root: "", path: item.path });
        made = stageFrom(m.body, item.hash, m.title, true);
      }
      if (typeof made === "string") return `stage "${stageIdOf(raw)}" in the content store: ${made}`;
      stages.push(made);
    }
    if (lock.manifest.path === null) {
      stages.sort((a, b) => a.order - b.order);
      man.stages = stages.map((s) => s.id);
    }
    const entries: { manifest: LoadedManifest; item: ResolvedItem }[] = [];
    let profile: Profile | null = null;
    for (const item of lock.items) {
      if (item.kind === "stage") continue;
      let m: LoadedManifest;
      if (item.source === "loop-output") {
        const text = new TextDecoder().decode(bytesOf(item.hash, `reference "${item.id}"`));
        const marking: Marking | null = item.origin?.marking ?? null;
        m = { kind: "reference", id: item.id, title: item.title, hash: item.hash, root: "", path: "", dir: "", body: { kind: "reference", id: item.id, title: item.title, marking }, text };
      } else if (item.kind === CHECK_SCRIPT) {
        m = scriptManifest(item.id, bytesOf(item.hash, `the script of check "${item.id}"`), "", item.path ?? "");
      } else {
        m = manifestFromBytes(bytesOf(item.hash, `${item.kind} "${item.id}"`), { kind: item.kind, id: item.id, root: "", path: item.path ?? "" });
      }
      if (item.stage === "*" && item.kind === "profile") profile = profileFrom(m);
      entries.push({ manifest: m, item: { ...item } });
    }
    if (profile === null) return `the lock of loop "${lock.loop}" names no profile`;
    const hash = hashOfLock(lock, stages);
    if (hash !== lock.hash) return `the lock of loop "${lock.loop}" does not hash to ${lock.hash.slice(0, 12)}`;
    return { manifest: man, pipeline: { id: lock.loop, hash, legacy_hash: lock.legacy_hash, stages }, profile, components: ItemComponents.of(entries), lock };
  } catch (err) {
    if (err instanceof Missing) return err.message;
    return `the lock of loop "${lock.loop}" cannot be rebuilt: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const SOURCES: readonly string[] = ["root", "pinned", "loop-output", "inline"];
function isItem(x: unknown): x is ResolvedItem {
  if (!isPlainObject(x)) return false;
  const o = x as Record<string, unknown>;
  if (!["stage", "kind", "id", "title"].every((k) => typeof o[k] === "string")) return false;
  if (typeof o.source !== "string" || !SOURCES.includes(o.source) || typeof o.hash !== "string" || !HEX64.test(o.hash)) return false;
  if (o.path !== null && typeof o.path !== "string") return false;
  if (o.origin !== undefined) {
    if (!isPlainObject(o.origin)) return false;
    const g = o.origin as Record<string, unknown>;
    if (typeof g.case !== "string" || typeof g.head !== "string" || typeof g.marking !== "string") return false;
  }
  return true;
}

/** The lock a blob holds; null when it is not one. */
export function readLock(bytes: Uint8Array): LoopLock | null {
  let x: unknown;
  try { x = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; }
  if (!isPlainObject(x)) return null;
  const o = x as Record<string, unknown>;
  if (o.format !== LOCK_FORMAT) return null;
  for (const k of ["loop", "title", "about", "hash", "profile", "entry"]) if (typeof o[k] !== "string") return null;
  if (typeof o.version !== "number" || !HEX64.test(o.hash as string)) return null;
  if (o.legacy_hash !== null && (typeof o.legacy_hash !== "string" || !HEX64.test(o.legacy_hash))) return null;
  if (!isPlainObject(o.manifest)) return null;
  const man = o.manifest as Record<string, unknown>;
  if ((man.path !== null && typeof man.path !== "string") || typeof man.hash !== "string") return null;
  if (!Array.isArray(o.items) || !o.items.every(isItem)) return null;
  if (!Array.isArray(o.subloops) || !o.subloops.every((s) => isPlainObject(s) && ["stage", "loop", "hash"].every((k) => typeof (s as Record<string, unknown>)[k] === "string"))) return null;
  return x as unknown as LoopLock;
}
