// Slice 14, Task 15: the improve loop's host over a workbench: its tasks, its staging stores and its probe children.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import type { Actor, Draft, Marking, Product } from "../../src/core/types";
import { CaseRefused, Workbench } from "../../src/core/workbench";
import type { ProbeMark } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import type { ManifestFile } from "../../src/modules/loop-write";
import { Engine } from "../../src/pipeline/engine";
import type { ImproveHost, ProbeRef } from "../../src/pipeline/improve/host";
import { probeLink } from "../../src/pipeline/improve/probe";
import { improveHost, stagedFolder } from "../../src/pipeline/improve/workbench-host";
import type { ResolvedLoop } from "../../src/pipeline/loops";
import { sampleRoot } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
const ENGINE: Actor = { kind: "system", id: "engine" };
const PROBE: Actor = { kind: "system", id: "improve-probe" };
const TARGET = "investigation";
const TYPE = "unknown-device";
const assembler: Actor = { kind: "agent", id: "assemble", stage: "assemble", profile: "default", model: "scripted-m", effort: null, where: "machine" };

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let config: Config;
let wb: Workbench;
let composed: ReturnType<typeof compose>;
let host: ImproveHost;
let opened: string[];
let errors: unknown[];
const engines = new Map<string, Engine>();
const sessions: CaseSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "improve-host-"));
  sample = sampleRoot(dir);
  // the sample's script runs the reputation lookup; code accepts free steps only, so the lookup is made free in this copy
  const rep = join(sample.root, "sources", "reputation.yaml");
  const repText = readFileSync(rep, "utf8");
  if (!repText.includes("cost: { weight: 5, unit: lookups }")) throw new Error("the sample's reputation cost changed");
  writeFileSync(rep, repText.replace("cost: { weight: 5, unit: lookups }", "cost: { weight: 0, unit: lookups }"));
  const base = loadConfig({ env: {}, home: dir, repoRoot: dir });
  const data = join(dir, "wb");
  config = {
    ...base, data_dir: data, roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 },
    loops: { ...base.loops, store: join(data, "loops"), imports: join(data, "imported") }, improve: { ...base.improve, staged: join(data, "staged") },
  };
  wb = Workbench.open(config.data_dir, { onError: () => {} });
  composed = compose(config, wb);
  opened = [];
  errors = [];
  sessions.length = 0;
  host = improveHost({
    wb, deps: () => ({ ...composed.deps, improve: host }), secrets: () => [], onError: (e) => { errors.push(e); },
    engine: (id) => {
      opened.push(id);
      let e = engines.get(id);
      if (e === undefined) engines.set(id, e = Engine.open(wb.session(id), { ...composed.deps, improve: host }));
      return e;
    },
  });
});
afterEach(() => {
  for (const s of sessions) if (s.open) expect(s.state.skipped).toEqual([]);
  for (const e of engines.values()) e.close();
  engines.clear();
  try { composed.close(); } catch { /* closed */ }
  try { wb.close(); } catch { /* closed */ }
  sample.close();
  rmSync(dir, { recursive: true, force: true });
});

const caseInput = (marking: Marking = "TLP:GREEN") =>
  ({ title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking });
