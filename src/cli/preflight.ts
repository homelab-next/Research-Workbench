// bun run src/cli/preflight.ts [--config <file>] [--min-context <tokens>] [--no-question]
// Is this configuration ready to run? Reads manifests, renders every pivot against the guard, checks the marking policy, and asks the
// model endpoint what it lists and has loaded. It never contacts a data source, opens no workbench, takes no lock and writes nothing.
// The one thing it sends anywhere is a fixed test question to each model a stage names; the question carries no case data.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject } from "../core/canonical";
import { loadProfile } from "../agents/context";
import { fitProblem, mayGo, packBudget, slotContext } from "../agents/pack";
import { loadProviders } from "../agents/providers";
import type { ModelInfo, Provider } from "../agents/providers";
import { describeSampling } from "../agents/providers/sampling";
import { ConfigError, loadConfig } from "../modules/config";
import { ConnectorPool } from "../modules/connectors";
import { GuardError } from "../modules/sqlguard";
import { Observables } from "../modules/observables";
import { Registry } from "../modules/registry";
import { Secrets, SecretError } from "../modules/secrets";
import { loadChecks, loadPipeline } from "../pipeline/manifests";
import type { StageManifest } from "../pipeline/manifests";

export interface Check { name: string; level: "ok" | "fail" | "note"; detail: string }

const USAGE = "usage: bun run preflight [--config <file>] [--min-context <tokens>] [--no-question]\nexit 0 ready, 1 not ready, 2 bad command line or configuration, 3 unexpected error";
const DEFAULT_MIN_CONTEXT = 32768;
const NAMES = ["configuration", "outside the repository", "secrets", "manifests", "pipeline", "checks", "lake sources", "pivots", "model listed", "model loaded", "context", "context fit", "marking policy", "model answers"] as const;
type Name = (typeof NAMES)[number];

/** The command line is wrong. The process exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = "UsageError";
  }
}

interface Parsed { config: string | null; min_context: number; question: boolean }

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { config: null, min_context: DEFAULT_MIN_CONTEXT, question: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--no-question") out.question = false;
    else if (a === "--config" || a === "--min-context") {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      if (a === "--config") {
        if (out.config !== null) throw new UsageError("--config was given twice");
        out.config = v;
      } else {
        if (!/^[1-9]\d{0,9}$/.test(v)) throw new UsageError(`--min-context wants a number of tokens, not ${v}`);
        out.min_context = Number(v);
      }
    } else throw new UsageError(`unexpected argument: ${a}`);
  }
  return out;
}

/** The real path of `p`, or of its nearest existing ancestor with the rest appended. */
function realish(p: string): string {
  let up = resolve(p);
  const rest: string[] = [];
  while (!existsSync(up)) { rest.unshift(basename(up)); up = dirname(up); }
  return join(realpathSync(up), ...rest);
}
const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + sep);
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** Nothing that looks like userinfo in a URL is ever printed. */
const noUserinfo = (s: string): string => s.replace(/\/\/[^/\s@]*@/g, "//");
const CONTROLS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]", "g");
const MAX_DETAIL = 300;
/** One line of at most 300 characters, with no control character and no userinfo: text from a model or an endpoint is never printed raw. */
export function oneLine(s: string): string {
  const t = noUserinfo(s).replace(CONTROLS, " ");
  return t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL - 1)}\u2026` : t;
}
const MODEL_CALL_MS = 30000;
/** Tokens the fixed question leaves free for the model's own reply, of the context a request has. */
const QUESTION_ROOM = 2048;
/** Rejects if `work` takes longer than `ms`. */
async function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`${what} gave no answer within ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

const QUESTION_TOOL = {
  name: "record", description: "Record one line.",
  parameters: { type: "object", additionalProperties: false, required: ["why"], properties: { why: { type: "string", minLength: 1 } } },
} as const;

/** What was wrong with the model's answer to the question, or null when it was one well-formed `record` call. */
function judge(calls: { name: string; arguments: string }[]): string | null {
  if (calls.length === 0) return "no tool call";
  if (calls.length > 1) return `${calls.length} tool calls; one was asked for`;
  const c = calls[0]!;
  if (c.name !== "record") return `the call is to "${c.name.slice(0, 60)}", not record`;
  let args: unknown;
  try { args = JSON.parse(c.arguments); } catch { return "arguments are not JSON"; }
  if (!isPlainObject(args)) return "arguments are not a JSON object";
  if (typeof args.why !== "string" || args.why === "") return "why is missing";
  return null;
}

