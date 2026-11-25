import { expect, test } from "bun:test";
import { Refused } from "../../src/core/refused";
import { THEN_ADVANCE } from "../../src/pipeline/contract";
import { Engine, RunRefused } from "../../src/pipeline/engine";
import { PlanRefused } from "../../src/pipeline/plans";
import { PublishRefused } from "../../src/pipeline/publish";
import { FeedbackRefused } from "../../src/pipeline/feedback";
import { ReviseRefused } from "../../src/pipeline/revise";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "../../src/agents/context";
import { Providers } from "../../src/agents/providers";
import { loadConfig } from "../../src/modules/config";
import { loadPipeline } from "../../src/pipeline/manifests";
import { fixture } from "../helpers/tools-fixture";

test("every refusal is a Refused", () => {
  for (const C of [RunRefused, PlanRefused, ReviseRefused, FeedbackRefused]) expect(new C("no")).toBeInstanceOf(Refused);
  expect(new PublishRefused(["a", "b"])).toBeInstanceOf(Refused);
  expect(new PublishRefused(["a", "b"]).reasons).toEqual(["a", "b"]);
  expect(new RunRefused("no").reasons).toEqual(["no"]);
  expect(new RunRefused("no").name).toBe("RunRefused");
  expect(new Refused("m", ["x"]).reasons).toEqual(["x"]);
});

test("THEN_ADVANCE names every engine command, and no command advances the run itself", async () => {
  expect(Object.keys(THEN_ADVANCE).sort()).toEqual(["acceptPlan", "answerChallenge", "approve", "denyPlan", "feedback", "pause", "reject", "replan", "resume", "revise", "rule", "setBudget", "setModel", "setPackLimit", "start", "stop"]);
  const on = Object.entries(THEN_ADVANCE).filter(([, v]) => v).map(([k]) => k).sort();
  expect(on).toEqual(["acceptPlan", "approve", "reject", "replan", "revise", "start"]);
  const f = fixture(false);
  const dir = mkdtempSync(join(tmpdir(), "contract-"));
  try {
    const { pipeline } = loadPipeline(f.sample.registry);
    const engine = new Engine(f.s, {
      config: loadConfig({ env: {}, home: dir, repoRoot: dir }), registry: f.sample.registry, runner: f.sample.deps, seeker: f.sample.seeker,
      providers: new Providers([]), pipeline: pipeline!, profile: loadProfile(f.sample.registry, "investigation"),
    });
    engine.start({ kind: "human", id: "analyst" });
    expect(f.s.state.run.status).not.toBe("none");
    expect(f.s.state.run.current).toBeNull();
    expect(engine.summary().current).toBeNull();
    expect(f.s.entries().some((e) => e.type === "stage.started")).toBe(false);
    expect(f.s.state.skipped).toEqual([]);
  } finally {
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
