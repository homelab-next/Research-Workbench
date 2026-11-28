// Slice 15's acceptance: an investigation of a synthetic case on the fake lake, on the scripted model, from start to a published product;
// what it cost and how budgets held it; that the judge stays blind and the setup keeps to its own folder. A tiny --scripted setup is built once
// under a fresh temporary folder, with TINY_PARAMS; every case here is synthetic and every folder is removed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { TINY_PARAMS } from "pivot/synth/params";
import type { GroundTruth } from "pivot/synth/truth";
import { compose } from "../../src/cli/compose";
import { hostsFor } from "../../src/cli/improve";
import type { CaseSession } from "../../src/core/session";
import { blockers, fold } from "../../src/core/state";
import type { Actor, Cost, Entry } from "../../src/core/types";
import { verifyCase } from "../../src/core/verify";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { StageRunner } from "../../src/pipeline/engine";
import { checkEstimate, estimateStep } from "../../src/pipeline/plans";
import { buildSetup } from "../../src/synth/build";
import { setupOf } from "../../src/synth/setup";
import { rowsOfBlob } from "../../src/modules/connectors/rows";
import { runPivot } from "../../src/modules/pivots";
import { runProposal } from "../../src/modules/proposals";
import { rowsHash } from "../../src/modules/runner";
import type { RunQueryResult } from "../../src/modules/runner";
import { caseInput, readIndex, SYNTH_OBJECTIVE } from "../../src/synth/tasks";
import { cleanEnv } from "../helpers/clean-env";
import { synthRun, truthOf } from "../helpers/synth-script";

const REPO = join(import.meta.dir, "..", "..");

let run: ReturnType<typeof synthRun>;
let human: Actor;
let session: CaseSession;
let engine: Engine;
let entries: Entry[];
let outsideRun: RunQueryResult;
let fetches = 0;
let fetchBefore: typeof globalThis.fetch;
/** The state after each seq, as the session had it live. */
const live = new Map<number, unknown>();

beforeAll(async () => {
  fetchBefore = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => { fetches++; throw new Error("no network in this file"); }, { preconnect: () => {} }) as unknown as typeof fetch;
  run = synthRun("password-spray");
  human = { kind: "human", id: run.config.user };
  const id = readIndex(run.config).cases.find((c) => c.storyline === "password-spray")!.case;
  session = run.wb.session(id);
  session.subscribe((e, st) => { live.set(e.seq, st); });
  engine = Engine.open(session, run.deps);
}, 120_000);
afterAll(() => {
  for (const e of [engine, ...engines]) try { e?.close(); } catch { /* closed */ }
  run?.close();
  globalThis.fetch = fetchBefore;
});

const ofType = <T extends Entry["type"]>(t: T): Extract<Entry, { type: T }>[] => entries.filter((e): e is Extract<Entry, { type: T }> => e.type === t);

test("a tiny synthetic setup builds, its configuration loads, and its root composes with no problem once the script is there", () => {
  const composed = compose(run.config, run.wb);
  try {
    expect(composed.problems).toEqual([]);
  } finally {
    composed.close();
  }
  expect(run.deps.loops!.current("investigation")).not.toBeNull();
  expect(session.state.meta!.title.startsWith("[synthetic] ")).toBe(true);
});

test("an investigation of the password-spray case runs on the scripted model from start to a published product", async () => {
  // start as the person; plan gate; accept with budgets; publish gate with no blocker; approve; run finished, outcome published; state.skipped is []
  engine.start(human);
  expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "plan" });
  engine.acceptPlan({ budgets: { s2: 1, s3: 1 }, actor: human });
  const atPublish = await engine.advance();
  expect({ status: atPublish.status, waiting: atPublish.waiting, pause: session.state.run.pause_reason }).toEqual({ status: "waiting", waiting: "publish", pause: null });
  // the researcher's lookup outside the plan waits for the person, who runs it with a budget of their own before approving
  const outside = Object.values(session.state.proposals).filter((p) => p.kind === "costly_query" && p.step === null);
  expect(outside.map((p) => p.status)).toEqual(["open"]);
  outsideRun = await runProposal(session, run.deps.runner, { proposal: outside[0]!.id, budget: 1, actor: human });
  const draft = session.state.drafts.at(-1)!;
  expect(blockers(session.state, draft.hash)).toEqual([]);
  engine.approve({ actor: human, unload_after: false });
  await engine.advance();
  expect(session.state.run.status).toBe("finished");
  expect(session.state.run.outcome).toBe("published");
  expect(session.state.published.map((p) => p.n)).toEqual([1]);
  expect(session.state.skipped).toEqual([]);
  entries = session.entries();
}, 120_000);

