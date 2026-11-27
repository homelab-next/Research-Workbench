import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CaseSummaryView, LoopFileView, LoopSummaryView, LoopView } from "../../src/core/wire";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";
import { SCRIPTED, writeLoopFile, writeTriage } from "../helpers/loop-files";

let s: Served | undefined;
afterEach(async () => {
  if (s !== undefined) for (const c of s.wb.listCases()) expect(s.app.hub.read(c.id).state.skipped).toEqual([]);
  await s?.close();
  s = undefined;
});

const HEX64 = /^[0-9a-f]{64}$/;

const brokenLoop = (root: string): void => writeLoopFile(root, "broken", {
  stages: [{ id: "frame", title: "Frame", order: 1, runs: "agent", role: "frame", tools: [], schema: "no-such-schema", model: SCRIPTED, on_pass: null, on_fail: null }],
});
const getJson = async <T>(path: string): Promise<T> => {
  const res = await s!.get(path);
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
};

// ---------- reads ----------

test("GET /api/loops lists investigation with its title, about, nine stages, version 1 and its version-2 hash", async () => {
  s = await served();
  const loops = await getJson<LoopSummaryView[]>("/api/loops");
  const inv = loops.find((l) => l.id === "investigation")!;
  expect(inv).toMatchObject({ id: "investigation", title: "Investigation", version: 1, usable: true, problems: [], implicit: false, trusted: true });
  expect(inv.about).toContain("Frame a question");
  expect(inv.stages).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"]);
  expect(inv.hash).toMatch(HEX64);
  expect(inv.hash).toBe(s.app.hub.deps.loops!.current("investigation")!.pipeline.hash);
  // the version-2 hash, not the pre-slice formula
  expect(inv.hash).not.toBe(s.app.hub.deps.loops!.current("investigation")!.pipeline.legacy_hash!);
  expect(inv.root).toBe("sample");
});

test("GET /api/loops/investigation gives each stage's context, middleware and orchestration, every item with its source and hash", async () => {
  s = await served();
  const view = await getJson<LoopView>("/api/loops/investigation");
  expect(view.entry).toBe("frame");
  expect(view.profile).toBe("investigation");
  expect(view.caps).toEqual({ max_depth: 2, max_children: 8 });
  expect(view.stage_views.map((x) => x.id)).toEqual(view.stages);
  expect(view.draft).not.toBeNull();
  const research = view.stage_views.find((x) => x.id === "research")!;
  expect(research).toMatchObject({ title: "Research", runs: "agent", role: "research", gate: null, reviews: false, on_pass: "assemble", on_fail: "plan", inline: false });
  expect(research.hash).toMatch(HEX64);
  const has = (kind: string, id: string) => research.context.find((i) => i.kind === kind && i.id === id);
  expect(has("persona", "researcher")).toMatchObject({ source: "root" });
  expect(has("persona", "researcher")!.hash).toMatch(HEX64);
  for (const [kind, id] of [["rules", "base-rules"], ["procedure", "research-sop"], ["skill", "ask-the-person"], ["schema", "research-output"]] as const) {
    expect(has(kind, id)).toBeDefined();
    expect(has(kind, id)!.hash).toMatch(HEX64);
  }
  expect(research.context.some((i) => i.kind === "goal")).toBe(true);
  expect(research.orchestration.tools).toEqual(["find_routes", "run_step", "run_pivot", "run_query", "list_cards", "read_card", "ask_person"]);
  expect(research.orchestration.model).toEqual(SCRIPTED);
  expect(research.orchestration.subloop).toBeNull();
  expect(research.orchestration.send_back_cap).toBe(3);
  // the query guard and the marking policy are built in: no hash
  const builtIn = research.middleware.filter((i) => i.source === "built-in");
  expect(builtIn.map((i) => i.id).sort()).toEqual(["marking-policy", "query-guard"]);
  for (const i of builtIn) expect(i.hash).toBeNull();
  const checks = view.stage_views.find((x) => x.id === "checks")!;
  expect(checks.middleware.filter((i) => i.kind === "check").length).toBe(11);
  expect(checks.middleware.filter((i) => i.kind === "check-script").length).toBe(11);
  for (const i of checks.middleware.filter((x) => x.source !== "built-in")) expect(i.hash).toMatch(HEX64);
  // a review stage has the citation check, built in
  const reviewing = view.stage_views.filter((x) => x.reviews);
  expect(reviewing.length).toBeGreaterThan(0);
  for (const r of reviewing) expect(r.middleware.find((i) => i.id === "citation-check")).toMatchObject({ source: "built-in", hash: null });
});

