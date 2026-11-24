import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import { blockers, latestDraft } from "../../src/core/state";
import type { Actor, Product } from "../../src/core/types";
import { loadProfile } from "../../src/agents/context";
import { Providers } from "../../src/agents/providers";
import { loadConfig } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnd, StageRunner } from "../../src/pipeline/engine";
import { loadPipeline } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { ReviseRefused } from "../../src/pipeline/revise";
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
