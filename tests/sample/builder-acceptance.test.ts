import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import type { Json } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { fold } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import type { Entry, EntryType } from "../../src/core/types";
import { verifyCase } from "../../src/core/verify";
import type { BuilderView, LoopSummaryView } from "../../src/core/wire";
import { REDACTED } from "../../src/server/builder";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

// Slice 12, part B, end to end on the sample and the scripted model (scripts/sample-builder.yaml). The person opens a builder conversation on the Loops
// page and asks for the partner blocklist (a SQLite table in the sample's data) as a source with a pivot over it, and for a loop that rechecks an address
// with the investigation. The builder reads the catalogue, has a deliberately bad pivot refused with the reason, proposes the source (with its field notes)
// and the pivot, then a stage and a loop; the person accepts each file; the builder asks to list the new source's tables, then for the new pivot on one
// value; the person approves each; a secret the person pastes is redacted; the session's ledger verifies and replays; a case made afterwards uses the
// new pivot, and a case made from the new loop runs.

/** A planted credential value, the host and the user of a source that names it: none may reach the builder's model, its ledger or a response. */
const SECRET = "planted-builder-secret-6Hv3";
const HOST = "lake.example.net";
const USER = "svc_reader";
const CHOICE = { provider: "scripted", model: "sample-builder", effort: null };
const ADDRESS = SAMPLE_START.value;
const SAMPLE = join(import.meta.dir, "..", "..", "sample");
const ASK_1 = "Our partner's blocklist is a SQLite table in data/blocklist.sqlite. Add it as a source with a pivot from an address, and a loop that rechecks an address with the investigation.";
const ASK_2 = `I accepted all four files. You will not need it, but the lake's password is ${SECRET}. What tables does the blocklist hold?`;
const ASK_3 = "Approved. Now try the pivot on 198.51.100.77.";

type Reply = { content?: string; tool_calls?: { tool: string; args: Record<string, Json> }[] };
type Snapshot = Record<string, { bytes: string; mtime: number }>;

/** Every file of a folder with its bytes and modification time. */
function snapshot(at: string): Snapshot {
  const out: Snapshot = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[relative(at, full)] = { bytes: readFileSync(full, "base64"), mtime: statSync(full).mtimeMs };
    }
  };
  walk(at);
  return out;
}
const changedFiles = (a: Snapshot, b: Snapshot): string[] => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k]?.bytes !== b[k]?.bytes).sort();

/** What the conversation left behind at each point a person acted, for the tests below to read. */
interface Run {
  s: Served; id: string; root: string; responses: string[];
  /** The session's live state after each act, by the seq of its head then. */
  live: Map<number, CaseState>;
  afterAsk1: { view: BuilderView; files: Snapshot; types: string[]; chain: number };
  beforeAsk1: { files: Snapshot; chain: number };
  afterAccepts: { files: Snapshot };
  afterAsk2: { view: BuilderView; queries: number };
  afterProbe1: { marking: string };
  investigation: string; recheck: string;
}

let running: Promise<Run> | undefined;
let opened: Served | undefined;
afterAll(async () => { await running?.catch(() => null); await opened?.close(); });

