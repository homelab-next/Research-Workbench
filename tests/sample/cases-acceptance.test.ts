import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { cases } from "../../src/cli/cases";
import { readManifest } from "../../src/core/casefile";
import { fold } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Entry } from "../../src/core/types";
import { verifyCase } from "../../src/core/verify";
import { CaseRefused } from "../../src/core/workbench";
import type { CaseSummaryView, StoreView } from "../../src/core/wire";
import { cleanEnv } from "../helpers/clean-env";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

// Slice 11's acceptance: a whole sample case on the scripted model goes to the case store and back with its record intact, is followed up,
// moves between two workbenches through a file, survives a stop in the middle of an unload, and never lets an id be given twice.
const REPO = join(import.meta.dir, "..", "..");
const VERIFY = join(REPO, "src", "cli", "verify.ts");
const STOPPER = join(REPO, "tests", "helpers", "unload-stopper.ts");
const FILE = "CASE-1.TLP-GREEN.tar.gz";

const open: Served[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fresh = (): string => { const d = mkdtempSync(join(tmpdir(), "cases-acceptance-")); dirs.push(d); return d; };

type Turn = { actor: string; reply: Record<string, unknown> };
/**
 * The sample's script, with a second run after it: the orchestrator and planner as before, each researcher answering from what the case
 * already holds (so no card is made twice and every title stays unique), and the analyst restating draft 2 with a change from product 1.
 * Evaluate, Challenge and Publish use the sample's own turns that the first run leaves unused.
 */
function withFollowUp(root: string): void {
  const f = join(root, "scripts", "sample-run.yaml");
  const body = Bun.YAML.parse(readFileSync(f, "utf8")) as { turns: Turn[] };
  const of = (actor: string): Turn[] => body.turns.filter((t) => t.actor === actor).map((t) => structuredClone(t));
  const analyst = of("analyst");
  body.turns.push(
    ...of("orchestrator"), ...of("planner"),
    { actor: "researcher-g1", reply: { content: JSON.stringify({ outcome: "answered", found: [{ type: "account", value: "j.doe" }], note: "As the case already shows." }) } },
    { actor: "researcher-g2", reply: { content: JSON.stringify({ outcome: "answered", found: [{ type: "verdict", value: "suspicious" }], note: "As the case already shows." }) } },
    analyst[3]!, analyst[4]!,
    { actor: "analyst", reply: { content: JSON.stringify({ done: true, change_kind: "consistent with", change_detail: "product 1, on the same records", assumptions: ["The asset list is current."], note: "Follow-up draft." }) } },
  );
  writeFileSync(f, JSON.stringify(body, null, 1));
}

async function serve(opts: Parameters<typeof served>[0] = {}): Promise<Served> {
  const s = await served({ before: withFollowUp, ...opts });
  open.push(s);
  return s;
}
async function shut(s: Served): Promise<void> {
  open.splice(open.indexOf(s), 1);
  await s.close();
}

/** Every file under `dir`, by its path inside it. */
function filesOf(dir: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p); else out.set(relative(dir, p), new Uint8Array(readFileSync(p)));
    }
  };
  walk(dir);
  return out;
}

const caseDir = (s: Served, id: string): string => join(s.config.data_dir, "cases", id);
const storeDir = (s: Served): string => s.config.cases.store;
const listed = async (s: Served): Promise<string[]> => ((await (await s.get("/api/cases")).json()) as CaseSummaryView[]).map((c) => c.id);
const stored = async (s: Served): Promise<StoreView> => (await (await s.get("/api/store")).json()) as StoreView;
const state = (s: Served, id: string): CaseState => s.app.hub.read(id).state;
const unload = (s: Served, id: string): Promise<Response> => s.post(`/api/cases/${id}/unload`, {});
const load = (s: Served, file: string): Promise<Response> => s.post("/api/store/load", { file });
const refusal = async (r: Response): Promise<string> => ((await r.json()) as { refused: string[] }).refused.join("; ");

