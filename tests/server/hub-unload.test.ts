import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CaseSummaryView, Me } from "../../src/core/wire";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";
import { storedEntries } from "../helpers/stored";

let s: Served;
afterEach(async () => { await s?.close(); });

const FILE = "CASE-1.TLP-GREEN.tar.gz";
const store = (): string => join(s.dir, "wb", "store");
const listed = async (): Promise<CaseSummaryView[]> => (await (await s.get("/api/cases")).json()) as CaseSummaryView[];
const me = async (): Promise<Me> => (await (await s.get("/api/me")).json()) as Me;
const chainSettings = (): unknown[] => s.wb.chain.read().filter((e) => e.type === "setting.changed").map((e) => ({ payload: e.payload, actor: e.actor }));

test("POST /api/settings saves cases.on_complete to the configuration file, changes /api/me, and records setting.changed on the workbench chain in the person's name", async () => {
  s = await served();
  mkdirSync(dirname(s.config.write_path), { recursive: true });
  writeFileSync(s.config.write_path, "user: analyst # who\ncases:\n  on_complete: keep # the default\n");
  const res = await s.post("/api/settings", { key: "cases.on_complete", value: "unload" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(readFileSync(s.config.write_path, "utf8")).toBe("user: analyst # who\ncases:\n  on_complete: unload # the default\n");
  expect((await me()).cases.on_complete).toBe("unload");
  expect(chainSettings()).toEqual([{ payload: { key: "cases.on_complete", value: "unload" }, actor: { kind: "human", id: s.config.user } }]);
  expect((await s.post("/api/settings", { key: "cases.on_complete", value: "keep" })).status).toBe(200);
  expect((await me()).cases.on_complete).toBe("keep");
  expect(chainSettings().length).toBe(2);
});

test("another key, another value, or a file that cannot be edited is refused and nothing changes", async () => {
  s = await served();
  const tries: [unknown, number][] = [
    [{ key: "cases.store", value: "unload" }, 400],
    [{ key: "cases.on_complete", value: "delete" }, 400],
    [{ key: "cases.on_complete", value: true }, 400],
    [{ key: "cases.on_complete" }, 400],
    [{ key: "cases.on_complete", value: "unload", actor: { kind: "human", id: "x" } }, 400],
    [{ key: "cases.on_complete", value: "unload", extra: 1 }, 400],
    [["cases.on_complete", "unload"], 400],
  ];
  for (const [body, status] of tries) expect((await s.post("/api/settings", body)).status).toBe(status);
  expect(existsSync(s.config.write_path)).toBe(false);
  // a flow-style cases block cannot be edited line by line
  mkdirSync(dirname(s.config.write_path), { recursive: true });
  const text = "cases: { on_complete: keep }\n";
  writeFileSync(s.config.write_path, text);
  const res = await s.post("/api/settings", { key: "cases.on_complete", value: "unload" });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { refused: string[] }).refused[0]).toContain("by hand");
  expect(readFileSync(s.config.write_path, "utf8")).toBe(text);
  expect((await me()).cases.on_complete).toBe("keep");
  expect(chainSettings()).toEqual([]);
});

test("approve with unload_after true publishes, and once the run has finished the case is unloaded by the workbench", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  expect((await s.command(id, "approve", { unload_after: true })).status).toBe(200);
  await s.app.hub.idle();
  expect(await listed()).toEqual([]);
  const types = (await storedEntries(join(store(), FILE)));
  expect(types.map((e) => e.type)).toContain("product.published");
  expect(types.map((e) => e.type)).toContain("run.finished");
  expect(types.at(-1)).toEqual({ type: "case.unloaded", actor: { kind: "system", id: "workbench" } });
});

test("approve without unload_after leaves the case loaded, whatever cases.on_complete says", async () => {
  s = await served({ config: { cases: { on_complete: "unload" } } });
  expect(s.config.cases.on_complete).toBe("unload");
  const id = await s.newCase();
  await s.toPublishGate(id);
  expect((await s.command(id, "approve")).status).toBe(200);
  await s.app.hub.idle();
  expect((await listed()).map((c) => c.id)).toEqual([id]);
  expect(s.app.hub.read(id).state.run).toMatchObject({ status: "finished", outcome: "published" });
  expect(existsSync(join(store(), FILE))).toBe(false);
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
});

test("when the unload after publishing fails, the case stays loaded with its product, the failure is recorded and listed, and nothing tries again", async () => {
  s = await served();
  writeFileSync(store(), "not a folder");
  const id = await s.newCase();
  await s.toPublishGate(id);
  expect((await s.command(id, "approve", { unload_after: true })).status).toBe(200);
  await s.app.hub.idle();
  const failed = (): number => s.entries(id).filter((e) => e.type === "case.unload_failed").length;
  expect(failed()).toBe(1);
  const [c] = await listed();
  expect(c!.id).toBe(id);
  expect(c!.unload_failed).toStartWith("the case file could not be written: ");
  const state = s.app.hub.read(id).state;
  expect(state.published.map((p) => p.n)).toEqual([1]);
  expect(state.archive.unload_after).toBe(false);
  expect(existsSync(join(s.dir, "wb", "cases", id, "published", "1"))).toBe(true);
  // recorded or refused with the engine's words: either way it is a further command on the case
  expect([200, 409]).toContain((await s.command(id, "feedback", { measure: "queries_run", value: 1, note: "n" })).status);
  expect((await s.command(id, "add_lane", { title: "x" })).status).toBe(200);
  await s.app.hub.idle();
  expect(failed()).toBe(1);
  expect(s.entries(id).filter((e) => e.type === "case.unloaded").length).toBe(1);
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
});

test("a run finished through resume is unloaded too", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  // the person approves, then pauses before the server has driven the run on
  const actor = { kind: "human" as const, id: s.config.user };
  s.app.hub.engine(id).approve({ actor, unload_after: true });
  expect((await s.command(id, "pause")).status).toBe(200);
  await s.app.hub.idle();
  expect(s.app.hub.read(id).state.run.status).toBe("paused");
  expect((await listed()).map((c) => c.id)).toEqual([id]);
  expect((await s.command(id, "resume")).status).toBe(200);
  await s.app.hub.idle();
  expect(await listed()).toEqual([]);
  const stored = await storedEntries(join(store(), FILE));
  expect(stored.at(-1)).toEqual({ type: "case.unloaded", actor: { kind: "system", id: "workbench" } });
});
