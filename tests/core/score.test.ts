// Slice 14, Task 4: a probe's output is scored against a known answer in code.
import { expect, test } from "bun:test";
import { CLAIM_MATCH, claimSimilarity, matchClaims, rescore, scoreOutput, scoreSheet, unmatched } from "../../src/core/score";
import type { AnswerCopy, OutputScore, ProbeOutput, ScoreSheet } from "../../src/core/state/improve";
import type { ExpectedFinding, Finding, Marking, Product } from "../../src/core/types";

const SEVEN = ["remote", "very unlikely", "unlikely", "roughly even", "likely", "very likely", "almost certain"];
const marking: Marking = "TLP:GREEN";

const found = (id: string, statement: string, likelihood = "likely", confidence: Finding["confidence"] = "moderate"): Finding => ({
  id, statement, likelihood, confidence, confidence_basis: "two sources", cites: ["C1"], assumptions: [], reasoning: "seen in the logs",
});
const expected = (claim: string, likelihood = "likely", confidence: ExpectedFinding["confidence"] = "moderate"): ExpectedFinding => ({ claim, likelihood, confidence });
const product = (findings: Finding[]): Product => ({
  objective: "Decide", question: "Is 192.0.2.10 beaconing?", marking, summary: "s", key_findings: findings, gaps_and_limits: "g",
  alternatives: "a", assessment: "x", sources: [], assumptions: [], change: "",
});
const drafted = (findings: Finding[]): ProbeOutput => ({
  format: 1, outcome: "drafted", reason: "", draft_hash: "d".repeat(64), product: product(findings),
  stats: { lookups: 3, tokens: 900, model_calls: 2, stages: [] },
});
const incomplete: ProbeOutput = {
  format: 1, outcome: "incomplete", reason: "its run was stopped", draft_hash: null, product: null, stats: { lookups: 0, tokens: 0, model_calls: 0, stages: [] },
};
const answer = (task: string, findings: ExpectedFinding[], text = "The host beacons to 198.51.100.7."): AnswerCopy => ({
  task, seq: 12, hash: "a".repeat(64), text, findings, marking,
});
const probe = (candidate: string, task: string) => ({ probe: `${candidate}/${task}`, candidate, task });

test("claimSimilarity is the share of shared words, in thousandths, whatever the case and the punctuation", () => {
  // A: the printer lp 3 held 192 0 2 21 (9 words). B: 192 0 2 21 was held by the printer lp 3 (11 words).
  // Shared: all 9 of A; union 11. round(1000 * 9 / 11) = round(818.18) = 818.
  expect(claimSimilarity("The printer lp-3 held 192.0.2.21.", "192.0.2.21 was held by the printer LP-3")).toBe(818);
  expect(claimSimilarity("Beacon, BEACON; beacon!", "beacon")).toBe(1000);
  expect(claimSimilarity("alpha beta", "gamma delta")).toBe(0);
});

test("claimSimilarity of an empty text is 0", () => {
  expect(claimSimilarity("", "a host beacons")).toBe(0);
  expect(claimSimilarity("a host beacons", "")).toBe(0);
  expect(claimSimilarity("...", "!!")).toBe(0);
  expect(claimSimilarity("", "")).toBe(0);
});

test("matchClaims pairs greatest similarity first, each finding once; a tie goes to the earlier expected, then the earlier produced", () => {
  // E0 "a b c d" vs F1 "a b c d" is 1000; E1 "a b c d e" vs F1 is 800 but F1 is taken; E1 vs F2 "a b c d e x" is 833.
  const exp = [expected("a b c d"), expected("a b c d e")];
  const prod = [found("F0", "q r s"), found("F1", "a b c d"), found("F2", "a b c d e x")];
  expect(matchClaims(exp, prod)).toEqual([
    { expected: 0, produced: "F1", by: "code", similarity: 1000 },
    { expected: 1, produced: "F2", by: "code", similarity: 833 },
  ]);
  // Ties: two expected findings equally like two equal produced ones: the earlier expected takes the earlier produced.
  const tied = matchClaims([expected("host beacons"), expected("host beacons")], [found("F1", "host beacons"), found("F2", "host beacons")]);
  expect(tied).toEqual([
    { expected: 0, produced: "F1", by: "code", similarity: 1000 },
    { expected: 1, produced: "F2", by: "code", similarity: 1000 },
  ]);
  // One produced finding liked equally by two expected ones: the earlier expected wins it.
  expect(matchClaims([expected("host beacons"), expected("host beacons")], [found("F9", "host beacons")])).toEqual([
    { expected: 0, produced: "F9", by: "code", similarity: 1000 },
    { expected: 1, produced: null, by: null, similarity: null },
  ]);
  expect(matchClaims([], [found("F1", "x")])).toEqual([]);
  expect(matchClaims([expected("x y")], [])).toEqual([{ expected: 0, produced: null, by: null, similarity: null }]);
});

