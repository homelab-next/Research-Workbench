import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import type { TurnRequest } from "../../src/agents/providers/types";
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
beforeEach(() => { afterTurn = null; structured = false; formats.length = 0; f = fixture(false); dir = mkdtempSync(join(tmpdir(), "analysis-")); });
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
/** The four sections the checks require, each written. */
const FILL = ["summary", "gaps_and_limits", "alternatives", "assessment"].map((x) => section(x, "stated"));
/** Draft 1: two findings and a summary. */
const FIRST: ScriptReply[] = [calls(finding("it is internal", ["c1"]), finding("it talks to the proxy", ["c2"]), section("summary", "all clear", ["c1"]), ...["gaps_and_limits", "alternatives", "assessment"].map((x) => section(x, "stated"))), out("first")];
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
/** When true, the scripted provider says it takes structured output, so a re-ask carries the schema as `response_format`. */
let structured = false;
/** The response_format of each request the scripted provider was sent, with the asking actor. */
const formats: { actor: string; format: TurnRequest["response_format"] | null }[] = [];
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
  if (structured) Object.assign(scripted, { structured_output: true });
  scripted.turn = async (req) => { formats.push({ actor: req.key, format: req.response_format ?? null }); const got = await real(req); afterTurn?.(++turns_, req.key); return got; };
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

