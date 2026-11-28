// The loop builder on the server (slice 12, part B): a conversation in a builder session, the person's decision on each file the builder
// proposed, and the person's decision on each probe it asked for. The builder agent never decides: builder.decided and builder.probe_decided
// are written here only, by the person the server names. A file is written only by saveManifests, as that person, after the save's own check of
// the root as it is now. A probe runs only through runQuery, the one custody point, in the builder session and in the person's name.
// No secret value reaches the ledger or the model: what the person types, what the model writes and what a probe's source answers (its entries
// and blobs) are searched for every secret value the workbench holds before anything is written, and each one found is redacted; every part of
// the pack and every tool view is scrubbed.
import { basename, join, resolve, sep } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { isPlainObject } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import { builderMarking, cardRefs } from "../core/state";
import type { BuilderChange, BuilderProbe, CaseState } from "../core/state";
import type { Actor, EntryInput, ModelChoice } from "../core/types";
import type { Workbench } from "../core/workbench";
import type { BuilderFileView, BuilderView, DiffLine } from "../core/wire";
import { ContextError, casePart, loadProfile, packPart, stageParts } from "../agents/context";
import type { PackPart } from "../agents/context";
import { runAgent } from "../agents/loop";
import type { AgentEnd } from "../agents/loop";
import { assemblePack, packBudget } from "../agents/pack";
import { DEFAULT_CONTEXT } from "../agents/providers/local";
import type { Provider, TurnResult } from "../agents/providers/types";
import { BUILDER_TOOL_NAMES } from "../agents/tools";
import type { BuilderTools, ToolContext } from "../agents/tools";
import { hideCredentials } from "../agents/tools/builder";
import { scrub } from "../agents/tools/kit";
import { rootsOf } from "../modules/config";
import { coveredLock, uncovered } from "../modules/loop-stage";
import { checkChange, saveManifests, writeRoot } from "../modules/loop-write";
import type { ManifestFile, SaveDeps } from "../modules/loop-write";
import { parseManifestFile, pivotWeight } from "../modules/manifests";
import { bindPivot, PivotError } from "../modules/pivots";
import { runQuery } from "../modules/runner";
import type { RunQueryResult } from "../modules/runner";
import { REDACTED, redactSecrets, searched } from "../core/redact";
import { DEFAULT_LIMITS } from "../modules/seeker";
import type { EngineDeps } from "../pipeline/engine";
import { IMPLICIT_NOTE } from "../pipeline/loops";
import type { CaseHub } from "./hub";
import { modelsFor, shown } from "./views";

/** A builder act the server will not carry out: nothing was written. */
export class BuilderRefused extends Refused {
  constructor(message: string, reasons?: string[]) {
    super(message, reasons);
    this.name = "BuilderRefused";
  }
}

export interface BuilderContext {
  session: CaseSession; deps: EngineDeps; hub: CaseHub; actor: Extract<Actor, { kind: "human" }>; reload(): string[];
  /** The workbench: its chain records manifest.written, and its chain's blobs are the content store a save's check reads. */
  wb: Workbench;
  /** The value of every secret the workbench holds (compose's secrets). */
  secrets(): readonly string[];
}

/** The stage of the builder's profile, and the profile. */
export const BUILDER_STAGE = "builder";
export const BUILDER_PROFILE = "loop-builder";
export const STALE = "this file changed since it was proposed; ask the builder to propose again";
const NO_MODEL = "The builder has no model. Choose one for this session.";
const QUESTION_MAX = 4000;
const DIFF_MAX = 2000;
const ANSWER_MAX = 60_000;
const TITLE_CHARS = 60;
const MARKS = ["[hidden]", REDACTED];
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

// ---------- redaction ----------

export { REDACTED, redactSecrets };

/** JSON text with every string in it redacted (so a value written with \u escapes is found too); text that is not JSON is redacted as text. */
function redactJsonText(text: string, secrets: readonly string[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return redactSecrets(text, secrets);
  }
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactSecrets(v, secrets);
      if (r !== v) changed = true;
      return r;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, w]) => [redactSecrets(k, secrets), walk(w)]));
    return v;
  };
  const walked = walk(parsed);
  return changed ? JSON.stringify(walked) : redactSecrets(text, secrets);
}

const enc = new TextEncoder();
const dec = new TextDecoder();
function redactBytes(raw: Uint8Array, secrets: readonly string[]): Uint8Array {
  const text = dec.decode(raw);
  const out = redactJsonText(text, secrets);
  return out === text ? raw : enc.encode(out);
}

/** Every string of a JSON value (keys too) with each secret value redacted; the same value when none was found. */
function redactJson<T>(value: T, secrets: readonly string[]): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redactSecrets(v, secrets);
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, w]) => [redactSecrets(k, secrets), walk(w)]));
    return v;
  };
  return walk(value) as T;
}

