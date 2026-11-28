// The Propose stage of an improve loop: an agent given the four builder tools proposes at most K changes to the target loop, each one
// builder.proposed of the improve case checked by the candidate rules; then code stages each change once beside the live registry and records it
// as a candidate, staged with its lock or dropped with the reason. The proposer is told each task's question and record, the target's outline
// and the text of each file a candidate may change. It is never told a known answer: no part reads state.answers or a task case.
import { lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { canonical, isPlainObject, parseJson } from "../../core/canonical";
import type { Json } from "../../core/canonical";
import type { CaseSession } from "../../core/session";
import { readTaskInputs, readTaskRecord } from "../../core/state";
import type { BuilderChange, CaseState } from "../../core/state";
import type { Actor, Payloads } from "../../core/types";
import type { PackPart } from "../../agents/context";
import type { BuilderLoop, BuilderTools, ChangeCheck, ManifestFile } from "../../agents/tools";
import { hideCredentials } from "../../agents/tools/builder";
import { scrub } from "../../agents/tools/kit";
import { rootsOf } from "../../modules/config";
import { parseManifestFile } from "../../modules/manifests";
import type { Registry } from "../../modules/registry";
import { rootRelative } from "../components";
import type { EngineDeps, StageRunner } from "../engine";
import { IMPLICIT_NOTE } from "../loops";
import type { LoopCatalog, LoopLock, ResolvedLoop } from "../loops";
import { stageAgent } from "../stages/agent";
import { improveOf } from "./host";

const ENGINE: Actor = { kind: "system", id: "engine" };
const clip = (t: string, n: number): string => (t.length <= n ? t : `${t.slice(0, n - 1)}…`);

const dec = new TextDecoder();
/** Task 9's sentence for a workbench whose host gives no improve loop. */
const NO_HOST = "this workbench cannot run an improve loop here";
/** The kinds of a lock's items a candidate may change by their own file. */
const ITEM_KINDS: readonly string[] = ["skill", "procedure", "stage"];

/**
 * The trusted root a candidate of `loop` is written into, as loop-write's writeRoot names it (src/pipeline may not import loop-write): the
 * trusted root that holds the loop's manifest, else the first trusted root; null when the configuration has none.
 */
function rootOf(deps: Pick<EngineDeps, "config">, loop: ResolvedLoop | null): string | null {
  const trusted = deps.config.roots.filter((r) => r.trusted);
  const at = loop?.manifest.root ?? null;
  const holds = at === null ? undefined : trusted.find((r) => resolve(r.path) === resolve(at));
  return holds?.path ?? trusted[0]?.path ?? null;
}

/** A manifest file of `root`, as the builder's read gives it: scrubbed, every secret value and credential-named value hidden; null when there is none. */
function readManifest(registry: Registry, root: string | null, path: string, secrets: readonly string[]): string | null {
  if (root === null || path === "" || path.startsWith("/") || path.includes("\\") || path.split("/").some((x) => x === "" || x === "." || x === "..")) return null;
  const at = join(root, ...path.split("/"));
  if (!resolve(at).startsWith(resolve(root) + sep)) return null;
  try {
    if (!lstatSync(at).isFile()) return null;
    const bytes = new Uint8Array(readFileSync(at));
    parseManifestFile(at, bytes);
    return scrub(registry, hideCredentials(dec.decode(bytes), secrets));
  } catch {
    return null;
  }
}

/** Every loop, as the builder's loop_catalogue shows it. */
function catalogue(catalog: LoopCatalog | undefined): BuilderLoop[] {
  return (catalog?.list() ?? []).map((x) => {
    const m = x.manifest;
    const stages = x.loop !== null
      ? x.loop.pipeline.stages.map((st) => ({ id: st.id, title: st.title, runs: st.runs, gate: st.gate, on_pass: st.on_pass, on_fail: st.on_fail, loop: st.subloop?.loop ?? null }))
      : (m?.stages ?? []).map((st) => (typeof st === "string"
        ? { id: st, title: st, runs: "", gate: null, on_pass: null, on_fail: null, loop: null }
        : {
          id: String(st.id), title: String(st.title ?? st.id), runs: String(st.runs ?? ""), gate: typeof st.gate === "string" ? st.gate : null,
          on_pass: typeof st.on_pass === "string" ? st.on_pass : null, on_fail: typeof st.on_fail === "string" ? st.on_fail : null, loop: typeof st.loop === "string" ? st.loop : null,
        }));
    return { id: x.id, title: m?.title ?? x.id, about: m?.about ?? "", version: m?.version ?? null, hash: x.loop?.pipeline.hash ?? null, usable: x.loop !== null, problems: x.problems.filter((p) => p !== IMPLICIT_NOTE), stages };
  });
}

/** The proposer's reader and check: `check` is the host's checkCandidate for the target. */
export function proposerTools(session: CaseSession, deps: EngineDeps): BuilderTools {
  const request = session.state.improve.request;
  const target = request?.target ?? "";
  const { config } = deps;
  const registry = deps.runner.registry;
  const root = rootOf(deps, deps.loops?.current(target) ?? null);
  const secrets = deps.runner.secrets?.() ?? [];
  const host = deps.improve;
  return {
    loops: () => catalogue(deps.loops),
    roots: () => rootsOf(config).map((r) => ({
      name: basename(resolve(r.path)), trusted: r.trusted, writable: r.trusted && config.roots.some((c) => c.trusted && resolve(c.path) === resolve(r.path)),
      credentials: [...r.credentials], imported: resolve(r.path).startsWith(resolve(config.loops.imports) + sep),
    })),
    root: root === null ? "" : basename(resolve(root)),
    read: (path) => readManifest(registry, root, path, secrets),
    check: (files: ManifestFile[]): ChangeCheck => {
      if (host === undefined) return { ok: false, problems: [NO_HOST], files: [] };
      if (root === null) return { ok: false, problems: ["the configuration has no trusted root to save into"], files: [] };
      return host.check(root, files, target);
    },
    secrets,
    improve: { target, max: request?.candidates ?? 0 },
  };
}

/** The lock Select recorded for this run, from the improve case's own blob; null when it cannot be read. */
function selectedLock(session: CaseSession, deps: EngineDeps): LoopLock | null {
  const sel = session.state.improve.selected;
  if (sel === null || deps.loops === undefined) return null;
  try {
    return deps.loops.readLock(session.blobs.get(sel.lock.blob));
  } catch {
    return null;
  }
}

/** The target's stages as the proposer is told them: role, tools, model, effort and turns. */
function outlineText(target: string, loop: ResolvedLoop | string): string {
  if (typeof loop === "string") return `The loop ${target}: ${loop}`;
  const lines = [`The loop ${target}, version ${loop.manifest.version} (${loop.pipeline.hash.slice(0, 12)}), its stages in order:`];
  for (const st of loop.pipeline.stages) {
    const model = st.model === null ? "no model" : `model ${st.model.provider}/${st.model.model}, effort ${st.model.effort ?? "none"}`;
    const fast = st.fast_model == null ? "" : `, fast model ${st.fast_model.provider}/${st.fast_model.model}, effort ${st.fast_model.effort ?? "none"}`;
    const tools = st.tools.length === 0 ? "no tools" : `tools [${st.tools.join(", ")}]`;
    lines.push(`- ${st.id} (${st.title}): role ${st.role}, runs ${st.runs}, ${tools}, ${model}${fast}, max_turns ${st.max_turns ?? "default"}`);
  }
  return lines.join("\n");
}

/** The root-relative paths of the files a candidate of the target may change: the lock's skill, procedure and stage files, the playbooks and sources its uses lists, the loop file. */
function changeablePaths(registry: Registry, root: string | null, lock: LoopLock | null, loop: ResolvedLoop | null): string[] {
  if (root === null) return [];
  const out: string[] = [];
  const add = (p: string | null | undefined): void => { if (typeof p === "string" && p !== "" && !out.includes(p)) out.push(p); };
  for (const i of lock?.items ?? []) if (ITEM_KINDS.includes(i.kind) && i.source === "root") add(i.path);
  const uses = loop?.manifest.uses ?? { playbooks: [], sources: [] };
  for (const [kind, ids] of [["playbook", uses.playbooks], ["source", uses.sources]] as const) {
    for (const id of ids) {
      const m = registry.get(kind, id);
      if (m !== null && resolve(m.root) === resolve(root)) add(rootRelative(m.root, m.path));
    }
  }
  add(lock?.manifest.path ?? null);
  return out;
}

/** One task's inputs and record, as the proposer reads them; what Select wrote, never the task's known answer. */
function taskText(session: CaseSession, task: CaseState["improve"]["tasks"][string]): string {
  const read = <T>(blob: string, reader: (b: Uint8Array) => T | null): T | null => {
    try {
      return reader(session.blobs.get(blob));
    } catch {
      return null;
    }
  };
  const inputs = read(task.inputs.blob, readTaskInputs);
  const record = read(task.record.blob, readTaskRecord);
  const lines = [`Task ${task.task}: case ${task.case}, its published product ${task.product.n}.`];
  lines.push(inputs === null ? "Its question could not be read." : `Its question and starting values:\n${JSON.stringify(inputs, null, 2)}`);
  lines.push(record === null ? "Its run's record could not be read." : `What its run did and published:\n${JSON.stringify(record, null, 2)}`);
  return lines.join("\n");
}

/** The parts the proposer is given beside its stage's own: each task's inputs and record, the target's outline, and each file a candidate may change with its path. */
export function improveParts(session: CaseSession, deps: EngineDeps): PackPart[] {
  const { improve } = session.state;
  const sel = improve.selected;
  const registry = deps.runner.registry;
  const secrets = deps.runner.secrets?.() ?? [];
  const clean = (t: string): string => scrub(registry, hideCredentials(t, secrets));
  const parts: PackPart[] = [];
  for (const id of improve.task_order) {
    const t = improve.tasks[id];
    if (t === undefined) continue;
    parts.push({ kind: "task", id: t.task, title: `Task ${t.task}`, text: taskText(session, t), marking: t.marking, fixed: false });
  }
  if (sel === null) return parts.map((p) => ({ ...p, title: clean(p.title), text: clean(p.text) }));
  const at = deps.loops === undefined ? "there is no loop catalogue here" : deps.loops.atHash(sel.target, sel.loop_hash);
  const loop = typeof at === "string" ? null : at;
  parts.push({ kind: "loop", id: sel.target, title: `The loop ${sel.target}`, text: outlineText(sel.target, at), marking: null, fixed: true });
  const root = rootOf(deps, loop);
  for (const path of changeablePaths(registry, root, selectedLock(session, deps), loop)) {
    const text = readManifest(registry, root, path, secrets);
    if (text === null) continue;
    parts.push({ kind: "manifest", id: path, title: path, text, marking: null, fixed: false });
  }
  return parts.map((p) => ({ ...p, title: clean(p.title), text: clean(p.text) }));
}

/** The changes proposed in this run of the improve case (after its selection), oldest first. */
function changesOfRun(state: Readonly<CaseState>): BuilderChange[] {
  const after = state.improve.selected?.seq ?? 0;
  return Object.values(state.builder.changes).filter((c) => c.seq > after).sort((a, b) => a.seq - b.seq);
}

/** The files of a change, from its bundle; null when the bundle cannot be read. */
function bundleFiles(session: CaseSession, change: BuilderChange): ManifestFile[] | null {
  try {
    const parsed = parseJson(session.blobs.text(change.bundle.blob));
    const files = parsed === null || !isPlainObject(parsed.value) ? null : (parsed.value as { files?: unknown }).files;
    if (!Array.isArray(files) || files.length === 0) return null;
    const out: ManifestFile[] = [];
    for (const f of files) {
      if (!isPlainObject(f) || typeof f.path !== "string" || typeof f.text !== "string") return null;
      out.push({ path: f.path, text: f.text });
    }
    return out;
  } catch {
    return null;
  }
}

/** The trusted root a change names by its folder name, now; null when there is none. */
function namedRoot(deps: Pick<EngineDeps, "config">, name: string): string | null {
  return deps.config.roots.find((r) => r.trusted && basename(resolve(r.path)) === name)?.path ?? null;
}

const SAME_AS_BASE = "it changes nothing the loop reads";
const REASON_CHARS = 300;

/** One change staged through the host: its candidate's payload but the id. Throws what the host throws (a stop of the process). */
function stageOne(session: CaseSession, deps: EngineDeps, host: NonNullable<EngineDeps["improve"]>, change: BuilderChange, sel: NonNullable<CaseState["improve"]["selected"]>): Omit<Payloads["improve.candidate"], "candidate"> {
  const registry = deps.runner.registry;
  const secrets = deps.runner.secrets?.() ?? [];
  const dropped = (reason: string) => ({ change: change.id, status: "dropped" as const, loop_hash: null, lock: null, reason: clip(scrub(registry, hideCredentials(reason, secrets)), REASON_CHARS) });
  const files = bundleFiles(session, change);
  if (files === null) return dropped("its files could not be read from the case");
  const root = namedRoot(deps, change.root);
  if (root === null) return dropped(`the root ${change.root} is not a trusted root here`);
  const r = host.stage(improveOf(session), root, files, sel.target);
  if (!r.ok) return dropped(r.problems[0] ?? `loop "${sel.target}" is not usable`);
  if (r.loop.pipeline.hash === sel.loop_hash) return dropped(SAME_AS_BASE);
  const lock = session.blobs.put(canonical(r.loop.lock as unknown as Json));
  return { change: change.id, status: "staged", loop_hash: r.loop.pipeline.hash, lock, reason: "" };
}

export const proposeRunner: StageRunner = async (env) => {
  const { session, deps, stage } = env;
  const host = deps.improve;
  if (host === undefined) return { kind: "stalled", reason: NO_HOST };
  const request = session.state.improve.request;
  const sel = session.state.improve.selected;
  if (request === null || sel === null || sel.run !== session.state.run.id) return { kind: "stalled", reason: "Propose runs after Select: this run has selected no tasks" };
  if (deps.loops?.current(sel.target)?.pipeline.hash !== sel.loop_hash) {
    return { kind: "stalled", reason: `loop ${sel.target} changed since the tasks were selected; stop this run and start another` };
  }
  if (changesOfRun(session.state).length === 0) {
    const task = `Propose at most ${request.candidates} changes to loop ${sel.target} that would make ${sel.case_type} cases more correct. Each is one call of propose_change. Change only what the parts titled by a path hold. Then answer with what you proposed.`;
    const end = await stageAgent(env, {
      actor_id: deps.profile.stages[stage.id]?.agent ?? "proposer", task, extras: improveParts(session, deps), builder: proposerTools(session, deps),
    });
    if (end.kind !== "output") return end;
  }
  // with or without a model call (a restart after the agent ended): each change of this run with no candidate yet, oldest first, one commit each
  for (;;) {
    const known = new Set(Object.values(session.state.improve.candidates).map((c) => c.change));
    const next = changesOfRun(session.state).find((c) => !known.has(c.id));
    if (next === undefined) break;
    const payload = stageOne(session, deps, host, next, sel);
    session.commit((st) => {
      if (Object.values(st.improve.candidates).some((c) => c.change === next.id)) return [];
      return [{ type: "improve.candidate", actor: ENGINE, run: st.run.id, stage: stage.id, payload: { candidate: `K${st.improve.candidate_order.length + 1}`, ...payload } }];
    });
    if (!Object.values(session.state.improve.candidates).some((c) => c.change === next.id)) {
      return { kind: "stalled", reason: `the candidate of ${next.id} was not recorded` };
    }
  }
  const { candidates, candidate_order } = session.state.improve;
  const output = { candidates: candidate_order.map((k) => ({ candidate: k, change: candidates[k]!.change, status: candidates[k]!.status })) };
  return { kind: "finished", outcome: "pass", draft_hash: null, output, reason: null };
};
