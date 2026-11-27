import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import type { Actor } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { draftOf, saveLoop } from "../../src/modules/loop-write";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps } from "../../src/pipeline/engine";
import { sampleRoot } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let config: Config;
let wb: Workbench;
let composed: ReturnType<typeof compose>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compose-reload-"));
  sample = sampleRoot(dir);
  const base = loadConfig({ env: {}, home: dir, repoRoot: dir });
  config = {
    ...base, data_dir: join(dir, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 },
    loops: { ...base.loops, store: join(dir, "wb", "loops"), imports: join(dir, "wb", "imported") },
  };
  wb = Workbench.open(config.data_dir, { onError: () => {} });
  composed = compose(config, wb);
});
afterEach(() => {
  composed.close();
  wb.close();
  sample.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A new version of the default loop, saved by a person as the forms would save it. */
function saveNewVersion(about: string): void {
  const loops = composed.deps.loops!;
  const loop = loops.current("investigation")!;
  const check = saveLoop({ config, chain: wb.chain, content: wb.chainBlobs, secrets: [], loops }, { ...draftOf(loop), about }, loop.manifest.version, { actor: human });
  expect(check.problems).toEqual([]);
}
const newCase = () => wb.createCase({ title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" }, human);
const startedHash = (s: ReturnType<typeof newCase>): string | null => {
  const e = s.entries().find((x) => x.type === "run.started");
  return e !== undefined && e.type === "run.started" ? e.payload.pipeline_hash : null;
};

test("reload after a save: deps.registry, deps.loops and deps.pipeline are the new ones on the same deps object, and an engine made before the reload binds the new version at its next start", () => {
  const deps = composed.deps;
  const was = { ...deps };
  const session = newCase();
  const engine = Engine.open(session, deps);
  saveNewVersion("a new about text");
  expect(composed.reload()).toEqual([]);
  expect(composed.deps).toBe(deps);
  expect(deps.registry).not.toBe(was.registry);
  expect(deps.loops).not.toBe(was.loops);
  expect(deps.runner).not.toBe(was.runner);
  expect(deps.runner.registry).toBe(deps.registry);
  expect(deps.loops!.current("investigation")!.manifest.version).toBe(2);
  expect(deps.pipeline.hash).toBe(deps.loops!.current("investigation")!.pipeline.hash);
  expect(deps.pipeline.hash).not.toBe(was.pipeline.hash);
  expect(deps.components).toBe(deps.loops!.current("investigation")!.components);
  // the new version is recorded on the workbench chain
  const recorded = wb.chain.read().flatMap((e) => (e.type === "loop.recorded" && e.payload.loop === "investigation" ? [[e.payload.version, e.payload.hash]] : []));
  expect(recorded).toEqual([[1, was.pipeline.hash], [2, deps.pipeline.hash]]);
  // copy on write: what the old deps held is as it was
  expect(was.loops!.current("investigation")!.manifest.version).toBe(1);
  expect(was.pipeline.hash).toBe(was.loops!.current("investigation")!.pipeline.hash);
  engine.start(human);
  expect(startedHash(session)).toBe(deps.pipeline.hash);
  expect(session.state.skipped).toEqual([]);
});

test("a run that holds the deps it started with goes on unchanged after a save and a reload; the next run uses the new version", async () => {
  const bound: EngineDeps = { ...composed.deps };
  const first = newCase();
  const running = Engine.open(first, bound);
  running.start(human);
  expect((await running.advance()).waiting).toBe("plan");
  saveNewVersion("saved while a run works");
  composed.reload();
  running.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await running.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(first.entries().some((e) => e.type === "run.paused")).toBe(false);
  expect(startedHash(first)).toBe(bound.pipeline.hash);
  expect(first.state.skipped).toEqual([]);

  const second = newCase();
  Engine.open(second, composed.deps).start(human);
  expect(startedHash(second)).toBe(composed.deps.pipeline.hash);
  expect(composed.deps.pipeline.hash).not.toBe(bound.pipeline.hash);
  expect(second.state.skipped).toEqual([]);
});

test("reload that would leave the default loop unusable marks it so, and a run that holds the deps it started with keeps them (controller ruling)", () => {
  const deps = composed.deps;
  const was = { ...deps };
  const at = join(sample.root, "stages", "research.yaml");
  writeFileSync(at, readFileSync(at, "utf8").replace("on_fail: plan", "on_fail: nowhere"));
  const problems = composed.reload();
  expect(problems).toContain('the default loop "investigation" is not usable: stage "research": on_fail names "nowhere", which is not a stage of this loop');
  expect(deps.pipeline.stages).toEqual([]);
  expect(deps.loops!.current("investigation")).toBeNull();
  // copy on write: what a run took before the reload is as it was
  expect(was.pipeline.stages.length).toBe(9);
  expect(was.loops!.current("investigation")).not.toBeNull();
  // nothing new is recorded for a loop that is not usable
  expect(wb.chain.read().filter((e) => e.type === "loop.recorded" && e.payload.loop === "investigation").length).toBe(1);
});

test("reload closes the old connector pool", () => {
  const old = composed.deps.runner.pool;
  let closed = 0;
  const closeAll = old.closeAll.bind(old);
  old.closeAll = () => { closed++; closeAll(); };
  composed.reload();
  expect(closed).toBe(1);
  expect(composed.deps.runner.pool).not.toBe(old);

  // a run that still holds the old runner can query: the closed pool opens its connector again
  const source = composed.deps.registry.source("reputation")!;
  expect(old.for(source).render({ text: "lookup", bound: { value: "198.51.100.7" }, window: { from: null, to: null }, max_rows: 10, timeout_ms: 5000, budget: null })).toContain("198.51.100.7");
  // each reload closes the pool it replaces, once
  composed.reload();
  expect(closed).toBe(1);
});