/** The whole conversation, once, driven through the server's routes as the person's browser would drive it. */
function conversation(): Promise<Run> {
  return (running ??= (async (): Promise<Run> => {
    const s = await served({
      credential: { name: "lake_reader", value: SECRET },
      before: (root) => {
        writeFileSync(join(root, "sources", "lakehouse.yaml"), `kind: source\nid: lakehouse\ntitle: Lake house\nconnector: trino\nlocation: https://${HOST}:8443\nuser: ${USER}\ncredential: lake_reader\nmarking: "TLP:GREEN"\nwhere: network\ncost: { weight: 1, unit: rows }\npurpose: Events kept in the lake.\ntables:\n  - name: events\n    time_column: ts\n    columns: [{ name: src, type: address }, { name: ts }]\n`);
      },
    });
    opened = s;
    const responses: string[] = [];
    const keep = async (res: Response): Promise<Response> => { responses.push(await res.clone().text()); return res; };
    const get = async (path: string): Promise<Response> => keep(await s.get(path));
    const post = async (path: string, body: unknown): Promise<Response> => keep(await s.post(path, body));
    const root = s.config.roots[0]!.path;
    const live = new Map<number, CaseState>();
    const capture = (id: string): void => { const b = s.wb.builder(id); live.set(b.head().seq, structuredClone(b.state)); };
    const ok = async (res: Promise<Response>): Promise<Response> => {
      const r = await res;
      if (r.status !== 200) throw new Error(`${r.status} ${await r.clone().text()}`);
      return r;
    };
    const view = async (id: string): Promise<BuilderView> => (await (await get(`/api/builders/${id}/view`)).json()) as BuilderView;
    const ask = async (id: string, text: string): Promise<void> => { await ok(post(`/api/builders/${id}/ask`, { text })); await s.app.hub.idle(); capture(id); };

    const beforeAsk1 = { files: snapshot(root), chain: s.wb.chain.read().length };
    const { id } = (await (await ok(post("/api/builders", { loop: null, marking: "TLP:GREEN" }))).json()) as { id: string };
    await ok(post(`/api/builders/${id}/model`, { choice: CHOICE }));
    capture(id);
    await ask(id, ASK_1);
    const v1 = await view(id);
    const afterAsk1 = { view: v1, files: snapshot(root), types: s.wb.builder(id).entries().map((e) => e.type), chain: s.wb.chain.read().length };

    // the person accepts every file: the source and the pivots first, then the stage and the loop
    for (const change of v1.changes) {
      for (const f of change.files) { await ok(post(`/api/builders/${id}/decide`, { change: change.id, file: f.index, accept: true })); capture(id); }
    }
    const afterAccepts = { files: snapshot(root) };

    await ask(id, ASK_2);
    const afterAsk2 = { view: await view(id), queries: s.wb.builder(id).entries().filter((e) => e.type.startsWith("query.")).length };
    await ok(post(`/api/builders/${id}/probe`, { probe: "probe-1", approve: true }));
    capture(id);
    const afterProbe1 = { marking: (await view(id)).marking };
    await ask(id, ASK_3);
    await ok(post(`/api/builders/${id}/probe`, { probe: "probe-2", approve: true }));
    capture(id);
    await get(`/api/builders/${id}/view`);
    await get("/api/builders");

    // a case made afterwards: the person runs the new pivot in it
    const investigation = await s.newCase();
    const pivot = await s.command(investigation, "run_pivot", { pivot: "address_to_blocklist", value: ADDRESS, window: SAMPLE_WINDOW, why: "is it on the partner's list" });
    if (pivot.status !== 200) throw new Error(`run_pivot: ${JSON.stringify(pivot.body)}`);
    // a case made from the new loop
    const recheck = await s.newCase({ loop: "triage-recheck" });
    const started = await s.command(recheck, "start_run");
    if (started.status !== 200) throw new Error(`start_run: ${JSON.stringify(started.body)}`);
    await s.app.hub.idle();
    return { s, id, root, responses, live, beforeAsk1, afterAsk1, afterAccepts, afterAsk2, afterProbe1, investigation, recheck };
  })());
}

const entriesOf = (r: Run): Entry[] => r.s.wb.builder(r.id).entries();
const ofType = <T extends EntryType>(r: Run, t: T): Extract<Entry, { type: T }>[] => entriesOf(r).filter((e): e is Extract<Entry, { type: T }> => e.type === t);
const person = (r: Run): { kind: "human"; id: string } => ({ kind: "human", id: r.s.config.user });
const script = (): { turns: { actor: string; reply: Reply }[] } => Bun.YAML.parse(readFileSync(join(SAMPLE, "scripts", "sample-builder.yaml"), "utf8")) as { turns: { actor: string; reply: Reply }[] };
const proposedText = (path: string): string => {
  for (const t of script().turns) for (const c of t.reply.tool_calls ?? []) {
    if (c.tool !== "propose_change") continue;
    const f = (c.args.files as { path: string; text: string }[]).find((x) => x.path === path);
    if (f !== undefined && !c.args.title!.toString().startsWith("Bad")) return f.text;
  }
  throw new Error(`the script proposes no ${path}`);
};

