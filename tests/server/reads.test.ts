import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Actor } from "../../src/core/types";
import type { Me, ModelView, Reference, CaseSummaryView } from "../../src/core/wire";
import { startStandin } from "../helpers/http-standin";
import { served, writeLocalModel } from "../helpers/served";
import type { Served } from "../helpers/served";
import { writeTriage } from "../helpers/loop-files";

let s: Served;
let standin: ReturnType<typeof startStandin> | undefined;
afterEach(async () => { await s?.close(); standin?.stop(); standin = undefined; });

test("a source is described without where it is or how to sign in", async () => {
  s = await served({ credential: { name: "SAMPLE_PLANTED_SECRET", value: "planted-secret-value-91d7" } });
  const text = await (await s.get("/api/reference")).text();
  for (const banned of ["planted-secret-value-91d7", "SAMPLE_PLANTED_SECRET", "127.0.0.1:", s.dir, "flows.sqlite"]) expect(text).not.toContain(banned);
  expect(Object.keys(JSON.parse(text).sources[0]).sort()).toEqual(["adhoc", "confirmed", "connector", "cost", "id", "marking", "quality", "title", "where"]);
});

test("the reference holds types, sources, pivots, objectives, phases and the profile", async () => {
  s = await served();
  const ref = (await (await s.get("/api/reference")).json()) as Reference;
  expect(ref.types.map((t) => t.id)).toContain("address");
  expect(ref.sources.map((x) => x.id)).toContain("flows");
  const pivot = ref.pivots.find((p) => p.id === "address_to_verdict")!;
  expect(pivot).toEqual({ id: "address_to_verdict", title: "Reputation verdict for the address", from: "address", to: "verdict", source: "reputation", free: false, weight: 5, needs_window: false, empty_means: "not-seen", inventory: null });
  expect(ref.pivots.find((p) => p.id === "address_to_peers" || p.id === "address_to_internal_peers")!.free).toBe(true);
  const objective = ref.objectives.find((o) => o.id === "sample-objective")!;
  expect(objective.measures).toContainEqual({ id: "queries_run", kind: "mop", title: "Queries run" });
  expect(objective.measures).toContainEqual({ id: "time_saved", kind: "moe", title: "Hours saved against doing it by hand" });
  expect(ref.phases.map((p) => p.id)).toContain("direction");
  expect(ref.profile.id).toBe("investigation");
});

test("the reference lists the standard's likelihood terms, least likely first", async () => {
  s = await served();
  const ref = (await (await s.get("/api/reference")).json()) as Reference;
  expect(ref.likelihood).toEqual(["almost no chance", "very unlikely", "unlikely", "roughly even chance", "likely", "very likely", "almost certain"]);
});

test("/api/me says who, in which role, at which origin, and the policy", async () => {
  s = await served();
  const me = (await (await s.get("/api/me")).json()) as Me;
  expect(me).toMatchObject({ user: s.config.user, role: "analyst", origin: s.origin, policy: s.config.marking_policy });
  expect(me.markings).toEqual(["TLP:CLEAR", "TLP:GREEN", "TLP:AMBER", "TLP:AMBER+STRICT", "TLP:RED"]);
  expect(me.problems).toEqual([]);
});

test("GET /api/me names the store folder and the on-complete default", async () => {
  s = await served();
  const me = (await (await s.get("/api/me")).json()) as Me;
  expect(me.cases).toEqual({ store: join(s.dir, "wb", "store"), on_complete: "keep" });
  // the other views are told the folder's name, not where it is
  const r = await served({ role: "requester" });
  try {
    expect(((await (await r.get("/api/me")).json()) as Me).cases).toEqual({ store: "store", on_complete: "keep" });
  } finally {
    await r.close();
  }
});

const broken = (root: string): void => writeFileSync(join(root, "sources", "broken.yaml"), "kind: source\nid: broken\ntitle: Broken\nconnector: files\nlocation: /srv/private-lake/broken\nmarking: TLP:BOGUS\nwhere: machine\n");

test("manifest problems reach the analyst with the path relative to its module root, never absolute", async () => {
  s = await served({ before: broken });
  expect(s.problems.length).toBeGreaterThan(0);
  expect(s.problems.join("\n")).toContain(s.dir);
  // the store folder is the one path the analyst is shown (it is theirs to open); every other field is checked for paths
  const text = JSON.stringify({ ...((await (await s.get("/api/me")).json()) as Me), cases: null });
  expect(text).not.toContain(s.dir);
  expect(text).not.toContain("private-lake");
  const problems = (JSON.parse(text) as Me).problems;
  expect(problems.length).toBe(s.problems.length);
  expect(problems.some((p) => p.startsWith("sources/broken.yaml: "))).toBe(true);
  for (const p of problems) expect(p.startsWith("/")).toBe(false);
});

