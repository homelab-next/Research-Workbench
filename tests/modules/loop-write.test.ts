import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { Actor } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { latestOutput } from "../../src/cli/compose";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { loadRegistry } from "../../src/modules/registry-record";
import type { Registry } from "../../src/modules/registry";
import { checkChange, copyLoop, copyOf, draftOf, loopText, saveLoop, saveManifests, WRITABLE_KINDS, WriteRefused, writeRoot } from "../../src/modules/loop-write";
import type { ManifestFile } from "../../src/modules/loop-write";
import { IMPLICIT_NOTE, loadLoops } from "../../src/pipeline/loops";
import type { LoopCatalog, ResolvedLoop } from "../../src/pipeline/loops";
import { copySample } from "../helpers/sample-root";

const human: Actor = { kind: "human", id: "analyst" };
let dir: string;
let root: string;
let config: Config;
let wb: Workbench;
const deps = () => ({ config, chain: wb.chain, content: wb.chainBlobs, secrets: [] as string[] });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "loop-write-"));
  root = join(dir, "sample");
  copySample(root);
  // these tests make a loop called triage of their own: the sample's (slice 12, Task 14) is taken out of this copy
  rmSync(join(root, "loops", "triage.yaml"));
  const base = loadConfig({ env: {}, home: dir, repoRoot: dir });
  config = { ...base, data_dir: join(dir, "wb"), roots: [{ path: root, trusted: true, credentials: [] }], loops: { ...base.loops, store: join(dir, "wb", "loops"), imports: join(dir, "wb", "imported") } };
  wb = Workbench.open(config.data_dir, { onError: () => {} });
});
afterEach(() => {
  wb.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The loops of the roots as they are now, as compose loads them. */
function load(): { registry: Registry; loops: LoopCatalog } {
  const registry = loadRegistry([{ path: root, trusted: true, credentials: [] }], { chain: wb.chain, content: wb.chainBlobs });
  const loops = loadLoops(registry, {
    registry, content: wb.chainBlobs, chain: wb.chain, trusted: [root], output: (l, o) => latestOutput(wb.chain, wb.chainBlobs, l, o),
  }, { max_depth: config.loops.max_depth, max_children: config.loops.max_children });
  return { registry, loops };
}
const investigation = (): ResolvedLoop => load().loops.current("investigation")!;
/** Every file of a folder with its bytes and modification time. */
function snapshot(at: string): Record<string, { bytes: string; mtime: number }> {
  const out: Record<string, { bytes: string; mtime: number }> = {};
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
const tmpOf = (): string[] => (existsSync(join(config.data_dir, "tmp")) ? readdirSync(join(config.data_dir, "tmp")) : []);
/** A loop of one stage that runs `child` as a sub-loop. */
const subloopLoop = (id: string, child: string): string => loopText({
  id, title: id, about: "", profile: "investigation", entry: "sub",
  stages: [{ id: "sub", title: "Sub", order: 1, runs: "loop", role: "subloop", loop: child, inputs: { question: "case.question", observables: "case.observables", window: "case.window" }, returns: { cards: { as: "cards" } }, on_pass: null, on_fail: null }],
  inputs: { question: { type: "question", required: true }, observables: { type: "observables", required: true }, window: { type: "window", required: true } },
  outputs: { cards: { from: "cards.kept" } }, components: {}, uses: {},
}, 1);
const sourceText = (id: string, extra = ""): string => `kind: source
id: ${id}
title: Extra
connector: http
location: http://127.0.0.1:9
marking: "TLP:GREEN"
where: machine
cost: { weight: 1, unit: lookups }
${extra}endpoints:
  - name: lookup
    method: GET
    path: /lookup
    read: true
    rows: rows
    columns: [verdict]
`;

test("checkChange of a valid new loop is ok, lists the file with its kind, id, hash and no before, and leaves the root as it was", () => {
  // every file of the root has the same bytes and mtime after; the temporary copy is gone
  const text = loopText(copyOf(investigation(), "triage", "Triage"), 1);
  const before = snapshot(root);
  const chainLength = wb.chain.read().length;
  const check = checkChange(deps(), root, [{ path: "loops/triage.yaml", text }]);
  expect(check).toEqual({ ok: true, problems: [], files: [{ path: "loops/triage.yaml", kind: "loop", id: "triage", hash: sha256Hex(text), before: null }] });
  expect(snapshot(root)).toEqual(before);
  expect(tmpOf()).toEqual([]);
  expect(wb.chain.read().length).toBe(chainLength);
});

test("checkChange refuses a loop whose on_fail names no stage, one whose entry is missing, one that runs itself and one past the depth cap, each with the loop's own problem", () => {
  const draft = copyOf(investigation(), "broken", "Broken");
  draft.stages[2] = { ...draft.stages[2]!, on_fail: "nowhere" };
  let check = checkChange(deps(), root, [{ path: "loops/broken.yaml", text: loopText(draft, 1) }]);
  expect(check.ok).toBe(false);
  expect(check.problems.join("\n")).toContain(`loop "broken": stage "research": on_fail names "nowhere", which is not a stage of this loop`);

  const noEntry = { ...copyOf(investigation(), "noentry", "No entry"), entry: "missing" };
  check = checkChange(deps(), root, [{ path: "loops/noentry.yaml", text: loopText(noEntry, 1) }]);
  expect(check.ok).toBe(false);
  expect(check.problems.join("\n")).toContain(`loop "noentry": loops/noentry.yaml: entry "missing" is not a stage of this loop`);

  check = checkChange(deps(), root, [{ path: "loops/selfie.yaml", text: subloopLoop("selfie", "selfie") }]);
  expect(check.ok).toBe(false);
  expect(check.problems.join("\n")).toContain(`loop "selfie": a loop may not run itself: selfie > selfie`);

  config.loops.max_depth = 1;
  check = checkChange(deps(), root, [{ path: "loops/outer.yaml", text: subloopLoop("outer", "middle") }, { path: "loops/middle.yaml", text: subloopLoop("middle", "investigation") }]);
  expect(check.ok).toBe(false);
  expect(check.problems).toEqual([`loop "outer": the chain of sub-loops outer > middle > investigation is 2 deep; loops.max_depth is 1`]);
  expect(tmpOf()).toEqual([]);
});

test("checkChange refuses a path with .., an absolute path, a path under data/, a dot-file, and an extension the registry does not read", () => {
  const text = loopText(copyOf(investigation(), "triage", "Triage"), 1);
  const cases: [string, string][] = [
    ["../triage.yaml", "../triage.yaml: a path inside the root, relative and without .."],
    ["loops/../../triage.yaml", "loops/../../triage.yaml: a path inside the root, relative and without .."],
    [join(root, "loops", "triage.yaml"), `${join(root, "loops", "triage.yaml")}: a path inside the root, relative and without ..`],
    ["data/triage.yaml", "data/triage.yaml: the registry does not read a folder named data"],
    ["loops/.triage.yaml", "loops/.triage.yaml: the registry does not read a file or folder whose name starts with ."],
    ["loops/triage.txt", "loops/triage.txt: the registry reads .yaml, .yml and .md files only"],
  ];
  for (const [path, problem] of cases) {
    const check = checkChange(deps(), root, [{ path, text }]);
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual([problem]);
  }
  expect(existsSync(join(dir, "triage.yaml"))).toBe(false);
});

test("checkChange refuses a model, a check, a persona, rules and types: a save may not write a <kind>", () => {
  const files: [string, string, string][] = [
    ["models/other.yaml", "kind: model\nid: other\n", "model"],
    ["checks/99-x.yaml", "kind: check\nid: x\nscript: 99-x.ts\n", "check"],
    ["context/personas/x.md", "---\nkind: persona\nid: x\n---\nYou are x.\n", "persona"],
    ["context/rules2.md", "---\nkind: rules\nid: other-rules\n---\nRules.\n", "rules"],
    ["types2.yaml", "kind: types\ntypes: []\n", "types"],
  ];
  for (const [path, text, kind] of files) {
    expect(WRITABLE_KINDS).not.toContain(kind);
    const check = checkChange(deps(), root, [{ path, text }]);
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual([`${path}: a save may not write a ${kind}`]);
  }
});

test("checkChange refuses a source that names a credential the configuration does not grant to the root, with the registry's sentence", () => {
  const check = checkChange(deps(), root, [{ path: "sources/extra.yaml", text: sourceText("extra", "credential: extra-token\n") }]);
  expect(check.ok).toBe(false);
  expect(check.problems).toEqual([`sources/extra.yaml: source names credential "extra-token", which the configuration does not grant to this root`]);
  // granted, it passes
  config.roots[0]!.credentials.push("extra-token");
  expect(checkChange(deps(), root, [{ path: "sources/extra.yaml", text: sourceText("extra", "credential: extra-token\n") }]).problems).toEqual([]);
});

test("checkChange refuses a pivot whose query the guard refuses and one whose extract pattern does not compile", () => {
  const pivot = (id: string, query: string, columns = ""): string => `kind: pivots
pivots:
  - id: ${id}
    title: Extra
    from: address
    to: address
    source: flows
    query: "${query}"
    needs_window: true
    empty_means: not-seen
    yields: { peer: address }
    times: { at: ts }
${columns}`;
  let check = checkChange(deps(), root, [{ path: "pivots/extra.yaml", text: pivot("extra_delete", "delete from flows where dst = {value} and ts >= {window.from} and ts < {window.to}") }]);
  expect(check.ok).toBe(false);
  expect(check.problems.length).toBe(1);
  expect(check.problems[0]).toStartWith(`pivots/extra.yaml: pivot "extra_delete": `);

  check = checkChange(deps(), root, [{ path: "pivots/extra.yaml", text: pivot("extra_regex", "select src as peer, ts from flows where dst = {value} and ts >= {window.from} and ts < {window.to}", `    columns:\n      peer: { extract: [{ id: bad, type: address, pattern: "(" }] }\n`) }]);
  expect(check.ok).toBe(false);
  expect(check.problems.length).toBe(1);
  expect(check.problems[0]).toStartWith("pivots/extra.yaml: ");
  expect(check.problems[0]).toContain("does not compile");

  // a good one passes
  expect(checkChange(deps(), root, [{ path: "pivots/extra.yaml", text: pivot("extra_ok", "select src as peer, ts from flows where dst = {value} and ts >= {window.from} and ts < {window.to}") }]).problems).toEqual([]);
});

test("checkChange refuses a file that holds a secret value, without repeating the value", () => {
  const secret = "s3cret-value-for-tests";
  const check = checkChange({ ...deps(), secrets: [secret, "short"] }, root, [{ path: "sources/extra.yaml", text: sourceText("extra", `quality: the token is ${secret}\n`) }]);
  expect(check.ok).toBe(false);
  expect(check.problems).toEqual(["sources/extra.yaml: it holds the value of a secret the workbench keeps; it is not saved"]);
  expect(JSON.stringify(check)).not.toContain(secret);
  // a value shorter than 8 characters is not searched for
  expect(checkChange({ ...deps(), secrets: ["short"] }, root, [{ path: "sources/extra.yaml", text: sourceText("extra", "quality: short\n") }]).ok).toBe(true);
});

test("checkChange validates every file it is given, whether or not a loop names it: a stage, a source, a pivot and a playbook that no loop uses", () => {
  // controller ruling (Task 17): a stage file no loop names is checked as a stage, so a bad one is never written to wait for a loop to meet it
  const stage = "kind: stage\nid: lonely\ntitle: Lonely\norder: 99\nphase: test\nruns: agent\nrole: oracle\ngate: null\nreviews: false\ntools: []\nschema: null\nmodel: null\non_pass: null\non_fail: null\n";
  let check = checkChange(deps(), root, [{ path: "stages/lonely.yaml", text: stage }]);
  expect(check.ok).toBe(false);
  expect(check.problems.length).toBe(1);
  expect(check.problems[0]).toStartWith(`stages/lonely.yaml: stage "lonely": `);
  expect(check.problems[0]).toContain(`role "oracle"`);
  // the same stage with a role a stage may have passes
  expect(checkChange(deps(), root, [{ path: "stages/lonely.yaml", text: stage.replace("role: oracle", "role: feedback").replace("runs: agent", "runs: human") }]).problems).toEqual([]);

  check = checkChange(deps(), root, [{ path: "sources/lonely.yaml", text: sourceText("lonely").replace("connector: http", "connector: carrier-pigeon") }]);
  expect(check.ok).toBe(false);
  expect(check.problems[0]).toStartWith("sources/lonely.yaml: ");

  check = checkChange(deps(), root, [{ path: "pivots/lonely.yaml", text: "kind: pivots\npivots:\n  - id: lonely\n    title: Lonely\n    from: address\n    to: nothing-at-all\n    source: flows\n" }]);
  expect(check.ok).toBe(false);
  expect(check.problems[0]).toStartWith("pivots/lonely.yaml: ");

  check = checkChange(deps(), root, [{ path: "playbooks/lonely.yaml", text: "kind: playbook\nid: lonely\ntitle: Lonely\ninputs: []\nsteps:\n  - { id: a, pivot: no_such_pivot, from: input.nothing }\nend: [a]\n" }]);
  expect(check.ok).toBe(false);
  expect(check.problems[0]).toStartWith("playbooks/lonely.yaml: ");
});

test("checkChange refuses a change that leaves another loop unusable: a stage manifest another loop names, edited so that loop's graph breaks", () => {
  const research = readFileSync(join(root, "stages", "research.yaml"), "utf8");
  const check = checkChange(deps(), root, [{ path: "stages/research.yaml", text: research.replace("on_fail: plan", "on_fail: nowhere") }]);
  expect(check.ok).toBe(false);
  expect(check.problems).toEqual([`loop "investigation": stage "research": on_fail names "nowhere", which is not a stage of this loop`]);
  expect(check.files).toEqual([{ path: "stages/research.yaml", kind: "stage", id: "research", hash: sha256Hex(research.replace("on_fail: plan", "on_fail: nowhere")), before: sha256Hex(research) }]);
  expect(readFileSync(join(root, "stages", "research.yaml"), "utf8")).toBe(research);
});

test("saveManifests by a person writes the files, appends manifest.written for each with before and after hashes, and the next load holds them", () => {
  const research = readFileSync(join(root, "stages", "research.yaml"), "utf8");
  const edited = research.replace("title: Research", "title: Research, edited");
  const loop = loopText(copyOf(investigation(), "triage", "Triage"), 1);
  const files: ManifestFile[] = [{ path: "loops/triage.yaml", text: loop }, { path: "stages/research.yaml", text: edited }];
  const at = wb.chain.read().length;
  const check = saveManifests(deps(), root, files, { actor: human, why: "save", session: null });
  expect(check.ok).toBe(true);
  expect(readFileSync(join(root, "loops", "triage.yaml"), "utf8")).toBe(loop);
  expect(readFileSync(join(root, "stages", "research.yaml"), "utf8")).toBe(edited);
  const written = wb.chain.read().slice(at);
  expect(written.map((e) => [e.type, e.actor, e.payload]) as unknown[]).toEqual([
    ["manifest.written", human, { root, path: "loops/triage.yaml", kind: "loop", id: "triage", hash: sha256Hex(loop), before: null, why: "save", session: null }],
    ["manifest.written", human, { root, path: "stages/research.yaml", kind: "stage", id: "research", hash: sha256Hex(edited), before: sha256Hex(research), why: "save", session: null }],
  ]);
  const { registry, loops } = load();
  expect(registry.get("stage", "research")!.title).toBe("Research, edited");
  expect(loops.current("triage")).not.toBeNull();
  // no temporary file is left beside the written ones
  expect(readdirSync(join(root, "loops")).sort()).toEqual(["investigation.yaml", "triage.yaml"]);
  expect(readdirSync(join(root, "stages")).filter((n) => n.startsWith("."))).toEqual([]);
  expect(tmpOf()).toEqual([]);
});

test("saveManifests by code or by an agent is refused and nothing is written or checked", () => {
  const loop = loopText(copyOf(investigation(), "triage", "Triage"), 1);
  // deps that throw when read: the refusal comes before anything is read
  const untouchable = new Proxy({}, { get: () => { throw new Error("read"); } }) as ReturnType<typeof deps>;
  for (const actor of [{ kind: "system", id: "engine" }, { kind: "agent", id: "builder" }] as Actor[]) {
    let thrown: unknown = null;
    try { saveManifests(untouchable, root, [{ path: "loops/triage.yaml", text: loop }], { actor, why: "builder", session: null }); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(WriteRefused);
    expect((thrown as Error).message).toBe("only a person may write a manifest into a root");
  }
  expect(existsSync(join(root, "loops", "triage.yaml"))).toBe(false);
  expect(wb.chain.read().some((e) => e.type === "manifest.written")).toBe(false);
});

test("saveManifests of a file that fails the check writes none of the files", () => {
  const loop = loopText(copyOf(investigation(), "triage", "Triage"), 1);
  const before = snapshot(root);
  const check = saveManifests(deps(), root, [{ path: "loops/triage.yaml", text: loop }, { path: "models/other.yaml", text: "kind: model\nid: other\n" }], { actor: human, why: "save", session: null });
  expect(check.ok).toBe(false);
  expect(check.problems).toEqual(["models/other.yaml: a save may not write a model"]);
  expect(snapshot(root)).toEqual(before);
  expect(wb.chain.read().some((e) => e.type === "manifest.written")).toBe(false);
});

test("copyOf writes every stage inline, so editing the copy's research stage changes no other loop's hash", () => {
  const original = investigation();
  const draft = copyOf(original, "inv-copy", "Investigation, copied");
  expect(draft.stages.map((s) => s.id)).toEqual(original.pipeline.stages.map((s) => s.id));
  expect(draft.stages.every((s) => typeof s === "object" && s.kind === undefined)).toBe(true);
  expect(draft).toMatchObject({ id: "inv-copy", title: "Investigation, copied", profile: "investigation", entry: "frame" });
  expect(copyLoop({ ...deps(), loops: load().loops }, "investigation", "inv-copy", "Investigation, copied", { actor: human }).ok).toBe(true);
  const copied = load().loops.current("inv-copy")!;
  expect(copied.manifest.version).toBe(1);
  expect(copied.pipeline.stages.every((s) => s.inline === true)).toBe(true);
  // the copy runs what the original runs: the same stages, in the same order, with the same components
  expect(copied.pipeline.stages.map(({ hash: _h, inline: _i, ...s }) => s)).toEqual(original.pipeline.stages.map(({ hash: _h, inline: _i, ...s }) => s));
  expect(copied.components.items()).toEqual(original.components.items());

  const edited = draftOf(copied);
  const at = edited.stages.findIndex((s) => s.id === "research");
  edited.stages[at] = { ...edited.stages[at]!, title: "Research, the copy's own" };
  expect(saveLoop({ ...deps(), loops: load().loops }, edited, 1, { actor: human }).ok).toBe(true);
  const after = load().loops;
  expect(after.current("inv-copy")!.manifest.version).toBe(2);
  expect(after.current("inv-copy")!.pipeline.hash).not.toBe(copied.pipeline.hash);
  expect(after.current("investigation")!.pipeline.hash).toBe(original.pipeline.hash);
  expect(readFileSync(join(root, "loops", "inv-copy.yaml"), "utf8").split("\n")[0]).toBe("# written by the workbench; edit it in the Loops page or by hand");
  // a copy over a loop that exists is refused
  expect(() => copyLoop({ ...deps(), loops: after }, "investigation", "inv-copy", "Again", { actor: human })).toThrow(`there is already a loop "inv-copy"`);
});

test("saving a loop twice gives versions 2 and 3, and each version's lock is in the content store after a reload", () => {
  const locks: string[] = [];
  for (const [n, about] of [[2, "first edit"], [3, "second edit"]] as const) {
    const { loops } = load();
    const loop = loops.current("investigation")!;
    const draft = { ...draftOf(loop), about };
    expect(saveLoop({ ...deps(), loops }, draft, loop.manifest.version, { actor: human }).ok).toBe(true);
    const now = load().loops.current("investigation")!;
    expect(now.manifest.version).toBe(n);
    expect(now.manifest.about).toBe(about);
    locks.push(sha256Hex(canonical(now.lock as unknown as Json)));
  }
  expect(new Set(locks).size).toBe(2);
  for (const h of locks) expect(wb.chainBlobs.has(h)).toBe(true);
  // a save against a version other than the current one is refused
  const { loops } = load();
  expect(() => saveLoop({ ...deps(), loops }, draftOf(loops.current("investigation")!), 2, { actor: human })).toThrow("the loop changed since you opened it");
  expect(wb.chain.read().filter((e) => e.type === "manifest.written").map((e) => e.type === "manifest.written" && e.payload.why)).toEqual(["save", "save"]);
});

test("the first save into a root with only the implicit loop also writes loops/investigation.yaml, and the implicit loop's legacy hash is the explicit one's", () => {
  rmSync(join(root, "loops"), { recursive: true });
  const implicit = load().loops;
  expect(implicit.list().find((x) => x.id === "investigation")!.problems).toEqual([IMPLICIT_NOTE]);
  const was = implicit.current("investigation")!;
  expect(was.manifest.implicit).toBe(true);
  expect(writeRoot(config, was.manifest)).toBe(root);
  const check = copyLoop({ ...deps(), loops: implicit }, "investigation", "triage", "Triage", { actor: human });
  expect(check.ok).toBe(true);
  expect(check.files.map((f) => [f.path, f.kind, f.id, f.before])).toEqual([["loops/triage.yaml", "loop", "triage", null], ["loops/investigation.yaml", "loop", "investigation", null]]);
  const now = load().loops;
  const explicit = now.current("investigation")!;
  expect(explicit.manifest.implicit).toBe(false);
  expect(explicit.manifest.version).toBe(1);
  expect(explicit.pipeline.legacy_hash).toBe(was.pipeline.legacy_hash!);
  expect(explicit.pipeline.stages.map((s) => s.id)).toEqual(was.pipeline.stages.map((s) => s.id));
  expect(now.current("triage")).not.toBeNull();
  expect(wb.chain.read().filter((e) => e.type === "manifest.written").map((e) => e.type === "manifest.written" && [e.payload.path, e.payload.why])).toEqual([["loops/triage.yaml", "copy"], ["loops/investigation.yaml", "copy"]]);
});

test("writeRoot is the trusted root that holds the loop, else the first trusted root, and refuses when there is none", () => {
  const other = join(dir, "other");
  mkdirSync(other);
  writeFileSync(join(other, "x.yaml"), "kind: model\nid: x\n");
  config.roots = [{ path: other, trusted: false, credentials: [] }, { path: root, trusted: true, credentials: [] }];
  expect(writeRoot(config, null)).toBe(root);
  expect(writeRoot(config, investigation().manifest)).toBe(root);
  config.roots = [{ path: root, trusted: false, credentials: [] }];
  expect(() => writeRoot(config, null)).toThrow(WriteRefused);
  // checkChange refuses a root the configuration does not trust
  expect(checkChange(deps(), root, [{ path: "loops/x.yaml", text: "kind: loop\n" }]).problems).toEqual(["the folder to save into is not a trusted root of the configuration"]);
});
