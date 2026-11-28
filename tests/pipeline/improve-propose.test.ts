// Slice 14, Task 10: Propose makes candidates as builder changes and stages each beside the live loop.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import { BlobStore } from "../../src/core/blobs";
import { canonical, parseJson } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import type { CaseSession } from "../../src/core/session";
import type { CaseState, TaskInputs, TaskRecord } from "../../src/core/state";
import type { Actor, Entry, Product } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { Providers } from "../../src/agents/providers";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import type { ScriptTurn } from "../../src/agents/providers/scripted";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { checkCandidate, stageCandidate } from "../../src/modules/loop-stage";
import type { ManifestFile } from "../../src/modules/loop-write";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnv, StageRunner } from "../../src/pipeline/engine";
import type { ImproveHost, TaskView } from "../../src/pipeline/improve/host";
import { improveParts } from "../../src/pipeline/improve/propose";
import { IMPROVE_ROLES, PROPOSE_TOOL_NAMES } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { sampleRoot } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
const ENGINE: Actor = { kind: "system", id: "engine" };
const TARGET = "unknown-device";
const CANARY = "canary-answer-5d1c";
const SECRET = "planted-propose-secret-8Hq3";
const ASK = "context/skills/ask-the-person.md";
const SOP = "context/procedures/research.md";
const WIFI = "sources/wifi.yaml";
const MODEL = "improve-test-model";

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let config: Config;
let wb: Workbench;
let composed: ReturnType<typeof compose>;
let staging: BlobStore;
const sessions: CaseSession[] = [];

const TITLES: Record<string, string> = { select: "Select", propose: "Propose", probe: "Probe", compose: "Compose", judge: "Judge", reflect: "Reflect", adopt: "Adopt" };
function improveLoop(): Record<string, Json> {
  const stages = IMPROVE_ROLES.map((role, i): Record<string, Json> => {
    const agent = role === "propose" || role === "compose" || role === "reflect";
    return {
      id: role, title: TITLES[role]!, order: i + 1, runs: agent ? "agent" : role === "adopt" ? "human" : "script", role, gate: role === "adopt" ? "adopt" : null, reviews: false,
      tools: role === "propose" ? [...PROPOSE_TOOL_NAMES] : [], schema: null, model: agent ? { provider: "scripted", model: MODEL, effort: null } : null,
      on_pass: IMPROVE_ROLES[i + 1] ?? null, on_fail: null, ...(role === "probe" ? { probe: { plan_gate: "accept" } } : {}),
    };
  });
  return { kind: "loop", id: "improve", title: "Improve", version: 1, profile: "improve-test", entry: "select", stages };
}
const IMPROVE_PROFILE = {
  kind: "profile", id: "improve-test", title: "Improve (test)", rules: "base-rules", framework: "intel-cycle", standard: "icd203",
  stages: {
    propose: { agent: "proposer", persona: "analyst", goal: "Propose changes to the target loop." },
    compose: { agent: "composer", persona: "analyst", goal: "Choose." },
    reflect: { agent: "reflector", persona: "analyst", goal: "Reflect." },
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "improve-propose-"));
  sample = sampleRoot(dir);
  writeFileSync(join(sample.root, "loops", "improve.yaml"), JSON.stringify(improveLoop(), null, 2));
  writeFileSync(join(sample.root, "context", "improve-test-profile.yaml"), JSON.stringify(IMPROVE_PROFILE, null, 2));
  const base = loadConfig({ env: {}, home: dir, repoRoot: dir });
  config = {
    ...base, data_dir: join(dir, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 },
    loops: { ...base.loops, store: join(dir, "wb", "loops"), imports: join(dir, "wb", "imported") },
  };
  wb = Workbench.open(config.data_dir, { onError: () => {} });
  composed = compose(config, wb);
  staging = new BlobStore(join(dir, "staged", "blobs"));
  sessions.length = 0;
});
afterEach(() => {
  for (const s of sessions) if (s.open) expect(s.state.skipped).toEqual([]);
  try { composed.close(); } catch { /* closed */ }
  try { wb.close(); } catch { /* closed */ }
  sample.close();
  rmSync(dir, { recursive: true, force: true });
});

