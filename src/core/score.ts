// Slice 14: a probe's output is scored against a known answer in code. Pure and browser-safe: no session, no deps, no model, no clock.
// `src/core/verify.ts` recomputes a recorded sheet with `rescore`; a model's part (which produced finding states a claim code left
// unmatched, and a verdict on an answer's text when it has no expected finding) is an input here, never a number.
import type { AnswerCopy, FindingScore, OutputScore, ProbeOutput, ScoreSheet } from "./state/improve";
import type { ExpectedFinding, Finding } from "./types";

/** The least similarity, in thousandths, at which code matches a claim to a produced finding. */
export const CLAIM_MATCH = 500;

const CONFIDENCE_ORDER: readonly Finding["confidence"][] = ["low", "moderate", "high"];
const TEXT_SCORE = { agrees: 1000, partly: 500, disagrees: 0 } as const;

/** The set of words of a text: lower-cased, split on anything that is not a letter or a digit, with no empty word. */
function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== ""));
}

/** The share of shared words of two texts, in thousandths: round(1000 * |A ∩ B| / |A ∪ B|); 0 when either has no word. */
export function claimSimilarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return Math.round((1000 * shared) / (A.size + B.size - shared));
}

/** A model's matching for an expected finding code left unmatched: the produced finding's id, or null for none. */
export interface ModelMatch { expected: number; produced: string | null }

type Match = { expected: number; produced: string | null; by: "code" | "model" | null; similarity: number | null };

/**
 * One row per expected finding, in order. Code first: every pair at or above CLAIM_MATCH, greatest similarity first (ties: the earlier
 * expected, then the earlier produced), each finding used once. Then `extra`, in order: an entry is used only when its expected finding
 * and its produced finding are both still free. A row's similarity is the pair's, whoever matched it; null when unmatched.
 */
export function matchClaims(expected: readonly ExpectedFinding[], produced: readonly Finding[], extra: readonly ModelMatch[] = []): Match[] {
  const pairs: { e: number; p: number; sim: number }[] = [];
  expected.forEach((ef, e) => produced.forEach((pf, p) => {
    const sim = claimSimilarity(ef.claim, pf.statement);
    if (sim >= CLAIM_MATCH) pairs.push({ e, p, sim });
  }));
  pairs.sort((x, y) => y.sim - x.sim || x.e - y.e || x.p - y.p);
  const rows: Match[] = expected.map((_, e) => ({ expected: e, produced: null, by: null, similarity: null }));
  const used = new Set<number>();
  for (const { e, p, sim } of pairs) {
    if (rows[e]!.by !== null || used.has(p)) continue;
    rows[e] = { expected: e, produced: produced[p]!.id, by: "code", similarity: sim };
    used.add(p);
  }
  for (const m of extra) {
    if (m.produced === null || !Number.isInteger(m.expected) || m.expected < 0 || m.expected >= expected.length) continue;
    if (rows[m.expected]!.by !== null) continue;
    const p = produced.findIndex((pf, i) => pf.id === m.produced && !used.has(i));
    if (p < 0) continue;
    rows[m.expected] = { expected: m.expected, produced: m.produced, by: "model", similarity: claimSimilarity(expected[m.expected]!.claim, produced[p]!.statement) };
    used.add(p);
  }
  return rows;
}

/** The expected findings code left unmatched, by index: what a model may be asked about. */
export function unmatched(expected: readonly ExpectedFinding[], produced: readonly Finding[]): number[] {
  return matchClaims(expected, produced).filter((r) => r.produced === null).map((r) => r.expected);
}

/** The distance of two terms on an ordered list, as a share of its length less one, in [0, 1]; 1 when either is off it or it has one term. */
function distance(list: readonly string[], a: string, b: string): number {
  const i = list.indexOf(a);
  const j = list.indexOf(b);
  if (i < 0 || j < 0 || list.length < 2) return 1;
  return Math.abs(i - j) / (list.length - 1);
}

/** The rounded mean of integers; null when there are none. */
function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : Math.round(xs.reduce((s, x) => s + x, 0) / xs.length);
}

