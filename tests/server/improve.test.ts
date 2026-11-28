// Slice 14, Task 17: the improve routes. POST /api/improve makes an improve case of the loop `improve` with the person's request and starts
// nothing; GET /api/cases/:id/improve is the improve view. Both are behind the guard and the role check, and the server names the person.
import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ImproveView, NewImproveInput } from "../../src/core/wire";
import { served, withImproveLoop } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served | undefined;
const extra: Served[] = [];
let errors: unknown[] = [];
afterEach(async () => {
  try {
    if (s !== undefined) for (const c of s.wb.listCases()) expect(`${c.id}: ${JSON.stringify(s.app.hub.read(c.id).state.skipped)}`).toBe(`${c.id}: []`);
    expect(errors).toEqual([]);
  } finally {
    await s?.close();
    for (const t of extra.splice(0)) await t.close();
    s = undefined;
    errors = [];
  }
});
const open = async (opts: { improve?: boolean; role?: "analyst" | "requester" | "leader" } = {}): Promise<Served> => {
  // with improve: false, the sample's own improve loop is taken out too
  const made = await served({ before: opts.improve === false ? (root) => rmSync(join(root, "loops", "improve.yaml")) : withImproveLoop, ...(opts.role === undefined ? {} : { role: opts.role }), onError: (e) => { errors.push(e); } });
  if (s === undefined) s = made; else extra.push(made);
  return made;
};

const INPUT: NewImproveInput = { loop: "investigation", case_type: "unknown-device", tasks: 2, candidates: 1, marking: "TLP:AMBER" };
const refusedOf = async (res: Response): Promise<string[]> => ((await res.json()) as { refused: string[] }).refused;

test("POST /api/improve makes an improve case of the improve loop with its request, of the case type, and starts nothing", async () => {
  const t = await open();
  const res = await t.post("/api/improve", INPUT);
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  const entries = t.entries(id);
  expect(entries[0]).toMatchObject({
    type: "case.created", actor: { kind: "human", id: t.config.user },
    payload: {
      title: "Improve investigation for unknown-device", asked: "Which change to loop investigation makes unknown-device cases more correct?",
      why: "an improve run the person asked for", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:AMBER",
    },
  });
  const requested = entries.filter((e) => e.type === "improve.requested");
  expect(requested.map((e) => [e.actor, e.payload])).toEqual([[{ kind: "human", id: t.config.user }, { target: "investigation", case_type: "unknown-device", tasks: 2, candidates: 1 }]]);
  const state = t.app.hub.read(id).state;
  expect(state.loop.id).toBe("improve");
  expect(state.memory.type).toBe("unknown-device");
  expect(state.improve.request).toMatchObject({ target: "investigation", case_type: "unknown-device", tasks: 2, candidates: 1 });
  // nothing is started: the client sends start
  expect(state.run.status).toBe("none");
  expect(entries.some((e) => e.type.startsWith("run.") || e.type.startsWith("stage."))).toBe(false);
  await t.app.hub.idle();
  expect(t.entries(id).length).toBe(entries.length);
});

test("each refusal of createImprove is a 409 with its sentence, and no case is made", async () => {
  const t = await open();
  const cases = (): number => t.wb.listCases().length;
  const refusal = async (over: Partial<NewImproveInput>, s2: Served = t): Promise<string[]> => {
    const before = s2.wb.listCases().length;
    const res = await s2.post("/api/improve", { ...INPUT, ...over });
    expect(res.status).toBe(409);
    expect(s2.wb.listCases().length).toBe(before);
    return refusedOf(res);
  };
  expect((await refusal({ loop: "nope" }))[0]).toStartWith("there is no usable loop nope: ");
  expect(await refusal({ loop: "improve" })).toEqual(["an improve loop is not improved by an improve loop"]);
  expect(await refusal({ case_type: "printer" })).toEqual(["there is no case type printer"]);
  expect(await refusal({ tasks: 0 })).toEqual(["an improve run takes 1 to 3 tasks"]);
  expect(await refusal({ tasks: 4 })).toEqual(["an improve run takes 1 to 3 tasks"]);
  expect(await refusal({ candidates: 0 })).toEqual(["an improve run takes 1 to 3 candidates"]);
  expect(await refusal({ candidates: 4 })).toEqual(["an improve run takes 1 to 3 candidates"]);
  expect(cases()).toBe(0);
  // a workbench with no improve loop
  const bare = await open({ improve: false });
  expect((await refusal({}, bare))[0]).toStartWith("there is no usable improve loop here: ");
  expect(bare.wb.listCases().length).toBe(0);
});