test("a loop that is not usable is listed with its problems and usable false, and its view names no absolute path", async () => {
  s = await served({ before: brokenLoop });
  const listText = await (await s.get("/api/loops")).text();
  const broken = (JSON.parse(listText) as LoopSummaryView[]).find((l) => l.id === "broken")!;
  expect(broken.usable).toBe(false);
  expect(broken.hash).toBeNull();
  expect(broken.problems.join(" | ")).toContain('schema "no-such-schema" is not loaded');
  const viewText = await (await s.get("/api/loops/broken")).text();
  const view = JSON.parse(viewText) as LoopView;
  expect(view.usable).toBe(false);
  expect(view.draft).toBeNull();
  for (const text of [listText, viewText]) {
    expect(text).not.toContain(s.dir);
    expect(text).not.toContain("/tmp/");
  }
});

test("an unknown loop is 404; a requester may read neither loops nor loop files", async () => {
  s = await served();
  const res = await s.get("/api/loops/no-such-loop");
  expect(res.status).toBe(404);
  expect(((await res.json()) as { refused: string[] }).refused).toEqual(['there is no loop "no-such-loop"']);
  const r = await served({ role: "requester" });
  try {
    for (const path of ["/api/loops", "/api/loops/investigation", "/api/loop-files"]) expect((await r.get(path)).status).toBe(403);
  } finally {
    await r.close();
  }
});

test("the case list names each case's loop, its parent and the child it waits on", async () => {
  s = await served({ before: writeTriage });
  const plain = await s.newCase();
  const parent = await s.newCase({ loop: "triage" });
  const r = await s.command(parent, "start_run");
  expect(r.status).toBe(200);
  await s.app.hub.idle();
  const listed = await getJson<CaseSummaryView[]>("/api/cases");
  const by = (id: string) => listed.find((c) => c.id === id)!;
  const child = listed.find((c) => c.parent === parent)!;
  expect(child).toBeDefined();
  expect(by(plain)).toMatchObject({ loop: "investigation", parent: null, waiting_on: null });
  expect(by(parent)).toMatchObject({ loop: "triage", parent: null, waiting_on: child.id, run_status: "paused" });
  expect(child).toMatchObject({ loop: "investigation", parent, waiting_on: null });
});

// ---------- copy, save, export, import and trust ----------

type Draft = { id: string; title: string; stages: Record<string, unknown>[]; [k: string]: unknown };
const refusedOf = async (res: Response): Promise<string[]> => ((await res.json()) as { refused: string[] }).refused;
const written = () => s!.wb.chain.read().filter((e) => e.type === "manifest.written");
const loopsNow = () => getJson<LoopSummaryView[]>("/api/loops");
const rootFile = (...parts: string[]): string => join(s!.config.roots[0]!.path, ...parts);
async function copyQuick(): Promise<void> {
  const res = await s!.post("/api/loops/investigation/copy", { id: "quick", title: "Quick" });
  if (res.status !== 200) throw new Error(`copy failed: ${res.status} ${await res.text()}`);
}
const draftOfQuick = async (): Promise<Draft> => (await getJson<LoopView>("/api/loops/quick")).draft as unknown as Draft;
const ofType = (id: string, type: string) => s!.entries(id).filter((e) => e.type === type);

test("copy writes loops/<id>.yaml with every stage inline, records manifest.written by the person, and the new loop is listed at once", async () => {
  s = await served();
  const res = await s.post("/api/loops/investigation/copy", { id: "quick", title: "Quick" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: "quick" });
  const body = Bun.YAML.parse(readFileSync(rootFile("loops", "quick.yaml"), "utf8")) as { id: string; title: string; version: number; stages: unknown[] };
  expect(body).toMatchObject({ id: "quick", title: "Quick", version: 1 });
  expect(body.stages.length).toBe(9);
  for (const st of body.stages) expect(typeof st).toBe("object");
  expect(written().map((e) => ({ actor: e.actor, path: (e.payload as { path: string }).path, why: (e.payload as { why: string }).why }))).toEqual([
    { actor: { kind: "human", id: s.config.user }, path: "loops/quick.yaml", why: "copy" },
  ]);
  const quick = (await loopsNow()).find((l) => l.id === "quick")!;
  expect(quick).toMatchObject({ title: "Quick", version: 1, usable: true, trusted: true });
  const view = await getJson<LoopView>("/api/loops/quick");
  expect(view.stage_views.every((x) => x.inline)).toBe(true);
  // a copy of a loop that is there already is refused, by name
  const again = await s.post("/api/loops/investigation/copy", { id: "quick", title: "Again" });
  expect(again.status).toBe(409);
  expect(await refusedOf(again)).toEqual(['there is already a loop "quick"']);
});

