import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { blockers, gateChanges, latestDraft } from "../../src/core/state";
import type { Overrule } from "../../src/core/state";
import type { Actor, Draft, Entry, Finding, Product } from "../../src/core/types";
import { loadProfile } from "../../src/agents/context";
import { termsOf } from "../../src/agents/draft";
import { Providers } from "../../src/agents/providers";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import type { ScriptReply } from "../../src/agents/providers/scripted";
import { loadConfig } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnd, StageRunner } from "../../src/pipeline/engine";
import { loadPipeline } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { OverruleRefused, overruledFindings } from "../../src/pipeline/overrule";
import { assembleRunner } from "../../src/pipeline/stages/assemble";
import { card } from "../helpers/entries";
import { fixture, PLAN } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

const terms = termsOf(Bun.YAML.parse(readFileSync(join(import.meta.dir, "..", "..", "sample", "context", "standards", "icd203.yaml"), "utf8")))!;

const fnd = (id: string, likelihood: string, claim: string, over: Partial<Finding> = {}): Finding => ({
  id, statement: `We assess it is ${likelihood} that ${claim}.`, likelihood, confidence: "moderate", confidence_basis: "b", cites: ["c1"], assumptions: [], reasoning: "r", ...over,
});
const product = (findings: Finding[]): Product => ({
  objective: "o", question: "q", marking: "TLP:GREEN", summary: "s", key_findings: findings, gaps_and_limits: "", alternatives: "", assessment: "", sources: [], assumptions: [], change: "c",
});
const draft = (n: number, findings: Finding[]): Draft => {
  const p = product(findings);
  return { n, hash: sha256Hex(canonical(p as unknown as Json)), author: { kind: "system", id: "t" }, product: p, reason: "r" };
};
let seq = 100;
const ov = (finding: string, over: Partial<Overrule> = {}): Overrule => ({
  finding, draft_hash: "h", likelihood: null, confidence: null, stays: null, note: "It is the TV I installed.", by: "analyst", seq: seq++, ts: "t", ...over,
});

const F1 = fnd("f1", "roughly even chance", "the device is idle");
const F2 = fnd("f2", "likely", "it talks to the proxy", { cites: ["c2"] });
const fs = [F1, F2];
const drafts = [draft(1, fs)];

test("a set likelihood replaces the term in the field and in the statement", () => {
  const out = overruledFindings(fs, [ov("f1", { likelihood: "almost certain" })], drafts, terms, () => true);
  expect(out[0]).toMatchObject({ id: "f1", likelihood: "almost certain", statement: "We assess it is almost certain that the device is idle." });
  expect(out[1]).toEqual(F2);
});

test("a set confidence replaces the confidence and leaves the rest", () => {
  const out = overruledFindings(fs, [ov("f2", { confidence: "high" })], drafts, terms, () => true);
  expect(out).toEqual([F1, { ...F2, confidence: "high" }]);
});

test("a dropped finding is removed; a finding that must stay and is gone comes back from the latest draft that held it, after the others", () => {
  const F3 = fnd("f3", "unlikely", "it was sold");
  const older = draft(1, [F1, F2, fnd("f3", "likely", "it was sold")]);
  const newer = draft(2, [F1, F3]);
  const now = [F1];
  expect(overruledFindings(now, [ov("f1", { stays: false })], [older, newer], terms, () => true)).toEqual([]);
  const out = overruledFindings(now, [ov("f2", { stays: true }), ov("f3", { stays: true })], [older, newer], terms, () => true);
  // f2 from draft 1 (the only one that held it), f3 from draft 2 (the latest that held it), in overrule order
  expect(out).toEqual([F1, F2, F3]);
  // a set value keeps the finding too, and is applied to the restored one
  expect(overruledFindings(now, [ov("f2", { confidence: "low" })], [older, newer], terms, () => true)).toEqual([F1, { ...F2, confidence: "low" }]);
});

test("a restored finding loses its cites to cards that are discarded or gone", () => {
  const F4 = fnd("f4", "likely", "it was moved", { cites: ["c1", "c2", "c3"] });
  const out = overruledFindings([F1], [ov("f4", { stays: true })], [draft(1, [F1, F4])], terms, (id) => id === "c2");
  expect(out[1]).toEqual({ ...F4, cites: ["c2"] });
});