test("a builder conversation on the sample: the builder reads the catalogue, proposes a source with its field notes and a pivot, then a stage and a loop; a bad pivot is refused with the reason; nothing is written under the root and no query is sent until the person acts", async () => {
  const r = await conversation();
  // the script is the builder's alone, and reads before it proposes
  const calls = script().turns.flatMap((t) => (t.reply.tool_calls ?? []).map((c) => c.tool));
  expect(script().turns.every((t) => t.actor === "builder")).toBe(true);
  expect(calls).toEqual(["loop_catalogue", "adapter_catalogue", "list_connectors", "validate_manifest", "propose_change", "propose_change", "propose_change", "request_probe", "request_probe"]);
  const called = ofType(r, "tool.called").map((e) => e.payload.tool);
  expect(called.slice(0, 7)).toEqual(calls.slice(0, 7));
  // the bad pivot is the tool's error, with the guard's reason, and makes no change
  const returned = ofType(r, "tool.returned");
  const bad = returned[4]!;
  expect(bad.payload.ok).toBe(false);
  expect(JSON.stringify(bad.payload)).toContain("address_to_blocklist");
  expect(JSON.stringify(bad.payload).toLowerCase()).toContain("delete");
  // the person is shown two changes, the good ones, file by file as diffs
  const v = r.afterAsk1.view;
  expect(v.changes.map((c) => [c.id, c.files.map((f) => [f.path, f.kind, f.id, f.new_file, f.decided, f.stale])])).toEqual([
    ["chg-1", [["sources/blocklist.yaml", "source", "blocklist", true, null, false], ["pivots/blocklist.yaml", "pivots", "address_to_blocklist", true, null, false]]],
    ["chg-2", [["stages/recheck.yaml", "stage", "recheck", true, null, false], ["loops/triage-recheck.yaml", "loop", "triage-recheck", true, null, false]]],
  ]);
  expect(v.changes[0]!.files[0]!.lines.every((l) => l.op === "+")).toBe(true);
  expect(v.changes[0]!.files[0]!.lines.map((l) => l.text)).toContain("        extract:");
  expect(v.probes).toEqual([]);
  // until the person acts: no file under the root changed, nothing on the workbench chain, no query, no case
  expect(changedFiles(r.beforeAsk1.files, r.afterAsk1.files)).toEqual([]);
  expect(r.afterAsk1.files).toEqual(r.beforeAsk1.files);
  expect(r.afterAsk1.chain).toBe(r.beforeAsk1.chain);
  expect(r.afterAsk1.types.filter((t) => t.startsWith("query.") || t === "card.created" || t === "builder.decided")).toEqual([]);
  // the probe the builder asks for next waits for the person: nothing is sent before Approve
  expect(r.afterAsk2.view.probes.map((p) => [p.id, p.kind, p.source, p.text, p.decided])).toEqual([["probe-1", "query", "blocklist", "SELECT name FROM sqlite_master WHERE type = 'table'", null]]);
  expect(r.afterAsk2.queries).toBe(0);
  expect(r.s.wb.builder(r.id).state.skipped).toEqual([]);
});

test("the person accepts the stage, then the loop: both files are in the trusted root, written by the person; triage-recheck is listed as usable, and a case made from it runs", async () => {
  const r = await conversation();
  expect(changedFiles(r.beforeAsk1.files, r.afterAccepts.files)).toEqual(["loops/triage-recheck.yaml", "pivots/blocklist.yaml", "sources/blocklist.yaml", "stages/recheck.yaml"]);
  for (const path of ["sources/blocklist.yaml", "pivots/blocklist.yaml", "stages/recheck.yaml", "loops/triage-recheck.yaml"]) {
    expect(readFileSync(join(r.root, path), "utf8")).toBe(proposedText(path));
  }
  const decided = ofType(r, "builder.decided");
  expect(decided.map((e) => [e.actor, e.payload.change, e.payload.file, e.payload.accepted])).toEqual([
    [person(r), "chg-1", 0, true], [person(r), "chg-1", 1, true], [person(r), "chg-2", 0, true], [person(r), "chg-2", 1, true],
  ]);
  const loops = (await (await r.s.get("/api/loops")).json()) as LoopSummaryView[];
  expect(loops.find((l) => l.id === "triage-recheck")).toMatchObject({ id: "triage-recheck", title: "Triage recheck", version: 1, usable: true });
  // the case made from it runs: its one stage makes a child on the investigation loop, which stops at its plan gate for the person
  const parent = r.s.app.hub.read(r.recheck).state;
  expect(parent.loop.id).toBe("triage-recheck");
  expect(parent.skipped).toEqual([]);
  const children = Object.values(parent.loop.children);
  expect(children.length).toBe(1);
  expect(children[0]!.loop).toBe("investigation");
  expect(parent.run.status).toBe("paused");
  const child = r.s.app.hub.read(children[0]!.child).state;
  expect(child.run.waiting).toBe("plan");
  expect(child.loop.parent).toMatchObject({ case: r.recheck, stage: "recheck", loop: "investigation", depth: 1 });
});

