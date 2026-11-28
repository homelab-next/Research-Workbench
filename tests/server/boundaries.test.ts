import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Actor } from "../../src/core/types";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

const ROOT = join(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const imports = (text: string): string[] => [...text.matchAll(IMPORT)].map((m) => m[1]!);
const rel = (f: string): string => relative(ROOT, f);

// A rule is a pure function of (file path under the repository, its text) that returns what it objects to, so each is also run on planted text.
type Rule = (path: string, text: string) => string[];

/** True when the relative specifier, resolved from the importing file, lands inside `dir` (a path under the repository, such as src/modules). */
const reaches = (path: string, spec: string, dir: string): boolean => {
  if (!spec.startsWith(".")) return false;
  const target = relative(ROOT, resolve(ROOT, dirname(path), spec));
  return target === dir || target.startsWith(`${dir}/`);
};

const noConnectorImports: Rule = (path, text) =>
  /^src\/(server|web)\//.test(path) ? imports(text).filter((s) => reaches(path, s, "src/modules/connectors")).map((s) => `${path} imports ${s}`) : [];

const webIsIsolated: Rule = (path, text) =>
  /^src\/web\//.test(path) && path !== "src/web/build.ts"
    ? imports(text).filter((s) => ["server", "modules", "agents", "pipeline", "cli"].some((d) => reaches(path, s, `src/${d}`))).map((s) => `${path} imports ${s}`)
    : [];

const onlyCliBuildsAPool: Rule = (path, text) =>
  !path.startsWith("src/cli/") && /\bnew\s+ConnectorPool\b/.test(text) ? [`${path} constructs a ConnectorPool`] : [];

/** Bun.serve only in src/server/app.ts, and there only with hostname "127.0.0.1"; no other way to listen. */
const listensOnlyOnLoopback: Rule = (path, text) => {
  const found: string[] = [];
  const calls = [...text.matchAll(/Bun\.serve\s*\(/g)];
  if (calls.length > 0 && path !== "src/server/app.ts") found.push(`${path} calls Bun.serve`);
  for (const c of calls) {
    const body = text.slice(c.index!, c.index! + 200);
    if (!/hostname:\s*"127\.0\.0\.1"/.test(body)) found.push(`${path} calls Bun.serve without hostname: "127.0.0.1"`);
  }
  if (/node:(http|https|http2|net|dgram)["']|\bcreateServer\s*\(|Bun\.listen\s*\(|Bun\.udpSocket\s*\(/.test(text)) found.push(`${path} opens a socket another way`);
  return found;
};

// ---------- slice 12: only a person writes a manifest, through the three writers; no agent and no stage reaches them; the server names the actor ----------

/** The three files that may write into a module root or the configuration file. */
const WRITERS = ["src/modules/loop-write.ts", "src/modules/loop-import.ts", "src/modules/config-write.ts"];
/** A call that makes or changes a file or a folder (removing a temporary folder, and making one under the system's temporary folder, are not). */
const WRITES = /\b(?:writeFileSync|appendFileSync|writeSync|renameSync|copyFileSync|cpSync|linkSync|symlinkSync|mkdirSync|createWriteStream|writeFile|appendFile)\s*\(|\bBun\.write\s*\(/;
/** What names a module root or the configuration file: the configuration's roots, rootsOf, the root a save writes into, the imports folder, the file a configuration edit writes. */
const NAMES_A_ROOT = /\.roots\b|\brootsOf\b|\bwriteRoot\b|\bloops\.imports\b|\bimportsDir\b|\bwrite_path\b/;
const writesOnlyThere: Rule = (path, text) =>
  /^src\//.test(path) && !WRITERS.includes(path) && WRITES.test(text) && NAMES_A_ROOT.test(text)
    ? [`${path} writes files and names ${text.match(NAMES_A_ROOT)![0]}`]
    : [];

/** The modules that write manifests, loop files and the configuration. */
const MANIFEST_WRITERS = ["src/modules/loop-write", "src/modules/loop-import", "src/modules/config-write"];
/** Each import, export-from and dynamic import of a file, with whether it is type-only (`import type …`, `export type … from`). */
const importStatements = (text: string): { spec: string; typeOnly: boolean }[] => [
  ...[...text.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']/gm)].map((m) => ({ spec: m[3]!, typeOnly: m[2] !== undefined })),
  ...[...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm)].map((m) => ({ spec: m[1]!, typeOnly: false })),
  ...[...text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => ({ spec: m[1]!, typeOnly: false })),
];
const agentsDoNotWriteManifests: Rule = (path, text) =>
  /^src\/(agents|pipeline)\//.test(path)
    ? importStatements(text)
        .filter((i) => !i.typeOnly && (MANIFEST_WRITERS.some((d) => reaches(path, i.spec, d) || reaches(path, i.spec, `${d}.ts`)) || reachesLoopFile(path, i.spec)))
        .map((i) => `${path} imports ${i.spec}`)
    : [];

/**
 * Reading `actor` from what a request carries: its body, its parsed JSON, its arguments, its query or its headers. (`request` is not in the list: in
 * the server it names a recorded model.request entry, whose actor is the agent that made it.)
 */
const ACTOR_FROM_REQUEST =
  /\b(?:body|json|parsed|asked|args|input|req|params|query|searchParams|headers)\s*(?:\?\.|\.|!\.)\s*actor\b|\b(?:body|json|parsed|asked|args|input|req|params|query)\s*\[\s*["']actor["']\s*\]|\.get\(\s*["'](?:x-)?actor["']\s*\)|\{\s*[^}]*\bactor\b[^}]*\}\s*=\s*(?:body|json|parsed|asked|args|input|await\s+req)/;
const serverNamesTheActor: Rule = (path, text) =>
  /^src\/server\//.test(path) && ACTOR_FROM_REQUEST.test(text) ? [`${path} reads ${text.match(ACTOR_FROM_REQUEST)![0]}`] : [];

// ---------- slice 12, part B: the builder proposes and asks; only a person decides, and a probe is a query the runner sends ----------

/** The one file that writes a decision on a builder's change or probe. */
const BUILDER_SERVER = "src/server/builder.ts";
/** An entry literal of one of the two decisions, from its type to the end of its object (a decision's payload is on one line). */
const DECISION = /type:\s*["'](builder\.(?:probe_)?decided)["'][^\n]*/g;
const decisionsAreThePersons: Rule = (path, text) => {
  if (!/^src\//.test(path) || /^src\/(?:core|web)\//.test(path)) return [];
  const found: string[] = [];
  for (const m of text.matchAll(DECISION)) {
    if (path !== BUILDER_SERVER) found.push(`${path} writes ${m[1]}`);
    else if (!/\bactor:\s*ctx\.actor\b/.test(m[0])) found.push(`${path} writes ${m[1]} with an actor that is not the request's person`);
  }
  // the context a decision is written in names the person, and the routes give it the server's own person
  if (path === BUILDER_SERVER && !/\bactor:\s*Extract<Actor,\s*\{\s*kind:\s*"human"\s*\}>/.test(text)) found.push(`${path}: the builder context's actor is not a person`);
  if (path === "src/server/builder-routes.ts" && !/\bactor:\s*d\.human\(\)/.test(text)) found.push(`${path}: the builder context's actor is not the server's person`);
  return found;
};
/** A connector, the pool, or a pool's connection reached from the builder's server code, which may only ask the runner. */
const REACHES_A_SOURCE = /\bConnectorPool\b|\.pool\b|\bconnectorFor\b|\bopenConnector\b/;
const probesGoThroughTheRunner: Rule = (path, text) => {
  if (path !== BUILDER_SERVER) return [];
  const found = imports(text).filter((spec) => reaches(path, spec, "src/modules/connectors")).map((spec) => `${path} imports ${spec}`);
  if (REACHES_A_SOURCE.test(text)) found.push(`${path} names ${text.match(REACHES_A_SOURCE)![0]}`);
  if (!/\brunQuery\s*\(/.test(text)) found.push(`${path} does not send a probe through runQuery`);
  return found;
};

// ---------- slice 14: only the person passes the adopt gate, in src/server/improve.ts ----------

/** The one file that passes an improve case's adopt gate. */
const IMPROVE_SERVER = "src/server/improve.ts";
/** An entry literal of a pass of the adopt gate, from its type to the end of its line. */
const ADOPT_PASS = /type:\s*["']gate\.passed["'][^\n]*\bgate:\s*["']adopt["'][^\n]*/g;
const adoptIsThePersons: Rule = (path, text) => {
  if (!/^src\//.test(path) || /^src\/(?:core|web)\//.test(path)) return [];
  const found: string[] = [];
  for (const m of text.matchAll(ADOPT_PASS)) {
    if (path !== IMPROVE_SERVER) found.push(`${path} passes the adopt gate`);
    else if (!/\bactor:\s*ctx\.actor\b/.test(m[0])) found.push(`${path} passes the adopt gate with an actor that is not the request's person`);
  }
  return found;
};

const RULES: [string, Rule][] = [
  ["no file under src/server or src/web imports from src/modules/connectors", noConnectorImports],
  ["no file under src/web except build.ts imports from src/server, src/modules, src/agents, src/pipeline or src/cli", webIsIsolated],
  ["only src/cli constructs a ConnectorPool", onlyCliBuildsAPool],
  ["Bun.serve appears only in src/server/app.ts, always with hostname 127.0.0.1", listensOnlyOnLoopback],
  ["only src/modules/loop-write.ts, src/modules/loop-import.ts and src/modules/config-write.ts write under a module root or the configuration", writesOnlyThere],
  ["nothing under src/agents or src/pipeline imports loop-write, loop-import, loopfile or config-write, type-only imports aside", agentsDoNotWriteManifests],
  ["no route handler takes an actor from a request: every new route names the person itself", serverNamesTheActor],
  ["builder.decided and builder.probe_decided are written only in src/server/builder.ts, with the request's person as actor", decisionsAreThePersons],
  ["runQuery and runPivot are the only senders of a probe: src/server/builder.ts imports no connector", probesGoThroughTheRunner],
  ["gate.passed for the adopt gate is written only in src/server/improve.ts, with the request's person as actor", adoptIsThePersons],
];

const sources = files(SRC).map((f) => ({ path: rel(f), text: readFileSync(f, "utf8") }));

test("the scan sees the server, the interface and the command line", () => {
  expect(sources.filter((s) => s.path.startsWith("src/server/")).length).toBeGreaterThanOrEqual(10);
  expect(sources.filter((s) => s.path.startsWith("src/web/")).length).toBeGreaterThanOrEqual(20);
  expect(sources.some((s) => s.path === "src/cli/serve.ts")).toBe(true);
  expect(sources.some((s) => s.path === "src/server/app.ts" && s.text.includes("Bun.serve"))).toBe(true);
});

for (const [name, rule] of RULES) {
  test(name, () => {
    expect(sources.flatMap((s) => rule(s.path, s.text))).toEqual([]);
  });
}

test("each rule catches a planted violation", () => {
  expect(noConnectorImports("src/server/x.ts", `import { ConnectorPool } from "../modules/connectors";`)).toHaveLength(1);
  expect(noConnectorImports("src/web/x.ts", `import x from "../modules/connectors/http"`)).toHaveLength(1);
  expect(noConnectorImports("src/server/x.ts", `import { x } from "../core/types";`)).toEqual([]);
  expect(webIsIsolated("src/web/x.ts", `import { x } from "../server/app";`)).toHaveLength(1);
  expect(webIsIsolated("src/web/views/x.ts", `import { x } from "../../pipeline/engine";`)).toHaveLength(1);
  expect(webIsIsolated("src/web/x.ts", `const m = await import("../agents/context");`)).toHaveLength(1);
  expect(webIsIsolated("src/web/x.ts", `import { x } from "../cli/run";`)).toHaveLength(1);
  expect(webIsIsolated("src/web/build.ts", `import type { Assets } from "../server/app";`)).toEqual([]);
  expect(webIsIsolated("src/web/x.ts", `import { x } from "../core/state";`)).toEqual([]);
  expect(onlyCliBuildsAPool("src/server/x.ts", `const p = new ConnectorPool({});`)).toHaveLength(1);
  expect(onlyCliBuildsAPool("src/pipeline/x.ts", `new  ConnectorPool(ctx)`)).toHaveLength(1);
  expect(onlyCliBuildsAPool("src/cli/serve.ts", `new ConnectorPool(ctx)`)).toEqual([]);
  expect(listensOnlyOnLoopback("src/cli/x.ts", `Bun.serve({ hostname: "127.0.0.1", port: 0 })`)).toHaveLength(1);
  expect(listensOnlyOnLoopback("src/server/app.ts", `Bun.serve({ port: 0, fetch })`)).toHaveLength(1);
  expect(listensOnlyOnLoopback("src/server/app.ts", `Bun.serve({ hostname: "0.0.0.0", port: 0 })`)).toHaveLength(1);
  expect(listensOnlyOnLoopback("src/server/app.ts", `Bun.serve({ hostname: "127.0.0.1", port: 0 })`)).toEqual([]);
  expect(listensOnlyOnLoopback("src/server/x.ts", `import { createServer } from "node:http";`).length).toBeGreaterThan(0);
  // slice 12: the three writers
  expect(writesOnlyThere("src/server/x.ts", `writeFileSync(join(config.roots[0].path, "loops", "x.yaml"), text);`)).toHaveLength(1);
  expect(writesOnlyThere("src/cli/x.ts", `for (const r of rootsOf(config)) mkdirSync(join(r.path, "stages"));`)).toHaveLength(1);
  expect(writesOnlyThere("src/agents/tools/x.ts", `await Bun.write(config.write_path, "roots: []");`)).toHaveLength(1);
  expect(writesOnlyThere("src/modules/x.ts", `renameSync(tmp, join(config.loops.imports, name));`)).toHaveLength(1);
  expect(writesOnlyThere("src/modules/loop-write.ts", `writeSync(fd, bytes); const root = writeRoot(config, loop);`)).toEqual([]);
  expect(writesOnlyThere("src/modules/config-write.ts", `renameSync(tmp, config.write_path);`)).toEqual([]);
  expect(writesOnlyThere("src/core/blobs.ts", `writeSync(fd, bytes, at);`)).toEqual([]);
  expect(writesOnlyThere("src/cli/preflight.ts", `const store = mkdtempSync(dir); rmSync(store); rootsOf(config);`)).toEqual([]);
  expect(agentsDoNotWriteManifests("src/agents/tools/x.ts", `import { saveManifests } from "../../modules/loop-write";`)).toHaveLength(1);
  expect(agentsDoNotWriteManifests("src/pipeline/x.ts", `import { importLoop } from "../modules/loop-import.ts";`)).toHaveLength(1);
  expect(agentsDoNotWriteManifests("src/pipeline/stages/x.ts", `const m = await import("../../modules/config-write");`)).toHaveLength(1);
  expect(agentsDoNotWriteManifests("src/agents/x.ts", `import { writeLoopFile } from "../core/loopfile";`)).toHaveLength(1);
  expect(agentsDoNotWriteManifests("src/agents/x.ts", `export { saveLoop } from "../modules/loop-write";`)).toHaveLength(1);
  expect(agentsDoNotWriteManifests("src/agents/x.ts", `import type { LoopDraft } from "../modules/loop-write";`)).toEqual([]);
  expect(agentsDoNotWriteManifests("src/pipeline/x.ts", `import type { LoopFileManifest } from "../core/loopfile";`)).toEqual([]);
  expect(agentsDoNotWriteManifests("src/server/x.ts", `import { saveLoop } from "../modules/loop-write";`)).toEqual([]);
  expect(serverNamesTheActor("src/server/x.ts", `const actor = body.actor as Actor;`)).toHaveLength(1);
  expect(serverNamesTheActor("src/server/x.ts", `saveLoop(deps, draft, version, { actor: args["actor"] });`)).toHaveLength(1);
  expect(serverNamesTheActor("src/server/x.ts", `const by = url.searchParams.get("actor");`)).toHaveLength(1);
  expect(serverNamesTheActor("src/server/x.ts", `const { draft, actor } = body;`)).toHaveLength(1);
  expect(serverNamesTheActor("src/server/x.ts", `saveLoop(deps, draft, version, { actor: d.human() });`)).toEqual([]);
  expect(serverNamesTheActor("src/server/x.ts", `if (Object.hasOwn(body, "actor")) return "the server names the actor";`)).toEqual([]);
  expect(serverNamesTheActor("src/agents/x.ts", `const actor = body.actor;`)).toEqual([]);
  expect(serverNamesTheActor("src/server/x.ts", `if (request.actor.kind !== "agent") throw new Error("no request");`)).toEqual([]);
  expect(serverNamesTheActor("src/server/x.ts", `const who = req.actor;`)).toHaveLength(1);
  // slice 12, part B: only the person decides; a probe goes through the runner
  const HUMAN_CTX = `export interface BuilderContext { actor: Extract<Actor, { kind: "human" }> }\n`;
  const decide = `session.commit(() => [{ type: "builder.decided", actor: ctx.actor, payload: { change, file, accepted: false, written: null } }]);`;
  expect(decisionsAreThePersons(BUILDER_SERVER, HUMAN_CTX + decide)).toEqual([]);
  expect(decisionsAreThePersons("src/server/converse.ts", decide)).toEqual(["src/server/converse.ts writes builder.decided"]);
  expect(decisionsAreThePersons("src/agents/tools/x.ts", `return [{ type: 'builder.probe_decided', actor: ctx.actor, payload }];`)).toEqual(["src/agents/tools/x.ts writes builder.probe_decided"]);
  expect(decisionsAreThePersons("src/pipeline/x.ts", `entries.push({ type: "builder.decided", actor, payload });`)).toHaveLength(1);
  expect(decisionsAreThePersons(BUILDER_SERVER, HUMAN_CTX + `session.commit(() => [{ type: "builder.probe_decided", actor: agentActor, payload }]);`)).toEqual([`${BUILDER_SERVER} writes builder.probe_decided with an actor that is not the request's person`]);
  expect(decisionsAreThePersons(BUILDER_SERVER, `export interface BuilderContext { actor: Actor }\n` + decide)).toEqual([`${BUILDER_SERVER}: the builder context's actor is not a person`]);
  expect(decisionsAreThePersons("src/server/builder-routes.ts", `const ctxOf = (session) => ({ session, actor: { kind: "human", id: fields.who } });`)).toHaveLength(1);
  expect(decisionsAreThePersons("src/server/builder-routes.ts", `const ctxOf = (session) => ({ session, actor: d.human() });`)).toEqual([]);
  // the fold and the interface name the two types as data: that is not writing one
  expect(decisionsAreThePersons("src/core/state/builder.ts", `if (e.type === "builder.decided") { }`)).toEqual([]);
  expect(decisionsAreThePersons("src/web/describe.ts", `const rows = { type: "builder.decided", label: "a decision" };`)).toEqual([]);
  const sends = `const r = await runQuery(session, deps.runner, { source, text, actor: ctx.actor });`;
  expect(probesGoThroughTheRunner(BUILDER_SERVER, sends)).toEqual([]);
  expect(probesGoThroughTheRunner(BUILDER_SERVER, `import { sqlConnector } from "../modules/connectors/sqlite";\n${sends}`)).toEqual([`${BUILDER_SERVER} imports ../modules/connectors/sqlite`]);
  expect(probesGoThroughTheRunner(BUILDER_SERVER, `${sends}\nconst c = deps.runner.pool.get(source); await c.query(text);`)).toEqual([`${BUILDER_SERVER} names .pool`]);
  expect(probesGoThroughTheRunner(BUILDER_SERVER, `const pool = new ConnectorPool(ctx);\n${sends}`)).toEqual([`${BUILDER_SERVER} names ConnectorPool`]);
  expect(probesGoThroughTheRunner(BUILDER_SERVER, `const rows = await source.query(text);`)).toEqual([`${BUILDER_SERVER} does not send a probe through runQuery`]);
  expect(probesGoThroughTheRunner("src/server/seek.ts", `deps.runner.pool.get(x)`)).toEqual([]);
  // slice 14: only the person passes the adopt gate
  const pass = `return { type: "gate.passed", actor: ctx.actor, payload: { gate: "adopt" }, run };`;
  expect(adoptIsThePersons(IMPROVE_SERVER, pass)).toEqual([]);
  expect(adoptIsThePersons("src/pipeline/improve/adopt.ts", pass)).toEqual(["src/pipeline/improve/adopt.ts passes the adopt gate"]);
  expect(adoptIsThePersons(IMPROVE_SERVER, `return { type: "gate.passed", actor: ENGINE, payload: { gate: "adopt" } };`)).toEqual([`${IMPROVE_SERVER} passes the adopt gate with an actor that is not the request's person`]);
  expect(adoptIsThePersons("src/pipeline/publish.ts", `const entries = [{ type: "gate.passed", actor, payload: { gate: "publish" } }];`)).toEqual([]);
});

test("the slice 12 rules see what they are about: the three writers write, the agents and stages exist, and the loop routes name the person", () => {
  for (const w of WRITERS) expect(`${w}: ${sources.some((f) => f.path === w && WRITES.test(f.text))}`).toBe(`${w}: true`);
  expect(sources.filter((f) => /^src\/(agents|pipeline)\//.test(f.path)).length).toBeGreaterThanOrEqual(20);
  const routes = sources.find((f) => f.path === "src/server/loop-routes.ts")!.text;
  for (const call of ["copyLoop(", "saveLoop("]) expect(routes).toContain(call);
  expect([...routes.matchAll(/\{ actor: d\.human\(\) \}/g)].length).toBeGreaterThanOrEqual(2);
});

// ---------- slice 11: only a person or code unloads, loads or deletes a case, and the case file stays on the server ----------

/** Every text file under a folder of the repository. */
function textFiles(dir: string): { path: string; text: string }[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? textFiles(p) : /\.(ts|ya?ml|md|json)$/.test(n) ? [{ path: rel(p), text: readFileSync(p, "utf8") }] : [];
  });
}
/** The calls, classes, routes and route permissions that unload, load or delete a case. */
const CASE_MOVES = /\bunloadCase\b|\bloadCase\b|\bCaseStoreFolder\b|\/api\/store\b|\/unload\b|\bunload_case\b|\bload_case\b|\bdelete_stored\b/;
const noAgentMovesCases: Rule = (path, text) =>
  /^src\/(agents|pipeline)\//.test(path) && CASE_MOVES.test(text) ? [`${path} names ${text.match(CASE_MOVES)![0]}`] : [];
const sampleNamesNoMove: Rule = (path, text) => (path.startsWith("sample/") && CASE_MOVES.test(text) ? [`${path} names ${text.match(CASE_MOVES)![0]}`] : []);
/** The case file, the store, the tar code they share and the loop file are server-side core: neither the browser's code nor the fold imports them. */
const SERVER_CORE = ["src/core/casefile", "src/core/packfile", "src/core/redact", "src/core/store", "src/core/tar"].flatMap((d) => [d, `${d}.ts`]);
/** Every file whose name starts with this is server-side core too: the loop file and anything beside it named for it. */
const LOOPFILE = "src/core/loopfile";
const reachesLoopFile = (path: string, spec: string): boolean =>
  spec.startsWith(".") && relative(ROOT, resolve(ROOT, dirname(path), spec)).startsWith(LOOPFILE);
const caseFileStaysOnServer: Rule = (path, text) =>
  /^src\/(web|core\/state)\//.test(path)
    ? imports(text).filter((spec) => SERVER_CORE.some((d) => reaches(path, spec, d)) || reachesLoopFile(path, spec)).map((spec) => `${path} imports ${spec}`)
    : [];

test("no agent tool and no stage runner can unload, load or delete a case", () => {
  expect(sources.filter((f) => /^src\/(agents\/tools|pipeline\/stages)\//.test(f.path)).length).toBeGreaterThanOrEqual(10);
  expect(sources.flatMap((f) => noAgentMovesCases(f.path, f.text))).toEqual([]);
  const sample = textFiles(join(ROOT, "sample"));
  expect(sample.some((f) => f.path.startsWith("sample/context/"))).toBe(true);
  expect(sample.flatMap((f) => sampleNamesNoMove(f.path, f.text))).toEqual([]);
  // the rules catch what they are for
  expect(noAgentMovesCases("src/agents/tools/x.ts", "await wb.unloadCase(id, { actor })")).toHaveLength(1);
  expect(noAgentMovesCases("src/pipeline/stages/x.ts", "new CaseStoreFolder(dir)")).toHaveLength(1);
  expect(noAgentMovesCases("src/pipeline/engine.ts", `fetch("/api/store/load")`)).toHaveLength(1);
  expect(noAgentMovesCases("src/server/hub.ts", "await wb.unloadCase(id, { actor })")).toEqual([]);
  expect(sampleNamesNoMove("sample/context/personas/x.yaml", "tools: [list_cards, load_case]")).toHaveLength(1);
});

test("the case file, the store, the tar code and the loop file are never imported by the browser's code or by the fold", () => {
  expect(sources.some((f) => f.path === "src/core/casefile.ts") && sources.some((f) => f.path === "src/core/store.ts")).toBe(true);
  expect(sources.flatMap((f) => caseFileStaysOnServer(f.path, f.text))).toEqual([]);
  expect(caseFileStaysOnServer("src/web/views/x.ts", `import { checkCaseFile } from "../../core/casefile";`)).toHaveLength(1);
  expect(caseFileStaysOnServer("src/core/state/x.ts", `import type { CaseManifest } from "../casefile";`)).toHaveLength(1);
  expect(caseFileStaysOnServer("src/web/x.ts", `import { CaseStoreFolder } from "../core/store.ts";`)).toHaveLength(1);
  // the tar code the case file and the loop file share is server-side core too (slice 12)
  expect(sources.some((f) => f.path === "src/core/tar.ts")).toBe(true);
  expect(caseFileStaysOnServer("src/web/views/x.ts", `import { readTarGz } from "../../core/tar";`)).toHaveLength(1);
  expect(caseFileStaysOnServer("src/core/state/x.ts", `import type { TarMember } from "../tar.ts";`)).toHaveLength(1);
  expect(caseFileStaysOnServer("src/server/x.ts", `import { writeTarGz } from "../core/tar";`)).toEqual([]);
  // the loop file is server-side core (slice 12): the browser and the fold never import it
  expect(sources.some((f) => f.path === "src/core/loopfile.ts")).toBe(true);
  expect(caseFileStaysOnServer("src/web/views/x.ts", `import { readLoopFile } from "../../core/loopfile";`)).toHaveLength(1);
  expect(caseFileStaysOnServer("src/core/state/x.ts", `import type { LoopFileManifest } from "../loopfile.ts";`)).toHaveLength(1);
  expect(caseFileStaysOnServer("src/web/x.ts", `import { x } from "../core/loopfile-parts.ts";`)).toHaveLength(1);
  expect(caseFileStaysOnServer("src/server/x.ts", `import { writeLoopFile } from "../core/loopfile";`)).toEqual([]);
  expect(caseFileStaysOnServer("src/web/app.ts", `import { CaseStore } from "./store";`)).toEqual([]);
  expect(caseFileStaysOnServer("src/server/x.ts", `import { checkCaseFile } from "../core/casefile";`)).toEqual([]);
});

/** readTarGz and writeTarGz are named only by tar.ts (which defines them) and packfile.ts (the one packer and reader of every packed file). */
const TAR_RW = /\b(?:readTarGz|writeTarGz)\b/;
const tarOnlyThroughPackfile: Rule = (path, text) =>
  path !== "src/core/tar.ts" && path !== "src/core/packfile.ts" && TAR_RW.test(text) ? [`${path} names ${text.match(TAR_RW)![0]}`] : [];

test("src/core/loopfile.ts imports no reader or writer of tar: it reads and writes through packfile.ts", () => {
  const loopfile = sources.find((f) => f.path === "src/core/loopfile.ts")!;
  expect(loopfile).toBeDefined();
  // its imports from ./tar are types and `shown` only
  const fromTar = [...loopfile.text.matchAll(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+"\.\/tar";$/gm)];
  expect(fromTar.length).toBeGreaterThan(0);
  expect(fromTar.filter((m) => m[1] === undefined).flatMap((m) => m[2]!.split(",").map((s) => s.trim()))).toEqual(["shown"]);
  expect(imports(loopfile.text)).toContain("./packfile");
  expect(sources.flatMap((f) => tarOnlyThroughPackfile(f.path, f.text))).toEqual([]);
  expect(tarOnlyThroughPackfile("src/core/loopfile.ts", `import { readTarGz } from "./tar";`)).toHaveLength(1);
  expect(tarOnlyThroughPackfile("src/core/packfile.ts", `import { readTarGz, writeTarGz } from "./tar";`)).toEqual([]);
});

// ---------- what the security notes claim, over a real socket on 127.0.0.1 ----------

const SECRET = "planted-secret-value-91d7", SECRET_NAME = "SAMPLE_PLANTED_SECRET";
const sys: Actor = { kind: "system", id: "test" };
let s: Served;
let id: string;
beforeAll(async () => {
  s = await served({ listen: true, credential: { name: SECRET_NAME, value: SECRET } });
  id = await s.newCase();
  await s.toPublishGate(id);
  expect((await s.command(id, "approve")).status).toBe(200);
  await s.app.hub.idle();
}, 120000);
afterAll(async () => { await s?.close(); });

const text = async (res: Response): Promise<string> => Buffer.from(await res.arrayBuffer()).toString("latin1");
const asPerson = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${s.origin}${path}`, init);

test("the server answers only at its own origin: another Host, another Origin and a cross-site request are refused, and no CORS header is ever sent", async () => {
  const port = new URL(s.origin).port;
  // fetch sets Host itself, so a request for another name is made with a raw socket
  const raw = async (head: string): Promise<string> => {
    let got = "";
    const done = Promise.withResolvers<void>();
    const sock = await Bun.connect({ hostname: "127.0.0.1", port: Number(port), socket: { data: (_s, d) => { got += d.toString(); }, close: () => done.resolve(), error: () => done.resolve() } });
    sock.write(head);
    await Promise.race([done.promise, Bun.sleep(1000)]);
    sock.end();
    return got;
  };
  expect(await raw(`GET /api/me HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`)).toStartWith("HTTP/1.1 421");
  expect(await raw(`GET /api/me HTTP/1.1\r\nHost: evil.example:${port}\r\nConnection: close\r\n\r\n`)).toStartWith("HTTP/1.1 421");
  expect((await asPerson("/api/me", { headers: { origin: "http://evil.example" } })).status).toBe(403);
  expect((await asPerson("/api/me", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
  const post = (headers: Record<string, string>) => asPerson("/api/cases", { method: "POST", body: "{}", headers });
  expect((await post({ "content-type": "application/json" })).status).toBe(403);
  expect((await post({ origin: "http://evil.example", "content-type": "application/json" })).status).toBe(403);
  expect((await post({ origin: s.origin, "content-type": "text/plain" })).status).toBe(403);
  const ok = await asPerson("/api/me", { headers: { origin: s.origin } });
  expect(ok.status).toBe(200);
  const preflight = await asPerson("/api/cases", { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
  for (const res of [ok, preflight]) for (const name of res.headers.keys()) expect(name.toLowerCase().startsWith("access-control-")).toBe(false);
});

test("the page runs under a content security policy with trusted types and is a constant: no data is ever written into it", async () => {
  const before = await asPerson("/");
  const policy = before.headers.get("content-security-policy") ?? "";
  for (const part of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "require-trusted-types-for 'script'", "trusted-types 'none'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"]) expect(policy).toContain(part);
  expect(policy).not.toContain("unsafe");
  const html = await before.text();
  expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
  expect(html).not.toMatch(/\son[a-z]+=|style=/);
  const hostile = await s.newCase({ title: "</title><script>alert(1)</script>", asked: "<img src=x onerror=alert(1)>" });
  expect(await (await asPerson("/")).text()).toBe(html);
  // the hostile text is data in the stream, as recorded, never markup in the page
  expect(JSON.stringify(s.entries(hostile))).toContain("<script>alert(1)</script>");
});

test("a requester's view may read the page and nothing of a case, and may not do what a person does, even when the request is made by hand", async () => {
  const t = await served({ listen: true, role: "requester" });
  try {
    const made = await fetch(`${t.origin}/api/cases`, { method: "POST", headers: { origin: t.origin, "content-type": "application/json" }, body: "{}" });
    expect(made.status).toBe(403);
    for (const path of ["/api/cases", "/api/reference", "/api/cases/CASE-1/entries"]) expect((await fetch(`${t.origin}${path}`)).status).toBe(403);
    expect((await fetch(`${t.origin}/`)).status).toBe(200);
  } finally {
    await t.close();
  }
});

test("the server names the person itself: a body that names an actor writes nothing", async () => {
  const before = s.entries(id).length;
  const res = await s.post(`/api/cases/${id}/commands`, { command: "stop_run", actor: { kind: "human", id: "someone-else" }, args: { reason: "x" } });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(s.entries(id).length).toBe(before);
});

test("blobs and bundle files are served as attachments that cannot run as pages of this origin", async () => {
  const session = s.app.hub.read(id);
  const asHtml = session.blobs.put("<html><script>alert(1)</script></html>", "text/html");
  session.commit(() => [{ type: "tool.returned", actor: sys, payload: { call: "html1", ok: true, summary: "planted", result: asHtml } }]);
  const blob = await asPerson(`/api/cases/${id}/blobs/${asHtml.blob}`);
  expect(blob.status).toBe(200);
  expect(blob.headers.get("content-type")).toBe("application/octet-stream");
  expect(blob.headers.get("content-disposition")).toStartWith("attachment");
  expect(blob.headers.get("content-security-policy")).toContain("sandbox");
  expect(blob.headers.get("x-content-type-options")).toBe("nosniff");
  for (const f of ["product.md", "product.json", "provenance.md", "manifest.json"]) {
    const res = await asPerson(`/api/cases/${id}/published/1/${f}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toStartWith("attachment");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("content-type")).not.toContain("html");
  }
  expect((await asPerson(`/api/cases/${id}/published/1/..%2f..%2fledger.sqlite`)).status).toBe(404);
});

test("a blob that only an entry the fold skipped refers to is still served (a known limit)", async () => {
  const other = await s.newCase();
  const session = s.app.hub.read(other);
  const ref = session.blobs.put("named only by a malformed entry", "text/plain");
  const before = session.state.skipped.length;
  session.commit(() => [{ type: "query.result", actor: sys, payload: { query: 7, result: ref, rows: "many", rows_hash: 1, coverage: "all" } as never }]);
  expect(session.state.skipped.length).toBe(before + 1);
  const res = await asPerson(`/api/cases/${other}/blobs/${ref.blob}`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("named only by a malformed entry");
});

test("entries and blobs reach the browser as recorded, and no response of any kind holds the planted credential", async () => {
  const seen: { path: string; body: string }[] = [];
  const grab = async (path: string): Promise<string> => { const body = await text(await asPerson(path)); seen.push({ path, body }); return body; };
  for (const p of ["/", "/app.js", "/app.css", "/api/me", "/api/reference", "/api/cases", "/api/routes", `/api/cases/${id}/models`, `/api/cases/${id}/agent`, `/api/cases/${id}/custody`, `/api/cases/${id}/preview`]) await grab(p);
  // the stream, read as the browser reads it, is each entry exactly as recorded
  const ctl = new AbortController();
  const stream = await asPerson(`/api/cases/${id}/entries`, { signal: ctl.signal });
  const reader = stream.body!.getReader();
  let streamed = "";
  const want = s.entries(id).length;
  while ((streamed.match(/^id: /gm) ?? []).length < want) {
    const { value, done } = await reader.read();
    if (done) break;
    streamed += new TextDecoder().decode(value);
  }
  ctl.abort();
  seen.push({ path: "entries stream", body: streamed });
  const datas = streamed.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
  expect(datas.length).toBe(want);
  s.entries(id).forEach((e, i) => expect(JSON.parse(datas[i]!)).toEqual(JSON.parse(JSON.stringify(e))));
  const session = s.app.hub.read(id);
  const blobs = new Set<string>();
  for (const e of session.entries()) for (const h of JSON.stringify(e.payload).match(/[0-9a-f]{64}/g) ?? []) if (session.blobs.has(h)) blobs.add(h);
  expect(blobs.size).toBeGreaterThan(3);
  for (const h of blobs) await grab(`/api/cases/${id}/blobs/${h}`);
  for (const f of ["product.md", "product.json", "provenance.md", "provenance.json", "manifest.json"]) await grab(`/api/cases/${id}/published/1/${f}`);
  for (const { path, body } of seen) {
    expect(`${path}: ${body.includes(SECRET)}`).toBe(`${path}: false`);
    expect(`${path}: ${body.includes(SECRET_NAME)}`).toBe(`${path}: false`);
  }
  // derived views name no source's location, user, folder or root
  const location = new URL(await Bun.file(join(s.dir, "sample", "sources", "reputation.yaml")).text().then((t) => /location:\s*(\S+)/.exec(t)![1]!)).host;
  for (const { path, body } of seen.filter((x) => x.path.startsWith("/api/") && !x.path.includes("/blobs/") && !x.path.includes("/published/"))) {
    expect(`${path}: ${body.includes(location)}`).toBe(`${path}: false`);
    // the one path shown is the case store's folder, to the analyst, in /api/me (slice 11)
    const without = path === "/api/me" ? body.replace(JSON.stringify(join(s.dir, "wb", "store")), '""') : body;
    expect(`${path}: ${without.includes(s.dir)}`).toBe(`${path}: false`);
  }
});

test("POST answers, refusals, the difference route, errors and the stream hold no planted credential and carry no CORS header", async () => {
  const seen: { path: string; status: number; body: string; headers: Headers }[] = [];
  const keep = async (path: string, res: Response): Promise<Response> => { seen.push({ path, status: res.status, body: await text(res), headers: res.headers }); return res; };
  const post = (path: string, body: unknown): Promise<Response> => asPerson(path, { method: "POST", headers: { origin: s.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const command = (c: string, name: string, args: Record<string, unknown>) => post(`/api/cases/${c}/commands`, { command: name, args });
  const made = await keep("create_case", await post("/api/cases", { title: "Planted", asked: "Is the address known to be bad?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" }));
  expect(made.status).toBe(200);
  const other = (JSON.parse(seen.at(-1)!.body) as { id: string }).id;
  // the pivot that uses the credentialled source: refused without a budget, then run with one
  expect((await keep("pivot, no budget", await command(other, "run_pivot", { pivot: "address_to_verdict", value: SAMPLE_START.value, window: SAMPLE_WINDOW, why: "is it bad" }))).status).toBe(409);
  expect((await keep("pivot", await command(other, "run_pivot", { pivot: "address_to_verdict", value: SAMPLE_START.value, window: SAMPLE_WINDOW, why: "is it bad", budget: 10 }))).status).toBe(200);
  const card = Object.values(s.app.hub.read(other).state.cards).at(-1)!.id;
  expect((await keep("verify", await command(other, "verify_card", { card, budget: 10 }))).status).toBe(200);
  await s.app.hub.idle();
  await keep("difference", await asPerson(`/api/cases/${other}/cards/${card}/difference`));
  await keep("difference, published case", await asPerson(`/api/cases/${id}/cards/c1/difference`));
  expect((await keep("refusal", await command(id, "stop", { reason: "done" }))).status).toBe(409);
  expect((await keep("unknown command", await command(id, "no_such_command", {}))).status).toBe(400);
  expect((await keep("unknown case", await asPerson("/api/cases/CASE-404/custody"))).status).toBe(404);
  expect((await keep("bad stream position", await asPerson(`/api/cases/${id}/entries?after=x`))).status).toBe(400);
  const ctl = new AbortController();
  const stream = await asPerson(`/api/cases/${id}/entries`, { signal: ctl.signal });
  seen.push({ path: "stream", status: stream.status, body: "", headers: stream.headers });
  ctl.abort();
  for (const { path, body, headers } of seen) {
    expect(`${path}: ${body.includes(SECRET)}`).toBe(`${path}: false`);
    expect(`${path}: ${body.includes(SECRET_NAME)}`).toBe(`${path}: false`);
    for (const name of headers.keys()) expect(`${path}: ${name.toLowerCase().startsWith("access-control-")}`).toBe(`${path}: false`);
    expect(`${path}: ${headers.get("x-content-type-options")}`).toBe(`${path}: nosniff`);
  }
  expect(s.app.hub.read(other).state.skipped).toEqual([]);
});

test("the page loads exactly one script and one stylesheet, and every bundle file is nosniff", async () => {
  const html = await (await asPerson("/")).text();
  expect((html.match(/<script\b/g) ?? []).length).toBe(1);
  expect(html).toMatch(/<script [^>]*src="\/app\.js"/);
  expect((html.match(/<link\b[^>]*rel="stylesheet"/g) ?? []).length).toBe(1);
  expect((html.match(/<link\b/g) ?? []).length).toBe(1);
  expect(html).toMatch(/<link [^>]*href="\/app\.css"/);
  for (const f of ["product.md", "product.json", "provenance.md", "provenance.json", "manifest.json"]) {
    const res = await asPerson(`/api/cases/${id}/published/1/${f}`);
    expect(`${f}: ${res.status} ${res.headers.get("x-content-type-options")}`).toBe(`${f}: 200 nosniff`);
    expect(res.headers.get("content-type")).toBe(f.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/json");
    await res.arrayBuffer();
  }
});

test("the sample run folds with nothing skipped", () => {
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
});

// ---------- slice 13: the memory routes ----------

test("every memory route is in the app's table behind the role check, and no memory route reads an actor from its body", async () => {
  const app = sources.find((f) => f.path === "src/server/app.ts")!.text;
  const table = app.slice(app.indexOf("const routes: Route[] = ["));
  expect(table).toContain("...memoryTable,");
  expect(app).toMatch(/const memoryTable = memoryRoutes\(\{[^}]*human: \(\) => \(\{ kind: "human", id: config\.user \}\)/);
  const routes = sources.find((f) => f.path === "src/server/memory-routes.ts")!.text;
  // each route literal names what it needs (a read or a command), so the role check applies to it; none takes an actor from what it is sent
  const literals = [...routes.matchAll(/\{\s*method:\s*"(GET|POST)",\s*path[^\n]*/g)].map((m) => m[0]);
  expect(literals.length).toBeGreaterThanOrEqual(4);
  for (const l of literals) if (!l.includes("needs:")) expect(routes).toMatch(/method: "POST", path, needs: \{ command \}/);
  expect(serverNamesTheActor("src/server/memory-routes.ts", routes)).toEqual([]);
  expect(serverNamesTheActor("src/server/memory-commands.ts", sources.find((f) => f.path === "src/server/memory-commands.ts")!.text)).toEqual([]);
  expect(routes).not.toMatch(/["']actor["']\s*[,\]]/);
  expect([...routes.matchAll(/actor:\s*([^,}\n]+)/g)].map((m) => m[1]!.trim()).every((a) => a === "d.human()")).toBe(true);

  // the same, from outside: a requester may not read or change memory, and a body that names an actor writes nothing
  const paths: [string, string, unknown?][] = [
    ["GET", "/api/memory"], ["GET", `/api/cases/${id}/memory`], ["GET", "/api/memory/files/memory.TLP-CLEAR.000000000000.memory.tar.gz"],
    ["POST", "/api/memory/lessons", {}], ["POST", "/api/memory/lessons/LESSON-1/accept", {}], ["POST", "/api/memory/lessons/LESSON-1/reject", {}],
    ["POST", "/api/memory/lessons/LESSON-1/retire", {}], ["POST", "/api/memory/export", {}], ["POST", "/api/memory/load", {}],
  ];
  const t = await served({ listen: true, role: "requester" });
  try {
    for (const [method, path, body] of paths) {
      const res = await fetch(`${t.origin}${path}`, method === "GET" ? {} : { method, headers: { origin: t.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(`${method} ${path}: ${res.status}`).toBe(`${method} ${path}: 403`);
    }
  } finally {
    await t.close();
  }
  const before = s.wb.memory.head();
  const lesson = s.wb.memory.state.order[0]!;
  const someone = { kind: "human", id: "someone-else" };
  for (const [path, body] of [
    ["/api/memory/lessons", { case_type: "unknown-device", title: "T", text: "x", triggers: [], marking: "TLP:CLEAR", supersedes: null, actor: someone }],
    [`/api/memory/lessons/${lesson}/accept`, { hash: s.wb.memory.state.lessons[lesson]!.hash, actor: someone }],
    [`/api/memory/lessons/${lesson}/reject`, { reason: "r", actor: someone }],
    [`/api/memory/lessons/${lesson}/retire`, { reason: "r", actor: someone }],
    ["/api/memory/export", { actor: someone }], ["/api/memory/load", { file: "x", typed: "x", actor: someone }],
  ] as [string, unknown][]) {
    const res = await s.post(path, body);
    expect(`${path}: ${res.status}`).toBe(`${path}: 400`);
    expect(((await res.json()) as { refused: string[] }).refused).toEqual(["the server names the actor"]);
  }
  expect(s.wb.memory.head()).toEqual(before);
});

// ---------- slice 14: the improve routes and commands ----------

test("both improve routes are in the app's table behind the role check, and no improve route or command reads an actor from its body", async () => {
  const app = sources.find((f) => f.path === "src/server/app.ts")!.text;
  const table = app.slice(app.indexOf("const routes: Route[] = ["));
  expect(table).toContain("...improveTable,");
  expect(app).toMatch(/const improveTable = improveRoutes\(\{[^}]*human: \(\) => \(\{ kind: "human", id: config\.user \}\)/);
  const routes = sources.find((f) => f.path === "src/server/improve-routes.ts")!.text;
  const literals = [...routes.matchAll(/\{\s*method:\s*"(GET|POST)",\s*path[^\n]*/g)].map((m) => m[0]);
  expect(literals.length).toBe(2);
  for (const l of literals) expect(l).toMatch(/needs: \{ (read: "improve"|command: "create_improve") \}/);
  for (const path of ["src/server/improve-routes.ts", IMPROVE_SERVER]) expect(serverNamesTheActor(path, sources.find((f) => f.path === path)!.text)).toEqual([]);
  // the person the routes name is the server's, and a case command's is the one app.ts names
  expect([...routes.matchAll(/actor:\s*([^,}\n]+)/g)].map((m) => m[1]!.trim())).toEqual(["ctx.actor"]);
  expect(routes).toContain("d.human()");

  // the same, from outside: a requester may not read an improve view, make an improve case or decide at Adopt
  const t = await served({ listen: true, role: "requester" });
  try {
    for (const [method, path, body] of [
      ["GET", "/api/cases/CASE-1/improve"], ["POST", "/api/improve", { loop: "investigation", case_type: "unknown-device", tasks: 1, candidates: 1, marking: "TLP:AMBER" }],
      ["POST", "/api/cases/CASE-1/commands", { command: "adopt_decide", args: { change: "chg-1", accept: true } }],
      ["POST", "/api/cases/CASE-1/commands", { command: "set_known_answer", args: { product: 1, text: "x", findings: [], marking: "TLP:RED" } }],
    ] as [string, string, unknown?][]) {
      const res = await fetch(`${t.origin}${path}`, method === "GET" ? {} : { method, headers: { origin: t.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(`${method} ${path}: ${res.status}`).toBe(`${method} ${path}: 403`);
    }
    expect(t.wb.listCases()).toEqual([]);
  } finally {
    await t.close();
  }
});

// ---------- slice 14 (Task 22): code passes a gate in exactly one function, and only a person decides a builder's change ----------

/** Each top-level declaration of a file (a function or a const), with where its text starts and ends. */
function declarations(text: string): { name: string; start: number; end: number }[] {
  const heads = [...text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*[:=])/gm)];
  return heads.map((m, i) => ({ name: (m[1] ?? m[2])!, start: m.index!, end: i + 1 < heads.length ? heads[i + 1]!.index! : text.length }));
}
const enclosing = (text: string, at: number): { name: string; body: string } | null => {
  const d = declarations(text).filter((x) => x.start <= at).at(-1);
  return d === undefined ? null : { name: d.name, body: text.slice(d.start, d.end) };
};
const PLANS = "src/pipeline/plans.ts";
/** Every function that writes gate.passed, and what in its body makes its actor a person (null: writeAcceptance, whose actor is its caller's). */
const GATE_WRITERS: Record<string, RegExp | null> = {
  [`${PLANS} writeAcceptance`]: null,
  [`${PLANS} requestReplan`]: /\bonlyAPerson\(input\.actor\)/,
  ["src/pipeline/publish.ts approve"]: /\batGate\(session, actor\)/,
  [`${IMPROVE_SERVER} passAdopt`]: /\bactor:\s*ctx\.actor\b/,
};
/** The callers of writeAcceptance, and what each must hold: a person's check before it, or the probe child's policy and the probe's actor. */
const ACCEPTANCE_CALLERS: Record<string, RegExp[]> = {
  acceptPlan: [/\bonlyAPerson\(input\.actor\);[\s\S]*\bwriteAcceptance\([^)]*\binput\.actor\)/],
  probeAcceptPlan: [/probe_of\?\.plan_gate !== "accept"\) throw/, /\bwriteAcceptance\([^)]*\bPROBE_ACTOR\)/],
};
const GATE_PASS = /\btype:\s*["']gate\.passed["']/g;
const gatesArePassedByAPerson: Rule = (path, text) => {
  if (!/^src\//.test(path) || /^src\/(?:core|web)\//.test(path)) return [];
  const found: string[] = [];
  for (const m of text.matchAll(GATE_PASS)) {
    const fn = enclosing(text, m.index!);
    const key = `${path} ${fn?.name ?? "(top level)"}`;
    if (!Object.hasOwn(GATE_WRITERS, key)) { found.push(`${key} writes gate.passed`); continue; }
    const guard = GATE_WRITERS[key]!;
    if (guard !== null && !guard.test(fn!.body)) found.push(`${key} writes gate.passed without a person's check`);
    if (guard !== null && /\bPROBE_ACTOR\b|["']improve-probe["']/.test(fn!.body)) found.push(`${key} names the probe's actor`);
  }
  for (const m of text.matchAll(/\bwriteAcceptance\s*\(/g)) {
    const fn = enclosing(text, m.index!);
    if (fn === null || /^(?:export\s+)?function\s+writeAcceptance\b/.test(fn.body)) continue;
    if (path !== PLANS || !Object.hasOwn(ACCEPTANCE_CALLERS, fn.name)) { found.push(`${path} ${fn.name} calls writeAcceptance`); continue; }
    for (const re of ACCEPTANCE_CALLERS[fn.name]!) if (!re.test(fn.body)) found.push(`${path} ${fn.name} calls writeAcceptance without ${re.source}`);
  }
  if (/^\s*export\s+function\s+writeAcceptance\b/m.test(text)) found.push(`${path} exports writeAcceptance`);
  return found;
};
/** The functions that hand writeAcceptance an actor that is not the caller's checked person: the code-passed gate. */
const codePassers = (path: string, text: string): string[] =>
  [...text.matchAll(/\bwriteAcceptance\s*\(([^)]*)\)/g)].filter((m) => /\bPROBE_ACTOR\b/.test(m[1]!)).map((m) => `${path} ${enclosing(text, m.index!)!.name}`);

test("gate.passed is written by a non-person in exactly one function, probeAcceptPlan", () => {
  expect(sources.flatMap((s) => gatesArePassedByAPerson(s.path, s.text))).toEqual([]);
  expect(sources.flatMap((s) => codePassers(s.path, s.text))).toEqual([`${PLANS} probeAcceptPlan`]);
  // every writer the table names is there: the table is not stale
  const writers = sources.flatMap((s) => [...s.text.matchAll(GATE_PASS)].map((m) => `${s.path} ${enclosing(s.text, m.index!)?.name}`)).filter((k) => !/^src\/(?:core|web)\//.test(k));
  expect([...new Set(writers)].sort()).toEqual(Object.keys(GATE_WRITERS).sort());
  // the probe's actor is the system's improve-probe, defined once
  const plans = sources.find((s) => s.path === PLANS)!.text;
  expect(plans).toMatch(/export const PROBE_ACTOR: Actor = \{ kind: "system", id: "improve-probe" \};/);
  expect(sources.filter((s) => /\bPROBE_ACTOR\s*(?::\s*Actor\s*)?=/.test(s.text)).map((s) => s.path)).toEqual([PLANS]);
  // planted: a stage that passes a gate, a writer that lost its check, another caller of writeAcceptance, and the probe's actor on another gate
  expect(gatesArePassedByAPerson("src/pipeline/stages/x.ts", `export function pass(s) {\n  s.commit(() => [{ type: "gate.passed", actor: ENGINE, payload: { gate: "plan" } }]);\n}\n`)).toEqual(["src/pipeline/stages/x.ts pass writes gate.passed"]);
  expect(gatesArePassedByAPerson(PLANS, `export function requestReplan(session, input) {\n  session.commit(() => [{ type: "gate.passed", actor: input.actor, payload: { gate: "plan" } }]);\n}\n`)).toEqual([`${PLANS} requestReplan writes gate.passed without a person's check`]);
  expect(gatesArePassedByAPerson(PLANS, `export function autoAccept(session) {\n  writeAcceptance(session, plan, steps, {}, ENGINE);\n}\n`)).toEqual([`${PLANS} autoAccept calls writeAcceptance`]);
  expect(gatesArePassedByAPerson("src/pipeline/engine.ts", `function go() {\n  writeAcceptance(session, plan, steps, {}, PROBE_ACTOR);\n}\n`)).toEqual(["src/pipeline/engine.ts go calls writeAcceptance"]);
  expect(gatesArePassedByAPerson(PLANS, `export function probeAcceptPlan(session) {\n  writeAcceptance(session, plan, steps, {}, PROBE_ACTOR);\n}\n`)).toHaveLength(1);
  expect(gatesArePassedByAPerson("src/pipeline/publish.ts", `export function approve(session, deps, input) {\n  atGate(session, actor);\n  const e = [{ type: "gate.passed", actor: PROBE_ACTOR, payload }];\n}\n`)).toEqual(["src/pipeline/publish.ts approve names the probe's actor"]);
  expect(gatesArePassedByAPerson(PLANS, `export function writeAcceptance() {}\n`)).toEqual([`${PLANS} exports writeAcceptance`]);
  expect(codePassers(PLANS, `function a() {\n  writeAcceptance(s, p, x, {}, PROBE_ACTOR);\n}\nfunction b() {\n  writeAcceptance(s, p, x, b, input.actor);\n}\n`)).toEqual([`${PLANS} a`]);
});

test("builder.decided is written only in src/server/builder.ts", () => {
  const WRITE = /\btype:\s*["']builder\.decided["']/g;
  const found = sources.flatMap((s) => [...s.text.matchAll(WRITE)].map(() => s.path));
  expect(found.length).toBeGreaterThan(0);
  expect([...new Set(found)]).toEqual([BUILDER_SERVER]);
  // and each one there is the request's person's (the slice 12 rule), in builderDecide or builderDecideAll
  const builder = sources.find((s) => s.path === BUILDER_SERVER)!.text;
  expect(decisionsAreThePersons(BUILDER_SERVER, builder)).toEqual([]);
  expect([...new Set([...builder.matchAll(WRITE)].map((m) => enclosing(builder, m.index!)!.name))].sort()).toEqual(["builderDecide", "builderDecideAll"]);
  // the improve loop's accept reaches it only through builderDecideAll, as the person
  const improve = sources.find((s) => s.path === IMPROVE_SERVER)!.text;
  expect(improve).toMatch(/\bbuilderDecideAll\(ctx,/);
  expect(sources.filter((s) => s.path.startsWith("src/pipeline/") || s.path.startsWith("src/agents/")).filter((s) => /\bbuilderDecide(?:All)?\b/.test(s.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""))).map((s) => s.path)).toEqual([]);
});
