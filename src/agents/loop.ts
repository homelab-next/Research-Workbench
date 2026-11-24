import type { Json } from "../core/canonical";
import { isPlainObject, parseJson } from "../core/canonical";
import type { Schema } from "../core/schema";
import { validate } from "../core/schema";
import type { CaseSession } from "../core/session";
import { runUsage } from "../core/state";
import type { Actor, BlobRef, EntryInput, Marking, Where } from "../core/types";
import { strictest } from "../core/types";
import { mayGo, renderPack, tooStrict } from "./pack";
import type { Pack } from "./pack";
import type { ChatMessage, Provider, TurnRequest, TurnResult } from "./providers/types";
import { execTool, parseCall, toolSpecs, viewText } from "./tools";
import type { ToolContext, ToolName } from "./tools";

export const MAX_TURNS = 16;
const DECLINE_CHARS = 2000;

export interface AgentSpec {
  actor: Extract<Actor, { kind: "agent" }>; provider: Provider; model: string; effort: string | null;
  pack: Pack; task: string; tools: readonly ToolName[]; ctx: ToolContext; schema: Schema | null;
  policy: Record<Marking, Where[]>; max_marking: Marking | null; max_turns?: number;
}
export interface CallRecord { call: string; tool: string; args: Json; ok: boolean }
export type AgentEnd =
  | { kind: "done"; content: string; output: Json | null; calls: CallRecord[] }
  | { kind: "invalid"; errors: string[]; calls: CallRecord[] }
  | { kind: "declined"; reason: string }
  | { kind: "blocked"; marking: Marking }
  | { kind: "error"; message: string }
  | { kind: "stopped"; why: "paused" | "budget" | "turns" };

const enc = new TextEncoder();

const SCAN_CHARS = 1024 * 1024;

/** The first of the text's JSON objects: one inside a fenced block, else the first balanced `{...}` that parses. One linear pass over at most the first MiB. */
export function extractJson(content: string): { value: Json } | null {
  const text = content.slice(0, SCAN_CHARS);
  const asObject = (s: string): { value: Json } | null => {
    const p = parseJson(s.trim());
    return p !== null && isPlainObject(p.value) ? p : null;
  };
  for (let at = text.indexOf("```"); at !== -1;) {
    const bodyStart = text.indexOf("\n", at);
    const close = bodyStart === -1 ? -1 : text.indexOf("```", bodyStart);
    if (close === -1) break;
    const got = asObject(text.slice(bodyStart + 1, close));
    if (got !== null) return got;
    at = text.indexOf("```", close + 3);
  }
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (depth > 0 && inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (depth > 0 && c === '"') inString = true;
    else if (c === "}" && depth > 0 && --depth === 0) {
      const got = asObject(text.slice(start, i + 1));
      if (got !== null) return got;
    }
  }
  return null;
}

const MAX_CALLS = 16;
const ARGS_INLINE_BYTES = 16 * 1024;
const NAME_CHARS = 200;
const WHY_CHARS = 500;
const SUMMARY_CHARS = 500;
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const count = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER)) : 0);

/**
 * One agent's conversation. Every model call and tool call is in the ledger before it happens and its outcome after.
 * Nothing but the ledger decides where a scripted provider is (the request's ordinal), so a replay cannot differ.
 * Never throws for anything a model or tool does.
 */