test("the requester and leader views get problems with no path at all", async () => {
  for (const role of ["requester", "leader"] as const) {
    s = await served({ role, before: broken });
    const text = await (await s.get("/api/me")).text();
    const problems = (JSON.parse(text) as Me).problems;
    expect(problems).toEqual(s.problems.map(() => "a module could not be loaded"));
    expect(text).not.toContain("broken.yaml");
    expect(text).not.toContain(s.dir);
    await s.close();
  }
});

test("models are marked allowed or not for the case's marking", async () => {
  standin = startStandin({ "GET /v1/models": () => Response.json({ data: [{ id: "big-hosted" }] }), "GET /api/v0/models": () => new Response("no", { status: 404 }) });
  s = await served({ before: (root) => writeLocalModel(root, "cloud", "hosted", `${standin!.url}/v1`) });
  const id = await s.newCase({ marking: "TLP:RED" });
  const views = (await (await s.get(`/api/cases/${id}/models`)).json()) as ModelView[];
  expect(views.find((m) => m.where === "hosted")).toMatchObject({ provider: "cloud", model: "big-hosted", allowed: false, reason: "TLP:RED may not go to a hosted model" });
  expect(views.find((m) => m.where === "machine")).toMatchObject({ provider: "scripted", allowed: true, reason: null });
  const green = await s.newCase({ marking: "TLP:CLEAR" });
  const open = (await (await s.get(`/api/cases/${green}/models`)).json()) as ModelView[];
  expect(open.find((m) => m.where === "hosted")).toMatchObject({ allowed: true, reason: null });
});

test("a provider that cannot list its models is left out", async () => {
  standin = startStandin({ "GET /v1/models": () => new Response("down", { status: 503 }) });
  s = await served({ before: (root) => writeLocalModel(root, "cloud", "hosted", `${standin!.url}/v1`) });
  const id = await s.newCase();
  const views = (await (await s.get(`/api/cases/${id}/models`)).json()) as ModelView[];
  expect(views.every((m) => m.provider !== "cloud")).toBe(true);
  expect(views.length).toBeGreaterThan(0);
});

test("creating a case writes case.created in the person's name and nothing else", async () => {
  s = await served();
  const chainBefore = s.wb.chain.head();
  const id = await s.newCase({ title: "A title" });
  expect(id).toMatch(/^CASE-[1-9]\d*$/);
  const entries = s.entries(id);
  expect(entries.map((e) => e.type)).toEqual(["case.created"]);
  expect(entries[0]!.actor).toEqual<Actor>({ kind: "human", id: s.config.user });
  expect(entries[0]!.payload).toMatchObject({ title: "A title", marking: "TLP:GREEN" });
  expect(s.wb.chain.head()).toEqual(chainBefore);
  const listed = (await (await s.get("/api/cases")).json()) as CaseSummaryView[];
  expect(listed.map((c) => c.id)).toEqual([id]);
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
});

const base = { title: "T", asked: "A", why: "W", starting: [{ type: "address", value: "198.51.100.77" }], window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, objective: null, marking: "TLP:GREEN" };
async function refused(over: Record<string, unknown>, reason?: string): Promise<void> {
  const before = s.wb.listCases().length;
  const res = await s.post("/api/cases", { ...base, ...over });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { ok: boolean; refused: string[] };
  expect(body.ok).toBe(false);
  expect(body.refused.length).toBeGreaterThan(0);
  if (reason !== undefined) expect(body.refused).toEqual([reason]);
  expect(s.wb.listCases().length).toBe(before);
}