test("a synth tasks case carries the setup's objective, so its product passes every check, and the objective names no verdict, no storyline and no truth", () => {
  expect(session.state.meta!.objective).toBe(SYNTH_OBJECTIVE);
  const draft = session.state.drafts.find((d) => d.hash === session.state.published[0]!.draft_hash)!;
  const review = session.state.reviews[draft.hash]!;
  expect(review.checks.length).toBe(11);
  expect(review.checks.filter((c) => !c.pass).map((c) => c.check)).toEqual([]);
  const objective = run.deps.registry.get("objective", SYNTH_OBJECTIVE)!;
  expect(draft.product.objective).toBe(objective.body.title as string);
  const text = readFileSync(join(REPO, "synth", "root", "context", `${SYNTH_OBJECTIVE}.yaml`), "utf8");
  const truths = setupOf(run.config).setup.storylines.map((x) => truthOf(run, x.id));
  for (const t of truths) {
    for (const x of [t.summary, ...t.findings.map((f) => f.claim), t.storyline, t.title]) expect({ x, holds: text.includes(x) }).toEqual({ x, holds: false });
  }
  expect(/\b(?:malicious|benign)\b/i.test(text)).toBe(false);
});

test("every query of the run is on a fakeathena source, went through runQuery (query.issued before query.result), and its stored result reads back", () => {
  const issued = ofType("query.issued");
  expect(issued.length).toBeGreaterThan(0);
  for (const q of issued) {
    expect(q.payload.connector).toBe("fakeathena");
    const closed = entries.filter((e) => (e.type === "query.result" || e.type === "query.failed") && e.payload.query === q.payload.query);
    expect(closed.map((e) => e.type)).toEqual(["query.result"]);
    expect(closed[0]!.seq).toBeGreaterThan(q.seq);
    const result = session.state.queries[q.payload.query]!.result!;
    expect(session.blobs.check(result.blob)).toBe("ok");
    const raw = JSON.parse(new TextDecoder().decode(session.blobs.get(result.blob))) as { columns: string[]; rows: unknown[][]; stats: { bytes_scanned: number } };
    expect(Array.isArray(raw.columns) && Array.isArray(raw.rows)).toBe(true);
    // an estimate's one row is the price; a result's raw bytes carry what it scanned beside its rows
    if (q.payload.purpose === "estimate") expect(raw.columns).toEqual(["bytes_scanned", "billed_bytes", "partitions", "usd"]);
    else expect(typeof raw.stats.bytes_scanned).toBe("number");
    const back = rowsOfBlob(run.deps.registry.source(q.payload.source)!, q.payload, session.blobs.get(result.blob), session.state.queries[q.payload.query]!.rows);
    expect(back).not.toBeNull();
    expect(rowsHash(back!.columns, back!.rows)).toBe(session.state.queries[q.payload.query]!.rows_hash!);
  }
});

test("the case verifies, and fold(entries, n) for every n is the state the session had at n", () => {
  expect(verifyCase(session.dir).ok).toBe(true);
  // the subscriber joined once the case was made, so every later entry was seen live
  const all = session.entries();
  expect(fold(all)).toEqual(session.state);
  const seen = all.filter((e) => live.has(e.seq));
  expect(seen.length).toBeGreaterThan(all.length - 3);
  for (const e of seen) expect({ seq: e.seq, state: fold(all, e.seq) }).toEqual({ seq: e.seq, state: live.get(e.seq) as never });
});

// ---------- costs and budgets ----------

