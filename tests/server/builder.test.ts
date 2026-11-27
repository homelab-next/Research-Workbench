import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Json } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { fold } from "../../src/core/state";
import type { Entry, EntryType } from "../../src/core/types";
import type { BuilderView, LoopSummaryView } from "../../src/core/wire";
import { BUILDER_TOOL_NAMES, parseCall } from "../../src/agents/tools";
import { copyOf, loopText } from "../../src/modules/loop-write";
import { lineDiff, REDACTED } from "../../src/server/builder";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

/** A planted credential value, a host and a user: none may reach the builder's model or its ledger. */
const SECRET = "planted-builder-secret-6Hv3";
const HOST = "lake.example.net";
const USER = "svc_reader";
const SCRIPT = "builder-test";
const CHOICE = { provider: "scripted", model: SCRIPT, effort: null };

type Reply = { content?: string; tool_calls?: { tool: string; args: Record<string, Json> }[] };

let s: Served;
const sessions: string[] = [];
afterEach(async () => {
  try {
    for (const id of sessions) expect(s.wb.builder(id).state.skipped).toEqual([]);
  } finally {
    sessions.length = 0;
    await s?.close();
  }
});

/** The builder's scripted turns, a trino source with a host, a user and a credential, and the planted secret granted to the root. */
async function start(turns: Reply[], opts: { before?: (root: string) => void; role?: "analyst" | "requester"; config?: NonNullable<Parameters<typeof served>[0]>["config"] } = {}): Promise<void> {
  s = await served({
    role: opts.role ?? "analyst",
    credential: { name: "builder_cred", value: SECRET },
    ...(opts.config === undefined ? {} : { config: opts.config }),
    before: (root) => {
      writeFileSync(join(root, "sources", "lakehouse.yaml"), `kind: source\nid: lakehouse\ntitle: Lake house\nconnector: trino\nlocation: https://${HOST}:8443\nuser: ${USER}\ncredential: builder_cred\nmarking: "TLP:GREEN"\nwhere: network\ncost: { weight: 1, unit: rows }\npurpose: Events kept in the lake.\ntables:\n  - name: events\n    time_column: ts\n    columns: [{ name: src, type: address }, { name: ts }]\n`);
      writeFileSync(join(root, "scripts", `${SCRIPT}.yaml`), JSON.stringify({ kind: "script", id: SCRIPT, title: "Builder test", turns: turns.map((reply) => ({ actor: "builder", reply })) }));
      opts.before?.(root);
    },
  });
}
const root = (): string => s.config.roots[0]!.path;
async function newBuilder(loop: string | null = "investigation"): Promise<string> {
  const res = await s.post("/api/builders", { loop, marking: "TLP:GREEN" });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  sessions.push(id);
  expect((await s.post(`/api/builders/${id}/model`, { choice: CHOICE })).status).toBe(200);
  return id;
}
const entries = (id: string): Entry[] => s.wb.builder(id).entries();
const ofType = <T extends EntryType>(id: string, t: T): Extract<Entry, { type: T }>[] => entries(id).filter((e): e is Extract<Entry, { type: T }> => e.type === t);
const ask = async (id: string, text = "What loops are there?"): Promise<Response> => {
  const res = await s.post(`/api/builders/${id}/ask`, { text });
  await s.app.hub.idle();
  return res;
};
const view = async (id: string): Promise<BuilderView> => (await (await s.get(`/api/builders/${id}/view`)).json()) as BuilderView;
const decide = (id: string, change: string, file: number, accept: boolean): Promise<Response> => s.post(`/api/builders/${id}/decide`, { change, file, accept });
/** Every byte the session's ledger and blobs hold, as text. */
function ledgerText(id: string): string {
  const session = s.wb.builder(id);
  const dir = join(session.dir, "blobs");
  const blobs = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(dir, e.name), "utf8")) : [];
  return [JSON.stringify(session.entries()), ...blobs].join("\n");
}
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
const body = (text: string): string => text.replace(/^---\n[\s\S]*?\n---\n/, "");
const frameText = (): string => readFileSync(join(import.meta.dir, "..", "..", "sample", "stages", "frame.yaml"), "utf8");
const SKILL = "---\nkind: skill\nid: extra-notes\ntitle: Extra notes\n---\nRead the field notes before you pivot.\n";
const propose = (title: string, files: { path: string; text: string }[]): Reply => ({ tool_calls: [{ tool: "propose_change", args: { why: "the person asked", title, files } }] });

