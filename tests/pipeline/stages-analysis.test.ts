import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import { blockers, latestDraft, publishable } from "../../src/core/state";
import { buildBundle } from "../../src/pipeline/publish";
import { ReviseRefused } from "../../src/pipeline/revise";
import type { Entry } from "../../src/core/types";
import { loadProfile } from "../../src/agents/context";
import { Providers } from "../../src/agents/providers";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import type { ScriptReply } from "../../src/agents/providers/scripted";
import { loadConfig } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnd, StageRunner } from "../../src/pipeline/engine";
import { loadPipeline } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { assembleRunner } from "../../src/pipeline/stages/assemble";
import { challengeRunner } from "../../src/pipeline/stages/challenge";
import { evaluateRunner } from "../../src/pipeline/stages/evaluate";
import { card } from "../helpers/entries";
import { fixture, person, PLAN } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
let dir: string;
beforeEach(() => { afterTurn = null; f = fixture(false); dir = mkdtempSync(join(tmpdir(), "analysis-")); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
  rmSync(dir, { recursive: true, force: true });
});

const planner = { kind: "agent", id: "planner", stage: "plan", profile: "investigation", model: "m", effort: null, where: "machine" } as const;
const PASS: Extract<StageEnd, { kind: "finished" }> = { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
const say = (x: unknown): ScriptReply => ({ content: JSON.stringify(x) });
const call = (tool: string, args: Record<string, Json>): { tool: string; args: Record<string, Json> } => ({ tool, args: { why: "w", ...args } });
const calls = (...c: { tool: string; args: Record<string, Json> }[]): ScriptReply => ({ tool_calls: c });
const finding = (claim: string, cites: string[], extra: Record<string, Json> = {}) =>
  call("propose_assessment", { claim, likelihood: "likely", confidence: "high", confidence_basis: "the record", cites, assumptions: [], reasoning: "matches", ...extra });
const section = (s: string, text: string, cites: string[] = []) => call("propose_narrative", { section: s, text, cites });
const out = (detail: string) => say({ done: true, change_kind: "first judgment", change_detail: detail, assumptions: ["the records are current"], note: "n" });
/** Draft 1: two findings and a summary. */
const FIRST: ScriptReply[] = [calls(finding("it is internal", ["c1"]), finding("it talks to the proxy", ["c2"]), section("summary", "all clear", ["c1"])), out("first")];
/** Draft 2: only f1 is proposed again. */
const SECOND: ScriptReply[] = [calls(finding("it is internal and managed", ["c1"], { replaces: "f1" })), out("second")];
/** Draft 2 that also answers challenge x1 (revised). */
const SECOND_ANSWERING: ScriptReply[] = [
  calls(finding("it is internal and managed", ["c1"], { replaces: "f1" }), call("answer_challenge", { challenge: "x1", answer: "f1 now says the record is managed", action: "revised" })), out("second"),
];
const EVAL_PASS = say({ pass: true, findings: [] });
const CHALLENGE_PASS = say({ done: true, summary: "nothing to add" });

/** Called after each model answer the scripted provider gives, with its running count and the asking actor; a test uses it to act while a model is answering. */
let afterTurn: ((n: number, actor: string) => void) | null = null;
interface Rig { engine: Engine; log: string[]; checks: { fail: number } }
/** Real Assemble, Evaluate and Challenge; stubs for the rest. `checks.fail` is how many times the Checks stub fails before it passes. */
function rig(replies: Record<string, ScriptReply[]>, over: Partial<Record<Role, StageRunner>> = {}, s: CaseSession = f.s): Rig {
  const registry = f.sample.registry;
  const { pipeline, problems } = loadPipeline(registry);
  if (pipeline === null) throw new Error(problems.join("; "));
  const turns = Object.entries(replies).flatMap(([actor, rs]) => rs.map((reply) => ({ actor, reply })));
  const scripted = new ScriptedProvider({ id: "scripted", scripts: [{ id: "sample-run", turns }] });
  const real = scripted.turn.bind(scripted);
  let turns_ = 0;
  scripted.turn = async (req) => { const got = await real(req); afterTurn?.(++turns_, req.key); return got; };
  const deps: EngineDeps = {
    config: loadConfig({ env: {}, home: dir, repoRoot: dir }), registry, runner: f.sample.deps, seeker: f.sample.seeker,
    providers: new Providers([scripted]), pipeline, profile: loadProfile(registry, "investigation"),
  };
  const log: string[] = [];
  const checks = { fail: 0 };
  const logged = (name: string, r: StageRunner): StageRunner => async (env) => { log.push(name); return r(env); };
  const runners: Partial<Record<Role, StageRunner>> = {
    frame: async () => { log.push("frame"); return PASS; },
    plan: async () => {
      log.push("plan");
      s.commit((_st, ids) => [{ type: "plan.proposed", actor: planner, payload: { plan: PLAN(ids.next("plan")) } }]);
      return PASS;
    },
    research: async () => { log.push("research"); return PASS; },
    assemble: logged("assemble", assembleRunner),
    checks: async () => {
      log.push("checks");
      const d = latestDraft(s.state)!;
      if (checks.fail > 0) {
        checks.fail--;
        s.commit(() => [{ type: "check.run", actor: { kind: "system", id: "engine" }, payload: {
          check: "cites", script_hash: "h", input: s.blobs.put("{}"), output: s.blobs.put("{}"), draft_hash: d.hash, pass: false, findings: [{ check: "cites", where: "f1", message: "f1 cites too little" }],
        } }]);
        return { kind: "finished", outcome: "fail", draft_hash: d.hash, output: null, reason: "f1 cites too little" };
      }
      return { ...PASS, draft_hash: d.hash };
    },
    evaluate: logged("evaluate", evaluateRunner),
    challenge: logged("challenge", challengeRunner),
    publish: async () => { log.push("publish"); return { ...PASS, draft_hash: latestDraft(s.state)?.hash ?? null }; },
    feedback: async () => PASS,
    ...over,
  };
  return { engine: new Engine(s, deps, { runners }), log, checks };
}

const ofType = <T extends Entry["type"]>(t: T): Extract<Entry, { type: T }>[] => f.s.entries().filter((e): e is Extract<Entry, { type: T }> => e.type === t);
const finished = (stage: string) => ofType("stage.finished").filter((e) => e.payload.stage === stage);
/** Every model call is a request: the first attempt of the analyst took two (proposals, then the output), so its second attempt begins at request 2. */
const requestText = (actor: string, ordinal: number): string => f.s.blobs.text(ofType("model.request").filter((e) => e.actor.id === actor)[ordinal]!.payload.messages.blob);

/** Two cards: c1 from the assets source, c2 amber from the flows source. */
function cards(): void {
  f.s.commit((_st, ids) => [
    { type: "card.created", actor: person, payload: { card: card(ids.next("card"), { title: "Asset record", body: "ws-17 is a managed laptop", source: "assets", marking: "TLP:GREEN" }) } },
    { type: "card.created", actor: person, payload: { card: card(ids.next("card"), { title: "Proxy flows", body: "ws-17 talks to the proxy", source: "flows", marking: "TLP:AMBER" }) } },
  ]);
}
const accept = (): void => {
  f.s.commit(() => [
    { type: "plan.accepted", actor: person, payload: { plan: f.s.state.plan.current!.id, steps: ["s1", "s2", "s3", "s4"], budgets: {} } },
    { type: "gate.passed", actor: person, payload: { gate: "plan" } },
  ]);
};
/** Starts the run, passes the plan gate, and drives it as far as it goes. */
async function go(r: Rig) {
  cards();
  r.engine.start(person);
  await r.engine.advance();
  accept();
  return r.engine.advance();
}

test("the analyst's proposals become draft 1 with its hash, and each finding is recorded against it", async () => {
  const r = rig({ analyst: FIRST, evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  const sum = await go(r);
  expect(sum).toMatchObject({ status: "waiting", waiting: "publish" });
  const d = f.s.state.drafts[0]!;
  const made = ofType("assessment.made");
  expect(d.n).toBe(1);
  expect(d.hash).toBe(sha256Hex(canonical(d.product as unknown as Json)));
  expect(made.map((e) => e.payload.draft_hash)).toEqual([d.hash, d.hash]);
  expect(made.map((e) => e.payload.finding.id)).toEqual(["f1", "f2"]);
  expect(d.author).toMatchObject({ kind: "agent", id: "analyst" });
  expect(d.reason).toBe("first draft");
  expect(finished("assemble")[0]!.payload).toMatchObject({ outcome: "pass", draft_hash: d.hash });
  expect(publishable(f.s.state, d.hash)).toBe(true);
});

test("objective, question, marking and source quality are filled in by code, not by the model", async () => {
  const r = rig({ analyst: FIRST, evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  await go(r);
  const p = f.s.state.drafts[0]!.product;
  expect(p.objective).toBe("");
  expect(p.question).toBe("a");
  expect(p.marking).toBe("TLP:AMBER");
  expect(p.sources.map((x) => x.source)).toEqual(["assets", "flows"]);
  expect(p.sources[0]!.quality).toBe(f.sample.registry.source("assets")!.quality);
  expect(p.assumptions).toEqual(["the records are current"]);
  expect(p.change).toBe("First judgment: first.");
});

test("Assemble composes the change from the analyst's change_kind and change_detail, and a statement from its likelihood and claim", async () => {
  const r = rig({ analyst: FIRST, evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  await go(r);
  const p = f.s.state.drafts[0]!.product;
  expect(p.change).toBe("First judgment: first.");
  expect(p.key_findings.map((x) => x.statement)).toEqual(["We assess it is likely that it is internal.", "We assess it is likely that it talks to the proxy."]);
  // the analyst's own words stay in the ledger: the reply and the tool calls are recorded as they were
  const called = ofType("tool.called").filter((e) => e.payload.tool === "propose_assessment").map((e) => (e.payload.args as Record<string, Json>).claim);
  expect(called).toEqual(["it is internal", "it talks to the proxy"]);
});

test("a revision starts from the previous draft's sections and holds only the findings proposed again", async () => {
  const r = rig({ analyst: [...FIRST, ...SECOND], evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  r.checks.fail = 1;
  await go(r);
  const [d1, d2] = f.s.state.drafts;
  expect(f.s.state.drafts).toHaveLength(2);
  expect(d2!.n).toBe(2);
  expect(d2!.product.key_findings[0]!.statement).toBe("We assess it is likely that it is internal and managed.");
  // f2 was not proposed again, so it is not carried
  expect(d2!.product.key_findings.map((x) => x.id)).toEqual(["f1"]);
  expect(d1!.product.key_findings.map((x) => x.id)).toEqual(["f1", "f2"]);
  expect(d2!.product.summary).toBe("all clear");
  expect(d2!.product.change).toBe("First judgment: second.");
  expect(d2!.reason).toBe("revised after Checks: f1 cites too little");
  expect(ofType("assessment.made").map((e) => e.payload.draft_hash)).toEqual([d1!.hash, d1!.hash, d2!.hash]);
});

/** A run whose Research stage leaves a person's draft of sixteen findings, f7 among them, for Assemble to start from. */
function sixteen(analyst: ScriptReply[]): Rig {
  let engine: Engine | null = null;
  const research: StageRunner = async () => {
    const findings = Array.from({ length: 16 }, (_, i) => ({
      id: `f${i + 1}`, statement: i === 6 ? "We judge that the device likely connected to the address." : `We assess it is likely that old claim ${i + 1} holds.`,
      likelihood: "likely", confidence: "low" as const, confidence_basis: "b", cites: ["c1"], assumptions: [], reasoning: "r",
    }));
    engine!.revise({ product: {
      objective: "o", question: "q", marking: "TLP:GREEN", summary: "all clear", key_findings: findings, gaps_and_limits: "", alternatives: "", assessment: "",
      sources: [], assumptions: [], change: "First judgment.",
    }, reason: "an earlier analysis", actor: person });
    return PASS;
  };
  const r = rig({ analyst, evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] }, { research });
  engine = r.engine;
  return r;
}

test("a draft holds only the findings of its own Assemble pass: f17-f20 proposed, and an old f7 does not reappear", async () => {
  const pass: ScriptReply[] = [calls(...[17, 18, 19, 20].map((n) => finding(`new claim ${n} holds`, ["c1"]))), out("second")];
  await go(sixteen(pass));
  const [d1, d2] = f.s.state.drafts;
  expect(d1!.product.key_findings).toHaveLength(16);
  expect(d2!.product.key_findings.map((x) => x.id)).toEqual(["f17", "f18", "f19", "f20"]);
  expect(d2!.product.key_findings.map((x) => x.statement).join(" ")).not.toContain("device");
  expect(d2!.product.summary).toBe("all clear");
  expect(ofType("assessment.made").filter((e) => e.payload.draft_hash === d2!.hash).map((e) => e.payload.finding.id)).toEqual(["f17", "f18", "f19", "f20"]);
  // the pack shows the previous draft's findings as reference, f7 among them
  const sent = requestText("analyst", 0);
  expect(sent).toContain("restate the ones you keep");
  expect(sent).toContain("We judge that the device likely connected to the address.");
});

test("a finding of the previous draft is kept only when it is proposed again in the pass, by id, the latest proposal winning", async () => {
  const pass: ScriptReply[] = [calls(
    finding("old claim 3 holds, restated", ["c1"], { replaces: "f3" }), finding("a new claim holds", ["c1"]), finding("old claim 3 holds, restated again", ["c1"], { replaces: "f3" }),
  ), out("second")];
  await go(sixteen(pass));
  const d2 = f.s.state.drafts[1]!;
  expect(d2.product.key_findings.map((x) => [x.id, x.statement])).toEqual([
    ["f3", "We assess it is likely that old claim 3 holds, restated again."], ["f17", "We assess it is likely that a new claim holds."],
  ]);
});

test("a revision keeps the cards a carried-over section cited by tool only", async () => {
  const first: ScriptReply[] = [calls(finding("it is internal", ["c1"]), section("summary", "all clear", ["c2"])), out("first")];
  const r = rig({ analyst: [...first, ...SECOND], evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  r.checks.fail = 1;
  await go(r);
  const [d1, d2] = f.s.state.drafts;
  expect(d1!.cited).toEqual(["c1", "c2"]);
  expect(d2!.product.summary).toBe("all clear");
  expect(d2!.product.key_findings.flatMap((x) => x.cites)).toEqual(["c1"]);
  expect(d2!.cited).toEqual(["c1", "c2"]);
  const prov = JSON.parse(buildBundle(f.s, d2!, { title: "t", note: "" }, f.s.head(), 1).files["provenance.json"]!) as { card: string }[];
  expect(prov.map((p) => p.card)).toEqual(["c1", "c2"]);
});

test("a revision that rewrites every section does not carry their old cards", async () => {
  const first: ScriptReply[] = [calls(finding("it is internal", ["c1"]), section("summary", "all clear", ["c2"])), out("first")];
  const second: ScriptReply[] = [calls(finding("it is internal", ["c1"], { replaces: "f1" }), ...["summary", "gaps_and_limits", "alternatives", "assessment"].map((s) => section(s, "rewritten"))), out("second")];
  const r = rig({ analyst: [...first, ...second], evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  r.checks.fail = 1;
  await go(r);
  expect(f.s.state.drafts[1]!.cited).toEqual(["c1"]);
});

test("the analyst is told what failed", async () => {
  const r = rig({ analyst: [...FIRST, ...SECOND], evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  r.checks.fail = 1;
  await go(r);
  expect(requestText("analyst", 0)).not.toContain("f1 cites too little");
  expect(requestText("analyst", 2)).toContain("f1 cites too little");
});

test("a request for research sends the run back to Research with no draft written", async () => {
  const ask: ScriptReply[] = [calls(call("request_research", { question: "Which accounts used ws-17?" })), out("none")];
  const r = rig({ analyst: [...ask, ...FIRST], evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  await go(r);
  expect(r.log.slice(0, 5)).toEqual(["frame", "plan", "research", "assemble", "research"]);
  expect(finished("assemble")[0]!.payload).toMatchObject({ outcome: "fail", draft_hash: null, reason: "more research is needed: Which accounts used ws-17?" });
  expect(ofType("research.requested")).toHaveLength(1);
  expect(f.s.state.drafts).toHaveLength(1);
  expect(f.s.state.drafts[0]!.reason).toBe("first draft");
});

test("the analyst never keeps, moves or discards a card", async () => {
  const r = rig({ analyst: [...FIRST, ...SECOND], evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  r.checks.fail = 1;
  await go(r);
  const bad = f.s.entries().filter((e) => e.actor.kind === "agent" && ["card.kept", "card.moved", "card.discarded"].includes(e.type));
  expect(bad).toEqual([]);
  expect(Object.values(f.s.state.cards).every((c) => c.place === "incoming")).toBe(true);
});

test("Evaluate records its verdict against the hash it examined", async () => {
  const r = rig({ analyst: FIRST, evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  await go(r);
  const d = f.s.state.drafts[0]!;
  const ev = ofType("evaluation.made");
  expect(ev).toHaveLength(1);
  expect(ev[0]!.payload).toEqual({ draft_hash: d.hash, pass: true, findings: [] });
  expect(ev[0]!.actor).toMatchObject({ kind: "agent", id: "evaluator", stage: "evaluate" });
  expect(finished("evaluate")[0]!.payload).toMatchObject({ outcome: "pass", draft_hash: d.hash });
  expect(f.s.state.reviews[d.hash]!.passed_stages).toContain("evaluate");
  // the draft and its cited cards were shown to the evaluator
  expect(requestText("evaluator", 0)).toContain("it talks to the proxy");
  expect(requestText("evaluator", 0)).toContain("ws-17 talks to the proxy");
});

test("a failed evaluation sends the draft back to Assemble with the finding as the reason", async () => {
  const bad = say({ pass: false, findings: [{ check: "support", where: "f1", message: "f1 is not supported by c1" }, { check: "support", where: "f2", message: "second" }] });
  const r = rig({ analyst: [...FIRST, ...SECOND], evaluator: [bad, EVAL_PASS], adversary: [CHALLENGE_PASS] });
  await go(r);
  expect(finished("evaluate")[0]!.payload).toMatchObject({ outcome: "fail", draft_hash: f.s.state.drafts[0]!.hash, reason: "f1 is not supported by c1" });
  expect(ofType("stage.sent_back").map((e) => e.payload)).toEqual([{ from: "evaluate", to: "assemble", reason: "f1 is not supported by c1", count: 1 }]);
  expect(f.s.state.drafts[1]!.reason).toBe("revised after Evaluate: f1 is not supported by c1");
  expect(requestText("analyst", 2)).toContain("f1 is not supported by c1");
  expect(f.s.state.reviews[f.s.state.drafts[0]!.hash]!.evaluation!.pass).toBe(false);
  expect(f.s.state.reviews[f.s.state.drafts[1]!.hash]!.evaluation!.pass).toBe(true);
});

test("an evaluation that fails with no finding pauses the run", async () => {
  const r = rig({ analyst: FIRST, evaluator: [say({ pass: false, findings: [] })] });
  const sum = await go(r);
  expect(sum).toMatchObject({ status: "paused", pause_reason: "Evaluate failed the draft without saying why" });
  expect(finished("evaluate")).toEqual([]);
});

test("a must-address challenge sends the draft back; a consider challenge does not", async () => {
  const consider = calls(call("raise_challenge", { severity: "consider", text: "the proxy is shared", cites: ["c2"] }));
  const must = calls(call("raise_challenge", { severity: "must_address", text: "the asset record may be stale", cites: ["c1"] }));
  const r = rig({ analyst: [...FIRST, ...SECOND], evaluator: [EVAL_PASS], adversary: [consider, CHALLENGE_PASS] });
  await go(r);
  expect(finished("challenge").map((e) => e.payload.outcome)).toEqual(["pass"]);
  expect(f.s.state.drafts).toHaveLength(1);
  expect(f.s.state.challenges.x1).toMatchObject({ severity: "consider", status: "open" });
  expect(ofType("challenge.raised")[0]!.actor).toMatchObject({ kind: "agent", id: "adversary" });
  expect(f.s.state.challenges.x1!.draft_hash).toBe(f.s.state.drafts[0]!.hash);
});

test("a must-address challenge fails the stage on that draft", async () => {
  const must = calls(call("raise_challenge", { severity: "must_address", text: "the asset record may be stale", cites: ["c1"] }));
  const r = rig({ analyst: [...FIRST, ...SECOND_ANSWERING], evaluator: [EVAL_PASS, EVAL_PASS], adversary: [must, CHALLENGE_PASS, CHALLENGE_PASS] });
  await go(r);
  expect(finished("challenge")[0]!.payload).toMatchObject({ outcome: "fail", draft_hash: f.s.state.drafts[0]!.hash, reason: "challenge x1 must be addressed: the asset record may be stale" });
  expect(ofType("stage.sent_back")[0]!.payload).toMatchObject({ from: "challenge", to: "assemble" });
  expect(f.s.state.drafts[1]!.reason).toBe("revised after Challenge: challenge x1 must be addressed: the asset record may be stale");
  expect(requestText("analyst", 2)).toContain("x1");
  expect(requestText("analyst", 2)).toContain("must_address");
  expect(requestText("analyst", 2)).toContain("the asset record may be stale");
});

test("an answered challenge no longer blocks the same draft", async () => {
  const must = calls(call("raise_challenge", { severity: "must_address", text: "the asset record may be stale", cites: ["c1"] }));
  // rebutted, and the draft is not changed (its findings are restated as they were): the same hash goes back to the adversary, who raises nothing more
  const rebut: ScriptReply[] = [calls(
    finding("it is internal", ["c1"], { replaces: "f1" }), finding("it talks to the proxy", ["c2"], { replaces: "f2" }),
    call("answer_challenge", { challenge: "x1", answer: "the record is from this week", action: "rebutted" }),
  ), out("first")];
  const r = rig({ analyst: [...FIRST, ...rebut], evaluator: [EVAL_PASS], adversary: [must, CHALLENGE_PASS, CHALLENGE_PASS] });
  const sum = await go(r);
  expect(sum).toMatchObject({ status: "waiting", waiting: "publish" });
  const [d1, d2] = f.s.state.drafts;
  expect(d2!.hash).toBe(d1!.hash);
  expect(f.s.state.challenges.x1).toMatchObject({ status: "answered", action: "rebutted" });
  expect(finished("challenge").map((e) => e.payload.outcome)).toEqual(["fail", "pass"]);
  expect(blockers(f.s.state, d2!.hash)).toEqual([]);
  expect(publishable(f.s.state, d2!.hash)).toBe(true);
});

test("an edit made while Evaluate is running is reviewed from Checks, and the old verdict stays on the old hash", async () => {
  let edited = false;
  let engine: Engine | null = null;
  const evaluate: StageRunner = async (env) => {
    r.log.push("evaluate");
    const running = evaluateRunner(env);
    // the runner has pinned the draft it examines before its first wait; a person now edits the draft
    if (!edited) {
      edited = true;
      const base = latestDraft(f.s.state)!.product;
      engine!.revise({ product: { ...base, summary: "all clear, after review" }, reason: "tightened the summary", actor: person });
    }
    return running;
  };
  const r = rig({ analyst: FIRST, evaluator: [EVAL_PASS, EVAL_PASS], adversary: [CHALLENGE_PASS] }, { evaluate: (env) => evaluate(env) });
  engine = r.engine;
  const sum = await go(r);
  const [d1, d2] = f.s.state.drafts;
  expect(f.s.state.drafts).toHaveLength(2);
  expect(d2!.author).toEqual(person);
  expect(f.s.state.reviews[d1!.hash]!.evaluation).toEqual({ pass: true, findings: [] });
  expect(f.s.state.reviews[d1!.hash]!.passed_stages).toContain("evaluate");
  expect(ofType("evaluation.made").map((e) => e.payload.draft_hash)).toEqual([d1!.hash, d2!.hash]);
  expect(r.log).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "checks", "evaluate", "challenge", "publish"]);
  expect(sum).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(f.s.state.reviews[d2!.hash]!.passed_stages.slice(0, 3)).toEqual(["checks", "evaluate", "challenge"]);
  expect(f.s.state.run.sendbacks).toEqual({});
  expect(ofType("stage.sent_back")).toEqual([]);
});

test("an edit made while Evaluate is failing the draft sends the run to Checks, not back to Assemble, and the failed verdict stays on the old hash", async () => {
  let edited = false;
  let engine: Engine | null = null;
  const evaluate: StageRunner = async (env) => {
    r.log.push("evaluate");
    const running = evaluateRunner(env);
    if (!edited) {
      edited = true;
      engine!.revise({ product: { ...latestDraft(f.s.state)!.product, summary: "edited meanwhile" }, reason: "wording", actor: person });
    }
    return running;
  };
  const bad = say({ pass: false, findings: [{ check: "support", where: "f1", message: "f1 is not supported by c1" }] });
  const r = rig({ analyst: FIRST, evaluator: [bad, EVAL_PASS], adversary: [CHALLENGE_PASS] }, { evaluate: (env) => evaluate(env) });
  engine = r.engine;
  const sum = await go(r);
  const [d1, d2] = f.s.state.drafts;
  expect(f.s.state.drafts).toHaveLength(2);
  expect(f.s.state.reviews[d1!.hash]!.evaluation!.pass).toBe(false);
  expect(finished("evaluate")[0]!.payload).toMatchObject({ outcome: "fail", draft_hash: d1!.hash });
  expect(ofType("stage.sent_back")).toEqual([]);
  expect(r.log).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "checks", "evaluate", "challenge", "publish"]);
  expect(sum).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(f.s.state.reviews[d2!.hash]!.evaluation!.pass).toBe(true);
});

test("Assemble, Evaluate and Challenge stall without a schema", async () => {
  const { pipeline } = loadPipeline(f.sample.registry);
  for (const [role, run] of [["assemble", assembleRunner], ["evaluate", evaluateRunner], ["challenge", challengeRunner]] as const) {
    const stage = { ...pipeline!.stages.find((s) => s.role === role)!, schema: null };
    const end = await run({ session: f.s, deps: rig({}).engine as never, stage, attempt: 1, onNeedsBudget: async () => null });
    expect(end).toEqual({ kind: "stalled", reason: `stage ${role} has no output schema` });
  }
});

test("a loop of Challenge failing back to Assemble ends at the send-back cap or the five-run pause, within 20 stage runs", async () => {
  let n = 0;
  const assemble: StageRunner = async () => {
    n++;
    const d = latestDraft(f.s.state);
    const base = d?.product ?? { objective: "", question: "a", marking: "TLP:GREEN" as const, summary: "", key_findings: [], gaps_and_limits: "", alternatives: "", assessment: "", sources: [], assumptions: [], change: "" };
    const product = { ...base, change: `v${n}` };
    const hash = sha256Hex(canonical(product as unknown as Json));
    f.s.commit((s) => [{ type: "draft.revised", actor: planner, payload: { draft: { n: s.drafts.length + 1, hash, author: planner, product, reason: "again" } } }]);
    return { ...PASS, draft_hash: hash };
  };
  const challenge: StageRunner = async () => ({ kind: "finished", outcome: "fail", draft_hash: latestDraft(f.s.state)!.hash, output: null, reason: "still not answered" });
  const evaluate: StageRunner = async () => ({ ...PASS, draft_hash: latestDraft(f.s.state)!.hash });
  const r = rig({}, { assemble, evaluate, challenge });
  const sum = await go(r);
  expect(sum.status).toBe("paused");
  expect(sum.pause_reason).toMatch(/has sent work back to Assemble 3 times|has run 5 times/);
  // 20 stage runs after the first three stages
  expect(ofType("stage.started").length - 3).toBeLessThanOrEqual(20);
});

const MUST = calls(call("raise_challenge", { severity: "must_address", text: "the asset record may be stale", cites: ["c1"] }));

test("Assemble fails when a must-address challenge is still open after its loop, and writes no draft", async () => {
  const r = rig({ analyst: [...FIRST, ...SECOND, ...SECOND_ANSWERING], evaluator: [EVAL_PASS, EVAL_PASS], adversary: [MUST, CHALLENGE_PASS, CHALLENGE_PASS] });
  const sum = await go(r);
  expect(finished("assemble").map((e) => e.payload.outcome)).toEqual(["pass", "fail", "pass"]);
  expect(finished("assemble")[1]!.payload).toMatchObject({ draft_hash: null, reason: "challenge x1 is still open" });
  expect(sum).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(f.s.state.drafts).toHaveLength(2);
  expect(f.s.state.challenges.x1!.status).toBe("answered");
});

test("a revision that ignores an open must-address challenge on an earlier draft is not publishable, and the run does not reach the gate", async () => {
  const r = rig({ analyst: FIRST, evaluator: [EVAL_PASS, EVAL_PASS], adversary: [CHALLENGE_PASS, CHALLENGE_PASS] });
  await go(r);
  const d1 = latestDraft(f.s.state)!;
  f.s.commit((_s, ids) => [{ type: "challenge.raised", actor: { kind: "agent", id: "adversary", stage: "challenge", profile: "investigation", model: "m", effort: null, where: "machine" }, payload: { challenge: { id: ids.next("challenge"), draft_hash: d1.hash, severity: "must_address", text: "stale record", cites: [] } } }]);
  const d2 = r.engine.revise({ product: { ...d1.product, summary: "edited" }, reason: "wording", actor: person });
  expect(blockers(f.s.state, d2.hash)).toContain("Challenge x1 must be addressed");
  expect(publishable(f.s.state, d2.hash)).toBe(false);
  const sum = await r.engine.advance();
  expect(sum.status).toBe("paused");
  expect(sum.pause_reason).toContain("Challenge x1 must be addressed");
  expect(sum.waiting).toBeNull();
});

test("the adversary is shown every challenge raised in this run, with its status and answer", async () => {
  const r = rig({ analyst: [...FIRST, ...SECOND_ANSWERING], evaluator: [EVAL_PASS, EVAL_PASS], adversary: [MUST, CHALLENGE_PASS, CHALLENGE_PASS] });
  await go(r);
  expect(f.s.state.drafts).toHaveLength(2);
  const second = requestText("adversary", 2);
  expect(second).toContain("x1");
  expect(second).toContain("the asset record may be stale");
  expect(second).toContain("f1 now says the record is managed");
  expect(second).toContain("answered");
});

test("a person answers a challenge through the engine; an agent or a closed challenge is refused", async () => {
  const r = rig({ analyst: FIRST, evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  await go(r);
  const d1 = latestDraft(f.s.state)!;
  f.s.commit((_s, ids) => [{ type: "challenge.raised", actor: planner, payload: { challenge: { id: ids.next("challenge"), draft_hash: d1.hash, severity: "must_address", text: "t", cites: [] } } }]);
  expect(() => r.engine.answerChallenge(planner, "x1", "a", "rebutted")).toThrow(ReviseRefused);
  expect(() => r.engine.answerChallenge(person, "x9", "a", "rebutted")).toThrow(ReviseRefused);
  r.engine.answerChallenge(person, "x1", "the record is current", "rebutted");
  expect(f.s.state.challenges.x1).toMatchObject({ status: "answered", answer: "the record is current", action: "rebutted" });
  expect(f.s.entries().filter((e) => e.type === "challenge.answered").at(-1)!.actor).toEqual(person);
  expect(() => r.engine.answerChallenge(person, "x1", "again", "rebutted")).toThrow(ReviseRefused);
});

test("a person's edit does not close an open challenge", async () => {
  const r = rig({ analyst: FIRST, evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  await go(r);
  const d1 = latestDraft(f.s.state)!;
  f.s.commit((_s, ids) => [{ type: "challenge.raised", actor: planner, payload: { challenge: { id: ids.next("challenge"), draft_hash: d1.hash, severity: "consider", text: "t", cites: [] } } }]);
  r.engine.revise({ product: { ...d1.product, summary: "edited" }, reason: "wording", actor: person });
  expect(f.s.state.challenges.x1!.status).toBe("open");
});

/** A red card c3 that no draft cites, which the adversary reads before it raises x1. */
const redCard = (): void => {
  f.s.commit((_st, ids) => [{ type: "card.created", actor: person, payload: { card: card(ids.next("card"), { title: "Secret record", body: "the red detail", source: "assets", marking: "TLP:RED" }) } }]);
};
const READ_RED = calls(call("read_card", { card: "c3" }));

test("a challenge raised after reading a red card is as red in the adversary's later pack", async () => {
  const r = rig({ analyst: [...FIRST, ...SECOND_ANSWERING], evaluator: [EVAL_PASS, EVAL_PASS], adversary: [READ_RED, MUST, CHALLENGE_PASS, CHALLENGE_PASS] });
  cards();
  redCard();
  r.engine.start(person);
  await r.engine.advance();
  accept();
  await r.engine.advance();
  const requests = ofType("model.request");
  const adversary = requests.filter((e) => e.actor.id === "adversary");
  // the reply that raised x1 answered a request made after the red card was read
  expect(adversary[1]!.payload.marking).toBe("TLP:RED");
  // the second Challenge run is shown x1, so it is red though the draft it reviews is amber
  expect(requestText("adversary", 3)).toContain("the asset record may be stale");
  expect(adversary[3]!.payload.marking).toBe("TLP:RED");
  expect(adversary[3]!.payload.pack.find((i) => i.id === "earlier-challenges")).toBeDefined();
});

test("under a pack limit the must-fix note holding a red challenge is not sent: the analyst's call is blocked", async () => {
  const r = rig({ analyst: [...FIRST, ...SECOND_ANSWERING], evaluator: [EVAL_PASS], adversary: [READ_RED, MUST, CHALLENGE_PASS] });
  cards();
  redCard();
  r.engine.setPackLimit("assemble", "TLP:AMBER", person);
  r.engine.start(person);
  await r.engine.advance();
  accept();
  const sum = await r.engine.advance();
  const analyst = ofType("model.request").filter((e) => e.actor.id === "analyst");
  // the first Assemble ran under the limit with the red card left out; the second would have carried x1's text
  expect(analyst).toHaveLength(2);
  expect(analyst[0]!.payload.left_out.map((i) => i.id)).toContain("c3");
  for (const e of analyst) expect(f.s.blobs.text(e.payload.messages.blob)).not.toContain("the asset record may be stale");
  expect(ofType("model.blocked").at(-1)!.payload).toMatchObject({ stage: "assemble", marking: "TLP:RED" });
  expect(sum.status).toBe("paused");
  expect(sum.pause_reason).toContain("TLP:RED");
});

test("Research's output is as strict as the requests its researchers made: under a pack limit it is left out", async () => {
  const researcher = { kind: "agent", id: "researcher-g1", stage: "research", profile: "investigation", model: "m", effort: null, where: "machine" } as const;
  const output = { subgoals: [{ id: "g1", title: "Is it internal", outcome: "answered", cards: ["c1"], note: "the red detail says so" }], requested: [] };
  const r = rig({ analyst: FIRST, evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] }, {
    research: async () => {
      // what a researcher that had read a red card asked its model
      f.s.commit((st, ids) => [{
        type: "model.request", actor: researcher, run: st.run.id, stage: "research",
        payload: { request: ids.next("request"), provider: "scripted", model: "m", effort: null, where: "machine", marking: "TLP:RED", pack: [], left_out: [], messages: f.s.blobs.put("[]"), tools: [] },
      }]);
      return { ...PASS, output: output as unknown as Json };
    },
  });
  r.engine.setPackLimit("assemble", "TLP:AMBER", person);
  await go(r);
  const first = ofType("model.request").find((e) => e.actor.id === "analyst")!;
  expect(first.payload.left_out.map((i) => i.id)).toContain("research-output");
  expect(f.s.blobs.text(first.payload.messages.blob)).not.toContain("the red detail says so");
});

test("Assemble writes no draft after the run was stopped while its model was answering", async () => {
  const r = rig({ analyst: FIRST, evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  let stopSeq = 0;
  afterTurn = (n, actor) => {
    if (actor !== "analyst" || n !== 2) return;
    r.engine.stop(person, "enough");
    stopSeq = f.s.head().seq;
  };
  const sum = await go(r);
  expect(stopSeq).toBeGreaterThan(0);
  expect(sum).toMatchObject({ status: "finished", outcome: "stopped" });
  // the model's answer is still recorded as what happened; nothing it led to is
  const after = f.s.entries().filter((e) => e.seq > stopSeq).map((e) => e.type);
  expect(after.filter((t) => t === "draft.revised" || t === "assessment.made")).toEqual([]);
  expect(after).not.toContain("stage.finished");
  expect(f.s.state.drafts).toEqual([]);
});

test("Evaluate writes no verdict after the run was stopped while its model was answering", async () => {
  const r = rig({ analyst: FIRST, evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  let stopSeq = 0;
  afterTurn = (_n, actor) => { if (actor === "evaluator") { r.engine.stop(person, "enough"); stopSeq = f.s.head().seq; } };
  const sum = await go(r);
  expect(stopSeq).toBeGreaterThan(0);
  expect(sum).toMatchObject({ status: "finished", outcome: "stopped" });
  const after = f.s.entries().filter((e) => e.seq > stopSeq).map((e) => e.type);
  expect(after).not.toContain("evaluation.made");
  expect(after).not.toContain("stage.finished");
});
