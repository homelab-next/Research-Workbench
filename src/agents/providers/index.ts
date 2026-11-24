import type { Json } from "../../core/canonical";
import { validate } from "../../core/schema";
import type { Schema } from "../../core/schema";
import { describeErrors, ManifestError, withoutNulls } from "../../modules/manifests";
import type { LoadedManifest } from "../../modules/manifests";
import type { Problem, Registry } from "../../modules/registry";
import type { Secrets } from "../../modules/secrets";
import { ScriptedProvider, toScript } from "./scripted";
import type { Script } from "./scripted";
import type { Provider } from "./types";

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

/** Reads every model manifest and every script. Each problem leaves only its own manifest out. */
export function loadProviders(registry: Registry, _secrets: Secrets): { providers: Providers; problems: Problem[] } {
  const problems: Problem[] = [];
  const problem = (m: LoadedManifest, error: string): void => {
    problems.push({ root: m.root, path: m.path, error });
  };
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
      problem(m, "the local provider is not built yet");
    } else {
      problem(m, `unknown provider "${kind}"`);
    }
  }
  return { providers: new Providers(list), problems };
}