/** Engines of the cases made below, closed with the setup. */
const engines: Engine[] = [];
/** A new case of the storyline, made as synth tasks makes one, run by the person to its plan gate. */
async function atPlanGate(): Promise<{ s: CaseSession; e: Engine }> {
  const s = run.wb.createCase(caseInput(run.truth, "TLP:GREEN"), human, { default_loop: run.config.loops.default, type: run.truth.task.case_type });
  const e = Engine.open(s, run.deps);
  engines.push(e);
  e.start(human);
  expect(await e.advance()).toMatchObject({ status: "waiting", waiting: "plan" });
  return { s, e };
}

/** The cost model's figure, worked here from the lake's own table and partition lists: the days the window touches, the columns named. */
function modelCost(table: string, text: string, window: { from: string | null; to: string | null }): Cost {
  const db = new Database(join(run.dir, "lake.sqlite"), { readonly: true });
  try {
    const columns = JSON.parse((db.query("select columns from _lake_tables where name = ?").get(table) as { columns: string }).columns) as string[];
    const named = Math.max(1, columns.filter((c) => new RegExp(`(?<![\\w])${c}(?![\\w])`).test(text)).length);
    const from = window.from!.slice(0, 10);
    const last = new Date(Date.parse(window.to!) - 1).toISOString().slice(0, 10);
    const parts = db.query("select dt, bytes from _lake_partitions where tbl = ?").all(table) as { dt: string; bytes: number }[];
    const bytes = parts.filter((p) => p.dt >= from && p.dt <= last).reduce((n, p) => n + p.bytes, 0);
    const billed = Math.max(Math.ceil((bytes * named) / columns.length), 10_000_000);
    return { amount: Math.round(((billed * 5) / 1_000_000_000_000) * 1e6) / 1e6, unit: "USD" };
  } finally {
    db.close();
  }
}

const address = (): string => run.truth.entities.find((e) => e.role === "attacker")!.value;
const pivotText = (id: string): string => run.deps.registry.pivot(id)!.query;
const issuedOf = (s: CaseSession) => s.entries().filter((e): e is Extract<Entry, { type: "query.issued" }> => e.type === "query.issued");
const resultOf = (s: CaseSession, query: string) => s.entries().find((e): e is Extract<Entry, { type: "query.result" }> => e.type === "query.result" && e.payload.query === query);
const costly = (source: string): boolean => run.deps.registry.source(source)!.cost.weight > 0;

let gate: { s: CaseSession; e: Engine };

test("at the plan gate the asset step is free and the sign-in and reputation steps are costly, each with its estimate in USD", async () => {
  gate = await atPlanGate();
  const steps = gate.s.state.plan.current!.steps;
  expect(steps.map((x) => [x.id, x.pivot, x.free])).toEqual([["s1", "address_to_asset", true], ["s2", "address_to_signins", false], ["s3", "address_to_reputation", false]]);
  expect(() => checkEstimate(gate.s, { step: "s1", actor: human })).toThrow("free");
  const s2 = await estimateStep(gate.s, run.deps.runner, { step: "s2", actor: human });
  const s3 = await estimateStep(gate.s, run.deps.runner, { step: "s3", actor: human });
  expect(s2).toEqual(modelCost("signins", pivotText("address_to_signins"), run.truth.task.window));
  expect(s3).toEqual({ amount: 0.002, unit: "USD" });
  expect(gate.s.state.plan.estimates).toEqual({ s2: s2!, s3: s3! });
  expect(gate.s.state.skipped).toEqual([]);
});

