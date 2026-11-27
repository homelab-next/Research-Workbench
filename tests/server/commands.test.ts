import { afterEach, expect, test } from "bun:test";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps } from "../../src/pipeline/engine";
import { PlanRefused } from "../../src/pipeline/plans";
import { createApp } from "../../src/server/app";
import { LIMITS } from "../../src/server/views";
import { startStandin } from "../helpers/http-standin";
import { served, writeLocalModel } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served;
let standin: ReturnType<typeof startStandin> | undefined;
afterEach(async () => { await s?.close(); standin?.stop(); standin = undefined; });
const types = (id: string): string[] => s.entries(id).map((e) => e.type);

test("start_run starts the run and the server drives it to the plan gate", async () => {
  s = await served();
  const id = await s.newCase();
  const r = await s.command(id, "start_run");
  expect(r).toEqual({ status: 200, body: { ok: true, seq: expect.any(Number) } });
  await s.app.hub.idle();
  expect(s.app.hub.read(id).state.run).toMatchObject({ status: "waiting", waiting: "plan" });
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
});

test("a command returns before the run has moved on", async () => {
  s = await served();
  const id = await s.newCase();
  const r = await s.command(id, "start_run");
  await s.app.hub.idle();
  expect((r.body as { seq: number }).seq).toBeLessThan(s.app.hub.read(id).head().seq);
});

test("the sample runs to a published product through commands alone", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  expect((await s.command(id, "approve")).status).toBe(200);
  await s.app.hub.idle();
  const st = s.app.hub.read(id).state;
  expect(st.run).toMatchObject({ status: "finished", outcome: "published" });
  expect(st.skipped).toEqual([]);
  for (const e of s.entries(id)) if (e.actor.kind === "human") expect(e.actor.id).toBe(s.config.user);
});

test("pause, set_budget, set_model, set_pack_limit, feedback and stop do not move the run", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPlanGate(id);
  const stage = s.app.hub.read(id).state.run.stages[0]!.id;
  const models = (await (await s.get(`/api/cases/${id}/models`)).json()) as { provider: string; model: string; efforts: string[]; allowed: boolean }[];
  const m = models.find((x) => x.allowed)!;
  const steps: [string, Record<string, unknown>, string][] = [
    ["pause", {}, "run.paused"],
    ["set_budget", { tokens: 1000 }, "budget.set"],
    ["set_model", { stage, provider: m.provider, model: m.model, effort: null }, "stage.model_set"],
    ["set_pack_limit", { stage, max_marking: "TLP:AMBER" }, "stage.pack_limit_set"],
    ["stop", { reason: "enough" }, "run.finished"],
  ];
  for (const [name, args, type] of steps) {
    const before = s.entries(id).length;
    const r = await s.command(id, name, args);
    expect([name, r.status]).toEqual([name, 200]);
    await s.app.hub.idle();
    expect([name, types(id).slice(before)]).toEqual([name, [type]]);
  }
  expect(s.app.hub.read(id).state.run).toMatchObject({ status: "finished", outcome: "stopped" });
});

test("feedback does not move the run", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  await s.command(id, "approve");
  await s.app.hub.idle();
  const before = s.entries(id).length;
  const r = await s.command(id, "feedback", { measure: "queries_run", value: 1, note: "n" });
  await s.app.hub.idle();
  // either recorded (200) or refused with the engine's words; either way the run is not advanced
  expect([200, 409]).toContain(r.status);
  expect(s.entries(id).slice(before).every((e) => e.actor.kind === "human")).toBe(true);
  expect(s.app.hub.read(id).state.run.status).toBe("finished");
});

test("a refusal is 409 with the engine's own words and writes nothing", async () => {
  s = await served();
  const id = await s.newCase();
  const before = s.entries(id).length;
  expect(await s.command(id, "approve")).toEqual({ status: 409, body: { ok: false, refused: [expect.stringContaining("publish")] } });
  expect(s.entries(id).length).toBe(before);
});

test("approving twice publishes once", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  const [a, b] = await Promise.all([s.command(id, "approve"), s.command(id, "approve")]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  await s.app.hub.idle();
  expect(s.entries(id).filter((e) => e.type === "product.published").length).toBe(1);
});

