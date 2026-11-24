import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose } from "../../src/cli/compose";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import { blockers, fold } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Actor, Entry } from "../../src/core/types";
import { verifyCase, verifyLedger } from "../../src/core/verify";
import { Workbench } from "../../src/core/workbench";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import { MOP_IDS } from "../../src/pipeline/feedback";
import { sampleRoot } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
const SECRET = "planted-secret-value-91d7";

interface Run {
  dir: string; wb: Workbench; s: CaseSession; engine: Engine; close(): void; stop(): void; sample: ReturnType<typeof sampleRoot>; config: Config;
  seenLive: Map<number, CaseState>; problems: string[];
}

const dirs: string[] = [];
const open: Run[] = [];

function configFor(dir: string, sample: ReturnType<typeof sampleRoot>, parallel = 3): Config {
  return { ...loadConfig({ env: {}, home: dir, repoRoot: dir }), data_dir: join(dir, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel } };
}

/** The sample as a workbench, a case, and an engine built the way the command builds one. */
function begin(parallel = 3, keep = false): Run {
  const dir = mkdtempSync(join(tmpdir(), "full-run-"));
  dirs.push(dir);
  const sample = sampleRoot(dir);
  const config = configFor(dir, sample, parallel);
  const wb = Workbench.open(config.data_dir, { onError: () => {} });
  const composed = compose(config, wb);
  const s = wb.createCase({ title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" }, human);
  const seenLive = new Map<number, CaseState>();
  s.subscribe((e, st) => { seenLive.set(e.seq, st as CaseState); });
  const run: Run = {
    dir, wb, s, engine: new Engine(s, composed.deps), sample, config, seenLive, problems: composed.problems,
    close(): void { try { wb.close(); } finally { composed.close(); } },
    stop(): void { this.close(); sample.close(); },
  };
  if (!keep) open.push(run);
  return run;
}

/** Closes the workbench and opens it again, as a second process would; the case's session is fresh, so its engine recovers it. */
function reopen(r: Run): Run {
  r.close();
  const wb = Workbench.open(r.config.data_dir, { onError: () => {} });
  const composed = compose(r.config, wb);
  const s = wb.session(r.s.id);
  const seenLive = new Map<number, CaseState>();
  s.subscribe((e, st) => { seenLive.set(e.seq, st as CaseState); });
  const again: Run = { ...r, wb, s, engine: new Engine(s, composed.deps), seenLive, close(): void { try { wb.close(); } finally { composed.close(); } } };
  open.push(again);
  return again;
}

afterEach(() => {
  for (const r of open.splice(0)) {
    expect(r.s.state.skipped).toEqual([]);
    try { r.stop(); } catch { /* already closed */ }
  }
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The whole run, once, shared by the tests that only read it. */
let shared: Run;
let entries: Entry[];
let approved: { n: number; dir: string; draft_hash: string };
let secretBefore: string | undefined;

beforeAll(async () => {
  secretBefore = process.env.SAMPLE_PLANTED_SECRET;
  process.env.SAMPLE_PLANTED_SECRET = SECRET;
  shared = begin(3, true);
});
afterAll(() => {
  if (secretBefore === undefined) delete process.env.SAMPLE_PLANTED_SECRET;
  else process.env.SAMPLE_PLANTED_SECRET = secretBefore;
  try { shared.stop(); } catch { /* closed */ }
});

const ofType = <T extends Entry["type"]>(t: T): Extract<Entry, { type: T }>[] => entries.filter((e): e is Extract<Entry, { type: T }> => e.type === t);

test("a full scripted run reaches the publish gate", async () => {
  const s = shared.s;
  const { engine } = shared;
  expect(shared.problems).toEqual([]);
  engine.start(human);
  const first = await engine.advance();
  expect(first.waiting).toBe("plan");
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(s.state.run.sendbacks).toEqual({ "checks>assemble": 1 });
  expect(s.state.drafts.map((d) => d.n)).toEqual([1, 2]);
  expect(blockers(s.state, s.state.drafts[1]!.hash)).toEqual([]);
  expect(s.state.skipped).toEqual([]);
  entries = s.entries();
});

test("every one of the eleven checks passes on the published draft", () => {
  const s = shared.s;
  const hash = s.state.drafts[1]!.hash;
  const review = s.state.reviews[hash]!;
  expect(review.checks.length).toBe(11);
  expect(review.checks.filter((c) => !c.pass).map((c) => c.check)).toEqual([]);
  // the first draft failed check 3, the planted fault
  const first = s.state.reviews[s.state.drafts[0]!.hash]!;
  expect(first.checks.filter((c) => !c.pass).map((c) => c.check)).toEqual(["confidence-and-likelihood"]);
});

test("the run found the account, hit a dead end, a partial result and a proven negative, and paid for one lookup", () => {
  const s = shared.s;
  const cards = Object.values(s.state.cards);
  const titled = (t: string) => cards.find((c) => c.title === t);
  expect(JSON.stringify(titled("Accounts that signed in to the asset: ws-17.example.net")?.rows)).toContain("j.doe");
  const negative = titled("Asset with the address, by asset list: 198.51.100.77")!;
  expect(negative.row_count).toBe(0);
  expect(negative.empty).toBe("proven-negative");
  const peers = titled("Hosts that connected to the address: 198.51.100.77")!;
  expect(peers.coverage?.kind).toBe("partial");
  expect(JSON.stringify(peers.rows)).toContain("192.0.2.17");
  expect(JSON.stringify(titled("Reputation verdict for the address: 198.51.100.77")?.rows)).toContain("suspicious");
  expect(JSON.stringify(titled("Addresses the account signed in from: j.doe")?.rows)).toContain("203.0.113.50");
  // the dead end: s1 found nothing; the account came from the re-route
  expect(s.state.plan.steps.s1!.status).toBe("empty");
  expect(s.state.plan.steps.s2!.status).toBe("answered");
  // one costly lookup, run by a person's budget through a proposal
  const costly = Object.values(s.state.proposals).filter((p) => p.kind === "costly_query");
  expect(costly.length).toBe(1);
  expect(entries.filter((e) => e.type === "query.issued" && e.payload.source === "reputation").length).toBe(1);
  expect(s.state.plan.steps.s3!.status).toBe("answered");
});

test("custody: every card traces to a query issued, a query result and a blob", () => {
  const s = shared.s;
  expect(Object.keys(s.state.cards).length).toBeGreaterThanOrEqual(6);
  for (const card of Object.values(s.state.cards)) {
    expect(card.query).not.toBeNull();
    const q = s.state.queries[card.query!]!;
    expect(entries.find((e) => e.seq === q.issued_seq)?.type).toBe("query.issued");
    expect(entries.some((e) => e.type === "query.result" && e.payload.query === q.id)).toBe(true);
    expect(s.blobs.check(q.result!.blob)).toBe("ok");
  }
});

test("custody: every model request has its response and every tool call its return, each with blobs that are there", () => {
  const s = shared.s;
  const reqs = ofType("model.request");
  expect(reqs.length).toBeGreaterThan(20);
  for (const r of reqs) {
    const answers = entries.filter((e) => (e.type === "model.response" || e.type === "model.declined") && e.payload.request === r.payload.request);
    expect(answers.map((a) => a.type)).toEqual(["model.response"]);
    expect(s.blobs.check(r.payload.messages.blob)).toBe("ok");
  }
  for (const r of ofType("model.response")) {
    expect(s.blobs.check(r.payload.response.blob)).toBe("ok");
    expect(reqs.filter((x) => x.payload.request === r.payload.request).length).toBe(1);
  }
  const called = ofType("tool.called");
  expect(called.length).toBeGreaterThan(20);
  for (const c of called) {
    const back = entries.filter((e) => e.type === "tool.returned" && e.payload.call === c.payload.call);
    expect(back.length).toBe(1);
    const ret = back[0]!;
    if (ret.type === "tool.returned" && ret.payload.result !== null) expect(s.blobs.check(ret.payload.result.blob)).toBe("ok");
  }
  expect(ofType("tool.returned").length).toBe(called.length);
});

test("custody: chain verification passes, for the case and for the workbench chain", () => {
  const rep = verifyCase(shared.s.dir);
  expect(rep.ok).toBe(true);
  expect(rep.blobs.bad).toEqual([]);
  const chain = verifyLedger(join(shared.config.data_dir, "workbench.sqlite"), join(shared.config.data_dir, "blobs"));
  expect(chain.ok).toBe(true);
});

test("custody: replay ends in the same state as live, and matches at every entry", () => {
  const s = shared.s;
  expect(fold(s.entries())).toEqual(s.state);
  // the subscriber joined after case.created, which is entry 1
  expect(shared.seenLive.size).toBe(s.entries().length - 1);
  expect(s.stateAt(1).meta?.title).toBe("Sample");
  for (const [seq, live] of shared.seenLive) expect(s.stateAt(seq)).toEqual(live);
});

test("no agent accepted, kept, moved, discarded or published anything, and none set a budget", () => {
  const banned = new Set<string>([
    "plan.accepted", "plan.denied", "plan.replan_requested", "gate.passed", "card.kept", "card.moved", "card.discarded", "card.restored", "card.sent_back", "card.pinned",
    "lane.created", "lane.renamed", "lane.removed", "lane.target_set", "product.published", "publish.rejected", "budget.set", "run.started", "run.finished", "run.resumed",
    "stage.model_set", "stage.pack_limit_set", "feedback.recorded",
  ]);
  const byAgent = entries.filter((e) => e.actor.kind === "agent");
  expect(byAgent.length).toBeGreaterThan(20);
  expect(byAgent.filter((e) => banned.has(e.type)).map((e) => e.type)).toEqual([]);
  // the person's budget ran the costly step, in the person's name
  const paid = entries.filter((e) => e.type === "query.issued" && e.payload.source === "reputation");
  expect(paid[0]!.actor).toEqual(human);
});

test("no secret is in any entry or blob, and no source location is in anything a model was sent", () => {
  const s = shared.s;
  const text = (e: Entry): string => JSON.stringify(e);
  expect(entries.some((e) => text(e).includes(SECRET))).toBe(false);
  const blobs = new Set<string>();
  for (const e of entries) {
    if (e.type === "query.result") blobs.add(e.payload.result.blob);
    else if (e.type === "model.request") blobs.add(e.payload.messages.blob);
    else if (e.type === "model.response") { blobs.add(e.payload.response.blob); if (e.payload.reasoning !== null) blobs.add(e.payload.reasoning.blob); }
    else if (e.type === "tool.returned" && e.payload.result !== null) blobs.add(e.payload.result.blob);
  }
  for (const b of blobs) expect(s.blobs.text(b).includes(SECRET)).toBe(false);
  const where = [shared.sample.fixture.url, shared.sample.root, "reputation-server", "127.0.0.1"];
  const sent = [...ofType("model.request").map((e) => e.payload.messages.blob), ...ofType("tool.returned").flatMap((e) => (e.payload.result === null ? [] : [e.payload.result.blob]))];
  for (const b of sent) for (const w of where) expect(s.blobs.text(b).includes(w)).toBe(false);
});

test("approving publishes exactly the reviewed revision and finishes the run", async () => {
  const s = shared.s;
  approved = shared.engine.approve({ actor: human });
  expect(approved.draft_hash).toBe(s.state.drafts[1]!.hash);
  expect((await shared.engine.advance()).outcome).toBe("published");
  expect(s.state.feedback.map((f) => f.measure)).toEqual([...MOP_IDS]);
  expect(s.state.feedback.find((f) => f.measure === "send_backs")!.value).toBe(1);
  expect(verifyCase(s.dir).ok).toBe(true);
  entries = s.entries();
});

test("custody: the bundle's product hash is the published draft's and its manifest head is a real entry", () => {
  const s = shared.s;
  const dir = join(s.dir, approved.dir);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { draft_hash: string; head: { seq: number; hash: string }; files: { name: string; sha256: string }[] };
  const productText = readFileSync(join(dir, "product.json"), "utf8");
  expect(sha256Hex(productText)).toBe(approved.draft_hash);
  expect(manifest.draft_hash).toBe(approved.draft_hash);
  expect(manifest.files.find((f) => f.name === "product.json")!.sha256).toBe(approved.draft_hash);
  const head = entries.find((e) => e.seq === manifest.head.seq);
  expect(head).toBeDefined();
  expect((head as unknown as { hash: string }).hash).toBe(manifest.head.hash);
  expect(s.state.published.map((p) => p.draft_hash)).toEqual([approved.draft_hash]);
  expect(s.state.skipped).toEqual([]);
});

async function throughPlan(r: Run): Promise<void> {
  r.engine.start(human);
  expect((await r.engine.advance()).waiting).toBe("plan");
}

test("the same run split across a stop at the plan gate ends in the same published hash", async () => {
  let r = begin();
  await throughPlan(r);
  r = reopen(r);
  r.engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  const out = r.engine.approve({ actor: human });
  expect(out.draft_hash).toBe(approved.draft_hash);
  expect((await r.engine.advance()).outcome).toBe("published");
  expect(verifyCase(r.s.dir).ok).toBe(true);
});

test("the same run split across a stop in the middle of research ends in the same published hash", async () => {
  let r = begin(1);
  await throughPlan(r);
  r.engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  let paused = false;
  const live = r;
  r.s.subscribe((e) => {
    if (!paused && e.type === "step.finished" && e.payload.step === "s1") {
      paused = true;
      live.engine.pause(human);
    }
  });
  const stopped = await r.engine.advance();
  expect(stopped.status).toBe("paused");
  expect(r.s.state.plan.steps.s1!.status).toBe("empty");
  r = reopen(r);
  const resumed = await r.engine.resume(human);
  expect(resumed).toMatchObject({ status: "waiting", waiting: "publish" });
  const out = r.engine.approve({ actor: human });
  expect(out.draft_hash).toBe(approved.draft_hash);
  expect((await r.engine.advance()).outcome).toBe("published");
  expect(verifyCase(r.s.dir).ok).toBe(true);
  expect(fold(r.s.entries())).toEqual(r.s.state);
});

test("with three researchers at once the script still resolves every card", async () => {
  const r = begin(3);
  await throughPlan(r);
  r.engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await r.engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(r.s.state.drafts[1]!.hash).toBe(approved.draft_hash);
  expect(r.s.state.reviews[r.s.state.drafts[1]!.hash]!.checks.every((c) => c.pass)).toBe(true);
});
