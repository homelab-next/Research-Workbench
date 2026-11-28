import type { Json } from "../../core/canonical";
import { canonical } from "../../core/canonical";
import type { Schema } from "../../core/schema";
import type { CaseSession } from "../../core/session";
import type { CaseState } from "../../core/state";
import { plannedProbes, readProbeOutput, readTaskInputs, stagedCandidates } from "../../core/state/improve";
import type { Contrast, ProbeOutput } from "../../core/state/improve";
import type { Actor, Finding } from "../../core/types";
import { ContextError, packPart } from "../../agents/context";
import type { PackPart } from "../../agents/context";
import { scrub } from "../../agents/tools/kit";
import type { StageEnd, StageEnv, StageRunner } from "../engine";
import { cleanText } from "../person";
import { agentActor, noSchema, stageAgent, titleOf } from "../stages/agent";

/** The most characters of Compose's reason the record keeps. */
export const WHY_MAX = 2000;

const ENGINE: Actor = { kind: "system", id: "engine" };
const BASE = "base";
const NONE = "none";

/** Two findings are the same when their statements are, lower-cased and trimmed. */
const keyOf = (statement: string): string => statement.trim().toLowerCase();
const findingsOf = (o: ProbeOutput): Finding[] => o.product?.key_findings ?? [];

/**
 * For each task and each staged candidate, what its output has that the base's has not: pure, from the outputs alone (keyed by probe id).
 * Tasks are taken in the state's order and candidates in theirs, so the result does not depend on the order of the outputs. A pair with an
 * output missing has no contrast.
 */
export function contrastsOf(state: Readonly<CaseState>, outputs: Record<string, ProbeOutput>): Contrast[] {
  const out: Contrast[] = [];
  for (const task of state.improve.task_order) {
    const base = Object.hasOwn(outputs, `${BASE}/${task}`) ? outputs[`${BASE}/${task}`]! : null;
    if (base === null) continue;
    const before = new Map<string, Finding>();
    for (const f of findingsOf(base)) if (!before.has(keyOf(f.statement))) before.set(keyOf(f.statement), f);
    for (const { candidate } of stagedCandidates(state)) {
      const now = Object.hasOwn(outputs, `${candidate}/${task}`) ? outputs[`${candidate}/${task}`]! : null;
      if (now === null) continue;
      const after = new Map<string, Finding>();
      for (const f of findingsOf(now)) if (!after.has(keyOf(f.statement))) after.set(keyOf(f.statement), f);
      const added = [...after].filter(([k]) => !before.has(k)).map(([, f]) => f.statement.trim());
      const removed = [...before].filter(([k]) => !after.has(k)).map(([, f]) => f.statement.trim());
      const changed: Contrast["changed"] = [];
      for (const [k, f] of after) {
        const was = before.get(k);
        if (was === undefined || (was.likelihood === f.likelihood && was.confidence === f.confidence)) continue;
        changed.push({
          statement: f.statement.trim(),
          likelihood: was.likelihood === f.likelihood ? null : [was.likelihood, f.likelihood],
          confidence: was.confidence === f.confidence ? null : [was.confidence, f.confidence],
        });
      }
      out.push({
        task, candidate, base: base.outcome, now: now.outcome, added, removed, changed,
        lookups: [base.stats.lookups, now.stats.lookups], tokens: [base.stats.tokens, now.stats.tokens],
      });
    }
  }
  return out;
}

const quoted = (list: readonly string[]): string => list.map((s) => `"${s}"`).join("; ");

