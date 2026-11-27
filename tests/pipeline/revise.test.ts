import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import { blockers, latestDraft } from "../../src/core/state";
import type { Actor, Finding, Product } from "../../src/core/types";
import { draftOf } from "../../src/agents/draft";
import { loadProfile } from "../../src/agents/context";
import { Providers } from "../../src/agents/providers";
import { loadConfig } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnd, StageRunner } from "../../src/pipeline/engine";
import { loadPipeline } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { revisionEntries, ReviseRefused } from "../../src/pipeline/revise";
import { markingProblem } from "../../src/pipeline/publish";
import { card } from "../helpers/entries";
import { fixture, PLAN } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

const person: Actor = { kind: "human", id: "analyst" };
const other: Actor = { kind: "human", id: "second-analyst" };
const planner = { kind: "agent", id: "planner", stage: "plan", profile: "investigation", model: "m", effort: null, where: "machine" } as const;
const PASS: Extract<StageEnd, { kind: "finished" }> = { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };

let f: Fixture;
let dir: string;
beforeEach(() => { f = fixture(false); dir = mkdtempSync(join(tmpdir(), "revise-")); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
  rmSync(dir, { recursive: true, force: true });
});

const base: Product = { objective: "o", question: "q", marking: "TLP:GREEN", summary: "s", key_findings: [], gaps_and_limits: "", alternatives: "", assessment: "", sources: [], assumptions: [], change: "c" };

function rig(over: Partial<Record<Role, StageRunner>> = {}, s: CaseSession = f.s): { engine: Engine; log: string[] } {
  const registry = f.sample.registry;
  const { pipeline } = loadPipeline(registry);
  const deps: EngineDeps = {
    config: loadConfig({ env: {}, home: dir, repoRoot: dir }), registry, runner: f.sample.deps, seeker: f.sample.seeker,
    providers: new Providers([]), pipeline: pipeline!, profile: loadProfile(registry, "investigation"),
  };
  const log: string[] = [];
  const draftPass = (): StageEnd => ({ ...PASS, draft_hash: latestDraft(s.state)?.hash ?? null });
  const runners: Partial<Record<Role, StageRunner>> = {
    frame: async () => PASS,
    plan: async () => { s.commit((_st, ids) => [{ type: "plan.proposed", actor: planner, payload: { plan: PLAN(ids.next("plan")) } }]); return PASS; },
    research: async () => PASS,
    assemble: async () => {
      log.push("assemble");
      const product = { ...base, summary: `s${s.state.drafts.length + 1}` };
      const hash = sha256Hex(canonical(product as unknown as Json));
      s.commit((st) => [{ type: "draft.revised", actor: planner, payload: { draft: { n: st.drafts.length + 1, hash, author: planner, product, reason: "r" } } }]);
      return { ...PASS, draft_hash: hash };
    },
    checks: async () => { log.push("checks"); return draftPass(); },
    evaluate: async () => { log.push("evaluate"); return draftPass(); },
    challenge: async () => { log.push("challenge"); return draftPass(); },
    publish: async () => draftPass(),
    feedback: async () => PASS,
    ...over,
  };
  return { engine: new Engine(s, deps, { runners }), log };
}
async function toGate(r: { engine: Engine }): Promise<void> {
  r.engine.start(person);
  await r.engine.advance();
  f.s.commit(() => [
    { type: "plan.accepted", actor: person, payload: { plan: f.s.state.plan.current!.id, steps: ["s1"], budgets: {} } },
    { type: "gate.passed", actor: person, payload: { gate: "plan" } },
  ]);
  const sum = await r.engine.advance();
  expect(sum).toMatchObject({ status: "waiting", waiting: "publish" });
}
const edit = (r: { engine: Engine }, over: Partial<Product> = {}, actor: Actor = person) =>
  r.engine.revise({ product: { ...latestDraft(f.s.state)!.product, summary: "edited", ...over }, reason: "clearer wording", actor });

test("a person's edit is a new numbered revision in their name", async () => {
  const r = rig();
  await toGate(r);
  const before = latestDraft(f.s.state)!;
  const d = edit(r, {}, other);
  expect(d).toMatchObject({ n: before.n + 1, author: other, reason: "clearer wording" });
  expect(d.hash).toBe(sha256Hex(canonical(d.product as unknown as Json)));
  expect(latestDraft(f.s.state)).toEqual(d);
  expect(f.s.state.drafts).toHaveLength(2);
  const rev = f.s.entries().filter((e) => e.type === "draft.revised").at(-1)!;
  expect(rev.actor).toEqual(other);
});

