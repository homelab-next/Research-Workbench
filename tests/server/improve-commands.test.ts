// Slice 14, Task 17: the improve loop's case commands. A known answer is set and withdrawn by the person the server names; at the adopt gate
// the chosen candidate is accepted or rejected whole (ruling: all or nothing), through the builder's accept, and the same commit passes the gate.
// The improve run is driven to its adopt gate by runners that write its record (Select, Propose staging K1 through the hub's host, Probe,
// Compose, Judge, Reflect); Adopt is the engine's own.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { CaseSession } from "../../src/core/session";
import type { ScoreSheet, TaskInputs } from "../../src/core/state";
import type { Actor, Entry, EntryInput } from "../../src/core/types";
import type { ImproveView, NewImproveInput } from "../../src/core/wire";
import { Engine } from "../../src/pipeline/engine";
import type { StageEnv, StageRunner } from "../../src/pipeline/engine";
import type { Role } from "../../src/pipeline/manifests";
import { ADOPT_STALE, NOT_PROBED, NOT_WAITING } from "../../src/server/improve";
import { served, withImproveLoop } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served | undefined;
let errors: unknown[] = [];
afterEach(async () => {
  try {
    if (s !== undefined) {
      await s.app.hub.idle();
      for (const c of s.wb.listCases()) expect(`${c.id}: ${JSON.stringify(s.app.hub.read(c.id).state.skipped)}`).toBe(`${c.id}: []`);
    }
    expect(errors).toEqual([]);
  } finally {
    await s?.close();
    s = undefined;
    errors = [];
  }
});
const open = async (): Promise<Served> => (s = await served({ before: withImproveLoop, onError: (e) => { errors.push(e); } }));

const ENGINE_ACTOR: Actor = { kind: "system", id: "engine" };
const TARGET = "investigation";
const TYPE = "unknown-device";
const RESEARCH = "context/procedures/research.md";
const ASSEMBLE = "context/procedures/assemble.md";
const INPUT: NewImproveInput = { loop: TARGET, case_type: TYPE, tasks: 1, candidates: 1, marking: "TLP:AMBER" };
const SHEET: ScoreSheet = {
  format: 1, scale: ["unlikely", "likely"],
  outputs: [
    { probe: "base/T1", candidate: "base", task: "T1", outcome: "drafted", score: 500, text: null, findings: [{ expected: 0, produced: null, by: null, similarity: null, likelihood_distance: null, confidence_distance: null, score: 0 }], left_over: ["a statement no answer expects"] },
    { probe: "K1/T1", candidate: "K1", task: "T1", outcome: "drafted", score: 875, text: null, findings: [{ expected: 0, produced: "the device is a printer", by: "code", similarity: 800, likelihood_distance: 0, confidence_distance: 500, score: 875 }], left_over: [] },
  ],
  summary: [{ candidate: "base", score: 500, drafted: 1, tasks: 1 }, { candidate: "K1", score: 875, drafted: 1, tasks: 1 }],
};
const LESSONS = { lessons: [{ lesson: "LESSON-7", title: "Say why nothing was found", fresh: true }], dropped: [] };

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

/** The candidate K1's two files: each procedure of the target loop with one line changed. */
function candidateFiles(root: string): { path: string; before: string; text: string }[] {
  const research = readFileSync(join(root, ...RESEARCH.split("/")), "utf8");
  const assemble = readFileSync(join(root, ...ASSEMBLE.split("/")), "utf8");
  return [
    { path: RESEARCH, before: research, text: research.replace("Say what was not found.", "Say what was not found, and why.") },
    { path: ASSEMBLE, before: assemble, text: `${assemble}Say which card each finding stands on.\n` },
  ];
}