export async function preflight(
  argv: string[],
  opts: { env?: Record<string, string | undefined>; home?: string; repoRoot?: string } = {},
): Promise<{ checks: Check[]; ok: boolean }> {
  const p = parseArgs(argv);
  const env = opts.env ?? process.env;
  const repoRoot = opts.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const config = loadConfig({ ...(p.config === null ? {} : { path: p.config }), env, ...(opts.home === undefined ? {} : { home: opts.home }), repoRoot });

  const by = new Map<Name, Check[]>();
  const add = (name: Name, level: Check["level"], detail: string): void => {
    const list = by.get(name) ?? [];
    list.push({ name, level, detail: oneLine(detail) });
    by.set(name, list);
  };
  add("configuration", "ok", config.path ?? "defaults (the bundled sample)");

  // where things live
  const repo = realpathSync(repoRoot);
  const sample = realish(join(repo, "sample"));
  const showFrom = config.path === null ? process.cwd() : dirname(config.path);
  const show = (path: string): string => (path === "" ? "(empty path)" : relative(showFrom, path) || ".");
  const placed: { what: string; path: string }[] = [];
  if (config.path !== null) placed.push({ what: "the configuration file", path: config.path });
  if (config.secrets_file !== null) placed.push({ what: "the secrets file", path: config.secrets_file });
  for (const r of config.roots) if (r.path === "" || realish(r.path) !== sample) placed.push({ what: "a root", path: r.path });
  let bad = 0;
  for (const x of placed) {
    if (x.path === "" || inside(realish(x.path), repo)) { bad++; add("outside the repository", "fail", `${x.what} ${x.what === "the configuration file" ? x.path : show(x.path)} lies inside the repository; keep it outside`); }
  }
  if (bad === 0) add("outside the repository", "ok", "the configuration, the secrets file and every root are outside it");

  // secrets: names only, never values
  let secrets: Secrets;
  let secretsOk = true;
  try {
    secrets = new Secrets(env, config.secrets_file);
  } catch (err) {
    secretsOk = false;
    add("secrets", "fail", reason(err));
    secrets = new Secrets(env, null);
  }

  const registry = Registry.load(config.roots);
  const named = new Set<string>();
  for (const s of registry.sources()) if (s.credential !== null) named.add(s.credential);
  for (const m of registry.all("model")) if (typeof m.body.credential === "string") named.add(m.body.credential);
  let missing = 0;
  for (const name of [...named].sort()) {
    try {
      if (secrets.get(name) === null) { missing++; add("secrets", "fail", `the credential ${name} has no value in the environment or the secrets file`); }
    } catch (err) {
      missing++;
      add("secrets", "fail", err instanceof SecretError ? `the credential ${name} has an unusable value (empty or too short)` : `the credential ${name} could not be read`);
    }
  }
  if (secretsOk && missing === 0) add("secrets", "ok", named.size === 0 ? "no credential is named" : `${named.size} named: ${[...named].sort().join(", ")}; each has a value`);

  // manifests
  const rel = (q: { root: string; path: string; error: string }): string => `${relative(q.root, q.path)}: ${q.error.split(q.root).join("")}`;
  const loaded = loadProviders(registry, secrets);
  const manifestProblems = [...registry.problems, ...loaded.problems];
  for (const q of manifestProblems) add("manifests", "fail", rel(q));
  if (manifestProblems.length === 0) add("manifests", "ok", `${registry.sources().length} sources, ${registry.pivots().length} pivots, ${loaded.providers.all().length} providers`);

  // pipeline and profile
  const { pipeline, problems: pipelineProblems } = loadPipeline(registry);
  for (const q of pipelineProblems) add("pipeline", "fail", config.roots.reduce((t, r) => t.split(`${r.path}/`).join(""), q));
  let profileOk = true;
  try { loadProfile(registry, "investigation"); } catch (err) { profileOk = false; add("pipeline", "fail", `no usable investigation profile: ${reason(err)}`); }
  if (pipeline === null && pipelineProblems.length === 0) add("pipeline", "fail", "there is no usable pipeline");
  if (pipeline !== null && pipelineProblems.length === 0 && profileOk) add("pipeline", "ok", `${pipeline.stages.length} stages and the investigation profile`);

  // checks
  const cks = loadChecks(registry);
  for (const b of cks.broken) add("checks", "fail", `${b.id}: ${b.problem}`);
  if (cks.checks.length === 0) add("checks", "fail", "no check is loaded");
  if (cks.broken.length === 0 && cks.checks.length > 0) add("checks", "ok", `${cks.checks.length} checks load`);

  // lake sources
  const lakes = registry.sources().filter((s) => s.connector === "trino");
  let lakeBad = 0;
  for (const s of lakes) {
    if (s.adhoc) { lakeBad++; add("lake sources", "fail", `${s.id}: open to agent-written queries (adhoc: true); set it to false`); }
    for (const t of s.tables) if (!t.guarded) add("lake sources", "note", `${s.id}: table ${t.name} is not guarded`);
    if (!s.tls_verify) add("lake sources", "note", `${s.id}: tls_verify is false; the server's certificate is not checked`);
  }
  if (lakeBad === 0) add("lake sources", "ok", lakes.length === 0 ? "no lake source" : `${lakes.length} lake source${lakes.length === 1 ? "" : "s"}, none open to agent-written queries`);

  // pivots, rendered offline
  const observables = new Observables(registry.types());
  const pool = new ConnectorPool({ secrets, observables });
  try {
    let pivotBad = 0;
    for (const pv of registry.pivots()) {
      const source = registry.source(pv.source);
      if (source === null) { pivotBad++; add("pivots", "fail", `${pv.id}: the source ${pv.source} is not loaded`); continue; }
      try {
        pool.for(source).render({
          text: pv.query, bound: { value: "probe" },
          window: pv.needs_window ? { from: "2026-01-01T00:00:00.000Z", to: "2026-01-01T01:00:00.000Z" } : { from: null, to: null },
          max_rows: source.limits.max_rows, timeout_ms: source.limits.timeout_ms, budget: null,
        });
      } catch (err) {
        pivotBad++;
        add("pivots", "fail", `${pv.id}: ${err instanceof GuardError ? err.violations.join("; ") : reason(err)}`);
      }
    }
    if (pivotBad === 0) { const n = registry.pivots().length; add("pivots", "ok", n === 0 ? "no pivots" : `${n} pivot${n === 1 ? "" : "s"} render${n === 1 ? "s" : ""} against the guard`); }
  } finally {
    pool.closeAll();
  }

  // the models the stages name
  const agents: StageManifest[] = (pipeline?.stages ?? []).filter((s) => s.runs === "agent" && s.model !== null);
  // each model a stage uses: its own, and a fast one when its manifest names one (named `research (fast)`)
  const stages: { id: string; model: { provider: string; model: string }; max_output_tokens: number | null | undefined }[] = agents.flatMap((s) => [
    { id: s.id, model: s.model!, max_output_tokens: s.max_output_tokens },
    ...(s.fast_model == null ? [] : [{ id: `${s.id} (fast)`, model: s.fast_model, max_output_tokens: s.max_output_tokens }]),
  ]);
  const pairs = new Map<string, { provider: string; model: string; stages: string[] }>();
  for (const s of stages) {
    const key = JSON.stringify([s.model.provider, s.model.model]);
    const have = pairs.get(key) ?? { provider: s.model.provider, model: s.model.model, stages: [] };
    have.stages.push(s.id);
    pairs.set(key, have);
  }
  const many = pairs.size > 1;
  const listings = new Map<string, Promise<ModelInfo[]>>();
  const asked: { pair: { provider: string; model: string }; provider: Provider; slot: number | null }[] = [];
  for (const pair of pairs.values()) {
    const who = many ? `${pair.model}: ` : "";
    const provider = loaded.providers.get(pair.provider);
    if (provider === null) { add("model listed", "fail", `${pair.model}: the provider "${pair.provider}" is not loaded (stages ${pair.stages.join(", ")})`); continue; }
    const cap = Math.min(typeof registry.get("model", provider.id)?.body.timeout_ms === "number" ? (registry.get("model", provider.id)!.body.timeout_ms as number) : 120000, MODEL_CALL_MS);
    if (!listings.has(provider.id)) listings.set(provider.id, within(cap, provider.models(), provider.id));
    let list: ModelInfo[];
    try { list = await listings.get(provider.id)!; } catch (err) { add("model listed", "fail", `${pair.provider}: ${reason(err)}`); continue; }
    const info = list.find((m) => m.id === pair.model);
    if (info === undefined) { add("model listed", "fail", `${pair.provider} does not list the model ${pair.model}`); continue; }
    add("model listed", "ok", `${pair.model} at ${pair.provider}` + (provider.kind === "local" ? `; sampling ${describeSampling(provider.sampling)}; up to ${provider.max_output_tokens ?? "an unknown number of"} output tokens` : ""));
    if (info.loaded === false) {
      add("model loaded", "fail", `${pair.model} is not loaded at ${pair.provider}; load it with a context of at least ${p.min_context} tokens and run this again`);
      continue;
    }
    if (info.loaded === null) add("model loaded", "note", `${pair.provider} does not say what is loaded; ${pair.model} may need loading`);
    else add("model loaded", "ok", `${pair.model} is loaded at ${pair.provider}`);
    let slotOf: number | null = null;
    if (provider.kind === "scripted") {
      add("context", "note", `${who}a script has no context window`);
    } else {
      const manifest = registry.get("model", pair.provider)?.body.context;
      const context = info.loaded === true ? info.context : typeof manifest === "number" ? manifest : null;
      const slots = info.parallel;
      if (context === null) add("context", "fail", `${who}the context is not known: ${pair.provider} does not report it and its manifest gives none`);
      else {
        const slot = slotContext(context, slots);
        const share = slots !== null && slots > 1 ? ` a request (${context} loaded, shared by ${slots} slots)` : "";
        if (slot < p.min_context) add("context", "fail", `${who}${slot} tokens${share} is below the ${p.min_context} a run needs; load it with a larger context`);
        else add("context", "ok", `${who}${slot} tokens${share}; a turn's pack may use ${packBudget(slot)} characters`);
        slotOf = slot;
        const mine = stages.filter((s) => s.model.provider === pair.provider && s.model.model === pair.model);
        const cap = (s: { max_output_tokens?: number | null }): number | undefined => s.max_output_tokens ?? provider.max_output_tokens;
        let fitBad = 0;
        for (const s of mine) {
          const c = cap(s);
          const problem = c === undefined ? null : fitProblem(slot, c);
          if (problem !== null) { fitBad++; add("context fit", "fail", `${s.id}: ${problem}`); }
        }
        if (fitBad === 0) add("context fit", "ok", `${who}every stage's reply cap fits ${slot} tokens a request (${slots ?? 1} slot${(slots ?? 1) === 1 ? "" : "s"})`);
      }
    }
    asked.push({ pair, provider, slot: slotOf });
  }

  // the marking policy
  let markBad = 0;
  for (const s of stages) {
    const provider = loaded.providers.get(s.model.provider);
    if (provider === null) continue;
    for (const src of registry.sources()) {
      if (!mayGo(src.marking, provider.where, config.marking_policy)) {
        markBad++;
        add("marking policy", "fail", `${s.id}: cards from ${src.id} (${src.marking}) may not go to a model at ${provider.where}`);
      }
    }
  }
  if (markBad === 0) add("marking policy", "ok", "every source's marking may go to every stage's model");

  // the one question
  if (p.question) {
    for (const { pair, provider, slot } of asked) {
      if (provider.kind === "scripted") { add("model answers", "note", `${pair.model} is scripted; nothing was asked`); continue; }
      const cap = Math.min(typeof registry.get("model", pair.provider)?.body.timeout_ms === "number" ? (registry.get("model", pair.provider)!.body.timeout_ms as number) : 120000, MODEL_CALL_MS);
      const r = await within(cap, provider.turn({
        model: pair.model, effort: null, key: "preflight", ordinal: 0,
        messages: [
          { role: "system", content: "You are checking that a tool can be called." },
          { role: "user", content: "Call the tool record once, with why set to a short reason. Then stop." },
        ],
        tools: [QUESTION_TOOL as never],
        ...(slot === null ? {} : { max_output_tokens: Math.max(1, slot - QUESTION_ROOM) }),
      }), pair.model).catch((err): { kind: "error"; message: string; raw: null } => ({ kind: "error", message: reason(err), raw: null }));
      if (r.kind === "error") { add("model answers", "fail", r.message); continue; }
      if (r.kind === "declined") { add("model answers", "fail", `declined: ${r.reason}`); continue; }
      const wrong = judge(r.tool_calls);
      if (wrong !== null) add("model answers", "fail", wrong);
      else add("model answers", "ok", `one well-formed call (${r.usage.input} tokens in, ${r.usage.output} out); this question carries no case data and is not in a ledger`);
    }
  }

  const checks = NAMES.flatMap((n) => by.get(n) ?? []);
  return { checks, ok: !checks.some((c) => c.level === "fail") };
}

const LABEL = { ok: "ok   ", fail: "FAIL ", note: "note " } as const;

if (import.meta.main) {
  try {
    const r = await preflight(process.argv.slice(2));
    for (const c of r.checks) console.log(`${LABEL[c.level]} ${c.name}: ${c.detail}`);
    const asked = r.checks.filter((c) => c.name === "model answers" && c.level !== "note").length;
    if (asked > 0) console.log(`made ${asked} model call${asked === 1 ? "" : "s"}: a fixed question with no case data, not recorded in any ledger`);
    const n = r.checks.filter((c) => c.level === "fail").length;
    console.log(n === 0 ? "ready" : `not ready: ${n} to fix`);
    process.exitCode = n === 0 ? 0 : 1;
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConfigError) {
      console.error(err.message);
      process.exitCode = 2;
    } else {
      console.error(`unexpected error: ${oneLine(reason(err))}`);
      process.exitCode = 3;
    }
  }
}
