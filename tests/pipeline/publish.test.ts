import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import { latestDraft } from "../../src/core/state";
import type { Actor, Entry, Product } from "../../src/core/types";
import { verifyCase } from "../../src/core/verify";
import { loadProfile } from "../../src/agents/context";
import { Providers } from "../../src/agents/providers";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import type { ScriptReply } from "../../src/agents/providers/scripted";
import { loadConfig } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnd, StageRunner } from "../../src/pipeline/engine";
import { loadPipeline } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { approve, draftProblem, PublishRefused } from "../../src/pipeline/publish";
import { lastOutput } from "../../src/pipeline/stages/agent";
import { publishRunner } from "../../src/pipeline/stages/publish";
import { feedbackRunner } from "../../src/pipeline/stages/feedback";
import { card } from "../helpers/entries";
import { fixture, person, PLAN } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

const human = person;
const researcher: Actor = { kind: "agent", id: "researcher-g1", stage: "research", profile: "investigation", model: "m", effort: null, where: "machine" };
const planner: Actor = { kind: "agent", id: "planner", stage: "plan", profile: "investigation", model: "m", effort: null, where: "machine" };
const PASS: Extract<StageEnd, { kind: "finished" }> = { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
const say = (x: unknown): ScriptReply => ({ content: JSON.stringify(x) });
const TITLES = [1, 2, 3, 4].map((i) => say({ title: `Title ${i}`, note: `Note ${i}` }));

let f: Fixture;
let dir: string;
let anchors: { case: string; seq: number; hash: string; why: string }[];
beforeEach(() => { f = fixture(false); dir = mkdtempSync(join(tmpdir(), "publish-")); anchors = []; });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
  rmSync(dir, { recursive: true, force: true });
});

const base: Product = { objective: "o", question: "q", marking: "TLP:AMBER", summary: "s", key_findings: [], gaps_and_limits: "gaps", alternatives: "alts", assessment: "assess", sources: [{ source: "assets", quality: "good" }], assumptions: ["a1"], change: "c" };
const productFor = (n: number): Product => ({
  ...base, summary: `s${n}`,
  key_findings: [
    { id: "f1", statement: "it is internal", likelihood: "likely", confidence: "high", confidence_basis: "the record", cites: ["c1"], assumptions: [], reasoning: "matches" },
    { id: "f2", statement: "it talks to the proxy", likelihood: "likely", confidence: "moderate", confidence_basis: "one source", cites: ["c2"], assumptions: ["a1"], reasoning: "flows" },
  ],
});

/** Two cards: c1 from a recorded query, c2 with none. */
function cards(subgoals: [string | null, string | null] = [null, null]): void {
  f.s.commit((_st, ids) => {
    const q = ids.next("query");
    const bytes = f.s.blobs.put('{"rows":[["ws-17"]]}');
    return [
      { type: "query.issued", actor: researcher, payload: { query: q, source: "assets", source_hash: "src-hash-1", pivot: null, pivot_hash: null, connector: "csv", text: "SELECT host FROM assets WHERE ip = :ip", bound: { ip: "198.51.100.77" }, window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, why: "who owns the address", estimate: null, step: "s1", verifies: null, purpose: "result" } },
      { type: "query.result", actor: researcher, payload: { query: q, result: bytes, rows: 1, rows_hash: "rows-hash-1", coverage: { kind: "full" }, duration_ms: 3, cost: null } },
      { type: "card.created", actor: researcher, payload: { card: card(ids.next("card"), { title: "Asset record", source: "assets", marking: "TLP:GREEN", query: q, subgoal: subgoals[0], why: "who owns the address" }) } },
      { type: "card.created", actor: researcher, payload: { card: card(ids.next("card"), { title: "Proxy flows", source: "flows", marking: "TLP:AMBER", subgoal: subgoals[1] }) } },
    ];
  });
}