/** The improve case's runners up to Adopt. `judge: false` stalls the Judge, so the run pauses after Compose with no scores. */
function runners(t: Served, opts: { judge?: boolean } = {}): Partial<Record<Role, StageRunner>> {
  const deps = t.app.hub.deps;
  const live = () => deps.loops!.current(TARGET)!;
  const root = t.config.roots[0]!.path;
  return {
    select: passing((env) => inRun(env, (x) => [
      { type: "improve.selected", actor: ENGINE_ACTOR, payload: { target: TARGET, version: live().manifest.version, loop_hash: live().pipeline.hash, lock: blobOf(x, live().lock), case_type: TYPE, scale: ["unlikely", "likely"], left_out: [] } },
      {
        type: "improve.task", actor: ENGINE_ACTOR,
        payload: {
          task: "T1", case: "CASE-90", origin: "f".repeat(64), head: { seq: 9, hash: "9".repeat(64) }, product: { n: 1, draft_hash: "d".repeat(64) },
          answer: { seq: 8, hash: "8".repeat(64) }, marking: "TLP:GREEN", inputs: blobOf(x, taskInputs), record: blobOf(x, { record: 1 }),
        },
      },
    ])),
    propose: passing((env) => {
      const files = candidateFiles(root);
      const staged = deps.improve!.stage({ case: env.session.id, origin: env.session.entries(0, 1)[0]!.hash }, "sample", files.map((f) => ({ path: f.path, text: f.text })), TARGET);
      if (!staged.ok) throw new Error(staged.problems.join(" | "));
      inRun(env, (x, next) => [
        {
          type: "builder.proposed", actor: agent("propose"),
          payload: {
            change: next("change"), title: "Say why", why: "fewer misses", root: "sample",
            files: files.map((f) => ({ path: f.path, kind: "procedure", id: f.path === RESEARCH ? "research-sop" : "assemble-sop", before: sha256Hex(f.before), after: sha256Hex(f.text) })),
            bundle: blobOf(x, { files: files.map((f) => ({ path: f.path, text: f.text })) }),
          },
        },
        { type: "improve.candidate", actor: ENGINE_ACTOR, payload: { candidate: "K1", change: "chg-1", status: "staged", loop_hash: staged.loop.pipeline.hash, lock: blobOf(x, staged.loop.lock), reason: "" } },
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
          payload: { probe, child, child_run: "run-1", head: { seq: 40 + n, hash: `${n}c`.repeat(32) }, outcome: "drafted", reason: "", draft_hash: `${n}d`.repeat(32), output_hash: `${n}e`.repeat(32), output: blobOf(x, { probe }), lookups: 3, tokens: 1000 + n },
        },
      ];
    }))),
    compose: passing((env) => inRun(env, (x) => [{ type: "compose.chosen", actor: agent("compose"), payload: { candidate: "K1", why: "K1 states why nothing was found", contrasts: blobOf(x, []) } }])),
    judge: opts.judge === false
      ? async () => ({ kind: "stalled", reason: "the test holds the Judge" })
      : passing((env) => inRun(env, (x) => [{ type: "judge.scored", actor: ENGINE_ACTOR, payload: { answers: blobOf(x, []), scores: blobOf(x, SHEET), matcher: "code", summary: SHEET.summary } }])),
    reflect: passing(() => undefined, LESSONS as unknown as Json),
  };
}

/** A new improve case, run to its adopt gate (or, with `judge: false`, to the Judge, where it pauses) by an engine with the test's runners. */
async function improveCase(t: Served, opts: { judge?: boolean } = {}): Promise<string> {
  const res = await t.post("/api/improve", INPUT);
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  const e = Engine.open(t.app.hub.read(id), t.app.hub.deps, { runners: runners(t, opts) });
  try {
    e.start({ kind: "human", id: t.config.user });
    await e.advance();
  } finally {
    e.close();
  }
  return id;
}
const atGate = async (t: Served): Promise<string> => {
  const id = await improveCase(t);
  expect(t.app.hub.read(id).state.run).toMatchObject({ status: "waiting", waiting: "adopt" });
  return id;
};
const rootFile = (t: Served, path: string): string => readFileSync(join(t.config.roots[0]!.path, ...path.split("/")), "utf8");
const refusedOf = (r: { body: unknown }): string[] => (r.body as { refused: string[] }).refused;
const ofType = <T extends Entry["type"]>(t: Served, id: string, type: T): Extract<Entry, { type: T }>[] => t.entries(id).filter((e): e is Extract<Entry, { type: T }> => e.type === type);

