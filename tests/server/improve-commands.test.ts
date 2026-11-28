// Slice 14, Task 17: the improve loop's case commands. A known answer is set and withdrawn by the person the server names; at the adopt gate
// the chosen candidate is accepted or rejected whole (ruling: all or nothing), through the builder's accept, and the same commit passes the gate.
// The improve run is driven to its adopt gate by runners that write its record (Select, Propose staging K1 through the hub's host, Probe,
// Compose, Judge, Reflect); Adopt is the engine's own.
import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../../src/core/hash";
import type { Entry } from "../../src/core/types";
import type { ImproveView } from "../../src/core/wire";
import { Engine } from "../../src/pipeline/engine";
import { ADOPT_STALE, NOT_PROBED, NOT_WAITING } from "../../src/server/improve";
import { ASSEMBLE, IMPROVE_INPUT, IMPROVE_SHEET, IMPROVE_TARGET, RESEARCH, candidateFiles, improveCase, improveRunners } from "../helpers/improve-run";
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

const TARGET = IMPROVE_TARGET;
const INPUT = IMPROVE_INPUT;
const SHEET = IMPROVE_SHEET;
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
  expect(refusedOf(await t.command(paused, "adopt_decide", { change: "chg-1", accept: false }))).toEqual([NOT_WAITING]);
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
  expect((await t.command(id, "adopt_decide", { change: "chg-1", accept: false })).status).toBe(200);
  await t.app.hub.idle();
  const late = await t.command(id, "adopt_decide", { change: "chg-1", accept: false });
  expect(refusedOf(late)).toEqual([NOT_WAITING]);
});

test("with a candidate chosen and its files undecided, an accept on a run paused or stopped at the adopt gate is refused before anything is written", async () => {
  const t = await open();
  for (const how of ["pause", "stop"] as const) {
    const id = await atGate(t);
    expect(t.app.hub.read(id).state.improve.chosen?.candidate).toBe("K1");
    expect((await t.command(id, how, how === "stop" ? { reason: "enough" } : {})).status).toBe(200);
    await t.app.hub.idle();
    expect(t.app.hub.read(id).state.run.status).toBe(how === "pause" ? "paused" : "finished");
    const chain = t.wb.chain.read().length;
    const research = rootFile(t, RESEARCH);
    const assemble = rootFile(t, ASSEMBLE);
    const n = t.entries(id).length;
    const r = await t.command(id, "adopt_decide", { change: "chg-1", accept: true });
    expect(r.status).toBe(409);
    expect(refusedOf(r)).toEqual([NOT_WAITING]);
    expect([rootFile(t, RESEARCH), rootFile(t, ASSEMBLE)]).toEqual([research, assemble]);
    expect(t.wb.chain.read().slice(chain).filter((e) => e.type === "manifest.written")).toEqual([]);
    expect(t.wb.chain.read().length).toBe(chain);
    expect(t.entries(id).length).toBe(n);
  }
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

test("a rejection decides every file undecided and passes the gate in one commit; nothing is written into a root, and there is no Finish command", async () => {
  const t = await open();
  {
    const id = await atGate(t);
    const finish = await t.command(id, "adopt_finish");
    expect(finish.status).not.toBe(200);
    const files = candidateFiles(t.config.roots[0]!.path);
    const chain = t.wb.chain.read().length;
    const before = t.entries(id).length;
    const r = await t.command(id, "adopt_decide", { change: "chg-1", accept: false });
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
  expect(early.selected).toMatchObject({ target: TARGET, tasks: [{ task: "T1", case: "CASE-90", marking: "TLP:GREEN" }], left_out: [{ case: "CASE-70", why: "marking" }] });
  expect(early.candidates.map((c) => [c.candidate, c.change, c.title, c.why, c.status, c.files.map((f) => [f.path, f.decided, f.stale])])).toEqual([
    ["K1", "chg-1", "Say why", "fewer misses", "staged", [[RESEARCH, null, false], [ASSEMBLE, null, false]]],
    ["K2", "chg-2", "Say nothing new", "the same words", "dropped", [[RESEARCH, null, false]]],
  ]);
  expect(early.candidates[0]!.files[0]!.lines.filter((l) => l.op !== " ").map((l) => l.op)).toEqual(["-", "+"]);
  expect(early.probes.map((p) => [p.probe, p.child, p.head?.seq, p.outcome, p.lookups])).toEqual([["base/T1", "CASE-80", 40, "drafted", 3], ["K1/T1", "CASE-81", 41, "drafted", 4]]);
  // the run goes on to the Judge and on to the adopt gate
  const e = Engine.open(t.app.hub.read(id), t.app.hub.deps, { runners: improveRunners(t) });
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
    ["adopt_decide", { change: "chg-1", accept: true }], ["set_known_answer", ANSWER], ["withdraw_known_answer", { product: 1, reason: "x" }],
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