interface Rig { engine: Engine; deps: EngineDeps; log: string[] }
function rig(over: Partial<Record<Role, StageRunner>> = {}, s: CaseSession = f.s): Rig {
  const registry = f.sample.registry;
  const { pipeline, problems } = loadPipeline(registry);
  if (pipeline === null) throw new Error(problems.join("; "));
  const deps: EngineDeps = {
    config: loadConfig({ env: {}, home: dir, repoRoot: dir }), registry, runner: f.sample.deps, seeker: f.sample.seeker,
    providers: new Providers([new ScriptedProvider({ id: "scripted", scripts: [{ id: "sample-run", turns: TITLES.map((reply) => ({ actor: "publisher", reply })) }] })]),
    pipeline, profile: loadProfile(registry, "investigation"), anchor: (a) => { anchors.push(a); },
  };
  const log: string[] = [];
  const pass = (): StageEnd => ({ ...PASS, draft_hash: latestDraft(s.state)?.hash ?? null });
  const runners: Partial<Record<Role, StageRunner>> = {
    frame: async () => PASS,
    plan: async () => { s.commit((_st, ids) => [{ type: "plan.proposed", actor: planner, payload: { plan: PLAN(ids.next("plan")) } }]); return PASS; },
    research: async () => PASS,
    assemble: async () => {
      log.push("assemble");
      const product = productFor(s.state.drafts.length + 1);
      const hash = sha256Hex(canonical(product as unknown as Json));
      s.commit((st) => [{ type: "draft.revised", actor: planner, payload: { draft: { n: st.drafts.length + 1, hash, author: planner, product, reason: "r" } } }]);
      return { ...PASS, draft_hash: hash };
    },
    checks: async () => { log.push("checks"); return pass(); },
    evaluate: async () => { log.push("evaluate"); return pass(); },
    challenge: async () => { log.push("challenge"); return pass(); },
    publish: publishRunner,
    feedback: feedbackRunner,
    ...over,
  };
  return { engine: new Engine(s, deps, { runners }), deps, log };
}
async function toGate(r: Rig): Promise<void> {
  r.engine.start(human);
  await r.engine.advance();
  f.s.commit(() => [
    { type: "plan.accepted", actor: human, payload: { plan: f.s.state.plan.current!.id, steps: ["s1"], budgets: {} } },
    { type: "gate.passed", actor: human, payload: { gate: "plan" } },
  ]);
  const sum = await r.engine.advance();
  expect(sum).toMatchObject({ status: "waiting", waiting: "publish" });
}
const ofType = <T extends Entry["type"]>(t: T): Extract<Entry, { type: T }>[] => f.s.entries().filter((e): e is Extract<Entry, { type: T }> => e.type === t);
const read = (rel: string, name: string): string => readFileSync(join(f.s.dir, rel, name), "utf8");
const gated = async (over: Partial<Record<Role, StageRunner>> = {}): Promise<Rig> => { cards(); const r = rig(over); await toGate(r); return r; };

test("the publisher's title and a preview of the bundle are the Publish stage's output", async () => {
  await gated();
  const out = lastOutput(f.s, "publish") as { title: string; note: string; preview: { draft_hash: string; title: string; files: { name: string }[]; marking: string } };
  expect(out.title).toBe("Title 1");
  expect(out.note).toBe("Note 1");
  expect(out.preview).toMatchObject({ draft_hash: latestDraft(f.s.state)!.hash, title: "Title 1", marking: "TLP:AMBER" });
  expect(out.preview.files.map((x) => x.name)).toEqual(["product.json", "product.md", "provenance.json", "provenance.md"]);
  const fin = ofType("stage.finished").filter((e) => e.payload.stage === "publish").at(-1)!;
  expect(fin.payload.draft_hash).toBe(latestDraft(f.s.state)!.hash);
  expect(ofType("gate.waiting").at(-1)!.payload.gate).toBe("publish");
  expect(readdirSync(join(f.s.dir, "published"))).toEqual([]);
});

