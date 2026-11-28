// Final review C1: Adopt writes a candidate's files only when the version that was probed covers every one of them (a source's field notes and a
// playbook's steps as well as the loop's components).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import type { Actor, EntryInput } from "../../src/core/types";
import { Engine } from "../../src/pipeline/engine";
import type { StageEnv, StageRunner } from "../../src/pipeline/engine";
import type { Role } from "../../src/pipeline/manifests";
import { NOT_PROBED } from "../../src/server/improve";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

const ENGINE_ACTOR: Actor = { kind: "system", id: "engine" };
const TARGET = "investigation";
const RESEARCH = "context/procedures/research.md";
const SOURCE = "sources/dns-logs.yaml";
const NOTE = "the answer column is the address the name resolved to";
let s: Served;
beforeAll(async () => { s = await served(); });
afterAll(async () => { const d = s.dir; await s.close(); rmSync(d, { recursive: true, force: true }); });

const blobOf = (x: CaseSession, v: unknown) => x.blobs.put(canonical(v as Json));
const inRun = (env: StageEnv, make: (x: CaseSession, next: (kind: "change") => string) => EntryInput[]): void => {
  env.session.commit((st, ids) => make(env.session, (kind) => ids.next(kind)).map((e) => ({ ...e, run: st.run.id, stage: env.stage.id })));
};
const passing = (action: (env: StageEnv) => void, output: Json = null): StageRunner => async (env) => { action(env); return { kind: "finished", outcome: "pass", draft_hash: null, output, reason: null }; };
const agent = (stage: string): Actor => ({ kind: "agent", id: "analyst", stage, profile: "improve-test", model: "sample-device", effort: null, where: "machine" });
const me = (x: CaseSession) => ({ case: x.id, origin: x.entries(0, 1)[0]!.hash });