test("an answer with an empty required section is re-asked naming it, and the stage finishes once it is written", async () => {
  const partial: ScriptReply[] = [calls(finding("it is internal", ["c1"]), section("summary", "all clear"), section("gaps_and_limits", "none"), section("assessment", "internal")), out("first"), calls(section("alternatives", "a misconfigured proxy")), out("first")];
  const r = rig({ analyst: partial, evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  await go(r);
  const reask = (JSON.parse(requestText("analyst", 2)) as { messages: { role: string; content: string }[] }).messages.at(-1)!;
  expect(reask).toEqual({ role: "user", content: "The draft still has no alternatives; propose them with propose_narrative, then answer" });
  // the request after the re-ask forces propose_narrative, its section narrowed to the one missing
  const forced = JSON.parse(requestText("analyst", 2)) as { tool_choice: unknown; tools: { name: string; parameters: { properties: { section?: { enum: string[] } } } }[] };
  expect(forced.tool_choice).toEqual({ type: "function", function: { name: "propose_narrative" } });
  expect(forced.tools.find((t) => t.name === "propose_narrative")!.parameters.properties.section!.enum).toEqual(["alternatives"]);
  expect(finished("assemble")[0]!.payload).toMatchObject({ outcome: "pass" });
  expect(f.s.state.drafts[0]!.product.alternatives).toBe("a misconfigured proxy");
});

test("an answer with no finding is re-asked for findings, and one still incomplete after the re-ask stalls the stage", async () => {
  const bare: ScriptReply[] = [calls(...["summary", "gaps_and_limits", "assessment"].map((x) => section(x, "stated"))), out("first"), out("first")];
  const r = rig({ analyst: bare, evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  const sum = await go(r);
  const reask = (JSON.parse(requestText("analyst", 2)) as { messages: { role: string; content: string }[] }).messages.at(-1)!;
  expect(reask.content).toStartWith("The draft still has no alternatives, findings;");
  expect(sum.status).not.toBe("waiting");
  expect(f.s.state.drafts).toHaveLength(0);
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
      objective: "o", question: "q", marking: "TLP:GREEN", summary: "all clear", key_findings: findings, gaps_and_limits: "g", alternatives: "a", assessment: "s",
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
  const first: ScriptReply[] = [calls(finding("it is internal", ["c1"]), section("summary", "all clear", ["c2"]), ...["gaps_and_limits", "alternatives", "assessment"].map((x) => section(x, "stated"))), out("first")];
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
  const first: ScriptReply[] = [calls(finding("it is internal", ["c1"]), section("summary", "all clear", ["c2"]), ...["gaps_and_limits", "alternatives", "assessment"].map((x) => section(x, "stated"))), out("first")];
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

/** A draft whose one finding cites c1 and whose gaps_and_limits names c2 and c3; `assessment` is the text of its assessment section. */
const CITING_GAPS = (assessment = "stated"): ScriptReply[] => [
  calls(finding("it is internal", ["c1"]), section("summary", "all clear", ["c1"]), section("gaps_and_limits", "c2 and c3 were empty [c2, c3]"), section("alternatives", "stated"), section("assessment", assessment)),
  out("first"),
];
/** The ids of the cards in the pack of the first request the named stage made. */
const packCards = (stage: string): string[] =>
  ofType("model.request").filter((e) => e.actor.kind === "agent" && e.actor.stage === stage)[0]!.payload.pack.filter((i) => i.kind === "card").map((i) => i.id);
/** cards() and a third, c3. */
function threeCards(): void {
  f.s.commit((_st, ids) => [{ type: "card.created", actor: person, payload: { card: card(ids.next("card"), { title: "Leases", body: "no lease", source: "assets", marking: "TLP:GREEN" }) } }]);
}

test("Evaluate's pack holds a card the draft cites only in Gaps and limits", async () => {
  const r = rig({ analyst: CITING_GAPS(), evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  cards();
  threeCards();
  r.engine.start(person);
  await r.engine.advance();
  accept();
  await r.engine.advance();
  expect(packCards("evaluate")).toEqual(["c1", "c2", "c3"]);
});

test("Challenge's pack holds the same cards, the findings' cards first", async () => {
  // the finding cites c3 and the gaps name c1 and c2, so citedOf's sorted order would put c3 last
  const r = rig({ analyst: [calls(finding("it is internal", ["c3"]), section("summary", "all clear", ["c3"]), section("gaps_and_limits", "c1 and c2 were empty [c1, c2]"), section("alternatives", "stated"), section("assessment", "stated")), out("first")], evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  cards();
  threeCards();
  r.engine.start(person);
  await r.engine.advance();
  accept();
  await r.engine.advance();
  expect(packCards("challenge")).toEqual(["c3", "c1", "c2"]);
  expect(packCards("evaluate")).toEqual(["c3", "c1", "c2"]);
});

test("a cited card left out of a reviewer's pack for size is named in its task", async () => {
  const r = rig({ analyst: CITING_GAPS(), evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  cards();
  f.s.commit((_st, ids) => [{ type: "card.created", actor: person, payload: { card: card(ids.next("card"), { title: "Leases", body: "no lease ".repeat(25_000), source: "assets", marking: "TLP:GREEN" }) } }]);
  r.engine.start(person);
  await r.engine.advance();
  accept();
  await r.engine.advance();
  expect(packCards("evaluate")).toEqual(["c1", "c2"]);
  const line = "Cited by the draft but left out of your context: c3. Read one you need with read_card; do not judge what you have not read.";
  expect(requestText("evaluator", 0)).toContain(line);
  expect(requestText("adversary", 0)).toContain(line);
  expect(requestText("analyst", 0)).not.toContain("Cited by the draft but left out");
});

test("a cited card a person discarded after the draft is named as discarded in the reviewer's task", async () => {
  const r = rig({ analyst: CITING_GAPS(), evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] }, {
    checks: async () => {
      f.s.commit(() => [{ type: "card.discarded", actor: person, payload: { card: "c3" } }]);
      return { ...PASS, draft_hash: latestDraft(f.s.state)!.hash };
    },
  });
  cards();
  threeCards();
  r.engine.start(person);
  await r.engine.advance();
  accept();
  await r.engine.advance();
  const line = "Cited by the draft but discarded from the case: c3. Say so where a finding rests on them.";
  expect(requestText("evaluator", 0)).toContain(line);
  expect(requestText("adversary", 0)).toContain(line);
  expect(requestText("evaluator", 0)).not.toContain("no longer in the case");
});

test("a cited card that is no longer in the case is named in the reviewer's task", async () => {
  const r = rig({ analyst: CITING_GAPS("as c9 shows, it is internal"), evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  cards();
  threeCards();
  r.engine.start(person);
  await r.engine.advance();
  accept();
  await r.engine.advance();
  const line = "Cited by the draft but no longer in the case: c9. Say so; do not judge what they held.";
  expect(requestText("evaluator", 0)).toContain(line);
  expect(requestText("adversary", 0)).toContain(line);
  expect(packCards("evaluate")).toEqual(["c1", "c2", "c3"]);
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

// ---- the last two form failures (task 15 item 2) ----

const answer = (kind: string, assumptions: string[] = ["the records are current"]) => say({ done: true, change_kind: kind, change_detail: "detail", assumptions, note: "n" });
/** The change_kind enum of the output schema shown in the pack of the analyst's request `ordinal`. */
function packedKinds(ordinal: number): unknown {
  const system = (JSON.parse(requestText("analyst", ordinal)) as { messages: { content: string }[] }).messages[0]!.content;
  const part = system.split("## Assemble output\n")[1]!;
  const json = part.slice(part.indexOf("\n") + 1, part.indexOf("\nExample:"));
  return (JSON.parse(json) as { properties: { change_kind: { enum: unknown } } }).properties.change_kind.enum;
}
const structuredKinds = (): unknown[] => formats.filter((x) => x.actor === "analyst" && x.format !== null).map((x) => (x.format!.schema.properties!.change_kind as { enum: unknown }).enum);
const RULED_OUT = "nothing has been published in this case before, so the change is 'first judgment'";

test("with nothing published in the case, the answer schema allows only 'first judgment', in the pack and as structured output, and the re-ask says why", async () => {
  structured = true;
  const r = rig({ analyst: [FIRST[0]!, answer("consistent with"), answer("first judgment")], evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  expect(await go(r)).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(packedKinds(0)).toEqual(["first judgment"]);
  expect(structuredKinds()).toEqual([["first judgment"]]);
  const reask = (JSON.parse(requestText("analyst", 2)) as { messages: { role: string; content: string }[] }).messages.at(-1)!;
  expect(reask.role).toBe("user");
  expect(reask.content).toContain(RULED_OUT);
  expect(f.s.state.drafts[0]!.product.change).toBe("First judgment: detail.");
});

test("once a judgment has been published in the case, the answer schema allows all three change kinds and the re-ask does not rule one out", async () => {
  structured = true;
  f.s.commit(() => [{ type: "product.published", actor: person, payload: { n: 1, draft_hash: "0".repeat(64), head_hash: "0".repeat(64), dir: "bundle-1", bundle: f.s.blobs.put("{}") } }]);
  const r = rig({ analyst: [FIRST[0]!, answer("consistent with", []), answer("consistent with")], evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  expect(await go(r)).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(packedKinds(0)).toEqual(["first judgment", "consistent with", "changes"]);
  expect(structuredKinds()).toEqual([["first judgment", "consistent with", "changes"]]);
  const reask = (JSON.parse(requestText("analyst", 2)) as { messages: { role: string; content: string }[] }).messages.at(-1)!;
  expect(reask.content).toStartWith("Your reply did not match the required output: assumptions ");
  expect(reask.content).not.toContain(RULED_OUT);
  expect(f.s.state.drafts[0]!.product.change).toBe("Consistent with detail.");
});

// ---- reviewers who disagree (task 17) ----

/** The ids of the parts in the pack of the actor's request `ordinal`. */
const packIds = (actor: string, ordinal: number): string[] => ofType("model.request").filter((e) => e.actor.id === actor)[ordinal]!.payload.pack.map((i) => i.id);
/** Draft 3: f1 reworded again. */
const THIRD: ScriptReply[] = [calls(finding("it is internal and managed by IT", ["c1"], { replaces: "f1" })), out("third")];
const EVAL_F1 = say({ pass: false, findings: [{ check: "support", where: "f1", message: "f1 is not supported by c1" }] });

test("the open review points of both reviewers are one list: Assemble sees each labelled by reviewer, with the analyst's earlier answers", async () => {
  // draft 1: Challenge raises x1; draft 2 answers it; Evaluate fails draft 2 on f1; draft 3 answers that
  const r = rig({ analyst: [...FIRST, ...SECOND_ANSWERING, ...THIRD], evaluator: [EVAL_PASS, EVAL_F1, EVAL_PASS], adversary: [MUST, CHALLENGE_PASS, CHALLENGE_PASS] });
  expect(await go(r)).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(f.s.state.drafts.map((d) => d.n)).toEqual([1, 2, 3]);
  // the third Assemble pass (requests 4 and 5)
  expect(packIds("analyst", 4)).toContain("review-points");
  const text = requestText("analyst", 4);
  expect(text).toContain("Open review points, by reviewer");
  expect(text).toContain("- Evaluate, on draft 2, at f1: f1 is not supported by c1");
  expect(text).toContain("- Challenge x1 (must_address, on draft 1): the asset record may be stale. Answered (revised): f1 now says the record is managed");
  // the first pass had nothing to answer
  expect(packIds("analyst", 0)).not.toContain("review-points");
});

test("Evaluate's pack carries Challenge's points with the analyst's answers, and Challenge's pack carries Evaluate's latest points with the analyst's answer", async () => {
  const r = rig({ analyst: [...FIRST, ...SECOND_ANSWERING, ...THIRD], evaluator: [EVAL_PASS, EVAL_F1, EVAL_PASS], adversary: [MUST, CHALLENGE_PASS, CHALLENGE_PASS] });
  await go(r);
  // Evaluate on draft 2 (its second request)
  expect(packIds("evaluator", 0)).not.toContain("other-review");
  expect(packIds("evaluator", 1)).toContain("other-review");
  const ev = requestText("evaluator", 1);
  expect(ev).toContain("Challenge's points and the analyst's answers");
  expect(ev).toContain("- Challenge x1 (must_address, on draft 1): the asset record may be stale. Answered (revised): f1 now says the record is managed");
  // Challenge on draft 3 (its third request)
  expect(packIds("adversary", 2)).toContain("other-review");
  const ch = requestText("adversary", 2);
  expect(ch).toContain("Evaluate's latest points and the analyst's answers");
  expect(ch).toContain("- Evaluate, on draft 2, at f1: f1 is not supported by c1. Answered in draft 3: f1 reworded");
});

// draft 1 says almost certain; Challenge says that overclaims; draft 2 lowers it to likely; Evaluate says likely understates it
const SURE: ScriptReply[] = [calls(finding("ws-17 held the address", ["c1"], { likelihood: "almost certain" }), ...FILL), out("first")];
const OVERCLAIMS = calls(call("raise_challenge", { severity: "must_address", text: "almost certain on f1 overclaims: one event", cites: ["c1"] }));
const LOWERED: ScriptReply[] = [calls(
  finding("ws-17 held the address", ["c1"], { likelihood: "likely", replaces: "f1" }),
  call("answer_challenge", { challenge: "x1", answer: "lowered f1 to likely", action: "revised" }),
), out("second")];
const UNDERSTATES = say({ pass: false, findings: [{ check: "support", where: "f1", message: "c1 shows the address directly, so likely understates it" }] });
const KEPT: ScriptReply[] = [calls(finding("ws-17 held the address, seen once", ["c1"], { likelihood: "likely", replaces: "f1" })), out("third")];
const DISAGREE = "Evaluate and Challenge disagree on f1: Evaluate asks almost certain, Challenge asked lower";

test("reviewers who disagree: the engine does not send back; it pauses naming both positions and records the conflict", async () => {
  const r = rig({ analyst: [...SURE, ...LOWERED], evaluator: [EVAL_PASS, UNDERSTATES], adversary: [OVERCLAIMS, CHALLENGE_PASS] });
  const sends = (): number => ofType("stage.sent_back").length;
  const sum = await go(r);
  expect(sum).toMatchObject({ status: "paused", pause_reason: `${DISAGREE}. The person rules on it in the Narrative lens: follow one reviewer, or write a note.` });
  // the one send-back is Challenge's; Evaluate's was not made
  expect(ofType("stage.sent_back").map((e) => e.payload.from)).toEqual(["challenge"]);
  expect(sends()).toBe(1);
  const [c] = ofType("review.conflict");
  expect(c!.actor).toEqual({ kind: "system", id: "engine" });
  expect(c!.payload.conflict).toMatchObject({ id: "k1", finding: "f1", change: "likelihood", earlier: "almost certain", now: "likely", raised_by: "evaluate", changed_for: "challenge", reason: DISAGREE });
  // the conflict and the pause are one commit, in that order
  const paused = ofType("run.paused").at(-1)!;
  expect(paused.seq).toBe(c!.seq + 1);
  expect(f.s.state.conflicts.k1).toMatchObject({ run: f.s.state.run.id, ruling: null });
  // a resume without a ruling pauses again, and records nothing more
  await r.engine.resume(person);
  expect(r.engine.summary().status).toBe("paused");
  expect(ofType("review.conflict")).toHaveLength(1);
  expect(sends()).toBe(1);
});

test("the person's ruling is recorded in their name, goes to Assemble as a fixed ruling, and both reviewers see it", async () => {
  const r = rig({ analyst: [...SURE, ...LOWERED, ...KEPT], evaluator: [EVAL_PASS, UNDERSTATES, EVAL_PASS], adversary: [OVERCLAIMS, CHALLENGE_PASS, CHALLENGE_PASS] });
  await go(r);
  expect(() => r.engine.rule(planner, "k1", "challenge", "")).toThrow("only a person may rule on a conflict");
  expect(() => r.engine.rule(person, "k9", "challenge", "")).toThrow("there is no conflict k9");
  expect(() => r.engine.rule(person, "k1", "checks", "")).toThrow("a ruling follows Evaluate or Challenge, or gives a note");
  expect(() => r.engine.rule(person, "k1", null, " ")).toThrow("a ruling follows Evaluate or Challenge, or gives a note");
  r.engine.rule(person, "k1", "challenge", "one event is not enough for almost certain");
  expect(() => r.engine.rule(person, "k1", "evaluate", "")).toThrow("conflict k1 has already been ruled on");
  const ruled = ofType("review.ruled");
  expect(ruled.map((e) => [e.actor, e.payload])).toEqual([[person, { conflict: "k1", follow: "challenge", note: "one event is not enough for almost certain" }]]);
  // a ruling is not a gate pass: nothing moves until the run is resumed
  expect(r.engine.summary().status).toBe("paused");
  const sum = await r.engine.resume(person);
  expect(sum).toMatchObject({ status: "waiting", waiting: "publish" });
  const ruling = "f1: Evaluate and Challenge disagree on f1: Evaluate asks almost certain, Challenge asked lower. Ruled: follow Challenge: keep likely. Note: one event is not enough for almost certain";
  expect(ofType("stage.sent_back").at(-1)!.payload).toMatchObject({ from: "evaluate", to: "assemble", reason: `the person ruled on f1 (${DISAGREE}): follow Challenge: keep likely. Note: one event is not enough for almost certain` });
  // Assemble's third pass (requests 4 and 5), then Evaluate and Challenge on draft 3
  for (const [actor, ordinal] of [["analyst", 4], ["evaluator", 2], ["adversary", 2]] as const) {
    const text = requestText(actor, ordinal);
    expect(text).toContain("Rulings by the person (fixed; neither reviewer may reopen them)");
    expect(text).toContain(ruling);
  }
  expect(f.s.state.drafts.at(-1)!.product.key_findings[0]!.likelihood).toBe("likely");
  expect(ofType("review.conflict")).toHaveLength(1);
});

const FOUR = ["first judgment", "consistent with", "changes", "withdraws"];
const withFourTerms = (): void => { (f.sample.registry.get("standard", "icd203")!.body as { change_terms: string[] }).change_terms = [...FOUR]; };

test("the change kinds the answer schema allows are the standard's own terms: only the first before anything is published", async () => {
  withFourTerms();
  expect(readFileSync(join(import.meta.dir, "..", "..", "sample", "context", "schemas", "assemble-output.yaml"), "utf8")).not.toContain("consistent");
  structured = true;
  const r = rig({ analyst: [FIRST[0]!, answer("withdraws"), answer("first judgment")], evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  expect(await go(r)).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(packedKinds(0)).toEqual(["first judgment"]);
  expect(structuredKinds()).toEqual([["first judgment"]]);
});

test("the change kinds the answer schema allows are the standard's own terms: all of them once something is published", async () => {
  withFourTerms();
  structured = true;
  f.s.commit(() => [{ type: "product.published", actor: person, payload: { n: 1, draft_hash: "0".repeat(64), head_hash: "0".repeat(64), dir: "bundle-1", bundle: f.s.blobs.put("{}") } }]);
  const r = rig({ analyst: [FIRST[0]!, answer("withdraws", []), answer("withdraws")], evaluator: [EVAL_PASS], adversary: [CHALLENGE_PASS] });
  expect(await go(r)).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(packedKinds(0)).toEqual(FOUR);
  expect(structuredKinds()).toEqual([FOUR]);
  expect(f.s.state.drafts[0]!.product.change).toBe("Withdraws detail.");
});
