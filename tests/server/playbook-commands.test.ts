import { afterEach, expect, test } from "bun:test";
import type { Reference } from "../../src/core/wire";
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
const open = async (opts?: Parameters<typeof served>[0]): Promise<string> => {
  s = await served(opts);
  const id = await s.newCase();
  cases.push(id);
  return id;
};
const start = (over: Record<string, unknown> = {}) => ({ playbook: "address-triage", inputs: [SAMPLE_START], window: SAMPLE_WINDOW, why: "first look", ...over });

/** Holds every connector's `run` until `release()` is called, so a playbook is provably mid-run. */
const held = () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const pool = s.app.hub.deps.runner.pool;
  const real = pool.for.bind(pool);
  let started = 0;
  pool.for = ((...a: Parameters<typeof real>) => {
    const c = real(...a);
    const run = c.run.bind(c);
    c.run = (async (...b: Parameters<typeof run>) => { started++; await gate; return run(...b); }) as typeof c.run;
    return c;
  }) as typeof real;
  return { release: () => { release(); pool.for = real; }, started: () => started };
};

test("the reference lists the sample playbook with what it takes and how much it can ask", async () => {
  await open();
  const ref = (await (await s.get("/api/reference")).json()) as Reference;
  expect(ref.playbooks).toEqual([expect.objectContaining({ id: "address-triage", free: true, max_lookups: 8, inputs: [{ name: "address", type: "address" }] })]);
});

test("run_playbook returns while the first lookup is still held, then the job finishes with cards", async () => {
  const id = await open();
  const gate = held();
  const r = await s.command(id, "run_playbook", start());
  expect(r.status).toBe(200);
  const job = Object.values(state(id).jobs).at(-1)!;
  expect(job).toMatchObject({ kind: "playbook", status: "running" });
  expect(s.entries(id).filter((e) => e.type === "query.result")).toEqual([]);
  expect(s.entries(id).some((e) => e.type === "playbook.started" && e.payload.job === job.id)).toBe(true);
  gate.release(); await s.app.hub.idle();
  expect(state(id).jobs[job.id]!.status).toBe("done");
  expect(state(id).playbooks[job.id]!.cards.length).toBeGreaterThan(0);
  expect(s.entries(id).filter((e) => e.type === "model.request")).toEqual([]);
});

test("a second start on the same value is refused while the first is running, and no lookup is sent twice", async () => {
  const id = await open();
  const gate = held();
  expect((await s.command(id, "run_playbook", start())).status).toBe(200);
  const again = await s.command(id, "run_playbook", start());
  expect(again.status).toBe(409);
  expect(again.body).toEqual({ ok: false, refused: ["this playbook is already running on this value"] });
  expect((await s.command(id, "run_playbook", start({ inputs: [{ type: "address", value: "192.0.2.17" }] }))).status).toBe(200);
  gate.release(); await s.app.hub.idle();
  const sent = s.entries(id).flatMap((e) => (e.type === "query.issued" ? [`${e.payload.pivot}|${JSON.stringify(e.payload.bound)}`] : []));
  expect(new Set(sent).size).toBe(sent.length);
  expect((await s.command(id, "run_playbook", start())).status).toBe(200);
  await s.app.hub.idle();
});

test("an unknown playbook, a wrong value, an extra value, an open window and a blank reason are each refused with nothing written", async () => {
  const id = await open();
  const n = s.entries(id).length;
  const bad: Record<string, unknown>[] = [
    start({ playbook: "no-such" }),
    start({ inputs: [{ type: "address", value: "not an address" }] }),
    start({ inputs: [SAMPLE_START, { type: "account", value: "x" }] }),
    start({ window: { from: null, to: null } }),
    start({ why: "   " }),
  ];
  for (const b of bad) {
    const r = await s.command(id, "run_playbook", b);
    expect([b, r.status]).toEqual([b, 409]);
    expect(s.entries(id).length).toBe(n);
  }
});

test("a requester may not run a playbook", async () => {
  s = await served({ role: "requester" });
  expect((await s.command("CASE-1", "run_playbook", start())).status).toBe(403);
});