/** An improve case run to its adopt gate with one candidate: the procedure and the source changed, recorded under the hash `staged` names. */
async function atAdopt(staged: "both" | "procedure"): Promise<{ id: string; change: string }> {
  const deps = s.app.hub.deps;
  const root = s.config.roots[0]!.path;
  const live = () => deps.loops!.current(TARGET)!;
  const research = readFileSync(join(root, RESEARCH), "utf8");
  const source = readFileSync(join(root, SOURCE), "utf8");
  const files = [
    { path: RESEARCH, kind: "procedure", id: "research-sop", before: research, text: research.replace("Say what was not found.", "Say what was not found, and why.") },
    { path: SOURCE, kind: "source", id: "dns-logs", before: source, text: source.replace("{ name: answer, type: address }", `{ name: answer, type: address, meaning: "${NOTE}" }`) },
  ];
  expect(files.every((f) => f.text !== f.before)).toBe(true);
  const res = await s.post("/api/improve", { loop: TARGET, case_type: "unknown-device", tasks: 1, candidates: 1, marking: "TLP:AMBER" });
  const { id } = (await res.json()) as { id: string };
  let change = "";
  const runners: Partial<Record<Role, StageRunner>> = {
    select: passing((env) => inRun(env, (x) => [
      { type: "improve.selected", actor: ENGINE_ACTOR, payload: { target: TARGET, version: live().manifest.version, loop_hash: live().pipeline.hash, lock: blobOf(x, live().lock), case_type: "unknown-device", scale: ["unlikely", "likely"], left_out: [] } },
      { type: "improve.task", actor: ENGINE_ACTOR, payload: { task: "T1", case: "CASE-90", origin: "f".repeat(64), head: { seq: 9, hash: "9".repeat(64) }, product: { n: 1, draft_hash: "d".repeat(64) }, answer: { seq: 8, hash: "8".repeat(64) }, marking: "TLP:GREEN", inputs: blobOf(x, {}), record: blobOf(x, {}) } },
    ])),
    propose: passing((env) => {
      const laid = staged === "both" ? files : files.slice(0, 1);
      const r = deps.improve!.stage(me(env.session), "sample", laid.map((f) => ({ path: f.path, text: f.text })), TARGET);
      if (!r.ok) throw new Error(r.problems.join(" | "));
      inRun(env, (x, next) => {
        change = next("change");
        return [
          { type: "builder.proposed", actor: agent("propose"), payload: { change, title: "t", why: "w", root: "sample", files: files.map((f) => ({ path: f.path, kind: f.kind, id: f.id, before: sha256Hex(f.before), after: sha256Hex(f.text) })), bundle: blobOf(x, { files: files.map((f) => ({ path: f.path, text: f.text })) }) } },
          { type: "improve.candidate", actor: ENGINE_ACTOR, payload: { candidate: "K1", change, status: "staged", loop_hash: r.loop.pipeline.hash, lock: blobOf(x, r.loop.lock), reason: "" } },
        ];
      });
    }),
    probe: passing((env) => inRun(env, (x) => ["base", "K1"].flatMap((candidate, n): EntryInput[] => {
      const probe = `${candidate}/T1`;
      const loop_hash = candidate === "base" ? x.state.improve.selected!.loop_hash : x.state.improve.candidates.K1!.loop_hash!;
      return [
        { type: "probe.started", actor: ENGINE_ACTOR, payload: { probe, candidate, task: "T1", child: `CASE-${80 + n}`, origin: "0a".repeat(32), loop_hash, input_hash: "0b".repeat(32), budgets: { lookups: 1, tokens: 1 } } },
        { type: "probe.finished", actor: ENGINE_ACTOR, payload: { probe, child: `CASE-${80 + n}`, child_run: "run-1", head: { seq: 40 + n, hash: `${n}c`.repeat(32) }, outcome: "drafted", reason: "", draft_hash: `${n}d`.repeat(32), output_hash: `${n}e`.repeat(32), output: blobOf(x, { probe }), lookups: 1, tokens: 1 } },
      ];
    }))),
    compose: passing((env) => inRun(env, (x) => [{ type: "compose.chosen", actor: agent("compose"), payload: { candidate: "K1", why: "w", contrasts: blobOf(x, []) } }])),
    judge: passing((env) => inRun(env, (x) => [{ type: "judge.scored", actor: ENGINE_ACTOR, payload: { answers: blobOf(x, []), scores: blobOf(x, { format: 1, scale: [], outputs: [], summary: [] }), matcher: "code", summary: [] } }])),
    reflect: passing(() => undefined, { lessons: [], dropped: [] } as unknown as Json),
  };
  const e = Engine.open(s.app.hub.read(id), deps, { runners });
  try { e.start({ kind: "human", id: s.config.user }); await e.advance(); } finally { e.close(); }
  await s.app.hub.idle();
  const st = s.app.hub.read(id).state;
  expect(st.run.waiting).toBe("adopt");
  expect(st.skipped).toEqual([]);
  return { id, change };
}

test("a candidate whose probed version left out its source change is refused at Adopt, and nothing is written", async () => {
  const root = s.config.roots[0]!.path;
  const before = [readFileSync(join(root, RESEARCH), "utf8"), readFileSync(join(root, SOURCE), "utf8")];
  const { id, change } = await atAdopt("procedure");
  const r = await s.command(id, "adopt_decide", { change, accept: true });
  await s.app.hub.idle();
  expect(r.status).toBe(409);
  expect(JSON.stringify(r.body)).toContain(NOT_PROBED);
  expect([readFileSync(join(root, RESEARCH), "utf8"), readFileSync(join(root, SOURCE), "utf8")]).toEqual(before);
  expect(s.app.hub.read(id).state.run.waiting).toBe("adopt");
}, 120_000);

test("a candidate whose probed version holds every file of its change is adopted whole", async () => {
  const root = s.config.roots[0]!.path;
  const { id, change } = await atAdopt("both");
  const r = await s.command(id, "adopt_decide", { change, accept: true });
  await s.app.hub.idle();
  expect(r.status).toBe(200);
  expect(readFileSync(join(root, SOURCE), "utf8")).toContain(NOTE);
  expect(readFileSync(join(root, RESEARCH), "utf8")).toContain("Say what was not found, and why.");
}, 120_000);
