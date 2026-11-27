import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Json } from "../../src/core/canonical";
import { parseJson } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { Entry, EntryType, Marking, Where } from "../../src/core/types";
import { MARKINGS } from "../../src/core/types";
import { loadProfile, partOf } from "../../src/agents/context";
import { runAgent } from "../../src/agents/loop";
import { assemblePack } from "../../src/agents/pack";
import { ScriptedProvider } from "../../src/agents/providers/scripted";
import { BUILDER_TOOL_NAMES, execTool, parseCall, STAGE_TOOL_NAMES, TOOL_NAMES, TOOLS } from "../../src/agents/tools";
import type { ToolResult } from "../../src/agents/tools";
import { BUILDER_TOOLS } from "../../src/agents/tools/builder";
import { copyOf, loopText } from "../../src/modules/loop-write";
import { builderAgent, builderFixture, fixture, INJECTED, PLANTED } from "../helpers/tools-fixture";
import type { BuilderFixture } from "../helpers/tools-fixture";

let f: BuilderFixture;
beforeEach(() => { f = builderFixture(); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});

const ofType = <T extends EntryType>(t: T): Extract<Entry, { type: T }>[] => f.s.entries().filter((e): e is Extract<Entry, { type: T }> => e.type === t);
const view = <T>(r: ToolResult): T => r.view as unknown as T;
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
const READ_TOOLS = ["loop_catalogue", "adapter_catalogue", "list_connectors", "list_roots"] as const;
const stageText = (id: string, extra = ""): string => `kind: stage
id: ${id}
title: Note
order: 10
phase: direction
runs: agent
role: frame
gate: null
reviews: false
tools: [list_sources]
schema: frame-output
model: { provider: scripted, model: sample-run, effort: null }
on_pass: null
on_fail: null
${extra}`;
const sourceText = (id: string, extra = ""): string => `kind: source
id: ${id}
title: Extra
connector: http
location: http://127.0.0.1:9
marking: "TLP:GREEN"
where: machine
cost: { weight: 1, unit: lookups }
endpoints:
  - name: lookup
    method: GET
    path: /v1/x/{value}
    rows: results
    columns: [address]
${extra}`;
const pivotText = (id: string, query: string, columns = ""): string => `kind: pivots
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
const subloopLoop = (id: string, child: string): string => loopText({
  id, title: id, about: "", profile: "investigation", entry: "sub",
  stages: [{ id: "sub", title: "Sub", order: 1, runs: "loop", role: "subloop", loop: child, inputs: { question: "case.question", observables: "case.observables", window: "case.window" }, returns: { cards: { as: "cards" } }, on_pass: null, on_fail: null }],
  inputs: { question: { type: "question", required: true }, observables: { type: "observables", required: true }, window: { type: "window", required: true } },
  outputs: { cards: { from: "cards.kept" } }, components: {}, uses: {},
}, 1);
const CREDENTIAL = "a credential is named by reference; set its value outside the workbench";

// ---------- the read tools ----------

test("loop_catalogue lists investigation and triage with their stages, gates, edges and the loop a stage runs", async () => {
  const r = await f.call("loop_catalogue", { why: "see the loops" });
  expect(r.ok).toBe(true);
  expect(r.marking).toBeNull();
  type Loop = { id: string; title: string; usable: boolean; version: number | null; hash: string | null; problems: string[]; stages: { id: string; runs: string; gate: string | null; on_pass: string | null; on_fail: string | null; loop: string | null }[] };
  const loops = view<{ loops: Loop[] }>(r).loops;
  const inv = loops.find((l) => l.id === "investigation")!;
  const tri = loops.find((l) => l.id === "triage")!;
  expect(inv.usable).toBe(true);
  expect(inv.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(inv.stages.map((s) => s.id)).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"]);
  expect(inv.stages.find((s) => s.id === "plan")!.gate).toBe("plan");
  expect(inv.stages.find((s) => s.id === "publish")!.gate).toBe("publish");
  expect(inv.stages.find((s) => s.id === "frame")!.on_pass).toBe("plan");
  expect(inv.stages.find((s) => s.id === "research")!.on_fail).toBe("plan");
  expect(tri.usable).toBe(true);
  expect(tri.stages.map((s) => [s.id, s.runs, s.loop])).toEqual([["sort", "agent", null], ["investigate", "loop", "investigation"]]);
  expect(tri.stages[0]!.on_pass).toBe("investigate");
});

test("adapter_catalogue gives each adapter's purpose, each field's meaning, reveals and extract rules, and where an extracted type leads", async () => {
  const r = await f.call("adapter_catalogue", { why: "see the adapters" });
  expect(r.ok).toBe(true);
  expect(r.marking).toBeNull();
  type Adapter = { id: string; purpose: string; access: { connector: string; needs_credential: boolean }; fields: { table: string; name: string; meaning: string; reveals: string; extract: { id: string; type: string; leads: string[] }[] }[]; in: { pivot: string }[] };
  const cat = view<{ adapters: Adapter[]; pivots: { id: string; from: string }[]; types: { id: string }[]; playbooks: { id: string }[]; inventories: { id: string }[] }>(r);
  const lake = cat.adapters.find((a) => a.id === "lakehouse")!;
  expect(lake.purpose).toBe("Events kept in the lake.");
  expect(lake.access.connector).toBe("trino");
  expect(lake.access.needs_credential).toBe(true);
  expect(lake.fields.find((x) => x.name === "src")!.meaning).toBe("the address that sent the event");
  // a field with an extract rule names the pivots its type leads to
  const ruled = cat.adapters.flatMap((a) => a.fields).filter((x) => x.extract.length > 0);
  expect(ruled.length).toBeGreaterThan(0);
  const rule = ruled[0]!.extract[0]!;
  expect(rule.leads).toEqual(cat.pivots.filter((p) => p.from === rule.type).map((p) => p.id));
  expect(cat.adapters.find((a) => a.id === "flows")!.in.map((i) => i.pivot)).toContain("address_to_internal_peers");
  expect(cat.types.map((t) => t.id)).toContain("address");
  expect(cat.playbooks.length).toBeGreaterThan(0);
  expect(Array.isArray(cat.inventories)).toBe(true);
  // the untrusted root's text is withheld: an order hidden in it never reaches the model
  const notes = cat.adapters.find((a) => a.id === "notes")!;
  expect(notes.purpose).toBe("");
  expect(JSON.stringify(r.view)).not.toContain(INJECTED);
});

test("no view of any builder tool holds a source's location, user, credential value or an absolute path", async () => {
  // a source with location http://lake.example.net:8443, user svc_reader, credential lake whose secret is planted: JSON.stringify of every view holds none of the four
  const views: Json[] = [];
  for (const name of READ_TOOLS) {
    const r = await f.call(name, { why: "look" });
    expect(r.ok).toBe(true);
    views.push(r.view);
  }
  views.push((await f.call("validate_manifest", { why: "w", path: "sources/lakehouse.yaml", text: readFileSync(join(f.root, "sources", "lakehouse.yaml"), "utf8") })).view);
  views.push((await f.call("validate_manifest", { why: "w", path: "sources/x.yaml", text: sourceText("x", `quality: ${PLANTED.file}\n`) })).view);
  views.push((await f.call("propose_change", { why: "w", title: "t", files: [{ path: "sources/x.yaml", text: sourceText("x", `quality: ${PLANTED.vault}\n`) }] })).view);
  views.push((await f.call("propose_change", { why: "w", title: "t", files: [{ path: "sources/x.yaml", text: sourceText("x", `quality: see ${PLANTED.env}\n`) }] })).view);
  views.push((await f.call("request_probe", { why: "w", kind: "query", source: "flows", text: `select '${PLANTED.env}'` })).view);
  // the reader the server gives the builder hides the same
  const read = f.ctx.builder!.read("sources/lakehouse.yaml");
  expect(read).not.toBeNull();
  views.push(read!);
  const text = JSON.stringify(views);
  for (const bad of [PLANTED.host, PLANTED.vault_host, PLANTED.user, PLANTED.file, PLANTED.vault, PLANTED.env, f.dir, f.root, INJECTED]) expect(text).not.toContain(bad);
  // and nothing the tools wrote holds a credential value either
  const ledger = f.ledgerText();
  for (const bad of [PLANTED.file, PLANTED.vault, PLANTED.env]) expect(ledger).not.toContain(bad);
  expect(ofType("builder.proposed")).toEqual([]);
  expect(ofType("builder.probe_asked")).toEqual([]);
});

test("list_connectors names the four connector kinds and which are trusted-only", async () => {
  const r = await f.call("list_connectors", { why: "which kinds" });
  expect(r.ok).toBe(true);
  expect(r.marking).toBeNull();
  const kinds = view<{ connectors: { kind: string; trusted_only: boolean; needs: string[]; credential: string }[] }>(r).connectors;
  expect(kinds.map((k) => k.kind)).toEqual(["sql", "files", "http", "trino"]);
  expect(Object.fromEntries(kinds.map((k) => [k.kind, k.trusted_only]))).toEqual({ sql: false, files: false, http: true, trino: true });
  for (const k of kinds) {
    expect(k.needs).toContain("location");
    expect(k.credential).toContain("credential: <name>");
  }
});

test("list_roots names roots by their last segment, with trust, whether a save may write there, and credential names only", async () => {
  const r = await f.call("list_roots", { why: "where" });
  expect(r.ok).toBe(true);
  expect(r.view).toEqual({
    write_root: "sample",
    roots: [
      { name: "sample", trusted: true, writable: true, credentials: ["lake_reader", "vault_kv_lake", "env_lake"], imported: false },
      { name: "evil-0123456789ab", trusted: false, writable: false, credentials: [], imported: true },
    ],
  });
});

test("every builder tool refuses outside a builder session: this tool is the loop builder's", async () => {
  expect([...BUILDER_TOOL_NAMES].sort() as string[]).toEqual(BUILDER_TOOLS.map((t): string => t.name).sort());
  expect([...TOOL_NAMES]).toEqual([...STAGE_TOOL_NAMES, ...BUILDER_TOOL_NAMES]);
  for (const t of BUILDER_TOOL_NAMES) expect(STAGE_TOOL_NAMES.includes(t)).toBe(false);
  const args: Record<string, Record<string, Json>> = {
    loop_catalogue: {}, adapter_catalogue: {}, list_connectors: {}, list_roots: {},
    validate_manifest: { path: "stages/x.yaml", text: stageText("x") },
    propose_change: { title: "t", files: [{ path: "stages/x.yaml", text: stageText("x") }] },
    request_probe: { kind: "pivot", source: "flows", pivot: "address_to_internal_peers", value: "198.51.100.77" },
  };
  // a case's tool context, with no builder
  const c = fixture(false);
  try {
    for (const name of BUILDER_TOOL_NAMES) {
      const r = await execTool(c.ctx, parseCall(TOOL_NAMES, name, JSON.stringify({ why: "w", ...args[name] })));
      expect(r).toEqual({ ok: false, summary: "this tool is the loop builder's", view: { error: "this tool is the loop builder's" }, marking: null });
    }
    // a builder context put on a case's session is refused all the same
    const borrowed = { ...c.ctx, builder: f.ctx.builder };
    for (const name of BUILDER_TOOL_NAMES) {
      const r = await execTool(borrowed, parseCall(TOOL_NAMES, name, JSON.stringify({ why: "w", ...args[name] })));
      expect(r.summary).toBe("this tool is the loop builder's");
    }
    expect(c.s.entries().map((e) => e.type)).toEqual(["case.created"]);
    expect(c.s.state.skipped).toEqual([]);
  } finally {
    c.close();
  }
  // in the builder session with no builder context
  const bare = { ...f.ctx };
  delete bare.builder;
  for (const name of BUILDER_TOOL_NAMES) {
    expect((await execTool(bare, parseCall(TOOL_NAMES, name, JSON.stringify({ why: "w", ...args[name] })))).summary).toBe("this tool is the loop builder's");
  }
  // every builder tool requires why and refuses unknown arguments, as every tool does
  for (const name of BUILDER_TOOL_NAMES) {
    expect(TOOLS[name].parameters.required).toContain("why");
    expect(TOOLS[name].parameters.additionalProperties).toBe(false);
  }
});

// ---------- propose and probe ----------

test("validate_manifest answers ok for a valid stage and the registry's own sentence for an invalid one, and writes no entry but its own tool.called and tool.returned", async () => {
  const head = f.s.head().seq;
  const good = await f.call("validate_manifest", { why: "w", path: "stages/note.yaml", text: stageText("note") });
  expect(good.ok).toBe(true);
  expect(good.view).toEqual({ ok: true, problems: [], files: [{ path: "stages/note.yaml", kind: "stage", id: "note", new_file: true }] });
  const research = readFileSync(join(f.root, "stages", "research.yaml"), "utf8");
  const bad = await f.call("validate_manifest", { why: "w", path: "stages/research.yaml", text: research.replace("on_fail: plan", "on_fail: nowhere") });
  expect(bad.ok).toBe(true);
  expect(view<{ ok: boolean }>(bad).ok).toBe(false);
  expect(view<{ problems: string[] }>(bad).problems).toContain(`loop "investigation": stage "research": on_fail names "nowhere", which is not a stage of this loop`);
  expect(view<{ files: unknown[] }>(bad).files).toEqual([]);
  // a stage a loop names is checked as that loop's stage, with the loop's own sentence
  const frame = readFileSync(join(f.root, "stages", "frame.yaml"), "utf8");
  const oracle = await f.call("validate_manifest", { why: "w", path: "stages/frame.yaml", text: frame.replace("role: frame", "role: oracle") });
  expect(view<{ problems: string[] }>(oracle).problems.join("\n")).toContain(`role "oracle" is not one of`);
  const tool = await f.call("validate_manifest", { why: "w", path: "stages/frame.yaml", text: frame.replace("[list_sources, describe_source]", "[list_sources, propose_change]") });
  expect(view<{ ok: boolean; problems: string[] }>(tool).ok).toBe(false);
  expect(view<{ problems: string[] }>(tool).problems.join("\n")).toContain(`"propose_change" is the loop builder's, not a stage's`);
  expect(f.s.head().seq).toBe(head);

  // through the agent loop: the call and its result are the only entries a tool adds
  const POLICY = Object.fromEntries(MARKINGS.map((m): [Marking, Where[]] => [m, ["machine"]])) as Record<Marking, Where[]>;
  const provider = new ScriptedProvider({ id: "p", scripts: [{ id: "m", turns: [
    { actor: builderAgent.id, reply: { tool_calls: [{ tool: "validate_manifest", args: { why: "check it", path: "stages/note.yaml", text: stageText("note") } }] } },
    { actor: builderAgent.id, reply: { content: "it is valid" } },
  ] }] });
  const pk = assemblePack([{ kind: "rules", id: "r", title: "Rules", text: "be careful", marking: null, fixed: true }], { budget: 10000, case_marking: "TLP:CLEAR", max_marking: null });
  if ("too_big" in pk) throw new Error("pack too big");
  const before = f.s.head().seq;
  const end = await runAgent(f.s, { actor: builderAgent, provider, model: "m", effort: null, pack: pk, task: "check", tools: BUILDER_TOOL_NAMES, ctx: f.ctx, schema: null, policy: POLICY, max_marking: null, outside_run: true });
  expect(end.kind).toBe("done");
  const added = f.s.entries(before).map((e) => e.type);
  expect(added.filter((t) => t === "tool.called" || t === "tool.returned")).toEqual(["tool.called", "tool.returned"]);
  expect(added.filter((t) => !t.startsWith("model.") && t !== "tool.called" && t !== "tool.returned")).toEqual([]);
  expect(ofType("tool.returned")[0]!.payload.ok).toBe(true);
});

test("propose_change with valid files records one builder.proposed with each file's kind, id, before and after hashes and a bundle blob that holds the texts", async () => {
  const skillPath = "context/skills/ask-the-person.md";
  const skillBefore = readFileSync(join(f.root, ...skillPath.split("/")), "utf8");
  const skill = skillBefore.replace("Ask one thing at a time, and ask early.", "Ask one thing at a time.");
  const loop = loopText(copyOf(f.loops.current("triage")!, "quick", "Quick"), 1);
  const r = await f.call("propose_change", { why: "a quicker triage", title: "Add a quick loop", files: [{ path: skillPath, text: skill }, { path: "loops/quick.yaml", text: loop }] });
  expect(r.ok).toBe(true);
  expect(r.summary).toContain("chg-1");
  const proposed = ofType("builder.proposed");
  expect(proposed.length).toBe(1);
  const p = proposed[0]!;
  expect(p.actor).toEqual(builderAgent);
  expect(p.payload.change).toBe("chg-1");
  expect(p.payload.title).toBe("Add a quick loop");
  expect(p.payload.why).toBe("a quicker triage");
  expect(p.payload.root).toBe("sample");
  expect(p.payload.files).toEqual([
    { path: skillPath, kind: "skill", id: "ask-the-person", before: sha256Hex(new TextEncoder().encode(skillBefore)), after: sha256Hex(new TextEncoder().encode(skill)) },
    { path: "loops/quick.yaml", kind: "loop", id: "quick", before: null, after: sha256Hex(new TextEncoder().encode(loop)) },
  ]);
  const bundle = parseJson(f.s.blobs.text(p.payload.bundle.blob))!.value as { files: { path: string; text: string }[] };
  expect(bundle).toEqual({ files: [{ path: skillPath, text: skill }, { path: "loops/quick.yaml", text: loop }] });
  expect(f.s.state.builder.changes["chg-1"]!.files.map((x) => x.decided)).toEqual([null, null]);
  expect(view<{ change: string; files: { path: string; new_file: boolean }[] }>(r)).toMatchObject({ change: "chg-1", files: [{ path: skillPath, new_file: false }, { path: "loops/quick.yaml", new_file: true }] });
});

test("propose_change with a loop whose on_fail names no stage records no proposal and returns that problem", async () => {
  const draft = copyOf(f.loops.current("investigation")!, "broken", "Broken");
  draft.stages[2] = { ...draft.stages[2]!, on_fail: "nowhere" };
  const r = await f.call("propose_change", { why: "w", title: "Broken", files: [{ path: "loops/broken.yaml", text: loopText(draft, 1) }] });
  expect(r.ok).toBe(false);
  expect(r.summary).toContain(`loop "broken": stage "research": on_fail names "nowhere", which is not a stage of this loop`);
  expect(ofType("builder.proposed")).toEqual([]);
  expect(f.s.entries().map((e) => e.type)).toEqual(["case.created", "case.loop_set"]);
});

test("propose_change with a pivot the guard refuses, an extract pattern that does not compile, and a loop past the depth cap each record no proposal", async () => {
  const del = await f.call("propose_change", { why: "w", title: "t", files: [{ path: "pivots/extra.yaml", text: pivotText("extra_delete", "delete from flows where dst = {value} and ts >= {window.from} and ts < {window.to}") }] });
  expect(del.ok).toBe(false);
  expect(del.summary).toContain(`pivots/extra.yaml: pivot "extra_delete": `);
  const regex = await f.call("propose_change", { why: "w", title: "t", files: [{ path: "pivots/extra.yaml", text: pivotText("extra_regex", "select src as peer, ts from flows where dst = {value} and ts >= {window.from} and ts < {window.to}", `    columns:\n      peer: { extract: [{ id: bad, type: address, pattern: "(" }] }\n`) }] });
  expect(regex.ok).toBe(false);
  expect(regex.summary).toContain("does not compile");
  // max_depth is 2: outer > middle > inner > investigation is 3 deep
  const deep = await f.call("propose_change", { why: "w", title: "t", files: [
    { path: "loops/outer.yaml", text: subloopLoop("outer", "middle") }, { path: "loops/middle.yaml", text: subloopLoop("middle", "inner") }, { path: "loops/inner.yaml", text: subloopLoop("inner", "investigation") },
  ] });
  expect(deep.ok).toBe(false);
  expect(deep.summary).toContain("loops.max_depth is 2");
  expect(ofType("builder.proposed")).toEqual([]);
  expect(f.s.head().seq).toBe(2);
});

test("propose_change with a file that holds a planted secret value, or a key named password, records no proposal and does not repeat the value", async () => {
  for (const value of [PLANTED.file, PLANTED.vault, PLANTED.env]) {
    const r = await f.call("propose_change", { why: "w", title: "t", files: [{ path: "sources/extra.yaml", text: sourceText("extra", `quality: "the key is ${value}"\n`) }] });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe(`sources/extra.yaml: ${CREDENTIAL}`);
    expect(JSON.stringify(r)).not.toContain(value);
  }
  const keys = ["password", "token", "secret", "api_key", "apikey", "Password"];
  for (const key of keys) {
    // at any depth: a key of a table is as much a credential as one at the top
    for (const text of [sourceText("extra").replace("where: machine", `where: machine\n${key}: hunter2-not-a-real-one`), sourceText("extra").replace("    rows: results", `    rows: results\n    ${key}: hunter2-not-a-real-one`)]) {
      const r = await f.call("propose_change", { why: "w", title: "t", files: [{ path: "sources/extra.yaml", text }] });
      expect(r.ok).toBe(false);
      expect(r.summary).toBe(`sources/extra.yaml: ${CREDENTIAL}`);
      expect(JSON.stringify(r)).not.toContain("hunter2");
      const v = await f.call("validate_manifest", { why: "w", path: "sources/extra.yaml", text });
      expect(v.view).toEqual({ ok: false, problems: [`sources/extra.yaml: ${CREDENTIAL}`], files: [] });
    }
  }
  // naming the credential by reference is how it is done, and passes
  const named = await f.call("validate_manifest", { why: "w", path: "sources/extra.yaml", text: sourceText("extra", "credential: env_lake\n") });
  expect(view<{ ok: boolean }>(named).ok).toBe(true);
  expect(ofType("builder.proposed")).toEqual([]);
  const ledger = f.ledgerText();
  for (const value of [PLANTED.file, PLANTED.vault, PLANTED.env, "hunter2"]) expect(ledger).not.toContain(value);
});

test("propose_change with a check, a model, a persona or rules is refused: a save may not write a <kind>", async () => {
  const files: [string, string, string][] = [
    ["checks/99-x.yaml", "kind: check\nid: x\nscript: 99-x.ts\n", "check"],
    ["models/other.yaml", "kind: model\nid: other\n", "model"],
    ["context/personas/x.md", "---\nkind: persona\nid: x\n---\nYou are x.\n", "persona"],
    ["context/rules2.md", "---\nkind: rules\nid: other-rules\n---\nRules.\n", "rules"],
  ];
  for (const [path, text, kind] of files) {
    const r = await f.call("propose_change", { why: "w", title: "t", files: [{ path, text }] });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain(`${path}: a save may not write a ${kind}`);
  }
  expect(ofType("builder.proposed")).toEqual([]);
});

test("propose_change writes nothing under any root", async () => {
  // every file of the root has the same bytes after
  const before = snapshot(f.root);
  const imported = snapshot(f.config.loops.imports);
  const loop = loopText(copyOf(f.loops.current("triage")!, "quick", "Quick"), 1);
  expect((await f.call("propose_change", { why: "w", title: "t", files: [{ path: "loops/quick.yaml", text: loop }, { path: "stages/note.yaml", text: stageText("note") }] })).ok).toBe(true);
  expect((await f.call("propose_change", { why: "w", title: "t", files: [{ path: "loops/quick.yaml", text: "kind: loop\nid: quick\n" }] })).ok).toBe(false);
  expect(snapshot(f.root)).toEqual(before);
  expect(snapshot(f.config.loops.imports)).toEqual(imported);
  expect(ofType("builder.proposed").length).toBe(1);
});

test("request_probe for a loaded pivot and a value of its type records builder.probe_asked and returns waiting for the person's approval; no query entry is written", async () => {
  const r = await f.call("request_probe", { why: "see who talks to it", kind: "pivot", source: "flows", pivot: "address_to_internal_peers", value: "198.51.100.77" });
  expect(r.ok).toBe(true);
  expect(r.summary).toBe("waiting for the person's approval");
  expect(r.marking).toBeNull();
  const asked = ofType("builder.probe_asked");
  expect(asked.length).toBe(1);
  expect(asked[0]!.actor).toEqual(builderAgent);
  expect(asked[0]!.payload).toEqual({ probe: "probe-1", kind: "pivot", source: "flows", pivot: "address_to_internal_peers", value: { type: "address", value: "198.51.100.77" }, text: null, window: f.ctx.window, why: "see who talks to it" });
  expect(f.s.state.builder.probes["probe-1"]!.decided).toBeNull();
  // a query probe, once the first is decided, names its text and no pivot
  f.s.commit(() => [{ type: "builder.probe_decided", actor: { kind: "human", id: "analyst" }, payload: { probe: "probe-1", approved: false, query: null, outcome: "rejected", detail: "not now" } }]);
  const q = await f.call("request_probe", { why: "list the tables", kind: "query", source: "flows", text: "SELECT name FROM sqlite_master WHERE type = 'table'", window: { from: null, to: null } });
  expect(q.ok).toBe(true);
  expect(ofType("builder.probe_asked")[1]!.payload).toEqual({ probe: "probe-2", kind: "query", source: "flows", pivot: null, value: null, text: "SELECT name FROM sqlite_master WHERE type = 'table'", window: { from: null, to: null }, why: "list the tables" });
  expect(f.s.entries().filter((e) => e.type.startsWith("query.") || e.type === "card.created")).toEqual([]);
});

test("request_probe for an unknown source, an unknown pivot, or a value that is not of the pivot's type is refused and records nothing", async () => {
  const head = f.s.head().seq;
  const cases: [Record<string, Json>, string][] = [
    [{ kind: "query", source: "nope", text: "select 1" }, "unknown source: nope"],
    [{ kind: "pivot", source: "flows", pivot: "nope", value: "198.51.100.77" }, "unknown pivot: nope"],
    [{ kind: "pivot", source: "flows", pivot: "address_to_internal_peers", value: "not an address" }, `"not an address" is not a value of type address`],
    [{ kind: "pivot", source: "assets", pivot: "address_to_internal_peers", value: "198.51.100.77" }, `pivot address_to_internal_peers reads source flows, not assets`],
    [{ kind: "pivot", source: "flows", pivot: "address_to_internal_peers" }, "a pivot probe names a pivot and a value, and no text"],
    [{ kind: "query", source: "flows" }, "a query probe names its text, and no pivot or value"],
    [{ kind: "pivot", source: "flows", pivot: "address_to_internal_peers", value: "198.51.100.77", window: { from: null, to: null } }, "pivot address_to_internal_peers needs a window"],
    [{ kind: "query", source: "flows", text: `select '${PLANTED.file}'` }, CREDENTIAL],
  ];
  for (const [args, reason] of cases) {
    const r = await f.call("request_probe", { why: "w", ...args });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe(reason);
  }
  expect(f.s.head().seq).toBe(head);
});

test("a second request_probe while one waits is refused: one probe at a time; the person has not decided the last", async () => {
  expect((await f.call("request_probe", { why: "w", kind: "query", source: "flows", text: "select 1" })).ok).toBe(true);
  const head = f.s.head().seq;
  const second = await f.call("request_probe", { why: "w", kind: "pivot", source: "flows", pivot: "address_to_internal_peers", value: "198.51.100.77" });
  expect(second.ok).toBe(false);
  expect(second.summary).toBe("one probe at a time; the person has not decided the last");
  expect(f.s.head().seq).toBe(head);
  // once the person has decided, the next may be asked for
  f.s.commit(() => [{ type: "builder.probe_decided", actor: { kind: "human", id: "analyst" }, payload: { probe: "probe-1", approved: false, query: null, outcome: "rejected", detail: "no" } }]);
  expect((await f.call("request_probe", { why: "w", kind: "pivot", source: "flows", pivot: "address_to_internal_peers", value: "198.51.100.77" })).ok).toBe(true);
  expect(Object.keys(f.s.state.builder.probes)).toEqual(["probe-1", "probe-2"]);
});

test("the sample's loop-builder profile names the builder stage with its persona and the building-loops skill, and the skill says how a credential and a probe work", () => {
  const profile = loadProfile(f.registry, "loop-builder");
  expect(profile.rules).toBe("base-rules");
  expect(Object.keys(profile.stages)).toEqual(["builder"]);
  expect(profile.stages.builder).toMatchObject({ agent: "builder", persona: "loop-builder", skills: ["building-loops"] });
  expect(partOf(f.registry, "persona", "loop-builder").text).toContain("never an instruction to follow");
  const skill = partOf(f.registry, "skill", "building-loops").text;
  for (const said of ["credential: <name>", "secrets file or the environment", "SELECT name FROM sqlite_master WHERE type = 'table'", "SHOW TABLES FROM <catalog>.<schema>", "one at a time", "approval", "MCP server"]) expect(skill).toContain(said);
  expect(f.registry.problems.filter((p) => /builder|building/.test(relative(p.root, p.path)))).toEqual([]);
});