/** A new case run to published on the scripted model; the live state after each entry is kept. */
async function published(s: Served): Promise<{ id: string; live: Map<number, CaseState> }> {
  const id = await s.newCase();
  const live = new Map<number, CaseState>();
  s.app.hub.read(id).subscribe((e, st) => { live.set(e.seq, st as CaseState); });
  await s.toPublishGate(id);
  expect((await s.command(id, "approve")).status).toBe(200);
  await s.app.hub.idle();
  expect(state(s, id).run).toMatchObject({ status: "finished", outcome: "published" });
  return { id, live };
}

const verifyCommand = (dir: string, home: string): { code: number; out: string } => {
  const r = Bun.spawnSync(["bun", "run", VERIFY, dir], { cwd: REPO, timeout: 60_000, stdout: "pipe", stderr: "pipe", env: cleanEnv(home) });
  return { code: r.exitCode ?? -1, out: r.stdout.toString() };
};

test("a published case unloaded and loaded again verifies, replays exactly, and its product files are byte for byte what they were", async () => {
  const s = await serve();
  const { id, live } = await published(s);
  const product = filesOf(join(caseDir(s, id), "published", "1"));
  expect(product.size).toBeGreaterThan(0);
  const before = s.entries(id);

  const out = await unload(s, id);
  expect(out.status).toBe(200);
  expect(await out.json()).toEqual({ ok: true, file: FILE });
  expect(await listed(s)).toEqual([]);
  expect(existsSync(caseDir(s, id))).toBe(false);
  const inStore = (await stored(s)).cases;
  expect(inStore.map((c) => [c.id, c.file, c.loaded])).toEqual([[id, FILE, false]]);
  // the head the store records is case.unloaded, which names the head before it
  const unloaded = live.get(inStore[0]!.entries)!;
  expect(unloaded.archive.pending).not.toBeNull();
  expect(inStore[0]!.entries).toBe(before.length + 1);

  const back = await load(s, FILE);
  expect(back.status).toBe(200);
  expect(await back.json()).toEqual({ ok: true, id });
  expect(await listed(s)).toEqual([id]);
  const report = verifyCase(caseDir(s, id));
  expect(report.ok).toBe(true);
  expect(report.case).toBe(id);
  const entries = s.entries(id);
  // the chain is the one that was unloaded, byte for byte, and its head is the one the store recorded; case.loaded comes after it
  expect(entries.slice(0, before.length)).toEqual(before);
  expect(entries[before.length]!.type).toBe("case.unloaded");
  expect(entries[before.length]!.hash).toBe(inStore[0]!.head);
  expect(entries.at(-1)).toMatchObject({ type: "case.loaded", seq: before.length + 2, prev_hash: inStore[0]!.head, actor: { kind: "human", id: s.config.user } });
  expect(report.head).toBe(entries.at(-1)!.hash);
  expect(filesOf(join(caseDir(s, id), "published", "1"))).toEqual(product);
  // replay is exact: every prefix folds to the state the live session had after that entry
  // (from entry 2, the first after the case was made, to case.unloaded)
  expect([...live.keys()]).toEqual(Array.from({ length: before.length }, (_, i) => i + 2));
  for (const [n, st] of live) expect(fold(entries, n)).toEqual(st);
  const now = state(s, id);
  expect(now.skipped).toEqual([]);
  expect(now.archive).toMatchObject({ pending: null, failed: null, unloads: 1, loads: 1 });
  expect(now.run).toMatchObject({ status: "finished", outcome: "published" });
});