test("approving writes the bundle and records it", async () => {
  const r = await gated();
  const res = r.engine.approve({ actor: human });
  const dirPath = join(f.s.dir, res.dir);
  expect(res.n).toBe(1);
  expect(readdirSync(dirPath).sort()).toEqual(["manifest.json", "product.json", "product.md", "provenance.json", "provenance.md"]);
  expect(sha256Hex(readFileSync(join(dirPath, "product.json")))).toBe(res.draft_hash);
  expect(read(res.dir, "product.json")).toBe(canonical(latestDraft(f.s.state)!.product as unknown as Json));
  expect(f.s.state.published).toHaveLength(1);
  const manifest = JSON.parse(read(res.dir, "manifest.json")) as { files: { name: string; sha256: string; bytes: number }[]; title: string; note: string };
  for (const x of manifest.files) {
    expect(sha256Hex(readFileSync(join(dirPath, x.name)))).toBe(x.sha256);
    expect(readFileSync(join(dirPath, x.name)).byteLength).toBe(x.bytes);
  }
  expect([manifest.title, manifest.note]).toEqual(["Title 1", "Note 1"]);
  const entry = ofType("product.published")[0]!;
  expect(entry.actor).toEqual(human);
  const blob = JSON.parse(f.s.blobs.text(entry.payload.bundle.blob)) as { manifest: unknown; files: Record<string, string> };
  expect(blob.files["product.json"]).toBe(read(res.dir, "product.json"));
  expect(blob.manifest).toEqual(manifest);
  expect(verifyCase(f.s.dir).ok).toBe(true);
});

test("the product carries its marking on its first and last lines", async () => {
  const r = await gated();
  const res = r.engine.approve({ actor: human });
  for (const name of ["product.md", "provenance.md"]) {
    const lines = read(res.dir, name).replace(/\n$/, "").split("\n");
    expect(lines[0]).toBe("TLP:AMBER");
    expect(lines.at(-1)).toBe("TLP:AMBER");
  }
  const md = read(res.dir, "product.md");
  for (const h of ["# Title 1", "Objective: o", "Question: q", "## Summary", "## Key findings", "## Assessment", "## Alternatives considered", "## Gaps and limits", "## Sources and their quality", "## Assumptions", "## Change from earlier judgments"]) {
    expect(md).toContain(h);
  }
  expect(md).toContain(`hash ${res.draft_hash}`);
  expect(md).toContain("Citations: [c1].");
  expect(md).toContain("Confidence: moderate (one source).");
});

test("the provenance appendix gives each cited card's source, exact query, why, who, when, marking and hashes", async () => {
  const r = await gated();
  const res = r.engine.approve({ actor: human });
  const issued = ofType("query.issued")[0]!;
  const result = ofType("query.result")[0]!;
  const prov = JSON.parse(read(res.dir, "provenance.json")) as Record<string, unknown>[];
  expect(prov.map((p) => p.card)).toEqual(["c1", "c2"]);
  expect(prov[0]).toEqual({
    card: "c1", title: "Asset record", source: "assets", source_hash: "src-hash-1", query: "q1", text: "SELECT host FROM assets WHERE ip = :ip", bound: { ip: "198.51.100.77" },
    window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, why: "who owns the address", by: "agent:researcher-g1", issued: issued.ts, marking: "TLP:GREEN",
    coverage: { kind: "full" }, empty: null, rows: 1, rows_hash: "rows-hash-1", result_sha256: result.payload.result.blob,
  });
  expect(prov[1]).toMatchObject({ card: "c2", source: "flows", query: null, text: null, marking: "TLP:AMBER" });
  const md = read(res.dir, "provenance.md");
  expect(md).toContain("SELECT host FROM assets WHERE ip = :ip");
  expect(md).toContain("src-hash-1");
  expect(md).toContain(issued.ts);
});