/** A sample case run and published by the person. */
async function published(t: Served): Promise<string> {
  const id = await t.newCase();
  await t.toPublishGate(id);
  expect((await t.command(id, "approve")).status).toBe(200);
  await t.app.hub.idle();
  expect(t.app.hub.read(id).state.published.length).toBe(1);
  return id;
}
const ANSWER = { product: 1, text: "A printer on the guest network, set up by the help desk.", findings: [{ claim: "the device is a printer", likelihood: "likely", confidence: "high" as const }], marking: "TLP:AMBER" };

// ---------- known answers ----------

test("set_known_answer writes the answer by the person the server names; a refusal is a 409 with its sentence", async () => {
  const t = await open();
  const id = await published(t);
  const r = await t.command(id, "set_known_answer", ANSWER);
  expect(r.status).toBe(200);
  const known = ofType(t, id, "answer.known");
  expect(known.map((e) => [e.actor, e.payload.product, e.payload.draft_hash, e.payload.text, e.payload.findings, e.payload.marking])).toEqual([
    [{ kind: "human", id: t.config.user }, 1, t.app.hub.read(id).state.published[0]!.draft_hash, ANSWER.text, ANSWER.findings, "TLP:AMBER"],
  ]);
  expect(Object.keys(t.app.hub.read(id).state.answers)).toEqual(["1"]);
  const n = t.entries(id).length;
  const no = await t.command(id, "set_known_answer", { ...ANSWER, product: 9 });
  expect(no.status).toBe(409);
  expect(refusedOf(no)).toEqual(["there is no published product 9 in this case"]);
  // the likelihood terms are the case's own standard's
  const term = await t.command(id, "set_known_answer", { ...ANSWER, findings: [{ claim: "a printer", likelihood: "sort of", confidence: "high" }] });
  expect(term.status).toBe(409);
  expect(refusedOf(term)[0]).toContain("sort of");
  // an improve case holds no known answer
  const imp = (await (await t.post("/api/improve", INPUT)).json()) as { id: string };
  const there = await t.command(imp.id, "set_known_answer", ANSWER);
  expect(there.status).toBe(409);
  expect(refusedOf(there)).toEqual(["a probe child and an improve case hold no known answer"]);
  expect(t.entries(id).length).toBe(n);
  expect(ofType(t, imp.id, "answer.known")).toEqual([]);
});

test("withdraw_known_answer removes it", async () => {
  const t = await open();
  const id = await published(t);
  expect((await t.command(id, "set_known_answer", ANSWER)).status).toBe(200);
  const r = await t.command(id, "withdraw_known_answer", { product: 1, reason: "the help desk was wrong" });
  expect(r.status).toBe(200);
  expect(ofType(t, id, "answer.withdrawn").map((e) => [e.actor, e.payload])).toEqual([[{ kind: "human", id: t.config.user }, { product: 1, reason: "the help desk was wrong" }]]);
  expect(t.app.hub.read(id).state.answers).toEqual({});
  const again = await t.command(id, "withdraw_known_answer", { product: 1, reason: "again" });
  expect(again.status).toBe(409);
  expect(refusedOf(again)).toEqual(["there is no known answer for product 1"]);
});

// ---------- the adopt gate ----------