test("save of an edited copy gives version 2 and a new hash; a case already running on version 1 finishes on version 1, and a new case of that loop starts on version 2", async () => {
  s = await served();
  await copyQuick();
  const v1 = (await loopsNow()).find((l) => l.id === "quick")!.hash!;
  const running = await s.newCase({ loop: "quick" });
  await s.toPlanGate(running);
  expect(s.app.hub.read(running).state.run.waiting).toBe("plan");
  const draft = await draftOfQuick();
  draft.stages.find((x) => x.id === "feedback")!.title = "Feedback, edited";
  const res = await s.post("/api/loops/quick/save", { draft, version: 1 });
  expect(res.status).toBe(200);
  const saved = (await res.json()) as { id: string; version: number; hash: string };
  expect(saved.id).toBe("quick");
  expect(saved.version).toBe(2);
  expect(saved.hash).toMatch(HEX64);
  expect(saved.hash).not.toBe(v1);
  expect((await loopsNow()).find((l) => l.id === "quick")).toMatchObject({ version: 2, hash: saved.hash });
  // the running case goes on to its end on the version it bound
  expect((await s.command(running, "accept_plan", { budgets: { s3: 1 } })).status).toBe(200);
  await s.app.hub.idle();
  expect(s.app.hub.read(running).state.run.waiting).toBe("publish");
  expect((await s.command(running, "approve")).status).toBe(200);
  await s.app.hub.idle();
  expect(s.app.hub.read(running).state.run).toMatchObject({ status: "finished", outcome: "published" });
  expect(ofType(running, "run.paused")).toEqual([]);
  expect(ofType(running, "loop.bound").map((e) => e.payload)).toMatchObject([{ loop: "quick", version: 1, hash: v1 }]);
  const fresh = await s.newCase({ loop: "quick" });
  expect((await s.command(fresh, "start_run")).status).toBe(200);
  await s.app.hub.idle();
  expect(ofType(fresh, "loop.bound").map((e) => e.payload)).toMatchObject([{ loop: "quick", version: 2, hash: saved.hash }]);
});

test("save with a stale version is 409: the loop changed since you opened it", async () => {
  s = await served();
  await copyQuick();
  const draft = await draftOfQuick();
  const before = readFileSync(rootFile("loops", "quick.yaml"), "utf8");
  for (const version of [2, null]) {
    const res = await s.post("/api/loops/quick/save", { draft, version });
    expect(res.status).toBe(409);
    expect(await refusedOf(res)).toEqual(["the loop changed since you opened it"]);
  }
  expect(readFileSync(rootFile("loops", "quick.yaml"), "utf8")).toBe(before);
  expect(written().length).toBe(1);
});

test("save of a draft that fails the check is 409 with the problems, and the file is unchanged", async () => {
  s = await served();
  await copyQuick();
  const draft = await draftOfQuick();
  draft.stages.find((x) => x.id === "research")!.on_fail = "nowhere";
  const before = readFileSync(rootFile("loops", "quick.yaml"), "utf8");
  const res = await s.post("/api/loops/quick/save", { draft, version: 1 });
  expect(res.status).toBe(409);
  const problems = await refusedOf(res);
  expect(problems.join(" | ")).toContain('on_fail names "nowhere"');
  expect(problems.join(" | ")).not.toContain(s.dir);
  expect(readFileSync(rootFile("loops", "quick.yaml"), "utf8")).toBe(before);
  expect(written().length).toBe(1);
  // a draft of another loop is refused before anything is checked
  const other = await s.post("/api/loops/investigation/save", { draft, version: 1 });
  expect(other.status).toBe(400);
  expect(await refusedOf(other)).toEqual(['the draft is of loop "quick", not "investigation"']);
});