export async function runAgent(session: CaseSession, spec: AgentSpec): Promise<AgentEnd> {
  const { actor, provider, ctx } = spec;
  const link = { run: ctx.link.run, stage: ctx.link.stage, job: ctx.link.job };
  const messages: ChatMessage[] = [{ role: "system", content: renderPack(spec.pack) }, { role: "user", content: spec.task }];
  const calls: CallRecord[] = [];
  let marking: Marking = spec.pack.marking;
  let failures = 0;
  const maxTurns = spec.max_turns ?? MAX_TURNS;
  const put = (data: Uint8Array | string): BlobRef => session.blobs.put(data);

  for (let turn = 0; turn < maxTurns; turn++) {
    // 1. stop checks
    const run = session.state.run;
    if (run.status === "paused") return { kind: "stopped", why: "paused" };
    if (run.budget_tokens !== null) {
      const { usage } = runUsage(session.state);
      if (usage.input + usage.output >= run.budget_tokens) return { kind: "stopped", why: "budget" };
    }
    // 2. marking: the strictest of the pack and every tool result so far
    if (!mayGo(marking, provider.where, spec.policy)) {
      session.commit(() => [{ type: "model.blocked", actor, ...link, payload: { stage: actor.stage, marking, model: spec.model, where: provider.where } }]);
      return { kind: "blocked", marking };
    }
    // 3. request, written before the provider is contacted
    const ordinal = session.entries().filter((e) => e.type === "model.request" && e.actor.kind === "agent" && e.actor.id === actor.id).length;
    const req: TurnRequest = { model: spec.model, effort: spec.effort, messages: [...messages], tools: toolSpecs(spec.tools), key: actor.id, ordinal };
    const body = provider.body(req);
    const messagesBlob = put(body);
    let requestId = "";
    const [requested] = session.commit((_s, ids) => {
      requestId = ids.next("request");
      return [{
        type: "model.request", actor, ...link,
        payload: { request: requestId, provider: provider.id, model: spec.model, effort: spec.effort, where: provider.where, marking, pack: spec.pack.items, left_out: spec.pack.left_out, messages: messagesBlob, tools: [...spec.tools] },
      }];
    });
    // 4. turn
    let result: TurnResult;
    try {
      result = await provider.turn(req);
    } catch (err) {
      result = { kind: "error", message: err instanceof Error ? err.message : String(err), raw: null };
    }
    // 5. response. Past this point a refused commit never throws: a small failure entry is written instead and the loop ends.
    let responded = false;
    const failed = (message: string): AgentEnd => {
      try {
        if (responded) return { kind: "error", message: clip(message, 500) };
        const raw = put(JSON.stringify({ error: clip(message, 500) }));
        session.commit(() => [{
          type: "model.response", actor, ...link, cause: requested!.seq,
          payload: { request: requestId, response: raw, stop: "error", usage: { input: 0, output: 0, reasoning: 0 }, served_by: clip(spec.model, NAME_CHARS), reasoning: null },
        }]);
      } catch {
        // the ledger refused even that; the end still says what happened
      }
      return { kind: "error", message: clip(message, 500) };
    };
    const guarded = (build: () => EntryInput[]): boolean => {
      try {
        session.commit(build);
        return true;
      } catch {
        return false;
      }
    };
    if (result.kind === "declined") {
      const reason = result.reason.slice(0, DECLINE_CHARS);
      if (!guarded(() => [{ type: "model.declined", actor, ...link, cause: requested!.seq, payload: { request: requestId, reason } }])) return failed("the ledger refused the declined entry");
      return { kind: "declined", reason };
    }
    if (result.kind === "error") {
      const message = clip(result.message, 500);
      const raw = put(result.raw ?? JSON.stringify({ error: message }));
      const wrote = guarded(() => [{
        type: "model.response", actor, ...link, cause: requested!.seq,
        payload: { request: requestId, response: raw, stop: "error", usage: { input: 0, output: 0, reasoning: 0 }, served_by: clip(spec.model, NAME_CHARS), reasoning: null },
      }]);
      return wrote ? { kind: "error", message } : failed(message);
    }
    const response = put(result.raw);
    const reasoning = result.reasoning === null ? null : put(result.reasoning);
    const usage = { input: count(result.usage?.input), output: count(result.usage?.output), reasoning: count(result.usage?.reasoning) };
    const stop = result.stop === "tool_calls" || result.stop === "length" ? result.stop : "end";
    if (!guarded(() => [{
      type: "model.response", actor, ...link, cause: requested!.seq,
      payload: { request: requestId, response, stop, usage, served_by: clip(String(result.served_by), NAME_CHARS), reasoning },
    }])) return failed("the ledger refused the model response");

    // 6. the tool calls that are present decide, not the finish label
    if (result.tool_calls.length > 0) {
      const results: ChatMessage[] = [];
      for (const [i, tc] of result.tool_calls.entries()) {
        if (i > 0 && session.state.run.status === "paused") return { kind: "stopped", why: "paused" };
        const name = clip(String(tc.name), NAME_CHARS);
        const parsed = parseCall(spec.tools, name, tc.arguments);
        const why = clip(parsed.why, WHY_CHARS);
        let args: Json = parsed.args;
        if (Buffer.byteLength(JSON.stringify(parsed.args), "utf8") > ARGS_INLINE_BYTES) args = put(JSON.stringify(parsed.args)) as unknown as Json;
        let callId = "";
        let called: { seq: number } | undefined;
        try {
          [called] = session.commit((_s, ids) => {
            callId = ids.next("call");
            return [{ type: "tool.called", actor, ...link, cause: requested!.seq, payload: { request: requestId, call: callId, tool: name, args, why } }];
          });
        } catch {
          return failed("the ledger refused the tool call");
        }
        let okOut: boolean;
        let summary: string;
        let forModel: string;
        let resultBlob: BlobRef | null = null;
        if (i >= MAX_CALLS) {
          okOut = false;
          summary = "too many tool calls in one reply";
          forModel = JSON.stringify({ ok: false, summary });
        } else {
          const out = await execTool(ctx, parsed);
          const full = viewText(out);
          forModel = full;
          if (tooStrict(out.marking, spec.max_marking)) {
            forModel = JSON.stringify({ ok: false, summary: `withheld: marked ${out.marking}, which this model may not receive` });
          } else if (out.marking !== null) {
            marking = strictest(marking, out.marking);
          }
          okOut = out.ok;
          summary = clip(out.summary, SUMMARY_CHARS);
          resultBlob = put(full);
        }
        const blob = resultBlob;
        const sealed = guarded(() => [{ type: "tool.returned", actor, ...link, cause: called!.seq, payload: { call: callId, ok: okOut, summary, result: blob } }]);
        if (!sealed) {
          guarded(() => [{ type: "tool.returned", actor, ...link, cause: called!.seq, payload: { call: callId, ok: false, summary: "the ledger refused this result", result: null } }]);
          return failed("the ledger refused a tool result");
        }
        calls.push({ call: callId, tool: name, args: parsed.args, ok: okOut });
        results.push({ role: "tool", content: forModel, tool_call_id: tc.id });
      }
      messages.push({ role: "assistant", content: result.content, tool_calls: result.tool_calls }, ...results);
      continue;
    }

    // 7. the answer
    if (spec.schema === null) return { kind: "done", content: result.content, output: null, calls };
    let errors: string[];
    if (result.stop === "length") {
      errors = ["the reply was cut off"];
    } else {
      const found = extractJson(result.content);
      if (found === null) errors = ["the reply holds no JSON object"];
      else {
        errors = validate(spec.schema, found.value).map((e) => `${e.path.replace(/^\$\.?/, "") || "output"} ${e.message}`);
        if (errors.length === 0) return { kind: "done", content: result.content, output: found.value, calls };
      }
    }
    if (++failures >= 2) return { kind: "invalid", errors, calls };
    messages.push(
      { role: "assistant", content: result.content },
      { role: "user", content: `Your reply did not match the required output: ${errors.join("; ")}. Reply again with the corrected JSON only.` },
    );
  }
  return { kind: "stopped", why: "turns" };
}
