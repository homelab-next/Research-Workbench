// Slice 14, Task 14: Adopt offers the chosen candidate's change, whole, and writes nothing else: the gate is the engine's, and only a person
// passes it (controller ruling: a candidate is adopted all or nothing, and only a version that was probed).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import type { CaseSession } from "../../src/core/session";
import type { Actor, Entry, EntryInput } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { Engine } from "../../src/pipeline/engine";
import type { StageEnv, StageRunner } from "../../src/pipeline/engine";
import type { ImproveHost } from "../../src/pipeline/improve/host";
import { IMPROVE_ROLES } from "../../src/pipeline/manifests";
import type { Role } from "../../src/pipeline/manifests";
import { sampleRoot } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
const ENGINE: Actor = { kind: "system", id: "engine" };
const agentOf = (stage: string): Actor => ({ kind: "agent", id: stage, stage, profile: "improve-test", model: "m", effort: null, where: "machine" });

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let config: Config;
let wb: Workbench;
let composed: ReturnType<typeof compose>;
const sessions: CaseSession[] = [];

function improveLoop(): Record<string, Json> {
  const stages = IMPROVE_ROLES.map((role, i): Record<string, Json> => {
    const agent = role === "propose" || role === "compose" || role === "reflect";
    return {
      id: role, title: role, order: i + 1, runs: agent ? "agent" : role === "adopt" ? "human" : "script", role, gate: role === "adopt" ? "adopt" : null, reviews: false,
      tools: [], schema: null, model: agent ? { provider: "scripted", model: "m", effort: null } : null, on_pass: IMPROVE_ROLES[i + 1] ?? null, on_fail: null,
      ...(role === "probe" ? { probe: { plan_gate: "accept" } } : {}),
    };
  });
  return { kind: "loop", id: "improve", title: "Improve", version: 1, profile: "improve-test", entry: "select", stages };
}
const IMPROVE_PROFILE = { kind: "profile", id: "improve-test", title: "Improve (test)", rules: "base-rules", framework: "intel-cycle", standard: "icd203",
  stages: Object.fromEntries(["propose", "compose", "reflect"].map((id) => [id, { agent: "analyst", persona: "analyst", goal: `The ${id} stage of the test.` }])),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "improve-adopt-"));
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
  sessions.length = 0;
});
afterEach(() => {
  for (const s of sessions) if (s.open) expect(s.state.skipped).toEqual([]);
  try { composed.close(); } catch { /* closed */ }
  try { wb.close(); } catch { /* closed */ }
  sample.close();
  rmSync(dir, { recursive: true, force: true });
});

function improveCase(): CaseSession {
  const s = wb.createCase(
    { title: "Improve", asked: "Improve the investigation loop", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: null, marking: "TLP:GREEN" },
    human, { loop: "improve" },
  );
  sessions.push(s);
  s.commit(() => [{ type: "improve.requested", actor: human, payload: { target: "investigation", case_type: "unknown-device", tasks: 1, candidates: 1 } }]);
  return s;
}
const host: ImproveHost = {
  tasks: () => [], task: () => null, staged: () => { throw new Error("no staging store"); }, stage: () => ({ ok: false, problems: ["not here"] }),
  check: () => { throw new Error("not here"); }, clear: () => {},
  probes: { find: () => null, create: () => { throw new Error("not here"); }, drive: () => { throw new Error("not here"); }, read: () => null, end: () => {} },
};
const put = (s: CaseSession, x: unknown) => s.blobs.put(canonical(x as Json));
const commitIn = (env: StageEnv, entries: (s: CaseSession, next: (kind: "change") => string) => EntryInput[]): void => {
  env.session.commit((st, ids) => entries(env.session, (kind) => ids.next(kind)).map((e) => ({ ...e, run: st.run.id, stage: env.stage.id })));
};
const STAGED = "a1".repeat(32);