// ---------- sessions, ask and the view ----------

test("POST /api/builders makes BUILD-1 for a loop and lists it; a requester may neither read nor make one", async () => {
  await start([]);
  const res = await s.post("/api/builders", { loop: "investigation", marking: "TLP:GREEN" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: "BUILD-1" });
  sessions.push("BUILD-1");
  const list = (await (await s.get("/api/builders")).json()) as { id: string; loop: string | null; marking: string }[];
  expect(list.map((b) => [b.id, b.loop, b.marking])).toEqual([["BUILD-1", "investigation", "TLP:GREEN"]]);
  // a builder session is not a case
  expect(s.wb.listCases()).toEqual([]);
  // the body may not name the actor, a loop that is not, or a marking that is not
  expect((await s.post("/api/builders", { loop: "investigation", marking: "TLP:GREEN", actor: { kind: "agent" } })).status).toBe(400);
  expect((await s.post("/api/builders", { loop: "no-such-loop", marking: "TLP:GREEN" })).status).toBe(400);
  expect((await s.post("/api/builders", { loop: null, marking: "TLP:PURPLE" })).status).toBe(400);
  expect(s.wb.builder("BUILD-1").state.skipped).toEqual([]);
  sessions.length = 0;
  await s.close();

  await start([], { role: "requester" });
  expect((await s.get("/api/builders")).status).toBe(403);
  const made = await s.post("/api/builders", { loop: null, marking: "TLP:GREEN" });
  expect(made.status).toBe(403);
  expect(await made.json()).toEqual({ ok: false, refused: ["the requester view may not do create builder"] });
  expect(s.wb.listBuilders()).toEqual([]);
});

