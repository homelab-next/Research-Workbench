import type { Json } from "../../core/canonical";
import { canonical, isPlainObject } from "../../core/canonical";
import type { Usage } from "../../core/state";
import type { Where } from "../../core/types";
import { ManifestError } from "../../modules/manifests";
import type { LoadedManifest } from "../../modules/manifests";
import type { ModelInfo, Provider, ToolCall, TurnRequest, TurnResult } from "./types";

export type ScriptReply =
  | { content?: string; reasoning?: string; tool_calls?: { tool: string; args: Record<string, Json> }[]; usage?: Partial<Usage> }
  | { declined: string }
  | { error: string };
export interface ScriptTurn { actor: string; reply: ScriptReply }
export interface Script { id: string; turns: ScriptTurn[] }

const enc = new TextEncoder();
const dec = new TextDecoder();
const PLACEHOLDER = /\{\{card:(.+?)\}\}/g;
const chars = (n: number): number => Math.ceil(n / 4);

class Unresolved extends Error {
  constructor(readonly title: string) {
    super(title);
  }
}

/** Every object with a string id and title, anywhere in a parsed tool result. */
function collectCards(value: unknown, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectCards(v, out);
  } else if (isPlainObject(value)) {
    if (typeof value.id === "string" && typeof value.title === "string" && !out.has(value.title)) out.set(value.title, value.id);
    for (const v of Object.values(value)) collectCards(v, out);
  }
}

function resolveJson(value: Json, cards: Map<string, string>): Json {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (_m, title: string) => {
      const id = cards.get(title);
      if (id === undefined) throw new Unresolved(title);
      return id;
    });
  }
  if (Array.isArray(value)) return value.map(v => resolveJson(v, cards));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value as Record<string, Json>).map(([k, v]) => [k, resolveJson(v, cards)]));
  return value;
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v !== "";

function checkReply(reply: unknown, where: string): ScriptReply {
  if (!isPlainObject(reply)) throw new ManifestError(`${where}: reply must be a mapping`);
  const keys = Object.keys(reply);
  if ("declined" in reply) {
    if (keys.length !== 1 || typeof reply.declined !== "string") throw new ManifestError(`${where}: a declined reply is only { declined: text }`);
    return { declined: reply.declined };
  }
  if ("error" in reply) {
    if (keys.length !== 1 || typeof reply.error !== "string") throw new ManifestError(`${where}: an error reply is only { error: text }`);
    return { error: reply.error };
  }
  const out: { content?: string; reasoning?: string; tool_calls?: { tool: string; args: Record<string, Json> }[]; usage?: Partial<Usage> } = {};
  for (const k of keys) {
    if (!["content", "reasoning", "tool_calls", "usage"].includes(k)) throw new ManifestError(`${where}: unknown reply field "${k}"`);
  }
  for (const k of ["content", "reasoning"] as const) {
    if (reply[k] === undefined || reply[k] === null) continue;
    if (typeof reply[k] !== "string") throw new ManifestError(`${where}: ${k} must be text`);
    out[k] = reply[k] as string;
  }
  if (reply.tool_calls !== undefined && reply.tool_calls !== null) {
    if (!Array.isArray(reply.tool_calls)) throw new ManifestError(`${where}: tool_calls must be a list`);
    out.tool_calls = reply.tool_calls.map((c: unknown, i: number) => {
      if (!isPlainObject(c) || !isNonEmptyString(c.tool) || !isPlainObject(c.args)) throw new ManifestError(`${where}: tool_calls[${i}] needs a tool name and an args mapping`);
      return { tool: c.tool, args: c.args as Record<string, Json> };
    });
  }
  if (reply.usage !== undefined && reply.usage !== null) {
    if (!isPlainObject(reply.usage)) throw new ManifestError(`${where}: usage must be a mapping`);
    const u: Partial<Usage> = {};
    for (const [k, v] of Object.entries(reply.usage)) {
      if (k !== "input" && k !== "output" && k !== "reasoning") throw new ManifestError(`${where}: unknown usage field "${k}"`);
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ManifestError(`${where}: usage.${k} must be a non-negative integer`);
      u[k] = v;
    }
    out.usage = u;
  }
  return out;
}