test("an edit at the publish gate leaves the gate and starts review again", async () => {
  const r = rig();
  await toGate(r);
  const edited = edit(r);
  expect(f.s.state.run.waiting).toBeNull();
  expect(f.s.state.run.current).toBe("checks");
  expect(f.s.state.run.status).toBe("running");
  expect(blockers(f.s.state, edited.hash)).toContain("Checks has not passed this revision");
  // one commit: the draft, then the start of Checks as the engine
  const entries = f.s.entries();
  const i = entries.findIndex((e) => e.type === "draft.revised" && e.payload.draft.hash === edited.hash);
  expect(entries[i + 1]).toMatchObject({ type: "stage.started", actor: { kind: "system", id: "engine" }, payload: { stage: "checks" } });
  const sum = await r.engine.advance();
  expect(sum).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(r.log.slice(-3)).toEqual(["checks", "evaluate", "challenge"]);
});

test("an edit does not count as a send-back", async () => {
  const r = rig();
  await toGate(r);
  const before = { ...f.s.state.run.sendbacks };
  edit(r);
  expect(f.s.state.run.sendbacks).toEqual(before);
  await r.engine.advance();
  expect(f.s.state.run.sendbacks).toEqual(before);
  expect(f.s.entries().some((e) => e.type === "stage.sent_back")).toBe(false);
});

test("an edit while the run is paused on a failed stage restarts review from Checks without a send-back", async () => {
  const r = rig({ evaluate: async () => ({ kind: "finished", outcome: "fail", draft_hash: latestDraft(f.s.state)!.hash, output: null, reason: "bad" }) });
  r.engine.start(person);
  await r.engine.advance();
  f.s.commit(() => [
    { type: "plan.accepted", actor: person, payload: { plan: f.s.state.plan.current!.id, steps: ["s1"], budgets: {} } },
    { type: "gate.passed", actor: person, payload: { gate: "plan" } },
  ]);
  const sum = await r.engine.advance();
  expect(sum.status).toBe("paused");
  const sendbacks = { ...f.s.state.run.sendbacks };
  const d = edit(r);
  expect(f.s.state.run.status).toBe("paused");
  expect(f.s.state.run.current).toBe("checks");
  expect(f.s.state.run.sendbacks).toEqual(sendbacks);
  expect(latestDraft(f.s.state)!.hash).toBe(d.hash);
});

test("an agent cannot use reviseDraft", async () => {
  const r = rig();
  await toGate(r);
  expect(() => edit(r, {}, planner)).toThrow(ReviseRefused);
  expect(() => edit(r, {}, { kind: "system", id: "engine" })).toThrow(ReviseRefused);
  expect(f.s.state.drafts).toHaveLength(1);
});

test("an edit after the run finished is refused", async () => {
  const r = rig();
  await toGate(r);
  const draft = latestDraft(f.s.state)!;
  f.s.commit(() => [
    { type: "product.published", actor: person, payload: { n: 1, draft_hash: draft.hash, head_hash: "x", dir: "out", bundle: f.s.blobs.put("{}") } },
    { type: "gate.passed", actor: person, payload: { gate: "publish" } },
  ]);
  await r.engine.advance();
  expect(r.engine.summary().status).toBe("finished");
  expect(() => edit(r)).toThrow(ReviseRefused);
  expect(f.s.state.drafts).toHaveLength(1);
});

test("an edit with no run, or a product the fold would not accept, is refused", async () => {
  const r = rig();
  expect(() => r.engine.revise({ product: base, reason: "r", actor: person })).toThrow(ReviseRefused);
  await toGate(r);
  expect(() => r.engine.revise({ product: { summary: "x" } as unknown as Product, reason: "r", actor: person })).toThrow(ReviseRefused);
  expect(() => r.engine.revise({ product: { ...base, marking: "SECRET" as never }, reason: "r", actor: person })).toThrow(ReviseRefused);
  expect(() => r.engine.revise({ product: { ...base, summary: undefined as never }, reason: "r", actor: person })).toThrow(ReviseRefused);
  expect(f.s.state.drafts).toHaveLength(1);
});

test("an edit while the run is paused at the publish gate leaves the gate and restarts review from Checks", async () => {
  const r = rig();
  await toGate(r);
  r.engine.pause(person);
  expect(f.s.state.run).toMatchObject({ status: "paused", waiting: "publish" });
  const d = edit(r);
  expect(f.s.state.run).toMatchObject({ status: "paused", waiting: null, current: "checks" });
  expect(blockers(f.s.state, d.hash)).toContain("Checks has not passed this revision");
  const sum = await r.engine.resume(person);
  expect(sum).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(r.log.slice(-3)).toEqual(["checks", "evaluate", "challenge"]);
  expect(f.s.state.run.sendbacks).toEqual({});
});