test("each costly step's estimate is a query of its own in the ledger, purpose estimate, whose one row holds the bytes scanned", () => {
  const estimated = gate.s.entries().filter((e): e is Extract<Entry, { type: "step.estimated" }> => e.type === "step.estimated");
  expect(estimated.map((e) => e.payload.step)).toEqual(["s2", "s3"]);
  // the lake is asked for the sign-in step's price
  const q = gate.s.state.queries[estimated[0]!.payload.query!]!;
  expect({ purpose: q.purpose, step: q.step, source: q.source }).toEqual({ purpose: "estimate", step: "s2", source: "signins" });
  const issued = issuedOf(gate.s).find((e) => e.payload.query === q.id)!;
  expect(issued.payload.text.startsWith("EXPLAIN (TYPE IO, FORMAT JSON) ")).toBe(true);
  const raw = JSON.parse(new TextDecoder().decode(gate.s.blobs.get(q.result!.blob))) as { columns: string[]; rows: number[][] };
  expect(raw.columns).toEqual(["bytes_scanned", "billed_bytes", "partitions", "usd"]);
  expect(raw.rows.length).toBe(1);
  expect(raw.rows[0]![0]).toBeGreaterThan(0);
  expect(raw.rows[0]![3]).toBe(estimated[0]!.payload.estimate!.amount);
  // a per-lookup source is priced as the http connector prices a request: by its manifest, with nothing asked of the lake
  expect(estimated[1]!.payload.query).toBeNull();
  expect(issuedOf(gate.s).filter((e) => e.payload.source === "reputation")).toEqual([]);
});

test("accepting the plan with no budget runs the free step only; the costly steps wait", async () => {
  gate.e.acceptPlan({ actor: human });
  await gate.e.advance();
  const { steps } = gate.s.state.plan;
  expect(steps.s1!.status).toBe("empty");
  expect(steps.s2!.status === "answered" || steps.s3!.status === "answered").toBe(false);
  const accepted = gate.s.entries().find((e) => e.type === "plan.accepted")!;
  const ran = issuedOf(gate.s).filter((e) => e.seq > accepted.seq && e.payload.purpose === "result");
  expect(ran.map((e) => e.payload.source)).toEqual(["assets"]);
  // each costly step left a proposal waiting for a person, with its price
  const waiting = Object.values(gate.s.state.proposals).flatMap((p) => (p.kind === "costly_query" && p.status === "open" && p.step !== null ? [p] : []));
  expect(waiting.map((p) => p.step).sort()).toEqual(["s2", "s3"]);
  for (const p of waiting) expect(p.estimate?.unit).toBe("USD");
  expect(gate.s.state.skipped).toEqual([]);
}, 120_000);

test("a budget below the sign-in step's estimate runs nothing of it and leaves a record of the price; a budget that covers it runs it", async () => {
  const c = await atPlanGate();
  const price = modelCost("signins", pivotText("address_to_signins"), run.truth.task.window);
  const low = price.amount / 2;
  c.e.acceptPlan({ budgets: { s2: low }, actor: human });
  await c.e.advance();
  const signins = () => issuedOf(c.s).filter((e) => e.payload.source === "signins" && e.payload.purpose === "result");
  expect(signins()).toEqual([]);
  const repriced = c.s.entries().filter((e): e is Extract<Entry, { type: "proposal.repriced" }> => e.type === "proposal.repriced");
  expect(repriced.length).toBe(1);
  expect({ budget: repriced[0]!.payload.budget, estimate: repriced[0]!.payload.estimate }).toEqual({ budget: low, estimate: price });
  expect(repriced[0]!.actor).toEqual(human);
  const p = c.s.state.proposals[repriced[0]!.payload.proposal]!;
  expect(p.kind === "costly_query" && { status: p.status, step: p.step, refused_budget: p.refused_budget }).toEqual({ status: "open", step: "s2", refused_budget: low });
  // the person's budget that covers it runs it
  const r = await runProposal(c.s, run.deps.runner, { proposal: p.id, budget: price.amount, actor: human });
  expect(r.status).toBe("done");
  expect(signins().length).toBe(1);
  expect(resultOf(c.s, signins()[0]!.payload.query)!.payload.cost).toEqual(price);
  expect(c.s.state.skipped).toEqual([]);
}, 120_000);

test("the sign-in result's cost is the estimate, and both are the cost model's figure for the step's window, computed in the test from the lake's partitions", () => {
  const q = issuedOf(session).find((e) => e.payload.pivot === "address_to_signins" && e.payload.purpose === "result")!;
  expect(q.payload.step).toBe("s2");
  const step = session.state.plan.current!.steps.find((x) => x.id === "s2")!;
  const price = modelCost("signins", pivotText("address_to_signins"), { from: step.window.from!, to: step.window.to! });
  expect(q.payload.estimate).toEqual(price);
  expect(resultOf(session, q.payload.query)!.payload.cost).toEqual(price);
  const raw = JSON.parse(new TextDecoder().decode(session.blobs.get(session.state.queries[q.payload.query]!.result!.blob))) as { stats: { usd: number } };
  expect(raw.stats.usd).toBe(price.amount);
});

