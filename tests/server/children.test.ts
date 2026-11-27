import { afterEach, expect, test } from "bun:test";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Entry } from "../../src/core/types";
import type { AgentView, LoopView, ModelView, Preview } from "../../src/core/wire";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";
import { writeTriage } from "../helpers/loop-files";

let s: Served | undefined;
let errors: unknown[] = [];
afterEach(async () => {
  if (s !== undefined) for (const c of s.wb.listCases()) expect(s.app.hub.read(c.id).state.skipped).toEqual([]);
  await s?.close();
  s = undefined;
  expect(errors).toEqual([]);
  errors = [];
});

const GATES = new Set(["gate.passed", "plan.accepted", "product.published"]);
const open = async (): Promise<Served> => (s = await served({ before: writeTriage, onError: (e) => { errors.push(e); } }));
const ofType = (id: string, type: string): Entry[] => s!.entries(id).filter((e) => e.type === type);
const last = (id: string): Entry => s!.entries(id).at(-1)!;

/** A triage case, started; the server drives it until it waits on its child. Returns the parent's and the child's ids. */
async function startParent(): Promise<{ parent: string; child: string }> {
  const parent = await s!.newCase({ loop: "triage" });
  const r = await s!.command(parent, "start_run");
  if (r.status !== 200) throw new Error(`start_run failed: ${JSON.stringify(r)}`);
  await s!.app.hub.idle();
  const started = ofType(parent, "subloop.started");
  if (started.length !== 1) throw new Error(`the parent started ${started.length} children`);
  return { parent, child: (started[0]!.payload as { child: string }).child };
}
/** The child's gates, passed by the person through the server: the only commands sent after the parent's start_run. */
async function passChildGates(child: string): Promise<void> {
  expect((await s!.command(child, "accept_plan", { budgets: { s3: 1 } })).status).toBe(200);
  await s!.app.hub.idle();
  expect((await s!.command(child, "approve")).status).toBe(200);
  await s!.app.hub.idle();
}

test("starting the parent makes the child, and the parent's stream ends its turn with run.paused: waiting on child CASE-2", async () => {
  s = await open();
  const { parent, child } = await startParent();
  expect(child).toBe("CASE-2");
  const paused = last(parent);
  expect(paused.type).toBe("run.paused");
  expect((paused.payload as { reason: string }).reason).toStartWith("waiting on child CASE-2: ");
  expect(s.app.hub.read(parent).state.run.hold).toEqual({ kind: "child", stage: "investigate", child: "CASE-2" });
  expect(s.app.hub.read(child).state.run.waiting).toBe("plan");
  expect(s.app.hub.read(child).state.loop.parent).toMatchObject({ case: parent, stage: "investigate", attempt: 1 });
  // the stream a screen reads says the same, ending on that pause
  const ac = new AbortController();
  const res = await s.app.handle(new Request(`${s.origin}/api/cases/${parent}/entries?after=0`, { headers: { host: new URL(s.origin).host }, signal: ac.signal }));
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("waiting on child CASE-2")) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  ac.abort();
  await reader.cancel().catch(() => undefined);
  const types = [...text.matchAll(/"type":"([a-z_.]+)"/g)].map((m) => m[1]);
  expect(types.at(-1)).toBe("run.paused");
});

test("accept_plan and approve on the child are the only commands sent; after each the parent goes on by itself and finishes once the child has published", async () => {
  s = await open();
  const { parent, child } = await startParent();
  const personBefore = s.entries(parent).filter((e) => e.actor.kind === "human").length;
  expect((await s.command(child, "accept_plan", { budgets: { s3: 1 } })).status).toBe(200);
  await s.app.hub.idle();
  // the child now waits at its publish gate, and the parent says so by itself
  expect(s.app.hub.read(child).state.run.waiting).toBe("publish");
  const pausedNow = s.app.hub.read(parent).state.run;
  expect(pausedNow.status).toBe("paused");
  expect(pausedNow.pause_reason).toStartWith("waiting on child CASE-2: ");
  expect(ofType(parent, "run.paused").length).toBe(2);
  expect((await s.command(child, "approve")).status).toBe(200);
  await s.app.hub.idle();
  expect(s.app.hub.read(child).state.run).toMatchObject({ status: "finished", outcome: "published" });
  expect(s.app.hub.read(parent).state.run).toMatchObject({ status: "finished", outcome: "completed" });
  expect(ofType(parent, "subloop.finished").map((e) => e.payload)).toMatchObject([{ stage: "investigate", attempt: 1, child, outcome: "published" }]);
  const returned = ofType(parent, "card.created").filter((e) => (e.payload as { card: { from?: unknown } }).card.from !== undefined);
  expect(returned.length).toBeGreaterThan(0);
  for (const e of returned) expect((e.payload as { card: { from: { case: string } } }).card.from.case).toBe(child);
  // no command was sent to the parent after start_run: nothing in its ledger since is a person's
  expect(s.entries(parent).filter((e) => e.actor.kind === "human").length).toBe(personBefore);
});