test("follow up: a new run in a loaded case publishes product 2, which states its change from product 1", async () => {
  const s = await serve();
  const id = await s.newCase();
  await s.toPublishGate(id);
  // approved with "Unload after publishing" ticked: once the run has finished the workbench unloads it
  expect((await s.command(id, "approve", { unload_after: true })).status).toBe(200);
  await s.app.hub.idle();
  expect(await listed(s)).toEqual([]);
  expect((await stored(s)).cases.map((c) => c.id)).toEqual([id]);
  const recorded = (await stored(s)).cases[0]!;

  expect((await load(s, FILE)).status).toBe(200);
  const report = verifyCase(caseDir(s, id));
  expect(report.ok).toBe(true);
  expect(s.entries(id).at(-1)!.prev_hash).toBe(recorded.head);
  expect(state(s, id).archive.unload_after).toBe(false);

  await s.toPublishGate(id);
  let st = state(s, id);
  expect(st.run.waiting).toBe("publish");
  expect(st.drafts.at(-1)!.product.change).toBe("Consistent with product 1, on the same records.");
  expect((await s.command(id, "approve", { unload_after: true })).status).toBe(200);
  await s.app.hub.idle();
  // product 2, published in the loaded case, then the case unloaded again
  expect(await listed(s)).toEqual([]);
  const again = (await stored(s)).cases[0]!;
  expect(again).toMatchObject({ id, file: FILE, published: 2, outcome: "published" });
  expect(again.entries).toBeGreaterThan(recorded.entries);
  expect((await load(s, FILE)).status).toBe(200);
  st = state(s, id);
  expect(st.published.map((p) => p.n)).toEqual([1, 2]);
  expect(readdirSync(join(caseDir(s, id), "published")).sort()).toEqual(["1", "2"]);
  const second = JSON.parse(readFileSync(join(caseDir(s, id), "published", "2", "product.json"), "utf8")) as { change: string };
  expect(second.change).toBe("Consistent with product 1, on the same records.");
  expect(verifyCase(caseDir(s, id)).ok).toBe(true);
  expect(st.archive).toMatchObject({ unloads: 2, loads: 2, unload_after: false });
  expect(st.skipped).toEqual([]);
}, 60_000);

test("the verify command passes on a loaded case and fails on a loaded case whose blob is then removed", async () => {
  const s = await serve();
  const { id } = await published(s);
  expect((await unload(s, id)).status).toBe(200);
  expect((await load(s, FILE)).status).toBe(200);
  const good = verifyCommand(caseDir(s, id), s.dir);
  expect(good.code).toBe(0);
  expect(good.out).toContain("chain intact");
  const blobs = [...filesOf(join(caseDir(s, id), "blobs")).keys()];
  expect(blobs.length).toBeGreaterThan(0);
  rmSync(join(caseDir(s, id), "blobs", blobs[0]!));
  expect(verifyCommand(caseDir(s, id), s.dir).code).toBe(1);
}, 60_000);

