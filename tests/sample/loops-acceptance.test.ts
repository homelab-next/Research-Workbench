import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import { BlobStore } from "../../src/core/blobs";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { Ledger } from "../../src/core/ledger";
import { readLoopFile } from "../../src/core/loopfile";
import type { LoopFileManifest } from "../../src/core/loopfile";
import { cardRefs, fold } from "../../src/core/state";
import { strictest } from "../../src/core/types";
import type { Actor, Card, Entry } from "../../src/core/types";
import { verifyCase, verifyLinks } from "../../src/core/verify";
import { Workbench } from "../../src/core/workbench";
import { loadConfig, rootsOf } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { saveTrustedRoot } from "../../src/modules/config-write";
import { exportLoop, importLoop } from "../../src/modules/loop-import";
import { copyLoop, draftOf, saveLoop } from "../../src/modules/loop-write";
import { loadRegistry } from "../../src/modules/registry-record";
import { Engine } from "../../src/pipeline/engine";
import type { EngineDeps } from "../../src/pipeline/engine";
import type { LoopOutput } from "../../src/pipeline/loops";
import { loadPipeline } from "../../src/pipeline/manifests";
import { foreignText, outputHash, outputsOf } from "../../src/pipeline/subloop";
import { sampleRoot } from "../helpers/sample-root";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

// Slice 12, part A, end to end on the sample and the scripted model: the sample's two loops, an old case under the loops, a triage case that runs the
// investigation loop as a child case, what comes back, replay, verify, markings, a loop file carried to a workbench with nothing in it, and the caps.