test("with no standard terms the statement is left as written and the likelihood field is set", () => {
  const out = overruledFindings(fs, [ov("f1", { likelihood: "sure" })], drafts, null, () => true);
  expect(out[0]).toEqual({ ...F1, likelihood: "sure" });
});

test("no overrule, a withdrawn one, and an overrule of a finding no draft held leave the findings as given", () => {
  expect(overruledFindings(fs, [], drafts, terms, () => true)).toEqual(fs);
  expect(overruledFindings(fs, [ov("f1")], drafts, terms, () => true)).toEqual(fs);
  expect(overruledFindings(fs, [ov("f9", { stays: true })], drafts, terms, () => true)).toEqual(fs);
});

test("the input is not changed, and the same input gives the same output", () => {
  const given = structuredClone(fs);
  const rules = [ov("f1", { likelihood: "almost certain", confidence: "high" }), ov("f2", { stays: false })];
  const ruleCopy = structuredClone(rules);
  const a = overruledFindings(given, rules, drafts, terms, () => true);
  const b = overruledFindings(given, rules, drafts, terms, () => true);
  expect(a).toEqual(b);
  expect(given).toEqual(fs);
  expect(rules).toEqual(ruleCopy);
  expect(a[0]).not.toBe(given[0]);
});

// ---- the command: the entry, and the person's revision or the send-back it brings ----