test("a case moves between two workbenches through a file and keeps its record: unload --to here, load there", async () => {
  const d = fresh();
  const here = join(d, "here"), there = join(d, "there"), carried = join(d, "carried");
  const configOf = (data: string): string => {
    const f = join(d, `${relative(d, data)}.yaml`);
    writeFileSync(f, [`data_dir: ${data}`, "user: analyst", "cases:", `  store: ${join(data, "store")}`, ""].join("\n"));
    return f;
  };
  const said: string[] = [];
  const io = { log: (l: string) => void said.push(l), error: (l: string) => void said.push(`error: ${l}`), readLine: async () => "" };

  // here: a published case; the server is stopped, then the command line unloads it to a folder that is not the store
  let s = await serve({ config: { data_dir: here } });
  const { id } = await published(s);
  const before = s.entries(id);
  const product = filesOf(join(caseDir(s, id), "published", "1"));
  await shut(s);
  expect(await cases(["unload", id, "--to", carried, "--config", configOf(here)], io)).toBe(0);
  expect(said.at(-1)).toStartWith(`unloaded ${id} to ${join(carried, FILE)}`);
  expect(existsSync(join(here, "cases", id))).toBe(false);
  expect(existsSync(join(here, "store", FILE))).toBe(false);

  // there: a workbench that has never seen the case loads it from that folder and keeps its id
  expect(await cases(["load", join(carried, FILE), "--config", configOf(there)], io)).toBe(0);
  expect(said.at(-1)).toBe(`loaded ${id} from ${join(carried, FILE)}`);
  s = await serve({ config: { data_dir: there } });
  expect(await listed(s)).toEqual([id]);
  const entries = s.entries(id);
  expect(entries.slice(0, before.length)).toEqual(before);
  expect(entries.slice(before.length).map((e) => [e.type, e.actor])).toEqual([
    ["case.unloaded", { kind: "human", id: "analyst" }], ["case.loaded", { kind: "human", id: "analyst" }],
  ]);
  expect(entries.at(-1)!.payload).toMatchObject({ file: FILE, id });
  expect(verifyCase(caseDir(s, id)).ok).toBe(true);
  expect(filesOf(join(caseDir(s, id), "published", "1"))).toEqual(product);
  expect(state(s, id).skipped).toEqual([]);
  // the id counter there goes past it
  expect(await s.newCase()).toBe("CASE-2");

  // a third workbench whose own CASE-1 is another case refuses the file, from a path and from its store, and writes nothing
  const third = await serve();
  expect(await third.newCase({ title: "Another case" })).toBe("CASE-1");
  const mine = third.entries("CASE-1");
  await expect(third.wb.loadCase(join(carried, FILE), { actor: { kind: "human", id: "analyst" } })).rejects.toThrow(CaseRefused);
  mkdirSync(storeDir(third), { recursive: true });
  copyFileSync(join(carried, FILE), join(storeDir(third), FILE));
  const r = await load(third, FILE);
  expect(r.status).toBe(409);
  expect(await refusal(r)).toContain("CASE-1 is taken here by another case");
  expect(third.entries("CASE-1")).toEqual(mine);
  expect(readdirSync(join(third.config.data_dir, "cases")).filter((n) => !n.startsWith(".high-water"))).toEqual(["CASE-1"]);
}, 60_000);

test("the whole sample run folds with nothing skipped after two round trips", async () => {
  const s = await serve();
  const { id, live } = await published(s);
  for (let i = 0; i < 2; i++) {
    expect((await unload(s, id)).status).toBe(200);
    expect((await load(s, FILE)).status).toBe(200);
  }
  const entries = s.entries(id);
  const folded = fold(entries);
  expect(folded.skipped).toEqual([]);
  expect(folded).toEqual(state(s, id));
  expect(entries.filter((e) => ["case.unloaded", "case.loaded", "case.unload_failed"].includes(e.type)).map((e) => e.type)).toEqual(["case.unloaded", "case.loaded", "case.unloaded", "case.loaded"]);
  expect(folded.archive).toMatchObject({ unloads: 2, loads: 2, pending: null, failed: null });
  for (const [n, st] of live) expect(fold(entries, n)).toEqual(st);
  expect(verifyCase(caseDir(s, id)).ok).toBe(true);
});

/** The stopper child: unloads CASE-1 of `data` and exits at `step`, as a crash would. */
function stopAt(data: string, store: string, step: string, home: string): number {
  const r = Bun.spawnSync(["bun", STOPPER, data, store, "CASE-1", step], { cwd: REPO, timeout: 60_000, stdout: "pipe", stderr: "pipe", env: cleanEnv(home) });
  return r.exitCode ?? -1;
}