test("check answers the same problems a save would and writes nothing", async () => {
  s = await served();
  await copyQuick();
  const draft = await draftOfQuick();
  draft.stages.find((x) => x.id === "research")!.on_fail = "nowhere";
  const before = readFileSync(rootFile("loops", "quick.yaml"), "utf8");
  const chain = s.wb.chain.head();
  const res = await s.post("/api/loops/quick/check", { draft });
  expect(res.status).toBe(200);
  const checked = (await res.json()) as { ok: boolean; problems: string[] };
  expect(checked.ok).toBe(false);
  expect(s.wb.chain.head()).toEqual(chain);
  const save = await s.post("/api/loops/quick/save", { draft, version: 1 });
  expect(await refusedOf(save)).toEqual(checked.problems);
  draft.stages.find((x) => x.id === "research")!.on_fail = "plan";
  draft.title = "Quick, checked";
  const good = (await (await s.post("/api/loops/quick/check", { draft })).json()) as { ok: boolean; problems: string[] };
  expect(good).toEqual({ ok: true, problems: [] });
  expect(readFileSync(rootFile("loops", "quick.yaml"), "utf8")).toBe(before);
  expect(s.wb.chain.head()).toEqual(chain);
});

/** A config file at write_path that lists the served root, as a person's would. */
function writeConfigFile(): string {
  mkdirSync(dirname(s!.config.write_path), { recursive: true });
  const text = `user: analyst\nroots:\n  - path: ${JSON.stringify(s!.config.roots[0]!.path)}\n    trusted: true\n    credentials: []\n`;
  writeFileSync(s!.config.write_path, text);
  return text;
}
/** quick, exported into the loop store, then taken out of the root: a loop file of a loop this workbench does not hold. */
async function exportedQuick(): Promise<string> {
  await copyQuick();
  const res = await s!.post("/api/loops/quick/export", {});
  if (res.status !== 200) throw new Error(`export failed: ${res.status} ${await res.text()}`);
  const { file } = (await res.json()) as { file: string };
  rmSync(rootFile("loops", "quick.yaml"));
  s!.reload();
  return file;
}

test("a copy, a save, an import and a trust while a run is working go ahead (controller ruling 5), and the working run keeps the version it bound", async () => {
  s = await served();
  const file = await exportedQuick();
  writeConfigFile();
  const id = await s.newCase();
  const bound = s.app.hub.deps.loops!.current("investigation")!.pipeline.hash;
  // the run is driven in the background: each act below lands while it works
  expect((await s.command(id, "start_run")).status).toBe(200);
  expect((await s.post("/api/loops/investigation/copy", { id: "second", title: "Second" })).status).toBe(200);
  const draft = (await getJson<LoopView>("/api/loops/second")).draft as unknown as Draft;
  draft.title = "Second, saved";
  expect((await s.post("/api/loops/second/save", { draft, version: 1 })).status).toBe(200);
  const imported = await s.post(`/api/loop-files/${file}/import`, {});
  expect(imported.status).toBe(200);
  const { root } = (await imported.json()) as { root: string };
  expect((await s.post("/api/roots/trust", { root, typed: root })).status).toBe(200);
  await s.app.hub.idle();
  const state = s.app.hub.read(id).state;
  expect(state.run.waiting).toBe("plan");
  expect(ofType(id, "run.paused")).toEqual([]);
  expect(ofType(id, "loop.bound").map((e) => (e.payload as { hash: string }).hash)).toEqual([bound]);
});

test("export writes a loop file into loops.store and the listing shows it; the download is an attachment with nosniff", async () => {
  s = await served();
  const res = await s.post("/api/loops/investigation/export", {});
  expect(res.status).toBe(200);
  const { file } = (await res.json()) as { file: string };
  const hash = s.app.hub.deps.loops!.current("investigation")!.pipeline.hash;
  expect(file).toBe(`investigation.v1.${hash.slice(0, 12)}.loop.tar.gz`);
  expect(existsSync(join(s.config.loops.store, file))).toBe(true);
  const files = await getJson<LoopFileView[]>("/api/loop-files");
  expect(files.length).toBe(1);
  expect(files[0]).toMatchObject({ file, loop: "investigation", version: 1, title: "Investigation", hash, problem: null });
  expect(files[0]!.files).toBeGreaterThan(10);
  expect(files[0]!.plan).toMatchObject({ write: 0, conflicts: [] });
  expect(files[0]!.plan!.same).toBe(files[0]!.files);
  const download = await s.get(`/api/loop-files/${file}`);
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toBe(`attachment; filename="${file}"`);
  expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array(readFileSync(join(s.config.loops.store, file))));
  expect(JSON.stringify(files)).not.toContain(s.dir);
});

