import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
import { validate } from "../../src/core/schema";
import { schemaOf } from "../../src/agents/context";
import { buildBundle } from "../../src/pipeline/publish";
import { reject } from "../../src/pipeline/publish";
import { recordMops } from "../../src/pipeline/feedback";
import { draftOf } from "../../src/agents/draft";
import { Workbench } from "../../src/core/workbench";
import { fold } from "../../src/core/state";
import { EntryBuilder } from "../helpers/entries";
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
let errors: unknown[];
let anchors: { case: string; seq: number; hash: string; why: string }[];
beforeEach(() => { f = fixture(false); dir = mkdtempSync(join(tmpdir(), "publish-")); anchors = []; errors = []; });
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
    pipeline, profile: loadProfile(registry, "investigation"), anchor: (a) => { anchors.push(a); }, onError: (e) => { errors.push(e); },
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
  return { engine: Engine.open(s, deps, { runners }), deps, log };
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

// ---- review fixes ----

/** A third card, marked RED, that only the summary cites. */
function redCard(): void {
  f.s.commit((_st, ids) => [{ type: "card.created", actor: researcher, payload: { card: card(ids.next("card"), { title: "Secret record", source: "assets", marking: "TLP:RED" }) } }]);
}
const narrative = (marking: Product["marking"]) => async (): Promise<StageEnd> => {
  const product: Product = { ...productFor(1), marking, summary: "as the secret record shows [c3]" };
  const d = draftOf(product, f.s.state.drafts.length + 1, planner, "r");
  f.s.commit(() => [{ type: "draft.revised", actor: planner, payload: { draft: d } }]);
  return { ...PASS, draft_hash: d.hash };
};

test("draftOf records every card the findings and the narrative cite, sorted, without changing the hash", () => {
  const product = { ...productFor(1), summary: "see [c9] and [c3]" };
  const d = draftOf(product, 1, human, "r", ["c10", "c2"]);
  expect(d.cited).toEqual(["c1", "c2", "c3", "c9", "c10"]);
  expect(d.hash).toBe(sha256Hex(canonical(product as unknown as Json)));
});

test("a person's edit records the cards its narrative cites", async () => {
  const r = await gated();
  const edited = r.engine.revise({ product: { ...latestDraft(f.s.state)!.product, summary: "now with [c3]" }, reason: "r", actor: human });
  expect(edited.cited).toEqual(["c1", "c2", "c3"]);
  expect(latestDraft(f.s.state)!.cited).toEqual(["c1", "c2", "c3"]);
});

test("a draft whose cited list is not a list of text is recorded as malformed", () => {
  const product = productFor(1);
  const b = new EntryBuilder();
  b.add("draft.revised", { draft: { n: 1, hash: sha256Hex(canonical(product as unknown as Json)), author: human, product, reason: "r", cited: [1] } as never });
  b.add("draft.revised", { draft: draftOf(product, 2, human, "r") });
  const state = fold(b.entries);
  expect(state.skipped.map((x) => x.seq)).toEqual([1]);
  expect(state.drafts).toHaveLength(1);
});

test("a card cited only in the narrative appears in the provenance", async () => {
  cards();
  redCard();
  const r = rig({ assemble: narrative("TLP:RED") });
  await toGate(r);
  const res = r.engine.approve({ actor: human });
  const prov = JSON.parse(read(res.dir, "provenance.json")) as { card: string; marking: string }[];
  expect(prov.map((p) => p.card)).toEqual(["c1", "c2", "c3"]);
  expect(prov[2]!.marking).toBe("TLP:RED");
  expect(read(res.dir, "provenance.md")).toContain("Secret record");
});

