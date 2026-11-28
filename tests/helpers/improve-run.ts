// An improve case of the served sample, driven to its adopt gate by runners that write its record (Select, Propose staging K1 through the
// hub's host, Probe, Compose, Judge, Reflect); Adopt is the engine's own. For the web's tests of the Improve lens (slice 14, Task 20), in
// happy-dom and in a real browser. Synthetic values only: the sample's names, RFC 5737 addresses, hashes of repeated digits.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import type { ScoreSheet, TaskInputs } from "../../src/core/state";
import type { Actor, EntryInput } from "../../src/core/types";
import type { NewImproveInput } from "../../src/core/wire";
import { Engine } from "../../src/pipeline/engine";
import type { StageEnv, StageRunner } from "../../src/pipeline/engine";
import type { Role } from "../../src/pipeline/manifests";
import type { Served } from "./served";

const ENGINE_ACTOR: Actor = { kind: "system", id: "engine" };
export const IMPROVE_TARGET = "investigation";
const TYPE = "unknown-device";
export const RESEARCH = "context/procedures/research.md";
export const ASSEMBLE = "context/procedures/assemble.md";
export const IMPROVE_INPUT: NewImproveInput = { loop: IMPROVE_TARGET, case_type: TYPE, tasks: 1, candidates: 2, marking: "TLP:AMBER" };
export const IMPROVE_SHEET: ScoreSheet = {
  format: 1, scale: ["unlikely", "likely"],
  outputs: [
    { probe: "base/T1", candidate: "base", task: "T1", outcome: "drafted", score: 500, text: null, findings: [{ expected: 0, produced: null, by: null, similarity: null, likelihood_distance: null, confidence_distance: null, score: 0 }], left_over: ["a statement no answer expects"] },
    { probe: "K1/T1", candidate: "K1", task: "T1", outcome: "drafted", score: 875, text: null, findings: [{ expected: 0, produced: "the device is a printer", by: "code", similarity: 800, likelihood_distance: 0, confidence_distance: 500, score: 875 }], left_over: [] },
  ],
  summary: [{ candidate: "base", score: 500, drafted: 1, tasks: 1 }, { candidate: "K1", score: 875, drafted: 1, tasks: 1 }],
};
export const IMPROVE_LESSONS = { lessons: [{ lesson: "LESSON-7", title: "Say why nothing was found", fresh: true }], dropped: [] };

export interface ImproveRunOptions {
  /** false stalls the Judge, so the run pauses after Compose with no scores. */
  judge?: boolean;
  /** How many files K1 changes: 2 (research and assemble, the default) or 1 (research only). */
  files?: 1 | 2;
  /** K1's title and why, as Propose's agent wrote them. */
  title?: string; why?: string;
  /** Compose's reason. */
  reason?: string;
}