test("a product with unknown keys, and an edit with an empty reason, are refused", async () => {
  const r = rig();
  await toGate(r);
  const cur = latestDraft(f.s.state)!.product;
  expect(() => r.engine.revise({ product: { ...cur, summary: "x", extra: 1 } as unknown as Product, reason: "r", actor: person })).toThrow(ReviseRefused);
  expect(() => r.engine.revise({ product: { ...cur, summary: "x", key_findings: [{ id: "f1", statement: "s", likelihood: "l", confidence: "high", confidence_basis: "b", cites: [], assumptions: [], reasoning: "r", note: "n" }] } as unknown as Product, reason: "r", actor: person })).toThrow(ReviseRefused);
  expect(() => r.engine.revise({ product: { ...cur, summary: "x" }, reason: "", actor: person })).toThrow(ReviseRefused);
  expect(() => r.engine.revise({ product: { ...cur, summary: "x" }, reason: "   ", actor: person })).toThrow(ReviseRefused);
  expect(f.s.state.drafts).toHaveLength(1);
});

/** A run at the publish gate whose draft cites an AMBER card c1 for its summary by tool only, so the product holds no `[c1]`. */
async function gateWithNarrativeCite(): Promise<{ engine: Engine }> {
  const researcher = { ...planner, id: "researcher-g1", stage: "research" };
  f.s.commit((_st, ids) => [{ type: "card.created", actor: researcher, payload: { card: card(ids.next("card"), { title: "Proxy flows", marking: "TLP:AMBER" }) } }]);
  const r = rig({
    assemble: async () => {
      const product: Product = { ...base, marking: "TLP:AMBER", summary: "The proxy talks to the address every hour." };
      const hash = sha256Hex(canonical(product as unknown as Json));
      f.s.commit((st) => [{ type: "draft.revised", actor: planner, payload: { draft: { n: st.drafts.length + 1, hash, author: planner, product, reason: "r", cited: ["c1"] } } }]);
      return { ...PASS, draft_hash: hash };
    },
  });
  await toGate(r);
  return r;
}

test("an edit that leaves the summary as it was keeps the card the summary cited, and the previous marking is its floor", async () => {
  const r = await gateWithNarrativeCite();
  // an edit that only lowers the marking changes nothing once the floor is applied
  expect(() => r.engine.revise({ product: { ...latestDraft(f.s.state)!.product, marking: "TLP:GREEN" }, reason: "lower it", actor: person })).toThrow("the marking cannot be lowered below TLP:AMBER");
  const d = r.engine.revise({ product: { ...latestDraft(f.s.state)!.product, marking: "TLP:GREEN", gaps_and_limits: "more" }, reason: "lower it", actor: person });
  expect(d.product.marking).toBe("TLP:AMBER");
  expect(d.cited).toContain("c1");
  expect(markingProblem(f.s, d)).toBeNull();
});

test("an edit that rewrites every section carries no tool-only cite over, but keeps every card its text names", async () => {
  const r = await gateWithNarrativeCite();
  const prev = latestDraft(f.s.state)!.product;
  const d = r.engine.revise({ product: { ...prev, summary: "All new.", gaps_and_limits: "x", alternatives: "y", assessment: "z" }, reason: "rewrite", actor: person });
  expect(d.cited).toEqual([]);
  for (const text of ["See [c1].", "See [c1, c2].", "See [Card c1].", "See c1 for the flows."]) {
    const e = r.engine.revise({ product: { ...prev, summary: text, gaps_and_limits: text, alternatives: "y", assessment: "z" }, reason: `cite as ${text}`, actor: person });
    expect(e.cited).toContain("c1");
  }
  expect(latestDraft(f.s.state)!.cited).toEqual(["c1"]);
});

