// The Judge stage of an improve loop (slice 14): it runs after Compose has committed its choice, reads each task's known answer at the entry Select
// named (the one place in a run an answer's text or claim is read), scores every probe's output in code, and records the scores nothing earlier
// could read. A model, when the stage runs one, only names which produced finding states a claim code left unmatched, or whether a product agrees
// with an answer that has no expected finding; it never gives a number. A model that fails leaves the scores as code made them.
import type { Json } from "../../core/canonical";
import { canonical, isPlainObject } from "../../core/canonical";
import type { CaseSession } from "../../core/session";
import type { CaseState } from "../../core/state";
import { BASE, plannedProbes, readProbeOutput, stagedCandidates } from "../../core/state/improve";
import type { AnswerCopy, OutputScore, ProbeOutput } from "../../core/state/improve";
import { matchClaims, scoreOutput, scoreSheet } from "../../core/score";
import type { ModelMatch } from "../../core/score";
import type { Actor, EntryInput, Marking } from "../../core/types";
import { strictest } from "../../core/types";
import type { PackPart } from "../../agents/context";
import { scrub } from "../../agents/tools/kit";
import type { StageEnd, StageEnv, StageRunner } from "../engine";
import type { ImproveHost } from "./host";
import { knownAnswerOf, withdrawnSince } from "./answers";
import { stageAgent } from "../stages/agent";

const ENGINE: Actor = { kind: "system", id: "engine" };
const AFTER_CHOICE = "the judge runs after Compose has chosen";
const VERDICTS = ["agrees", "partly", "disagrees"] as const;
type Verdict = (typeof VERDICTS)[number];
/** What a model is asked of one probe: the expected findings code left unmatched, the produced findings no expected one took, and whether it gives a verdict on the answer's text. */
interface Asked { expected: number[]; free: string[]; text: boolean }

/** Why a task's outputs are unscored: its answer was withdrawn once Select had named it. */
export const withdrawnReason = (task: string, caseId: string): string => `the known answer of task ${task} (${caseId}) was withdrawn after Select; its outputs are unscored`;

/**
 * The answers Select named, read from their tasks' ledgers by seq and hash; the sentence when one cannot be read. A task whose answer the person
 * withdrew since is left out (its outputs are unscored and its answer is not copied); its reason is added to `withdrawn`.
 */
export function answersOf(state: Readonly<CaseState>, host: Pick<ImproveHost, "task">, withdrawn: string[] = []): AnswerCopy[] | string {
  const out: AnswerCopy[] = [];
  for (const task of state.improve.task_order) {
    const t = state.improve.tasks[task];
    if (t === undefined) continue;
    const view = host.task({ case: t.case, origin: t.origin });
    if (view === null) return `task ${t.case} is not loaded; load it from the store so its known answer can be read`;
    if (withdrawnSince(view.entries(), t.answer, t.product.n)) { withdrawn.push(withdrawnReason(task, t.case)); continue; }
    const known = knownAnswerOf(view.entries(), t.answer);
    if (known === null) return `the known answer Select named is not in ${t.case}'s ledger`;
    out.push({ task, seq: t.answer.seq, hash: t.answer.hash, text: known.text, findings: known.findings, marking: known.marking });
  }
  return out;
}

/**
 * What code left for a model in one drafted output: an unmatched expected finding while a produced finding is free to take it, or, for an answer
 * with no expected finding, the answer's text. Null when nothing is left, and for an output that is not drafted (it scores 0).
 */
function askedOf(answer: AnswerCopy, output: ProbeOutput): Asked | null {
  if (output.outcome !== "drafted" || output.product === null) return null;
  const produced = output.product.key_findings;
  if (answer.findings.length === 0) return { expected: [], free: produced.map((f) => f.id), text: true };
  const rows = matchClaims(answer.findings, produced);
  const expected = rows.filter((r) => r.produced === null).map((r) => r.expected);
  const taken = new Set(rows.map((r) => r.produced));
  const free = produced.map((f) => f.id).filter((id) => !taken.has(id));
  return expected.length === 0 || free.length === 0 ? null : { expected, free, text: false };
}