test("accepting the plan twice writes one plan.accepted", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPlanGate(id);
  const [a, b] = await Promise.all([s.command(id, "accept_plan", { budgets: { s3: 1 } }), s.command(id, "accept_plan", { budgets: { s3: 1 } })]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  await s.app.hub.idle();
  expect(s.entries(id).filter((e) => e.type === "plan.accepted").length).toBe(1);
});

test("an unknown command, unknown argument or wrong type is 400 and writes nothing", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPlanGate(id);
  const before = s.entries(id).length;
  for (const [name, args] of [["nope", {}], ["accept_plan", { budgets: { s3: "1" } }], ["keep", { card: "c1", extra: 1 }], ["keep", {}]] as const) {
    const r = await s.command(id, name, args);
    expect([name, r.status]).toEqual([name, 400]);
    expect(r.body).toEqual({ ok: false, refused: [expect.any(String)] });
  }
  for (const body of ["[]", "{\"command\":3}", "{\"command\":\"approve\",\"args\":[]}", "nonsense"]) {
    expect((await s.post(`/api/cases/${id}/commands`, body)).status).toBe(400);
  }
  expect(s.entries(id).length).toBe(before);
});

test("a body that names an actor is 400", async () => {
  s = await served();
  const id = await s.newCase();
  const before = s.entries(id).length;
  for (const body of [{ command: "approve", args: {}, actor: { kind: "human", id: "x" } }, { command: "keep", args: { card: "c1", actor: "x" } }]) {
    const res = await s.post(`/api/cases/${id}/commands`, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, refused: ["the server names the actor"] });
  }
  expect(s.entries(id).length).toBe(before);
});

test("a requester may do nothing", async () => {
  await s?.close();
  s = await served({ role: "requester" });
  const id = s.app.hub.create({ title: "T", asked: "A", why: "W", starting: [], window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, objective: null, marking: "TLP:GREEN" }, { kind: "human", id: "x" }).id;
  const before = s.entries(id).length;
  expect(await s.command(id, "approve")).toEqual({ status: 403, body: { ok: false, refused: ["the requester view may not do approve"] } });
  expect((await s.command(id, "nope")).status).toBe(403);
  expect(s.entries(id).length).toBe(before);
});

test("set_model refuses a model the case's marking may not go to", async () => {
  standin = startStandin({ "GET /v1/models": () => Response.json({ data: [{ id: "big-hosted" }] }), "GET /api/v0/models": () => new Response("no", { status: 404 }) });
  s = await served({ before: (root) => writeLocalModel(root, "cloud", "hosted", `${standin!.url}/v1`) });
  const id = await s.newCase({ marking: "TLP:RED" });
  const before = s.entries(id).length;
  const r = await s.command(id, "set_model", { stage: "agent", provider: "cloud", model: "big-hosted", effort: null });
  expect(r).toEqual({ status: 409, body: { ok: false, refused: ["TLP:RED may not go to a hosted model"] } });
  expect(s.entries(id).length).toBe(before);
});

test("set_model refuses a model no provider lists, and an effort the model does not have", async () => {
  s = await served();
  const id = await s.newCase();
  const models = (await (await s.get(`/api/cases/${id}/models`)).json()) as { provider: string; model: string; allowed: boolean }[];
  const m = models.find((x) => x.allowed)!;
  const before = s.entries(id).length;
  expect((await s.command(id, "set_model", { stage: "agent", provider: m.provider, model: "no-such-model", effort: null })).status).toBe(409);
  expect((await s.command(id, "set_model", { stage: "agent", provider: m.provider, model: m.model, effort: "extreme-effort" })).status).toBe(409);
  expect((await s.command(id, "set_model", { stage: "no-such-stage", provider: m.provider, model: m.model, effort: null })).status).toBe(409);
  expect(s.entries(id).length).toBe(before);
});

test("answer_challenge refuses a challenge from an earlier run", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  const open = Object.values(s.app.hub.read(id).state.challenges)[0];
  // a stopped run, then a new one: the old challenge belongs to the earlier run
  await s.command(id, "stop", { reason: "again" });
  await s.command(id, "start_run");
  await s.app.hub.idle();
  const st = s.app.hub.read(id).state;
  const old = Object.entries(st.challenges).find(([, c]) => c.run !== st.run.id);
  expect(open).toBeDefined();
  expect(old).toBeDefined();
  if (old === undefined) return;
  const before = s.entries(id).length;
  const r = await s.command(id, "answer_challenge", { challenge: old[0], answer: "a", action: "rebutted" });
  expect(r).toEqual({ status: 409, body: { ok: false, refused: [`challenge ${old[0]} is from an earlier run`] } });
  expect(s.entries(id).length).toBe(before);
});