test("import of a listed file lands in loops.imports; the loop is then listed as not usable with: a loop manifest is accepted only from a trusted root", async () => {
  s = await served();
  const file = await exportedQuick();
  expect((await loopsNow()).some((l) => l.id === "quick")).toBe(false);
  const listed = (await getJson<LoopFileView[]>("/api/loop-files")).find((f) => f.file === file)!;
  expect(listed.plan!.write).toBe(1);
  const res = await s.post(`/api/loop-files/${file}/import`, {});
  expect(res.status).toBe(200);
  const done = (await res.json()) as { root: string; written: number; same: number };
  expect(done.root).toMatch(/^quick-[0-9a-f]{12}$/);
  expect(done.written).toBe(1);
  expect(done.same).toBe(listed.plan!.same);
  expect(existsSync(join(s.config.loops.imports, done.root, "loops", "quick.yaml"))).toBe(true);
  const quick = (await loopsNow()).find((l) => l.id === "quick")!;
  expect(quick).toMatchObject({ usable: false, trusted: false, root: done.root });
  expect(quick.problems.join(" | ")).toContain("a loop manifest is accepted only from a trusted root");
  // the same file again is refused: it is imported already
  const again = await s.post(`/api/loop-files/${file}/import`, {});
  expect(again.status).toBe(409);
  expect((await refusedOf(again)).join(" ")).toContain("already imported");
});

test("trust with the folder's name typed adds the root to the configuration and the loop becomes usable; a wrong name typed, or a folder that is not an imported one, changes nothing", async () => {
  s = await served();
  const file = await exportedQuick();
  const text = writeConfigFile();
  const { root } = (await (await s.post(`/api/loop-files/${file}/import`, {})).json()) as { root: string };
  mkdirSync(join(s.dir, "elsewhere"), { recursive: true });
  for (const body of [{ root, typed: "quick" }, { root: "elsewhere", typed: "elsewhere" }, { root: "../sample", typed: "../sample" }, { root: "nope-000000000000", typed: "nope-000000000000" }]) {
    const res = await s.post("/api/roots/trust", body);
    expect(res.status).toBe(409);
    expect(readFileSync(s.config.write_path, "utf8")).toBe(text);
  }
  expect(s.config.roots.length).toBe(1);
  expect((await loopsNow()).find((l) => l.id === "quick")!.usable).toBe(false);
  const res = await s.post("/api/roots/trust", { root, typed: root });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(readFileSync(s.config.write_path, "utf8")).toContain(JSON.stringify(join(s.config.loops.imports, root)));
  expect((await loopsNow()).find((l) => l.id === "quick")).toMatchObject({ usable: true, trusted: true, root });
  // trusting it twice is refused
  expect((await s.post("/api/roots/trust", { root, typed: root })).status).toBe(409);
});

test("a file name with a separator, a leading dot or another ending is refused at every loop-file route", async () => {
  s = await served();
  for (const name of ["..%2Fx.v1.aaaaaaaaaaaa.loop.tar.gz", "a%2Fb.v1.aaaaaaaaaaaa.loop.tar.gz", ".x.v1.aaaaaaaaaaaa.loop.tar.gz", "x.v1.aaaaaaaaaaaa.tar.gz", "x.v1.aaaaaaaaaaaa.loop.tar.gz.exe", "%E0%A4%A"]) {
    for (const res of [await s.get(`/api/loop-files/${name}`), await s.post(`/api/loop-files/${name}/import`, {})]) {
      expect(res.status).toBe(400);
      expect(await refusedOf(res)).toEqual(["that is not a loop file's name"]);
    }
  }
  expect(existsSync(s.config.loops.imports)).toBe(false);
});

