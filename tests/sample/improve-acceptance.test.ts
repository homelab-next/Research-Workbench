// Slice 14, Task 22: the improve loop end to end on the sample, through the server, on the scripted model. Three device-check cases are run and
// published by the person, who sets a known answer on each; an improve case for device-check with 3 tasks and 3 candidates runs to its adopt
// gate; the person accepts K1. The known answers each hold a canary, and their claims are worded unlike any scripted finding, so a test can see
// that nothing before the Judge was shown one. The answers are the person's: they are here, never in the sample.
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { sha256Hex } from "../../src/core/hash";
import { Ledger } from "../../src/core/ledger";
import type { CaseSession } from "../../src/core/session";
import { fold, initialImprove } from "../../src/core/state";
import type { Actor, Entry, ExpectedFinding } from "../../src/core/types";
import { verifyCase, verifyProbes, verifyScores } from "../../src/core/verify";
import type { NewCase } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import { stagedFolder } from "../../src/pipeline/improve/workbench-host";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

const K1_SENTENCE = "For an address that is not in the asset list, plan the lookup in the WiFi log in place of the lease records: a device that took no lease is named by the connection message it sent when it joined.";
const SKILL = join("context", "skills", "find-the-device.md");
const TASKS: { address: string; text: string; findings: ExpectedFinding[] }[] = [
  {
    address: "192.0.2.14",
    text: "canary-acc-7f31: the workstation ws-14.example.net holds this address under its lease.",
    findings: [{ claim: "ws-14.example.net was the device holding 192.0.2.14 by lease", likelihood: "very likely", confidence: "moderate" }],
  },
  {
    address: "192.0.2.61",
    text: "canary-acc-a2c9: the workstation ws-17.example.net joined the WiFi at this address without a lease.",
    findings: [{ claim: "ws-17.example.net was the device at 192.0.2.61, as its WiFi connection message shows", likelihood: "very likely", confidence: "moderate" }],
  },
  {
    address: "192.0.2.62",
    text: "canary-acc-5d04: the printer pr-2.example.net joined the WiFi at this address without a lease.",
    findings: [{ claim: "pr-2.example.net was the device at 192.0.2.62, as its WiFi connection message shows", likelihood: "very likely", confidence: "moderate" }],
  },
];
/** What no request, tool result or blob before the Judge may hold: each canary, each answer's text and each claim (lower-cased). */
const SECRETS_OF_THE_JUDGE = TASKS.flatMap((t) => [t.text.slice(0, "canary-acc-0000".length), t.text, ...t.findings.map((f) => f.claim)]).map((x) => x.toLowerCase());
const PERSON: Actor = { kind: "human", id: "analyst" };
const IMPROVE_TYPES = ["answer.known", "answer.withdrawn", "improve.requested", "improve.selected", "improve.task", "improve.candidate", "probe.started", "probe.finished", "compose.chosen", "judge.scored", "probe.child"];
const SUMMARY = [{ candidate: "base", score: 333, drafted: 3, tasks: 3 }, { candidate: "K1", score: 1000, drafted: 3, tasks: 3 }, { candidate: "K2", score: 333, drafted: 3, tasks: 3 }];

const caseOf = (address: string): Partial<NewCase> & { loop: string } => ({
  loop: "device-check", title: `Device at ${address}`, asked: `Which device held ${address}?`, why: "sample",
  starting: [{ type: "address", value: address }], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN",
});

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string): string => { const d = mkdtempSync(join(tmpdir(), `improve-acc-${name}-`)); dirs.push(d); return d; };

/** A server over a copy of the sample whose data folder (and staging folder) is `data`, outside the server's own folder, so a second server finds it. */
async function servedOn(data: string, errors: unknown[]): Promise<Served> {
  const improve = { ...loadConfig({ env: {}, home: data, repoRoot: data }).improve, staged: join(data, "staged") };
  return served({ config: { data_dir: data, improve }, onError: (e) => { errors.push(e); } });
}

/** Every file under a folder, relative path to its hash. */
function filesOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, join(rel, n));
      else out[join(rel, n)] = sha256Hex(readFileSync(p));
    }
  };
  walk(dir, "");
  return out;
}