test("the parent's run.resumed entries after a child settled are by the engine, and no gate.passed in either ledger is by anything but the person", async () => {
  s = await open();
  const { parent, child } = await startParent();
  await passChildGates(child);
  const resumed = ofType(parent, "run.resumed");
  expect(resumed.length).toBe(2);
  for (const e of resumed) expect(e.actor).toEqual({ kind: "system", id: "engine" });
  for (const id of [parent, child]) for (const e of s.entries(id).filter((x) => GATES.has(x.type))) expect(e.actor).toEqual({ kind: "human", id: s.config.user });
  expect(s.entries(parent).some((e) => GATES.has(e.type))).toBe(false);
  expect(s.entries(child).filter((e) => e.type === "gate.passed").length).toBe(2);
});

test("a child whose parent was unloaded settles without an error, and loading the parent and resuming it picks the child up", async () => {
  s = await open();
  const { parent, child } = await startParent();
  const unloaded = await s.post(`/api/cases/${parent}/unload`, {});
  expect(unloaded.status).toBe(200);
  const { file } = (await unloaded.json()) as { file: string };
  expect(s.wb.listCases().map((c) => c.id)).toEqual([child]);
  await passChildGates(child);
  expect(s.app.hub.read(child).state.run).toMatchObject({ status: "finished", outcome: "published" });
  const loaded = await s.post("/api/store/load", { file });
  expect(loaded.status).toBe(200);
  expect(((await loaded.json()) as { id: string }).id).toBe(parent);
  expect(s.app.hub.read(parent).state.run.status).toBe("paused");
  expect((await s.command(parent, "resume")).status).toBe(200);
  await s.app.hub.idle();
  expect(s.app.hub.read(parent).state.run).toMatchObject({ status: "finished", outcome: "completed" });
  expect(ofType(parent, "subloop.finished").length).toBe(1);
  expect(ofType(parent, "subloop.started").length).toBe(1);
});

test("loop.output is on the workbench chain once the child published: the product, with its marking and the child's head", async () => {
  s = await open();
  const { child } = await startParent();
  const outputs = () => s!.wb.chain.read().filter((e) => e.type === "loop.output");
  expect((await s.command(child, "accept_plan", { budgets: { s3: 1 } })).status).toBe(200);
  await s.app.hub.idle();
  expect(outputs()).toEqual([]);
  expect((await s.command(child, "approve")).status).toBe(200);
  await s.app.hub.idle();
  const product = outputs().find((e) => (e.payload as { case: string; output: string }).case === child && (e.payload as { output: string }).output === "product")!;
  expect(product).toBeDefined();
  const p = product.payload as { loop: string; outcome: string; marking: string; head: { seq: number; hash: string }; hash: string; value: { blob: string }; run: string };
  expect(p).toMatchObject({ loop: "investigation", outcome: "published" });
  expect(product.actor).toEqual({ kind: "system", id: "engine" });
  const state = s.app.hub.read(child).state;
  const published = state.drafts.find((d) => d.hash === state.published.at(-1)!.draft_hash)!.product;
  expect(JSON.parse(s.wb.chainBlobs.text(p.value.blob))).toEqual(published);
  expect(p.marking).toBe(published.marking);
  const at = s.entries(child).find((e) => e.seq === p.head.seq)!;
  expect(at.hash).toBe(p.head.hash);
  expect(s.entries(child).slice(0, p.head.seq).some((e) => e.type === "run.finished")).toBe(true);
  // the parent's run, which completed, gives the outputs its loop declares too
  expect(outputs().some((e) => (e.payload as { loop: string; outcome: string }).loop === "triage" && (e.payload as { outcome: string }).outcome === "completed")).toBe(true);
});

