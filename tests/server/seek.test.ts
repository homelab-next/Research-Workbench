import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Difference, RouteView } from "../../src/core/wire";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served;
const cases: string[] = [];
afterEach(async () => {
  try {
    for (const id of cases) expect(s.app.hub.read(id).state.skipped).toEqual([]);
  } finally {
    cases.length = 0;
    await s?.close();
  }
});
const state = (id: string) => s.app.hub.read(id).state;
const open = async (): Promise<string> => {
  s = await served();
  const id = await s.newCase();
  cases.push(id);
  return id;
};
const routes = async (q: string): Promise<RouteView[]> => {
  const res = await s.get(`/api/routes?${q}`);
  expect(res.status).toBe(200);
  return (await res.json()) as RouteView[];
};
const route = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  have: [SAMPLE_START], want: "account", window: SAMPLE_WINDOW, why: "who is behind it", max_weight: null, allow_unconfirmed: false, ...over,
});

test("routes are listed cheapest first without contacting a source or writing an entry", async () => {
  const id = await open();
  const before = s.entries(id).length;
  const pool = s.app.hub.deps.runner.pool;
  const real = pool.for.bind(pool);
  let contacts = 0;
  pool.for = (...a: Parameters<typeof real>) => { contacts++; return real(...a); };
  const list = await routes("have=address&want=account");
  expect(list.length).toBeGreaterThan(1);
  expect(list.map((r) => r.weight)).toEqual([...list.map((r) => r.weight)].sort((a, b) => a - b));
  expect(list[0]!.hops.at(-1)!.to).toBe("account");
  expect(list[0]!.hops[0]).toMatchObject({ from: "address", source_title: expect.any(String), title: expect.any(String), free: true, needs_window: expect.any(Boolean), empty_means: expect.any(String), confirmed: true });
  expect(JSON.stringify(list)).not.toContain(s.dir);
  expect(contacts).toBe(0);
  expect(s.entries(id).length).toBe(before);
  pool.for = real;
});

test("unconfirmed sources and the cost limit change which routes are offered", async () => {
  await open();
  const sure = await routes("have=address&want=asset");
  const all = await routes("have=address&want=asset&unconfirmed=1");
  expect(all.length).toBeGreaterThanOrEqual(sure.length);
  expect(all.some((r) => r.hops.some((h) => !h.confirmed))).toBe(true);
  expect(sure.some((r) => r.hops.some((h) => !h.confirmed))).toBe(false);
  expect((await routes("have=address&want=verdict")).length).toBeGreaterThan(0);
  expect(await routes("have=address&want=verdict&max_weight=0")).toEqual([]);
  expect((await routes("have=address&want=verdict&max_weight=5")).every((r) => r.weight <= 5)).toBe(true);
  expect((await routes("have=address&want=verdict&max_weight=5")).length).toBeGreaterThan(0);
});

test("a route read with an unknown type or a bad limit is refused", async () => {
  await open();
  for (const q of ["have=nonsense&want=account", "have=address&want=nonsense", "want=account", "have=address", "have=address&want=account&max_weight=-1", "have=address&want=account&max_weight=x", "have=address&want=account&unconfirmed=2"]) {
    expect([q, (await s.get(`/api/routes?${q}`)).status]).toEqual([q, 400]);
  }
});

test("a route runs as a job in the person's name; its lookups carry the job and it ends in route.finished", async () => {
  const id = await open();
  const r = await s.command(id, "run_route", route());
  expect(r.status).toBe(200);
  const started = s.entries(id).findLast((e) => e.type === "job.started")!;
  expect(started.payload).toMatchObject({ title: "Route to Account from 198.51.100.77", kind: "query", source: null });
  await s.app.hub.idle();
  const done = s.entries(id).findLast((e) => e.type === "route.finished")!;
  expect(done.type === "route.finished" && done.payload.outcome).toBe("answered");
  expect(done.job).toBe(done.type === "route.finished" ? done.payload.job : "");
  const job = done.job!;
  const mine = s.entries(id).filter((e) => e.type === "query.issued" && e.job === job);
  expect(mine.length).toBeGreaterThan(1);
  expect(mine.every((e) => e.actor.kind === "human")).toBe(true);
  expect(state(id).jobs[job]!.status).toBe("done");
  expect(s.entries(id).at(-1)!.type).toBe("job.finished");
  expect(state(id).run.status).toBe("none");
});

test("a route re-routes around a dead end, and the lookups that ran show it", async () => {
  const id = await open();
  await s.command(id, "run_route", route());
  await s.app.hub.idle();
  const done = s.entries(id).findLast((e) => e.type === "route.finished")!;
  const queries = s.entries(id).filter((e) => e.type === "query.result" && e.job === done.job).map((e) => (e.type === "query.result" ? state(id).queries[e.payload.query]! : null)!);
  expect(queries.some((q) => q.rows === 0)).toBe(true);   // the asset list does not hold the address
  expect(queries.some((q) => (q.rows ?? 0) > 0)).toBe(true);
  expect(done.type === "route.finished" && done.payload.reached.map((o) => o.value)).toContain("j.doe");
});

test("a costly lookup with no budget is refused with its estimate; with a budget it runs", async () => {
  const id = await open();
  const base = { pivot: "address_to_verdict", value: SAMPLE_START.value, window: SAMPLE_WINDOW, why: "see the verdict" };
  const no = await s.command(id, "run_pivot", base);
  expect(no.status).toBe(409);
  expect(JSON.stringify(no.body)).toContain("this lookup is costly: the estimate is 1 lookups; give a budget");
  expect(s.entries(id).some((e) => e.type === "query.issued")).toBe(false);
  const yes = await s.command(id, "run_pivot", { ...base, budget: 3 });
  expect(yes.status).toBe(200);
  const issued = s.entries(id).filter((e) => e.type === "query.issued");
  expect(issued.length).toBe(1);
  expect(issued[0]!.actor).toEqual({ kind: "human", id: s.config.user });
  expect(Object.values(state(id).cards).length).toBe(1);
});