test("a body that names an actor is refused at every new route", async () => {
  s = await served();
  await copyQuick();
  const draft = await draftOfQuick();
  const actor = { kind: "human", id: "someone-else" };
  const chain = s.wb.chain.head();
  for (const [path, body] of [
    ["/api/loops/investigation/copy", { id: "other", title: "Other", actor }],
    ["/api/loops/quick/save", { draft, version: 1, actor }],
    ["/api/loops/quick/check", { draft, actor }],
    ["/api/loops/quick/export", { actor }],
    ["/api/loop-files/quick.v1.aaaaaaaaaaaa.loop.tar.gz/import", { actor }],
    ["/api/roots/trust", { root: "x", typed: "x", actor }],
    ["/api/cases", { title: "T", asked: "A", why: "W", starting: [], window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, objective: null, marking: "TLP:GREEN", loop: "quick", actor }],
  ] as const) {
    const res = await s.post(path, body);
    expect(res.status).toBe(400);
    expect(await refusedOf(res)).toEqual(["the server names the actor"]);
  }
  expect(s.wb.chain.head()).toEqual(chain);
  expect(existsSync(s.config.loops.store)).toBe(false);
});

test("POST /api/cases with a loop makes a case for it; an unknown or unusable loop is refused by name", async () => {
  s = await served({ before: (root) => { writeTriage(root); brokenLoop(root); } });
  const id = await s.newCase({ loop: "triage" });
  expect(ofType(id, "case.loop_set").map((e) => ({ payload: e.payload, actor: e.actor }))).toEqual([{ payload: { loop: "triage" }, actor: { kind: "human", id: s.config.user } }]);
  const before = s.wb.listCases().length;
  const input = { title: "T", asked: "A", why: "W", starting: [], window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, objective: null, marking: "TLP:GREEN" };
  for (const [loop, why] of [["nope", 'there is no loop "nope"'], ["broken", 'loop "broken" is not usable: stage "frame": schema "no-such-schema" is not loaded'], [3, "loop must be a loop's id"]] as const) {
    const res = await s.post("/api/cases", { ...input, loop });
    expect(res.status).toBe(400);
    expect(await refusedOf(res)).toEqual([why]);
  }
  expect(s.wb.listCases().length).toBe(before);
});

test("an unusable default loop does not stop the server: it is a problem, a new case of it is refused, and every read still answers (controller ruling)", async () => {
  s = await served({ before: (root) => writeFileSync(join(root, "stages", "research.yaml"), readFileSync(join(root, "stages", "research.yaml"), "utf8").replace("on_fail: plan", "on_fail: nowhere")) });
  const me = await getJson<{ problems: string[] }>("/api/me");
  expect(me.problems.join(" | ")).toContain('the default loop "investigation" is not usable: stage "research": on_fail names "nowhere"');
  const inv = (await loopsNow()).find((l) => l.id === "investigation")!;
  expect(inv).toMatchObject({ usable: false, hash: null });
  const res = await s.post("/api/cases", { title: "T", asked: "A", why: "W", starting: [], window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, objective: null, marking: "TLP:GREEN" });
  expect(res.status).toBe(400);
  expect(await refusedOf(res)).toEqual(['loop "investigation" is not usable: stage "research": on_fail names "nowhere", which is not a stage of this loop']);
  for (const path of ["/api/cases", "/api/reference", "/api/store", "/api/loop-files", "/api/loops/investigation"]) expect((await s.get(path)).status).toBe(200);
  // fixed by hand and reloaded, it is usable again and a case can be made
  writeFileSync(rootFile("stages", "research.yaml"), readFileSync(rootFile("stages", "research.yaml"), "utf8").replace("on_fail: nowhere", "on_fail: plan"));
  expect(s.reload().join(" | ")).not.toContain("is not usable");
  await s.newCase();
});