test("your agent, the preview and the models of a child read the child's own loop version", async () => {
  s = await open();
  const { parent, child } = await startParent();
  const get = async <T>(path: string): Promise<T> => {
    const res = await s!.get(path);
    if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  // the child is of the investigation loop, whose Assemble names the model your agent uses; the parent's triage has no Assemble
  expect((await get<AgentView>(`/api/cases/${child}/agent`)).model).toMatchObject({ provider: "scripted", model: "sample-run" });
  expect((await get<AgentView>(`/api/cases/${parent}/agent`)).model).toBeNull();
  // a new version of investigation, whose Assemble names another model, is saved while the child runs on version 1
  const draft = (await get<LoopView>("/api/loops/investigation")).draft as unknown as { stages: Record<string, unknown>[] };
  draft.stages.find((x) => x.id === "assemble")!.model = { provider: "scripted", model: "not-listed", effort: null };
  const saved = await s.post("/api/loops/investigation/save", { draft, version: 1 });
  expect(saved.status).toBe(200);
  const fresh = await s.newCase();
  expect((await get<AgentView>(`/api/cases/${fresh}/agent`)).model).toBeNull();
  expect((await get<AgentView>(`/api/cases/${child}/agent`)).model).toMatchObject({ provider: "scripted", model: "sample-run" });
  // the child's publish stage and models are its version's
  expect((await s.command(child, "accept_plan", { budgets: { s3: 1 } })).status).toBe(200);
  await s.app.hub.idle();
  const preview = await get<Preview>(`/api/cases/${child}/preview`);
  expect("manifest" in preview).toBe(true);
  const models = await get<ModelView[]>(`/api/cases/${child}/models`);
  expect(models.some((m) => m.provider === "scripted" && m.model === "sample-run")).toBe(true);
  expect(ofType(child, "loop.bound").map((e) => (e.payload as { version: number }).version)).toEqual([1]);
  expect(ofType(child, "run.paused")).toEqual([]);
});

test("a parent loaded without its child, on a workbench whose own case has the child's id, neither drives nor reads that case: it pauses saying the child is not loaded", async () => {
  // workbench A: two cases, then a triage parent CASE-3 whose child is CASE-4, waiting at its plan gate; the parent alone is unloaded
  s = await open();
  await s.newCase();
  await s.newCase();
  const { parent, child } = await startParent();
  expect([parent, child]).toEqual(["CASE-3", "CASE-4"]);
  const started = ofType(parent, "subloop.started")[0]!.payload as { origin?: string };
  expect(started.origin).toBe(s.entries(child)[0]!.hash);
  const unloaded = await s.post(`/api/cases/${parent}/unload`, {});
  expect(unloaded.status).toBe(200);
  const { file } = (await unloaded.json()) as { file: string };
  const bErrors: unknown[] = [];
  const b = await served({ before: writeTriage, onError: (e) => { bErrors.push(e); } });
  try {
    // workbench B: four cases of its own; its CASE-3 is unloaded and deleted, so the id is free; its CASE-4 is no child of anything
    for (let i = 1; i <= 4; i++) await b.newCase({ title: `B's own case ${i}`, marking: "TLP:AMBER" });
    expect((await b.post("/api/cases/CASE-3/unload", {})).status).toBe(200);
    const f3 = readdirSync(b.config.cases.store).find((f) => f.startsWith("CASE-3."))!;
    expect((await b.post("/api/store/delete", { file: f3, id: "CASE-3" })).status).toBe(200);
    copyFileSync(join(s.config.cases.store, file), join(b.config.cases.store, file));
    expect((await b.post("/api/store/load", { file })).status).toBe(200);
    const theirs = b.entries("CASE-4").length;
    expect((await b.command("CASE-3", "resume")).status).toBe(200);
    await b.app.hub.idle();
    // B's own CASE-4 is untouched: no run, no entry
    expect(b.entries("CASE-4").length).toBe(theirs);
    expect(b.app.hub.read("CASE-4").state.run.status).toBe("none");
    const run = b.app.hub.read("CASE-3").state.run;
    expect(run.status).toBe("paused");
    expect(run.pause_reason).toBe("waiting on child CASE-4: child CASE-4 is not loaded; load it from the store");
    expect(b.entries("CASE-3").some((e) => e.type === "subloop.finished")).toBe(false);
    for (const c of b.wb.listCases()) expect(b.app.hub.read(c.id).state.skipped).toEqual([]);
  } finally {
    await b.close();
  }
  expect(bErrors).toEqual([]);
});
