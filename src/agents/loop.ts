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
import type { ChatMessage, Provider, Sampling, TurnRequest, TurnResult } from "./providers/types";
import type { RequestExtra } from "./providers/extra";
import { execTool, parseCall, toolSpecs, viewText } from "./tools";
import type { ToolContext, ToolName } from "./tools";

export const MAX_TURNS = 16;
/** The re-ask for a reply that came back empty while the model wrote its answer into its reasoning. */
export const EMPTY_REASK = "Your reply was empty; your answer went into your reasoning. Put the JSON answer in the reply itself.";
const DECLINE_CHARS = 2000;

/** The line each request's task text ends with: which turn this is, and near the end what is left to do. */
export function turnLine(turn: number, of: number, missing: readonly string[] = []): string {
  const said = `Turn ${turn} of ${of}.`;
  const lacks = missing.length === 0 ? "" : ` The draft still has no ${missing.join(", ")}.`;
  if (turn >= of) return `${said} This is the last turn: give your final answer now; no tool will be run.${lacks}`;
  if (turn === of - 1) return `${said} Two turns left: finish your proposals and give your final answer next turn.${lacks}`;
  return said;
}

export interface AgentSpec {
  actor: Extract<Actor, { kind: "agent" }>; provider: Provider; model: string; effort: string | null;
  pack: Pack; task: string; tools: readonly ToolName[]; ctx: ToolContext; schema: Schema | null;
  /** The output schema's id: the name a structured-output request gives it ("output" when absent). */
  schema_id?: string;
  /** This agent's own sampling and output limit (the stage's): each wins over the model's. */
  sampling?: Sampling; max_output_tokens?: number;
  /** This agent's own extra chat-body fields (the stage's request_extra): each wins over the model's, key by key. */
  request_extra?: RequestExtra;
  policy: Record<Marking, Where[]>; max_marking: Marking | null; max_turns?: number;
  /** True for an agent that works beside the run (the conversational one): the run being paused, finished or out of budget does not stop it. The marking check and every entry written are the same. */
  outside_run?: boolean;
  /** What the stage knows of an answer that failed its schema: sentences added to the re-ask (and to the errors) for that answer. */
  explain?: (answer: Json) => string[];
  /** What the work still lacks, by name (read at each request): an answer that fits its schema is re-asked, with the one re-ask, while this is not empty; the last two turns' notes name it. */
  lacking?: () => string[];
  /** The re-ask for an answer given while `lacking` names something. */
  lackingAsk?: (missing: string[]) => string;
  /** The seq of the entry this work answers (a question): put on the agent's own request and block entries, so a reader links them to it by cause rather than by position. */
  cause?: number;
  /** An optional fast model that takes the tool-choosing turns only; the stage's model writes the answer. Absent: the stage's model takes every turn. */
  fast?: { provider: Provider; model: string; effort: string | null };
}
export interface CallRecord { call: string; tool: string; args: Json; ok: boolean }
export type AgentEnd =
  | { kind: "done"; content: string; output: Json | null; calls: CallRecord[] }
  /** `returned`: what the last reply was, in a word ("the model returned the schema itself"), so a model's mistake reads apart from a bug. */
  | { kind: "invalid"; errors: string[]; returned: string; calls: CallRecord[] }
  | { kind: "declined"; reason: string }
  | { kind: "blocked"; marking: Marking }
  | { kind: "error"; message: string; retried?: true; cause?: "context" }
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

/** What a reply cut off at the output limit did, in plain words. */
const ranPast = (limit: number | undefined): string => (limit === undefined
  ? "the model ran past its output limit" : `the model ran past ${limit} output tokens`);

/** A failed call that is made once more for the same turn: no answer in time, the endpoint not reached, or the output limit reached. */
type Attempt = { kind: "timeout"; ms: number } | { kind: "transport"; message: string } | { kind: "length" };
const seconds = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);
const subject = (a: Attempt): string => (a.kind === "transport" ? "the model endpoint" : "the model");
const verb = (a: Attempt, limit: number | undefined): string => (a.kind === "timeout" ? `did not answer within ${seconds(a.ms)}`
  : a.kind === "transport" ? "could not be reached" : ranPast(limit).slice("the model ".length));
/** What two failed calls for one turn did, in plain words: "the model did not answer within 300 s twice". */
function twice(first: Attempt, second: Attempt, limit: number | undefined): string {
  const same = first.kind === second.kind;
  const said = same ? `${subject(first)} ${verb(first, limit)} twice` : `${subject(first)} ${verb(first, limit)}, then ${verb(second, limit)}`;
  return second.kind === "transport" ? `${said} (${second.message})` : said;
}