/** The output a probe gave, from its blob of the improve case; the sentence when it cannot be read. */
function outputOfProbe(session: CaseSession, probe: string): ProbeOutput | string {
  const done = session.state.improve.probes[probe]?.finished;
  if (done === undefined || done === null) return `the probe ${probe} has not finished`;
  if (!session.blobs.has(done.output.blob)) return `the output of the probe ${probe} is not in this case`;
  return readProbeOutput(session.blobs.get(done.output.blob)) ?? `the output of the probe ${probe} cannot be read`;
}

/**
 * What the matcher model is asked: per output (keyed by probe id) with something left, the expected claims code left unmatched, by number, and the
 * output's findings no expected claim took, by id; and, for an answer with no expected finding, the answer's text and the output's findings.
 */
export function matcherParts(session: CaseSession, answers: readonly AnswerCopy[], outputs: Record<string, ProbeOutput>): PackPart[] {
  const parts: PackPart[] = [];
  const floor: Marking = session.state.meta?.marking ?? strictest(null);
  for (const [probe, output] of Object.entries(outputs)) {
    const task = probe.slice(probe.indexOf("/") + 1);
    const answer = answers.find((a) => a.task === task);
    if (answer === undefined || output.product === null) continue;
    const asked = askedOf(answer, output);
    if (asked === null) continue;
    const findings = output.product.key_findings.filter((f) => asked.free.includes(f.id)).map((f) => `${f.id}: ${f.statement}`);
    const lines = [`Probe ${probe}`];
    if (asked.text) {
      lines.push(`The known answer: ${answer.text}`, "The product's findings:", ...findings, "Does the product agree with the known answer? Say agrees, partly or disagrees.");
    } else {
      lines.push("Expected findings no finding was matched to:", ...asked.expected.map((e) => `${e}: ${answer.findings[e]!.claim}`), "The product's findings not yet matched:", ...findings);
    }
    parts.push({ kind: "judge", id: probe, title: `Probe ${probe}`, text: lines.join("\n"), marking: strictest(floor, answer.marking, output.product.marking), fixed: true });
  }
  return parts;
}

/** What the stage's output says when its model gave no matching: never the model's own words. */
export const MODEL_GAVE_NONE = "the stage's model gave no matching; the scores are the code's";
const QUESTION = [
  "Compare each probe's findings with the expected findings listed for it.",
  "For each expected finding that one of the probe's findings states in other words, give { probe, expected, produced }: the probe's id, the number of the expected finding and the id of that finding. Leave out an expected finding no finding states.",
  "For a probe that lists a known answer, give { probe, verdict } with the verdict agrees, partly or disagrees.",
  "Give no number and no score.",
].join("\n");

/** What the model answered, kept only where it names something that was asked: a probe, an expected finding of it and a free finding of it. */
function keep(answer: Json, asked: ReadonlyMap<string, Asked>): { extra: Map<string, ModelMatch[]>; texts: Map<string, Verdict> } {
  const extra = new Map<string, ModelMatch[]>();
  const texts = new Map<string, Verdict>();
  if (!isPlainObject(answer)) return { extra, texts };
  for (const m of Array.isArray(answer.matches) ? (answer.matches as unknown[]) : []) {
    if (!isPlainObject(m) || typeof m.probe !== "string" || typeof m.expected !== "number" || typeof m.produced !== "string") continue;
    const a = asked.get(m.probe);
    if (a === undefined || !a.expected.includes(m.expected) || !a.free.includes(m.produced)) continue;
    extra.set(m.probe, [...(extra.get(m.probe) ?? []), { expected: m.expected, produced: m.produced }]);
  }
  for (const v of Array.isArray(answer.texts) ? (answer.texts as unknown[]) : []) {
    if (!isPlainObject(v) || typeof v.probe !== "string" || typeof v.verdict !== "string" || !(VERDICTS as readonly string[]).includes(v.verdict)) continue;
    if (asked.get(v.probe)?.text !== true || texts.has(v.probe)) continue;
    texts.set(v.probe, v.verdict as Verdict);
  }
  return { extra, texts };
}