test("a product marked lower than a card it cites is refused, naming the card", async () => {
  cards();
  redCard();
  const r = rig({ assemble: narrative("TLP:AMBER") });
  await toGate(r);
  let err: unknown = null;
  try { r.engine.approve({ actor: human }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(PublishRefused);
  expect((err as PublishRefused).reasons.join(" ")).toContain("c3");
  expect(f.s.state.published).toEqual([]);
  expect(readdirSync(join(f.s.dir, "published"))).toEqual([]);
});

const INJECT = "T\n\n## Summary\n\nINJECTED\n\n## Key findings";

test("a title cannot inject Markdown into the product", () => {
  const product = productFor(1);
  const draft = draftOf(product, 1, human, "r");
  cards();
  const b = buildBundle(f.s, draft, { title: INJECT, note: "n" }, { seq: 1, hash: "x" }, 1);
  const lines = b.files["product.md"]!.split("\n");
  expect(lines.filter((l) => l === "## Summary")).toHaveLength(1);
  expect(lines.some((l) => l === "INJECTED")).toBe(false);
  expect(lines[2]).toBe("# T \\#\\# Summary INJECTED \\#\\# Key findings");
  expect(buildBundle(f.s, draft, { title: "a*b_[c]", note: "" }, { seq: 1, hash: "x" }, 1).files["product.md"]).toContain("# a\\*b\\_\\[c\\]");
});

test("the publish output schema refuses a title with a line break or over 200 characters", () => {
  const schema = schemaOf(f.sample.registry, "publish-output");
  expect(validate(schema, { title: "fine", note: "" })).toEqual([]);
  expect(validate(schema, { title: INJECT, note: "" }).length).toBeGreaterThan(0);
  expect(validate(schema, { title: "x".repeat(201), note: "" }).length).toBeGreaterThan(0);
});

test("approving refuses a title or note with control characters", async () => {
  for (const [title, note] of [[INJECT, "n"], ["ok", "bad\u0007bell"]]) {
    const r = await gated({ publish: async () => ({ ...PASS, draft_hash: latestDraft(f.s.state)!.hash, output: { title, note } }) });
    expect(() => r.engine.approve({ actor: human })).toThrow(PublishRefused);
    expect(f.s.state.published).toEqual([]);
    f.s.commit((st) => [{ type: "run.finished", actor: human, run: st.run.id, payload: { outcome: "stopped" } }]);
  }
});

test("a commit that fails leaves no published folder and no temporary one", async () => {
  const r = await gated();
  const put = f.s.blobs.put.bind(f.s.blobs);
  f.s.blobs.put = (() => { throw new Error("disk full"); }) as typeof f.s.blobs.put;
  expect(() => r.engine.approve({ actor: human })).toThrow("disk full");
  f.s.blobs.put = put;
  expect(readdirSync(join(f.s.dir, "published"))).toEqual([]);
  expect(f.s.state.published).toEqual([]);
});

test("the bundle is in place only once its entry is written", async () => {
  const r = await gated();
  let during: string[] = [];
  const commit = f.s.commit.bind(f.s);
  f.s.commit = ((build: Parameters<typeof commit>[0]) => { during = readdirSync(join(f.s.dir, "published")); return commit(build); }) as typeof f.s.commit;
  r.engine.approve({ actor: human });
  expect(during).toHaveLength(1);
  expect(during[0]).toMatch(/^\.tmp-1-/);
  expect(readdirSync(join(f.s.dir, "published"))).toEqual(["1"]);
});

test("starting an engine removes a temporary folder a crash left, and says so", async () => {
  mkdirSync(join(f.s.dir, "published", ".tmp-1-abc"), { recursive: true });
  mkdirSync(join(f.s.dir, "published", "5"), { recursive: true });
  rig();
  expect(readdirSync(join(f.s.dir, "published")).sort()).toEqual(["5"]);
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain(".tmp-1-abc");
});

test("a measure set is recorded, and the missing objective reported, when the objective manifest is not loaded", () => {
  const wb = Workbench.open(join(dir, "wb-ghost"), { onError: () => {} });
  try {
    const s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [], window: { from: null, to: null }, objective: "ghost", marking: "TLP:GREEN" }, human);
    s.commit((_st, ids) => [{ type: "run.started", actor: human, payload: { run: ids.next("run"), pipeline: "p", pipeline_hash: "h", stages: [] } }]);
    recordMops(s, f.sample.registry, (e) => errors.push(e));
    expect(s.state.feedback).toHaveLength(7);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("ghost");
  } finally { wb.close(); }
});

test("an anchor that fails after the commit does not undo or hide the publication", async () => {
  const r = await gated();
  const deps = { ...r.deps, anchor: () => { throw new Error("chain unreachable"); } };
  const res = approve(f.s, deps, { actor: human });
  expect(res.n).toBe(1);
  expect(f.s.state.published).toHaveLength(1);
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain("chain unreachable");
});

test("approving twice is refused", async () => {
  const r = await gated();
  r.engine.approve({ actor: human });
  expect(() => r.engine.approve({ actor: human })).toThrow(PublishRefused);
  await r.engine.advance();
  expect(() => r.engine.approve({ actor: human })).toThrow(PublishRefused);
  expect(f.s.state.published).toHaveLength(1);
});

/** Another writer appends once (or every time) while the bundle is being stored. */
function interfere(times: number): { count: () => number } {
  const put = f.s.blobs.put.bind(f.s.blobs);
  let n = 0;
  f.s.blobs.put = ((...a: Parameters<typeof put>) => {
    if (n < times) { n++; f.s.commit(() => [{ type: "budget.set", actor: human, payload: { tokens: 1000 + n } }]); }
    return put(...a);
  }) as typeof f.s.blobs.put;
  return { count: () => n };
}

test("an entry that arrives while the bundle is built makes approval start again", async () => {
  const r = await gated();
  const i = interfere(1);
  const res = r.engine.approve({ actor: human });
  expect(i.count()).toBe(1);
  expect(readdirSync(join(f.s.dir, "published"))).toEqual(["1"]);
  const manifest = JSON.parse(read(res.dir, "manifest.json")) as { head: { seq: number } };
  const gate = f.s.entries().find((e) => e.type === "gate.passed" && e.payload.gate === "publish")!;
  expect(manifest.head.seq).toBe(gate.seq - 1);
});

test("approval gives up after three attempts, leaving nothing behind", async () => {
  const r = await gated();
  const i = interfere(10);
  expect(() => r.engine.approve({ actor: human })).toThrow(PublishRefused);
  expect(i.count()).toBe(3);
  expect(readdirSync(join(f.s.dir, "published"))).toEqual([]);
  expect(f.s.state.published).toEqual([]);
});

test("a person's rejection is refused when the Publish stage has nowhere to send work back to", async () => {
  const r = await gated();
  const pipeline = { ...r.deps.pipeline, stages: r.deps.pipeline.stages.map((s) => (s.id === "publish" ? { ...s, on_fail: null } : s)) };
  expect(() => reject(f.s, pipeline, { reason: "no", stop: false, actor: human })).toThrow(PublishRefused);
  expect(ofType("publish.rejected")).toEqual([]);
  reject(f.s, pipeline, { reason: "no", stop: true, actor: human });
  expect(f.s.state.run.outcome).toBe("stopped");
});