test("a body that names an actor is refused", async () => {
  s = await served();
  await refused({ actor: { kind: "human", id: "someone" } }, "the server names the actor");
});
test("an unknown marking is refused", async () => { s = await served(); await refused({ marking: "TLP:PURPLE" }); });
test("a starting value that is not of its type is refused", async () => {
  s = await served();
  await refused({ starting: [{ type: "address", value: "not an address" }] });
  await refused({ starting: [{ type: "nonesuch", value: "198.51.100.77" }] });
  await refused({ starting: [{ type: "address" }] });
});
test("an unknown objective is refused", async () => { s = await served(); await refused({ objective: "no-such-objective" }); });
test("a window that is not two UTC millisecond timestamps in order is refused", async () => {
  s = await served();
  for (const window of [
    { from: "2026-11-17", to: "2026-11-24T00:00:00.000Z" }, { from: "2026-11-17T00:00:00Z", to: "2026-11-24T00:00:00.000Z" },
    { from: "2026-11-24T00:00:00.000Z", to: "2026-11-17T00:00:00.000Z" }, { from: null, to: null }, { from: "2026-02-31T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" },
    "yesterday", null,
  ]) await refused({ window });
});
test("a body that is not an object, not JSON, or missing fields is refused", async () => {
  s = await served();
  for (const body of ["[]", "null", "42", "{"]) {
    const res = await s.post("/api/cases", body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  }
  await refused({ title: 7 });
  await refused({ asked: undefined });
});
test("a valid body with an objective in the registry is accepted", async () => {
  s = await served();
  expect((await s.post("/api/cases", { ...base, objective: "sample-objective" })).status).toBe(200);
});

test("reads write nothing: the case head and the workbench chain head are unchanged after every GET", async () => {
  s = await served();
  const id = await s.newCase();
  const headBefore = s.app.hub.read(id).head();
  const chainBefore = s.wb.chain.head();
  const entriesBefore = s.entries(id).length;
  for (const path of ["/", "/app.js", "/app.css", "/api/me", "/api/cases", "/api/reference", `/api/cases/${id}/models`]) expect((await s.get(path)).status).toBe(200);
  const stream = await s.get(`/api/cases/${id}/entries`);
  expect(stream.status).toBe(200);
  await stream.body!.cancel();
  expect((await s.get("/api/cases/CASE-99/models")).status).toBe(404);
  expect(s.app.hub.read(id).head()).toEqual(headBefore);
  expect(s.wb.chain.head()).toEqual(chainBefore);
  expect(s.entries(id).length).toBe(entriesBefore);
});

test("an unknown case is 404", async () => {
  s = await served();
  for (const path of ["/api/cases/CASE-99/models", "/api/cases/CASE-99/entries", "/api/cases/nonsense/models"]) {
    const res = await s.get(path);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  }
});

test("an unexpected failure is 500 with a scrubbed first line, and goes to onError", async () => {
  s = await served();
  const id = await s.newCase();
  const spy = s.app.hub as unknown as { read: (id: string) => unknown };
  spy.read = () => { throw new Error(`boom at ${s.dir}/secret\nstack line`); };
  const res = await s.get(`/api/cases/${id}/models`);
  expect(res.status).toBe(500);
  const text = await res.text();
  expect(text).toContain("the server failed: ");
  expect(text).not.toContain(s.dir);
  expect(text).not.toContain("stack line");
});

test("a case's reads take its own loop: the agent of a triage case has no Assemble model, and reading writes nothing", async () => {
  s = await served({ before: writeTriage });
  const triage = await s.newCase({ loop: "triage" });
  const plain = await s.newCase();
  const head = s.app.hub.read(triage).head();
  const agent = async (id: string): Promise<{ model: unknown }> => (await (await s.get(`/api/cases/${id}/agent`)).json()) as { model: unknown };
  expect((await agent(triage)).model).toBeNull();
  expect((await agent(plain)).model).toMatchObject({ provider: "scripted", model: "sample-run" });
  expect((await s.get(`/api/cases/${triage}/models`)).status).toBe(200);
  expect((await s.get(`/api/cases/${triage}/preview`)).status).toBe(200);
  expect(s.app.hub.read(triage).head()).toEqual(head);
});

test("/api/me names the default loop as the configuration has it, so the page hard-codes no loop's id (Task 13)", async () => {
  s = await served();
  const me = (await (await s.get("/api/me")).json()) as Me;
  expect(me.loops).toEqual({ default: s.config.loops.default });
});

test("the reference lists the tool names a stage may give and the models the loops' stages name, for the loop forms (Task 13)", async () => {
  s = await served();
  const ref = (await (await s.get("/api/reference")).json()) as Reference;
  expect(ref.stage_tools).toContain("run_query");
  expect(ref.stage_tools).toContain("ask_person");
  expect(new Set(ref.stage_tools).size).toBe(ref.stage_tools.length);
  expect(ref.stage_models).toContainEqual({ provider: "scripted", model: "sample-run", effort: null });
  expect(new Set(ref.stage_models.map((m) => JSON.stringify(m))).size).toBe(ref.stage_models.length);
});

test("the reference lists no case type when no root loads one, and the case list says a case with none has type null", async () => {
  s = await served();
  const ref = (await (await s.get("/api/reference")).json()) as Reference;
  expect(ref.case_types).toEqual([]);
  await s.newCase();
  expect(((await (await s.get("/api/cases")).json()) as CaseSummaryView[]).map((c) => c.type)).toEqual([null]);
});