const input = { title: "Improve", asked: "Make unknown-device cases more correct", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: null, marking: "TLP:GREEN" as const };
const read = (path: string): string => readFileSync(join(sample.root, ...path.split("/")), "utf8");
const edit = (path: string, from: string, to: string): ManifestFile => {
  const text = read(path);
  if (!text.includes(from)) throw new Error(`${path} does not hold ${from}`);
  return { path, text: text.replace(from, to) };
};
const askEdit = (): ManifestFile => edit(ASK, "Ask one thing at a time, and ask early.", "Ask one thing at a time.");
const sopEdit = (): ManifestFile => edit(SOP, "Say what was not found.", "Say what was not found, and why.");
const wifiEdit = (): ManifestFile => edit(WIFI, "A disconnection message names neither.", "A disconnection message names neither the host nor the access point.");

function improveCase(candidates = 2): CaseSession {
  const s = wb.createCase(input, human, { loop: "improve", type: TARGET, improve: { target: TARGET, case_type: TARGET, tasks: 2, candidates } });
  sessions.push(s);
  return s;
}

const product = (summary: string): Product => ({
  objective: "Find the device", question: "Which device is 198.51.100.77?", marking: "TLP:GREEN", summary, key_findings: [], gaps_and_limits: "none",
  alternatives: "none", assessment: "none", sources: [], assumptions: [], change: "first",
});
const taskInputs = (t: string): TaskInputs => ({ question: `Which device held 198.51.100.7${t.slice(1)}?`, starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: null, marking: "TLP:GREEN", title: `Device ${t}` });
const taskRecord = (t: string): TaskRecord => ({
  product: product(`record-marker-${t}: the device was not seen`), stages: [{ id: "research", title: "Research", status: "passed", attempts: 1, last_reason: null }],
  queries: [{ source: "assets", pivot: null, outcome: "ran", rows: 0 }], questions: 0, sendbacks: 0, usage: { input: 10, output: 5, calls: 1 },
});
const put = (s: CaseSession, x: Json) => s.blobs.put(canonical(x));