test("a pair below 500 is no match", () => {
  expect(CLAIM_MATCH).toBe(500);
  // "a b c" vs "a b d e": 2 shared of 5 = 400.
  expect(matchClaims([expected("a b c")], [found("F1", "a b d e")])).toEqual([{ expected: 0, produced: null, by: null, similarity: null }]);
  // "a b c" vs "a b d": 2 of 4 = 500, exactly the bar: a match.
  expect(matchClaims([expected("a b c")], [found("F1", "a b d")])).toEqual([{ expected: 0, produced: "F1", by: "code", similarity: 500 }]);
  expect(unmatched([expected("a b c"), expected("a b d")], [found("F1", "a b d e")])).toEqual([0]);
});

test("a model's match is used only for an expected finding code left unmatched and a produced finding still free", () => {
  const exp = [expected("host beacons"), expected("traffic every minute"), expected("no data left")];
  const prod = [found("F1", "host beacons"), found("F2", "connections at sixty second intervals"), found("F3", "nothing exfiltrated")];
  expect(unmatched(exp, prod)).toEqual([1, 2]);
  const rows = matchClaims(exp, prod, [
    { expected: 0, produced: "F3" }, // code matched E0 already: ignored
    { expected: 1, produced: "F1" }, // F1 is taken by code: ignored
    { expected: 1, produced: "F2" }, // used
    { expected: 2, produced: "F2" }, // F2 now taken by the model: ignored
    { expected: 2, produced: "F404" }, // no such finding: ignored
    { expected: 7, produced: "F3" }, // no such expected finding: ignored
  ]);
  expect(rows).toEqual([
    { expected: 0, produced: "F1", by: "code", similarity: 1000 },
    { expected: 1, produced: "F2", by: "model", similarity: 0 },
    { expected: 2, produced: null, by: null, similarity: null },
  ]);
  expect(matchClaims(exp, prod, [{ expected: 2, produced: null }])[2]).toEqual({ expected: 2, produced: null, by: null, similarity: null });
  expect(matchClaims(exp, prod, [{ expected: 2, produced: "F3" }])[2]).toEqual({ expected: 2, produced: "F3", by: "model", similarity: 0 });
});

test("a matched finding with the same likelihood and confidence scores 1000", () => {
  const s = scoreOutput(probe("base", "T1"), drafted([found("F1", "host beacons", "likely", "high")]), answer("T1", [expected("host beacons", "likely", "high")]), SEVEN);
  expect(s.findings).toEqual([{ expected: 0, produced: "F1", by: "code", similarity: 1000, likelihood_distance: 0, confidence_distance: 0, score: 1000 }]);
  expect(s.score).toBe(1000);
});

test("a matched finding at the other end of a seven-term scale and of confidence scores 500", () => {
  const s = scoreOutput(probe("base", "T1"), drafted([found("F1", "host beacons", "remote", "low")]), answer("T1", [expected("host beacons", "almost certain", "high")]), SEVEN);
  expect(s.findings[0]).toMatchObject({ likelihood_distance: 1000, confidence_distance: 1000, score: 500 });
  expect(s.score).toBe(500);
});

test("one step of seven on likelihood and one of confidence scores 500 + round(250 * 5/6) + 125", () => {
  const s = scoreOutput(probe("K1", "T1"), drafted([found("F1", "host beacons", "very likely", "high")]), answer("T1", [expected("host beacons", "likely", "moderate")]), SEVEN);
  // likelihood one step of six: round(1000/6) = 167 thousandths; confidence one step of two: 500.
  expect(s.findings[0]).toMatchObject({ likelihood_distance: 167, confidence_distance: 500, score: 500 + Math.round((250 * 5) / 6) + 125 });
  expect(s.score).toBe(833);
});

test("a likelihood term that is not on the scale is at distance 1", () => {
  const off = scoreOutput(probe("base", "T1"), drafted([found("F1", "host beacons", "probable", "moderate")]), answer("T1", [expected("host beacons", "likely", "moderate")]), SEVEN);
  expect(off.findings[0]).toMatchObject({ likelihood_distance: 1000, confidence_distance: 0, score: 750 });
  // Equal terms off the scale are still at distance 1.
  const both = scoreOutput(probe("base", "T1"), drafted([found("F1", "host beacons", "probable")]), answer("T1", [expected("host beacons", "probable")]), SEVEN);
  expect(both.findings[0]).toMatchObject({ likelihood_distance: 1000, score: 750 });
  // A scale of one term: distance 1.
  const one = scoreOutput(probe("base", "T1"), drafted([found("F1", "host beacons", "likely")]), answer("T1", [expected("host beacons", "likely")]), ["likely"]);
  expect(one.findings[0]).toMatchObject({ likelihood_distance: 1000, score: 750 });
});