test("run_pivot refuses an unknown pivot, a value of the wrong type and no why, and writes nothing", async () => {
  const id = await open();
  const before = s.entries(id).length;
  for (const args of [
    { pivot: "nope", value: "x", window: SAMPLE_WINDOW, why: "w" },
    { pivot: "address_to_internal_peers", value: "not an address", window: SAMPLE_WINDOW, why: "w" },
    { pivot: "address_to_internal_peers", value: SAMPLE_START.value, window: SAMPLE_WINDOW, why: "   " },
    { pivot: "address_to_verdict", value: SAMPLE_START.value, window: SAMPLE_WINDOW, why: "w", budget: 0 },
  ]) expect([JSON.stringify(args), (await s.command(id, "run_pivot", args)).status]).toEqual([JSON.stringify(args), 409]);
  expect(s.entries(id).length).toBe(before);
});

test("a free pivot runs in the person's name and makes a card", async () => {
  const id = await open();
  const r = await s.command(id, "run_pivot", { pivot: "address_to_internal_peers", value: SAMPLE_START.value, window: SAMPLE_WINDOW, why: "who talked to it" });
  expect(r.status).toBe(200);
  expect(Object.values(state(id).cards).length).toBe(1);
  expect(state(id).queries.q1!.by).toEqual({ kind: "human", id: s.config.user });
});

test("run_route with no why is refused and writes nothing", async () => {
  const id = await open();
  const before = s.entries(id).length;
  for (const bad of [{ why: "   " }, { why: "" }, { have: [{ type: "address", value: "nope" }] }, { want: "nonsense" }, { have: [{ type: "nonsense", value: "x" }] }, { max_weight: -2 }, { window: { from: "yesterday", to: null } }]) {
    const r = await s.command(id, "run_route", route(bad));
    expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 409]);
  }
  expect((await s.command(id, "run_route", route({ have: [] }))).status).toBe(400);   // the schema wants at least one value
  await s.app.hub.idle();
  expect(s.entries(id).length).toBe(before);
});

test("a route that throws ends its job as failed", async () => {
  const id = await open();
  const reg = s.app.hub.deps.runner.registry;
  const real = reg.pivot.bind(reg);
  reg.pivot = () => { throw new Error("the registry broke"); };
  await s.command(id, "run_route", route());
  await s.app.hub.idle();
  reg.pivot = real;
  const job = s.entries(id).findLast((e) => e.type === "job.started")!.job!;
  expect(state(id).jobs[job]!.status).toBe("failed");
  expect(s.entries(id).some((e) => e.type === "route.finished")).toBe(false);
});

test("verify_card records verify.run and returns", async () => {
  const id = await open();
  await s.command(id, "run_pivot", { pivot: "address_to_asset", value: "192.0.2.17", window: SAMPLE_WINDOW, why: "its asset" });
  const card = Object.keys(state(id).cards)[0]!;
  expect((await s.command(id, "verify_card", { card })).status).toBe(200);
  await s.app.hub.idle();
  const run = s.entries(id).findLast((e) => e.type === "verify.run")!;
  expect(run.payload).toMatchObject({ card, outcome: "matches" });
  expect(run.actor).toEqual({ kind: "human", id: s.config.user });
  expect(state(id).cards[card]!.validated).toMatchObject({ outcome: "matches" });
  expect((await s.command(id, "verify_card", { card: "c99" })).status).toBe(409);
  expect((await s.command(id, "verify_card", { card, budget: -1 })).status).toBe(409);
});

test("the difference route gives rows for a card that differs and a reason otherwise", async () => {
  const id = await open();
  await s.command(id, "run_pivot", { pivot: "address_to_asset", value: "192.0.2.17", window: SAMPLE_WINDOW, why: "its asset" });
  const card = Object.keys(state(id).cards)[0]!;
  const diff = async (): Promise<Difference | { reason: string }> => {
    const res = await s.get(`/api/cases/${id}/cards/${card}/difference`);
    expect(res.status).toBe(200);
    return (await res.json()) as Difference | { reason: string };
  };
  expect(await diff()).toEqual({ reason: "this card has no difference to show" });
  await s.command(id, "verify_card", { card });
  await s.app.hub.idle();
  expect(await diff()).toEqual({ reason: "this card has no difference to show" });
  const csv = join(s.dir, "sample", "data", "assets.csv");
  writeFileSync(csv, readFileSync(csv, "utf8").replace("ws-17.example.net,192.0.2.17", "ws-99.example.net,192.0.2.17"));
  await s.command(id, "verify_card", { card });
  await s.app.hub.idle();
  const d = await diff();
  if ("reason" in d) throw new Error(d.reason);
  expect(d.removed.length).toBe(1);
  expect(d.added).toEqual([["ws-99.example.net"]]);
  expect(d.same).toBe(0);
  expect((await s.get(`/api/cases/${id}/cards/c99/difference`)).status).toBe(200);
  expect((await s.get(`/api/cases/CASE-99/cards/${card}/difference`)).status).toBe(404);
});

test("the other views may read neither routes nor a difference, and do no pivot, route or verify", async () => {
  s = await served({ role: "requester" });
  expect((await s.get("/api/routes?have=address&want=account")).status).toBe(403);
  expect((await s.get("/api/cases/CASE-1/cards/c1/difference")).status).toBe(403);
  for (const name of ["run_route", "run_pivot", "verify_card"]) expect([name, (await s.command("CASE-1", name, {})).status]).toEqual([name, 403]);
});