test("every new route is refused for another Host, another Origin, a cross-site request, a non-JSON POST and a requester", async () => {
  s = await served();
  const routes: { method: "GET" | "POST"; path: string; body: unknown }[] = [
    { method: "GET", path: "/api/loops", body: null },
    { method: "GET", path: "/api/loops/investigation", body: null },
    { method: "GET", path: "/api/loop-files", body: null },
    { method: "GET", path: "/api/loop-files/x.v1.aaaaaaaaaaaa.loop.tar.gz", body: null },
    { method: "POST", path: "/api/loops/investigation/copy", body: { id: "other", title: "Other" } },
    { method: "POST", path: "/api/loops/investigation/save", body: { draft: {}, version: 1 } },
    { method: "POST", path: "/api/loops/investigation/check", body: { draft: {} } },
    { method: "POST", path: "/api/loops/investigation/export", body: {} },
    { method: "POST", path: "/api/loop-files/x.v1.aaaaaaaaaaaa.loop.tar.gz/import", body: {} },
    { method: "POST", path: "/api/roots/trust", body: { root: "x", typed: "x" } },
  ];
  const host = new URL(s.origin).host;
  const ask = (path: string, headers: Record<string, string>, init: RequestInit): Promise<Response> => s!.app.handle(new Request(`${s!.origin}${path}`, { ...init, headers }));
  const r = await served({ role: "requester" });
  try {
    for (const route of routes) {
      const init: RequestInit = route.method === "GET" ? {} : { method: "POST", body: JSON.stringify(route.body) };
      const json = { "content-type": "application/json" };
      expect((await ask(route.path, { ...json, host: "evil.example:4747", origin: s.origin }, init)).status).toBe(421);
      expect((await ask(route.path, { ...json, host, origin: "https://example.net" }, init)).status).toBe(403);
      expect((await ask(route.path, { ...json, host, origin: s.origin, "sec-fetch-site": "cross-site" }, init)).status).toBe(403);
      expect((await ask(route.path, { host, origin: s.origin, "content-type": "text/plain" }, { method: "POST", body: JSON.stringify(route.body ?? {}) })).status).toBe(403);
      const asRequester = route.method === "GET" ? await r.get(route.path) : await r.post(route.path, route.body);
      expect(asRequester.status).toBe(403);
    }
  } finally {
    await r.close();
  }
  expect(written()).toEqual([]);
  expect(existsSync(s.config.loops.store)).toBe(false);
  expect(existsSync(s.config.write_path)).toBe(false);
});

test("an export whose files would hold a secret value the workbench keeps is refused, and nothing is written", async () => {
  const secret = "planted-secret-value-5c21";
  s = await served({ credential: { name: "SAMPLE_PLANTED_SECRET", value: secret }, before: (root) => {
    const at = join(root, "context", "personas", "researcher.md");
    writeFileSync(at, `${readFileSync(at, "utf8")}\nThe key is ${secret}.\n`);
  } });
  const res = await s.post("/api/loops/investigation/export", {});
  expect(res.status).toBe(409);
  const text = JSON.stringify(await refusedOf(res));
  expect(text).not.toContain(secret);
  expect(existsSync(s.config.loops.store) ? readdirSync(s.config.loops.store).filter((f) => f.endsWith(".loop.tar.gz")) : []).toEqual([]);
});

// ---------- final review C2: an imported loop is staged until it is trusted ----------

const enc = new TextEncoder();
/** A sql source over a file of the import's own, and a pivot on it: what an imported loop file can carry beside its loop. */
const giftSource = (over = ""): string => `kind: source\nid: gift-names\ntitle: Gift names\nconnector: sql\nlocation: "unset"\nconfirmed: false\nmarking: TLP:CLEAR\nwhere: machine\ncost: { weight: 0, unit: rows }\n${over}tables:\n  - name: names\n    about: names\n    columns:\n      - { name: answer, type: address }\n      - { name: name, type: domain }\n`;
const giftPivots = `kind: pivots\npivots:\n  - id: zz_gift\n    title: Names for the address (gift)\n    from: address\n    to: domain\n    source: gift-names\n    query: "select name from names where answer = {value}"\n    empty_means: proven-negative\n    yields: { name: domain }\n`;
async function giftFile(members: { path: string; kind: string; id: string; bytes: Uint8Array }[], tag = "cd"): Promise<string> {
  const { writeLoopFile: pack } = await import("../../src/core/loopfile");
  mkdirSync(s!.config.loops.store, { recursive: true });
  const hash = tag.repeat(32);
  const name = `gift.v1.${hash.slice(0, 12)}.loop.tar.gz`;
  await pack(join(s!.config.loops.store, name), { loop: "gift", version: 1, title: "Gift", about: "", hash, legacy_hash: null, lock: {}, subloops: [] } as never, members.map((m) => ({ ...m, origin: null })));
  return name;
}
const routePivots = async (): Promise<string[]> => (await getJson<{ hops: { pivot: string }[] }[]>("/api/routes?have=address&want=domain")).flatMap((r) => r.hops.map((h) => h.pivot));