/** A contrast in words. */
function contrastText(c: Contrast): string {
  const lines = [
    `Task ${c.task}, ${c.candidate} against base: base ${c.base === "drafted" ? "gave a draft" : "gave no draft"}; ${c.candidate} ${c.now === "drafted" ? "gave a draft" : "gave no draft"}.`,
    c.added.length === 0 ? `${c.candidate} added no finding.` : `${c.candidate} added: ${quoted(c.added)}.`,
    c.removed.length === 0 ? `${c.candidate} dropped no finding.` : `${c.candidate} dropped: ${quoted(c.removed)}.`,
  ];
  for (const x of c.changed) {
    const how = [
      ...(x.likelihood === null ? [] : [`likelihood ${x.likelihood[0]} to ${x.likelihood[1]}`]),
      ...(x.confidence === null ? [] : [`confidence ${x.confidence[0]} to ${x.confidence[1]}`]),
    ];
    lines.push(`${c.candidate} changed "${x.statement}": ${how.join(", ")}.`);
  }
  lines.push(`Lookups: base ${c.lookups[0]}, ${c.candidate} ${c.lookups[1]}. Tokens: base ${c.tokens[0]}, ${c.candidate} ${c.tokens[1]}.`);
  return lines.join("\n");
}

/** What a probe's output holds, in words: the outcome and reason, each finding, the narrative sections and the stats. */
function outputText(id: string, o: ProbeOutput): string {
  const lines = [`Probe ${id}${id.startsWith(`${BASE}/`) ? " (the unchanged loop)" : ""}`, `Outcome: ${o.outcome}`];
  if (o.reason !== "") lines.push(`Reason: ${o.reason}`);
  const p = o.product;
  if (p !== null) {
    lines.push(`Summary: ${p.summary}`, "Findings:");
    for (const f of p.key_findings) lines.push(`- ${f.statement} (likelihood ${f.likelihood}, confidence ${f.confidence})`);
    lines.push(`Assessment: ${p.assessment}`, `Gaps and limits: ${p.gaps_and_limits}`);
  }
  if (o.asked !== undefined) lines.push("Asked the person:", ...o.asked.map((q) => `- ${q}`));
  const st = o.stats;
  lines.push(`Stats: ${st.lookups} lookups, ${st.tokens} tokens, ${st.model_calls} model calls; stages: ${st.stages.map((x) => `${x.id} ${x.status} (${x.attempts})`).join(", ")}`);
  return lines.join("\n");
}

/**
 * What Compose's model is given: per task its question; per probe its output; the contrasts in words. Every part is marked the improve case's
 * marking. Nothing here reads a task case, an answer or a score.
 */
export function composeParts(session: CaseSession, outputs: Record<string, ProbeOutput>, contrasts: readonly Contrast[]): PackPart[] {
  const state = session.state;
  const floor = state.meta!.marking;
  const entries = session.entries();
  const part = (kind: string, id: string, title: string, text: string): PackPart => packPart({ kind, id, title, text, fixed: true, entries, written_by: [], floor });
  const parts: PackPart[] = [];
  for (const task of state.improve.task_order) {
    if (!Object.hasOwn(state.improve.tasks, task)) continue;
    const ref = state.improve.tasks[task]!.inputs;
    let inputs: ReturnType<typeof readTaskInputs> = null;
    try {
      inputs = readTaskInputs(session.blobs.get(ref.blob));
    } catch {
      inputs = null;
    }
    if (inputs === null) throw new ContextError(`the question of task ${task} cannot be read`);
    parts.push(part("task", `task-${task}`, `Task ${task}`, `Task ${task}: ${inputs.title}\nQuestion: ${inputs.question}`));
  }
  for (const p of plannedProbes(state)) {
    if (Object.hasOwn(outputs, p.probe)) parts.push(part("probe", p.probe, `Probe ${p.probe}`, outputText(p.probe, outputs[p.probe]!)));
  }
  parts.push(part("contrasts", "contrasts", "Contrasts", contrasts.length === 0 ? "No candidate differs from the base." : contrasts.map(contrastText).join("\n\n")));
  return parts;
}

const TASK = "For each task you are given what the unchanged loop produced and what each candidate produced. Pick the one candidate the differences support across the tasks, or none. Say why from the differences. You are not told which answer is right.";

/** The output schema with `choice` held to the staged candidates' ids and none; a schema without `choice` is unchanged. */
function narrowChoice(schema: Schema, ids: readonly string[]): Schema {
  const choice = schema.properties?.choice;
  if (choice === undefined) return schema;
  return { ...schema, properties: { ...schema.properties, choice: { ...choice, enum: [...ids, NONE] } } };
}