test("the same pivot over the case's window costs less than over the whole period", async () => {
  /* two estimates, by a person, no budget: needs_budget with each */
  const { params } = setupOf(run.config).setup;
  const start = `${params.start}T00:00:00.000Z`;
  const period = { from: start, to: new Date(Date.parse(start) + params.days * 86_400_000).toISOString() };
  const ask = (window: { from: string | null; to: string | null }) => runPivot(gate.s, run.deps.runner, { pivot: "address_to_signins", value: address(), window, why: "what would it cost", actor: human, budget: null });
  const narrow = await ask(run.truth.task.window);
  const wide = await ask(period);
  if (narrow.status !== "needs_budget" || wide.status !== "needs_budget") throw new Error(`${narrow.status}, ${wide.status}`);
  expect({ narrow: narrow.proposal, wide: wide.proposal }).toEqual({ narrow: null, wide: null });
  expect(narrow.estimate).toEqual(modelCost("signins", pivotText("address_to_signins"), run.truth.task.window));
  expect(wide.estimate).toEqual(modelCost("signins", pivotText("address_to_signins"), period));
  expect(narrow.estimate!.amount).toBeLessThan(wide.estimate!.amount);
});

test("the reputation step costs its per-lookup price whatever it returned", async () => {
  const q = issuedOf(session).find((e) => e.payload.pivot === "address_to_reputation" && e.payload.purpose === "result")!;
  expect(resultOf(session, q.payload.query)!.payload.cost).toEqual({ amount: 0.002, unit: "USD" });
  // an address the feeds do not list costs the same
  const db = new Database(join(run.dir, "lake.sqlite"), { readonly: true });
  let unknown: string;
  try {
    unknown = [...Array(250).keys()].map((n) => `192.0.2.${n + 1}`).find((a) => db.query("select 1 from reputation where indicator = ?").get(a) === null)!;
  } finally {
    db.close();
  }
  const r = await runPivot(gate.s, run.deps.runner, { pivot: "address_to_reputation", value: unknown, window: run.truth.task.window, why: "an address no feed lists", actor: human, budget: 1 });
  if (r.status !== "done") throw new Error(JSON.stringify(r));
  expect(r.rows).toBe(0);
  expect(resultOf(gate.s, r.query)!.payload.cost).toEqual({ amount: 0.002, unit: "USD" });
});

test("the researcher's costly lookup outside the plan becomes a costly_query proposal with an estimate; the person's budget runs it", () => {
  const outside = Object.values(session.state.proposals).filter((p) => p.kind === "costly_query" && p.step === null);
  expect(outside.length).toBe(1);
  const p = outside[0]!;
  if (p.kind !== "costly_query") throw new Error("not a costly query");
  const account = run.truth.entities.find((e) => e.role === "victim")!.value;
  expect({ by: p.by, source: p.source, bound: p.bound, status: p.status }).toEqual({ by: "researcher-g2", source: "signins", bound: { value: account }, status: "accepted" });
  expect(p.estimate).toEqual(modelCost("signins", pivotText("account_to_signins"), run.truth.task.window));
  expect(outsideRun.status).toBe("done");
  const accepted = entries.find((e) => e.type === "proposal.accepted" && e.payload.proposal === p.id)!;
  expect(accepted.actor).toEqual(human);
  if (outsideRun.status !== "done") throw new Error("not run");
  expect(resultOf(session, outsideRun.query)!.payload.cost).toEqual(p.estimate);
});