test("a challenge of the current run can be answered", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  const open = Object.values(s.app.hub.read(id).state.challenges).find((c) => c.status === "open")!;
  expect(open.run).toBe(s.app.hub.read(id).state.run.id);
  const r = await s.command(id, "answer_challenge", { challenge: open.id, answer: "checked", action: "rebutted" });
  expect(r.status).toBe(200);
  expect(s.app.hub.read(id).state.challenges[open.id]).toMatchObject({ status: "answered", answer: "checked", action: "rebutted" });
});

test("a provider that never lists its models cannot hold up stop; set_model says the list could not be read", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPlanGate(id);
  const deps = (s.app.hub as unknown as { deps: EngineDeps }).deps;
  const real = deps.providers.all.bind(deps.providers);
  const saved = LIMITS.modelListMs;
  LIMITS.modelListMs = 400;
  (deps.providers as unknown as { all: () => unknown[] }).all = () => [{ id: "hung", where: "machine", models: () => new Promise(() => {}) }];
  try {
    const stage = s.app.hub.read(id).state.run.stages[0]!.id;
    const asked = s.command(id, "set_model", { stage, provider: "hung", model: "m", effort: null });
    await Bun.sleep(50);
    const t0 = Date.now();
    const stopped = await s.command(id, "stop", { reason: "x" });
    expect(stopped.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await asked).toEqual({ status: 409, body: { ok: false, refused: ["the model list could not be read"] } });
  } finally {
    LIMITS.modelListMs = saved;
    (deps.providers as unknown as { all: unknown }).all = real;
  }
});

test("the first command on a case left running by a stopped process finds it interrupted", async () => {
  s = await served();
  const id = await s.newCase();
  // a run started and never finished, as a killed process leaves it; written without the hub, so nothing has recovered it
  const deps = (s.app.hub as unknown as { deps: EngineDeps }).deps;
  new Engine(s.wb.session(id), deps).start({ kind: "human", id: s.config.user });
  expect(s.app.hub.read(id).state.run.status).toBe("running");
  // the process stops and another opens the case: a new session over the same ledger
  s.wb.session(id).close();
  const before = s.entries(id).length;
  expect((await s.get(`/api/cases/${id}/models`)).status).toBe(200);
  const stream = await s.get(`/api/cases/${id}/entries`);
  await stream.body!.cancel();
  expect(s.entries(id).length).toBe(before);
  expect(types(id)).not.toContain("run.interrupted");
  expect((await s.command(id, "pause")).status).toBe(200);
  expect(types(id)).toContain("run.interrupted");
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
});

test("a case left running when the app closed reads interrupted as soon as a new app starts, with no command sent", async () => {
  s = await served();
  const id = await s.newCase();
  const other = await s.newCase();
  const deps = (s.app.hub as unknown as { deps: EngineDeps }).deps;
  new Engine(s.wb.session(id), deps).start({ kind: "human", id: s.config.user });
  expect(s.app.hub.read(id).state.run.status).toBe("running");
  const idleBefore = s.entries(other).length;
  s.wb.session(id).close();
  expect(types(id)).not.toContain("run.interrupted");
  const next = createApp({ config: s.config, wb: s.wb, deps, problems: [], assets: { html: "", js: "", css: "" }, origin: s.origin, onError: () => {} });
  try {
    expect(s.app.hub.read(id).state.run.status).toBe("interrupted");
    expect(types(id).filter((t) => t === "run.interrupted")).toHaveLength(1);
    await next.hub.idle();
    expect(s.entries(other).length).toBe(idleBefore);
  } finally {
    await next.close();
  }
});

