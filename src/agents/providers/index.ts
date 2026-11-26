import type { Json } from "../../core/canonical";
import { isPlainObject } from "../../core/canonical";
import { validate } from "../../core/schema";
import type { Schema } from "../../core/schema";
import { describeErrors, ManifestError, withoutNulls } from "../../modules/manifests";
import type { LoadedManifest } from "../../modules/manifests";
import type { Problem, Registry } from "../../modules/registry";
import type { Secrets } from "../../modules/secrets";
import { LocalProvider } from "./local";
import { requestExtraProblem } from "./extra";
import type { RequestExtra } from "./extra";
import { SAMPLING_SCHEMA } from "./sampling";
import { ScriptedProvider, toScript } from "./scripted";
import type { Script } from "./scripted";
import type { Where } from "../../core/types";
import type { Provider, Sampling } from "./types";

export type { ChatMessage, ModelInfo, Provider, ToolCall, ToolSpec, TurnRequest, TurnResult } from "./types";

export class Providers {
  readonly #byId = new Map<string, Provider>();
  constructor(list: Provider[]) {
    for (const p of list) this.#byId.set(p.id, p);
  }
  get(id: string): Provider | null {
    return this.#byId.get(id) ?? null;
  }
  all(): Provider[] {
    return [...this.#byId.values()];
  }
}

const MODEL_SCHEMA: Schema = {
  type: "object",
  required: ["kind", "id", "provider", "where"],
  properties: {
    kind: { const: "model" },
    id: { type: "string", minLength: 1 },
    title: { type: "string" },
    provider: { type: "string", minLength: 1 },
    where: { enum: ["machine", "network", "hosted"] },
  },
  additionalProperties: true,
};

const LOCAL_SCHEMA: Schema = {
  type: "object",
  required: ["base_url"],
  properties: {
    base_url: { type: "string", minLength: 1 },
    credential: { type: "string", minLength: 1 },
    context: { type: "integer", minimum: 1 },
    parallel: { type: "integer", minimum: 1, maximum: 64 },
    efforts: { type: "array", items: { type: "string", minLength: 1 } },
    timeout_ms: { type: "integer", minimum: 1, maximum: 600000 },
    max_output_tokens: { type: "integer", minimum: 1 },
    structured_output: { type: "boolean" },
    sampling: SAMPLING_SCHEMA,
    request_extra: { type: "object" },
  },
  additionalProperties: true,
};

/** A local provider from its manifest, or the reason it cannot be built. */
function buildLocal(m: LoadedManifest, registry: Registry, secrets: Secrets, own: (() => readonly string[]) | undefined): LocalProvider | string {
  const body = withoutNulls(m.body as Json) as Record<string, Json>;
  const errors = validate(LOCAL_SCHEMA, body);
  if (errors.length > 0) return describeErrors(errors);
  if (body.request_extra !== undefined) {
    const problem = requestExtraProblem(body.request_extra);
    if (problem !== null) return problem;
  }
  const credential = typeof body.credential === "string" ? body.credential : null;
  if (credential !== null && !(registry.rootOf(m.path)?.credentials ?? []).includes(credential)) {
    return `model "${m.id}" names credential "${credential}", which this root's credentials do not include`;
  }
  try {
    return new LocalProvider({
      id: m.id,
      base_url: body.base_url as string,
      where: m.body.where as Where,
      credential,
      secrets,
      context: typeof body.context === "number" ? body.context : null,
      ...(typeof body.parallel === "number" ? { parallel: body.parallel } : {}),
      efforts: Array.isArray(body.efforts) ? (body.efforts as string[]) : [],
      timeout_ms: typeof body.timeout_ms === "number" ? body.timeout_ms : 120000,
      ...(typeof body.max_output_tokens === "number" ? { max_output_tokens: body.max_output_tokens } : {}),
      ...(typeof body.structured_output === "boolean" ? { structured_output: body.structured_output } : {}),
      ...(isPlainObject(body.sampling) ? { sampling: body.sampling as Sampling } : {}),
      ...(isPlainObject(body.request_extra) ? { request_extra: body.request_extra as RequestExtra } : {}),
      ...(own === undefined ? {} : { refuse_hosts: own }),
    });
  } catch (err) {
    return `model "${m.id}": ${(err as Error).message}`;
  }
}

/** Reads every model manifest and every script. Each problem leaves only its own manifest out. */
export function loadProviders(registry: Registry, secrets: Secrets, opts: { refuse_hosts?: () => readonly string[] } = {}): { providers: Providers; problems: Problem[] } {
  const problems: Problem[] = [];
  const problem = (m: LoadedManifest, error: string): void => {
    problems.push({ root: m.root, path: m.path, error });
  };
  // The trusted-root and duplicate-id checks below are defence in depth: the registry already refuses model and script
  // manifests from untrusted roots and duplicate ids before they load.
  const trusted = (m: LoadedManifest): boolean => registry.rootOf(m.path)?.trusted === true;

  const scripts: Script[] = [];
  for (const m of registry.all("script")) {
    if (!trusted(m)) { problem(m, "a script is accepted only from a trusted root"); continue; }
    try {
      scripts.push(toScript(m));
    } catch (err) {
      problem(m, `script "${m.id}": ${err instanceof ManifestError ? err.message : (err as Error).message}`);
    }
  }

  const list: Provider[] = [];
  const seen = new Set<string>();
  for (const m of registry.all("model")) {
    if (!trusted(m)) { problem(m, "a model manifest is accepted only from a trusted root"); continue; }
    const errors = validate(MODEL_SCHEMA, withoutNulls(m.body as Json));
    if (errors.length > 0) { problem(m, describeErrors(errors)); continue; }
    if (seen.has(m.id)) { problem(m, `duplicate model id "${m.id}"`); continue; }
    const kind = m.body.provider as string;
    if (kind === "scripted") {
      if (m.body.where !== "machine") { problem(m, "a scripted provider runs on this machine: where must be machine"); continue; }
      seen.add(m.id);
      list.push(new ScriptedProvider({ id: m.id, scripts }));
    } else if (kind === "local") {
      const built = buildLocal(m, registry, secrets, opts.refuse_hosts);
      if (typeof built === "string") { problem(m, built); continue; }
      seen.add(m.id);
      list.push(built);
    } else {
      problem(m, `unknown provider "${kind}"`);
    }
  }
  return { providers: new Providers(list), problems };
}