test("a person's edit cannot lower the marking below the previous draft's", async () => {
  const amber: Product = { ...base, marking: "TLP:AMBER", summary: "amber" };
  const r = rig({
    assemble: async () => {
      const hash = sha256Hex(canonical(amber as unknown as Json));
      f.s.commit((st) => [{ type: "draft.revised", actor: planner, payload: { draft: { n: st.drafts.length + 1, hash, author: planner, product: amber, reason: "r" } } }]);
      return { ...PASS, draft_hash: hash };
    },
  });
  await toGate(r);
  const latest = latestDraft(f.s.state)!;
  expect(latest.product.marking).toBe("TLP:AMBER");
  const d = r.engine.revise({ product: { ...latest.product, marking: "TLP:CLEAR", summary: "edited" }, reason: "tidy", actor: person });
  expect(d.product.marking).toBe("TLP:AMBER");
  expect(d.hash).toBe(sha256Hex(canonical(d.product as unknown as Json)));
  expect(latestDraft(f.s.state)).toEqual(d);
});

test("an edit cannot lower the marking below the case's, nor below a card the edited draft cites", async () => {
  // the case is GREEN; the latest draft is CLEAR (as a stand-in assemble may leave it); a card the edit cites is AMBER
  const clear: Product = { ...base, marking: "TLP:CLEAR", summary: "clear" };
  const researcher = { ...planner, id: "researcher-g1", stage: "research" };
  f.s.commit((_st, ids) => [{ type: "card.created", actor: researcher, payload: { card: card(ids.next("card"), { title: "Proxy flows", marking: "TLP:AMBER" }) } }]);
  const r = rig({
    assemble: async () => {
      const hash = sha256Hex(canonical(clear as unknown as Json));
      f.s.commit((st) => [{ type: "draft.revised", actor: planner, payload: { draft: { n: st.drafts.length + 1, hash, author: planner, product: clear, reason: "r" } } }]);
      return { ...PASS, draft_hash: hash };
    },
  });
  await toGate(r);
  const latest = latestDraft(f.s.state)!;
  // case marking GREEN is the floor for an edit that cites nothing
  const a = r.engine.revise({ product: { ...latest.product, marking: "TLP:CLEAR", summary: "edited" }, reason: "tidy", actor: person });
  expect(a.product.marking).toBe("TLP:GREEN");
  // and a card it cites sets it higher
  const b = r.engine.revise({ product: { ...a.product, marking: "TLP:GREEN", summary: "see [c1]" }, reason: "cite", actor: person });
  expect(b.product.marking).toBe("TLP:AMBER");
  expect(() => r.engine.revise({ product: { ...b.product, marking: "TLP:CLEAR" }, reason: "lower", actor: person })).toThrow("the marking cannot be lowered below TLP:AMBER");
});

// ---- the person's overrule holds against their own edit (slice 8) ----

const F1: Finding = { id: "f1", statement: "We assess it is almost certain that the device is idle.", likelihood: "almost certain", confidence: "moderate", confidence_basis: "b", cites: [], assumptions: [], reasoning: "r" };

test("a person's edit that does not hold their overrule is refused with the way out", async () => {
  const r = rig();
  await toGate(r);
  const held = { ...base, key_findings: [F1] };
  f.s.commit((st) => [{ type: "draft.revised", actor: person, run: st.run.id, payload: { draft: draftOf(held, st.drafts.length + 1, person, "with f1") } }]);
  f.s.commit((st) => [{ type: "finding.overruled", actor: person, run: st.run.id, payload: { finding: "f1", draft_hash: latestDraft(st)!.hash, likelihood: "almost certain", confidence: null, stays: null, note: "It is the TV I installed." } }]);
  const way = "f1 is overruled (likelihood almost certain); overrule it again, or withdraw the overrule, to change it";
  expect(() => edit(r, { key_findings: [{ ...F1, likelihood: "likely" }] })).toThrow(way);
  expect(() => edit(r, { key_findings: [] })).toThrow(way);
  // an edit that keeps the overruled value is taken
  expect(edit(r, { summary: "tidied" }).product.key_findings).toEqual([F1]);
});

test("reviseDraft writes what it wrote before", async () => {
  // the builder moved out unchanged: what revisionEntries builds from a state is what reviseDraft commits from it
  const r = rig();
  await toGate(r);
  const { pipeline } = loadPipeline(f.sample.registry);
  const product = { ...latestDraft(f.s.state)!.product, summary: "edited" };
  const built = revisionEntries(f.s.state, pipeline!, { product, reason: "clearer wording", actor: person });
  const head = f.s.head().seq;
  const d = r.engine.revise({ product, reason: "clearer wording", actor: person });
  expect(built.draft).toEqual(d);
  expect(f.s.entries().filter((e) => e.seq > head).map(({ type, actor, payload }) => ({ type, actor, payload }))).toEqual(built.entries.map(({ type, actor, payload }) => ({ type, actor, payload })));
});