const clipWhy = (why: string): string => (why.length > WHY_MAX ? `${why.slice(0, WHY_MAX - 1)}…` : why);

/**
 * The Compose stage of an improve loop: reads every probe's output from the improve case's blobs, works out the contrasts, and records the
 * choice before any later stage runs. With no staged candidate the engine records none and no model is called.
 */
export const composeRunner: StageRunner = async (env: StageEnv): Promise<StageEnd> => {
  const { session, deps, stage } = env;
  const state = session.state;
  const chosen = state.improve.chosen;
  if (chosen !== null) {
    return { kind: "finished", outcome: "pass", draft_hash: null, output: { choice: chosen.candidate ?? NONE, why: chosen.why }, reason: null };
  }
  if (state.improve.selected === null) return { kind: "stalled", reason: "Compose: Select has not recorded this run's tasks" };
  const planned = plannedProbes(state);
  const open = planned.filter((p) => !Object.hasOwn(state.improve.probes, p.probe) || state.improve.probes[p.probe]!.finished === null).map((p) => p.probe);
  if (open.length > 0) return { kind: "stalled", reason: `Compose: these probes have not finished: ${open.join(", ")}` };
  const outputs: Record<string, ProbeOutput> = {};
  for (const p of planned) {
    const ref = state.improve.probes[p.probe]!.finished!.output;
    let output: ProbeOutput | null = null;
    try {
      output = readProbeOutput(session.blobs.get(ref.blob));
    } catch {
      output = null;
    }
    if (output === null) return { kind: "stalled", reason: `Compose: the output of probe ${p.probe} cannot be read` };
    outputs[p.probe] = output;
  }
  const contrasts = contrastsOf(state, outputs);
  const staged = stagedCandidates(state).map((c) => c.candidate);
  const run = state.run.id;
  const open_ = (s: Readonly<CaseState>): boolean => s.run.id === run && s.run.status !== "finished" && s.improve.chosen === null;
  const record = (actor: Actor, candidate: string | null, why: string): Extract<StageEnd, { kind: "finished" | "stopped" }> => {
    const contrastsRef = session.blobs.put(canonical(contrasts as unknown as Json));
    const written = session.commit((s) => (open_(s)
      ? [{ type: "compose.chosen", actor, run: s.run.id, stage: stage.id, payload: { candidate, why, contrasts: contrastsRef } }] : []));
    if (written.length === 0) return { kind: "stopped" };
    return { kind: "finished", outcome: "pass", draft_hash: null, output: { choice: candidate ?? NONE, why }, reason: null };
  };
  if (staged.length === 0) return record(ENGINE, null, "no candidate was staged");

  const stalled = noSchema(env);
  if (stalled !== null) return stalled;
  const clean = (text: string): string => cleanText(deps.runner, scrub(deps.registry, text));
  let extras: PackPart[];
  try {
    extras = composeParts(session, outputs, contrasts).map((p) => ({ ...p, title: clean(p.title), text: clean(p.text) }));
  } catch (err) {
    if (err instanceof ContextError) return { kind: "stalled", reason: `${titleOf(env)}: ${err.message}` };
    throw err;
  }
  const actorId = deps.profile.stages[stage.id]?.agent ?? "composer";
  const end = await stageAgent(env, {
    actor_id: actorId, task: TASK, extras, narrow: (s) => narrowChoice(s, staged),
    explain: () => [`choice must be one of ${[...staged, NONE].join(", ")}`],
  });
  if (end.kind !== "output") return end;
  const { choice, why } = end.output as { choice?: unknown; why?: unknown };
  if (typeof choice !== "string" || ![...staged, NONE].includes(choice) || typeof why !== "string") {
    return { kind: "stalled", reason: `${titleOf(env)}: its output does not name a staged candidate or none` };
  }
  return record(agentActor(session, actorId), choice === NONE ? null : choice, clipWhy(clean(why)));
};
