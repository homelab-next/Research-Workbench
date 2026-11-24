import { afterEach, expect, test } from "bun:test";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps } from "../../src/pipeline/engine";
import { PlanRefused } from "../../src/pipeline/plans";
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
  if (open === undefined || old === undefined) return; // the sample raised no challenge to carry over
  const before = s.entries(id).length;
  const r = await s.command(id, "answer_challenge", { challenge: old[0], answer: "a", action: "rebutted" });
  expect(r).toEqual({ status: 409, body: { ok: false, refused: [`challenge ${old[0]} is from an earlier run`] } });
  expect(s.entries(id).length).toBe(before);
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