/** Every blob a payload names, at any depth. */
function blobsIn(x: unknown): string[] {
  if (Array.isArray(x)) return x.flatMap(blobsIn);
  if (x === null || typeof x !== "object") return [];
  const o = x as Record<string, unknown>;
  const own = typeof o.blob === "string" && /^[0-9a-f]{64}$/.test(o.blob) ? [o.blob] : [];
  return [...own, ...Object.values(o).flatMap(blobsIn)];
}
const textOf = (session: CaseSession, blob: string): string => new TextDecoder().decode(session.blobs.get(blob)).toLowerCase();
const heldSecrets = (text: string): string[] => SECRETS_OF_THE_JUDGE.filter((x) => text.includes(x));

/** Runs and publishes the three task cases, as the person, and sets the known answer on each product. Their ids. */
async function publishTasks(s: Served): Promise<string[]> {
  const ids: string[] = [];
  for (const t of TASKS) {
    const id = await s.newCase(caseOf(t.address));
    await s.toPlanGate(id);
    expect((await s.command(id, "accept_plan")).status).toBe(200);
    await s.app.hub.idle();
    expect([t.address, s.app.hub.read(id).state.run.waiting]).toEqual([t.address, "publish"]);
    expect((await s.command(id, "approve")).status).toBe(200);
    await s.app.hub.idle();
    expect(s.app.hub.read(id).state.published).toHaveLength(1);
    const set = await s.command(id, "set_known_answer", { product: 1, text: t.text, findings: t.findings, marking: "TLP:GREEN" });
    expect([t.address, set.status]).toEqual([t.address, 200]);
    ids.push(id);
  }
  return ids;
}