test("the run's query_cost measure is the sum of the costs the sources reported, in USD", () => {
  const from = entries.findLastIndex((e) => e.type === "run.started");
  let sum = 0;
  for (const e of entries.slice(from)) {
    if (e.type !== "query.result" || e.payload.cost === null) continue;
    expect(e.payload.cost.unit).toBe("USD");
    sum += e.payload.cost.amount;
  }
  expect(sum).toBeGreaterThan(0);
  const measured = entries.filter((e): e is Extract<Entry, { type: "feedback.recorded" }> => e.type === "feedback.recorded" && e.payload.measure === "query_cost");
  expect(measured.map((e) => e.payload.value)).toEqual([`${sum} USD`]);
});

test("an acceptance with no budget issues no costly query: after it, no query.issued of purpose result names a costly source", () => {
  const accepted = gate.s.entries().find((e) => e.type === "plan.accepted")!;
  expect(accepted.type === "plan.accepted" && accepted.payload.budgets).toEqual({});
  // the person's own priced lookups above came later, each with a budget of the person's; none is the acceptance's
  const firstOwn = issuedOf(gate.s).find((e) => e.payload.why.endsWith("what would it cost"))!.seq;
  const after = issuedOf(gate.s).filter((e) => e.seq > accepted.seq && e.seq < firstOwn && e.payload.purpose === "result");
  expect(after.length).toBeGreaterThan(0);
  expect(after.filter((e) => costly(e.payload.source)).map((e) => e.payload.source)).toEqual([]);
});

// ---------- blindness and separation ----------

/** Every blob an entry's payload names, at any depth. */
function blobsOf(x: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(x)) for (const v of x) blobsOf(v, out);
  else if (x !== null && typeof x === "object") {
    const o = x as Record<string, unknown>;
    if (typeof o.blob === "string" && /^[0-9a-f]{64}$/.test(o.blob)) out.add(o.blob);
    for (const v of Object.values(o)) blobsOf(v, out);
  }
  return out;
}
/** The truth's summary and each claim, as written and as JSON writes them inside a string. */
const secretsOf = (truths: GroundTruth[]): string[] => truths.flatMap((t) => [t.summary, ...t.findings.map((f) => f.claim)]).flatMap((x) => [x, JSON.stringify(x).slice(1, -1)]);
const textOf = (s: CaseSession, blob: string): string => new TextDecoder().decode(s.blobs.get(blob));

test("no model.request and no tool.returned of the investigation holds the truth's summary or a claim, word for word", () => {
  const secrets = secretsOf([run.truth]);
  for (const s of [session, gate.s]) {
    const said = s.entries().filter((e) => e.type === "model.request" || e.type === "tool.returned");
    expect(said.length).toBeGreaterThan(10);
    for (const e of said) {
      const texts = [JSON.stringify(e.payload), ...[...blobsOf(e.payload)].map((b) => textOf(s, b))];
      for (const x of secrets) expect({ seq: e.seq, holds: texts.some((t) => t.includes(x)) }).toEqual({ seq: e.seq, holds: false });
    }
  }
});

/** A second tiny setup, worked by the person's own commands, each spawned with a clean environment and a HOME of its own. */
let second: { tmp: string; home: string; dir: string; config: Config; truths: GroundTruth[] } | null = null;
afterAll(() => {
  if (second !== null) rmSync(second.tmp, { recursive: true, force: true });
});

function synth(args: string[]): { code: number; out: string } {
  const p = Bun.spawnSync([process.execPath, "run", "synth", ...args], { cwd: REPO, env: cleanEnv(second!.home), stdout: "pipe", stderr: "pipe", timeout: 240_000 });
  return { code: p.exitCode ?? -1, out: `${p.stdout.toString()}${p.stderr.toString()}` };
}