const passed = (output: Json, reason: string | null = null): StageEnd => ({ kind: "finished", outcome: "pass", draft_hash: null, output, reason });

export const judgeRunner: StageRunner = async (env: StageEnv): Promise<StageEnd> => {
  const { session, deps, stage } = env;
  const first = session.state;
  // recorded already: the Judge reads and writes nothing
  if (first.improve.scored !== null) return passed({ matcher: first.improve.scored.matcher, summary: first.improve.scored.summary, reason: null });
  if (first.improve.selected === null || first.improve.chosen === null) return { kind: "stalled", reason: AFTER_CHOICE };
  if (deps.improve === undefined) return { kind: "stalled", reason: "this workbench has no improve host: the Judge cannot read the tasks" };
  const withdrawn: string[] = [];
  const answers = answersOf(first, deps.improve, withdrawn);
  if (typeof answers === "string") return { kind: "stalled", reason: answers };

  const scale = first.improve.selected.scale;
  const planned = plannedProbes(first);
  const outputs: Record<string, ProbeOutput> = {};
  for (const p of planned) {
    const got = outputOfProbe(session, p.probe);
    if (typeof got === "string") return { kind: "stalled", reason: got };
    outputs[p.probe] = got;
  }
  const answerOf = (task: string): AnswerCopy | undefined => answers.find((a) => a.task === task);

  // the model's part, when the stage runs an agent and code left something for it
  const asked = new Map<string, Asked>();
  for (const p of planned) {
    const a = answerOf(p.task);
    const left = a === undefined ? null : askedOf(a, outputs[p.probe]!);
    if (left !== null) asked.set(p.probe, left);
  }
  let reason: string | null = null;
  let extra = new Map<string, ModelMatch[]>();
  let texts = new Map<string, Verdict>();
  if (stage.runs === "agent" && asked.size > 0) {
    if (stage.schema === null) {
      reason = `stage ${stage.id} has no output schema; the scores are the code's`;
    } else {
      const parts = matcherParts(session, answers, Object.fromEntries([...asked.keys()].map((k) => [k, outputs[k]!]))).map((part) => ({ ...part, text: scrub(deps.registry, part.text) }));
      const end = await stageAgent(env, { actor_id: deps.profile.stages[stage.id]?.agent ?? "judge", task: QUESTION, extras: parts });
      switch (end.kind) {
        case "output": ({ extra, texts } = keep(end.output, asked)); break;
        case "stopped": return { kind: "stopped" };
        case "blocked": reason = `the stage's model may not receive data marked ${end.marking}; the scores are the code's`; break;
        // a fixed sentence: the model's own words could quote a claim it was shown
        case "declined": case "stalled": case "waiting_child": reason = MODEL_GAVE_NONE; break;
      }
    }
  }

  const scored: OutputScore[] = planned.flatMap((p) => {
    const a = answerOf(p.task);
    return a === undefined ? [] : [scoreOutput(p, outputs[p.probe]!, a, scale, extra.get(p.probe) ?? [], texts.get(p.probe) ?? null)];
  });
  const sheet = scoreSheet(scored, scale, [BASE, ...stagedCandidates(first).map((c) => c.candidate)]);
  const matcher: "code" | "code+model" = scored.some((o) => o.text !== null || o.findings.some((f) => f.by === "model")) ? "code+model" : "code";
  const answersBlob = session.blobs.put(canonical(answers as unknown as Json));
  const sheetBlob = session.blobs.put(canonical(sheet as unknown as Json));
  session.commit((s): EntryInput[] => {
    if (s.run.id !== first.run.id || s.run.status === "finished" || s.improve.scored !== null || s.improve.chosen === null) return [];
    return [{ type: "judge.scored", actor: ENGINE, run: s.run.id, stage: stage.id, payload: { answers: answersBlob, scores: sheetBlob, matcher, summary: sheet.summary } }];
  });
  const said = [...withdrawn, ...(reason === null ? [] : [reason])];
  const why = said.length === 0 ? null : said.join("; ");
  return passed({ matcher, summary: sheet.summary, reason: why }, why);
};