test("adopt_decide accept writes the file into the trusted root as the person, records manifest.written with why builder, writes builder.decided and reloads", async () => {
  const t = await open();
  const id = await atGate(t);
  const files = candidateFiles(t.config.roots[0]!.path);
  const chainBefore = t.wb.chain.read().length;
  const r = await t.command(id, "adopt_decide", { change: "chg-1", accept: true });
  expect(r.status).toBe(200);
  // every file of the candidate, as proposed
  for (const f of files) expect(rootFile(t, f.path)).toBe(f.text);
  const written = t.wb.chain.read().slice(chainBefore).filter((e) => e.type === "manifest.written");
  expect(written.map((e) => [e.actor, e.payload.path, e.payload.why, e.payload.session, e.payload.hash, e.payload.before])).toEqual(files.map((f) => [
    { kind: "human", id: t.config.user }, f.path, "builder", id, sha256Hex(f.text), sha256Hex(f.before),
  ]));
  expect(ofType(t, id, "builder.decided").map((e) => [e.actor, e.payload])).toEqual(files.map((f, file) => [
    { kind: "human", id: t.config.user }, { change: "chg-1", file, accepted: true, written: sha256Hex(f.text) },
  ]));
  // reloaded: the live registry reads the written procedure
  expect(t.app.hub.deps.registry.get("procedure", "research-sop")?.hash).toBe(sha256Hex(files[0]!.text));
});

test("the last decision passes the adopt gate in that person's name and the run finishes completed", async () => {
  const t = await open();
  const id = await atGate(t);
  const before = t.entries(id).length;
  expect((await t.command(id, "adopt_decide", { change: "chg-1", accept: true })).status).toBe(200);
  await t.app.hub.idle();
  const after = t.entries(id).slice(before);
  // the decisions and the gate in one commit, by the person; then the engine's end of the run
  expect(after.slice(0, 3).map((e) => [e.type, e.actor])).toEqual([
    ["builder.decided", { kind: "human", id: t.config.user }], ["builder.decided", { kind: "human", id: t.config.user }], ["gate.passed", { kind: "human", id: t.config.user }],
  ]);
  expect(new Set(after.slice(0, 3).map((e) => e.ts)).size).toBe(1);
  expect(after[2]!.payload).toEqual({ gate: "adopt" });
  const gates = ofType(t, id, "gate.passed");
  expect(gates.every((g) => g.actor.kind === "human")).toBe(true);
  expect(t.app.hub.read(id).state.run).toMatchObject({ status: "finished", outcome: "completed" });
});

test("adopt_decide on a candidate that was not chosen, before the gate, or on a decided file is refused and writes nothing", async () => {
  const t = await open();
  // before the gate: a new improve case has no run
  const fresh = (await (await t.post("/api/improve", INPUT)).json()) as { id: string };
  const early = await t.command(fresh.id, "adopt_decide", { change: "chg-1", accept: true });
  expect(early.status).toBe(409);
  expect(refusedOf(early)).toEqual([NOT_WAITING]);
  // a run paused before Adopt
  const paused = await improveCase(t, { judge: false });
  expect(refusedOf(await t.command(paused, "adopt_decide", { change: "chg-1", accept: true }))).toEqual([NOT_WAITING]);
  expect(refusedOf(await t.command(paused, "adopt_finish"))).toEqual([NOT_WAITING]);
  const id = await atGate(t);
  const n = t.entries(id).length;
  const chain = t.wb.chain.read().length;
  const research = rootFile(t, RESEARCH);
  const other = await t.command(id, "adopt_decide", { change: "chg-9", accept: true });
  expect(other.status).toBe(409);
  expect(refusedOf(other)).toEqual(["chg-9 is not the change Adopt offers"]);
  // a file decided already (here written straight into the ledger): the whole candidate is no longer the one offered undecided
  t.app.hub.read(id).commit((st) => [{ type: "builder.decided", actor: { kind: "human", id: t.config.user }, payload: { change: "chg-1", file: 1, accepted: false, written: null }, run: st.run.id }]);
  const decided = await t.command(id, "adopt_decide", { change: "chg-1", accept: true });
  expect(decided.status).toBe(409);
  expect(refusedOf(decided)).toEqual([`${ASSEMBLE} of change chg-1 is decided already`]);
  expect(t.entries(id).length).toBe(n + 1);
  expect(t.wb.chain.read().length).toBe(chain);
  expect(rootFile(t, RESEARCH)).toBe(research);
  expect(t.app.hub.read(id).state.run).toMatchObject({ status: "waiting", waiting: "adopt" });
  // once the gate is passed, nothing more is decided there
  expect((await t.command(id, "adopt_finish")).status).toBe(200);
  await t.app.hub.idle();
  const late = await t.command(id, "adopt_decide", { change: "chg-1", accept: false });
  expect(refusedOf(late)).toEqual([NOT_WAITING]);
});

