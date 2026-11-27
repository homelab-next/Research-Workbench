import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest } from "../../src/core/casefile";
import type { CaseSummaryView, StoreView } from "../../src/core/wire";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps } from "../../src/pipeline/engine";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";
import { storedEntries } from "../helpers/stored";
import { rawCaseFile } from "../helpers/tar";

let s: Served;
afterEach(async () => { await s?.close(); });

const FILE = "CASE-1.TLP-GREEN.tar.gz";
const unload = (id: string, body: unknown = {}): Promise<Response> => s.post(`/api/cases/${id}/unload`, body);
const listed = async (): Promise<CaseSummaryView[]> => (await (await s.get("/api/cases")).json()) as CaseSummaryView[];
const store = (): string => join(s.dir, "wb", "store");
const storeFiles = (): string[] => (existsSync(store()) ? readdirSync(store()).sort() : []);

test("POST /api/cases/CASE-1/unload unloads the case in the server's name: the list no longer has it, and its reads are 404", async () => {
  s = await served();
  const id = await s.newCase();
  expect(id).toBe("CASE-1");
  const res = await unload(id);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, file: FILE });
  expect(await listed()).toEqual([]);
  expect((await s.get("/api/cases/CASE-1/custody")).status).toBe(404);
  expect((await s.get("/api/cases/CASE-1/entries")).status).toBe(404);
  const stored = await storedEntries(join(store(), FILE));
  expect(stored.at(-1)).toEqual({ type: "case.unloaded", actor: { kind: "human", id: s.config.user } });
});

test("a body that names an actor, or has any other field, is refused and nothing is unloaded", async () => {
  s = await served();
  const id = await s.newCase();
  const actor = await unload(id, { actor: { kind: "system", id: "workbench" } });
  expect(actor.status).toBe(400);
  expect(await actor.json()).toEqual({ ok: false, refused: ["the server names the actor"] });
  const other = await unload(id, { to: "/tmp/elsewhere" });
  expect(other.status).toBe(400);
  expect(await other.json()).toEqual({ ok: false, refused: ["the body has a field it should not have: to"] });
  const list = await unload(id, []);
  expect(list.status).toBe(400);
  expect((await listed()).map((c) => c.id)).toEqual([id]);
  expect(storeFiles()).toEqual([]);
  expect(s.entries(id).map((e) => e.type)).toEqual(["case.created"]);
});

test("unload while a run is running is 409 with the reason, and the case stays", async () => {
  s = await served();
  const id = await s.newCase();
  // a run that is running and not driven: the state alone says running
  const deps = (s.app.hub as unknown as { deps: EngineDeps }).deps;
  new Engine(s.wb.session(id), deps).start({ kind: "human", id: s.config.user });
  const before = s.entries(id).length;
  const res = await unload(id);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ ok: false, refused: ["a run is running; pause or stop it first"] });
  expect((await listed()).map((c) => c.id)).toEqual([id]);
  expect(s.entries(id).length).toBe(before);
  expect(storeFiles()).toEqual([]);
});

test("unload while the server is still driving the case is refused, even when the state no longer says running", async () => {
  s = await served();
  const id = await s.newCase();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  s.app.hub.follow(id, held);
  expect(s.app.hub.read(id).state.run.status).not.toBe("running");
  const res = await unload(id);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ ok: false, refused: ["the workbench is still working on this case"] });
  expect((await listed()).map((c) => c.id)).toEqual([id]);
  release();
  await s.app.hub.idle();
  expect((await unload(id)).status).toBe(200);
});

test("an unload that fails after it began is 409 with the reason, the case is still listed with unload_failed, and its commands still work", async () => {
  s = await served();
  const id = await s.newCase();
  // the store is a file, so the case file cannot be written there
  writeFileSync(store(), "not a folder");
  const res = await unload(id);
  expect(res.status).toBe(409);
  const body = (await res.json()) as { ok: false; refused: string[] };
  expect(body.ok).toBe(false);
  expect(body.refused[0]).toStartWith("the case file could not be written: ");
  const [c] = await listed();
  expect(c!.id).toBe(id);
  expect(c!.unload_failed).toBe(body.refused[0]!);
  expect(s.entries(id).map((e) => e.type)).toEqual(["case.created", "case.unloaded", "case.unload_failed"]);
  const r = await s.command(id, "add_lane", { title: "x" });
  expect(r.status).toBe(200);
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
});

test("an unknown case is 404", async () => {
  s = await served();
  expect((await unload("CASE-7")).status).toBe(404);
  expect((await unload("nonsense")).status).toBe(404);
});

