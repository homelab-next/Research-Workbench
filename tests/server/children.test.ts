import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import type { TaskInputs } from "../../src/core/state";
import type { Actor, EntryInput } from "../../src/core/types";
import type { Entry } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps, StageEnv, StageRunner } from "../../src/pipeline/engine";
import { stagedFolder } from "../../src/pipeline/improve/workbench-host";
import { IMPROVE_ROLES } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { CaseHub } from "../../src/server/hub";
import type { AgentView, LoopView, ModelView, Preview } from "../../src/core/wire";
import { CASE_TYPES, served } from "../helpers/served";
import type { Served } from "../helpers/served";
import { writeTriage } from "../helpers/loop-files";
import { inputsOf } from "../../src/pipeline/subloop";

let s: Served | undefined;
let errors: unknown[] = [];
afterEach(async () => {
  if (s !== undefined) for (const c of s.wb.listCases()) expect(s.app.hub.read(c.id).state.skipped).toEqual([]);
  await s?.close();
  s = undefined;
  expect(errors).toEqual([]);
  errors = [];
});

const GATES = new Set(["gate.passed", "plan.accepted", "product.published"]);
const open = async (): Promise<Served> => (s = await served({ before: writeTriage, onError: (e) => { errors.push(e); } }));
const ofType = (id: string, type: string): Entry[] => s!.entries(id).filter((e) => e.type === type);
const last = (id: string): Entry => s!.entries(id).at(-1)!;

/** A triage case, started; the server drives it until it waits on its child. Returns the parent's and the child's ids. */
async function startParent(): Promise<{ parent: string; child: string }> {
  const parent = await s!.newCase({ loop: "triage" });
  const r = await s!.command(parent, "start_run");
  if (r.status !== 200) throw new Error(`start_run failed: ${JSON.stringify(r)}`);
  await s!.app.hub.idle();
  const started = ofType(parent, "subloop.started");
  if (started.length !== 1) throw new Error(`the parent started ${started.length} children`);
  return { parent, child: (started[0]!.payload as { child: string }).child };
}
/** The child's gates, passed by the person through the server: the only commands sent after the parent's start_run. */
async function passChildGates(child: string): Promise<void> {
  expect((await s!.command(child, "accept_plan", { budgets: { s3: 1 } })).status).toBe(200);
  await s!.app.hub.idle();
  expect((await s!.command(child, "approve")).status).toBe(200);
  await s!.app.hub.idle();
}

test("starting the parent makes the child, and the parent's stream ends its turn with run.paused: waiting on child CASE-2", async () => {
  s = await open();
  const { parent, child } = await startParent();
  expect(child).toBe("CASE-2");
  const paused = last(parent);
  expect(paused.type).toBe("run.paused");
  expect((paused.payload as { reason: string }).reason).toStartWith("waiting on child CASE-2: ");
  expect(s.app.hub.read(parent).state.run.hold).toEqual({ kind: "child", stage: "investigate", child: "CASE-2" });
  expect(s.app.hub.read(child).state.run.waiting).toBe("plan");
  expect(s.app.hub.read(child).state.loop.parent).toMatchObject({ case: parent, stage: "investigate", attempt: 1 });
  // the stream a screen reads says the same, ending on that pause
  const ac = new AbortController();
  const res = await s.app.handle(new Request(`${s.origin}/api/cases/${parent}/entries?after=0`, { headers: { host: new URL(s.origin).host }, signal: ac.signal }));
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("waiting on child CASE-2")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  ac.abort();
  await reader.cancel().catch(() => undefined);
  const types = [...text.matchAll(/"type":"([a-z_.]+)"/g)].map((m) => m[1]);
  expect(types.at(-1)).toBe("run.paused");
});