test("a file changed on disk since it was proposed is refused as stale, and the gate stays", async () => {
  const t = await open();
  const id = await atGate(t);
  const n = t.entries(id).length;
  const chain = t.wb.chain.read().length;
  const at = join(t.config.roots[0]!.path, ...ASSEMBLE.split("/"));
  const was = readFileSync(at, "utf8");
  writeFileSync(at, `${was}Changed by hand.\n`);
  const r = await t.command(id, "adopt_decide", { change: "chg-1", accept: true });
  expect(r.status).toBe(409);
  expect(refusedOf(r)).toEqual([ADOPT_STALE]);
  // all or nothing: the other file was not written either
  expect(rootFile(t, RESEARCH)).toBe(candidateFiles(t.config.roots[0]!.path)[0]!.before);
  writeFileSync(at, was);
  // a file the candidate does not change, changed since it was probed: the version written would not be the one probed
  const persona = join(t.config.roots[0]!.path, "context", "personas", "researcher.md");
  const text = readFileSync(persona, "utf8");
  writeFileSync(persona, `${text}\nOne more line.\n`);
  t.reload();
  const changed = await t.command(id, "adopt_decide", { change: "chg-1", accept: true });
  expect(changed.status).toBe(409);
  expect(refusedOf(changed)).toEqual([NOT_PROBED]);
  writeFileSync(persona, text);
  t.reload();
  expect(t.entries(id).length).toBe(n);
  expect(t.wb.chain.read().slice(chain).filter((e) => e.type === "manifest.written")).toEqual([]);
  expect(t.app.hub.read(id).state.run).toMatchObject({ status: "waiting", waiting: "adopt" });
  await t.app.hub.idle();
  expect(t.app.hub.read(id).state.run).toMatchObject({ status: "waiting", waiting: "adopt" });
});

test("adopt_finish rejects what is undecided and passes the gate in one commit; nothing is written into a root", async () => {
  const t = await open();
  for (const how of ["adopt_finish", "reject"] as const) {
    const id = await atGate(t);
    const files = candidateFiles(t.config.roots[0]!.path);
    const chain = t.wb.chain.read().length;
    const before = t.entries(id).length;
    const r = how === "adopt_finish" ? await t.command(id, "adopt_finish") : await t.command(id, "adopt_decide", { change: "chg-1", accept: false });
    expect(r.status).toBe(200);
    await t.app.hub.idle();
    const after = t.entries(id).slice(before);
    expect(after.slice(0, 3).map((e) => [e.type, e.payload])).toEqual([
      ["builder.decided", { change: "chg-1", file: 0, accepted: false, written: null }], ["builder.decided", { change: "chg-1", file: 1, accepted: false, written: null }],
      ["gate.passed", { gate: "adopt" }],
    ]);
    expect(new Set(after.slice(0, 3).map((e) => e.ts)).size).toBe(1);
    for (const f of files) expect(rootFile(t, f.path)).toBe(f.before);
    expect(t.wb.chain.read().slice(chain).filter((e) => e.type === "manifest.written")).toEqual([]);
    expect(t.app.hub.read(id).state.run).toMatchObject({ status: "finished", outcome: "completed" });
  }
});

test("after every file of the chosen candidate is accepted, the target's current version has the candidate's hash, and it is recorded on the chain", async () => {
  const t = await open();
  const id = await atGate(t);
  const k1 = t.app.hub.read(id).state.improve.candidates.K1!;
  expect(t.app.hub.deps.loops!.current(TARGET)!.pipeline.hash).not.toBe(k1.loop_hash);
  expect((await t.command(id, "adopt_decide", { change: "chg-1", accept: true })).status).toBe(200);
  await t.app.hub.idle();
  expect(t.app.hub.deps.loops!.current(TARGET)!.pipeline.hash).toBe(k1.loop_hash!);
  const recorded = t.wb.chain.read().filter((e) => e.type === "loop.recorded" && e.payload.loop === TARGET).map((e) => (e.type === "loop.recorded" ? e.payload.hash : ""));
  expect(recorded).toContain(k1.loop_hash!);
  // a new case of the target binds the adopted version
  expect(t.app.hub.deps.loops!.atHash(TARGET, k1.loop_hash!)).toMatchObject({ pipeline: { hash: k1.loop_hash } });
});