/** The sample's pipeline hash as the workbench computed it before slice 12. */
const SAMPLE_LEGACY_HASH = "19f7829f3f9c97faf5c149c0eddc4b047471ca3b2119f168abe2cbef93761329";
const GATES = new Set(["gate.passed", "plan.accepted", "product.published"]);
const human: Actor = { kind: "human", id: "analyst" };
const caseInput = { title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" as const };

const dirs: string[] = [];
const closers: (() => unknown)[] = [];
afterAll(async () => {
  while (closers.length > 0) await closers.pop()!();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string): string => { const d = mkdtempSync(join(tmpdir(), `loops-acc-${name}-`)); dirs.push(d); return d; };

/** The sample as a trusted root, a workbench and compose over it, closed by the caller. */
function composedSample(d: string): { config: Config; wb: Workbench; composed: ReturnType<typeof compose>; sample: ReturnType<typeof sampleRoot>; close(): void } {
  const sample = sampleRoot(d);
  const base = loadConfig({ env: {}, home: d, repoRoot: d });
  const config: Config = {
    ...base, data_dir: join(d, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 },
    loops: { ...base.loops, store: join(d, "wb", "loops"), imports: join(d, "wb", "imported") },
  };
  const wb = Workbench.open(config.data_dir, { onError: () => {} });
  const composed = compose(config, wb);
  return { config, wb, composed, sample, close: () => { composed.close(); wb.close(); sample.close(); } };
}

test("the sample has two usable loops, investigation and triage, and triage's lock names investigation's hash", () => {
  const w = composedSample(tmp("two"));
  try {
    expect(w.composed.problems).toEqual([]);
    const loops = w.composed.deps.loops!;
    const listed = loops.list();
    expect(listed.map((l) => [l.id, l.problems])).toEqual([["investigation", []], ["triage", []]]);
    const investigation = loops.current("investigation")!;
    const triage = loops.current("triage")!;
    expect(triage.manifest).toMatchObject({ title: "Triage", version: 1, profile: "triage", entry: "sort" });
    expect(triage.pipeline.stages.map((s) => [s.id, s.runs])).toEqual([["sort", "agent"], ["investigate", "loop"]]);
    expect(triage.lock.subloops).toEqual([{ stage: "investigate", loop: "investigation", hash: investigation.pipeline.hash }]);
    expect(triage.pipeline.legacy_hash).toBeNull();
    // the default loop is still the investigation, with the hash a case made before slice 12 recorded
    expect(w.composed.deps.pipeline.id).toBe("investigation");
    expect(investigation.pipeline.legacy_hash).toBe(SAMPLE_LEGACY_HASH);
  } finally {
    w.close();
  }
});

test("an investigation case made before slice 12's entries existed, stopped at its plan gate, runs to a published product after the upgrade with nothing skipped and its recorded pipeline hash unchanged", async () => {
  const d = tmp("old");
  const sample = sampleRoot(d);
  closers.push(() => sample.close());
  const config: Config = { ...loadConfig({ env: {}, home: d, repoRoot: d }), data_dir: join(d, "wb"), roots: [{ path: sample.root, trusted: true, credentials: [] }], research: { parallel: 1 } };
  // what the workbench ran with before slice 12: the pipeline of every stage manifest ("default", the old formula's hash) and no loops
  let wb = Workbench.open(config.data_dir, { onError: () => {} });
  let composed = compose(config, wb);
  const { loops: _l, components: _c, content: _b, ...rest } = composed.deps;
  const old: EngineDeps = { ...rest, pipeline: loadPipeline(composed.deps.registry).pipeline! };
  const first = wb.createCase(caseInput, human);
  const oldEngine = Engine.open(first, old);
  oldEngine.start(human);
  expect((await oldEngine.advance()).waiting).toBe("plan");
  oldEngine.close();
  const before = first.entries();
  const started = before.find((e) => e.type === "run.started")!;
  expect(started.type === "run.started" && [started.payload.pipeline, started.payload.pipeline_hash]).toEqual(["default", SAMPLE_LEGACY_HASH]);
  expect(before.some((e) => e.type.startsWith("loop.") || e.type.startsWith("subloop.") || e.type === "case.loop_set")).toBe(false);
  const id = first.id;
  wb.close();
  composed.close();

  // after the upgrade: the sample's two loops; the case is reopened with the composed deps, and a person accepts and approves
  wb = Workbench.open(config.data_dir, { onError: () => {} });
  composed = compose(config, wb);
  try {
    expect(composed.deps.loops!.list().map((l) => l.id)).toEqual(["investigation", "triage"]);
    const again = wb.session(id);
    const engine = Engine.open(again, composed.deps);
    engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
    expect(await engine.advance()).toMatchObject({ status: "waiting", waiting: "publish" });
    expect(again.state.drafts.length).toBeGreaterThan(0);
    engine.approve({ actor: human });
    const end = await engine.advance();
    engine.close();
    expect(end).toMatchObject({ status: "finished" });
    expect(again.state.run.outcome).toBe("published");
    expect(again.state.published.length).toBe(1);
    const entries = again.entries();
    expect(entries.slice(0, before.length)).toEqual(before);
    expect(entries.some((e) => e.type === "run.paused")).toBe(false);
    expect(entries.some((e) => e.type === "loop.bound")).toBe(false);
    expect(entries.filter((e) => e.type === "run.started").map((e) => (e.payload as { pipeline_hash: string }).pipeline_hash)).toEqual([SAMPLE_LEGACY_HASH]);
    expect(again.state.skipped).toEqual([]);
    expect(verifyCase(again.dir).ok).toBe(true);
    for (let n = 1; n <= entries.length; n++) {
      const at = fold(entries, n);
      if (n <= before.length) expect(at).toEqual(fold(before, n));
      expect(at.skipped).toEqual([]);
    }
  } finally {
    wb.close();
    composed.close();
  }
}, 120_000);

// ---------- a triage case over the served workbench: one run, read by the tests that follow ----------

interface Triaged {
  s: Served; parent: string; child: string;
  /** What the parent and the child said at each step, as the person met it. */
  seen: { child_made: string; paused: string; hold: unknown; child_waiting: string | null; after_accept: { child: string | null; parent: string; reason: string | null } };
  parentEntries: Entry[]; childEntries: Entry[];
}
let triaged: Promise<Triaged> | undefined;
async function runTriage(): Promise<Triaged> {
  const errors: unknown[] = [];
  const s = await served({ onError: (e) => { errors.push(e); } });
  closers.push(async () => { await s.close(); expect(errors).toEqual([]); });
  const parent = await s.newCase({ loop: "triage" });
  const r = await s.command(parent, "start_run");
  if (r.status !== 200) throw new Error(`start_run failed: ${JSON.stringify(r)}`);
  await s.app.hub.idle();
  const startedChild = s.entries(parent).filter((e) => e.type === "subloop.started");
  if (startedChild.length !== 1) throw new Error(`the parent started ${startedChild.length} children`);
  const child = (startedChild[0]!.payload as { child: string }).child;
  const p = s.app.hub.read(parent).state.run;
  const seen: Triaged["seen"] = {
    child_made: child, paused: p.pause_reason ?? "", hold: p.hold, child_waiting: s.app.hub.read(child).state.run.waiting,
    after_accept: { child: null, parent: "", reason: null },
  };
  // the person passes the child's gates by the child's own commands; nothing is sent to the parent
  const accepted = await s.command(child, "accept_plan", { budgets: { s3: 1 } });
  if (accepted.status !== 200) throw new Error(`accept_plan failed: ${JSON.stringify(accepted)}`);
  await s.app.hub.idle();
  const mid = s.app.hub.read(parent).state.run;
  seen.after_accept = { child: s.app.hub.read(child).state.run.waiting, parent: mid.status, reason: mid.pause_reason };
  const approved = await s.command(child, "approve");
  if (approved.status !== 200) throw new Error(`approve failed: ${JSON.stringify(approved)}`);
  await s.app.hub.idle();
  return { s, parent, child, seen, parentEntries: s.entries(parent), childEntries: s.entries(child) };
}
const theTriage = (): Promise<Triaged> => (triaged ??= runTriage());
const returnedCards = (t: Triaged): Card[] =>
  t.parentEntries.flatMap((e) => (e.type === "card.created" && (e.payload as { card: Card }).card.from !== undefined ? [(e.payload as { card: Card }).card] : []));

test("a triage case runs Sort, makes CASE-2 on the investigation loop, waits on it, and finishes as completed once a person has accepted the child's plan and approved its product", async () => {
  const t = await theTriage();
  const { s, parent, child } = t;
  expect(parent).toBe("CASE-1");
  expect(child).toBe("CASE-2");
  // Sort ran on the triage script, then the sub-loop stage made the child
  const stageEnds = t.parentEntries.filter((e) => e.type === "stage.finished" || e.type === "stage.started").map((e) => `${e.type} ${(e as { stage?: string | null }).stage ?? ""}`);
  expect(stageEnds[0]).toBe("stage.started sort");
  expect(t.parentEntries.some((e) => e.type === "model.request" && JSON.stringify(e.payload).includes("sample-triage"))).toBe(true);
  expect(s.app.hub.read(child).state.loop.parent).toMatchObject({ case: parent, stage: "investigate", attempt: 1, loop: "investigation", depth: 1 });
  expect(t.childEntries.find((e) => e.type === "case.loop_set")!.payload).toEqual({ loop: "investigation" });
  // while the child waits for the person, the parent says so
  expect(t.seen.paused).toStartWith("waiting on child CASE-2: ");
  expect(t.seen.hold).toEqual({ kind: "child", stage: "investigate", child: "CASE-2" });
  expect(t.seen.child_waiting).toBe("plan");
  expect(t.seen.after_accept).toMatchObject({ child: "publish", parent: "paused" });
  expect(t.seen.after_accept.reason).toStartWith("waiting on child CASE-2: ");
  // both ends
  expect(s.app.hub.read(child).state.run).toMatchObject({ status: "finished", outcome: "published" });
  expect(s.app.hub.read(parent).state.run).toMatchObject({ status: "finished", outcome: "completed" });
  // only the person passed a gate, and only in the child; the parent's resumes are the engine's
  for (const e of [...t.parentEntries, ...t.childEntries].filter((x) => GATES.has(x.type))) expect(e.actor).toEqual({ kind: "human", id: s.config.user });
  expect(t.parentEntries.some((e) => GATES.has(e.type))).toBe(false);
  for (const e of t.parentEntries.filter((x) => x.type === "run.resumed")) expect(e.actor).toEqual({ kind: "system", id: "engine" });
  const finished = t.parentEntries.filter((e) => e.type === "subloop.finished");
  expect(finished.map((e) => e.payload)).toMatchObject([{ stage: "investigate", attempt: 1, child, outcome: "published" }]);
  for (const id of [parent, child]) expect(s.app.hub.read(id).state.skipped).toEqual([]);
}, 120_000);

test("the triage case's returned cards are the child's findings, each with its origin, marked as the child's product is, and none cites a card of the parent", async () => {
  const t = await theTriage();
  const childState = t.s.app.hub.read(t.child).state;
  const product = childState.drafts.find((d) => d.hash === childState.published.at(-1)!.draft_hash)!.product;
  const cards = returnedCards(t);
  expect(cards.length).toBe(product.key_findings.length);
  expect(cards.length).toBeGreaterThan(0);
  const finished = t.parentEntries.find((e) => e.type === "subloop.finished")!.payload as { child_run: string; head: { seq: number; hash: string }; cards: string[] };
  expect(finished.cards).toEqual(cards.map((c) => c.id));
  const parentCardIds = Object.keys(t.s.app.hub.read(t.parent).state.cards);
  for (const c of cards) {
    expect(c.from).toMatchObject({ case: t.child, loop: "investigation", run: finished.child_run, head: finished.head.hash });
    expect(c.made_by).toBe("system");
    expect(c.kind).toBe("note");
    expect(c.query).toBeNull();
    expect(c.marking).toBe(product.marking);
    // a reference to the child's cards reads as the child's, never as a citation of a card of the parent
    expect(cardRefs(`${c.title}\n${c.body}`)).toEqual([]);
    expect(`${c.title} ${c.body}`).not.toMatch(/\[c\d+/);
    expect(parentCardIds).toContain(c.id);
  }
  // each card is one of the child's findings, in order, its text the child's with any citation written as the child's
  product.key_findings.forEach((f, i) => {
    expect(cards[i]!.body).toStartWith(foreignText(f.statement, t.child));
    expect(cards[i]!.body).toContain(`Likelihood: ${f.likelihood}. Confidence: ${f.confidence}.`);
  });
  // they are in the parent's Incoming
  const incoming = t.s.app.hub.read(t.parent).state.incoming;
  for (const c of cards) expect(incoming).toContain(c.id);
  for (const e of t.parentEntries.filter((x) => x.type === "card.created" && (x.payload as { card: Card }).card.from !== undefined)) expect(e.actor.kind).toBe("system");
}, 120_000);

test("the triage case replays exactly at every entry with the child's folder removed, and the child replays exactly on its own", async () => {
  const t = await theTriage();
  const casesDir = join(t.s.config.data_dir, "cases");
  // the parent's folder, alone, somewhere the child is not
  const alone = tmp("alone");
  cpSync(join(casesDir, t.parent), join(alone, t.parent), { recursive: true });
  expect(readdirSync(alone)).toEqual([t.parent]);
  const ledger = Ledger.open(join(alone, t.parent, "ledger.sqlite"), t.parent);
  const copied = ledger.read();
  ledger.close();
  expect(copied).toEqual(t.parentEntries);
  for (let n = 1; n <= copied.length; n++) {
    const at = fold(copied, n);
    expect(at).toEqual(fold(t.parentEntries, n));
    expect(at.skipped).toEqual([]);
  }
  expect(fold(copied, copied.length)).toEqual(t.s.app.hub.read(t.parent).state);
  // the parent's record of the child: the child's head and the hash of what came back, read from the parent's own chain and blobs, not a re-run
  const fin = copied.find((e) => e.type === "subloop.finished")!.payload as { head: { seq: number; hash: string }; output_hash: string; output: { blob: string } };
  const blobs = new BlobStore(join(alone, t.parent, "blobs"));
  const output = JSON.parse(blobs.text(fin.output.blob)) as Record<string, Json>;
  expect(outputHash(output)).toBe(fin.output_hash);
  expect(sha256Hex(canonical(output))).toBe(fin.output_hash);
  // and it is what the child held at that head
  const atHead = t.childEntries.find((e) => e.seq === fin.head.seq)!;
  expect(atHead.hash).toBe(fin.head.hash);
  const declared = loadRegistry(t.s.config.roots).get("loop", "investigation")!.body.outputs as unknown as Record<string, LoopOutput>;
  expect(Object.keys(declared).sort()).toEqual(["cards", "findings", "product"]);
  expect(outputsOf(fold(t.childEntries, fin.head.seq), declared)).toEqual(output);
  // the parent's replay asks no model: no model.request after the sub-loop stage started
  const startedAt = copied.find((e) => e.type === "subloop.started")!.seq;
  expect(copied.filter((e) => e.seq > startedAt && e.type === "model.request")).toEqual([]);
  // the child on its own
  const own = tmp("child");
  cpSync(join(casesDir, t.child), join(own, t.child), { recursive: true });
  const childLedger = Ledger.open(join(own, t.child, "ledger.sqlite"), t.child);
  const childCopied = childLedger.read();
  childLedger.close();
  expect(childCopied).toEqual(t.childEntries);
  for (let n = 1; n <= childCopied.length; n++) {
    const at = fold(childCopied, n);
    expect(at).toEqual(fold(t.childEntries, n));
    expect(at.skipped).toEqual([]);
  }
  expect(fold(childCopied, childCopied.length)).toEqual(t.s.app.hub.read(t.child).state);
  // verify reads the parent alone: the link is not checked, which does not fail it
  expect(verifyCase(join(alone, t.parent)).ok).toBe(true);
  expect(verifyLinks(join(alone, t.parent), alone)).toMatchObject({ ok: true, links: [{ child: t.child, status: "not_loaded" }] });
}, 120_000);

test("verify passes on both cases and reports the link as matching", async () => {
  const t = await theTriage();
  const casesDir = join(t.s.config.data_dir, "cases");
  for (const id of [t.parent, t.child]) {
    const r = verifyCase(join(casesDir, id));
    expect(`${id} ${r.ok}`).toBe(`${id} true`);
  }
  expect(verifyLinks(join(casesDir, t.parent), casesDir)).toEqual({ ok: true, links: [{ key: `${t.s.app.hub.read(t.parent).state.run.id}/investigate/1`, child: t.child, status: "matches" }] });
  // the child names no child of its own
  expect(verifyLinks(join(casesDir, t.child), casesDir)).toEqual({ ok: true, links: [] });
}, 120_000);

test("the child's marking is at least the parent's, and a parent marked TLP:RED makes a child marked TLP:RED", async () => {
  const t = await theTriage();
  const parentMarking = t.s.app.hub.read(t.parent).state.meta!.marking;
  const childMarking = t.s.app.hub.read(t.child).state.meta!.marking;
  expect(strictest(parentMarking, childMarking)).toBe(childMarking);
  // a second triage case, marked TLP:RED, on the same workbench
  const red = await t.s.newCase({ loop: "triage", marking: "TLP:RED" });
  expect((await t.s.command(red, "start_run")).status).toBe(200);
  await t.s.app.hub.idle();
  const started = t.s.entries(red).filter((e) => e.type === "subloop.started");
  expect(started.length).toBe(1);
  const redChild = (started[0]!.payload as { child: string }).child;
  expect(redChild).not.toBe(t.child);
  expect(t.s.app.hub.read(redChild).state.meta!.marking).toBe("TLP:RED");
  expect(t.s.app.hub.read(redChild).state.loop.parent).toMatchObject({ case: red, floor: "TLP:RED" });
  for (const id of [red, redChild]) expect(t.s.app.hub.read(id).state.skipped).toEqual([]);
}, 120_000);

// ---------- the loop file, carried to a workbench with nothing in it ----------

let exported: Promise<{ file: string; path: string; manifest: LoopFileManifest; locations: string[] }> | undefined;
/** The sample's triage loop exported, once, with the sample's source locations as the root held them. */
function exportTriage(): Promise<{ file: string; path: string; manifest: LoopFileManifest; locations: string[] }> {
  exported ??= (async () => {
    const w = composedSample(tmp("export"));
    try {
      const locations = readdirSync(join(w.sample.root, "sources")).map((f) => /^location:\s*(\S+)/m.exec(readFileSync(join(w.sample.root, "sources", f), "utf8"))![1]!);
      const done = await exportLoop({ loops: w.composed.deps.loops!, registry: w.composed.deps.registry, secrets: w.composed.secrets() }, "triage", join(tmp("out"), "loops"));
      return { ...done, locations };
    } finally {
      w.close();
    }
  })();
  return exported;
}
/** A configuration file whose own roots are `roots`, its data folder `at`. */
function configOf(at: string, roots: { path: string; trusted: boolean }[]): Config {
  mkdirSync(at, { recursive: true });
  const p = join(at, "config.yaml");
  writeFileSync(p, `data_dir: ${JSON.stringify(at)}\nroots:\n${roots.map((r) => `  - { path: ${JSON.stringify(r.path)}, trusted: ${r.trusted}, credentials: [] }`).join("\n")}\n`);
  return loadConfig({ path: p, env: {}, home: at, repoRoot: at });
}

test("exporting triage and importing it into a second workbench whose only root is empty gives an imported root that is not trusted; once trusted, triage and investigation resolve there to the exported hashes", async () => {
  // importLoop, rootsOf, loadRegistry and loadLoops called directly: a workbench with no usable loop cannot be composed, and must still be able to import
  const { path, file, manifest } = await exportTriage();
  expect(file).toMatch(/^triage\.v1\.[0-9a-f]{12}\.loop\.tar\.gz$/);
  expect(manifest).toMatchObject({ loop: "triage", version: 1, title: "Triage" });
  expect((manifest.subloops as { loop: string }[]).map((l) => l.loop)).toEqual(["investigation"]);
  const investigationHash = (manifest.subloops[0] as { hash: string }).hash;

  const d = tmp("second");
  const own = join(d, "own");
  mkdirSync(own, { recursive: true });
  const config = configOf(join(d, "data"), [{ path: own, trusted: true }]);
  const done = await importLoop(path, loadRegistry(rootsOf(config)), config.loops.imports);
  expect(done.same).toEqual([]);
  expect(done.written.length).toBe(manifest.files.length);
  expect(readdirSync(own)).toEqual([]);
  expect(rootsOf(config)).toEqual([{ path: own, trusted: true, credentials: [] }, { path: done.root, trusted: false, credentials: [] }]);
  const untrusted = loadRegistry(rootsOf(config));
  expect(untrusted.get("loop", "triage")).toBeNull();
  expect(untrusted.problems.find((p) => p.path === join(done.root, "loops", "triage.yaml"))?.error).toBe("a loop manifest is accepted only from a trusted root");

  // the person trusts the root: the configuration gains it, and both loops resolve to the hashes the file names
  saveTrustedRoot(config, done.root);
  const trustedNow = loadConfig({ path: config.write_path, env: {}, home: join(d, "data"), repoRoot: join(d, "data") });
  const roots = rootsOf(trustedNow);
  expect(roots).toEqual([{ path: own, trusted: true, credentials: [] }, { path: done.root, trusted: true, credentials: [] }]);
  const wb = Workbench.open(trustedNow.data_dir, { onError: () => {} });
  const composed = compose(trustedNow, wb);
  try {
    const loops = composed.deps.loops!;
    expect(loops.problems("triage")).toEqual([]);
    expect(loops.problems("investigation")).toEqual([]);
    expect(loops.current("triage")!.pipeline.hash).toBe(manifest.hash);
    expect(loops.current("investigation")!.pipeline.hash).toBe(investigationHash);
    expect(JSON.parse(JSON.stringify(loops.current("triage")!.lock))).toEqual(manifest.lock);
    // a case started from it there binds the version the file carried
    const s = wb.createCase(caseInput, human, { loop: "triage" });
    const engine = Engine.open(s, composed.deps);
    engine.start(human);
    engine.close();
    const bound = s.entries().filter((e) => e.type === "loop.bound").map((e) => e.payload as { loop: string; hash: string });
    expect(bound).toEqual([expect.objectContaining({ loop: "triage", hash: manifest.hash })]);
    expect(s.state.skipped).toEqual([]);
  } finally {
    composed.close();
    wb.close();
  }
}, 120_000);

test("the exported file holds none of the sample's source locations, and nothing under data/", async () => {
  const { path, locations } = await exportTriage();
  expect(locations.length).toBe(7);
  const names: string[] = [];
  const texts: string[] = [];
  await readLoopFile(path, (entry, bytes) => { names.push(entry.path); texts.push(new TextDecoder().decode(bytes)); });
  expect(names.length).toBeGreaterThan(20);
  for (const n of names) {
    expect(n.split("/")).not.toContain("data");
    expect(n.startsWith("sources/")).toBe(false);
    expect(n.startsWith("models/") || n.startsWith("scripts/")).toBe(false);
  }
  const all = texts.join("\n");
  for (const l of locations) expect(`${l}: ${all.includes(l)}`).toBe(`${l}: false`);
  expect(all).not.toContain("127.0.0.1");
  expect(all).not.toMatch(/^location:/m);
}, 120_000);

test("a triage loop edited to run itself is refused at save, and one made to nest three deep is refused at the default cap", () => {
  const w = composedSample(tmp("caps"));
  try {
    const deps = () => ({ config: w.config, chain: w.wb.chain, content: w.wb.chainBlobs, secrets: [] as string[], loops: w.composed.deps.loops! });
    const fileText = (): string => readFileSync(join(w.sample.root, "loops", "triage.yaml"), "utf8");
    const before = fileText();
    // triage's sub-loop stage made to run triage
    const selfie = JSON.parse(JSON.stringify(draftOf(w.composed.deps.loops!.current("triage")!))) as ReturnType<typeof draftOf>;
    const sub = selfie.stages.find((s) => s.id === "investigate")!;
    sub.loop = "triage";
    sub.returns = { cards: { as: "cards" } };
    const refusedSelf = saveLoop(deps(), selfie, 1, { actor: human });
    expect(refusedSelf.ok).toBe(false);
    expect(refusedSelf.problems.join("\n")).toContain("a loop may not run itself: triage > triage");
    expect(fileText()).toBe(before);
    // deep runs triage (two deep: allowed); deeper runs deep (three deep: refused at the default cap of 2)
    expect(copyLoop(deps(), "triage", "deep", "Deep", { actor: human }).ok).toBe(true);
    expect(w.composed.reload()).toEqual([]);
    const deep = JSON.parse(JSON.stringify(draftOf(w.composed.deps.loops!.current("deep")!))) as ReturnType<typeof draftOf>;
    Object.assign(deep.stages.find((s) => s.id === "investigate")!, { loop: "triage", returns: { cards: { as: "cards" } } });
    const savedDeep = saveLoop(deps(), deep, 1, { actor: human });
    expect(savedDeep.problems).toEqual([]);
    expect(w.composed.reload()).toEqual([]);
    expect(copyLoop(deps(), "triage", "deeper", "Deeper", { actor: human }).ok).toBe(true);
    expect(w.composed.reload()).toEqual([]);
    const deeper = JSON.parse(JSON.stringify(draftOf(w.composed.deps.loops!.current("deeper")!))) as ReturnType<typeof draftOf>;
    Object.assign(deeper.stages.find((s) => s.id === "investigate")!, { loop: "deep", returns: { cards: { as: "cards" } } });
    const refusedDeep = saveLoop(deps(), deeper, 1, { actor: human });
    expect(refusedDeep.ok).toBe(false);
    expect(refusedDeep.problems.join("\n")).toContain("the chain of sub-loops deeper > deep > triage > investigation is 3 deep; loops.max_depth is 2");
    expect(w.config.loops.max_depth).toBe(2);
  } finally {
    w.close();
  }
});