/** Builds a script from a `kind: script` manifest. Throws ManifestError naming the bad turn. */
export function toScript(manifest: LoadedManifest): Script {
  const turns = manifest.body.turns;
  if (!Array.isArray(turns)) throw new ManifestError("a script needs a turns list");
  return {
    id: manifest.id,
    turns: turns.map((t, i): ScriptTurn => {
      const where = `turns[${i}]`;
      if (!isPlainObject(t)) throw new ManifestError(`${where}: must be a mapping`);
      if (!isNonEmptyString(t.actor)) throw new ManifestError(`${where}: missing actor`);
      return { actor: t.actor, reply: checkReply(t.reply, where) };
    }),
  };
}

export class ScriptedProvider implements Provider {
  readonly id: string;
  readonly kind = "scripted" as const;
  readonly where: Where = "machine";
  readonly #scripts = new Map<string, Script>();

  constructor(opts: { id: string; scripts: Script[] }) {
    this.id = opts.id;
    for (const s of opts.scripts) this.#scripts.set(s.id, s);
  }

  async models(): Promise<ModelInfo[]> {
    return [...this.#scripts.keys()].map(id => ({ id, context: null, efforts: [] }));
  }

  body(req: TurnRequest): Uint8Array {
    const { model, effort, key, ordinal, messages, tools } = req;
    return enc.encode(canonical({ model, effort, key, ordinal, messages, tools } as unknown as Json));
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const missing = (): TurnResult => ({ kind: "error", message: `script ${req.model} has no turn ${req.ordinal + 1} for ${req.key}`, raw: null });
    const script = this.#scripts.get(req.model);
    if (script === undefined) return missing();
    const turn = script.turns.filter(t => t.actor === req.key)[req.ordinal];
    if (turn === undefined) return missing();
    const reply = turn.reply;
    if ("declined" in reply) return { kind: "declined", reason: reply.declined, served_by: script.id, raw: enc.encode(canonical(reply)) };
    if ("error" in reply) return { kind: "error", message: reply.error, raw: enc.encode(canonical(reply)) };

    const cards = new Map<string, string>();
    for (const m of req.messages) {
      if (m.role !== "tool") continue;
      try {
        collectCards(JSON.parse(m.content), cards);
      } catch {
        // a tool result that is not JSON holds no cards
      }
    }
    let content: string;
    let calls: { tool: string; args: Record<string, Json> }[];
    try {
      content = resolveJson(reply.content ?? "", cards) as string;
      calls = (reply.tool_calls ?? []).map(c => ({ tool: c.tool, args: resolveJson(c.args, cards) as Record<string, Json> }));
    } catch (err) {
      if (!(err instanceof Unresolved)) throw err;
      return { kind: "error", message: `script ${script.id} refers to a card titled "${err.title}" that this conversation has not shown`, raw: null };
    }
    const reasoning = reply.reasoning ?? null;
    const tool_calls: ToolCall[] = calls.map((c, i) => ({ id: `call-${req.ordinal}-${i}`, name: c.tool, arguments: JSON.stringify(c.args) }));
    const usage: Usage = {
      input: chars(dec.decode(this.body(req)).length),
      output: chars(content.length),
      reasoning: chars((reasoning ?? "").length),
      ...(reply.usage ?? {}),
    };
    const resolved: { [k: string]: Json } = { content };
    if (reasoning !== null) resolved.reasoning = reasoning;
    if (calls.length > 0) resolved.tool_calls = calls as unknown as Json;
    if (reply.usage !== undefined) resolved.usage = reply.usage as Json;
    return {
      kind: "answer", content, reasoning, tool_calls, stop: tool_calls.length > 0 ? "tool_calls" : "end",
      usage, served_by: script.id, raw: enc.encode(canonical(resolved)),
    };
  }
}