test("the person approves each probe: one query each in the builder's ledger through the runner, its card in the session, the session's marking raised to the source's", async () => {
  const r = await conversation();
  const issued = ofType(r, "query.issued");
  const results = ofType(r, "query.result");
  expect(issued.map((e) => [e.actor, e.payload.source, e.payload.pivot ?? null])).toEqual([[person(r), "blocklist", null], [person(r), "blocklist", "address_to_blocklist"]]);
  expect(results.map((e) => [e.actor, e.cause])).toEqual(issued.map((e) => [{ kind: "system", id: "runner" }, e.seq]));
  const probes = r.s.wb.builder(r.id).state.builder.probes;
  expect(Object.values(probes).map((p) => [p.id, p.kind, p.decided?.approved, p.decided?.outcome, p.decided?.by])).toEqual([
    ["probe-1", "query", true, "ran", r.s.config.user], ["probe-2", "pivot", true, "ran", r.s.config.user],
  ]);
  const state = r.s.wb.builder(r.id).state;
  const cards = Object.values(state.cards);
  expect(cards.length).toBe(2);
  expect(cards.map((c) => c.query)).toEqual(issued.map((e) => e.payload.query));
  expect(cards[0]!.rows.flat()).toContain("blocklist");
  expect(cards[1]!.rows.flat()).toContain("suspicious");
  // the field notes' extract rule pulled the domain out of the note, by code
  expect(JSON.stringify(cards[1]!.extracted ?? null)).toContain("cdn-update.example.org");
  // the new source is TLP:AMBER: the first card raises the session from TLP:GREEN, and every later pack is sent at TLP:AMBER
  expect(cards.map((c) => c.marking)).toEqual(["TLP:AMBER", "TLP:AMBER"]);
  expect(r.afterProbe1.marking).toBe("TLP:AMBER");
  expect(ofType(r, "model.request").map((e) => e.payload.marking).at(-1)).toBe("TLP:AMBER");
  expect(ofType(r, "model.request")[0]!.payload.marking).toBe("TLP:GREEN");
  // a case made afterwards uses the new pivot: the person's lookup is in that case, from the new source
  const kase = r.s.app.hub.read(r.investigation).state;
  const kaseCards = Object.values(kase.cards);
  expect(kaseCards.length).toBe(1);
  expect(kase.queries[kaseCards[0]!.query!]).toMatchObject({ source: "blocklist", pivot: "address_to_blocklist" });
  expect(kaseCards[0]!.rows.flat()).toContain("suspicious");
  expect(kase.skipped).toEqual([]);
  // and nothing of the builder's probes is in either case
  for (const c of [r.investigation, r.recheck]) expect(r.s.entries(c).some((e) => e.type === "builder.probe_asked")).toBe(false);
});