/** A reply that is a schema rather than an instance of one: a schema manifest (kind: schema), or a JSON Schema object body. */
function isSchemaCopy(value: Json, schema: Schema): boolean {
  if (!isPlainObject(value)) return false;
  if (value.kind === "schema") return true;
  const own = schema.properties ?? {};
  return value.type === "object" && isPlainObject(value.properties) && !Object.hasOwn(own, "type") && !Object.hasOwn(own, "properties");
}

/** What a reply that failed its schema held, in a word. */
function returnedWord(empty: boolean, found: { value: Json } | null, schema: Schema): string {
  if (empty) return "the model returned nothing";
  if (found === null) return "the model returned no JSON object";
  return isSchemaCopy(found.value, schema) ? "the model returned the schema itself" : "the model returned an object that does not match its schema";
}

/**
 * One agent's conversation. Every model call and tool call is in the ledger before it happens and its outcome after.
 * Nothing but the ledger decides where a scripted provider is (the request's ordinal), so a replay cannot differ.
 * Never throws for anything a model or tool does.
 */
export async function runAgent(session: CaseSession, spec: AgentSpec): Promise<AgentEnd> {
  const { actor, provider, ctx } = spec;
  const link = { run: ctx.link.run, stage: ctx.link.stage, job: ctx.link.job };
  const because = spec.cause === undefined ? {} : { cause: spec.cause };
  const messages: ChatMessage[] = [{ role: "system", content: renderPack(spec.pack) }, { role: "user", content: spec.task }];
  const calls: CallRecord[] = [];
  let marking: Marking = spec.pack.marking;
  let failures = 0;
  // set once the agent has been re-asked for its answer: from then on a provider that can is asked for output matching the schema
  let reasked = false;
  // set when a routing turn's reply held no tool call: from then on the stage's model takes every turn, with no tool on offer
  let answerNow = false;
  // the failed attempt of this turn that is being made once more, and the seq of its response, which causes the new request
  let failedOnce: Attempt | null = null;
  let retryCause: number | null = null;
  const maxTurns = spec.max_turns ?? MAX_TURNS;
  const put = (data: Uint8Array | string): BlobRef => session.blobs.put(data);

  for (let turn = 0; turn < maxTurns; turn++) {
    // 1. stop checks
    const run = session.state.run;
    if (!spec.outside_run && (run.status === "paused" || run.status === "finished")) return { kind: "stopped", why: "paused" };
    if (!spec.outside_run && run.budget_tokens !== null) {
      const { usage } = runUsage(session.state);
      if (usage.input + usage.output >= run.budget_tokens) return { kind: "stopped", why: "budget" };
    }
    // a routing turn goes to the fast model: not the last turn, not a re-ask, tools on offer, and not "answer now"
    const last = turn === maxTurns - 1;
    const routing = spec.fast !== undefined && !last && !reasked && !answerNow && spec.tools.length > 0;
    const via = routing ? spec.fast!.provider : provider;
    const viaModel = routing ? spec.fast!.model : spec.model;
    const viaEffort = routing ? spec.fast!.effort : spec.effort;
    // what the entries of this turn's request and response say the agent was
    const who: typeof actor = routing ? { ...actor, model: viaModel, effort: viaEffort, where: via.where } : actor;
    const limit = spec.max_output_tokens ?? via.max_output_tokens;
    // 2. marking: the strictest of the pack and every tool result so far. A fixed part over the stage's limit (what must be fixed, say) is
    // never left out, so the call is not made instead.
    if (!mayGo(marking, via.where, spec.policy) || tooStrict(marking, spec.max_marking)) {
      session.commit(() => [{ type: "model.blocked", actor: who, ...link, ...because, payload: { stage: actor.stage, marking, model: viaModel, where: via.where } }]);
      return { kind: "blocked", marking };
    }
    // 3. request, written before the provider is contacted
    // a scripted provider is placed by how many requests this agent has made to it, so each of two models counts its own
    const ordinal = session.entries().filter((e) => e.type === "model.request" && e.actor.kind === "agent" && e.actor.id === actor.id
      && e.payload.provider === via.id && e.payload.model === viaModel).length;
    // the task text says which turn this is; on the last the reply can only be the answer: no tool is offered to run, and output is structured
    const sent = messages.map((m, i) => (i === 1 ? { ...m, content: `${spec.task}\n\n${turnLine(turn + 1, maxTurns, spec.lacking?.() ?? [])}` } : m));
    const req: TurnRequest = { model: viaModel, effort: viaEffort, messages: sent, tools: toolSpecs(spec.tools, ctx), key: actor.id, ordinal };
    if (spec.sampling !== undefined) req.sampling = spec.sampling;
    if (spec.max_output_tokens !== undefined) req.max_output_tokens = spec.max_output_tokens;
    if (spec.request_extra !== undefined) req.request_extra = spec.request_extra;
    if (last || answerNow) req.tool_choice = "none";
    if ((reasked || last || answerNow) && spec.schema !== null && via.structured_output === true) req.response_format = { name: spec.schema_id ?? "output", schema: spec.schema };
    const body = via.body(req);
    const messagesBlob = put(body);
    let requestId = "";
    const [requested] = session.commit((_s, ids) => {
      requestId = ids.next("request");
      return [{
        type: "model.request", actor: who, ...link, ...(retryCause === null ? because : { cause: retryCause }),
        payload: { request: requestId, provider: via.id, model: viaModel, effort: viaEffort, where: via.where, marking, pack: spec.pack.items, left_out: spec.pack.left_out, messages: messagesBlob, tools: [...spec.tools] },
      }];
    });
    // 4. turn
    let result: TurnResult;
    try {
      result = await via.turn(req);
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
          type: "model.response", actor: who, ...link, cause: requested!.seq,
          payload: { request: requestId, response: raw, stop: "error", usage: { input: 0, output: 0, reasoning: 0 }, served_by: clip(viaModel, NAME_CHARS), reasoning: null },
        }]);
      } catch {
        // the ledger refused even that; the end still says what happened
      }
      return { kind: "error", message: clip(message, 500) };
    };
    const guarded = (build: () => EntryInput[], wrote?: (firstSeq: number) => void): boolean => {
      try {
        const out = session.commit(build);
        if (out.length > 0) wrote?.(out[0]!.seq);
        return true;
      } catch {
        return false;
      }
    };
    if (result.kind === "declined") {
      const reason = result.reason.slice(0, DECLINE_CHARS);
      if (!guarded(() => [{ type: "model.declined", actor: who, ...link, cause: requested!.seq, payload: { request: requestId, reason } }])) return failed("the ledger refused the declined entry");
      return { kind: "declined", reason };
    }
    retryCause = null;
    /** A failed attempt: made once more for the same turn (the stop checks come first), else the end, saying what happened twice. */
    const again = (attempt: Attempt, responseSeq: number, message: string): AgentEnd | null => {
      if (failedOnce !== null) return { kind: "error", message: clip(twice(failedOnce, attempt, limit), 500), retried: true };
      if (spec.outside_run) return { kind: "error", message };
      failedOnce = attempt;
      retryCause = responseSeq;
      return null;
    };
    if (result.kind === "error") {
      const message = clip(result.message, 500);
      const raw = put(result.raw ?? JSON.stringify({ error: message }));
      let seq = -1;
      const wrote = guarded(() => [{
        type: "model.response", actor: who, ...link, cause: requested!.seq,
        payload: { request: requestId, response: raw, stop: "error", usage: { input: 0, output: 0, reasoning: 0 }, served_by: clip(viaModel, NAME_CHARS), reasoning: null },
      }], (s) => { seq = s; });
      if (!wrote) return failed(message);
      const t = result.transient;
      if (t === undefined) return { kind: "error", message, ...(result.cause === undefined ? {} : { cause: result.cause }) };
      const end = again(t.kind === "timeout" ? t : { kind: "transport", message }, seq, message);
      if (end !== null) return end;
      turn--;
      continue;
    }
    const response = put(result.raw);
    const reasoning = result.reasoning === null ? null : put(result.reasoning);
    const usage = { input: count(result.usage?.input), output: count(result.usage?.output), reasoning: count(result.usage?.reasoning) };
    const stop = result.stop === "tool_calls" || result.stop === "length" ? result.stop : "end";
    // at most MAX_CALLS of a reply's tool calls run; the rest are one entry beside the response, not an entry each
    // an agent with no tools runs none: every call in its reply is skipped; nor does a reply cut off at the output limit, whose calls may be cut too
    const cut = result.stop === "length";
    const noTools = spec.outside_run === true && spec.tools.length === 0;
    const toRun = noTools || cut || last ? [] : result.tool_calls.slice(0, MAX_CALLS);
    const extra = result.tool_calls.length - toRun.length;
    const skippedNote = cut ? `${extra} tool calls were not run: the reply was cut off at the output limit`
      : noTools ? `${extra} tool calls were not run: this agent has no tools`
      : last ? `${extra} tool calls were not run: this was the last turn` : `${extra} further tool calls were not run`;
    let responseSeq = -1;
    if (!guarded(() => [
      {
        type: "model.response", actor: who, ...link, cause: requested!.seq,
        payload: { request: requestId, response, stop, usage, served_by: clip(String(result.served_by), NAME_CHARS), reasoning },
      },
      ...(extra > 0 ? [{ type: "tool.skipped" as const, actor: who, ...link, cause: requested!.seq, payload: { request: requestId, count: extra, note: skippedNote } }] : []),
    ], (s) => { responseSeq = s; })) return failed("the ledger refused the model response");
    responded = true;

    // a reply cut off at the output limit is a failed attempt: neither its text nor its calls are used
    if (cut) {
      const end = again({ kind: "length" }, responseSeq, ranPast(limit));
      if (end !== null) return end;
      turn--;
      continue;
    }
    failedOnce = null;

    // a routing turn that called no tool is not the answer: whatever it said is not used, and the stage's model is asked to answer now
    if (routing && toRun.length === 0) {
      answerNow = true;
      continue;
    }
    // 6. the tool calls that are present decide, not the finish label
    if (toRun.length > 0) {
      const results: ChatMessage[] = [];
      for (const tc of toRun) {
        // checked before every call, the first included: a reply that arrives after a stop runs nothing
        if (!spec.outside_run && (session.state.run.status === "paused" || session.state.run.status === "finished")) return { kind: "stopped", why: "paused" };
        const name = clip(String(tc.name), NAME_CHARS);
        const parsed = parseCall(spec.tools, name, tc.arguments, ctx);
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
        const blob: BlobRef = put(full);
        const sealed = guarded(() => [{ type: "tool.returned", actor, ...link, cause: called!.seq, payload: { call: callId, ok: okOut, summary, result: blob } }]);
        if (!sealed) {
          guarded(() => [{ type: "tool.returned", actor, ...link, cause: called!.seq, payload: { call: callId, ok: false, summary: "the ledger refused this result", result: null } }]);
          return failed("the ledger refused a tool result");
        }
        calls.push({ call: callId, tool: name, args: parsed.args, ok: okOut });
        results.push({ role: "tool", content: forModel, tool_call_id: tc.id });
      }
      // the next request carries only the calls that ran, so it does not grow with a reply's excess
      messages.push({ role: "assistant", content: result.content, tool_calls: toRun }, ...results);
      if (extra > 0) messages.push({ role: "user", content: `${skippedNote}: at most ${MAX_CALLS} tool calls of a reply are run. Call again for what you still need.` });
      continue;
    }

    // 7. the answer. A last reply that only called tools holds none.
    if (last && result.tool_calls.length > 0 && result.content.trim() === "") return { kind: "stopped", why: "turns" };
    if (spec.schema === null) return { kind: "done", content: result.content, output: null, calls };
    let errors: string[];
    // an empty reply (a thinking model may write its whole answer into its reasoning) is re-asked as such; it uses the one re-ask
    const empty = result.content.trim() === "";
    const found = empty ? null : extractJson(result.content);
    if (empty) errors = ["the reply is empty"];
    else if (found === null) errors = ["the reply holds no JSON object"];
    else {
      errors = validate(spec.schema, found.value).map((e) => `${e.path.replace(/^\$\.?/, "") || "output"} ${e.message}`);
      if (errors.length === 0) {
        const missing = spec.lacking?.() ?? [];
        if (missing.length === 0) return { kind: "done", content: result.content, output: found.value, calls };
        // a complete-looking answer over an unfinished draft: it uses the one re-ask, and the work goes on with its tools
        if (++failures >= 2) return { kind: "invalid", errors: [`the draft still has no ${missing.join(", ")}`], returned: "an answer over an unfinished draft", calls };
        reasked = true;
        messages.push({ role: "assistant", content: result.content }, { role: "user", content: spec.lackingAsk?.(missing) ?? `The draft still has no ${missing.join(", ")}; finish it, then answer` });
        continue;
      }
      if (spec.explain !== undefined) errors.push(...spec.explain(found.value));
    }
    if (++failures >= 2) return { kind: "invalid", errors, returned: returnedWord(empty, found, spec.schema), calls };
    reasked = true;
    messages.push(
      { role: "assistant", content: result.content },
      { role: "user", content: empty ? EMPTY_REASK : `Your reply did not match the required output: ${errors.join("; ")}. Reply again with the corrected JSON only.` },
    );
  }
  return { kind: "stopped", why: "turns" };
}