const person: Actor = { kind: "human", id: "analyst" };
const planner = { kind: "agent", id: "planner", stage: "plan", profile: "investigation", model: "m", effort: null, where: "machine" } as const;
const PASS: Extract<StageEnd, { kind: "finished" }> = { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
const say = (x: unknown): ScriptReply => ({ content: JSON.stringify(x) });
const call = (tool: string, args: Record<string, Json>): { tool: string; args: Record<string, Json> } => ({ tool, args: { why: "w", ...args } });
const calls = (...c: { tool: string; args: Record<string, Json> }[]): ScriptReply => ({ tool_calls: c });
const proposal = (claim: string, cites: string[], extra: Record<string, Json> = {}) =>
  call("propose_assessment", { claim, likelihood: "roughly even chance", confidence: "moderate", confidence_basis: "the record", cites, assumptions: [], reasoning: "matches", ...extra });
const out = (detail: string) => say({ done: true, change_kind: "first judgment", change_detail: detail, assumptions: ["the records are current"], note: "n" });
const FILL = ["summary", "gaps_and_limits", "alternatives", "assessment"].map((x) => call("propose_narrative", { section: x, text: "stated", cites: [] }));
/** Draft 1: f1 (the device is idle) and f2. */
const FIRST: ScriptReply[] = [calls(proposal("the device is idle", ["c1"]), proposal("it talks to the proxy", ["c2"], { likelihood: "likely" }), ...FILL), out("first")];
/** A later pass that proposes f1 again at roughly even chance, and leaves f2 out. */
const AGAIN: ScriptReply[] = [calls(proposal("the device is idle", ["c1"], { replaces: "f1" })), out("again")];
const NOTE = "It is the TV I installed.";

let f: Fixture;
let dir: string;
/** Called after each model answer, with the asking actor: a test uses it to act while the analyst is working. */
let afterTurn: ((actor: string) => void) | null = null;
beforeEach(() => { afterTurn = null; f = fixture(false); dir = mkdtempSync(join(tmpdir(), "overrule-")); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Rig { engine: Engine; deps: EngineDeps }
/** Real Assemble on a scripted analyst; stubs for the rest. */
function rig(analyst: ScriptReply[], over: Partial<Record<Role, StageRunner>> = {}): Rig {
  const s = f.s;
  const registry = f.sample.registry;
  const { pipeline, problems } = loadPipeline(registry);
  if (pipeline === null) throw new Error(problems.join("; "));
  const scripted = new ScriptedProvider({ id: "scripted", scripts: [{ id: "sample-run", turns: analyst.map((reply) => ({ actor: "analyst", reply })) }] });
  const real = scripted.turn.bind(scripted);
  scripted.turn = async (req) => { const got = await real(req); afterTurn?.(req.key); return got; };
  const deps: EngineDeps = {
    config: loadConfig({ env: {}, home: dir, repoRoot: dir }), registry, runner: f.sample.deps, seeker: f.sample.seeker,
    providers: new Providers([scripted]), pipeline, profile: loadProfile(registry, "investigation"),
  };
  const draftPass = (): StageEnd => ({ ...PASS, draft_hash: latestDraft(s.state)?.hash ?? null });
  const runners: Partial<Record<Role, StageRunner>> = {
    frame: async () => PASS,
    plan: async () => { s.commit((_st, ids) => [{ type: "plan.proposed", actor: planner, payload: { plan: PLAN(ids.next("plan")) } }]); return PASS; },
    research: async () => PASS,
    assemble: assembleRunner,
    checks: async () => draftPass(),
    evaluate: async () => draftPass(),
    challenge: async () => draftPass(),
    publish: async () => draftPass(),
    feedback: async () => PASS,
    ...over,
  };
  return { engine: new Engine(s, deps, { runners }), deps };
}
function cards(): void {
  f.s.commit((_st, ids) => [
    { type: "card.created", actor: person, payload: { card: card(ids.next("card"), { title: "Asset record", body: "ws-17 is a managed laptop", source: "assets", marking: "TLP:GREEN" }) } },
    { type: "card.created", actor: person, payload: { card: card(ids.next("card"), { title: "Proxy flows", body: "ws-17 talks to the proxy", source: "flows", marking: "TLP:GREEN" }) } },
  ]);
}
async function startRun(r: Rig) {
  r.engine.start(person);
  await r.engine.advance();
  f.s.commit(() => [
    { type: "plan.accepted", actor: person, payload: { plan: f.s.state.plan.current!.id, steps: ["s1"], budgets: {} } },
    { type: "gate.passed", actor: person, payload: { gate: "plan" } },
  ]);
  return r.engine.advance();
}
async function toGate(r: Rig): Promise<void> {
  cards();
  expect(await startRun(r)).toMatchObject({ status: "waiting", waiting: "publish" });
}
const ofType = <T extends Entry["type"]>(t: T): Extract<Entry, { type: T }>[] => f.s.entries().filter((e): e is Extract<Entry, { type: T }> => e.type === t);
const latest = (): Draft => latestDraft(f.s.state)!;
type In = Parameters<Engine["overrule"]>[0];
const input = (over: Partial<In> = {}): In => ({ actor: person, finding: "f1", draft_hash: latest().hash, likelihood: "almost certain", confidence: null, stays: null, note: NOTE, ...over });
/** The types of the entries written from `from` on. */
const since = (from: number): string[] => f.s.entries().filter((e) => e.seq > from).map((e) => e.type);

test("an overrule at the publish gate writes only finding.overruled and the run stays at the gate; a second overrule of the same draft is taken; Send back with my changes takes both to Assemble", async () => {
  // slice 10 (reverses controller ruling 6): a change at the gate sends nothing back by itself; the person sends the draft back with all their changes at once
  const r = rig([...FIRST, ...AGAIN]);
  await toGate(r);
  const head = f.s.head().seq;
  r.engine.overrule(input());
  expect(since(head)).toEqual(["finding.overruled"]);
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(f.s.state.drafts).toHaveLength(1);
  const [o] = ofType("finding.overruled");
  expect(o!.actor).toEqual(person);
  expect(o!.payload).toEqual({ finding: "f1", draft_hash: f.s.state.drafts[0]!.hash, likelihood: "almost certain", confidence: null, stays: null, note: NOTE });
  // the owner's second overrule, on the draft still on screen
  r.engine.overrule(input({ finding: "f2", likelihood: null, confidence: "high", note: "I saw the proxy log." }));
  expect(since(head)).toEqual(["finding.overruled", "finding.overruled"]);
  expect(f.s.state.run).toMatchObject({ waiting: "publish" });
  const mid = f.s.head().seq;
  r.engine.sendBackChanges(person, latest().hash);
  expect(since(mid)).toEqual(["stage.finished", "stage.sent_back", "case.phase_changed", "stage.started"]);
  const reason1 = `the person overruled f1: likelihood almost certain. Note: ${NOTE} Code holds f1 to it; rewrite f1's confidence_basis and reasoning to rest on the person's note.`;
  const reason2 = "the person overruled f2: confidence high. Note: I saw the proxy log. Code holds f2 to it; rewrite f2's confidence_basis and reasoning to rest on the person's note.";
  const reason = `${reason1}\n${reason2}`;
  const sentBack = ofType("stage.sent_back").at(-1)!;
  expect(sentBack.actor).toEqual(person);
  expect(sentBack.payload).toEqual({ from: "publish", to: "assemble", reason, count: 1 });
  expect(f.s.state.run).toMatchObject({ current: "assemble", waiting: null });
  // the gate's own stage no longer waits while Assemble works
  expect(f.s.state.run.stages.find((x) => x.id === "publish")!.status).not.toBe("waiting");
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  const d = latest();
  expect(d.n).toBe(2);
  // the new draft took both overrules in: neither is a change of the person's since it was made
  expect(gateChanges(f.s.state, f.s.entries())).toEqual([]);
  expect(d.reason).toBe(`revised after Publish: ${reason}`);
  expect(d.product.key_findings[0]).toMatchObject({ id: "f1", likelihood: "almost certain", statement: "We assess it is almost certain that the device is idle." });
  expect(blockers(f.s.state, d.hash)).toEqual([]);
});

/** Takes the run off the gate: paused, with Challenge started again on the latest draft and, when `failed`, failed on it. */
function offGate(failed: boolean): void {
  const engine = { kind: "system", id: "engine" } as const;
  f.s.commit((s) => [
    { type: "run.paused", actor: person, run: s.run.id, payload: { reason: "stop here" } },
    { type: "stage.started", actor: engine, run: s.run.id, stage: "challenge", payload: { stage: "challenge", attempt: 2 } },
    ...(failed ? [{ type: "stage.finished", actor: engine, run: s.run.id, stage: "challenge", payload: { stage: "challenge", attempt: 2, outcome: "fail", draft_hash: latest().hash, output: null, reason: "no" } } as const] : []),
  ]);
}

test("an overrule off the gate, on a stopped review, writes only finding.overruled; on resume the work goes back to Assemble with it as the reason (final review I4)", async () => {
  // controller ruling on I4: while a run is active the overrule sends the work back to Assemble when the current stage ends, as at the gate
  const r = rig([...FIRST, ...AGAIN]);
  await toGate(r);
  offGate(true);
  const head = f.s.head().seq;
  r.engine.overrule(input());
  expect(since(head)).toEqual(["finding.overruled"]);
  expect(await r.engine.resume(person)).toMatchObject({ status: "waiting", waiting: "publish" });
  const reason = `the person overruled f1: likelihood almost certain. Note: ${NOTE} Code holds f1 to it; rewrite f1's confidence_basis and reasoning to rest on the person's note.`;
  const back = ofType("stage.sent_back").filter((e) => e.seq > head);
  expect(back.map((e) => e.payload)).toEqual([{ from: "publish", to: "assemble", reason, count: 1 }]);
  const d = latest();
  expect(d).toMatchObject({ n: 2, author: { kind: "agent", id: "analyst" }, reason: `revised after Publish: ${reason}` });
  expect(d.product.key_findings[0]).toMatchObject({ id: "f1", likelihood: "almost certain", statement: "We assess it is almost certain that the device is idle." });
  expect(ofType("draft.revised").filter((e) => e.actor.kind === "human")).toEqual([]);
  expect(blockers(f.s.state, d.hash)).toEqual([]);
});

test("an overrule while a review stage works: that stage ends, then the work goes to Assemble with the overrule as the reason (final review I4)", async () => {
  let once = false;
  const r: Rig = rig([...FIRST, ...AGAIN], {
    checks: async () => {
      if (!once && f.s.state.drafts.length === 1) { once = true; r.engine.overrule(input({ likelihood: null, confidence: "high" })); }
      return { ...PASS, draft_hash: latestDraft(f.s.state)?.hash ?? null };
    },
  });
  await toGate(r);
  expect(once).toBe(true);
  const back = ofType("stage.sent_back").filter((e) => e.payload.to === "assemble");
  expect(back.map((e) => [e.payload.from, e.payload.reason.slice(0, 41)])).toEqual([["publish", "the person overruled f1: confidence high."]]);
  // Checks finished on draft 1 before the send-back
  const checksEnd = ofType("stage.finished").find((e) => e.payload.stage === "checks")!;
  expect(checksEnd.seq).toBeLessThan(back[0]!.seq);
  const d = latest();
  expect(d).toMatchObject({ n: 2, author: { kind: "agent", id: "analyst" } });
  expect(d.product.key_findings[0]).toMatchObject({ id: "f1", confidence: "high" });
});

test("an overrule while Assemble is working writes only finding.overruled; the draft Assemble then builds holds it, and Assemble is sent it once to rewrite the basis", async () => {
  const r = rig([...FIRST, ...AGAIN, ...AGAIN]);
  await toGate(r);
  r.engine.reject({ actor: person, reason: "look again", stop: false });
  let head = 0;
  afterTurn = () => {
    if (head !== 0) return;
    head = f.s.head().seq;
    r.engine.overrule(input({ likelihood: null, confidence: "high", stays: true }));
  };
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(f.s.entries().filter((e) => e.seq > head && e.seq <= head + 1).map((e) => e.type)).toEqual(["finding.overruled"]);
  expect(ofType("draft.revised").filter((e) => e.actor.kind === "human")).toEqual([]);
  const d = latest();
  expect(d.author).toMatchObject({ kind: "agent", id: "analyst" });
  expect(d.product.key_findings[0]).toMatchObject({ id: "f1", likelihood: "roughly even chance", confidence: "high" });
  // the draft that pass built held the values, but its basis and reasoning were written before the overrule: Assemble is sent it once (final review I4)
  const back = ofType("stage.sent_back").filter((e) => e.seq > head);
  expect(back.map((e) => [e.payload.from, e.payload.to, e.payload.reason.startsWith("the person overruled f1: confidence high. Note")])).toEqual([["publish", "assemble", true]]);
  expect(f.s.state.drafts).toHaveLength(3);
});

test("an overrule with no run in progress writes only finding.overruled, and the next run's first Assemble draft holds it", async () => {
  const r = rig([...FIRST, ...AGAIN]);
  await toGate(r);
  r.engine.stop(person, "enough");
  const head = f.s.head().seq;
  r.engine.overrule(input({ finding: "f2", likelihood: null, stays: true }));
  expect(since(head)).toEqual(["finding.overruled"]);
  expect(await startRun(r)).toMatchObject({ status: "waiting", waiting: "publish" });
  const d = latest();
  expect(d.n).toBe(2);
  expect(d.author).toMatchObject({ kind: "agent", id: "analyst" });
  // AGAIN proposes only f1; f2 must stay, so code restored it from draft 1
  expect(d.product.key_findings.map((x) => x.id)).toEqual(["f1", "f2"]);
  expect(d.product.key_findings[1]).toEqual(f.s.state.drafts[0]!.product.key_findings[1]!);
});

test("an overrule the latest draft already holds writes only finding.overruled", async () => {
  const r = rig(FIRST);
  await toGate(r);
  offGate(false);
  const head = f.s.head().seq;
  r.engine.overrule(input({ likelihood: "roughly even chance" }));
  expect(since(head)).toEqual(["finding.overruled"]);
});

test("an overrule is refused: not by a person; no note; a draft that is not the latest; a finding no draft held; a term the standard does not have; a dropped finding with a value; nothing to withdraw; the same overrule again", async () => {
  const r = rig(FIRST);
  await toGate(r);
  const head = f.s.head().seq;
  const refused = (over: Partial<In>, message: string) => {
    expect(() => r.engine.overrule(input(over))).toThrow(OverruleRefused);
    expect(() => r.engine.overrule(input(over))).toThrow(message);
  };
  refused({ actor: planner }, "only a person may overrule a finding");
  refused({ note: "  " }, "an overrule needs a note");
  refused({ draft_hash: "0".repeat(64) }, "a newer draft arrived; look at it before overruling");
  refused({ finding: "f9" }, "there is no finding f9");
  refused({ likelihood: "sure" }, '"sure" is not a likelihood term of the standard: give one of almost no chance, very unlikely, unlikely, roughly even chance, likely, very likely, almost certain');
  refused({ stays: false }, "a dropped finding has no likelihood or confidence to set");
  refused({ likelihood: null }, "there is no overrule of f1 to withdraw");
  expect(since(head)).toEqual([]);
  // the same overrule again, off the gate so the first is not sent back
  r.engine.stop(person, "enough");
  r.engine.overrule(input());
  refused({}, "that is already the overrule of f1");
});

test("withdrawing an overrule writes finding.overruled with nothing set and no revision", async () => {
  const r = rig(FIRST);
  await toGate(r);
  r.engine.stop(person, "enough");
  r.engine.overrule(input());
  const head = f.s.head().seq;
  r.engine.overrule(input({ likelihood: null, note: "I was wrong about the TV." }));
  expect(since(head)).toEqual(["finding.overruled"]);
  expect(ofType("finding.overruled").at(-1)!.payload).toMatchObject({ likelihood: null, confidence: null, stays: null });
  expect(f.s.state.drafts).toHaveLength(1);
});

test("a new finding after the person dropped the highest-numbered one takes a fresh id, so the drop is not applied to it (final review I1)", async () => {
  const NEW: ScriptReply[] = [calls(proposal("the device is idle", ["c1"], { replaces: "f1" }), proposal("it was moved to the lab", ["c2"], { likelihood: "likely" })), out("again")];
  const r = rig([...FIRST, ...AGAIN, ...NEW]);
  await toGate(r);
  // at the gate the drop is sent back with the person's changes; draft 2 holds f1 only
  r.engine.overrule(input({ finding: "f2", likelihood: null, stays: false, note: "That flow was my own test." }));
  r.engine.sendBackChanges(person, latest().hash);
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(latest().product.key_findings.map((x) => x.id)).toEqual(["f1"]);
  r.engine.reject({ actor: person, reason: "say where it went", stop: false });
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  const d = latest();
  expect(d.n).toBe(3);
  // f2 stays dropped; the new claim is f3, not a second f2 that code would drop with it
  expect(d.product.key_findings.map((x) => [x.id, x.statement])).toEqual([
    ["f1", "We assess it is roughly even chance that the device is idle."],
    ["f3", "We assess it is likely that it was moved to the lab."],
  ]);
});

test("Send back with my changes is refused: not by a person; off the publish gate; a draft that is not the latest; no change since the draft was made", async () => {
  const r = rig([...FIRST, ...AGAIN]);
  await toGate(r);
  const head = f.s.head().seq;
  expect(() => r.engine.sendBackChanges(person, latest().hash)).toThrow("there is no change of yours since draft 1 was made: nothing to send back");
  r.engine.overrule(input());
  expect(() => r.engine.sendBackChanges(planner, latest().hash)).toThrow("only a person may send the draft back with their changes");
  expect(() => r.engine.sendBackChanges(person, "0".repeat(64))).toThrow("a newer draft arrived; look at it before sending it back");
  expect(since(head)).toEqual(["finding.overruled"]);
  r.engine.stop(person, "enough");
  expect(() => r.engine.sendBackChanges(person, latest().hash)).toThrow("the run is not waiting at the publish gate");
});

test("an overrule made at the gate is not sent back by the engine on its own, even when the run is paused and resumed there", async () => {
  const r = rig([...FIRST, ...AGAIN]);
  await toGate(r);
  r.engine.overrule(input());
  r.engine.pause(person);
  expect(await r.engine.resume(person)).toMatchObject({ waiting: "publish" });
  expect(ofType("stage.sent_back")).toEqual([]);
  expect(f.s.state.drafts).toHaveLength(1);
});

test("withdrawing at the gate an overrule that was never sent is not a change; withdrawing one the draft holds is", async () => {
  const r = rig([...FIRST, ...AGAIN]);
  await toGate(r);
  r.engine.overrule(input());
  expect(gateChanges(f.s.state, f.s.entries()).map((c) => c.id)).toEqual(["f1"]);
  r.engine.overrule(input({ likelihood: null, confidence: null, stays: null, note: "I was wrong." }));
  expect(gateChanges(f.s.state, f.s.entries())).toEqual([]);
  // sent, taken in by draft 2, then withdrawn: that is a change
  r.engine.overrule(input({ note: "Again." }));
  r.engine.sendBackChanges(person, latest().hash);
  await r.engine.advance();
  expect(gateChanges(f.s.state, f.s.entries())).toEqual([]);
  r.engine.overrule(input({ likelihood: null, confidence: null, stays: null, note: "No, withdrawn." }));
  expect(gateChanges(f.s.state, f.s.entries()).map((c) => [c.kind, c.id])).toEqual([["overrule", "f1"]]);
});