/** The stages before Adopt as runners writing the record; Compose chooses K1, or none. Adopt is the real one. */
function runnersOf(choose: "K1" | null): Partial<Record<Role, StageRunner>> {
  const after = (act: (env: StageEnv) => void): StageRunner => async (env) => { act(env); return { kind: "finished", outcome: "pass", draft_hash: null, output: null, reason: null }; };
  return {
    select: after((env) => commitIn(env, (s) => [
      {
        type: "improve.selected", actor: ENGINE,
        payload: { target: "investigation", version: 1, loop_hash: composed.deps.loops!.current("investigation")!.pipeline.hash, lock: put(s, { lock: 1 }), case_type: "unknown-device", scale: ["unlikely", "likely"], left_out: [] },
      },
      {
        type: "improve.task", actor: ENGINE,
        payload: {
          task: "T1", case: "CASE-90", origin: "f".repeat(64), head: { seq: 9, hash: "9".repeat(64) }, product: { n: 1, draft_hash: "d".repeat(64) }, answer: { seq: 8, hash: "8".repeat(64) },
          marking: "TLP:GREEN", inputs: put(s, { inputs: 1 }), record: put(s, { record: 1 }),
        },
      },
    ])),
    propose: after((env) => commitIn(env, (s, next) => [
      {
        type: "builder.proposed", actor: agentOf("propose"),
        payload: {
          change: next("change"), title: "Clearer research", why: "fewer misses", root: "sample",
          files: [{ path: "skills/a.md", kind: "skill", id: "a", before: "4".repeat(64), after: "5".repeat(64) }, { path: "skills/b.md", kind: "skill", id: "b", before: "6".repeat(64), after: "7".repeat(64) }],
          bundle: put(s, { bundle: 1 }),
        },
      },
      { type: "improve.candidate", actor: ENGINE, payload: { candidate: "K1", change: "chg-1", status: "staged", loop_hash: STAGED, lock: put(s, { staged: 1 }), reason: "" } },
    ])),
    probe: after((env) => commitIn(env, (s) => ["base", "K1"].flatMap((c, i): EntryInput[] => [
      {
        type: "probe.started", actor: ENGINE,
        payload: { probe: `${c}/T1`, candidate: c, task: "T1", child: `CASE-${70 + i}`, origin: "0a".repeat(32), loop_hash: "e".repeat(64), input_hash: "0b".repeat(32), budgets: { lookups: 60, tokens: 300000 } },
      },
      {
        type: "probe.finished", actor: ENGINE,
        payload: {
          probe: `${c}/T1`, child: `CASE-${70 + i}`, child_run: "run-1", head: { seq: 30, hash: "3".repeat(64) }, outcome: "incomplete", reason: "it stopped", draft_hash: null,
          output_hash: "c".repeat(64), output: put(s, { output: c }), lookups: 3, tokens: 900,
        },
      },
    ]))),
    compose: after((env) => commitIn(env, (s) => [{ type: "compose.chosen", actor: agentOf("compose"), payload: { candidate: choose, why: "the test chose", contrasts: put(s, []) } }])),
    judge: after(() => {}),
    reflect: after(() => {}),
  };
}

type Finished = Extract<Entry, { type: "stage.finished" }>;
const adoptEnd = (s: CaseSession): Finished => s.entries().findLast((e): e is Finished => e.type === "stage.finished" && e.payload.stage === "adopt")!;
const outputOf = (s: CaseSession, e: Finished): unknown => (e.payload.output === null ? null : JSON.parse(s.blobs.text(e.payload.output.blob)));
/** The entries Adopt's pass wrote between its stage.started and its stage.finished. */
const between = (s: CaseSession): Entry[] => {
  const all = s.entries();
  const from = all.findLastIndex((e) => e.type === "stage.started" && e.payload.stage === "adopt");
  const to = all.findLastIndex((e) => e.type === "stage.finished" && e.payload.stage === "adopt");
  return all.slice(from + 1, to);
};

test("Adopt passes with the chosen candidate's change and its file count, and with nothing when none was chosen", async () => {
  const s = improveCase();
  const engine = Engine.open(s, { ...composed.deps, improve: host }, { runners: runnersOf("K1") });
  engine.start(human);
  expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "adopt" });
  const end = adoptEnd(s);
  expect(end.payload.outcome).toBe("pass");
  // the whole candidate is offered: the version that was probed, and every file of its change
  expect(outputOf(s, end)).toEqual({ candidate: "K1", change: "chg-1", files: 2, loop_hash: STAGED });
  expect(between(s)).toEqual([]);
  // nothing is decided and no gate is passed by Adopt: both are the person's
  expect(s.state.builder.changes["chg-1"]!.files.every((f) => f.decided === null)).toBe(true);
  expect(s.entries().some((e) => e.type === "builder.decided" || (e.type === "gate.passed" && e.payload.gate === "adopt"))).toBe(false);

  const none = improveCase();
  const e2 = Engine.open(none, { ...composed.deps, improve: host }, { runners: runnersOf(null) });
  e2.start(human);
  expect(await e2.advance()).toMatchObject({ status: "finished", outcome: "completed" });
  expect(outputOf(none, adoptEnd(none))).toEqual({ candidate: null });
  expect(between(none)).toEqual([]);
});