test("the improve view shows no score before judge.scored and the sheet after", async () => {
  const t = await open();
  const id = await improveCase(t, { judge: false });
  const view = async (): Promise<ImproveView> => (await (await t.get(`/api/cases/${id}/improve`)).json()) as ImproveView;
  const early = await view();
  expect(early.scores).toBeNull();
  expect(early.chosen).toEqual({ candidate: "K1", why: "K1 states why nothing was found" });
  expect(early.lessons).toEqual([]);
  expect(early.adopt).toMatchObject({ waiting: false, candidate: "K1", change: "chg-1", undecided: 2 });
  expect(early.selected).toMatchObject({ target: TARGET, tasks: [{ task: "T1", case: "CASE-90", marking: "TLP:GREEN" }], left_out: [] });
  expect(early.candidates.map((c) => [c.candidate, c.change, c.title, c.why, c.status, c.files.map((f) => [f.path, f.decided, f.stale])])).toEqual([
    ["K1", "chg-1", "Say why", "fewer misses", "staged", [[RESEARCH, null, false], [ASSEMBLE, null, false]]],
  ]);
  expect(early.candidates[0]!.files[0]!.lines.filter((l) => l.op !== " ").map((l) => l.op)).toEqual(["-", "+"]);
  expect(early.probes.map((p) => [p.probe, p.child, p.head?.seq, p.outcome, p.lookups])).toEqual([["base/T1", "CASE-80", 40, "drafted", 3], ["K1/T1", "CASE-81", 41, "drafted", 3]]);
  // the run goes on to the Judge and on to the adopt gate
  const e = Engine.open(t.app.hub.read(id), t.app.hub.deps, { runners: runners(t) });
  try {
    await e.resume({ kind: "human", id: t.config.user });
  } finally {
    e.close();
  }
  const later = await view();
  expect(later.scores).toEqual(SHEET);
  expect(later.lessons).toEqual([{ lesson: "LESSON-7", title: "Say why nothing was found" }]);
  expect(later.adopt).toEqual({ waiting: true, candidate: "K1", change: "chg-1", undecided: 2 });
  // no known answer reaches the view: the scores name an expected finding by its number
  expect(JSON.stringify(later)).not.toContain("help desk");
});

test("no route and no command takes an actor", async () => {
  const t = await open();
  const id = await atGate(t);
  const someone = { kind: "human", id: "someone-else" };
  const n = t.entries(id).length;
  const cases = t.wb.listCases().length;
  const create = await t.post("/api/improve", { ...INPUT, actor: someone });
  expect(create.status).toBe(400);
  for (const [command, args] of [
    ["adopt_decide", { change: "chg-1", accept: true }], ["adopt_finish", {}], ["set_known_answer", ANSWER], ["withdraw_known_answer", { product: 1, reason: "x" }],
  ] as const) {
    const inArgs = await t.post(`/api/cases/${id}/commands`, { command, args: { ...args, actor: someone } });
    expect(`${command}: ${inArgs.status} ${JSON.stringify(await inArgs.json())}`).toBe(`${command}: 400 ${JSON.stringify({ ok: false, refused: ["the server names the actor"] })}`);
    const inBody = await t.post(`/api/cases/${id}/commands`, { command, args, actor: someone });
    expect(inBody.status).toBe(400);
  }
  expect(t.entries(id).length).toBe(n);
  expect(t.wb.listCases().length).toBe(cases);
  expect(t.app.hub.read(id).state.run).toMatchObject({ status: "waiting", waiting: "adopt" });
});
