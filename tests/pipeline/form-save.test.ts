import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import type { Json } from "../../src/core/canonical";
import type { CaseSession } from "../../src/core/session";
import type { Actor, Entry } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { draftOf, saveLoop } from "../../src/modules/loop-write";
import type { LoopDraft } from "../../src/modules/loop-write";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps } from "../../src/pipeline/engine";
import { loadPipeline } from "../../src/pipeline/manifests";
import { sampleRoot } from "../helpers/sample-root";

// Controller ruling for Task 13: a form save keeps every stage the person did not edit as a reference to its stage manifest; only an edited stage is
// written inline as a new version of itself. So the loop's legacy hash, which a run from before slice 12 is held to, is unchanged by an unrelated edit.

/** The sample's pipeline hash as the workbench computed it before slice 12. */
const SAMPLE_LEGACY_HASH = "19f7829f3f9c97faf5c149c0eddc4b047471ca3b2119f168abe2cbef93761329";
const CHANGED = "the pipeline has changed since this run started";
const human: Actor = { kind: "human", id: "analyst" };

let dir: string;
let sample: ReturnType<typeof sampleRoot>;
let config: Config;
let wb: Workbench;
let composed: ReturnType<typeof compose>;
const sessions: CaseSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "form-save-"));
  sample = sampleRoot(dir);
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

/** What the workbench ran with before slice 12: the pipeline of every stage manifest, and no loops. */
function oldDepsOf(deps: EngineDeps): EngineDeps {
  const { loops: _l, components: _c, content: _b, ...rest } = deps;
  return { ...rest, pipeline: loadPipeline(deps.registry).pipeline! };
}
function newCase(): CaseSession {
  const s = wb.createCase({ title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" }, human);
  sessions.push(s);
  return s;
}
const reasonsOf = (entries: readonly Entry[]): string[] => entries.flatMap((e) => (e.type === "run.paused" ? [e.payload.reason] : []));
/** Saves the default loop as the forms do: the draft the server gave, changed by `edit`, with the version the screen loaded. */
function formSave(edit: (d: LoopDraft) => void): void {
  const loops = composed.deps.loops!;
  const loop = loops.current("investigation")!;
  const draft = JSON.parse(JSON.stringify(draftOf(loop))) as LoopDraft;
  edit(draft);
  const check = saveLoop({ config, chain: wb.chain, content: wb.chainBlobs, secrets: [], loops }, draft, loop.manifest.version, { actor: human });
  expect(check.problems).toEqual([]);
  expect(composed.reload()).toEqual([]);
}
const stageOf = (d: LoopDraft, id: string): Record<string, Json> => d.stages.find((s) => s.id === id)!;
const fileText = (): string => readFileSync(join(sample.root, "loops", "investigation.yaml"), "utf8");

test("a form save of the about text writes every stage as a reference by id, and the loop's legacy hash is still the sample's", () => {
  formSave((d) => { d.about = "An edited about text."; });
  const now = composed.deps.loops!.current("investigation")!;
  expect(now.manifest.version).toBe(2);
  expect(now.manifest.about).toBe("An edited about text.");
  expect(now.manifest.stages).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"]);
  expect(now.pipeline.stages.every((s) => s.inline !== true)).toBe(true);
  expect(now.pipeline.legacy_hash).toBe(SAMPLE_LEGACY_HASH);
  expect(fileText()).not.toContain("\"order\"");
});

test("a form save that edits one stage writes that stage alone inline; the others stay references", () => {
  formSave((d) => { stageOf(d, "research").title = "Research, edited"; });
  const now = composed.deps.loops!.current("investigation")!;
  const raw = now.manifest.stages;
  expect(raw.filter((s) => typeof s !== "string").map((s) => (s as Record<string, Json>).id)).toEqual(["research"]);
  expect(raw.filter((s) => typeof s === "string")).toEqual(["frame", "plan", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"]);
  expect(now.pipeline.stages.find((s) => s.id === "research")!.title).toBe("Research, edited");
  expect(now.pipeline.legacy_hash).toBeNull();
});

test("a run started before slice 12, waiting at its plan gate, goes on after a form save of an unrelated field: no pause, nothing skipped", async () => {
  const first = newCase();
  const old = Engine.open(first, oldDepsOf(composed.deps));
  old.start(human);
  expect((await old.advance()).waiting).toBe("plan");
  formSave((d) => { d.about = "Saved through the forms while an old run waits."; });
  const engine = Engine.open(first, composed.deps);
  expect(engine.bound.pipeline.legacy_hash).toBe(SAMPLE_LEGACY_HASH);
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(reasonsOf(first.entries())).toEqual([]);
  expect(first.entries().some((e) => e.type === "loop.bound")).toBe(false);
});

test("that old run pauses with today's sentence when the form save edited one of its stages", async () => {
  const first = newCase();
  const old = Engine.open(first, oldDepsOf(composed.deps));
  old.start(human);
  expect((await old.advance()).waiting).toBe("plan");
  formSave((d) => { stageOf(d, "research").title = "Research, edited"; });
  const engine = Engine.open(first, composed.deps);
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  expect(await engine.advance()).toMatchObject({ status: "paused", pause_reason: CHANGED });
});