test("the bundle records the chain head at the moment of publishing", async () => {
  const r = await gated();
  const res = r.engine.approve({ actor: human });
  const entries = f.s.entries();
  const i = entries.findIndex((e) => e.type === "gate.passed" && e.payload.gate === "publish");
  const manifest = JSON.parse(read(res.dir, "manifest.json")) as { head: { seq: number; hash: string } };
  expect(manifest.head).toEqual({ seq: entries[i - 1]!.seq, hash: entries[i - 1]!.hash });
  expect(ofType("product.published")[0]!.payload.head_hash).toBe(entries[i - 1]!.hash);
});

test("approving keeps the cited cards into their sub-goals' lanes", async () => {
  cards(["g2", null]);
  f.s.commit((_st, ids) => [
    { type: "lane.created", actor: human, payload: { lane: ids.next("lane"), title: "First", subgoal: "g1" } },
    { type: "lane.created", actor: human, payload: { lane: ids.next("lane"), title: "Second", subgoal: "g2" } },
  ]);
  const r = rig();
  await toGate(r);
  r.engine.approve({ actor: human });
  expect(f.s.state.cards.c1!.lane).toBe("l2");
  expect(f.s.state.cards.c2!.lane).toBe("l1");
  expect(Object.values(f.s.state.cards).every((c) => c.place === "lane")).toBe(true);
  expect(f.s.state.lanes).toHaveLength(2);
  const kept = ofType("card.kept");
  expect(kept.every((e) => e.actor.kind === "human")).toBe(true);
});

test("a case with no lane gets one for the cited evidence", async () => {
  const r = await gated();
  r.engine.approve({ actor: human });
  expect(f.s.state.lanes).toEqual([{ id: "l1", title: "Cited evidence", subgoal: null, cards: ["c1", "c2"] }]);
  expect(ofType("lane.created")[0]!.payload).toEqual({ lane: "l1", title: "Cited evidence", subgoal: null });
});

