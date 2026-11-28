// An improve candidate: a change of what a loop already has, checked by the candidate rules after the save's own check, and staged beside the
// live registry: the target loop as the files would leave it, rebuilt from its lock over a store of its own. Nothing here writes a root, the
// workbench chain or the content store.
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { BlobStore } from "../core/blobs";
import { canonical, isPlainObject } from "../core/canonical";
import type { Json } from "../core/canonical";
import { rootRelative } from "../pipeline/components";
import type { LoopCatalog, ResolvedLoop } from "../pipeline/loops";
import { checkChange, planChange } from "./loop-write";
import type { ChangeCheck, ManifestFile, SaveDeps } from "./loop-write";
import { parseManifestFile } from "./manifests";
import type { Registry } from "./registry";

/** The kinds a candidate may change. */
export const CANDIDATE_KINDS: readonly string[] = ["skill", "procedure", "playbook", "source", "stage", "loop"];

type CandidateDeps = SaveDeps & { loops: LoopCatalog; registry: Registry };
type Body = Record<string, Json>;

const ADDS_NO_FILE = "a candidate changes what the loop has; it adds no file";
const SOURCE_ONLY = "a candidate changes a source's field notes only: never its location, connector, credential, marking, tables or cost";
const STAGE_ONLY = "a candidate changes a stage's tools, turns or effort only";
const LOOP_ONLY = "a candidate changes a loop file's inline stages only: never its profile, entry, stage list, components, uses, inputs, outputs or case_type";
/** The keys of a column or an endpoint field a candidate may change. */
const FIELD_NOTES = ["meaning", "reveals", "extract"] as const;

const sameDir = (a: string, b: string): boolean => resolve(a) === resolve(b);
const same = (a: Json, b: Json): boolean => {
  try {
    return canonical(a) === canonical(b);
  } catch {
    return false;
  }
};
const without = (body: Body, keys: readonly string[]): Body => Object.fromEntries(Object.entries(body).filter(([k]) => !keys.includes(k)));

/** A stage body with what a candidate may change taken out: its tools, its turns and the effort of each model. */
function stageKept(body: Body): Body {
  const out = without(body, ["tools", "max_turns"]);
  for (const k of ["model", "fast_model"]) {
    const m = out[k];
    if (isPlainObject(m)) out[k] = without(m as Body, ["effort"]);
  }
  return out;
}

/** A source body with every column's and endpoint field's notes taken out; an endpoint's field named by a string is that name. */
function sourceKept(body: Body): Body {
  const field = (c: Json): Json => (typeof c === "string" ? { name: c } : isPlainObject(c) ? without(c as Body, FIELD_NOTES) : c);
  const listOf = (x: Json | undefined, columns: (c: Json) => Json): Json | undefined =>
    Array.isArray(x) ? x.map((t) => (isPlainObject(t) && Array.isArray((t as Body).columns) ? { ...(t as Body), columns: ((t as Body).columns as Json[]).map(columns) } : t)) : x;
  const out: Body = { ...body };
  if (out.tables !== undefined) out.tables = listOf(out.tables, field)!;
  if (out.endpoints !== undefined) out.endpoints = listOf(out.endpoints, field)!;
  return out;
}

/** A loop body as a candidate may not change it: every key but version, and the stage list with each inline stage's id only. */
function loopKept(body: Body): Body {
  const stages = Array.isArray(body.stages) ? body.stages.map((s) => (isPlainObject(s) ? { inline: (s as Body).id ?? null } : s)) : body.stages ?? null;
  return { ...without(body, ["version"]), stages };
}

/** Whether `path` of `root` is a check's script, as the registry reads checks. */
function isCheckScript(registry: Registry, root: string, path: string): boolean {
  const at = resolve(root, ...path.split("/"));
  return registry.all("check").some((m) => sameDir(m.root, root) && typeof m.body.script === "string" && resolve(dirname(m.path), m.body.script) === at);
}

/** Whether the registry's manifest of this kind and id is the file at `path` of `root`. */
function heldHere(registry: Registry, root: string, kind: string, id: string, path: string): boolean {
  const m = registry.get(kind, id);
  return m !== null && sameDir(m.root, root) && rootRelative(m.root, m.path) === path;
}