test("an unmatched expected finding scores 0, and a produced finding matched by none is listed as left over", () => {
  const s = scoreOutput(
    probe("base", "T1"), drafted([found("F1", "printer held the address"), found("F2", "host beacons"), found("F3", "a scan ran")]),
    answer("T1", [expected("host beacons"), expected("credentials were reused")]), SEVEN,
  );
  expect(s.findings[1]).toEqual({ expected: 1, produced: null, by: null, similarity: null, likelihood_distance: null, confidence_distance: null, score: 0 });
  expect(s.left_over).toEqual(["F1", "F3"]);
  expect(s.score).toBe(500);
});

test("the output's score is the rounded mean of its expected findings' scores", () => {
  // 1000, 833 and 0: mean 611 (1833 / 3 = 611.0).
  const s = scoreOutput(
    probe("K2", "T3"), drafted([found("F1", "host beacons", "likely", "moderate"), found("F2", "traffic every minute", "very likely", "high")]),
    answer("T3", [expected("host beacons"), expected("traffic every minute"), expected("credentials were reused")]), SEVEN,
  );
  expect(s.findings.map((f) => f.score)).toEqual([1000, 833, 0]);
  expect(s.score).toBe(Math.round(1833 / 3));
  // 1000 and 833: 916.5 rounds to 917.
  const two = scoreOutput(
    probe("K2", "T3"), drafted([found("F1", "host beacons"), found("F2", "traffic every minute", "very likely", "high")]),
    answer("T3", [expected("host beacons"), expected("traffic every minute")]), SEVEN,
  );
  expect(two.score).toBe(917);
  expect(two).toMatchObject({ probe: "K2/T3", candidate: "K2", task: "T3", outcome: "drafted", text: null });
});

test("an incomplete output scores 0", () => {
  const s = scoreOutput(probe("K1", "T2"), incomplete, answer("T2", [expected("host beacons"), expected("traffic every minute")]), SEVEN);
  expect(s).toEqual({
    probe: "K1/T2", candidate: "K1", task: "T2", outcome: "incomplete", score: 0, text: null, left_over: [],
    findings: [0, 1].map((expected) => ({ expected, produced: null, by: null, similarity: null, likelihood_distance: null, confidence_distance: null, score: 0 })),
  });
  // Also with no expected finding, and whatever the model said of its text.
  expect(scoreOutput(probe("K1", "T2"), incomplete, answer("T2", []), SEVEN, [], "agrees")).toMatchObject({ score: 0, text: null, findings: [] });
});

test("an answer with no expected finding is unscored without a text verdict, and 1000, 500 or 0 with one", () => {
  const out = drafted([found("F1", "host beacons")]);
  const a = answer("T1", []);
  expect(scoreOutput(probe("base", "T1"), out, a, SEVEN)).toMatchObject({ score: null, text: null, findings: [], left_over: ["F1"] });
  expect(scoreOutput(probe("base", "T1"), out, a, SEVEN, [], null).score).toBeNull();
  expect(scoreOutput(probe("base", "T1"), out, a, SEVEN, [], "agrees")).toMatchObject({ score: 1000, text: "agrees" });
  expect(scoreOutput(probe("base", "T1"), out, a, SEVEN, [], "partly")).toMatchObject({ score: 500, text: "partly" });
  expect(scoreOutput(probe("base", "T1"), out, a, SEVEN, [], "disagrees")).toMatchObject({ score: 0, text: "disagrees" });
  // With expected findings a text verdict is not what scores it, and is not kept.
  expect(scoreOutput(probe("base", "T1"), out, answer("T1", [expected("host beacons")]), SEVEN, [], "disagrees")).toMatchObject({ score: 1000, text: null });
});

const outputScore = (candidate: string, task: string, score: number | null, outcome: OutputScore["outcome"] = "drafted"): OutputScore => ({
  probe: `${candidate}/${task}`, candidate, task, outcome, score, text: null, findings: [], left_over: [],
});

test("a candidate's score is the rounded mean of its scored outputs; an unscored output counts in none", () => {
  const sheet = scoreSheet([outputScore("base", "T1", 1000), outputScore("base", "T2", 833), outputScore("base", "T3", null), outputScore("K1", "T1", null)], SEVEN, ["base", "K1"]);
  // base: (1000 + 833) / 2 = 916.5, rounded 917; K1 has no scored output: 0.
  expect(sheet.summary).toEqual([
    { candidate: "base", score: 917, drafted: 3, tasks: 3 },
    { candidate: "K1", score: 0, drafted: 1, tasks: 1 },
  ]);
});