test("accept_plan and approve on the child are the only commands sent; after each the parent goes on by itself and finishes once the child has published", async () => {
  s = await open();
  const { parent, child } = await startParent();
  const personBefore = s.entries(parent).filter((e) => e.actor.kind === "human").length;
  expect((await s.command(child, "accept_plan", { budgets: { s3: 1 } })).status).toBe(200);
  await s.app.hub.idle();
  // the child now waits at its publish gate, and the parent says so by itself
  expect(s.app.hub.read(child).state.run.waiting).toBe("publish");
  const pausedNow = s.app.hub.read(parent).state.run;
  expect(pausedNow.status).toBe("paused");
  expect(pausedNow.pause_reason).toStartWith("waiting on child CASE-2: ");
  expect(ofType(parent, "run.paused").length).toBe(2);
  expect((await s.command(child, "approve")).status).toBe(200);
  await s.app.hub.idle();
  expect(s.app.hub.read(child).state.run).toMatchObject({ status: "finished", outcome: "published" });
  expect(s.app.hub.read(parent).state.run).toMatchObject({ status: "finished", outcome: "completed" });
  expect(ofType(parent, "subloop.finished").map((e) => e.payload)).toMatchObject([{ stage: "investigate", attempt: 1, child, outcome: "published" }]);
  const returned = ofType(parent, "card.created").filter((e) => (e.payload as { card: { from?: unknown } }).card.from !== undefined);
  expect(returned.length).toBeGreaterThan(0);
  for (const e of returned) expect((e.payload as { card: { from: { case: string } } }).card.from.case).toBe(child);
  // no command was sent to the parent after start_run: nothing in its ledger since is a person's
  expect(s.entries(parent).filter((e) => e.actor.kind === "human").length).toBe(personBefore);
});

test("the parent's run.resumed entries after a child settled are by the engine, and no gate.passed in either ledger is by anything but the person", async () => {
  s = await open();
  const { parent, child } = await startParent();
  await passChildGates(child);
  const resumed = ofType(parent, "run.resumed");
  expect(resumed.length).toBe(2);
  for (const e of resumed) expect(e.actor).toEqual({ kind: "system", id: "engine" });
  for (const id of [parent, child]) for (const e of s.entries(id).filter((x) => GATES.has(x.type))) expect(e.actor).toEqual({ kind: "human", id: s.config.user });
  expect(s.entries(parent).some((e) => GATES.has(e.type))).toBe(false);
  expect(s.entries(child).filter((e) => e.type === "gate.passed").length).toBe(2);
});

test("a child whose parent was unloaded settles without an error, and loading the parent and resuming it picks the child up", async () => {
  s = await open();
  const { parent, child } = await startParent();
  const unloaded = await s.post(`/api/cases/${parent}/unload`, {});
  expect(unloaded.status).toBe(200);
  const { file } = (await unloaded.json()) as { file: string };
  expect(s.wb.listCases().map((c) => c.id)).toEqual([child]);
  await passChildGates(child);
  expect(s.app.hub.read(child).state.run).toMatchObject({ status: "finished", outcome: "published" });
  const loaded = await s.post("/api/store/load", { file });
  expect(loaded.status).toBe(200);
  expect(((await loaded.json()) as { id: string }).id).toBe(parent);
  expect(s.app.hub.read(parent).state.run.status).toBe("paused");
  expect((await s.command(parent, "resume")).status).toBe(200);
  await s.app.hub.idle();
  expect(s.app.hub.read(parent).state.run).toMatchObject({ status: "finished", outcome: "completed" });
  expect(ofType(parent, "subloop.finished").length).toBe(1);
  expect(ofType(parent, "subloop.started").length).toBe(1);
});