/**
 * One output's score against one known answer. A matched expected finding scores 500 + round(250 * (1 − ld)) + round(250 * (1 − cd));
 * an unmatched one 0; the output the rounded mean of them. The distances are recorded in thousandths, so every number is an integer.
 * An incomplete output scores 0. With no expected finding the output is scored from `text` (1000, 500, 0), or is unscored (null).
 * `text` is kept only where it scored.
 */
export function scoreOutput(
  probe: { probe: string; candidate: string; task: string }, output: ProbeOutput, answer: AnswerCopy, scale: readonly string[],
  extra: readonly ModelMatch[] = [], text: "agrees" | "partly" | "disagrees" | null = null,
): OutputScore {
  const head = { probe: probe.probe, candidate: probe.candidate, task: probe.task, outcome: output.outcome };
  if (output.outcome !== "drafted" || output.product === null) {
    const findings: FindingScore[] = answer.findings.map((_, e) => ({
      expected: e, produced: null, by: null, similarity: null, likelihood_distance: null, confidence_distance: null, score: 0,
    }));
    return { ...head, score: 0, text: null, findings, left_over: [] };
  }
  const produced = output.product.key_findings;
  const rows = matchClaims(answer.findings, produced, extra);
  const taken = new Set(rows.map((r) => r.produced));
  const left_over = produced.map((f) => f.id).filter((id) => !taken.has(id));
  if (answer.findings.length === 0) return { ...head, score: text === null ? null : TEXT_SCORE[text], text, findings: [], left_over };
  const findings: FindingScore[] = rows.map((r) => {
    const pf = r.produced === null ? undefined : produced.find((f) => f.id === r.produced);
    if (pf === undefined) return { ...r, produced: null, by: null, similarity: null, likelihood_distance: null, confidence_distance: null, score: 0 };
    const ef = answer.findings[r.expected]!;
    const ld = distance(scale, ef.likelihood, pf.likelihood);
    const cd = distance(CONFIDENCE_ORDER, ef.confidence, pf.confidence);
    return {
      ...r, likelihood_distance: Math.round(1000 * ld), confidence_distance: Math.round(1000 * cd),
      score: 500 + Math.round(250 * (1 - ld)) + Math.round(250 * (1 - cd)),
    };
  });
  return { ...head, score: mean(findings.map((f) => f.score)), text: null, findings, left_over };
}

/** The sheet of a run: the outputs as given, and a summary row per candidate of `order` (base, then the candidates); a candidate with no scored output scores 0. */
export function scoreSheet(outputs: readonly OutputScore[], scale: readonly string[], order: readonly string[]): ScoreSheet {
  const summary = order.map((candidate) => {
    const mine = outputs.filter((o) => o.candidate === candidate);
    const scored = mine.flatMap((o) => (o.score === null ? [] : [o.score]));
    return { candidate, score: mean(scored) ?? 0, drafted: mine.filter((o) => o.outcome === "drafted").length, tasks: mine.length };
  });
  return { format: 1, scale: [...scale], outputs: [...outputs], summary };
}

/**
 * scoreSheet over scoreOutput, with the matches and text verdicts a recorded sheet holds as the model's part: what verifyScores compares.
 * An output whose probe output or answer is missing is left out, so the result differs from the recorded sheet.
 */
export function rescore(recorded: ScoreSheet, outputs: Record<string, ProbeOutput>, answers: readonly AnswerCopy[]): ScoreSheet {
  const again = recorded.outputs.flatMap((o) => {
    const output = Object.hasOwn(outputs, o.probe) ? outputs[o.probe] : undefined;
    const answer = answers.find((a) => a.task === o.task);
    if (output === undefined || answer === undefined) return [];
    const extra = o.findings.filter((f) => f.by === "model").map((f) => ({ expected: f.expected, produced: f.produced }));
    return [scoreOutput({ probe: o.probe, candidate: o.candidate, task: o.task }, output, answer, recorded.scale, extra, o.text)];
  });
  return scoreSheet(again, recorded.scale, recorded.summary.map((r) => r.candidate));
}