/**
 * The builder session as a probe's runQuery writes to it: every entry's payload and every blob put is searched for each secret value the workbench
 * holds, and each one found is redacted before it is committed or stored. The runner is unchanged; what it records here holds no secret value.
 */
function redactingSession(session: CaseSession, secrets: readonly string[]): CaseSession {
  const blobs = new Proxy(session.blobs, {
    get(target, key) {
      if (key === "put") return (bytes: Uint8Array | string, media?: string) => target.put(redactBytes(typeof bytes === "string" ? enc.encode(bytes) : bytes, secrets), media);
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return new Proxy(session, {
    get(target, key) {
      if (key === "blobs") return blobs;
      if (key === "commit") {
        return (fn: Parameters<CaseSession["commit"]>[0]) => target.commit((state, ids) => fn(state, ids).map((e) => ({ ...e, payload: redactJson(e.payload, secrets) }) as typeof e));
      }
      const v: unknown = Reflect.get(target, key, target);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** A model's turn with every secret value it wrote redacted: its text, its reasoning, each tool call's arguments and the raw reply, before the agent loop records any of them. */
export function redactTurn(result: TurnResult, secrets: readonly string[]): TurnResult {
  if (searched(secrets).length === 0) return result;
  switch (result.kind) {
    case "answer":
      return {
        ...result, content: redactSecrets(result.content, secrets), reasoning: result.reasoning === null ? null : redactSecrets(result.reasoning, secrets),
        tool_calls: result.tool_calls.map((c) => ({ id: c.id, name: redactSecrets(c.name, secrets), arguments: redactJsonText(c.arguments, secrets) })),
        served_by: redactSecrets(result.served_by, secrets), raw: redactBytes(result.raw, secrets),
      };
    case "declined":
      return { ...result, reason: redactSecrets(result.reason, secrets), raw: redactBytes(result.raw, secrets) };
    case "error":
      return {
        ...result, message: redactSecrets(result.message, secrets), raw: result.raw === null ? null : redactBytes(result.raw, secrets),
        ...(result.reasoning === undefined ? {} : { reasoning: redactSecrets(result.reasoning, secrets) }),
      };
  }
}

/** The provider, with each turn's reply redacted before the agent loop sees it. */
function redacting(p: Provider, secrets: readonly string[]): Provider {
  return {
    id: p.id, kind: p.kind, where: p.where,
    ...(p.max_output_tokens === undefined ? {} : { max_output_tokens: p.max_output_tokens }),
    ...(p.sampling === undefined ? {} : { sampling: p.sampling }),
    ...(p.structured_output === undefined ? {} : { structured_output: p.structured_output }),
    models: () => p.models(),
    body: (req) => p.body(req),
    turn: async (req) => redactTurn(await p.turn(req), secrets),
  };
}

// ---------- the diff ----------

const linesOf = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** A line diff of two texts (longest common subsequence over lines; at most 2000 lines a side, else every old line removed and every new line added). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length > DIFF_MAX || b.length > DIFF_MAX) return [...a.map((text): DiffLine => ({ op: "-", text })), ...b.map((text): DiffLine => ({ op: "+", text }))];
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..]
  const lcs: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: " ", text: a[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "-", text: a[i++]! });
    else out.push({ op: "+", text: b[j++]! });
  }
  while (i < a.length) out.push({ op: "-", text: a[i++]! });
  while (j < b.length) out.push({ op: "+", text: b[j++]! });
  return out;
}

// ---------- the root and the files on disk ----------

/** The trusted root a change names by its folder name, now. */
function rootPathOf(deps: EngineDeps, name: string): string | null {
  return deps.config.roots.find((r) => r.trusted && basename(resolve(r.path)) === name)?.path ?? null;
}

/** A file under a root, as it is now: its text and hash, or null when there is none. */
function onDisk(root: string, path: string): { text: string; hash: string } | null {
  if (path.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  const at = join(root, ...path.split("/"));
  if (!resolve(at).startsWith(resolve(root) + sep)) return null;
  try {
    if (!lstatSync(at).isFile()) return { text: "", hash: "" };
    const bytes = new Uint8Array(readFileSync(at));
    return { text: dec.decode(bytes), hash: sha256Hex(bytes) };
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return null;
    throw err;
  }
}

/** The proposed texts of a change by path, from its bundle; empty when the bundle cannot be read. */
function bundleOf(session: CaseSession, change: BuilderChange): Map<string, string> {
  try {
    const parsed = JSON.parse(dec.decode(session.blobs.get(change.bundle.blob))) as { files?: { path?: unknown; text?: unknown }[] };
    const out = new Map<string, string>();
    for (const f of parsed.files ?? []) if (typeof f.path === "string" && typeof f.text === "string") out.set(f.path, f.text);
    return out;
  } catch {
    return new Map();
  }
}

const saveDepsOf = (ctx: Pick<BuilderContext, "deps" | "wb">, secrets: readonly string[]): SaveDeps => ({ config: ctx.deps.config, chain: ctx.wb.chain, content: ctx.wb.chainBlobs, secrets });

// ---------- the view ----------

/** The model the builder uses: the session's pick for stage builder, else the model of the default loop's Assemble stage. */
export function builderChoice(session: CaseSession, deps: EngineDeps): ModelChoice | null {
  const { state } = session;
  if (Object.hasOwn(state.stage_models, BUILDER_STAGE)) return state.stage_models[BUILDER_STAGE]!;
  const pipeline = deps.loops?.current(deps.config.loops.default)?.pipeline ?? deps.pipeline;
  return pipeline.stages.find((s) => s.role === "assemble")?.model ?? null;
}

function costlyOf(deps: EngineDeps, p: BuilderProbe): boolean {
  const { registry } = deps.runner;
  const source = registry.source(p.source);
  if (source === null) return false;
  const pivot = p.pivot === null ? null : registry.pivot(p.pivot);
  return (pivot !== null && pivot.source === source.id ? pivotWeight(pivot, source) : source.cost.weight) > 0;
}

export async function builderView(session: CaseSession, deps: EngineDeps, opts: { secrets?: readonly string[] } = {}): Promise<BuilderView> {
  const { state } = session;
  const secrets = opts.secrets ?? [];
  // text the person may see: no secret value, and the registry's scrub for what came from the model
  const plain = (t: string): string => redactSecrets(t, secrets);
  const said = (t: string): string => shown(deps, redactSecrets(t, secrets));
  const changes = Object.values(state.builder.changes).sort((a, b) => a.seq - b.seq).map((c) => {
    const texts = bundleOf(session, c);
    const root = rootPathOf(deps, c.root);
    const files = c.files.map((f, index): BuilderFileView => {
      const after = texts.get(f.path) ?? "";
      const now = root === null ? null : onDisk(root, f.path);
      let before: string;
      let stale = false;
      if (f.decided === null) {
        stale = (now?.hash ?? null) !== f.before;
        before = now?.text ?? "";
      } else if (f.decided.accepted) {
        // what it was before it was written: the content store holds every manifest the registry loaded
        before = f.before === null ? "" : deps.content?.has(f.before) === true ? dec.decode(deps.content.get(f.before)) : "";
      } else {
        before = now?.text ?? "";
      }
      return {
        index, path: f.path, kind: f.kind, id: f.id, new_file: f.before === null, lines: lineDiff(plain(before), plain(after)).map((l) => ({ op: l.op, text: l.text })),
        decided: f.decided === null ? null : { accepted: f.decided.accepted }, stale,
      };
    });
    return { id: c.id, title: said(c.title), why: said(c.why), files };
  });
  const cardOf = (query: string | null): string | null => (query === null ? null : Object.values(state.cards).find((c) => c.query === query)?.id ?? null);
  const probes = Object.values(state.builder.probes).sort((a, b) => a.seq - b.seq).map((p) => ({
    id: p.id, kind: p.kind, source: p.source, pivot: p.pivot, value: p.value === null ? null : { type: p.value.type, value: p.value.value },
    text: p.text === null ? null : plain(p.text), why: said(p.why), costly: costlyOf(deps, p),
    decided: p.decided === null ? null : { approved: p.decided.approved, outcome: p.decided.outcome, detail: said(p.decided.detail), card: cardOf(p.decided.query) },
  }));
  return { id: state.meta?.id ?? "", loop: state.loop.id, marking: builderMarking(state), model: builderChoice(session, deps), changes, probes };
}

// ---------- the builder's tools on the server ----------

/** What the builder's tools read and check through, made as the server makes it for one turn. */
export function builderTools(ctx: Pick<BuilderContext, "session" | "deps" | "wb">, secrets: readonly string[]): BuilderTools {
  const { deps, session } = ctx;
  const { config } = deps;
  const registry = deps.runner.registry;
  const loopId = session.state.loop.id;
  const catalog = deps.loops;
  const man = loopId === null ? null : catalog?.list().find((x) => x.id === loopId)?.manifest ?? null;
  const root = writeRoot(config, man);
  return {
    loops: () => (catalog?.list() ?? []).map((x) => {
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
    }),
    roots: () => rootsOf(config).map((r) => ({
      name: basename(resolve(r.path)), trusted: r.trusted, writable: r.trusted && config.roots.some((c) => c.trusted && resolve(c.path) === resolve(r.path)),
      credentials: [...r.credentials], imported: resolve(r.path).startsWith(resolve(config.loops.imports) + sep),
    })),
    root: basename(resolve(root)),
    read: (path) => {
      if (path === "" || path.startsWith("/") || path.includes("\\") || path.split("/").some((x) => x === "" || x === "." || x === "..")) return null;
      const at = join(root, ...path.split("/"));
      try {
        if (!lstatSync(at).isFile()) return null;
        const bytes = new Uint8Array(readFileSync(at));
        parseManifestFile(at, bytes);
        return scrub(registry, hideCredentials(dec.decode(bytes), secrets));
      } catch {
        return null;
      }
    },
    check: (files: ManifestFile[]) => checkChange(saveDepsOf(ctx, secrets), root, files),
    secrets,
  };
}

// ---------- ask ----------

interface Resolved { choice: ModelChoice; provider: Provider; context: number }
async function resolveModel(session: CaseSession, deps: EngineDeps): Promise<Resolved | null> {
  const choice = builderChoice(session, deps);
  if (choice === null) return null;
  const provider = deps.providers.get(choice.provider);
  if (provider === null) return null;
  const listed = (await modelsFor(deps, builderMarking(session.state))).find((m) => m.provider === choice.provider && m.model === choice.model);
  if (listed === undefined) return null;
  return { choice, provider, context: listed.context ?? DEFAULT_CONTEXT };
}

/** The loop the session is about, as a part: its manifest's text, scrubbed. None for a session about no loop. */
function loopPart(session: CaseSession, deps: EngineDeps): PackPart | null {
  const id = session.state.loop.id;
  if (id === null) return null;
  const x = deps.loops?.list().find((l) => l.id === id);
  const m = x?.manifest ?? null;
  let text: string;
  if (m === null) text = `There is no loop "${id}" in the roots now.`;
  else if (m.implicit || m.root === null || m.path === null) text = `The loop "${id}" is implicit: every stage manifest of the root, in order (${(x?.loop?.pipeline.stages ?? []).map((s) => s.id).join(", ")}). Saving any loop writes it as loops/${id}.yaml.`;
  else {
    let body = "";
    try { body = readFileSync(join(m.root, ...m.path.split("/")), "utf8"); } catch { body = "(the file could not be read)"; }
    text = `The loop "${id}", version ${m.version}, from ${m.path} in the root ${basename(resolve(m.root))}${x?.loop === null ? ` (not usable: ${x.problems.filter((p) => p !== IMPLICIT_NOTE).join("; ")})` : ""}:\n${body}`;
  }
  return { kind: "loop", id, title: `The loop ${id}`, text, marking: null, fixed: false };
}

/** The changes and probes of the session and what the person decided, as one part; none when there are none. */
function decisionsPart(session: CaseSession): PackPart | null {
  const { builder, cards } = session.state;
  const changes = Object.values(builder.changes).sort((a, b) => a.seq - b.seq);
  const probes = Object.values(builder.probes).sort((a, b) => a.seq - b.seq);
  if (changes.length === 0 && probes.length === 0) return null;
  const lines: string[] = [];
  if (changes.length > 0) lines.push("Changes proposed in this session, and the person's decision on each file:");
  for (const c of changes) {
    lines.push(`- ${c.id} "${c.title}":`);
    for (const f of c.files) lines.push(`  - ${f.path} (${f.kind} ${f.id}): ${f.decided === null ? "waiting for the person" : f.decided.accepted ? "accepted and written" : "rejected"}`);
  }
  if (probes.length > 0) lines.push("Probes asked for in this session:");
  for (const p of probes) {
    const what = p.kind === "pivot" ? `pivot ${p.pivot} on ${p.value?.type} ${p.value?.value}` : `query on ${p.source}: ${p.text}`;
    const card = p.decided?.query == null ? null : Object.values(cards).find((c) => c.query === p.decided!.query)?.id ?? null;
    const end = p.decided === null ? "waiting for the person" : !p.decided.approved ? "rejected by the person"
      : p.decided.outcome === "ran" ? `ran${card === null ? "" : `; its answer is card ${card}`}${p.decided.detail === "" ? "" : ` (${p.decided.detail})`}` : `refused: ${p.decided.detail}`;
    lines.push(`- ${p.id} ${what}: ${end}`);
  }
  return { kind: "builder", id: "decisions", title: "Changes and probes", text: lines.join("\n"), marking: null, fixed: false };
}

/** The parts the builder is given, in priority order, every text scrubbed and every secret value hidden. */
export function builderParts(session: CaseSession, deps: EngineDeps, secrets: readonly string[]): PackPart[] {
  const { state } = session;
  const registry = deps.runner.registry;
  try {
    const profile = loadProfile(registry, BUILDER_PROFILE);
    const parts: PackPart[] = [...stageParts(registry, profile, BUILDER_STAGE, { schema: null, objective: null }), casePart(state)];
    const loop = loopPart(session, deps);
    if (loop !== null) parts.push(loop);
    const decisions = decisionsPart(session);
    if (decisions !== null) parts.push(decisions);
    for (const card of Object.values(state.cards).sort((a, b) => b.created_seq - a.created_seq)) parts.push(packPart({ card, registry }));
    const entries = session.entries();
    for (const t of [...state.conversation].reverse()) {
      if (t.answer === null) continue;
      const wrote = entries.find((e) => e.type === "model.request" && e.payload.request === t.request);
      if (wrote === undefined) continue;
      parts.push(packPart({ kind: "turn", id: t.turn, title: `Earlier: ${clip(t.asked, TITLE_CHARS)}`, text: `Asked: ${t.asked}\nAnswered: ${t.answer}`, fixed: false, entries, written_by: [wrote], floor: null }));
    }
    const clean = (t: string): string => scrub(registry, hideCredentials(t, secrets));
    return parts.map((p) => ({ ...p, title: clean(p.title), text: clean(p.text) }));
  } catch (err) {
    if (err instanceof ContextError) throw new BuilderRefused(err.message);
    throw err;
  }
}

/** One turn after another per session: two answers are never being written at once. It is not the session's command line, which a slow model must not hold. */
const lines = new WeakMap<CaseHub, Map<string, Promise<unknown>>>();
function inTurn(hub: CaseHub, id: string, work: () => Promise<void>): Promise<void> {
  const mine = lines.get(hub) ?? new Map<string, Promise<unknown>>();
  lines.set(hub, mine);
  const after = mine.get(id) ?? Promise.resolve();
  const run = after.then(work, work);
  const tail = run.then(() => undefined, () => undefined);
  mine.set(id, tail);
  void tail.then(() => { if (mine.get(id) === tail) mine.delete(id); });
  return run;
}

const END_REASON: Record<Exclude<AgentEnd["kind"], "done">, string> = { blocked: "blocked", declined: "declined", error: "the model call failed", stopped: "stopped", invalid: "the answer was not valid" };

/** Writes agent.asked, with every secret value in the question redacted, and returns; the builder's turn goes on in the background, as converse's ask. */
export async function builderAsk(ctx: BuilderContext, text: string): Promise<void> {
  const { session, hub } = ctx;
  const deps = { ...ctx.deps };
  const secrets = ctx.secrets();
  // the person's words are searched for every secret value before anything is written, the length checked after
  const asked = redactSecrets(typeof text === "string" ? text.trim() : "", secrets);
  if (asked.length < 1 || asked.length > QUESTION_MAX) throw new BuilderRefused("a question must be 1 to 4,000 characters");
  const who = await resolveModel(session, deps);
  if (who === null) throw new BuilderRefused(NO_MODEL);
  const limit = Object.hasOwn(session.state.pack_limits, BUILDER_STAGE) ? session.state.pack_limits[BUILDER_STAGE]! : null;
  const first = assemblePack(builderParts(session, deps, secrets), { budget: packBudget(who.context), case_marking: builderMarking(session.state), max_marking: limit });
  if ("too_big" in first) throw new BuilderRefused("The fixed context does not fit this model.");
  let turn = "";
  const [entry] = session.commit((_s, ids) => {
    turn = ids.next("turn");
    return [{ type: "agent.asked", actor: ctx.actor, payload: { turn, text: asked, left_out: [], added: [] } }];
  });
  const seq = entry!.seq;
  const id = session.state.meta!.id;
  hub.background(inTurn(hub, id, async () => {
    try {
      await answer(ctx, deps, secrets, who, { turn, seq, text: asked });
    } catch (err) {
      try {
        const reason = clip(redactSecrets(shown(deps, (err instanceof Error ? err.message : String(err)).split("\n")[0]!), secrets), 300);
        session.commit(() => [{ type: "agent.ended", actor: { kind: "system", id: "builder" }, cause: seq, payload: { asked: seq, reason } }]);
      } catch { /* the ledger refused even that */ }
      throw err;
    }
  }));
}

async function answer(ctx: BuilderContext, deps: EngineDeps, secrets: readonly string[], who: Resolved, q: { turn: string; seq: number; text: string }): Promise<void> {
  const { session } = ctx;
  const state = session.state;
  const limit = Object.hasOwn(state.pack_limits, BUILDER_STAGE) ? state.pack_limits[BUILDER_STAGE]! : null;
  const pack = assemblePack(builderParts(session, deps, secrets), { budget: packBudget(who.context), case_marking: builderMarking(state), max_marking: limit });
  if ("too_big" in pack) throw new Error("the fixed context no longer fits the model");
  const profile = loadProfile(deps.runner.registry, BUILDER_PROFILE);
  const actor: Extract<Actor, { kind: "agent" }> = {
    kind: "agent", id: profile.stages[BUILDER_STAGE]?.agent ?? "builder", stage: BUILDER_STAGE, profile: profile.id, model: who.choice.model, effort: who.choice.effort, where: who.provider.where,
  };
  const window = state.meta === null ? { from: null, to: null } : { from: state.meta.window.from, to: state.meta.window.to };
  const tctx: ToolContext = {
    session, deps: deps.runner, seeker: deps.seeker, actor, link: { run: null, stage: null, job: null }, draft: null, draft_hash: null, subgoal: null, window,
    limits: { ...DEFAULT_LIMITS }, builder: builderTools({ session, deps, wb: ctx.wb }, secrets),
  };
  const end = await runAgent(session, {
    actor, provider: redacting(who.provider, secrets), model: who.choice.model, effort: who.choice.effort, pack, task: q.text, tools: BUILDER_TOOL_NAMES, schema: null,
    outside_run: true, cause: q.seq, policy: deps.config.marking_policy, max_marking: limit, ctx: tctx,
  });
  if (end.kind !== "done") {
    session.commit(() => [{ type: "agent.ended", actor: { kind: "system", id: "builder" }, cause: q.seq, payload: { asked: q.seq, reason: END_REASON[end.kind] } }]);
    return;
  }
  const request = session.entries().findLast((e) => e.type === "model.request" && e.cause === q.seq);
  if (request === undefined || request.type !== "model.request") throw new Error("the answer has no request");
  const text = clip(redactSecrets(end.content.trim() === "" ? "The model returned no text." : end.content, secrets), ANSWER_MAX);
  const cites = [...new Set(cardRefs(text))].filter((c) => Object.hasOwn(session.state.cards, c));
  session.commit(() => [{ type: "agent.answered", actor, payload: { turn: q.turn, request: request.payload.request, text, cites } }]);
}

// ---------- decide ----------

function changeFile(session: CaseSession, change: string, file: number): { c: BuilderChange; f: BuilderChange["files"][number] } {
  const changes = session.state.builder.changes;
  if (typeof change !== "string" || !Object.hasOwn(changes, change)) throw new BuilderRefused(`there is no change ${JSON.stringify(String(change).slice(0, 40))} in this session`);
  const c = changes[change]!;
  if (!Number.isInteger(file) || file < 0 || file >= c.files.length) throw new BuilderRefused(`change ${change} has no file ${String(file).slice(0, 20)}`);
  const f = c.files[file]!;
  if (f.decided !== null) throw new BuilderRefused(`${f.path} of change ${change} is decided already`);
  return { c, f };
}

/**
 * The person's decision on one file of a proposed change. An accept is written by saveManifests as the person, after the save's check of the
 * root as it is now with that one file laid over it; a file that changed on disk since it was proposed is stale and is not written.
 */
export function builderDecide(ctx: BuilderContext, change: string, file: number, accept: boolean): void {
  const { session } = ctx;
  const { c, f } = changeFile(session, change, file);
  const payload = { change, file };
  if (!accept) {
    session.commit(() => [{ type: "builder.decided", actor: ctx.actor, payload: { ...payload, accepted: false, written: null } }]);
    return;
  }
  const deps = { ...ctx.deps };
  const root = rootPathOf(deps, c.root);
  if (root === null) throw new BuilderRefused(`the root ${c.root} is not a trusted root of the configuration now`);
  const now = onDisk(root, f.path);
  if ((now?.hash ?? null) !== f.before) throw new BuilderRefused(STALE);
  const text = bundleOf(session, c).get(f.path);
  if (text === undefined || sha256Hex(enc.encode(text)) !== f.after) throw new BuilderRefused("the proposed text of this file is not in this session");
  if (MARKS.some((m) => text.includes(m))) throw new BuilderRefused("this file holds the mark of text kept from the builder; ask it to propose the file again");
  const id = session.state.meta!.id;
  const check = saveManifests(saveDepsOf({ deps, wb: ctx.wb }, ctx.secrets()), root, [{ path: f.path, text }], { actor: ctx.actor, why: "builder", session: id });
  if (!check.ok) {
    const reasons = check.problems.map((p) => shown(deps, p));
    throw new BuilderRefused(reasons[0] ?? "the save's check refused it", reasons);
  }
  const written = check.files.find((x) => x.path === f.path)!.hash;
  session.commit(() => [{ type: "builder.decided", actor: ctx.actor, payload: { ...payload, accepted: true, written } }]);
  ctx.reload();
}

/**
 * The person's decision on a whole change at once (slice 14: an improve case's chosen candidate is adopted all or nothing). An accept needs every
 * file undecided and none stale (`opts.stale` is said for one that is); with `opts.expect` the root as it is now, with every file laid over it, must
 * give loop `expect.loop` the hash `expect.hash` (else `expect.refusal`), so only the version that was probed is written. It then writes every file
 * in one saveManifests as the person (why builder) and reloads. A rejection decides every file still undecided. Each builder.decided and what
 * `opts.with` adds are one commit; nothing is written when anything is refused.
 */
export function builderDecideAll(
  ctx: BuilderContext, change: string, accept: boolean,
  opts: { stale?: string; expect?: { loop: string; hash: string; refusal: string }; with?: (state: Readonly<CaseState>) => EntryInput[] } = {},
): void {
  const { session } = ctx;
  const changes = session.state.builder.changes;
  if (typeof change !== "string" || !Object.hasOwn(changes, change)) throw new BuilderRefused(`there is no change ${JSON.stringify(String(change).slice(0, 40))} in this session`);
  const c = changes[change]!;
  if (accept) {
    const decided = c.files.find((f) => f.decided !== null);
    if (decided !== undefined) throw new BuilderRefused(`${decided.path} of change ${change} is decided already`);
  }
  const undecided = c.files.map((f, file) => ({ f, file })).filter(({ f }) => f.decided === null);
  let written = new Map<string, string>();
  if (accept) {
    const deps = { ...ctx.deps };
    const root = rootPathOf(deps, c.root);
    if (root === null) throw new BuilderRefused(`the root ${c.root} is not a trusted root of the configuration now`);
    const texts = bundleOf(session, c);
    const laid: ManifestFile[] = [];
    for (const { f } of undecided) {
      const now = onDisk(root, f.path);
      if ((now?.hash ?? null) !== f.before) throw new BuilderRefused(opts.stale ?? STALE);
      const text = texts.get(f.path);
      if (text === undefined || sha256Hex(enc.encode(text)) !== f.after) throw new BuilderRefused("the proposed text of this file is not in this session");
      if (MARKS.some((m) => text.includes(m))) throw new BuilderRefused("this file holds the mark of text kept from the builder; ask it to propose the file again");
      laid.push({ path: f.path, text });
    }
    const saveDeps = saveDepsOf({ deps, wb: ctx.wb }, ctx.secrets());
    const refuse = (problems: string[]): never => {
      const reasons = problems.map((p) => shown(deps, p));
      throw new BuilderRefused(reasons[0] ?? "the save's check refused it", reasons);
    };
    if (opts.expect !== undefined) {
      // the version these files make, sources and playbooks included, must be the one probed, and it must name every file written
      const planned = coveredLock(saveDeps, root, laid, opts.expect.loop);
      if (!planned.check.ok) refuse(planned.check.problems);
      if (planned.lock === null || planned.lock.hash !== opts.expect.hash || uncovered(planned.lock, laid).length > 0) throw new BuilderRefused(opts.expect.refusal);
    }
    const check = saveManifests(saveDeps, root, laid, { actor: ctx.actor, why: "builder", session: session.state.meta!.id });
    if (!check.ok) refuse(check.problems);
    written = new Map(check.files.map((x) => [x.path, x.hash]));
  }
  session.commit((state) => [
    ...undecided.map(({ f, file }): EntryInput => ({ type: "builder.decided", actor: ctx.actor, payload: { change, file, accepted: accept, written: accept ? written.get(f.path) ?? null : null } })),
    ...(opts.with?.(state) ?? []),
  ]);
  if (accept) ctx.reload();
}

// ---------- probe ----------

/** What a probe's query answered, as builder.probe_decided records it. */
function outcomeOf(deps: EngineDeps, r: RunQueryResult): { query: string | null; outcome: "ran" | "refused"; detail: string } {
  switch (r.status) {
    case "done": return { query: r.query, outcome: "ran", detail: `${r.rows} ${r.rows === 1 ? "row" : "rows"} (${r.outcome})` };
    case "failed": return { query: r.query, outcome: "ran", detail: `the query failed: ${shown(deps, r.error)}` };
    case "refused": return { query: null, outcome: "refused", detail: r.reasons.map((x) => shown(deps, x)).join("; ") };
    case "needs_budget": return {
      query: null, outcome: "refused",
      detail: r.estimate === null ? "it is costly and has no estimate; approve it with a budget" : `it is costly: it would cost ${r.estimate.amount} ${r.estimate.unit}; approve it with a budget that covers that`,
    };
  }
}

/** Approves already being run, by session: a second press waits in the session's line and then finds the probe decided. */
const probing = new WeakMap<CaseHub, Set<string>>();

/**
 * The person's decision on a probe. A rejection writes builder.probe_decided and nothing else. An approval runs it through runQuery in the
 * builder session, in the person's name, with the person's budget, and records whatever runQuery answered; the card it makes is the session's.
 */
export async function builderProbe(ctx: BuilderContext, probe: string, approve: boolean, budget: number | null): Promise<void> {
  const { session, hub } = ctx;
  const probes = session.state.builder.probes;
  if (typeof probe !== "string" || !Object.hasOwn(probes, probe)) throw new BuilderRefused(`there is no probe ${JSON.stringify(String(probe).slice(0, 40))} in this session`);
  const p = probes[probe]!;
  if (p.decided !== null) throw new BuilderRefused(`probe ${probe} is decided already`);
  if (budget !== null && !(typeof budget === "number" && Number.isFinite(budget) && budget > 0)) throw new BuilderRefused("a budget is a number above zero, or none");
  if (!approve) {
    session.commit(() => [{ type: "builder.probe_decided", actor: ctx.actor, payload: { probe, approved: false, query: null, outcome: "rejected", detail: "" } }]);
    return;
  }
  const key = `${session.state.meta!.id}/${probe}`;
  const running = probing.get(hub) ?? new Set<string>();
  probing.set(hub, running);
  if (running.has(key)) throw new BuilderRefused(`probe ${probe} is being run already`);
  running.add(key);
  const deps = { ...ctx.deps };
  const release = deps.retain?.() ?? (() => undefined);
  // what the source answers is data: a secret value in its rows is redacted before the session's ledger or blobs hold it
  const recording = redactingSession(session, ctx.secrets());
  try {
    const why = p.why === "" ? `a probe the loop builder asked for (${probe})` : p.why;
    const window = { from: p.window.from, to: p.window.to };
    let result: RunQueryResult;
    if (p.kind === "pivot") {
      const pivot = deps.runner.registry.pivot(p.pivot ?? "");
      if (pivot === null) result = { status: "refused", reasons: [`unknown pivot: ${p.pivot}`] };
      else {
        let bound: ReturnType<typeof bindPivot> | null = null;
        try {
          bound = bindPivot(pivot, p.value?.value ?? "", deps.runner.observables);
        } catch (err) {
          if (!(err instanceof PivotError)) throw err;
          result = { status: "refused", reasons: [err.message] };
        }
        result = bound === null ? result! : await runQuery(recording, deps.runner, { source: pivot.source, text: bound.text, bound: bound.bound, window, why, actor: ctx.actor, pivot, make_card: true, budget });
      }
    } else {
      result = await runQuery(recording, deps.runner, { source: p.source, text: p.text ?? "", bound: {}, window, why, actor: ctx.actor, make_card: true, budget });
    }
    const got = outcomeOf(deps, result);
    session.commit((s) => {
      if (s.builder.probes[probe]?.decided != null) throw new BuilderRefused(`probe ${probe} is decided already`);
      return [{ type: "builder.probe_decided", actor: ctx.actor, payload: { probe, approved: true, query: got.query, outcome: got.outcome, detail: clip(redactSecrets(got.detail, ctx.secrets()), 2000) } }];
    });
  } finally {
    running.delete(key);
    release();
  }
}

// ---------- the model ----------

/** The person's pick of the builder's model for this session: one a provider lists and the session's marking may go to. */
export async function builderModel(ctx: BuilderContext, choice: ModelChoice): Promise<void> {
  const { session } = ctx;
  const deps = { ...ctx.deps };
  const marking = builderMarking(session.state);
  const view = (await modelsFor(deps, marking)).find((m) => m.provider === choice.provider && m.model === choice.model);
  if (view === undefined) throw new BuilderRefused(`no provider lists the model ${String(choice.model).slice(0, 64)} for ${String(choice.provider).slice(0, 64)}`);
  if (choice.effort !== null && !view.efforts.includes(choice.effort)) throw new BuilderRefused(`the model ${view.model} has no effort ${choice.effort}`);
  if (!view.allowed) throw new BuilderRefused(view.reason ?? `${marking} may not go to this model`);
  session.commit(() => [{ type: "stage.model_set", actor: ctx.actor, payload: { stage: BUILDER_STAGE, choice: { provider: view.provider, model: view.model, effort: choice.effort } } }]);
}

/** For a JSON body: a model choice, or null. */
export function choiceFrom(x: unknown): ModelChoice | null {
  if (!isPlainObject(x)) return null;
  const extra = Object.keys(x).find((k) => !["provider", "model", "effort"].includes(k));
  if (extra !== undefined || typeof x.provider !== "string" || typeof x.model !== "string" || !(x.effort === null || typeof x.effort === "string")) return null;
  return { provider: x.provider, model: x.model, effort: x.effort as string | null };
}