test("after synth tasks and synth seed-tasks on the setup, an improve run's Select takes the seeded cases of a type as tasks, and no request before the Judge holds a truth's claim", async () => {
  // Select only, driven with the improve loop's own runner; then read every blob the improve case names
  const tmp = mkdtempSync(join(tmpdir(), "synth-accept-"));
  mkdirSync(join(tmp, "home"));
  const built = buildSetup(join(tmp, "setup"), { params: TINY_PARAMS, model: "scripted" }, null);
  const config = loadConfig({ path: built.config, env: {}, home: join(tmp, "home") });
  const truths = built.setup.storylines.map((x) => truthOf(built, x.id));
  second = { tmp, home: join(tmp, "home"), dir: built.dir, config, truths };
  const tasks = synth(["tasks", "--config", built.config]);
  expect(tasks).toMatchObject({ code: 0 });
  const seeded = synth(["seed-tasks", "--config", built.config]);
  expect(seeded).toMatchObject({ code: 0 });

  const TYPE = "suspicious-signin";
  const index = readIndex(config).cases;
  const ofType = truths.filter((t) => t.task.case_type === TYPE).map((t) => t.storyline);
  const want = index.filter((c) => c.made_by === "seed-tasks" && ofType.includes(c.storyline)).map((c) => c.case).sort();
  expect(want.length).toBe(ofType.length);

  const wb = Workbench.open(config.data_dir, { store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store, onError: () => {} });
  const composed = compose(config, wb);
  const deps = { ...composed.deps };
  const stall: StageRunner = async () => ({ kind: "stalled", reason: "this test runs Select only" });
  const host = hostsFor(wb, deps, () => {}, { propose: stall });
  try {
    const me: Actor = { kind: "human", id: config.user };
    const s = wb.createCase(
      { title: `Improve investigation for ${TYPE}`, asked: `Which change to loop investigation makes ${TYPE} cases more correct?`, why: "a synthetic improve run", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN" },
      me, { loop: "improve", type: TYPE, improve: { target: "investigation", case_type: TYPE, tasks: ofType.length, candidates: 1 } },
    );
    const e = host.engine(s.id);
    e.start(me);
    await e.advance();
    expect(s.state.run.pause_reason ?? "").toContain("Select only");
    const picked = s.entries().filter((x): x is Extract<Entry, { type: "improve.task" }> => x.type === "improve.task").map((x) => x.payload.case).sort();
    expect(picked).toEqual(want);
    // nothing the improve case holds, entry or blob, before any Judge has run, holds a truth's summary or a claim
    expect(s.entries().filter((x) => x.type === "judge.scored")).toEqual([]);
    const secrets = secretsOf(truths);
    for (const x of s.entries()) {
      const texts = [JSON.stringify(x.payload), ...[...blobsOf(x.payload)].map((b) => textOf(s, b))];
      for (const t of secrets) expect({ seq: x.seq, holds: texts.some((y) => y.includes(t)) }).toEqual({ seq: x.seq, holds: false });
    }
    expect(s.state.skipped).toEqual([]);
  } finally {
    host.close();
    composed.close();
    wb.close();
  }
}, 600_000);

/** Every path under a folder, files and folders. */
function tree(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    out.push(p);
    if (statSync(p).isDirectory()) out.push(...tree(p));
  }
  return out;
}

test("the setup's folders are its own: the data folder, the root and the lake are inside <dir>, and nothing outside <dir> was written by any command of this file", () => {
  // a HOME made for the test stays empty but for what cleanEnv puts there
  for (const [dir, config] of [[run.dir, run.config], [second!.dir, second!.config]] as const) {
    const inside = (p: string): boolean => { const r = relative(dir, p); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };
    expect(inside(config.data_dir)).toBe(true);
    for (const r of config.roots) expect(inside(r.path)).toBe(true);
    for (const p of [config.cases.store, config.loops.store, config.loops.imports, config.memory.store, config.memory.files]) expect(inside(p)).toBe(true);
    for (const src of ["signins", "reputation", "assets"]) {
      const m = run.deps.registry.source(src)!;
      expect(inside(resolve(dir, "root", "sources", m.location))).toBe(true);
    }
    expect(existsSync(join(dir, "lake.sqlite"))).toBe(true);
    // beside the setup, only the test's home, and in it nothing
    const parent = dirname(dir);
    expect(readdirSync(parent).sort()).toEqual(["home", "setup"]);
    // the one thing there may be is bun's own cache, which the runtime keeps under the HOME cleanEnv gives a spawned command
    const home = join(parent, "home");
    expect(tree(home).filter((p) => p !== join(home, ".bun") && !p.startsWith(`${join(home, ".bun")}/`))).toEqual([]);
  }
});

test("the connector opened no network connection: fetch was called zero times in this file", () => {
  expect(fetches).toBe(0);
});