test("the builder's ledger holds the conversation, the proposal, both decisions with who made them, the probe and its decision; it verifies; it replays exactly", async () => {
  const r = await conversation();
  const state = r.s.wb.builder(r.id).state;
  expect(state.skipped).toEqual([]);
  expect(state.conversation.map((t) => t.asked)).toEqual([ASK_1, ASK_2.replace(SECRET, REDACTED), ASK_3]);
  expect(state.conversation.every((t) => typeof t.answer === "string" && t.answer.length > 0)).toBe(true);
  expect(ofType(r, "agent.asked").map((e) => e.actor)).toEqual([person(r), person(r), person(r)]);
  expect(ofType(r, "builder.proposed").map((e) => [e.actor.kind, e.payload.change])).toEqual([["agent", "chg-1"], ["agent", "chg-2"]]);
  expect(Object.values(state.builder.changes).flatMap((c) => c.files.map((f) => f.decided?.by))).toEqual(Array(4).fill(r.s.config.user));
  expect(ofType(r, "builder.probe_asked").map((e) => [e.actor.kind, e.payload.probe])).toEqual([["agent", "probe-1"], ["agent", "probe-2"]]);
  expect(ofType(r, "builder.probe_decided").map((e) => [e.actor, e.payload.probe, e.payload.approved])).toEqual([[person(r), "probe-1", true], [person(r), "probe-2", true]]);
  // the agent wrote no decision
  for (const t of ["builder.decided", "builder.probe_decided"] as const) expect(ofType(r, t).every((e) => e.actor.kind === "human")).toBe(true);
  // verify: the chain and every blob
  const report = verifyCase(r.s.wb.builder(r.id).dir);
  expect(report).toMatchObject({ ok: true, firstBad: null, blobs: { bad: [] } });
  expect(report.entries).toBe(entriesOf(r).length);
  // replay: at every point the person acted, the fold of the entries up to it is the state the session had then
  const all = entriesOf(r);
  expect(r.live.size).toBeGreaterThanOrEqual(10);
  for (const [seq, then] of r.live) expect(fold(all, seq), `at entry ${seq}`).toEqual(then);
  expect(fold(all)).toEqual(state);
});

test("the workbench chain holds manifest.written for both files with why builder and the session id, and loop.recorded for the new loop", async () => {
  const r = await conversation();
  const chain = r.s.wb.chain.read();
  const written = chain.filter((e): e is Extract<Entry, { type: "manifest.written" }> => e.type === "manifest.written");
  expect(written.map((e) => [e.actor, e.payload.path, e.payload.kind, e.payload.id, e.payload.before, e.payload.why, e.payload.session])).toEqual([
    [person(r), "sources/blocklist.yaml", "source", "blocklist", null, "builder", r.id],
    [person(r), "pivots/blocklist.yaml", "pivots", "address_to_blocklist", null, "builder", r.id],
    [person(r), "stages/recheck.yaml", "stage", "recheck", null, "builder", r.id],
    [person(r), "loops/triage-recheck.yaml", "loop", "triage-recheck", null, "builder", r.id],
  ]);
  for (const e of written) expect(e.payload.hash).toBe(sha256Hex(readFileSync(join(r.root, e.payload.path), "utf8")));
  const recorded = chain.filter((e): e is Extract<Entry, { type: "loop.recorded" }> => e.type === "loop.recorded" && e.payload.loop === "triage-recheck");
  expect(recorded.length).toBe(1);
  expect(recorded[0]!.payload).toMatchObject({ loop: "triage-recheck", version: 1, hash: r.s.app.hub.deps.loops!.current("triage-recheck")!.pipeline.hash, legacy_hash: null });
  expect(recorded[0]!.seq).toBeGreaterThan(written.at(-1)!.seq);
});

test("no entry of the builder's ledger, no model request and no response of the server holds the planted secret, a source's location or its user", async () => {
  const r = await conversation();
  const session = r.s.wb.builder(r.id);
  const dir = join(session.dir, "blobs");
  const blobs = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(dir, e.name), "utf8")) : [];
  const requests = ofType(r, "model.request").map((e) => new TextDecoder().decode(session.blobs.get(e.payload.messages.blob)));
  expect(requests.length).toBeGreaterThanOrEqual(11);
  // the pasted secret reached the ledger redacted
  expect(ofType(r, "agent.asked")[1]!.payload.text).toContain(REDACTED);
  const lakeFile = readFileSync(join(r.root, "sources", "lakehouse.yaml"), "utf8");
  expect(lakeFile).toContain(HOST);
  for (const [what, text] of [["the ledger", JSON.stringify(session.entries())], ["the blobs", blobs.join("\n")], ["the model requests", requests.join("\n")], ["the responses", r.responses.join("\n")]] as const) {
    for (const planted of [SECRET, HOST, USER, r.s.dir, r.root]) expect(text.includes(planted), `${what} holds ${planted === SECRET ? "the secret" : planted}`).toBe(false);
  }
  expect(r.responses.length).toBeGreaterThan(10);
});