/** Select's record, as Task 9 writes it: the target's current version, its lock, and two tasks with their inputs and records. */
function selects(opts: { loop_hash?: string } = {}): StageRunner {
  return async (env: StageEnv) => {
    const live = composed.deps.loops!.current(TARGET)!;
    env.session.commit((st) => [
      {
        type: "improve.selected", actor: ENGINE, run: st.run.id, stage: env.stage.id,
        payload: { target: TARGET, version: live.manifest.version, loop_hash: opts.loop_hash ?? live.pipeline.hash, lock: put(env.session, live.lock as unknown as Json), case_type: TARGET, scale: ["unlikely", "likely"], left_out: [] },
      },
      ...["T1", "T2"].map((task, i) => ({
        type: "improve.task" as const, actor: ENGINE, run: st.run.id, stage: env.stage.id,
        payload: {
          task, case: `CASE-${90 + i}`, origin: "f".repeat(64), head: { seq: 9, hash: "9".repeat(64) }, product: { n: 1, draft_hash: "d".repeat(64) }, answer: { seq: 8, hash: "8".repeat(64) },
          marking: "TLP:GREEN" as const, inputs: put(env.session, taskInputs(task) as unknown as Json), record: put(env.session, taskRecord(task) as unknown as Json),
        },
      })),
    ]);
    return { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
  };
}
const PROBE_STALL = "probe stalled in the test";
const stallProbe: StageRunner = async () => ({ kind: "stalled", reason: PROBE_STALL });

/** A task as the host would give it, whose state holds a known answer with the canary: Propose must never ask for it. */
function canaryTask(): TaskView {
  const state = { answers: { "1": { product: 1, text: `the answer is ${CANARY}`, findings: [{ claim: `claim ${CANARY}`, likelihood: "likely", confidence: "high" }] } } } as unknown as CaseState;
  return { ref: { case: "CASE-90", origin: "f".repeat(64) }, state, head: { seq: 9, hash: "9".repeat(64) }, entries: () => [] };
}
interface Host extends ImproveHost { asked: string[]; staged_problems: string[][] }
/** A host whose check and stage are the real checkCandidate and stageCandidate over the sample's root; `before` runs before each staging. */
/** The root a host call names by its folder's name, as a path. */
const pathOf = (name: string): string => (name === basename(sample.root) ? sample.root : join(dir, "no-such-root", name));
function host(opts: { before?: () => void; stageThrows?: boolean } = {}): Host {
  const asked: string[] = [];
  const staged_problems: string[][] = [];
  const candidateDeps = () => ({ config, chain: wb.chain, content: wb.chainBlobs, secrets: [SECRET], loops: composed.deps.loops!, registry: composed.deps.registry });
  return {
    asked, staged_problems,
    tasks: (type) => { asked.push(`tasks:${type}`); return [canaryTask()]; },
    task: (ref) => { asked.push(`task:${ref.case}`); return canaryTask(); },
    staged: () => staging,
    check: (root, files, target) => checkCandidate(candidateDeps(), pathOf(root), files, target),
    stage: (_i, root, files, target) => {
      if (opts.stageThrows === true) throw new Error("the process stopped");
      opts.before?.();
      const r = stageCandidate(candidateDeps(), pathOf(root), files, target, staging);
      if (!r.ok) staged_problems.push(r.problems);
      return r;
    },
    clear: () => {},
    probes: {
      find: () => null, create: () => { throw new Error("no probe here"); }, drive: () => { throw new Error("no probe here"); }, read: () => null, end: () => {},
    },
  };
}
const proposal = (title: string, files: ManifestFile[]): { tool: string; args: Record<string, Json> } => ({ tool: "propose_change", args: { why: `because ${title}`, title, files: files as unknown as Json } });
function providerOf(turns: ScriptTurn["reply"][], context?: number): Providers {
  return new Providers([new ScriptedProvider({ id: "scripted", scripts: [{ id: MODEL, turns: turns.map((reply) => ({ actor: "proposer", reply })), ...(context === undefined ? {} : { context }) }] })]);
}
function depsWith(h: ImproveHost, providers: Providers): EngineDeps {
  return { ...composed.deps, improve: h, providers, runner: { ...composed.deps.runner, secrets: () => [SECRET] } };
}
const runners = (opts: { loop_hash?: string } = {}): Partial<Record<Role, StageRunner>> => ({ select: selects(opts), probe: stallProbe });

async function run(s: CaseSession, h: ImproveHost, turns: ScriptTurn["reply"][], opts: { loop_hash?: string; context?: number } = {}): Promise<Engine> {
  const engine = Engine.open(s, depsWith(h, providerOf(turns, opts.context)), { runners: runners(opts) });
  expect(engine.unusable).toBeNull();
  engine.start(human);
  await engine.advance();
  return engine;
}
const ofType = <T extends Entry["type"]>(s: CaseSession, t: T): Extract<Entry, { type: T }>[] => s.entries().filter((e): e is Extract<Entry, { type: T }> => e.type === t);
/** Everything the proposer was sent: each request's messages and each tool result the stage's agent was given. */
function sent(s: CaseSession): string[] {
  const out: string[] = [];
  for (const e of s.entries()) {
    if (e.type === "model.request" && e.stage === "propose") out.push(s.blobs.text(e.payload.messages.blob));
    if (e.type === "tool.returned" && e.stage === "propose" && e.payload.result !== null) out.push(s.blobs.text(e.payload.result.blob));
  }
  return out;
}
const proposeOutput = (s: CaseSession): Json => {
  const done = ofType(s, "stage.finished").filter((e) => e.payload.stage === "propose" && e.payload.outcome === "pass");
  expect(done.length).toBe(1);
  return parseJson(s.blobs.text(done[0]!.payload.output!.blob))!.value;
};
const FINAL = { content: "Proposed what is above." };

// ---- the pack

test("the proposer's pack holds each task's question and record, the target's outline and each changeable file under its path", async () => {
  const s = improveCase();
  await run(s, host(), [FINAL]);
  expect(s.state.run.pause_reason).toContain(PROBE_STALL);
  const parts = improveParts(s, depsWith(host(), providerOf([])));
  expect(parts.filter((p) => p.kind === "task").map((p) => [p.id, p.marking])).toEqual([["T1", "TLP:GREEN"], ["T2", "TLP:GREEN"]]);
  expect(parts.filter((p) => p.kind === "loop").map((p) => p.id)).toEqual([TARGET]);
  const paths = parts.filter((p) => p.kind === "manifest").map((p) => p.title);
  for (const p of [ASK, SOP, "context/procedures/assemble.md", WIFI, "sources/assets.yaml", "loops/unknown-device.yaml"]) expect(paths).toContain(p);
  // nothing a candidate may not change: no persona, schema, check or profile
  expect(paths.filter((p) => /personas|schemas|checks\/|profile/.test(p))).toEqual([]);
  expect(parts.find((p) => p.title === ASK)!.text).toContain("Ask one thing at a time, and ask early.");
  const outline = parts.find((p) => p.kind === "loop")!.text;
  expect(outline).toContain("- research (Research): role research, runs agent, tools [find_routes, run_step, run_pivot, run_query, list_cards, read_card, ask_person, note_memory], model scripted/sample-device, effort none, max_turns default");
  // and the request the model was sent holds them all
  const requests = sent(s).filter((t) => t.includes("Propose at most"));
  expect(requests.length).toBe(1);
  const text = requests[0]!;
  for (const said of ["Which device held 198.51.100.71?", "Which device held 198.51.100.72?", "record-marker-T1", "record-marker-T2", `The loop ${TARGET}`, `## ${ASK}`, `## ${SOP}`, `## ${WIFI}`]) expect(text).toContain(said);
  expect(text).toContain(`Propose at most 2 changes to loop ${TARGET} that would make ${TARGET} cases more correct. Each is one call of propose_change. Change only what the parts titled by a path hold. Then answer with what you proposed.`);
  // every part was offered: what the model's context could not take is named as left out, never dropped unseen
  const req = ofType(s, "model.request").find((e) => e.stage === "propose")!;
  const offered = [...req.payload.pack, ...req.payload.left_out].map((i) => `${i.kind}:${i.id}`);
  for (const p of parts) expect(offered).toContain(`${p.kind}:${p.id}`);
  expect(req.payload.tools).toEqual([...PROPOSE_TOOL_NAMES]);
});

test("the proposer's pack holds no known answer: the canary is in no model.request of the stage", async () => {
  const s = improveCase();
  const h = host();
  await run(s, h, [{ tool_calls: [proposal("Shorter", [askEdit()]), { tool: "loop_catalogue", args: { why: "see" } }] }, FINAL]);
  expect(ofType(s, "model.request").filter((e) => e.stage === "propose").length).toBe(2);
  for (const t of sent(s)) expect(t).not.toContain(CANARY);
  // Propose asks the host for no task
  expect(h.asked).toEqual([]);
  // nothing the improve case holds names it either
  for (const name of readdirSync(join(s.dir, "blobs"))) expect(readFileSync(join(s.dir, "blobs", name), "latin1")).not.toContain(CANARY);
});

// ---- the candidates

test("two proposed changes become K1 and K2, each staged with its lock and hash", async () => {
  const s = improveCase();
  const base = composed.deps.loops!.current(TARGET)!.pipeline.hash;
  await run(s, host(), [{ tool_calls: [proposal("Shorter ask", [askEdit()]), proposal("Say why", [sopEdit()])] }, FINAL]);
  const cands = ofType(s, "improve.candidate");
  expect(cands.map((e) => [e.payload.candidate, e.payload.change, e.payload.status, e.payload.reason])).toEqual([["K1", "chg-1", "staged", ""], ["K2", "chg-2", "staged", ""]]);
  // one commit per candidate
  expect(new Set(cands.map((e) => e.seq)).size).toBe(2);
  for (const c of cands) {
    expect(c.actor).toEqual(ENGINE);
    expect(c.payload.loop_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.payload.loop_hash).not.toBe(base);
    const lock = composed.deps.loops!.readLock(s.blobs.get(c.payload.lock!.blob))!;
    expect(lock.hash).toBe(c.payload.loop_hash!);
    // the staged version is rebuilt from its lock over the staging store, and only there
    const again = composed.deps.loops!.fromLock(lock, staging);
    expect(typeof again === "string" ? again : again.pipeline.hash).toBe(c.payload.loop_hash!);
    expect(typeof composed.deps.loops!.fromLock(lock)).toBe("string");
  }
  expect(cands[0]!.payload.loop_hash).not.toBe(cands[1]!.payload.loop_hash);
  expect(s.state.improve.candidate_order).toEqual(["K1", "K2"]);
  expect(proposeOutput(s)).toEqual({ candidates: [{ candidate: "K1", change: "chg-1", status: "staged" }, { candidate: "K2", change: "chg-2", status: "staged" }] });
  // the root is as it was: nothing was written there
  expect(read(ASK)).toContain("Ask one thing at a time, and ask early.");
  expect(composed.deps.loops!.current(TARGET)!.pipeline.hash).toBe(base);
});

test("a change of a source's field notes alone is staged, not dropped: the version it is probed as covers the source", async () => {
  const s = improveCase();
  await run(s, host(), [{ tool_calls: [proposal("Wifi notes", [wifiEdit()])] }, FINAL]);
  expect(ofType(s, "builder.proposed").length).toBe(1);
  const [k1] = ofType(s, "improve.candidate").map((e) => e.payload);
  expect(k1).toMatchObject({ candidate: "K1", change: "chg-1", status: "staged", reason: "" });
  expect(k1!.loop_hash).not.toBe(s.state.improve.selected!.loop_hash);
  expect(proposeOutput(s)).toEqual({ candidates: [{ candidate: "K1", change: "chg-1", status: "staged" }] });
});

test("a change of a file the proposer was not shown (left out of its pack) is dropped with the reason, and is not staged", async () => {
  const s = improveCase();
  const h = host();
  // a context so small that the changeable files are left out of the proposer's pack
  await run(s, h, [{ tool_calls: [proposal("Shorter", [askEdit()])] }, FINAL], { context: 2048 });
  const requests = ofType(s, "model.request").filter((e) => e.stage === "propose");
  expect(requests.length).toBeGreaterThan(0);
  const path = askEdit().path;
  expect(requests.every((e) => !e.payload.pack.some((i) => i.kind === "manifest" && i.id === path))).toBe(true);
  expect(ofType(s, "builder.proposed").length).toBe(1);
  expect(ofType(s, "improve.candidate").map((e) => e.payload)).toEqual([{ candidate: "K1", change: "chg-1", status: "dropped", loop_hash: null, lock: null, reason: `it changes ${path}, which was not in what the proposer was shown` }]);
  expect(h.staged_problems).toEqual([]);
});

test("a change that no longer resolves when it is staged is dropped with the loop's problem", async () => {
  const s = improveCase();
  const persona = join(sample.root, "context", "personas", "researcher.md");
  const away = join(dir, "researcher.md");
  // the persona the target reads is taken from the root after the proposal was checked, before it is staged
  const h = host({ before: () => renameSync(persona, away) });
  try {
    await run(s, h, [{ tool_calls: [proposal("Shorter", [askEdit()])] }, FINAL]);
  } finally {
    renameSync(away, persona);
  }
  expect(h.staged_problems.length).toBe(1);
  const problem = h.staged_problems[0]![0]!;
  expect(problem.length).toBeGreaterThan(0);
  expect(ofType(s, "improve.candidate").map((e) => e.payload)).toEqual([{ candidate: "K1", change: "chg-1", status: "dropped", loop_hash: null, lock: null, reason: problem }]);
});

test("when the target changed since Select, Propose stalls with the sentence and calls no model", async () => {
  const s = improveCase();
  await run(s, host(), [FINAL], { loop_hash: "e".repeat(64) });
  expect(s.state.run.status).toBe("paused");
  expect(s.state.run.pause_reason).toContain(`loop ${TARGET} changed since the tasks were selected; stop this run and start another`);
  expect(ofType(s, "model.request")).toEqual([]);
  expect(ofType(s, "improve.candidate")).toEqual([]);
});

test("after a stop between the agent's end and the staging, Propose stages what was proposed and calls no model again", async () => {
  const s = improveCase();
  const first = await run(s, host({ stageThrows: true }), [{ tool_calls: [proposal("Shorter", [askEdit()])] }, FINAL]);
  expect(s.state.run.status).toBe("paused");
  expect(s.state.run.pause_reason).toContain("the process stopped");
  expect(ofType(s, "builder.proposed").length).toBe(1);
  expect(ofType(s, "improve.candidate")).toEqual([]);
  first.close();
  const requests = ofType(s, "model.request").length;
  // a new engine (a restart), whose model has nothing to say: it is not asked
  const again = new Engine(s, depsWith(host(), providerOf([])), { runners: runners() });
  await again.resume(human);
  expect(ofType(s, "model.request").length).toBe(requests);
  expect(ofType(s, "improve.candidate").map((e) => [e.payload.candidate, e.payload.change, e.payload.status])).toEqual([["K1", "chg-1", "staged"]]);
  expect(s.state.run.pause_reason).toContain(PROBE_STALL);
  again.close();
});

test("a model that proposes nothing passes with no candidate", async () => {
  const s = improveCase();
  await run(s, host(), [{ content: "Nothing to change." }]);
  expect(ofType(s, "builder.proposed")).toEqual([]);
  expect(ofType(s, "improve.candidate")).toEqual([]);
  expect(proposeOutput(s)).toEqual({ candidates: [] });
  expect(s.state.run.pause_reason).toContain(PROBE_STALL);
});

test("no secret value and no source location is in anything the proposer was sent", async () => {
  // a secret value written into a file a candidate may change: the proposer must never be shown it
  const ask = join(sample.root, ...ASK.split("/"));
  const plain = readFileSync(ask, "utf8");
  writeFileSync(ask, `${plain}\nThe service key is ${SECRET}.\n`);
  const s = improveCase();
  await run(s, host(), [{
    tool_calls: [
      { tool: "adapter_catalogue", args: { why: "see" } }, { tool: "loop_catalogue", args: { why: "see" } },
      { tool: "validate_manifest", args: { why: "check", path: ASK, text: plain } },
    ],
  }, FINAL]);
  const texts = sent(s);
  expect(texts.length).toBeGreaterThan(2);
  // the file that holds it was in the pack, with the value hidden
  expect(texts[0]).toContain("The service key is [hidden].");
  expect(texts.join("\n")).toContain("ask-the-person");
  const url = new URL(sample.fixture.url);
  for (const t of texts) {
    expect(t).not.toContain(SECRET);
    expect(t).not.toContain(sample.root);
    expect(t).not.toContain(url.host);
    expect(t).not.toContain("../data");
  }
});