const blobOf = (x: CaseSession, v: unknown) => x.blobs.put(canonical(v as Json));
const inRun = (env: StageEnv, make: (x: CaseSession, next: (kind: "change") => string) => EntryInput[]): void => {
  env.session.commit((st, ids) => make(env.session, (kind) => ids.next(kind)).map((e) => ({ ...e, run: st.run.id, stage: env.stage.id })));
};
const passing = (action: (env: StageEnv) => void, output: Json = null): StageRunner => async (env) => {
  action(env);
  return { kind: "finished", outcome: "pass", draft_hash: null, output, reason: null };
};
const taskInputs: TaskInputs = { question: "Task 1: who is behind the traffic to 198.51.100.77?", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN", title: "Task 1" };
const agent = (stage: string): Actor => ({ kind: "agent", id: "analyst", stage, profile: "improve-test", model: "sample-device", effort: null, where: "machine" });

/** K1's files: each procedure of the target loop with one line changed (research only, with `files: 1`). */
export function candidateFiles(root: string, files: 1 | 2 = 2): { path: string; before: string; text: string }[] {
  const research = readFileSync(join(root, ...RESEARCH.split("/")), "utf8");
  const assemble = readFileSync(join(root, ...ASSEMBLE.split("/")), "utf8");
  const all = [
    { path: RESEARCH, before: research, text: research.replace("Say what was not found.", "Say what was not found, and why.") },
    { path: ASSEMBLE, before: assemble, text: `${assemble}Say which card each finding stands on.\n` },
  ];
  return all.slice(0, files);
}

/** The improve case's runners up to Adopt: K1 staged and chosen, K2 dropped (its change resolves to the base's own version). */
function runners(t: Served, opts: ImproveRunOptions): Partial<Record<Role, StageRunner>> {
  const deps = t.app.hub.deps;
  const live = () => deps.loops!.current(IMPROVE_TARGET)!;
  const root = t.config.roots[0]!.path;
  return {
    select: passing((env) => inRun(env, (x) => [
      { type: "improve.selected", actor: ENGINE_ACTOR, payload: { target: IMPROVE_TARGET, version: live().manifest.version, loop_hash: live().pipeline.hash, lock: blobOf(x, live().lock), case_type: TYPE, scale: ["unlikely", "likely"], left_out: [{ case: "CASE-70", why: "marking" }] } },
      {
        type: "improve.task", actor: ENGINE_ACTOR,
        payload: {
          task: "T1", case: "CASE-90", origin: "f".repeat(64), head: { seq: 9, hash: "9".repeat(64) }, product: { n: 1, draft_hash: "d".repeat(64) },
          answer: { seq: 8, hash: "8".repeat(64) }, marking: "TLP:GREEN", inputs: blobOf(x, taskInputs), record: blobOf(x, { record: 1 }),
        },
      },
    ])),
    propose: passing((env) => {
      const files = candidateFiles(root, opts.files ?? 2);
      const staged = deps.improve!.stage({ case: env.session.id, origin: env.session.entries(0, 1)[0]!.hash }, "sample", files.map((f) => ({ path: f.path, text: f.text })), IMPROVE_TARGET);
      if (!staged.ok) throw new Error(staged.problems.join(" | "));
      const research = files[0]!;
      inRun(env, (x, next) => [
        {
          type: "builder.proposed", actor: agent("propose"),
          payload: {
            change: next("change"), title: opts.title ?? "Say why", why: opts.why ?? "fewer misses", root: "sample",
            files: files.map((f) => ({ path: f.path, kind: "procedure", id: f.path === RESEARCH ? "research-sop" : "assemble-sop", before: sha256Hex(f.before), after: sha256Hex(f.text) })),
            bundle: blobOf(x, { files: files.map((f) => ({ path: f.path, text: f.text })) }),
          },
        },
        { type: "improve.candidate", actor: ENGINE_ACTOR, payload: { candidate: "K1", change: "chg-1", status: "staged", loop_hash: staged.loop.pipeline.hash, lock: blobOf(x, staged.loop.lock), reason: "" } },
        {
          type: "builder.proposed", actor: agent("propose"),
          payload: {
            change: next("change"), title: "Say nothing new", why: "the same words", root: "sample",
            files: [{ path: RESEARCH, kind: "procedure", id: "research-sop", before: sha256Hex(research.before), after: sha256Hex(research.before) }],
            bundle: blobOf(x, { files: [{ path: RESEARCH, text: research.before }] }),
          },
        },
        { type: "improve.candidate", actor: ENGINE_ACTOR, payload: { candidate: "K2", change: "chg-2", status: "dropped", loop_hash: null, lock: null, reason: "it gives the loop's own version" } },
      ]);
    }),
    probe: passing((env) => inRun(env, (x) => ["base", "K1"].flatMap((candidate, n): EntryInput[] => {
      const probe = `${candidate}/T1`;
      const loop_hash = candidate === "base" ? x.state.improve.selected!.loop_hash : x.state.improve.candidates.K1!.loop_hash!;
      const child = `CASE-${80 + n}`;
      return [
        { type: "probe.started", actor: ENGINE_ACTOR, payload: { probe, candidate, task: "T1", child, origin: "0a".repeat(32), loop_hash, input_hash: "0b".repeat(32), budgets: { lookups: 120, tokens: 600000 } } },
        {
          type: "probe.finished", actor: ENGINE_ACTOR,
          payload: { probe, child, child_run: "run-1", head: { seq: 40 + n, hash: `${n}c`.repeat(32) }, outcome: "drafted", reason: "", draft_hash: `${n}d`.repeat(32), output_hash: `${n}e`.repeat(32), output: blobOf(x, { probe }), lookups: 3 + n, tokens: 1000 + n },
        },
      ];
    }))),
    compose: passing((env) => inRun(env, (x) => [{ type: "compose.chosen", actor: agent("compose"), payload: { candidate: "K1", why: opts.reason ?? "K1 states why nothing was found", contrasts: blobOf(x, []) } }])),
    judge: opts.judge === false
      ? async () => ({ kind: "stalled", reason: "the test holds the Judge" })
      : passing((env) => inRun(env, (x) => [{ type: "judge.scored", actor: ENGINE_ACTOR, payload: { answers: blobOf(x, []), scores: blobOf(x, IMPROVE_SHEET), matcher: "code", summary: IMPROVE_SHEET.summary } }])),
    reflect: passing(() => undefined, IMPROVE_LESSONS as unknown as Json),
  };
}

/** A new improve case, run to its adopt gate (or, with `judge: false`, to the Judge, where it pauses) by an engine with the runners above. */
export async function improveCase(t: Served, opts: ImproveRunOptions = {}): Promise<string> {
  const res = await t.post("/api/improve", IMPROVE_INPUT);
  if (res.status !== 200) throw new Error(`POST /api/improve: ${res.status} ${await res.text()}`);
  const { id } = (await res.json()) as { id: string };
  const e = Engine.open(t.app.hub.read(id), t.app.hub.deps, { runners: runners(t, opts) });
  try {
    e.start({ kind: "human", id: t.config.user });
    await e.advance();
  } finally {
    e.close();
  }
  await t.app.hub.idle();
  return id;
}