test("a playbook job left running by a stopped process, with no run, is recovered as soon as a new app starts", async () => {
  s = await served();
  const id = await s.newCase();
  const deps = (s.app.hub as unknown as { deps: EngineDeps }).deps;
  // a playbook started from the Pivot panel (no run) and never finished, written without the hub: nothing has recovered it
  const pb = deps.registry.playbook("address-triage")!;
  const actor = { kind: "human" as const, id: s.config.user };
  const window = { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" };
  let j1 = "";
  s.wb.session(id).commit((_st, ids) => (j1 = ids.next("job"), [
    { type: "job.started", actor, job: j1, payload: { job: j1, title: "Playbook: Triage an address", kind: "playbook", source: null } },
    { type: "playbook.started", actor, job: j1, payload: {
      job: j1, playbook: pb.id, playbook_hash: pb.hash, title: pb.title, inputs: [{ type: "address", value: "198.51.100.77" }], window, why: "w", plan_step: null,
      steps: pb.steps.map((x) => ({ id: x.id, pivot: x.pivot, pivot_hash: deps.registry.pivot(x.pivot)!.hash })),
    } },
  ]));
  expect(s.app.hub.read(id).state.jobs[j1]!.status).toBe("running");
  expect(s.app.hub.read(id).state.run.status).toBe("none");
  s.wb.session(id).close();
  const next = createApp({ config: s.config, wb: s.wb, deps, problems: [], assets: { html: "", js: "", css: "" }, origin: s.origin, onError: () => {} });
  try {
    const state = s.app.hub.read(id).state;
    expect(state.jobs[j1]!.status).toBe("failed");
    expect(state.playbooks[j1]!.status).toBe("interrupted");
    expect(state.skipped).toEqual([]);
    await next.hub.idle();
  } finally {
    await next.close();
  }
});

test("a refusal that quotes a source error is scrubbed", async () => {
  s = await served();
  const id = await s.newCase();
  const engine = s.app.hub.engine(id);
  engine.acceptPlan = () => { throw new PlanRefused("the source said http://db.example.net:9999/x failed"); };
  await s.toPlanGate(id);
  const r = await s.command(id, "accept_plan", {});
  expect(r.status).toBe(409);
  expect(JSON.stringify(r.body)).toContain("[hidden]");
  expect(JSON.stringify(r.body)).not.toContain("db.example.net");
});

test("resume is refused with the reason when nothing is paused or interrupted, and writes nothing", async () => {
  s = await served();
  const id = await s.newCase();
  const n0 = s.entries(id).length;
  expect(await s.command(id, "resume")).toEqual({ status: 409, body: { ok: false, refused: ["there is no paused or interrupted run to resume; the run is none"] } });
  expect(s.entries(id).length).toBe(n0);
  await s.toPlanGate(id);
  const n1 = s.entries(id).length;
  expect(await s.command(id, "resume")).toEqual({ status: 409, body: { ok: false, refused: ["there is no paused or interrupted run to resume; the run is waiting"] } });
  await s.app.hub.idle();
  expect(s.entries(id).length).toBe(n1);
  expect((await s.command(id, "pause")).status).toBe(200);
  expect((await s.command(id, "resume")).status).toBe(200);
  await s.app.hub.idle();
  expect(s.app.hub.read(id).state.run.waiting).toBe("plan");
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
});

test("a command's then is the contract's: no command file says advance as a literal", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(import.meta.dir, "..", "..", "src", "server");
  const literal = readdirSync(dir).filter((f) => f.endsWith(".ts")).filter((f) => /then:\s*"advance"\s*[,}]/.test(readFileSync(join(dir, f), "utf8")));
  expect(literal).toEqual([]);
});

test("rule_conflict records the person's ruling in the server's name and resumes the run; a requester may not rule", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  const session = s.app.hub.read(id);
  const d = session.state.drafts.at(-1)!;
  const engine = { kind: "system", id: "engine" } as const;
  session.commit((st, ids) => [
    { type: "review.conflict", actor: engine, run: st.run.id, payload: { conflict: {
      id: ids.next("conflict"), draft_hash: d.hash, finding: "f1", change: "likelihood", earlier: "almost certain", now: "likely", raised_by: "evaluate", changed_for: "challenge",
      asks: "almost certain", asked: "lower", points: ["f1: x"], reason: "Evaluate and Challenge disagree on f1",
    } } },
    { type: "run.paused", actor: engine, run: st.run.id, payload: { reason: "Evaluate and Challenge disagree on f1" } },
  ]);
  expect((await s.command(id, "rule_conflict", { conflict: "k9", follow: "evaluate", note: "" }))).toEqual({ status: 409, body: { ok: false, refused: ["there is no conflict k9"] } });
  const r = await s.command(id, "rule_conflict", { conflict: "k1", follow: "evaluate", note: "the card shows it" });
  expect(r.status).toBe(200);
  await s.app.hub.idle();
  const after = s.entries(id);
  const ruled = after.find((e) => e.type === "review.ruled")!;
  expect(ruled.actor).toEqual({ kind: "human", id: s.config.user });
  expect(ruled.payload).toEqual({ conflict: "k1", follow: "evaluate", note: "the card shows it" });
  expect(after.slice(after.indexOf(ruled)).some((e) => e.type === "run.resumed" && e.actor.kind === "human")).toBe(true);
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
});