test("loop.output is on the workbench chain once the child published: the product, with its marking and the child's head", async () => {
  s = await open();
  const { child } = await startParent();
  const outputs = () => s!.wb.chain.read().filter((e) => e.type === "loop.output");
  expect((await s.command(child, "accept_plan", { budgets: { s3: 1 } })).status).toBe(200);
  await s.app.hub.idle();
  expect(outputs()).toEqual([]);
  expect((await s.command(child, "approve")).status).toBe(200);
  await s.app.hub.idle();
  const product = outputs().find((e) => (e.payload as { case: string; output: string }).case === child && (e.payload as { output: string }).output === "product")!;
  expect(product).toBeDefined();
  const p = product.payload as { loop: string; outcome: string; marking: string; head: { seq: number; hash: string }; hash: string; value: { blob: string }; run: string };
  expect(p).toMatchObject({ loop: "investigation", outcome: "published" });
  expect(product.actor).toEqual({ kind: "system", id: "engine" });
  const state = s.app.hub.read(child).state;
  const published = state.drafts.find((d) => d.hash === state.published.at(-1)!.draft_hash)!.product;
  expect(JSON.parse(s.wb.chainBlobs.text(p.value.blob))).toEqual(published);
  expect(p.marking).toBe(published.marking);
  const at = s.entries(child).find((e) => e.seq === p.head.seq)!;
  expect(at.hash).toBe(p.head.hash);
  expect(s.entries(child).slice(0, p.head.seq).some((e) => e.type === "run.finished")).toBe(true);
  // the parent's run, which completed, gives the outputs its loop declares too
  expect(outputs().some((e) => (e.payload as { loop: string; outcome: string }).loop === "triage" && (e.payload as { outcome: string }).outcome === "completed")).toBe(true);
});