test("an imported source and pivot supply nothing before the folder is trusted: not in the registry, not in the route finder, not run by run_pivot; trusted, they load", async () => {
  s = await served();
  const name = await giftFile([
    { path: "sources/gift-names.yaml", kind: "source", id: "gift-names", bytes: enc.encode(giftSource()) },
    { path: "pivots.yaml", kind: "pivots", id: "zz_gift", bytes: enc.encode(giftPivots) },
  ]);
  const imp = await s.post(`/api/loop-files/${name}/import`, {});
  expect(imp.status).toBe(200);
  const { root } = (await imp.json()) as { root: string };
  const reg = s.app.hub.deps.registry;
  expect(reg.source("gift-names")).toBeNull();
  expect(reg.pivot("zz_gift")).toBeNull();
  expect(reg.problems.find((p) => p.path.endsWith(join(root, "pivots.yaml")))?.error).toBe("a pivot manifest from an imported folder is used only once the folder is trusted");
  expect(await routePivots()).not.toContain("zz_gift");
  const id = await s.newCase();
  const r = await s.command(id, "run_pivot", { pivot: "zz_gift", value: "198.51.100.77", why: "x" });
  await s.app.hub.idle();
  expect(r.status).not.toBe(200);
  expect(Object.keys(s.app.hub.read(id).state.queries)).toEqual([]);
  // once trusted, they load, and the source is a shape that names no place
  writeConfigFile();
  expect((await s.post("/api/roots/trust", { root, typed: root })).status).toBe(200);
  expect(s.app.hub.deps.registry.pivot("zz_gift")).not.toBeNull();
  expect(s.app.hub.deps.registry.source("gift-names")).toMatchObject({ confirmed: false });
});

test("an import is refused, writing nothing, for a source that is not a shape or a check script no check of the file names", async () => {
  s = await served();
  const unshaped = await giftFile([{ path: "sources/gift-names.yaml", kind: "source", id: "gift-names", bytes: enc.encode(giftSource().replace('location: "unset"\nconfirmed: false\n', "location: names.sqlite\nconfirmed: true\n")) }], "ce");
  const smuggled = await giftFile([{ path: "names.sqlite", kind: "check-script", id: "nope", bytes: enc.encode("SQLite format 3\u0000") }], "cf");
  const dangling = await giftFile([
    { path: "checks/zz.yaml", kind: "check", id: "zz", bytes: enc.encode("kind: check\nid: zz\ntitle: zz\nscript: zz.ts\n") },
    { path: "checks/other.ts", kind: "check-script", id: "zz", bytes: enc.encode("export default () => [];\n") },
  ], "c0");
  for (const [file, said] of [[unshaped, "is not a source's shape"], [smuggled, "no check of this loop file names it"], [dangling, "no check of this loop file names it"]] as const) {
    const res = await s.post(`/api/loop-files/${file}/import`, {});
    expect(res.status).toBe(409);
    expect((await refusedOf(res)).join(" ")).toContain(said);
  }
  expect(existsSync(s.config.loops.imports) ? readdirSync(s.config.loops.imports) : []).toEqual([]);
});

test("trusting an imported folder is re-validated: a folder that now holds a kind and id the registry already has is refused, and nothing is changed", async () => {
  s = await served();
  const name = await giftFile([{ path: "sources/gift-names.yaml", kind: "source", id: "gift-names", bytes: enc.encode(giftSource()) }]);
  const { root } = (await (await s.post(`/api/loop-files/${name}/import`, {})).json()) as { root: string };
  // the person writes a source of that id into their own root meanwhile
  writeFileSync(rootFile("sources", "gift-names.yaml"), giftSource().replace("title: Gift names", "title: My names"));
  s.reload();
  expect(s.app.hub.deps.registry.source("gift-names")).toMatchObject({ title: "My names" });
  const text = writeConfigFile();
  const res = await s.post("/api/roots/trust", { root, typed: root });
  expect(res.status).toBe(409);
  expect((await refusedOf(res)).join(" ")).toContain('source "gift-names"');
  expect(readFileSync(s.config.write_path, "utf8")).toBe(text);
  expect(s.app.hub.deps.registry.source("gift-names")).toMatchObject({ title: "My names" });
});