test("rule_conflict on a ruled conflict records the new ruling in the server's name", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  const session = s.app.hub.read(id);
  const d = session.state.drafts.at(-1)!;
  const engine = { kind: "system", id: "engine" } as const;
  session.commit((st, ids) => [{ type: "review.conflict", actor: engine, run: st.run.id, payload: { conflict: {
    id: ids.next("conflict"), draft_hash: d.hash, finding: "f1", change: "likelihood", earlier: "almost certain", now: "likely", raised_by: "evaluate", changed_for: "challenge",
    asks: "almost certain", asked: "lower", points: ["f1: x"], reason: "Evaluate and Challenge disagree on f1",
  } } }]);
  expect((await s.command(id, "rule_conflict", { conflict: "k1", follow: "challenge", note: "" })).status).toBe(200);
  await s.app.hub.idle();
  expect(await s.command(id, "rule_conflict", { conflict: "k1", follow: "challenge", note: "" })).toEqual({ status: 409, body: { ok: false, refused: ["that is already the ruling on k1"] } });
  expect((await s.command(id, "rule_conflict", { conflict: "k1", follow: "evaluate", note: "the card shows it" })).status).toBe(200);
  await s.app.hub.idle();
  const after = s.entries(id);
  const ruled = after.filter((e) => e.type === "review.ruled");
  expect(ruled.map((e) => [e.actor, e.payload])).toEqual([
    [{ kind: "human", id: s.config.user }, { conflict: "k1", follow: "challenge", note: "" }],
    [{ kind: "human", id: s.config.user }, { conflict: "k1", follow: "evaluate", note: "the card shows it" }],
  ]);
  const state = s.app.hub.read(id).state;
  expect(state.conflicts.k1!.earlier_rulings).toHaveLength(1);
  // revised at the publish gate: nothing went back by itself (slice 10); send_back_changes sends it, in the server's name, and the server drives the run on
  expect(after.slice(after.indexOf(ruled[0]!)).filter((e) => e.type === "stage.sent_back").length).toBe(0);
  expect(state.run.waiting).toBe("publish");
  expect((await s.command(id, "send_back_changes", { draft_hash: d.hash })).status).toBe(200);
  await s.app.hub.idle();
  const all = s.entries(id);
  const back = all.filter((e) => e.type === "stage.sent_back");
  expect(back.at(-1)!.actor).toEqual({ kind: "human", id: s.config.user });
  expect(back.at(-1)!.payload).toMatchObject({ from: "publish", to: "assemble", reason: "the person revised the ruling on f1 (Evaluate and Challenge disagree on f1): follow Evaluate: almost certain. Note: the card shows it" });
  // (the sample's script has no more Assemble turns, so the analyst's call is answered with an error and the run pauses there)
  expect(all.slice(all.indexOf(back.at(-1)!)).some((e) => e.type === "model.request" && e.actor.kind === "agent" && e.actor.id === "analyst")).toBe(true);
  // a second press finds the run off the gate
  expect(await s.command(id, "send_back_changes", { draft_hash: d.hash })).toEqual({ status: 409, body: { ok: false, refused: ["the run is not waiting at the publish gate"] } });
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
});

test("a requester may not rule on a conflict", async () => {
  s = await served({ role: "requester" });
  const id = s.app.hub.create({ title: "T", asked: "A", why: "W", starting: [], window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, objective: null, marking: "TLP:GREEN" }, { kind: "human", id: "x" }).id;
  expect(await s.command(id, "rule_conflict", { conflict: "k1", follow: null, note: "n" })).toEqual({ status: 403, body: { ok: false, refused: ["the requester view may not do rule conflict"] } });
});