test("a draft that has not passed review cannot be published", async () => {
  const r = await gated();
  const p = { ...productFor(9), summary: "sneaked in" };
  f.s.commit((st) => [{ type: "draft.revised", actor: human, payload: { draft: { n: st.drafts.length + 1, hash: sha256Hex(canonical(p as unknown as Json)), author: human, product: p, reason: "x" } } }]);
  let err: unknown = null;
  try { approve(f.s, r.deps, { actor: human }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(PublishRefused);
  expect((err as PublishRefused).reasons).toContain("Checks has not passed this revision");
  expect(f.s.state.published).toEqual([]);
  expect(readdirSync(join(f.s.dir, "published"))).toEqual([]);
});

test("an edit goes back through Checks, Evaluate and Challenge before it can be approved", async () => {
  const r = await gated();
  const before = r.log.length;
  const edited = r.engine.revise({ product: { ...latestDraft(f.s.state)!.product, summary: "edited" }, reason: "wording", actor: human });
  expect(() => r.engine.approve({ actor: human })).toThrow(PublishRefused);
  await r.engine.advance();
  expect(r.log.slice(before)).toEqual(["checks", "evaluate", "challenge"]);
  const res = r.engine.approve({ actor: human });
  expect(res.draft_hash).toBe(edited.hash);
  expect(JSON.parse(read(res.dir, "product.json")).summary).toBe("edited");
  expect(lastOutput(f.s, "publish")).toMatchObject({ title: "Title 2" });
});

test("draftProblem names a draft whose hash is not the hash of its product", () => {
  const product = productFor(1);
  const draft = { n: 1, hash: sha256Hex(canonical(product as unknown as Json)), author: human, product, reason: "r" };
  expect(draftProblem(draft)).toBeNull();
  expect(draftProblem({ ...draft, product: { ...product, summary: "changed" } })).toBe("the draft's hash does not match its product");
});

test("a draft with an open must-address challenge is refused, naming it", async () => {
  const r = await gated();
  const d = latestDraft(f.s.state)!;
  f.s.commit((_st, ids) => [{ type: "challenge.raised", actor: { ...planner, id: "adversary" }, payload: { challenge: { id: ids.next("challenge"), draft_hash: d.hash, severity: "must_address", text: "no second source", cites: [] } } }]);
  let err: unknown = null;
  try { r.engine.approve({ actor: human }); } catch (e) { err = e; }
  expect((err as PublishRefused).reasons).toContain("Challenge x1 must be addressed");
  expect(f.s.state.published).toEqual([]);
});

test("an agent or the system cannot approve", async () => {
  const r = await gated();
  for (const actor of [planner, { kind: "system", id: "engine" } as Actor]) expect(() => r.engine.approve({ actor })).toThrow(PublishRefused);
  expect(() => r.engine.reject({ reason: "no", stop: false, actor: planner })).toThrow(PublishRefused);
  expect(f.s.state.published).toEqual([]);
  expect(f.s.state.run.waiting).toBe("publish");
});

test("approving when the run is not at the publish gate is refused", async () => {
  cards();
  const r = rig();
  expect(() => r.engine.approve({ actor: human })).toThrow("the run is not waiting at the publish gate");
  r.engine.start(human);
  await r.engine.advance();
  expect(() => r.engine.approve({ actor: human })).toThrow(PublishRefused);
  expect(() => r.engine.reject({ reason: "no", stop: true, actor: human })).toThrow(PublishRefused);
});

test("rejecting sends the run back to Assemble with the reason, and the draft must pass review again", async () => {
  const r = await gated();
  const rejected = latestDraft(f.s.state)!;
  r.engine.reject({ reason: "the summary overstates", stop: false, actor: human });
  expect(ofType("publish.rejected")[0]).toMatchObject({ actor: human, payload: { draft_hash: rejected.hash, reason: "the summary overstates", stop: false } });
  expect(f.s.state.reviews[rejected.hash]!.passed_stages).toEqual([]);
  expect(f.s.state.run).toMatchObject({ status: "running", waiting: null, current: "assemble" });
  expect(ofType("stage.sent_back").at(-1)!.payload).toMatchObject({ from: "publish", to: "assemble", reason: "the summary overstates", count: 1 });
  expect(ofType("stage.finished").filter((e) => e.payload.stage === "publish").at(-1)!.payload).toMatchObject({ outcome: "fail", reason: "the summary overstates" });
  const sum = await r.engine.advance();
  expect(sum).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(f.s.state.drafts).toHaveLength(2);
  expect(r.log.slice(-4)).toEqual(["assemble", "checks", "evaluate", "challenge"]);
  expect(r.engine.approve({ actor: human }).draft_hash).toBe(latestDraft(f.s.state)!.hash);
});

test("rejecting with stop finishes the run as stopped", async () => {
  const r = await gated();
  r.engine.reject({ reason: "not wanted", stop: true, actor: human });
  expect(f.s.state.run).toMatchObject({ status: "finished", outcome: "stopped" });
  expect(ofType("run.finished").at(-1)!.actor).toEqual(human);
  expect(anchors.map((a) => a.why)).toEqual(["closed"]);
  expect(f.s.state.published).toEqual([]);
});

test("publishing is anchored on the workbench chain, once", async () => {
  const r = await gated();
  r.engine.approve({ actor: human });
  const head = f.s.head();
  expect(anchors).toEqual([{ case: f.s.id, seq: head.seq, hash: head.hash, why: "published" }]);
  expect(ofType("product.published")[0]!.seq).toBe(head.seq);
  const done = await r.engine.advance();
  expect(done).toMatchObject({ status: "finished", outcome: "published" });
  expect(anchors.map((a) => a.why)).toEqual(["published"]);
});

test("a second product in the same case is numbered 2", async () => {
  const r = await gated();
  expect(r.engine.approve({ actor: human }).n).toBe(1);
  await r.engine.advance();
  await toGate(r);
  const second = r.engine.approve({ actor: human });
  expect(second).toMatchObject({ n: 2, dir: "published/2" });
  expect(readdirSync(join(f.s.dir, "published")).sort()).toEqual(["1", "2"]);
  expect(f.s.state.published.map((p) => p.n)).toEqual([1, 2]);
  expect(verifyCase(f.s.dir).ok).toBe(true);
});