test("your agent, the preview and the models of a child read the child's own loop version", async () => {
  s = await open();
  const { parent, child } = await startParent();
  const get = async <T>(path: string): Promise<T> => {
    const res = await s!.get(path);
    if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  // the child is of the investigation loop, whose Assemble names the model your agent uses; the parent's triage has no Assemble
  expect((await get<AgentView>(`/api/cases/${child}/agent`)).model).toMatchObject({ provider: "scripted", model: "sample-run" });
  expect((await get<AgentView>(`/api/cases/${parent}/agent`)).model).toBeNull();
  // a new version of investigation, whose Assemble names another model, is saved while the child runs on version 1
  const draft = (await get<LoopView>("/api/loops/investigation")).draft as unknown as { stages: Record<string, unknown>[] };
  draft.stages.find((x) => x.id === "assemble")!.model = { provider: "scripted", model: "not-listed", effort: null };
  const saved = await s.post("/api/loops/investigation/save", { draft, version: 1 });
  expect(saved.status).toBe(200);
  const fresh = await s.newCase();
  expect((await get<AgentView>(`/api/cases/${fresh}/agent`)).model).toBeNull();
  expect((await get<AgentView>(`/api/cases/${child}/agent`)).model).toMatchObject({ provider: "scripted", model: "sample-run" });
  // the child's publish stage and models are its version's
  expect((await s.command(child, "accept_plan", { budgets: { s3: 1 } })).status).toBe(200);
  await s.app.hub.idle();
  const preview = await get<Preview>(`/api/cases/${child}/preview`);
  expect("manifest" in preview).toBe(true);
  const models = await get<ModelView[]>(`/api/cases/${child}/models`);
  expect(models.some((m) => m.provider === "scripted" && m.model === "sample-run")).toBe(true);
  expect(ofType(child, "loop.bound").map((e) => (e.payload as { version: number }).version)).toEqual([1]);
  expect(ofType(child, "run.paused")).toEqual([]);
});

test("a parent loaded without its child, on a workbench whose own case has the child's id, neither drives nor reads that case: it pauses saying the child is not loaded", async () => {
  // workbench A: two cases, then a triage parent CASE-3 whose child is CASE-4, waiting at its plan gate; the parent alone is unloaded
  s = await open();
  await s.newCase();
  await s.newCase();
  const { parent, child } = await startParent();
  expect([parent, child]).toEqual(["CASE-3", "CASE-4"]);
  const started = ofType(parent, "subloop.started")[0]!.payload as { origin?: string };
  expect(started.origin).toBe(s.entries(child)[0]!.hash);
  const unloaded = await s.post(`/api/cases/${parent}/unload`, {});
  expect(unloaded.status).toBe(200);
  const { file } = (await unloaded.json()) as { file: string };
  const bErrors: unknown[] = [];
  const b = await served({ before: writeTriage, onError: (e) => { bErrors.push(e); } });
  try {
    // workbench B: four cases of its own; its CASE-3 is unloaded and deleted, so the id is free; its CASE-4 is no child of anything
    for (let i = 1; i <= 4; i++) await b.newCase({ title: `B's own case ${i}`, marking: "TLP:AMBER" });
    expect((await b.post("/api/cases/CASE-3/unload", {})).status).toBe(200);
    const f3 = readdirSync(b.config.cases.store).find((f) => f.startsWith("CASE-3."))!;
    expect((await b.post("/api/store/delete", { file: f3, id: "CASE-3" })).status).toBe(200);
    copyFileSync(join(s.config.cases.store, file), join(b.config.cases.store, file));
    expect((await b.post("/api/store/load", { file })).status).toBe(200);
    const theirs = b.entries("CASE-4").length;
    expect((await b.command("CASE-3", "resume")).status).toBe(200);
    await b.app.hub.idle();
    // B's own CASE-4 is untouched: no run, no entry
    expect(b.entries("CASE-4").length).toBe(theirs);
    expect(b.app.hub.read("CASE-4").state.run.status).toBe("none");
    const run = b.app.hub.read("CASE-3").state.run;
    expect(run.status).toBe("paused");
    expect(run.pause_reason).toBe("waiting on child CASE-4: child CASE-4 is not loaded; load it from the store");
    expect(b.entries("CASE-3").some((e) => e.type === "subloop.finished")).toBe(false);
    for (const c of b.wb.listCases()) expect(b.app.hub.read(c.id).state.skipped).toEqual([]);
  } finally {
    await b.close();
  }
  expect(bErrors).toEqual([]);
});

test("a card given to a child holds no query of the parent, and verify_card on it in the child is refused: verify it in the parent", async () => {
  s = await open();
  const a = await s.newCase();
  await s.toPublishGate(a);
  let st = s.app.hub.read(a).state;
  const some = Object.values(st.cards).find((c) => c.query !== null)!;
  expect((await s.command(a, "keep", { card: some.id })).status).toBe(200);
  st = s.app.hub.read(a).state;
  const made = inputsOf(st, { loop: "investigation", inputs: { question: "case.question", notes: "cards.kept" }, returns: {} }, { question: { type: "question", required: true }, notes: { type: "cards", required: true } }, "h");
  const child = s.wb.createCase(made.case, { kind: "system", id: "engine" }, { loop: "investigation", link: { parent: a, run: st.run.id!, stage: "x", attempt: 1, loop: "investigation", input_hash: made.input_hash, depth: 1, floor: st.meta!.marking }, cards: made.cards });
  const given = Object.values(child.state.cards)[0]!;
  expect(given).toMatchObject({ kind: "note", made_by: "system", query: null, source: null, step: null, from: { case: a, card: some.id } });
  const before = s.entries(child.id).length;
  const r = await s.command(child.id, "verify_card", { card: given.id });
  await s.app.hub.idle();
  expect(r.status).toBe(409);
  expect(JSON.stringify(r.body)).toContain(`verify it in ${a}`);
  expect(s.entries(child.id).length).toBe(before);
});

test("a child case takes its own loop's case type, else its parent's", async () => {
  const types = (root: string): void => { writeTriage(root); writeFileSync(join(root, "case-types.yaml"), CASE_TYPES); };
  // the child's loop names no case type: the child takes its parent's, by the engine
  s = await served({ before: types, onError: (e) => { errors.push(e); } });
  let parent = await s.newCase({ loop: "triage", type: "phishing" });
  expect((await s.command(parent, "start_run")).status).toBe(200);
  await s.app.hub.idle();
  let child = (ofType(parent, "subloop.started")[0]!.payload as { child: string }).child;
  expect(s.app.hub.read(child).state.memory.type).toBe("phishing");
  expect(ofType(child, "case.type_set").map((e) => [e.payload, e.actor])).toEqual([[{ type: "phishing" }, { kind: "system", id: "parent" }]]);
  await s.close();
  // the child's loop names one: the child takes its loop's
  s = await served({
    before: (root) => {
      types(root);
      const at = join(root, "loops", "investigation.yaml");
      writeFileSync(at, `${readFileSync(at, "utf8").trimEnd()}\ncase_type: unknown-device\n`);
    },
    onError: (e) => { errors.push(e); },
  });
  parent = await s.newCase({ loop: "triage", type: "phishing" });
  expect((await s.command(parent, "start_run")).status).toBe(200);
  await s.app.hub.idle();
  child = (ofType(parent, "subloop.started")[0]!.payload as { child: string }).child;
  expect(s.app.hub.read(child).state.memory.type).toBe("unknown-device");
  expect(ofType(child, "case.type_set").map((e) => [e.payload, e.actor])).toEqual([[{ type: "unknown-device" }, { kind: "system", id: "loop-default" }]]);
});

// ---------- slice 14: the hub hosts improve runs ----------

const HUMAN: Actor = { kind: "human", id: "analyst" };
const SYSTEM_ENGINE: Actor = { kind: "system", id: "engine" };
const PROBE_ACTOR: Actor = { kind: "system", id: "improve-probe" };
const TARGET = "investigation";
const TYPE = "unknown-device";
const PROCEDURE = "context/procedures/research.md";
const STOP_AFTER_PROBE = "the test stops after Probe";
const STAGE_TITLES: Record<string, string> = { select: "Select", propose: "Propose", probe: "Probe", compose: "Compose", judge: "Judge", reflect: "Reflect", adopt: "Adopt" };

/** The root an improve run needs: an improve loop of seven inline stages, its profile, and the sample's reputation lookup made free (code accepts free steps only). */
function writeImprove(root: string): void {
  const stages = IMPROVE_ROLES.map((role, i): Record<string, Json> => {
    const agent = role === "propose" || role === "compose" || role === "reflect";
    return {
      id: role, title: STAGE_TITLES[role]!, order: i + 1, runs: agent ? "agent" : role === "adopt" ? "human" : "script", role, gate: role === "adopt" ? "adopt" : null, reviews: false,
      tools: [], schema: null, model: agent ? { provider: "scripted", model: "sample-device", effort: null } : null, on_pass: IMPROVE_ROLES[i + 1] ?? null, on_fail: null,
      ...(role === "probe" ? { probe: { plan_gate: "accept" } } : {}),
    };
  });
  writeFileSync(join(root, "loops", "improve.yaml"), JSON.stringify({ kind: "loop", id: "improve", title: "Improve", version: 1, profile: "improve-test", entry: "select", stages }, null, 2));
  writeFileSync(join(root, "context", "improve-test-profile.yaml"), JSON.stringify({
    kind: "profile", id: "improve-test", title: "Improve (test)", rules: "base-rules", framework: "intel-cycle", standard: "icd203",
    stages: Object.fromEntries(["propose", "compose", "reflect"].map((id) => [id, { agent: "analyst", persona: "analyst", goal: `The ${id} stage of the test.` }])),
  }, null, 2));
  const rep = join(root, "sources", "reputation.yaml");
  const text = readFileSync(rep, "utf8");
  if (!text.includes("cost: { weight: 5, unit: lookups }")) throw new Error("the sample's reputation cost changed");
  writeFileSync(rep, text.replace("cost: { weight: 5, unit: lookups }", "cost: { weight: 0, unit: lookups }"));
}

const blobOf = (x: CaseSession, v: unknown) => x.blobs.put(canonical(v as Json));
const inRun = (env: StageEnv, make: (x: CaseSession, next: (kind: "change") => string) => EntryInput[]): void => {
  env.session.commit((st, ids) => make(env.session, (kind) => ids.next(kind)).map((e) => ({ ...e, run: st.run.id, stage: env.stage.id })));
};
const passing = (action: (env: StageEnv) => void): StageRunner => async (env) => {
  action(env);
  return { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null };
};
const taskInputsOf = (n: number): TaskInputs => ({
  question: `Task ${n}: who is behind the traffic to 198.51.100.77?`, starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN", title: `Task ${n}`,
});
/** The improve case's runners: Select and Propose write their record (one task, one candidate staged through the hub's host); Compose stops the run; Probe is the engine's own. */
function improveRunners(deps: EngineDeps): Partial<Record<Role, StageRunner>> {
  const live = () => deps.loops!.current(TARGET)!;
  return {
    select: passing((env) => inRun(env, (x) => [
      { type: "improve.selected", actor: SYSTEM_ENGINE, payload: { target: TARGET, version: 1, loop_hash: live().pipeline.hash, lock: blobOf(x, live().lock), case_type: TYPE, scale: ["unlikely", "likely"], left_out: [] } },
      {
        type: "improve.task", actor: SYSTEM_ENGINE,
        payload: {
          task: "T1", case: "CASE-90", origin: "f".repeat(64), head: { seq: 9, hash: "9".repeat(64) }, product: { n: 1, draft_hash: "d".repeat(64) },
          answer: { seq: 8, hash: "8".repeat(64) }, marking: "TLP:GREEN", inputs: blobOf(x, taskInputsOf(1)), record: blobOf(x, { record: 1 }),
        },
      },
    ])),
    propose: passing((env) => {
      const root = deps.config.roots[0]!.path;
      const before = readFileSync(join(root, ...PROCEDURE.split("/")), "utf8");
      const files = [{ path: PROCEDURE, text: before.replace("Say what was not found.", "Say what was not found, and why.") }];
      const staged = deps.improve!.stage({ case: env.session.id, origin: env.session.entries(0, 1)[0]!.hash }, "sample", files, TARGET);
      if (!staged.ok) throw new Error(staged.problems.join(" | "));
      inRun(env, (x, next) => [
        {
          type: "builder.proposed", actor: { kind: "agent", id: "propose", stage: "propose", profile: "improve-test", model: "sample-device", effort: null, where: "machine" },
          payload: {
            change: next("change"), title: "Say why", why: "fewer misses", root: "sample",
            files: [{ path: PROCEDURE, kind: "procedure", id: "research-sop", before: sha256Hex(before), after: sha256Hex(files[0]!.text) }],
            bundle: blobOf(x, { files }),
          },
        },
        { type: "improve.candidate", actor: SYSTEM_ENGINE, payload: { candidate: "K1", change: "chg-1", status: "staged", loop_hash: staged.loop.pipeline.hash, lock: blobOf(x, staged.loop.lock), reason: "" } },
      ]);
    }),
    compose: async () => ({ kind: "stalled", reason: STOP_AFTER_PROBE }),
  };
}
const improveIn = (wb: Workbench): CaseSession => wb.createCase(
  { title: "Improve", asked: "Improve the investigation loop", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: null, marking: "TLP:AMBER" },
  HUMAN, { loop: "improve", improve: { target: TARGET, case_type: TYPE, tasks: 1, candidates: 1 }, type: TYPE },
);
const typed = <T extends Entry["type"]>(x: CaseSession, type: T): Extract<Entry, { type: T }>[] => x.entries().filter((e): e is Extract<Entry, { type: T }> => e.type === type);
const stagingOf = (x: CaseSession): string => join(s!.config.improve.staged, stagedFolder({ case: x.id, origin: x.entries(0, 1)[0]!.hash }));

test("a hub's deps carry the improve host, and an improve case's run reaches Probe through it", async () => {
  s = await served({ before: writeImprove, onError: (e) => { errors.push(e); } });
  const deps = s.app.hub.deps;
  expect(deps.improve).toBeDefined();
  expect(deps.children).toBe(s.app.hub.children);
  const imp = improveIn(s.wb);
  const e = Engine.open(imp, deps, { runners: improveRunners(deps) });
  try {
    e.start(HUMAN);
    await e.advance();
    expect(imp.state.run.pause_reason).toBe(STOP_AFTER_PROBE);
    // the candidate was staged into this improve case's staging folder
    expect(existsSync(join(stagingOf(imp), "blobs"))).toBe(true);
    const started = typed(imp, "probe.started").map((x) => x.payload);
    expect(started.map((p) => p.probe)).toEqual(["base/T1", "K1/T1"]);
    const k1 = imp.state.improve.candidates.K1!;
    for (const p of started) {
      const c = s.app.hub.read(p.child);
      expect(c.state.improve.probe_of).toMatchObject({ improve: imp.id, probe: p.probe });
      expect(c.state.memory.type).toBe(TYPE);
      expect(c.state.loop.bound?.hash).toBe(p.candidate === "base" ? imp.state.improve.selected!.loop_hash : k1.loop_hash!);
      // driven to its publish gate with its plan accepted by code, then ended by improve-probe; nothing published
      expect(c.entries().filter((x) => x.type === "plan.accepted").map((x) => x.actor)).toEqual([PROBE_ACTOR]);
      expect(c.entries().filter((x) => x.type === "run.finished").map((x) => x.actor)).toEqual([PROBE_ACTOR]);
      expect(c.entries().some((x) => x.type === "product.published")).toBe(false);
    }
    expect(typed(imp, "probe.finished").map((x) => [x.payload.probe, x.payload.outcome])).toEqual([["base/T1", "drafted"], ["K1/T1", "drafted"]]);
    // the improve run ended: the host clears its staging folder
    e.stop(HUMAN, "enough");
    expect(existsSync(stagingOf(imp))).toBe(false);
  } finally {
    e.close();
  }
});

test("a new hub over the same data folder, mid-probe: the child's engine rebuilds its staged version and the probe is finished", async () => {
  s = await served({ before: writeImprove, onError: (e) => { errors.push(e); } });
  const first = s;
  const imp = improveIn(first.wb);
  const e = Engine.open(imp, first.app.hub.deps, { runners: improveRunners(first.app.hub.deps) });
  // the process stops as the K1 probe is recorded: its child waits at its publish gate, on the staged version
  const commit = imp.commit.bind(imp);
  let armed = true;
  imp.commit = ((fn: Parameters<CaseSession["commit"]>[0]) => commit((state, ids) => {
    const out = fn(state, ids);
    if (armed && out.some((x) => x.type === "probe.finished" && (x.payload as { probe: string }).probe === "K1/T1")) {
      armed = false;
      throw new Error("the process stopped");
    }
    return out;
  })) as CaseSession["commit"];
  e.start(HUMAN);
  await e.advance();
  e.close();
  expect(imp.state.run.status).toBe("paused");
  const k1 = imp.state.improve.candidates.K1!;
  const childId = typed(imp, "probe.started").find((x) => x.payload.probe === "K1/T1")!.payload.child;
  expect(first.app.hub.read(childId).state.run.waiting).toBe("publish");
  const id = imp.id;
  const folder = stagingOf(imp);
  await first.app.close();
  first.wb.close();

  const config = first.config;
  const wb2 = Workbench.open(config.data_dir, { onError: () => {}, store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store });
  const composed2 = compose(config, wb2);
  const later: Engine[] = [];
  try {
    // compose's sweep kept the folder: its improve run is in progress
    expect(existsSync(folder)).toBe(true);
    const hub2 = new CaseHub(wb2, composed2.deps, (err) => { errors.push(err); });
    expect(composed2.deps.improve).toBeDefined();
    // the child's engine in the new hub binds the candidate's staged version
    expect(hub2.engine(childId).bound.pipeline.hash).toBe(k1.loop_hash!);
    const imp2 = wb2.session(id);
    const e2 = Engine.open(imp2, hub2.deps, { runners: improveRunners(hub2.deps) });
    later.push(e2);
    await e2.resume(HUMAN);
    expect(imp2.state.run.pause_reason).toBe(STOP_AFTER_PROBE);
    expect(typed(imp2, "probe.started")).toHaveLength(2);
    const finished = typed(imp2, "probe.finished").map((x) => x.payload);
    expect(finished.map((p) => [p.probe, p.child, p.outcome])).toEqual([["base/T1", finished[0]!.child, "drafted"], ["K1/T1", childId, "drafted"]]);
    const c = wb2.session(childId);
    expect(c.entries().filter((x) => x.type === "run.finished").map((x) => x.actor)).toEqual([PROBE_ACTOR]);
    for (const x of wb2.listCases()) expect(wb2.session(x.id).state.skipped).toEqual([]);
  } finally {
    for (const x of later) x.close();
    composed2.close();
    wb2.close();
    await first.close();
    s = undefined;
  }
});