/** Why one file is not a candidate for `loop`, or null. */
function fileProblem(deps: CandidateDeps, root: string, f: ManifestFile, loop: ResolvedLoop, target: string): string | null {
  const path = f.path;
  const at = resolve(root, ...path.split("/"));
  if (typeof path !== "string" || path === "" || path.startsWith("/") || path.includes("\\") || path.split("/").some((s) => s === "" || s === "." || s === "..") || !at.startsWith(resolve(root) + sep)) {
    return `${path}: a path inside the root, relative and without ..`;
  }
  if (isCheckScript(deps.registry, root, path)) return `${path}: an improve candidate may not change a check's script`;
  let next: { kind: string; body: Body; text: string | null };
  try {
    next = parseManifestFile(path, new TextEncoder().encode(f.text));
  } catch (err) {
    return `${path}: ${err instanceof Error ? err.message : String(err)}`;
  }
  const kind = next.kind;
  if (!CANDIDATE_KINDS.includes(kind)) return `${path}: an improve candidate may not change a ${kind}`;
  const id = typeof next.body.id === "string" ? next.body.id : "";

  // the file is in the root, a manifest of the same kind and id
  let was: { kind: string; body: Body; text: string | null };
  try {
    if (!lstatSync(at).isFile()) return `${path}: ${ADDS_NO_FILE}`;
    was = parseManifestFile(path, new Uint8Array(readFileSync(at)));
  } catch {
    return `${path}: ${ADDS_NO_FILE}`;
  }
  const wasId = typeof was.body.id === "string" ? was.body.id : "";
  if (was.kind !== kind || wasId !== id) return `${path}: the file there is ${was.kind} "${wasId}"; a candidate keeps a file's kind and id`;

  // the file is the target's
  const here = heldHere(deps.registry, root, kind, id, path);
  let part: boolean;
  if (kind === "skill" || kind === "procedure" || kind === "stage") {
    part = here && loop.lock.items.some((i) => i.kind === kind && i.id === id && i.source === "root" && i.path === path);
  } else if (kind === "playbook" || kind === "source") {
    const listed = kind === "playbook" ? loop.manifest.uses.playbooks : loop.manifest.uses.sources;
    part = here && (listed.length === 0 || listed.includes(id));
  } else {
    part = here && id === target;
  }
  if (!part) return `${path} is not part of loop ${target}`;

  // what differs is only what a candidate may change, on the parsed bodies
  switch (kind) {
    case "skill":
    case "procedure":
      return same(was.body, next.body) ? null : `${path}: a candidate changes a ${kind}'s text only`;
    case "playbook":
      return same(without(was.body, ["steps", "end"]), without(next.body, ["steps", "end"])) ? null : `${path}: a candidate changes a playbook's steps and end only`;
    case "source":
      return same(sourceKept(was.body), sourceKept(next.body)) ? null : `${path}: ${SOURCE_ONLY}`;
    case "stage":
      return same(stageKept(was.body), stageKept(next.body)) ? null : `${path}: ${STAGE_ONLY}`;
    default: {
      const version = loop.manifest.version + 1;
      if (next.body.version !== version) return `${path}: a changed loop file is version ${version}`;
      if (!same(loopKept(was.body), loopKept(next.body))) return `${path}: ${LOOP_ONLY}`;
      const before = was.body.stages as Json[];
      const after = next.body.stages as Json[];
      for (const [i, s] of after.entries()) {
        if (isPlainObject(s) && !same(stageKept(before[i] as Body), stageKept(s as Body))) return `${path}: ${STAGE_ONLY}`;
      }
      return null;
    }
  }
}

/** Why these files are not an improve candidate for `target`; [] when they are. Reads the root and the target's lock; writes nothing. */
export function candidateProblems(deps: CandidateDeps, root: string, files: ManifestFile[], target: string): string[] {
  const loop = deps.loops.current(target);
  if (loop === null) return [`loop "${target}" is not usable`];
  const problems: string[] = [];
  for (const f of files) {
    const p = fileProblem(deps, root, f, loop, target);
    if (p !== null) problems.push(p);
  }
  return problems;
}

/** checkChange, then candidateProblems. What the proposer's check and propose_change run. */
export function checkCandidate(deps: CandidateDeps, root: string, files: ManifestFile[], target: string): ChangeCheck {
  const check = checkChange(deps, root, files);
  if (!check.ok) return check;
  const problems = candidateProblems(deps, root, files, target);
  return problems.length === 0 ? check : { ok: false, problems, files: check.files };
}

/** The target loop as these files would leave it, rebuilt from its lock over `into`; the bytes the content store lacks are in `into` and nowhere else. */
export function stageCandidate(deps: CandidateDeps, root: string, files: ManifestFile[], target: string, into: BlobStore): { ok: true; loop: ResolvedLoop } | { ok: false; problems: string[] } {
  // the rules read only the root and the live lock: a file they refuse is never planned, so `into` takes nothing for it
  const rules = candidateProblems(deps, root, files, target);
  if (rules.length > 0) return { ok: false, problems: rules };
  const { check, lock } = planChange(deps, root, files, { into, loop: target });
  if (!check.ok) return { ok: false, problems: check.problems };
  if (lock === null) return { ok: false, problems: [`loop "${target}" is not usable`] };
  const loop = deps.loops.fromLock(lock, into);
  return typeof loop === "string" ? { ok: false, problems: [loop] } : { ok: true, loop };
}