test("the summary lists base first and then the candidates in order, with drafted and tasks counts", () => {
  const outs = [
    outputScore("K2", "T1", 400), outputScore("K1", "T1", 0, "incomplete"), outputScore("base", "T1", 600),
    outputScore("K2", "T2", 600), outputScore("K1", "T2", 900), outputScore("base", "T2", 0, "incomplete"),
  ];
  const sheet = scoreSheet(outs, SEVEN, ["base", "K1", "K2"]);
  expect(sheet).toEqual({
    format: 1, scale: SEVEN, outputs: outs,
    summary: [
      { candidate: "base", score: 300, drafted: 1, tasks: 2 },
      { candidate: "K1", score: 450, drafted: 1, tasks: 2 },
      { candidate: "K2", score: 500, drafted: 2, tasks: 2 },
    ],
  });
  expect(sheet.scale).not.toBe(SEVEN);
  expect(sheet.outputs).not.toBe(outs);
});

/** A whole run: base and two candidates on two tasks, one answer with no expected finding judged by its text, one model match. */
function wholeRun(): { sheet: ScoreSheet; outputs: Record<string, ProbeOutput>; answers: AnswerCopy[] } {
  const answers = [answer("T1", [expected("host beacons", "likely", "high"), expected("traffic every minute", "very likely")]), answer("T2", [])];
  const outputs: Record<string, ProbeOutput> = {
    "base/T1": drafted([found("F1", "host beacons", "unlikely", "low"), found("F2", "a scan ran")]),
    "base/T2": drafted([found("F1", "host beacons")]),
    "K1/T1": drafted([found("F1", "host beacons", "likely", "high"), found("F2", "connections at sixty second intervals", "very likely")]),
    "K1/T2": incomplete,
    "K2/T1": incomplete,
    "K2/T2": drafted([found("F1", "nothing")]),
  };
  const model: Record<string, { extra: { expected: number; produced: string | null }[]; text: "agrees" | "partly" | "disagrees" | null }> = {
    "base/T1": { extra: [], text: null }, "base/T2": { extra: [], text: "partly" },
    "K1/T1": { extra: [{ expected: 1, produced: "F2" }], text: null }, "K1/T2": { extra: [], text: null },
    "K2/T1": { extra: [], text: null }, "K2/T2": { extra: [], text: null },
  };
  const scored = Object.keys(outputs).map((p) => {
    const [candidate, task] = p.split("/") as [string, string];
    return scoreOutput({ probe: p, candidate, task }, outputs[p]!, answers.find((a) => a.task === task)!, SEVEN, model[p]!.extra, model[p]!.text);
  });
  return { sheet: scoreSheet(scored, SEVEN, ["base", "K1", "K2"]), outputs, answers };
}

test("rescore of a sheet over the same outputs and answers is that sheet", () => {
  const { sheet, outputs, answers } = wholeRun();
  expect(sheet.outputs.find((o) => o.probe === "K1/T1")!.findings[1]).toMatchObject({ produced: "F2", by: "model" });
  expect(sheet.summary).toEqual([
    // base/T1: E0 matched, two steps of six and two of two: 500 + round(250 * 4/6) + 0 = 667; E1 unmatched: 0; mean 334 (333.5). base/T2: partly 500.
    { candidate: "base", score: Math.round((334 + 500) / 2), drafted: 2, tasks: 2 },
    // K1/T1: 1000 and 1000 (the model's match): 1000. K1/T2 incomplete: 0.
    { candidate: "K1", score: 500, drafted: 1, tasks: 2 },
    // K2/T1 incomplete: 0. K2/T2 unscored.
    { candidate: "K2", score: 0, drafted: 1, tasks: 2 },
  ]);
  const before = JSON.stringify({ sheet, outputs, answers });
  expect(rescore(sheet, outputs, answers)).toEqual(sheet);
  expect(JSON.stringify({ sheet, outputs, answers })).toBe(before);
  // Determinism: the same inputs give the same sheet, byte for byte.
  expect(JSON.stringify(wholeRun().sheet)).toBe(JSON.stringify(sheet));
  // A changed output is seen.
  const changed = { ...outputs, "K1/T1": drafted([found("F1", "host beacons", "remote", "low")]) };
  expect(rescore(sheet, changed, answers)).not.toEqual(sheet);
});

test("every number in a sheet is an integer", () => {
  const { sheet } = wholeRun();
  const numbers: number[] = [];
  const walk = (x: unknown): void => {
    if (typeof x === "number") numbers.push(x);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (x !== null && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk(sheet);
  expect(numbers.length).toBeGreaterThan(20);
  for (const n of numbers) expect(Number.isInteger(n)).toBe(true);
  for (const o of sheet.outputs) if (o.score !== null) expect(o.score >= 0 && o.score <= 1000).toBe(true);
});