/** Makes the improve case for device-check, 3 tasks, 3 candidates. Its id. */
async function newImprove(s: Served): Promise<string> {
  const res = await s.post("/api/improve", { loop: "device-check", case_type: "device-check", tasks: 3, candidates: 3, marking: "TLP:GREEN" });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

const ofType = (entries: readonly Entry[], type: string): Entry[] => entries.filter((e) => e.type === type);
const payloadOf = <T>(e: Entry): T => e.payload as unknown as T;

interface TheRun {
  s: Served; errors: unknown[]; tasks: string[]; improve: string; children: string[]; casesDir: string;
  /** Taken before the improve case was made, and again at the adopt gate. */
  before: { root: Record<string, string>; content: Record<string, string>; chain: Entry[] };
  atGate: { root: Record<string, string>; content: Record<string, string>; chain: Entry[]; entries: Entry[]; staged: boolean; candidateHashes: string[]; atHash: string[] };
}
let theRunMade: Promise<TheRun> | undefined;
/** The one improve run the tests read, made once, up to its adopt gate. */
const theRun = (): Promise<TheRun> => (theRunMade ??= (async () => {
  const errors: unknown[] = [];
  const s = await served({ onError: (e) => { errors.push(e); } });
  closers.push(() => s.close());
  expect(s.problems).toEqual([]);
  const root = s.config.roots[0]!.path;
  const content = join(s.config.data_dir, "blobs");
  const tasks = await publishTasks(s);
  const before = { root: filesOf(root), content: filesOf(content), chain: s.wb.chain.read() };
  const improve = await newImprove(s);
  expect((await s.command(improve, "start_run")).status).toBe(200);
  await s.app.hub.idle();
  const session = s.app.hub.read(improve);
  const st = session.state;
  const children = st.improve.probe_order.map((p) => st.improve.probes[p]!.child);
  const candidateHashes = st.improve.candidate_order.map((k) => st.improve.candidates[k]!.loop_hash).filter((h): h is string => h !== null);
  const loops = s.app.hub.deps.loops!;
  const atGate = {
    root: filesOf(root), content: filesOf(content), chain: s.wb.chain.read(), entries: [...session.entries()],
    staged: existsSync(join(s.config.improve.staged, stagedFolder({ case: improve, origin: session.entries(0, 1)[0]!.hash }))),
    candidateHashes, atHash: candidateHashes.map((h) => { const r = loops.atHash("device-check", h); return typeof r === "string" ? r : `bound ${r.pipeline.hash}`; }),
  };
  return { s, errors, tasks, improve, children, casesDir: join(s.config.data_dir, "cases"), before, atGate };
})());

let acceptedMade: Promise<TheRun> | undefined;
/** The run after the person accepted K1 at Adopt. */
const theAccept = (): Promise<TheRun> => (acceptedMade ??= (async () => {
  const t = await theRun();
  const change = t.s.app.hub.read(t.improve).state.improve.candidates.K1!.change;
  const r = await t.s.command(t.improve, "adopt_decide", { change, accept: true });
  expect([r.status, JSON.stringify(r.body)]).toEqual([200, expect.any(String)]);
  await t.s.app.hub.idle();
  return t;
})());

test("the improve run reaches its adopt gate with K1 chosen, K2 staged and the third change refused; nine probes (base, K1 and K2 for three tasks), each with its own child", async () => {
  const t = await theRun();
  const st = t.s.app.hub.read(t.improve).state;
  expect(st.skipped).toEqual([]);
  expect(st.run).toMatchObject({ status: "waiting", waiting: "adopt" });
  expect(st.improve.request).toMatchObject({ target: "device-check", case_type: "device-check", tasks: 3, candidates: 3, by: "analyst" });
  expect(st.improve.task_order).toEqual(["T1", "T2", "T3"]);
  expect(st.improve.task_order.map((k) => st.improve.tasks[k]!.case).sort()).toEqual([...t.tasks].sort());
  expect(st.improve.candidate_order).toEqual(["K1", "K2"]);
  expect(st.improve.candidate_order.map((k) => st.improve.candidates[k]!.status)).toEqual(["staged", "staged"]);
  // the third change was refused by the save's own check, so it was never a candidate
  const refused = ofType(t.atGate.entries, "tool.returned").filter((e) => payloadOf<{ ok: boolean }>(e).ok === false);
  expect(refused.map((e) => payloadOf<{ summary: string }>(e).summary)).toEqual(["checks/07-alternatives.yaml: a save may not write a check"]);
  expect(ofType(t.atGate.entries, "builder.proposed")).toHaveLength(2);
  expect(st.improve.chosen).toMatchObject({ candidate: "K1" });
  expect(st.improve.chosen!.why).toMatch(/T2 and T3/);
  expect(st.improve.probe_order).toEqual(["base", "K1", "K2"].flatMap((k) => ["T1", "T2", "T3"].map((task) => `${k}/${task}`)));
  expect(new Set(t.children).size).toBe(9);
  for (const p of st.improve.probe_order) {
    const probe = st.improve.probes[p]!;
    expect([p, probe.finished?.outcome]).toEqual([p, "drafted"]);
    const child = t.s.app.hub.read(probe.child).state;
    expect(child.skipped).toEqual([]);
    expect(child.improve.probe_of).toMatchObject({ improve: t.improve, probe: p, candidate: probe.candidate, task: probe.task, plan_gate: "accept" });
    expect(child.memory.type).toBe("device-check");
    // each child is marked as the improve case is, which is at least as strict as each task
    expect(child.meta!.marking).toBe("TLP:GREEN");
  }
  // the proposer's pack: nothing fixed was left out, and the target loop's outline and the skill K1 changes were given
  const proposer = ofType(t.atGate.entries, "model.request").filter((e) => e.stage === "propose");
  expect(proposer.length).toBeGreaterThan(0);
  for (const r of proposer) {
    const p = payloadOf<{ pack: { kind: string; id: string; fixed: boolean }[]; left_out: { kind: string; id: string; fixed: boolean }[] }>(r);
    expect(p.left_out.filter((x) => x.fixed)).toEqual([]);
    expect(p.pack.some((x) => x.kind === "loop" && x.id === "device-check")).toBe(true);
    expect(p.pack.some((x) => x.kind === "manifest" && x.id === "context/skills/find-the-device.md")).toBe(true);
  }
  for (const stage of ["compose", "reflect"]) {
    for (const r of ofType(t.atGate.entries, "model.request").filter((e) => e.stage === stage)) expect(payloadOf<{ left_out: unknown[] }>(r).left_out).toEqual([]);
  }
  expect(t.errors).toEqual([]);
}, 300_000);

test("the scores are base 333, K1 1000, K2 333, and verifyScores recomputes them from the improve case alone", async () => {
  const t = await theRun();
  const st = t.s.app.hub.read(t.improve).state;
  expect(st.improve.scored!.summary).toEqual(SUMMARY);
  expect(st.improve.scored!.matcher).toBe("code");
  const alone = tmp("scores");
  cpSync(join(t.casesDir, t.improve), join(alone, t.improve), { recursive: true });
  expect(verifyScores(join(alone, t.improve))).toEqual({ ok: true, scored: true, problem: null });
}, 300_000);

test("blind: no model request and no tool result of any stage but the Judge, in the improve case or in any probe child, holds a canary, an answer's text or a claim", async () => {
  // read the messages blob of every model.request and the blob of every tool.returned of the improve case and of all nine children
  const t = await theRun();
  let requests = 0;
  for (const id of [t.improve, ...t.children]) {
    const session = t.s.app.hub.read(id);
    for (const e of session.entries()) {
      if (e.stage === "judge") continue;
      const blob = e.type === "model.request" ? payloadOf<{ messages: { blob: string } }>(e).messages.blob
        : e.type === "tool.returned" ? payloadOf<{ result: { blob: string } | null }>(e).result?.blob ?? null : null;
      if (blob === null) continue;
      if (e.type === "model.request") requests++;
      expect(`${id} ${e.seq} ${e.type}: ${heldSecrets(textOf(session, blob)).join(", ")}`).toBe(`${id} ${e.seq} ${e.type}: `);
    }
  }
  // the improve case's agents and every child's were asked
  expect(requests).toBeGreaterThan(9);
}, 300_000);

test("blind: no blob named by an entry of the improve case before judge.scored holds a canary, an answer's text or a claim", async () => {
  const t = await theRun();
  const session = t.s.app.hub.read(t.improve);
  const entries = session.entries();
  const judged = ofType(entries, "judge.scored")[0]!.seq;
  let read = 0;
  for (const e of entries.filter((x) => x.seq < judged)) {
    expect(`${e.seq} ${e.type}: ${heldSecrets(JSON.stringify(e.payload).toLowerCase()).join(", ")}`).toBe(`${e.seq} ${e.type}: `);
    for (const b of blobsIn(e.payload)) {
      read++;
      expect(`${e.seq} ${e.type} ${b}: ${heldSecrets(textOf(session, b)).join(", ")}`).toBe(`${e.seq} ${e.type} ${b}: `);
    }
  }
  expect(read).toBeGreaterThan(20);
  // and the Judge's copy of the answers, after it, holds them: the check sees what it looks for
  const answers = payloadOf<{ answers: { blob: string } }>(ofType(entries, "judge.scored")[0]!).answers.blob;
  expect(heldSecrets(textOf(session, answers)).length).toBe(SECRETS_OF_THE_JUDGE.length);
}, 300_000);

test("blind: compose.chosen is before judge.scored in the ledger, and the Judge's stage started after Compose's finished", async () => {
  const t = await theRun();
  const entries = t.atGate.entries;
  const chosen = ofType(entries, "compose.chosen");
  const scored = ofType(entries, "judge.scored");
  expect([chosen.length, scored.length]).toEqual([1, 1]);
  expect(chosen[0]!.seq).toBeLessThan(scored[0]!.seq);
  const composeFinished = ofType(entries, "stage.finished").find((e) => payloadOf<{ stage: string }>(e).stage === "compose")!;
  const judgeStarted = ofType(entries, "stage.started").find((e) => payloadOf<{ stage: string }>(e).stage === "judge")!;
  expect(composeFinished.seq).toBeLessThan(judgeStarted.seq);
  expect(judgeStarted.seq).toBeLessThan(scored[0]!.seq);
}, 300_000);

test("staged, not live: before the accept, the chain holds no loop.recorded of a candidate's hash, the root's files are what they were, and loops.atHash of each candidate hash is the not-in-this-workbench sentence", async () => {
  const t = await theRun();
  expect(t.atGate.candidateHashes).toHaveLength(2);
  const recorded = ofType(t.atGate.chain, "loop.recorded").map((e) => payloadOf<{ hash: string }>(e).hash);
  for (const h of t.atGate.candidateHashes) expect(recorded).not.toContain(h);
  const registryEntries = (chain: Entry[]): Entry[] => chain.filter((e) => ["loop.recorded", "module.loaded", "manifest.written"].includes(e.type));
  expect(registryEntries(t.atGate.chain)).toEqual(registryEntries(t.before.chain));
  expect(t.atGate.root).toEqual(t.before.root);
  expect(t.atGate.content).toEqual(t.before.content);
  expect(t.atGate.atHash).toEqual(t.atGate.candidateHashes.map((h) => `version ${h.slice(0, 12)} of loop "device-check" is not in this workbench; import its loop file`));
  // the staging folder held the candidates while the run waited
  expect(t.atGate.staged).toBe(true);
}, 300_000);

test("custody: every query of every probe child was issued through runQuery in that child's ledger; every child verifies; no child published", async () => {
  const t = await theRun();
  const improveEntries = t.s.app.hub.read(t.improve).entries();
  expect(ofType(improveEntries, "query.issued")).toEqual([]);
  const st = t.s.app.hub.read(t.improve).state;
  for (const p of st.improve.probe_order) {
    const probe = st.improve.probes[p]!;
    const child = t.s.app.hub.read(probe.child);
    const entries = child.entries();
    const issued = ofType(entries, "query.issued");
    expect([p, issued.length]).toEqual([p, probe.finished!.lookups]);
    expect(issued.length).toBeGreaterThan(0);
    // each query has its result in the same ledger, and each card that came from a query names one of them
    const ids = new Set(issued.map((e) => payloadOf<{ query: string }>(e).query));
    for (const q of ids) expect([p, q, child.state.queries[q]?.status]).toEqual([p, q, "done"]);
    const fromQueries = Object.values(child.state.cards).filter((c) => c.query !== null && c.query !== undefined);
    expect(fromQueries.length).toBeGreaterThan(0);
    for (const c of fromQueries) expect([p, c.id, ids.has(c.query!)]).toEqual([p, c.id, true]);
    expect(entries.some((e) => e.type === "product.published" || (e.type === "gate.passed" && payloadOf<{ gate: string }>(e).gate === "publish"))).toBe(false);
    expect(child.state.published).toEqual([]);
    const report = verifyCase(join(t.casesDir, probe.child));
    expect([p, report.ok]).toEqual([p, true]);
  }
}, 300_000);

test("the only gate passed by code is each child's plan gate, by improve-probe; every other gate.passed of every ledger is a person's", async () => {
  const t = await theRun();
  let byCode = 0;
  let byPerson = 0;
  for (const c of t.s.wb.listCases()) {
    const session = t.s.app.hub.read(c.id);
    for (const e of ofType(session.entries(), "gate.passed")) {
      if (e.actor.kind === "human") {
        expect(e.actor).toEqual(PERSON);
        byPerson++;
        continue;
      }
      expect([c.id, e.actor, payloadOf<{ gate: string }>(e).gate]).toEqual([c.id, { kind: "system", id: "improve-probe" }, "plan"]);
      expect(t.children).toContain(c.id);
      byCode++;
    }
  }
  expect(byCode).toBe(9);
  // each task's plan and publish gates
  expect(byPerson).toBe(6);
}, 300_000);

test("budgets: each child's lookups and tokens are within its share, and the shares add up to no more than the configuration's", async () => {
  const t = await theRun();
  const cfg = t.s.config.improve;
  const entries = t.s.app.hub.read(t.improve).entries();
  const started = ofType(entries, "probe.started").map((e) => payloadOf<{ probe: string; child: string; budgets: { lookups: number; tokens: number } }>(e));
  const finished = new Map(ofType(entries, "probe.finished").map((e) => { const p = payloadOf<{ probe: string; lookups: number; tokens: number }>(e); return [p.probe, p]; }));
  expect(started).toHaveLength(9);
  let lookups = 0;
  let tokens = 0;
  for (const p of started) {
    expect(p.budgets).toEqual({ lookups: Math.floor(cfg.probe_lookups / 9), tokens: Math.floor(cfg.probe_tokens / 9) });
    lookups += p.budgets.lookups;
    tokens += p.budgets.tokens;
    const f = finished.get(p.probe)!;
    expect(f.lookups).toBeLessThanOrEqual(p.budgets.lookups);
    expect(f.tokens).toBeLessThanOrEqual(p.budgets.tokens);
    expect(f.tokens).toBeGreaterThan(0);
    const child = t.s.app.hub.read(p.child);
    expect(child.state.improve.probe_of!.max_lookups).toBe(p.budgets.lookups);
    expect(ofType(child.entries(), "query.issued").length).toBeLessThanOrEqual(p.budgets.lookups);
    // the child's token budget is a budget.set of its first commit
    const mark = ofType(child.entries(), "probe.child")[0]!;
    const budgets = ofType(child.entries(), "budget.set");
    expect(budgets.map((e) => [e.seq, payloadOf<{ tokens: number | null }>(e).tokens])).toEqual([[mark.seq + 1, p.budgets.tokens]]);
  }
  expect(lookups).toBeLessThanOrEqual(cfg.probe_lookups);
  expect(tokens).toBeLessThanOrEqual(cfg.probe_tokens);
}, 300_000);

test("replay: the improve case folded at every seq equals the live state at that seq, with every child and every task case removed from the folder", async () => {
  const t = await theRun();
  const live = t.s.app.hub.read(t.improve);
  const liveEntries = [...live.entries()];
  const alone = tmp("replay");
  cpSync(join(t.casesDir, t.improve), join(alone, t.improve), { recursive: true });
  expect(readdirSync(alone)).toEqual([t.improve]);
  const ledger = Ledger.open(join(alone, t.improve, "ledger.sqlite"), t.improve);
  const copied = ledger.read();
  ledger.close();
  expect(copied).toEqual(liveEntries);
  for (let n = 1; n <= copied.length; n++) {
    const at = fold(copied, n);
    expect(at).toEqual(fold(liveEntries, n));
    expect(at.skipped).toEqual([]);
    // scores only from judge.scored on
    expect([n, at.improve.scored !== null]).toEqual([n, n >= ofType(copied, "judge.scored")[0]!.seq]);
  }
  expect(fold(copied, copied.length)).toEqual(live.state);
  expect(verifyCase(join(alone, t.improve)).ok).toBe(true);
  // replaying the improve case asks no child: each probe is its recorded head and the output blob of the improve case
  for (const e of ofType(copied, "probe.finished")) {
    const p = payloadOf<{ output: { blob: string }; output_hash: string }>(e);
    expect(existsSync(join(alone, t.improve, "blobs"))).toBe(true);
    expect(p.output.blob).toMatch(/^[0-9a-f]{64}$/);
  }
}, 300_000);

test("verifyProbes matches all nine probes against their children at the recorded heads", async () => {
  const t = await theRun();
  const r = verifyProbes(join(t.casesDir, t.improve), t.casesDir);
  expect(r.ok).toBe(true);
  expect(r.probes.map((p) => p.status)).toEqual(Array(9).fill("matches"));
  expect(r.probes.map((p) => p.child)).toEqual(t.children);
  // with the children elsewhere, each is not loaded and nothing fails
  const alone = tmp("probes");
  cpSync(join(t.casesDir, t.improve), join(alone, t.improve), { recursive: true });
  const away = verifyProbes(join(alone, t.improve), alone);
  expect([away.ok, away.probes.map((p) => p.status)]).toEqual([true, Array(9).fill("not_loaded")]);
}, 300_000);

test("Reflect filed one proposal for device-check from this case; it is not accepted, and no later case is given it", async () => {
  const t = await theAccept();
  const filed = Object.values(t.s.wb.memory.state.lessons).filter((l) => l.from.kind === "case" && (l.from as { case: string }).case === t.improve);
  expect(filed).toHaveLength(1);
  const lesson = filed[0]!;
  expect([lesson.status, lesson.case_type, lesson.decided]).toEqual(["proposed", "device-check", null]);
  expect((lesson.from as { stage: string }).stage).toBe("reflect");
  expect(t.s.wb.memory.entries().filter((e) => e.type === "lesson.accepted" && payloadOf<{ lesson: string }>(e).lesson === lesson.id)).toEqual([]);
  // a later device-check case is given no lesson: no memory bound, and no request holds its title
  const later = await laterCase();
  const session = t.s.app.hub.read(later);
  expect(ofType(session.entries(), "memory.bound").flatMap((e) => payloadOf<{ lessons: unknown[] }>(e).lessons)).toEqual([]);
  for (const e of ofType(session.entries(), "model.request")) {
    expect(textOf(session, payloadOf<{ messages: { blob: string } }>(e).messages.blob)).not.toContain(lesson.title.toLowerCase());
  }
}, 300_000);

test("accepting K1's file writes the skill into the root as the person; the run finishes completed; device-check's current version has K1's hash", async () => {
  const t = await theAccept();
  const st = t.s.app.hub.read(t.improve).state;
  expect(st.skipped).toEqual([]);
  expect(st.run).toMatchObject({ status: "finished", outcome: "completed" });
  const root = t.s.config.roots[0]!.path;
  const skill = readFileSync(join(root, SKILL), "utf8");
  expect(skill).toContain(K1_SENTENCE);
  // the only file of the root that changed is the skill
  const now = filesOf(root);
  expect(Object.keys(now).filter((f) => now[f] !== t.before.root[f])).toEqual([SKILL]);
  const written = ofType(t.s.wb.chain.read(), "manifest.written");
  const last = written.at(-1)!;
  expect(last.actor).toEqual(PERSON);
  expect(payloadOf<{ why: string }>(last).why).toBe("builder");
  const decided = ofType(t.s.app.hub.read(t.improve).entries(), "builder.decided");
  expect(decided.map((e) => e.actor)).toEqual([PERSON]);
  const adopt = ofType(t.s.app.hub.read(t.improve).entries(), "gate.passed");
  expect(adopt.map((e) => [e.actor, payloadOf<{ gate: string }>(e).gate])).toEqual([[PERSON, "adopt"]]);
  const k1 = st.improve.candidates.K1!.loop_hash!;
  expect(t.s.app.hub.deps.loops!.current("device-check")!.pipeline.hash).toBe(k1);
  // the adopted version is a normal recorded version now
  expect(ofType(t.s.wb.chain.read(), "loop.recorded").map((e) => payloadOf<{ hash: string }>(e).hash)).toContain(k1);
  expect(t.errors).toEqual([]);
}, 300_000);

test("after the run the staging folder is gone, and each probe child still replays and verifies", async () => {
  const t = await theAccept();
  const session = t.s.app.hub.read(t.improve);
  expect(existsSync(join(t.s.config.improve.staged, stagedFolder({ case: t.improve, origin: session.entries(0, 1)[0]!.hash })))).toBe(false);
  for (const id of t.children) {
    const child = t.s.app.hub.read(id);
    const entries = [...child.entries()];
    for (let n = 1; n <= entries.length; n++) expect(fold(entries, n).skipped).toEqual([]);
    expect(fold(entries)).toEqual(child.state);
    expect([id, verifyCase(join(t.casesDir, id)).ok]).toEqual([id, true]);
  }
  expect(verifyProbes(join(t.casesDir, t.improve), t.casesDir).ok).toBe(true);
}, 300_000);

let laterMade: Promise<string> | undefined;
/** A device-check case made after the accept, run to its plan gate. */
const laterCase = (): Promise<string> => (laterMade ??= (async () => {
  const t = await theAccept();
  const id = await t.s.newCase(caseOf("192.0.2.61"));
  await t.s.toPlanGate(id);
  return id;
})());

test("a new device-check case after the accept binds the adopted version", async () => {
  const t = await theAccept();
  const id = await laterCase();
  const k1 = t.s.app.hub.read(t.improve).state.improve.candidates.K1!.loop_hash!;
  const bound = ofType(t.s.app.hub.read(id).entries(), "loop.bound");
  expect(bound.map((e) => [payloadOf<{ loop: string }>(e).loop, payloadOf<{ hash: string }>(e).hash])).toEqual([["device-check", k1]]);
  expect(t.s.app.hub.read(id).state.skipped).toEqual([]);
  // the tasks bound the version before
  const base = t.s.app.hub.read(t.improve).state.improve.selected!.loop_hash;
  for (const task of t.tasks) expect(ofType(t.s.app.hub.read(task).entries(), "loop.bound").map((e) => payloadOf<{ hash: string }>(e).hash)).toEqual([base]);
}, 300_000);

/** Makes every commit of the session throw once one would write the `nth` entry of `type`: the process stopped there, and wrote nothing more. */
function dieAt(session: CaseSession, type: string, nth: number): () => boolean {
  const commit = session.commit.bind(session);
  let seen = 0;
  let dead = false;
  session.commit = ((fn: Parameters<CaseSession["commit"]>[0]) => {
    if (dead) throw new Error("the process stopped");
    return commit((state, ids) => {
      const out = fn(state, ids);
      seen += out.filter((x) => x.type === type).length;
      if (seen >= nth) {
        dead = true;
        throw new Error("the process stopped");
      }
      return out;
    });
  }) as CaseSession["commit"];
  return () => dead;
}

test("the same improve run split across a stop of the server in the middle of Probe ends with the same scores and the same choice", async () => {
  const data = join(tmp("split"), "wb");
  const errors: unknown[] = [];
  const first = await servedOn(data, errors);
  let improve: string;
  try {
    await publishTasks(first);
    improve = await newImprove(first);
    const died = dieAt(first.app.hub.read(improve), "probe.finished", 5);
    expect((await first.command(improve, "start_run")).status).toBe(200);
    await first.app.hub.idle();
    expect(died()).toBe(true);
    const st = first.app.hub.read(improve).state;
    // four probes recorded, the fifth child made and driven but not recorded
    expect(Object.values(st.improve.probes).filter((p) => p.finished !== null)).toHaveLength(4);
    expect(st.improve.probe_order).toHaveLength(5);
    expect(st.run.status).toBe("running");
  } finally {
    await first.close();
  }
  const second = await servedOn(data, errors);
  try {
    const before = second.wb.listCases().length;
    const resumed = await second.command(improve, "resume");
    expect([resumed.status, JSON.stringify(resumed.body)]).toEqual([200, expect.any(String)]);
    await second.app.hub.idle();
    const st = second.app.hub.read(improve).state;
    expect(st.skipped).toEqual([]);
    expect(st.run).toMatchObject({ status: "waiting", waiting: "adopt" });
    expect(st.improve.scored!.summary).toEqual(SUMMARY);
    expect(st.improve.chosen!.candidate).toBe("K1");
    const main = (await theRun()).s.app.hub.read((await theRun()).improve).state.improve;
    expect([st.improve.scored!.summary, st.improve.chosen!.why]).toEqual([main.scored!.summary, main.chosen!.why]);
    // no child made twice: the fifth was found by its link
    const children = st.improve.probe_order.map((p) => st.improve.probes[p]!.child);
    expect(new Set(children).size).toBe(9);
    expect(second.wb.listCases().length - before).toBe(4);
    expect(ofType(second.app.hub.read(improve).entries(), "probe.started")).toHaveLength(9);
    expect(ofType(second.app.hub.read(improve).entries(), "probe.finished")).toHaveLength(9);
    expect(verifyProbes(join(data, "cases", improve), join(data, "cases")).ok).toBe(true);
    expect(verifyScores(join(data, "cases", improve)).ok).toBe(true);
  } finally {
    await second.close();
  }
  // the first server's errors are the stop itself
  expect(errors.every((e) => String(e).includes("the process stopped"))).toBe(true);
}, 300_000);

test("a case made before this slice (the sample's whole-run ledger) folds, verifies and resumes as it did", async () => {
  const data = join(tmp("old"), "wb");
  const errors: unknown[] = [];
  const first = await servedOn(data, errors);
  let id: string;
  try {
    // the sample's investigation run, which writes nothing this slice added
    id = await first.newCase();
    await first.toPlanGate(id);
    expect(first.app.hub.read(id).state.run.waiting).toBe("plan");
  } finally {
    await first.close();
  }
  const second = await servedOn(data, errors);
  try {
    const check = (): void => {
      const entries = [...second.app.hub.read(id).entries()];
      expect(entries.filter((e) => IMPROVE_TYPES.includes(e.type))).toEqual([]);
      expect(entries.filter((e) => e.actor.kind === "system" && e.actor.id === "improve-probe")).toEqual([]);
      expect(entries.filter((e) => e.type === "gate.passed" && payloadOf<{ gate: string }>(e).gate === "adopt")).toEqual([]);
      for (let n = 1; n <= entries.length; n++) {
        const at = fold(entries, n);
        expect(at.skipped).toEqual([]);
        expect(at.answers).toEqual({});
        expect(at.improve).toEqual(initialImprove());
      }
      expect(verifyCase(join(data, "cases", id)).ok).toBe(true);
    };
    check();
    // the run waits at its plan gate across the stop; the person accepts it with the costly step's budget, and it goes on to the publish gate
    expect(second.app.hub.read(id).state.run.waiting).toBe("plan");
    expect((await second.command(id, "accept_plan", { budgets: { s3: 1 } })).status).toBe(200);
    await second.app.hub.idle();
    expect(second.app.hub.read(id).state.run).toMatchObject({ status: "waiting", waiting: "publish" });
    check();
  } finally {
    await second.close();
  }
  expect(errors).toEqual([]);
}, 300_000);