const productOf = (summary: string): Product => ({
  objective: "Decide", question: "Who is behind the traffic?", marking: "TLP:GREEN", summary,
  key_findings: [{ id: "f1", statement: "198.51.100.77 is a test host", likelihood: "likely", confidence: "moderate", confidence_basis: "one source", cites: [], assumptions: [], reasoning: "seen" }],
  gaps_and_limits: "", alternatives: "", assessment: "Likely a test host.", sources: [{ source: "netflow", quality: "good" }], assumptions: [], change: "",
});
/** A case of `type`, with a product published when `publish`. */
function taskCase(type: string, publish: boolean): CaseSession {
  const s = wb.createCase(caseInput(), human, { type });
  sessions.push(s);
  if (publish) {
    const product = productOf(`Published in ${s.id}.`);
    const draft: Draft = { n: 1, hash: sha256Hex(canonical(product as never)), author: assembler, product, reason: "first" };
    s.commit(() => [
      { type: "draft.revised", actor: assembler, payload: { draft } },
      { type: "product.published", actor: human, payload: { n: 1, draft_hash: draft.hash, head_hash: "b".repeat(64), dir: "products/1", bundle: { blob: "c".repeat(64), bytes: 10 } } },
    ]);
  }
  return s;
}
/** An improve case, made by the person. */
function improveCase(): CaseSession {
  const s = wb.createCase({ ...caseInput("TLP:AMBER"), title: "Improve", objective: null }, human, { loop: "improve", improve: { target: TARGET, case_type: TYPE, tasks: 1, candidates: 1 }, type: TYPE });
  sessions.push(s);
  return s;
}
const me = (s: CaseSession) => ({ case: s.id, origin: s.entries(0, 1)[0]!.hash });
const PROCEDURE = "context/procedures/research.md";
const candidateFiles = (): ManifestFile[] => {
  const text = readFileSync(join(sample.root, ...PROCEDURE.split("/")), "utf8");
  if (!text.includes("Say what was not found.")) throw new Error("the sample's procedure changed");
  return [{ path: PROCEDURE, text: text.replace("Say what was not found.", "Say what was not found, and why.") }];
};
/** Every file under `root`, by its path relative to it, with its size and time of change. */
function listing(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const p = join(at, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.set(relative(root, p), `${st.size}:${st.mtimeMs}`);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
const live = (): ResolvedLoop => composed.deps.loops!.current(TARGET)!;
/** A probe child of `parent` made through the host, and its ref. */
function probeChild(parent: CaseSession): ProbeRef {
  const probe = "base/T1";
  const inputs = { question: "Who is behind the traffic to 198.51.100.77?", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" as Marking, title: "Task 1" };
  // a run of the improve case for the link to name
  parent.commit((_, ids) => [{ type: "run.started", actor: ENGINE, payload: { run: ids.next("run"), pipeline: "improve", pipeline_hash: "a".repeat(64), stages: [] } }]);
  const link = probeLink(parent.state, "probe", { probe, loop_hash: live().pipeline.hash }, inputs);
  const mark: ProbeMark = { improve: parent.id, origin: parent.entries(0, 1)[0]!.hash, probe, candidate: "base", task: "T1", plan_gate: "accept", max_lookups: 20, max_tokens: 300000 };
  expect(host.probes.find(link)).toBeNull();
  const made = host.probes.create({ ...caseInput("TLP:AMBER"), title: "Probe" }, link, mark, TYPE);
  expect(host.probes.find(link)).toEqual(made);
  sessions.push(wb.session(made.id));
  return { ...made, parent: parent.id, run: link.run, stage: link.stage, attempt: 1, input_hash: link.input_hash, probe };
}

test("tasks lists the loaded cases of the type that published, newest first, and opens no engine", () => {
  const a = taskCase(TYPE, true);
  taskCase(TYPE, false);
  taskCase("other-type", true);
  const d = taskCase(TYPE, true);
  const views = host.tasks(TYPE);
  expect(views.map((v) => v.ref.case)).toEqual([d.id, a.id]);
  const v = views[0]!;
  expect(v.ref.origin).toBe(d.entries(0, 1)[0]!.hash);
  expect(v.head).toEqual(d.head());
  expect(v.state.published).toHaveLength(1);
  expect(v.entries().map((e) => e.hash)).toEqual(d.entries().map((e) => e.hash));
  expect(host.tasks("no-such-type")).toEqual([]);
  // task gives the case only for its own origin
  expect(host.task(v.ref)?.ref).toEqual(v.ref);
  expect(host.task({ case: d.id, origin: "0".repeat(64) })).toBeNull();
  expect(host.task({ case: "CASE-99", origin: v.ref.origin })).toBeNull();
  expect(opened).toEqual([]);
});

test("stage writes only under <data>/staged/<case>-<origin12>/ and returns the staged loop", () => {
  const s = improveCase();
  const folder = stagedFolder(me(s));
  expect(folder).toBe(`${s.id}-${me(s).origin.slice(0, 12)}`);
  const before = listing(dir);
  const chainBefore = wb.chain.read().length;
  const r = host.stage(me(s), sample.root, candidateFiles(), TARGET);
  if (!r.ok) throw new Error(r.problems.join(" | "));
  expect(r.loop.pipeline.hash).not.toBe(live().pipeline.hash);
  expect(r.loop.manifest.id).toBe(TARGET);
  // the root named by its folder's name stages the same version
  const again = host.stage(me(s), "sample", candidateFiles(), TARGET);
  expect(again.ok && again.loop.pipeline.hash).toBe(r.loop.pipeline.hash);
  const after = listing(dir);
  const changed = [...after].filter(([p, v]) => before.get(p) !== v).map(([p]) => p);
  expect(changed.length).toBeGreaterThan(0);
  for (const p of changed) expect(p.startsWith(join("wb", "staged", folder, "blobs") + "/")).toBe(true);
  for (const p of before.keys()) expect(after.has(p)).toBe(true);
  expect(wb.chain.read()).toHaveLength(chainBefore);
  // the staged store is the one the host gives for that case
  expect(existsSync(join(config.improve.staged, folder, "blobs"))).toBe(true);
  // check reads the roots as they are and writes nothing
  expect(host.check(sample.root, candidateFiles(), TARGET).ok).toBe(true);
  expect(host.stage(me(s), "no-such-root", candidateFiles(), TARGET)).toEqual({ ok: false, problems: ["the root no-such-root is not a trusted root here"] });
  expect(listing(dir)).toEqual(after);
});

test("clear removes that folder, and a second clear is nothing", () => {
  const s = improveCase();
  const other = improveCase();
  const r = host.stage(me(s), sample.root, candidateFiles(), TARGET);
  expect(r.ok).toBe(true);
  host.staged(me(other));
  host.clear(me(s));
  expect(existsSync(join(config.improve.staged, stagedFolder(me(s))))).toBe(false);
  expect(existsSync(join(config.improve.staged, stagedFolder(me(other))))).toBe(true);
  host.clear(me(s));
  expect(errors).toEqual([]);
});

test("probes.create makes a probe child of the task's type; probes.drive refuses a case that is not that child", async () => {
  const parent = improveCase();
  const ref = probeChild(parent);
  const c = wb.session(ref.id);
  expect(c.state.improve.probe_of).toMatchObject({ improve: parent.id, probe: "base/T1", plan_gate: "accept", max_lookups: 20 });
  expect(c.state.loop.parent?.case).toBe(parent.id);
  expect(c.state.memory.type).toBe(TYPE);
  const typed = c.entries().find((e) => e.type === "case.type_set")!;
  expect(typed.actor).toEqual({ kind: "system", id: "improve-task" });
  expect(c.entries(0, 1)[0]!.actor).toEqual(ENGINE);
  expect(host.probes.read(ref)?.state.improve.probe_of?.probe).toBe("base/T1");
  // a case that is not the child the ref names: refused, and nothing is run on it
  const other = taskCase(TYPE, false);
  const wrong: ProbeRef = { ...ref, id: other.id, origin: other.entries(0, 1)[0]!.hash };
  expect(host.probes.read(wrong)).toBeNull();
  await expect(host.probes.drive(wrong, { loop: live() })).rejects.toBeInstanceOf(CaseRefused);
  await expect(host.probes.drive({ ...ref, input_hash: "0".repeat(64) }, { loop: live() })).rejects.toBeInstanceOf(CaseRefused);
  expect(other.state.run.status).toBe("none");
  expect(c.state.run.status).toBe("none");
  expect(opened).toEqual([]);
  // the child itself is driven to its publish gate, its plan accepted by improve-probe
  const summary = await host.probes.drive(ref, { loop: live() });
  expect(summary).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(c.entries().filter((e) => e.type === "plan.accepted").map((e) => e.actor)).toEqual([PROBE]);
  expect(c.state.loop.bound?.hash).toBe(live().pipeline.hash);
});

test("probes.end ends a waiting child's run as stopped by improve-probe and does nothing to a finished one", async () => {
  const parent = improveCase();
  const ref = probeChild(parent);
  const c = wb.session(ref.id);
  // a child with no run: nothing
  host.probes.end(ref, "a probe ends at its publish gate");
  expect(c.entries().some((e) => e.type === "run.finished")).toBe(false);
  await host.probes.drive(ref, { loop: live() });
  expect(c.state.run.waiting).toBe("publish");
  host.probes.end(ref, "a probe ends at its publish gate");
  const finished = c.entries().filter((e) => e.type === "run.finished");
  expect(finished).toHaveLength(1);
  expect(finished[0]!.actor).toEqual(PROBE);
  expect(finished[0]!.payload).toEqual({ outcome: "stopped", reason: "a probe ends at its publish gate" });
  expect(c.state.run.status).toBe("finished");
  const seq = c.state.seq;
  host.probes.end(ref, "again");
  expect(c.state.seq).toBe(seq);
  expect(c.entries().some((e) => e.type === "product.published")).toBe(false);
});