test("every builder route is behind the Host and Origin guard and answers refusals as JSON", async () => {
  await start([]);
  const id = await newBuilder();
  const gets = ["/api/builders", `/api/builders/${id}/view`, `/api/builders/${id}/entries`, `/api/builders/${id}/blobs/${"0".repeat(64)}`];
  const posts: [string, unknown][] = [
    ["/api/builders", { loop: null, marking: "TLP:GREEN" }], [`/api/builders/${id}/ask`, { text: "x" }], [`/api/builders/${id}/decide`, { change: "chg-1", file: 0, accept: true }],
    [`/api/builders/${id}/probe`, { probe: "probe-1", approve: true }], [`/api/builders/${id}/model`, { choice: CHOICE }],
  ];
  // the guard refuses before any route runs (its own plain sentence, as for every route of the app); what a route refuses is JSON
  for (const path of gets) {
    expect((await s.get(path, { host: "evil.example.com" })).status).toBe(421);
    expect((await s.get(path, { origin: "https://evil.example.com" })).status).toBe(403);
    expect((await s.get(path, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  }
  for (const [path, b] of posts) {
    for (const headers of [{ host: "evil.example.com" }, { origin: "https://evil.example.com" }, { "content-type": "text/plain" }] as Record<string, string>[]) {
      expect([403, 421]).toContain((await s.post(path, b, headers)).status);
    }
    // a body that is not JSON is refused as JSON
    const notJson = await s.post(path, "{not json");
    expect(notJson.status).toBe(400);
    expect(notJson.headers.get("content-type")).toContain("application/json");
    expect(await notJson.json()).toEqual({ ok: false, refused: ["the body is not JSON"] });
    // a body that names the actor is refused
    if (isObj(b)) {
      const named = await s.post(path, { ...b, actor: { kind: "human", id: "someone" } });
      expect(named.status).toBe(400);
      expect(named.headers.get("content-type")).toContain("application/json");
      expect(await named.json()).toEqual({ ok: false, refused: ["the server names the actor"] });
    }
  }
  // an unknown session is a JSON 404
  const none = await s.get("/api/builders/BUILD-99/view");
  expect(none.status).toBe(404);
  expect(((await none.json()) as { ok: boolean }).ok).toBe(false);
  expect(s.wb.listBuilders().length).toBe(1);
  expect(entries(id).map((e) => e.type)).toEqual(["case.created", "case.loop_set", "stage.model_set"]);
});
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

test("ask writes agent.asked at once; the turn records model.request, tool.called, tool.returned and agent.answered in the builder's ledger and nothing in any case", async () => {
  await start([{ tool_calls: [{ tool: "loop_catalogue", args: { why: "see the loops" } }] }, { content: "There are two loops: investigation and triage." }]);
  const id = await newBuilder();
  const res = await s.post(`/api/builders/${id}/ask`, { text: "What loops are there?" });
  expect(res.status).toBe(200);
  const asked = ofType(id, "agent.asked");
  expect(asked.length).toBe(1);
  expect(asked[0]!.actor).toEqual({ kind: "human", id: s.config.user });
  expect(((await res.json()) as { seq: number }).seq).toBe(asked[0]!.seq);
  await s.app.hub.idle();
  const types = entries(id).filter((e) => e.seq > asked[0]!.seq).map((e) => e.type);
  expect(types).toEqual(["model.request", "model.response", "tool.called", "tool.returned", "model.request", "model.response", "agent.answered"]);
  const req = ofType(id, "model.request")[0]!;
  expect(req.actor).toMatchObject({ kind: "agent", id: "builder", stage: "builder", profile: "loop-builder", model: SCRIPT });
  expect(req.payload.tools).toEqual([...BUILDER_TOOL_NAMES]);
  expect(s.wb.builder(id).state.conversation.at(-1)).toMatchObject({ asked: "What loops are there?", answer: "There are two loops: investigation and triage." });
  expect(s.wb.listCases()).toEqual([]);
});

test("the builder's pack holds its persona, its skill, the loop the session is about, and no location, user or credential of any source", async () => {
  // read the model.request's messages blob: none of the planted host, user or secret
  await start([{ content: "Ready." }]);
  const id = await newBuilder();
  expect((await ask(id)).status).toBe(200);
  const req = ofType(id, "model.request")[0]!;
  const messages = new TextDecoder().decode(s.wb.builder(id).blobs.get(req.payload.messages.blob));
  const persona = body(readFileSync(join(root(), "context", "personas", "loop-builder.md"), "utf8")).split("\n")[0]!;
  const skill = body(readFileSync(join(root(), "context", "skills", "building-loops.md"), "utf8")).split("\n")[0]!;
  expect(messages).toContain(JSON.stringify(persona).slice(1, 60));
  expect(messages).toContain(JSON.stringify(skill).slice(1, 60));
  expect(messages).toContain("stages: [frame, plan, research, assemble, checks, evaluate, challenge, publish, feedback]");
  expect(req.payload.pack.map((p) => p.kind)).toEqual(expect.arrayContaining(["rules", "persona", "skill", "case", "loop"]));
  expect(req.payload.marking).toBe("TLP:GREEN");
  for (const planted of [SECRET, HOST, USER, s.dir, root()]) expect(messages).not.toContain(planted);
});

test("a question that holds a secret value is written with the value redacted, and the value reaches neither the ledger nor the model", async () => {
  // controller ruling (Task 17): what the person types is searched for each secret value before anything is written, and each one found is redacted
  await start([{ content: "Please name the credential instead of pasting it." }]);
  const id = await newBuilder();
  const res = await s.post(`/api/builders/${id}/ask`, { text: `The lake's password is ${SECRET}; put it in the source.` });
  expect(res.status).toBe(200);
  await s.app.hub.idle();
  const asked = ofType(id, "agent.asked")[0]!;
  expect(asked.payload.text).toBe(`The lake's password is ${REDACTED}; put it in the source.`);
  expect(ledgerText(id)).not.toContain(SECRET);
  expect(ofType(id, "agent.answered").length).toBe(1);
  // a question with nothing but whitespace is still refused, and writes nothing
  const before = entries(id).length;
  const empty = await s.post(`/api/builders/${id}/ask`, { text: "   " });
  expect(empty.status).toBe(409);
  expect(entries(id).length).toBe(before);
});

test("a secret value the model writes into a tool's arguments, its answer or its reasoning is redacted before the ledger records it", async () => {
  // controller ruling (Task 17): the model's tool arguments are searched for each secret value before tool.called is written
  const escaped = SECRET.split("").map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  await start([
    { tool_calls: [{ tool: "validate_manifest", args: { why: `checking ${SECRET}`, path: "sources/x.yaml", text: `kind: source\nid: x\nquality: ${SECRET}\n` } }] },
    { content: `I would not write ${SECRET} anywhere.` },
  ], {
    before: (r) => {
      // a model may also spell the value with JSON escapes
      const at = join(r, "scripts", `${SCRIPT}.yaml`);
      writeFileSync(at, readFileSync(at, "utf8").replace(`"why":"checking ${SECRET}"`, `"why":"checking ${escaped}"`));
    },
  });
  const id = await newBuilder();
  expect((await ask(id)).status).toBe(200);
  const called = ofType(id, "tool.called")[0]!;
  expect(JSON.stringify(called.payload.args)).toContain(REDACTED);
  expect(ofType(id, "agent.answered")[0]!.payload.text).toBe(`I would not write ${REDACTED} anywhere.`);
  expect(ledgerText(id)).not.toContain(SECRET);
});

test("the view shows a proposed change as line diffs against the files on disk, a new file as all additions, and what is decided", async () => {
  const frame = frameText().replace("title: Frame\n", "title: Frame the question\n");
  await start([propose("Rename Frame, add notes", [{ path: "stages/frame.yaml", text: frame }, { path: "context/skills/extra-notes.md", text: SKILL }]), { content: "Proposed." }]);
  const id = await newBuilder();
  expect((await ask(id, "Rename the Frame stage and add a skill.")).status).toBe(200);
  let v = await view(id);
  expect(v).toMatchObject({ id, loop: "investigation", marking: "TLP:GREEN", model: CHOICE, probes: [] });
  expect(v.changes.length).toBe(1);
  const [stage, skill] = v.changes[0]!.files;
  expect(v.changes[0]).toMatchObject({ id: "chg-1", title: "Rename Frame, add notes", why: "the person asked" });
  expect(stage).toMatchObject({ index: 0, path: "stages/frame.yaml", kind: "stage", id: "frame", new_file: false, decided: null, stale: false });
  expect(stage!.lines.filter((l) => l.op !== " ")).toEqual([{ op: "-", text: "title: Frame" }, { op: "+", text: "title: Frame the question" }]);
  expect(stage!.lines.filter((l) => l.op === " ").length).toBe(frameText().trimEnd().split("\n").length - 1);
  expect(skill).toMatchObject({ index: 1, path: "context/skills/extra-notes.md", kind: "skill", id: "extra-notes", new_file: true, decided: null, stale: false });
  expect(skill!.lines).toEqual(SKILL.trimEnd().split("\n").map((text) => ({ op: "+", text })));
  // nothing is written until the person decides
  expect(readFileSync(join(root(), "stages", "frame.yaml"), "utf8")).toBe(frameText());
  expect((await decide(id, "chg-1", 1, false)).status).toBe(200);
  v = await view(id);
  expect(v.changes[0]!.files.map((f) => f.decided)).toEqual([null, { accepted: false }]);
});

test("a diff line that looks like markup is a string in the view", async () => {
  const markup = "<img src=x onerror=alert(1)><script>alert(2)</script>";
  const text = `---\nkind: skill\nid: markup\ntitle: Markup\n---\n${markup}\n`;
  await start([propose("A skill", [{ path: "context/skills/markup.md", text }]), { content: "Proposed." }]);
  const id = await newBuilder();
  expect((await ask(id)).status).toBe(200);
  const raw = await (await s.get(`/api/builders/${id}/view`)).text();
  const v = JSON.parse(raw) as BuilderView;
  expect(v.changes[0]!.files[0]!.lines).toContainEqual({ op: "+", text: markup });
  expect(typeof v.changes[0]!.files[0]!.lines.at(-1)!.text).toBe("string");
});

test("lineDiff of equal texts is all context; of an added line is one +; past 2000 lines it is all - then all +", () => {
  expect(lineDiff("a\nb\nc\n", "a\nb\nc\n")).toEqual([{ op: " ", text: "a" }, { op: " ", text: "b" }, { op: " ", text: "c" }]);
  expect(lineDiff("a\nc\n", "a\nb\nc\n")).toEqual([{ op: " ", text: "a" }, { op: "+", text: "b" }, { op: " ", text: "c" }]);
  expect(lineDiff("", "x\n")).toEqual([{ op: "+", text: "x" }]);
  expect(lineDiff("x\ny\n", "y\n")).toEqual([{ op: "-", text: "x" }, { op: " ", text: "y" }]);
  const big = Array.from({ length: 2001 }, (_, i) => `line ${i}`).join("\n");
  const d = lineDiff(big, big);
  expect(d.length).toBe(4002);
  expect(d.slice(0, 2001).every((l) => l.op === "-")).toBe(true);
  expect(d.slice(2001).every((l) => l.op === "+")).toBe(true);
});

// ---------- decisions ----------

test("accepting a file writes exactly that file into the trusted root as the person, records builder.decided with the written hash and manifest.written on the workbench chain with why builder and the session id", async () => {
  const frame = frameText().replace("title: Frame\n", "title: Frame the question\n");
  await start([propose("Rename and add", [{ path: "stages/frame.yaml", text: frame }, { path: "context/skills/extra-notes.md", text: SKILL }]), { content: "Proposed." }]);
  const id = await newBuilder();
  expect((await ask(id)).status).toBe(200);
  const before = snapshot(root());
  const res = await decide(id, "chg-1", 0, true);
  expect(res.status).toBe(200);
  const after = snapshot(root());
  const changed = Object.keys(after).filter((k) => before[k]?.bytes !== after[k]!.bytes);
  expect(changed).toEqual(["stages/frame.yaml"]);
  expect(readFileSync(join(root(), "stages", "frame.yaml"), "utf8")).toBe(frame);
  expect(existsSync(join(root(), "context", "skills", "extra-notes.md"))).toBe(false);
  const decided = ofType(id, "builder.decided");
  expect(decided.map((e) => [e.actor, e.payload])).toEqual([[{ kind: "human", id: s.config.user }, { change: "chg-1", file: 0, accepted: true, written: sha256Hex(frame) }]]);
  const written = s.wb.chain.read().filter((e) => e.type === "manifest.written");
  expect(written.map((e) => [e.actor, e.payload])).toEqual([[{ kind: "human", id: s.config.user }, {
    root: root(), path: "stages/frame.yaml", kind: "stage", id: "frame", hash: sha256Hex(frame), before: sha256Hex(frameText()), why: "builder", session: id,
  }]]);
});

test("after an accept the registry holds the new manifest and GET /api/loops shows the new loop or version", async () => {
  let text = "";
  await start([{ content: "placeholder" }], {
    before: () => { /* the loop's text is made from the loaded loop below */ },
  });
  text = loopText(copyOf(s.app.hub.deps.loops!.current("investigation")!, "solo", "Solo"), 1);
  await s.close();
  await start([propose("A new loop", [{ path: "loops/solo.yaml", text }]), { content: "Proposed." }]);
  const id = await newBuilder();
  expect((await ask(id)).status).toBe(200);
  expect(((await (await s.get("/api/loops")).json()) as LoopSummaryView[]).some((l) => l.id === "solo")).toBe(false);
  expect((await decide(id, "chg-1", 0, true)).status).toBe(200);
  expect(s.app.hub.deps.registry.get("loop", "solo")).not.toBeNull();
  const loops = (await (await s.get("/api/loops")).json()) as LoopSummaryView[];
  expect(loops.find((l) => l.id === "solo")).toMatchObject({ id: "solo", title: "Solo", version: 1, usable: true });
});

test("rejecting a file writes nothing under any root and records the rejection", async () => {
  await start([propose("A skill", [{ path: "context/skills/extra-notes.md", text: SKILL }]), { content: "Proposed." }]);
  const id = await newBuilder();
  expect((await ask(id)).status).toBe(200);
  const before = snapshot(root());
  const chain = s.wb.chain.read().length;
  const seq = s.wb.builder(id).head().seq;
  expect((await decide(id, "chg-1", 0, false)).status).toBe(200);
  expect(snapshot(root())).toEqual(before);
  expect(s.wb.chain.read().length).toBe(chain);
  expect(entries(id).filter((e) => e.seq > seq).map((e) => [e.type, e.payload])).toEqual([["builder.decided", { change: "chg-1", file: 0, accepted: false, written: null }]]);
});

const STAGE2 = "kind: stage\nid: frame2\ntitle: Frame again\norder: 1\nphase: direction\nruns: human\nrole: feedback\ngate: null\nreviews: false\ntools: []\nschema: null\nmodel: null\non_pass: null\non_fail: null\n";
const LOOP2 = "kind: loop\nid: solo\ntitle: Solo\nabout: one stage\nversion: 1\nprofile: investigation\nentry: frame2\nstages: [frame2]\n";

test("of two files where the loop needs the stage, accepting the loop first is refused with the problem that names the stage, and accepting the stage and then the loop writes both", async () => {
  await start([propose("A loop and its stage", [{ path: "loops/solo.yaml", text: LOOP2 }, { path: "stages/frame2.yaml", text: STAGE2 }]), { content: "Proposed." }]);
  const id = await newBuilder();
  expect((await ask(id)).status).toBe(200);
  expect(ofType(id, "builder.proposed").length).toBe(1);
  const before = snapshot(root());
  const first = await decide(id, "chg-1", 0, true);
  expect(first.status).toBe(409);
  const reasons = ((await first.json()) as { refused: string[] }).refused;
  expect(reasons.join("\n")).toContain("frame2");
  expect(snapshot(root())).toEqual(before);
  expect(ofType(id, "builder.decided")).toEqual([]);
  expect((await decide(id, "chg-1", 1, true)).status).toBe(200);
  expect((await decide(id, "chg-1", 0, true)).status).toBe(200);
  expect(readFileSync(join(root(), "loops", "solo.yaml"), "utf8")).toBe(LOOP2);
  expect(readFileSync(join(root(), "stages", "frame2.yaml"), "utf8")).toBe(STAGE2);
  expect(s.app.hub.deps.loops!.current("solo")).not.toBeNull();
});

test("a file changed on disk since it was proposed is stale: its accept is refused and nothing is written", async () => {
  const frame = frameText().replace("title: Frame\n", "title: Frame the question\n");
  await start([propose("Rename Frame", [{ path: "stages/frame.yaml", text: frame }]), { content: "Proposed." }]);
  const id = await newBuilder();
  expect((await ask(id)).status).toBe(200);
  const edited = frameText().replace("phase: direction", "phase: direction\n# edited by hand");
  writeFileSync(join(root(), "stages", "frame.yaml"), edited);
  expect((await view(id)).changes[0]!.files[0]!.stale).toBe(true);
  const res = await decide(id, "chg-1", 0, true);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ ok: false, refused: ["this file changed since it was proposed; ask the builder to propose again"] });
  expect(readFileSync(join(root(), "stages", "frame.yaml"), "utf8")).toBe(edited);
  expect(ofType(id, "builder.decided")).toEqual([]);
});

test("a decision sent twice, on an unknown change, or with a file index out of range is refused and writes nothing", async () => {
  await start([propose("A skill", [{ path: "context/skills/extra-notes.md", text: SKILL }]), { content: "Proposed." }]);
  const id = await newBuilder();
  expect((await ask(id)).status).toBe(200);
  expect((await decide(id, "chg-1", 0, true)).status).toBe(200);
  const seq = s.wb.builder(id).head().seq;
  const chain = s.wb.chain.read().length;
  const before = snapshot(root());
  for (const [change, file, accept] of [["chg-1", 0, true], ["chg-1", 0, false], ["chg-9", 0, true], ["chg-1", 1, true], ["chg-1", -1, false]] as const) {
    const res = await decide(id, change, file, accept);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  }
  expect((await s.post(`/api/builders/${id}/decide`, { change: "chg-1", file: 0.5, accept: true })).status).toBe(400);
  expect(s.wb.builder(id).head().seq).toBe(seq);
  expect(s.wb.chain.read().length).toBe(chain);
  expect(snapshot(root())).toEqual(before);
});

test("an accept while a run is working goes ahead (controller ruling 5), and the working run keeps the version it bound", async () => {
  const frame = frameText().replace("title: Frame\n", "title: Frame the question\n");
  await start([propose("Rename Frame", [{ path: "stages/frame.yaml", text: frame }]), { content: "Proposed." }]);
  const id = await newBuilder();
  expect((await ask(id)).status).toBe(200);
  const kase = await s.newCase();
  const bound = s.app.hub.deps.loops!.current("investigation")!.pipeline.hash;
  // the run is driven in the background: the accept lands while it works
  expect((await s.command(kase, "start_run")).status).toBe(200);
  expect((await decide(id, "chg-1", 0, true)).status).toBe(200);
  await s.app.hub.idle();
  const state = s.app.hub.read(kase).state;
  expect(state.run.waiting).toBe("plan");
  expect(s.entries(kase).filter((e) => e.type === "run.paused")).toEqual([]);
  expect(s.entries(kase).filter((e) => e.type === "loop.bound").map((e) => (e.payload as { hash: string }).hash)).toEqual([bound]);
  expect(s.app.hub.deps.loops!.current("investigation")!.pipeline.hash).not.toBe(bound);
  expect(s.app.hub.read(kase).state.skipped).toEqual([]);
});

test("no route lets the builder agent decide: a tool call named builder_decide is an unknown tool, and builder.decided by the agent's actor is skipped by the fold", async () => {
  await start([propose("A skill", [{ path: "context/skills/extra-notes.md", text: SKILL }]), { content: "Proposed." }]);
  const id = await newBuilder();
  expect((await ask(id)).status).toBe(200);
  for (const name of ["builder_decide", "builder_probe", "decide"]) expect(parseCall(BUILDER_TOOL_NAMES, name, "{}").error).toBe(`unknown tool: ${name}`);
  const live = entries(id);
  const agent = ofType(id, "model.request")[0]!.actor;
  const last = live.at(-1)!;
  const forged = { ...last, seq: last.seq + 1, type: "builder.decided", actor: agent, payload: { change: "chg-1", file: 0, accepted: true, written: sha256Hex(SKILL) } } as unknown as Entry;
  const folded = fold([...live, forged]);
  expect(folded.builder.changes["chg-1"]!.files[0]!.decided).toBeNull();
  expect(folded.skipped.map((x) => x.reason)).toEqual(["a change is decided by a person"]);
  expect(existsSync(join(root(), "context", "skills", "extra-notes.md"))).toBe(false);
});

// ---------- final review I2: a proposal never replaces a manifest of another kind ----------

/** A builder.proposed written straight into the session, as if the tool had let it through: what the person's accept must still refuse. */
function proposedByHand(id: string, path: string, text: string, kind: string, fileId: string): void {
  const session = s.wb.builder(id);
  const at = join(root(), ...path.split("/"));
  const before = existsSync(at) ? sha256Hex(new Uint8Array(readFileSync(at))) : null;
  const bundle = session.blobs.put(JSON.stringify({ files: [{ path, text }] }), "application/json");
  session.commit((_s, ids) => [{ type: "builder.proposed", actor: { kind: "human", id: s.config.user }, payload: { change: ids.next("change"), title: "Tidy a file", why: "housekeeping", root: "sample", files: [{ path, kind, id: fileId, before, after: sha256Hex(text) }], bundle } }]);
}
const checksOf = (): string[] => s.app.hub.deps.loops!.current("investigation")!.lock.items.filter((i) => i.kind === "check").map((i) => i.id);

test("a proposal that replaces a check with a skill is the builder's error; written into the session by hand, its accept is refused, and the loop keeps its eleven checks", async () => {
  const text = "kind: skill\nid: tidy-notes\ntitle: Tidy notes\n";
  await start([propose("Tidy a file", [{ path: "checks/11-marking.yaml", text }]), { content: "Proposed." }]);
  const id = await newBuilder();
  expect((await ask(id)).status).toBe(200);
  expect(ofType(id, "builder.proposed")).toEqual([]);
  const returned = ofType(id, "tool.returned").map((e) => JSON.stringify(e.payload)).join(" ");
  expect(returned).toContain("the file there is a check");
  proposedByHand(id, "checks/11-marking.yaml", text, "skill", "tidy-notes");
  const before = readFileSync(join(root(), "checks", "11-marking.yaml"), "utf8");
  const res = await decide(id, "chg-1", 0, true);
  expect(res.status).toBe(409);
  expect(JSON.stringify(await res.json())).toContain("the file there is a check");
  expect(readFileSync(join(root(), "checks", "11-marking.yaml"), "utf8")).toBe(before);
  expect(checksOf()).toHaveLength(11);
});