test("GET /api/store lists the store from each file's case.json, says which are loaded, and filters with search", async () => {
  s = await served();
  const one = await s.newCase({ title: "First", starting: [{ type: "address", value: "192.0.2.10" }] });
  const two = await s.newCase({ title: "Second", starting: [{ type: "address", value: "203.0.113.20" }] });
  expect((await unload(one)).status).toBe(200);
  expect((await unload(two)).status).toBe(200);
  expect((await s.post("/api/store/load", { file: "CASE-2.TLP-GREEN.tar.gz" })).status).toBe(200);
  const res = await s.get("/api/store");
  expect(res.status).toBe(200);
  const view = (await res.json()) as StoreView;
  expect(view.store).toBe(store());
  expect(view.unreadable).toEqual([]);
  expect(view.leftovers).toBe(0);
  expect(view.cases.map((c) => [c.id, c.loaded]).sort()).toEqual([["CASE-1", false], ["CASE-2", true]]);
  const first = view.cases.find((c) => c.id === "CASE-1")!;
  const m = await readManifest(join(store(), FILE));
  expect(first).toEqual({
    file: FILE, bytes: first.bytes, id: "CASE-1", title: "First", asked: m.asked, marking: "TLP:GREEN", starting: [{ type: "address", value: "192.0.2.10" }],
    status: m.status, outcome: null, published: 0, head: m.head.hash, entries: m.entries, unloaded_ts: m.unloaded_ts, workbench: m.workbench, loaded: false,
  });
  expect(first.bytes).toBeGreaterThan(0);
  const found = (await (await s.get("/api/store?search=203.0.113")).json()) as StoreView;
  expect(found.cases.map((c) => c.id)).toEqual(["CASE-2"]);
  const none = (await (await s.get("/api/store?search=zzz")).json()) as StoreView;
  expect(none.cases).toEqual([]);
});

test("POST /api/store/load loads a file by its name and the case is listed again, paused where it was", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPlanGate(id);
  const run = s.app.hub.read(id).state.run;
  expect(run.status).toBe("waiting");
  expect((await unload(id)).status).toBe(200);
  expect(await listed()).toEqual([]);
  const res = await s.post("/api/store/load", { file: FILE });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, id });
  expect((await listed()).map((c) => c.id)).toEqual([id]);
  const state = s.app.hub.read(id).state;
  expect(state.run).toEqual(run);
  expect(state.skipped).toEqual([]);
  const last = s.entries(id).at(-1)!;
  expect(last.type).toBe("case.loaded");
  expect(last.actor).toEqual({ kind: "human", id: s.config.user });
  // the run goes on from the gate it was waiting at
  expect((await s.command(id, "accept_plan", { budgets: { s3: 1 } })).status).toBe(200);
  await s.app.hub.idle();
  expect(s.app.hub.read(id).state.run).toMatchObject({ status: "waiting", waiting: "publish" });
});

test("a file name with a separator, a leading dot or another extension is refused before the store is read", async () => {
  s = await served();
  // the store is a file: reading it would fail differently
  writeFileSync(store(), "not a folder");
  for (const file of ["../x.tar.gz", "a/CASE-1.TLP-GREEN.tar.gz", ".CASE-1.tar.gz", "CASE-1.TLP-GREEN.zip", "", 7, null]) {
    const res = await s.post("/api/store/load", { file });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, refused: ["file must be a case file's name"] });
  }
  const extra = await s.post("/api/store/load", { file: FILE, actor: { kind: "human", id: "x" } });
  expect(extra.status).toBe(400);
  expect(await listed()).toEqual([]);
});

test("loading a file that fails its check is 409 with the reason and the list is unchanged", async () => {
  s = await served();
  const id = await s.newCase();
  expect((await unload(id)).status).toBe(200);
  const m = await readManifest(join(store(), FILE));
  rawCaseFile(join(store(), FILE), [{ name: "case.json", body: JSON.stringify(m) }, { name: "ledger.sqlite", type: "2", link: "/etc/passwd" }]);
  const res = await s.post("/api/store/load", { file: FILE });
  expect(res.status).toBe(409);
  const body = (await res.json()) as { refused: string[] };
  expect(body.refused[0]).toContain("link");
  expect(await listed()).toEqual([]);
  expect(readdirSync(join(s.dir, "wb", "cases")).filter((n) => !n.startsWith(".high-water"))).toEqual([]);
  const missing = await s.post("/api/store/load", { file: "CASE-9.TLP-GREEN.tar.gz" });
  expect(missing.status).toBe(409);
});

test("POST /api/store/delete without the id, or with another id, deletes nothing: the server refuses it", async () => {
  s = await served();
  const id = await s.newCase();
  expect((await unload(id)).status).toBe(200);
  const none = await s.post("/api/store/delete", { file: FILE });
  expect(none.status).toBe(400);
  expect(await none.json()).toEqual({ ok: false, refused: ["id must be text"] });
  const other = await s.post("/api/store/delete", { file: FILE, id: "CASE-9" });
  expect(other.status).toBe(409);
  expect(await other.json()).toEqual({ ok: false, refused: ["type CASE-1 to delete its file"] });
  const bad = await s.post("/api/store/delete", { file: "../x.tar.gz", id: "CASE-1" });
  expect(bad.status).toBe(400);
  expect(storeFiles()).toEqual([FILE]);
  expect(existsSync(join(store(), "deleted.log"))).toBe(false);
});

test("delete with the id typed removes the file and logs one line naming the person", async () => {
  s = await served();
  const id = await s.newCase({ title: "To delete" });
  expect((await unload(id)).status).toBe(200);
  const m = await readManifest(join(store(), FILE));
  const res = await s.post("/api/store/delete", { file: FILE, id: "CASE-1" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(storeFiles()).toEqual(["deleted.log"]);
  const lines = readFileSync(join(store(), "deleted.log"), "utf8").split("\n").filter((l) => l !== "");
  expect(lines.length).toBe(1);
  const line = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(line).toEqual({ id: "CASE-1", title: "To delete", head: m.head.hash, when: expect.any(String), who: s.config.user, file: FILE });
  // the id is not given out again
  expect(await s.newCase()).toBe("CASE-2");
});