test("a stop in the middle of an unload leaves the case loaded, recorded as a failed unload, and the next unload replaces the file", async () => {
  for (const step of ["write", "leave"] as const) {
    const d = fresh();
    const data = join(d, "wb");
    let s = await serve({ config: { data_dir: data } });
    const { id } = await published(s);
    const before = s.entries(id);
    const product = filesOf(join(caseDir(s, id), "published", "1"));
    await shut(s);

    expect(stopAt(data, join(data, "store"), step, d)).toBe(9);
    // the stop came before the commit point: the folder is whole, so the case is loaded
    expect(existsSync(join(data, "cases", id))).toBe(true);
    // at "leave" the store already holds a file one entry behind; at "write" it holds only the unfinished temporary file
    const files = existsSync(join(data, "store")) ? readdirSync(join(data, "store")) : [];
    expect(files.includes(FILE)).toBe(step === "leave");

    s = await serve({ config: { data_dir: data } });
    expect(await listed(s)).toEqual([id]);
    const entries = s.entries(id);
    expect(entries.slice(0, before.length)).toEqual(before);
    expect(entries.slice(before.length).map((e) => [e.type, e.actor])).toEqual([
      ["case.unloaded", { kind: "human", id: "analyst" }], ["case.unload_failed", { kind: "system", id: "recovery" }],
    ]);
    expect(entries.at(-1)!.payload).toEqual({ reason: "the workbench stopped before the case was unloaded" });
    expect(verifyCase(caseDir(s, id)).ok).toBe(true);
    expect(filesOf(join(caseDir(s, id), "published", "1"))).toEqual(product);
    expect(state(s, id).archive).toMatchObject({ pending: null, failed: { reason: "the workbench stopped before the case was unloaded" } });
    expect(state(s, id).skipped).toEqual([]);
    if (step === "leave") {
      const r = await load(s, FILE);
      expect(r.status).toBe(409);
      expect(await refusal(r)).toContain(`${id} is already loaded`);
      expect((await readManifest(join(data, "store", FILE))).entries).toBe(before.length + 1);
    }
    // the next unload goes through and its file holds the whole record, the stopped attempt included
    expect((await unload(s, id)).status).toBe(200);
    expect((await readManifest(join(data, "store", FILE))).entries).toBe(before.length + 3);
    expect(await listed(s)).toEqual([]);
    await shut(s);
  }
}, 120_000);

test("an id is never given twice: not after its case was unloaded, nor deleted from the store, nor while the store is unplugged", async () => {
  const s = await serve();
  expect(await s.newCase()).toBe("CASE-1");
  expect((await unload(s, "CASE-1")).status).toBe(200);
  expect(await s.newCase()).toBe("CASE-2");
  expect((await unload(s, "CASE-2")).status).toBe(200);
  const file2 = (await stored(s)).cases.find((c) => c.id === "CASE-2")!.file;
  // a delete is checked on the server: the wrong id typed deletes nothing
  expect((await s.post("/api/store/delete", { file: file2, id: "CASE-1" })).status).toBe(409);
  expect((await s.post("/api/store/delete", { file: file2, id: "CASE-2" })).status).toBe(200);
  expect((await stored(s)).cases.map((c) => c.id)).toEqual(["CASE-1"]);
  expect(await s.newCase()).toBe("CASE-3");
  expect((await unload(s, "CASE-3")).status).toBe(200);
  expect(await listed(s)).toEqual([]);
  // the store unplugged: its folder, its files and its deleted.log are gone, nothing is loaded, and still no id is given again
  const away = join(s.dir, "unplugged");
  renameSync(storeDir(s), away);
  expect(await s.newCase()).toBe("CASE-4");
  // plugged back in, CASE-1 loads under its own id, and the next id is past every one
  renameSync(away, storeDir(s));
  expect((await load(s, FILE)).status).toBe(200);
  expect(await s.newCase()).toBe("CASE-5");
  expect((await listed(s)).sort()).toEqual(["CASE-1", "CASE-4", "CASE-5"]);
  for (const id of await listed(s)) expect(state(s, id).skipped).toEqual([]);
  const types = (es: Entry[]): string[] => es.map((e) => e.type);
  expect(types(s.entries("CASE-1"))).toEqual(["case.created", "case.unloaded", "case.loaded"]);
});