test("a builder script that proposes a model manifest, a check, a file with a credential value, and a loop that runs itself gets four refusals and the person is shown nothing", async () => {
  const propose = (title: string, path: string, text: string): Reply => ({ tool_calls: [{ tool: "propose_change", args: { why: "the person asked", title, files: [{ path, text }] } }] });
  const turns: Reply[] = [
    propose("A model", "models/fast.yaml", "kind: model\nid: fast\ntitle: Fast\nprovider: local\nwhere: machine\nbase_url: http://127.0.0.1:9\n"),
    propose("A check", "checks/99-extra.yaml", "kind: check\nid: extra\ntitle: Extra\nscript: 99-extra.ts\n"),
    propose("A source", "sources/blocklist.yaml", `kind: source\nid: blocklist\ntitle: Blocklist\nconnector: sql\nlocation: ../data/blocklist.sqlite\nmarking: "TLP:GREEN"\nwhere: machine\nquality: x\ntables:\n  - name: blocklist\n    time_column: null\n    columns: [{ name: address, type: address }]\npassword: ${SECRET}\n`),
    propose("A loop", "loops/again.yaml", "kind: loop\nid: again\ntitle: Again\nabout: runs itself\nversion: 1\nprofile: triage\nentry: again\nstages:\n  - { id: again, title: Again, order: 1, phase: collection, runs: loop, role: subloop, loop: again, inputs: { question: case.question }, returns: { findings: { as: cards } }, on_pass: null, on_fail: null }\n"),
    { content: "Nothing I proposed passed the check." },
  ];
  const s = await served({
    credential: { name: "lake_reader", value: SECRET },
    before: (root) => writeFileSync(join(root, "scripts", "bad-builder.yaml"), JSON.stringify({ kind: "script", id: "bad-builder", title: "Bad builder", turns: turns.map((reply) => ({ actor: "builder", reply })) })),
  });
  try {
    const root = s.config.roots[0]!.path;
    const before = snapshot(root);
    const { id } = (await (await s.post("/api/builders", { loop: null, marking: "TLP:GREEN" })).json()) as { id: string };
    expect((await s.post(`/api/builders/${id}/model`, { choice: { provider: "scripted", model: "bad-builder", effort: null } })).status).toBe(200);
    expect((await s.post(`/api/builders/${id}/ask`, { text: "Add a model, a check, the blocklist with its password, and a loop that runs itself." })).status).toBe(200);
    await s.app.hub.idle();
    const entries = s.wb.builder(id).entries();
    const returned = entries.filter((e): e is Extract<Entry, { type: "tool.returned" }> => e.type === "tool.returned");
    expect(returned.map((e) => e.payload.ok)).toEqual([false, false, false, false]);
    const reasons = returned.map((e) => JSON.stringify(e.payload));
    expect(reasons[0]).toContain("a save may not write a model");
    expect(reasons[1]).toContain("a save may not write a check");
    expect(reasons[2]).toContain("a credential is named by reference; set its value outside the workbench");
    expect(reasons[3]).toContain("again");
    expect(reasons.join("\n")).not.toContain(SECRET);
    // the person is shown nothing: no change, no probe, no file, no chain entry
    expect(entries.some((e) => e.type === "builder.proposed")).toBe(false);
    const v = (await (await s.get(`/api/builders/${id}/view`)).json()) as BuilderView;
    expect([v.changes, v.probes]).toEqual([[], []]);
    expect(snapshot(root)).toEqual(before);
    expect(s.wb.chain.read().some((e) => e.type === "manifest.written")).toBe(false);
    expect(s.wb.builder(id).state.conversation.at(-1)!.answer).toBe("Nothing I proposed passed the check.");
    expect(s.wb.builder(id).state.skipped).toEqual([]);
  } finally {
    await s.close();
  }
});