test("a body with an actor, or a field it should not have, is refused", async () => {
  const t = await open();
  const bad = async (body: unknown): Promise<string[]> => {
    const res = await t.post("/api/improve", body);
    expect(res.status).toBe(400);
    return refusedOf(res);
  };
  expect(await bad({ ...INPUT, actor: { kind: "human", id: "someone-else" } })).toEqual(["the server names the actor"]);
  expect(await bad({ ...INPUT, start: true })).toEqual(["the body has a field it should not have: start"]);
  expect((await bad({ ...INPUT, tasks: "2" })).length).toBeGreaterThan(0);
  expect((await bad({ ...INPUT, tasks: 1.5 })).length).toBeGreaterThan(0);
  expect((await bad({ ...INPUT, marking: "TLP:PINK" })).length).toBeGreaterThan(0);
  const { case_type: _c, ...missing } = INPUT;
  expect((await bad(missing)).length).toBeGreaterThan(0);
  expect(await bad([INPUT])).toEqual(["the body must be a JSON object"]);
  expect(t.wb.listCases().length).toBe(0);
});

test("GET /api/cases/:id/improve of a case with no request is a view with request null", async () => {
  const t = await open();
  const id = await t.newCase();
  const res = await t.get(`/api/cases/${id}/improve`);
  expect(res.status).toBe(200);
  expect((await res.json()) as ImproveView).toEqual({ request: null, selected: null, candidates: [], probes: [], chosen: null, scores: null, lessons: [], adopt: null });
  // an improve case just made: its request and nothing of a run
  const made = (await (await t.post("/api/improve", INPUT)).json()) as { id: string };
  const view = (await (await t.get(`/api/cases/${made.id}/improve`)).json()) as ImproveView;
  expect(view).toEqual({ request: { target: "investigation", case_type: "unknown-device", tasks: 2, candidates: 1 }, selected: null, candidates: [], probes: [], chosen: null, scores: null, lessons: [], adopt: null });
  expect((await t.get("/api/cases/CASE-404/improve")).status).toBe(404);
});

// Ruling (the dispatch): a known answer and what is made from it are the analyst's alone, so only the analyst's view reads an improve view.
test("a view that is not the analyst's may not read an improve view, create an improve case or decide at Adopt", async () => {
  const t = await open();
  const made = (await (await t.post("/api/improve", INPUT)).json()) as { id: string };
  expect((await t.get(`/api/cases/${made.id}/improve`)).status).toBe(200);
  for (const role of ["requester", "leader"] as const) {
    const r = await open({ role });
    const view = await r.get("/api/cases/CASE-1/improve");
    expect(view.status).toBe(403);
    expect(await refusedOf(view)).toEqual([`the ${role} view may not read improve`]);
    const create = await r.post("/api/improve", INPUT);
    expect(create.status).toBe(403);
    expect(await refusedOf(create)).toEqual([`the ${role} view may not do create improve`]);
    for (const [command, args] of [["adopt_decide", { change: "chg-1", accept: true }], ["set_known_answer", { product: 1, text: "x", findings: [], marking: "TLP:RED" }], ["withdraw_known_answer", { product: 1, reason: "x" }]] as const) {
      const res = await r.command("CASE-1", command, args);
      expect(`${command}: ${res.status}`).toBe(`${command}: 403`);
    }
    expect(r.wb.listCases().length).toBe(0);
  }
});

test("both routes are behind the Host and Origin guard", async () => {
  const t = await open();
  const made = (await (await t.post("/api/improve", INPUT)).json()) as { id: string };
  const host = new URL(t.origin).host;
  const ask = (path: string, headers: Record<string, string>, init: RequestInit = {}): Promise<Response> => t.app.handle(new Request(`${t.origin}${path}`, { ...init, headers }));
  const view = `/api/cases/${made.id}/improve`;
  const post = (headers: Record<string, string>): Promise<Response> => ask("/api/improve", headers, { method: "POST", body: JSON.stringify(INPUT) });
  expect((await ask(view, { host: "evil.example:4747" })).status).toBe(421);
  expect((await ask(view, { host, origin: "https://example.net" })).status).toBe(403);
  expect((await ask(view, { host, "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await post({ host: "evil.example:4747", origin: t.origin, "content-type": "application/json" })).status).toBe(421);
  expect((await post({ host, "content-type": "application/json" })).status).toBe(403);
  expect((await post({ host, origin: "https://example.net", "content-type": "application/json" })).status).toBe(403);
  expect((await post({ host, origin: t.origin, "content-type": "text/plain" })).status).toBe(403);
  expect((await post({ host, origin: t.origin, "content-type": "application/json", "sec-fetch-site": "cross-site" })).status).toBe(403);
  // a refusal of the route itself is JSON
  const r = await ask("/api/improve", { host, origin: t.origin, "content-type": "application/json" }, { method: "POST", body: "{}" });
  expect(r.status).toBe(400);
  expect(r.headers.get("content-type") ?? "").toContain("application/json");
  expect(t.wb.listCases().map((c) => c.id)).toEqual([made.id]);
  expect((await ask(view, { host, origin: t.origin })).status).toBe(200);
});
