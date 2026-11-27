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

const RULES: [string, Rule][] = [
  ["no file under src/server or src/web imports from src/modules/connectors", noConnectorImports],
  ["no file under src/web except build.ts imports from src/server, src/modules, src/agents, src/pipeline or src/cli", webIsIsolated],
  ["only src/cli constructs a ConnectorPool", onlyCliBuildsAPool],
  ["Bun.serve appears only in src/server/app.ts, always with hostname 127.0.0.1", listensOnlyOnLoopback],
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
/** The case file and the store are server-side core: neither the browser's code nor the fold imports them. */
const caseFileStaysOnServer: Rule = (path, text) =>
  /^src\/(web|core\/state)\//.test(path)
    ? imports(text).filter((spec) => ["src/core/casefile", "src/core/store", "src/core/casefile.ts", "src/core/store.ts"].some((d) => reaches(path, spec, d))).map((spec) => `${path} imports ${spec}`)
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

test("the case file and the store are never imported by the browser's code or by the fold", () => {
  expect(sources.some((f) => f.path === "src/core/casefile.ts") && sources.some((f) => f.path === "src/core/store.ts")).toBe(true);
  expect(sources.flatMap((f) => caseFileStaysOnServer(f.path, f.text))).toEqual([]);
  expect(caseFileStaysOnServer("src/web/views/x.ts", `import { checkCaseFile } from "../../core/casefile";`)).toHaveLength(1);
  expect(caseFileStaysOnServer("src/core/state/x.ts", `import type { CaseManifest } from "../casefile";`)).toHaveLength(1);
  expect(caseFileStaysOnServer("src/web/x.ts", `import { CaseStoreFolder } from "../core/store.ts";`)).toHaveLength(1);
  expect(caseFileStaysOnServer("src/web/app.ts", `import { CaseStore } from "./store";`)).toEqual([]);
  expect(caseFileStaysOnServer("src/server/x.ts", `import { checkCaseFile } from "../core/casefile";`)).toEqual([]);
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
