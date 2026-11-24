import { afterEach, beforeEach, expect, test } from "bun:test";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import type { SourceManifest } from "../../src/modules/manifests";
import { ConnectorError, makeConnector } from "../../src/modules/connectors";
import type { Connector, QueryRequest } from "../../src/modules/connectors";
import { renderLiteral } from "../../src/modules/connectors/trino";
import { GuardError } from "../../src/modules/sqlguard";
import { startTrino } from "../helpers/trino-standin";
import type { TrinoStandin } from "../helpers/trino-standin";

const PW = "p4ssw0rd-xyz";
const win = { from: "2026-11-20T00:00:00.000Z", to: "2026-11-23T00:00:00.000Z" };
const TEXT = "select a from iceberg.s.events where ts >= {window.from} and ts < {window.to} limit 5";
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

let t: TrinoStandin;
let c: Connector;
let servers: { stop(force?: boolean): unknown }[] = [];
const realFetch = globalThis.fetch;

function source(location: string, over: Partial<SourceManifest> = {}): SourceManifest {
  return {
    id: "lake", title: "Lake", hash: "h1", dir: "/nonexistent", root: "/nonexistent", connector: "trino", location, credential: null, user: "workbench",
    tls_verify: true, marking: "TLP:AMBER", where: "hosted", confirmed: true, adhoc: false, cost: { weight: 0, unit: "" },
    limits: { max_rows: 5, timeout_ms: 200 }, quality: "", quality_notes: [],
    tables: [{ name: "iceberg.s.events", time_column: "ts", guarded: true, large_columns: [], file: null, format: null, columns: [] }], endpoints: [], ...over,
  };
}
const ctx = (env: Record<string, string> = {}) => ({ secrets: new Secrets(env, null), observables: new Observables([]) });
function req(q: string, bound: QueryRequest["bound"] = {}, w: QueryRequest["window"] = win, over: Partial<QueryRequest> = {}): QueryRequest {
  return { text: q, bound, window: w, max_rows: 5, timeout_ms: 200, budget: null, ...over };
}
const okReq = req(TEXT);
const make = (location: string, over: Partial<SourceManifest> = {}, env?: Record<string, string>): Connector => makeConnector(source(location, over), ctx(env));
/** A hand-written server for hostile behaviour the stand-in does not speak. */
function raw(handler: (req: Request, base: string) => Response | Promise<Response>): { url: string; hits: string[] } {
  const hits: string[] = [];
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(r): Response | Promise<Response> { hits.push(`${r.method} ${new URL(r.url).pathname}`); return handler(r, `http://127.0.0.1:${server.port}`); },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, hits };
}
const json = (v: unknown): Response => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

beforeEach(() => { t = startTrino(); c = make(t.url); });
afterEach(() => {
  globalThis.fetch = realFetch;
  c.close();
  t.stop();
  for (const s of servers) void s.stop(true);
  servers = [];
});

test("literals are rendered safely", () => {
  expect(renderLiteral("value", "ws-17")).toBe("'ws-17'");
  expect(renderLiteral("value", "o'brien")).toBe("'o''brien'");
  expect(renderLiteral("value", 42)).toBe("42");
  expect(renderLiteral("value", null)).toBe("NULL");
  expect(renderLiteral("window.from", "2026-11-20T00:00:00.000Z")).toBe("TIMESTAMP '2026-11-20 00:00:00.000 UTC'");
});

test("a value with a control character is refused", () => {
  expect(() => renderLiteral("value", "a\nb")).toThrow(ConnectorError);
  expect(() => renderLiteral("value", "a\x00b")).toThrow(ConnectorError);
  expect(() => renderLiteral("value", "a\x7fb")).toThrow(ConnectorError);
});

test("non-finite numbers and malformed window values are refused", () => {
  expect(() => renderLiteral("value", Number.NaN)).toThrow(ConnectorError);
  expect(() => renderLiteral("value", Infinity)).toThrow(ConnectorError);
  expect(() => renderLiteral("window.from", "yesterday")).toThrow(ConnectorError);
  expect(() => renderLiteral("window.to", 5)).toThrow(ConnectorError);
});

test("render fills placeholders with literals", () => {
  expect(c.render(req("select a from iceberg.s.events where host = {value} and ts >= {window.from} and ts < {window.to} limit 5", { value: "ws-17" })))
    .toBe("select a from iceberg.s.events where host = 'ws-17' and ts >= TIMESTAMP '2026-11-20 00:00:00.000 UTC' and ts < TIMESTAMP '2026-11-23 00:00:00.000 UTC' limit 5");
});

test("a value cannot break out of its literal", () => {
  const out = c.render(req("select a from iceberg.s.events where host = {value} and ts >= {window.from} limit 5", { value: "x' or 1=1 --" }));
  expect(out).toContain("host = 'x'' or 1=1 --' and");
  expect(() => c.render(req("select a from iceberg.s.events where host = {value} and ts >= {window.from}", {}))).toThrow(ConnectorError);
});

test("an open-ended window on a guarded table is refused", () => {
  const open = { from: null, to: win.to };
  try {
    c.render(req(TEXT, {}, open));
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(GuardError);
    expect((e as GuardError).message).toContain("window");
  }
  expect(t.statements).toHaveLength(0);
});

test("a write is refused before anything is sent", async () => {
  expect(() => c.render(req("delete from iceberg.s.events"))).toThrow(GuardError);
  await expect(c.run(req("delete from iceberg.s.events"))).rejects.toThrow(GuardError);
  await expect(c.run(req("select 1; drop table x"))).rejects.toThrow(GuardError);
  expect(t.statements).toHaveLength(0);
});

test("a guardrail violation is refused with every reason", async () => {
  const q = req("select * from iceberg.s.events");
  try {
    c.render(q);
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(GuardError);
    expect((e as GuardError).violations).toHaveLength(2);
  }
  await expect(c.run(q)).rejects.toThrow(GuardError);
  expect(t.statements).toHaveLength(0);
});

test("run sends the identity, UTC and a source tag, and follows pages to the end", async () => {
  t.on(/from iceberg\.s\.events/, { columns: ["a"], pages: [[[1], [2]], [[3]]] });
  const out = await c.run(okReq);
  expect(out.columns).toEqual(["a"]);
  expect(out.rows).toEqual([[1], [2], [3]]);
  expect(out.coverage).toEqual({ kind: "full" });
  expect(out.cost).toBeNull();
  expect(t.statements).toHaveLength(1);
  expect(t.statements[0]!.sql).toBe(c.render(okReq));
  expect(t.statements[0]!.headers).toMatchObject({ "x-trino-user": "workbench", "x-trino-time-zone": "UTC", "x-trino-source": "research-workbench", "content-type": "text/plain" });
  expect(t.statements[0]!.headers.authorization).toBeUndefined();
  expect(t.cancelled).toHaveLength(0);
});

test("the raw bytes are the pages as received", async () => {
  t.on(/./, { columns: ["a"], pages: [[[1], [2]], [[3]]] });
  const out = await c.run(okReq);
  const pages = JSON.parse(text(out.raw)) as { id: string; columns?: unknown; data?: unknown; nextUri?: string }[];
  expect(Array.isArray(pages)).toBe(true);
  expect(pages.map(p => p.data ?? null)).toEqual([null, [[1], [2]], [[3]]]);
  expect(pages[0]!.nextUri).toBe(`${t.url}/v1/statement/q1/1`);
  expect(pages[1]!.columns).toEqual([{ name: "a" }]);
  expect(pages[2]!.nextUri).toBeUndefined();
});

test("the row cap stops paging and cancels the query", async () => {
  t.on(/./, { columns: ["a"], pages: [[[1], [2], [3]], [[4], [5], [6]], [[7]]] });
  const out = await c.run(okReq);
  expect(out.rows).toHaveLength(5);
  expect(out.coverage).toMatchObject({ kind: "partial", reason: "row_limit" });
  expect(t.cancelled).toHaveLength(1);
  expect(JSON.parse(text(out.raw))).toHaveLength(3); // POST reply and two pages; the third is never fetched
});

test("exactly the cap on the last page is full coverage", async () => {
  t.on(/./, { columns: ["a"], pages: [[[1], [2], [3]], [[4], [5]]] });
  const out = await c.run(okReq);
  expect(out.rows).toHaveLength(5);
  expect(out.coverage).toEqual({ kind: "full" });
  expect(t.cancelled).toHaveLength(0);
});

test("a timeout cancels the query and is partial coverage", async () => {
  t.on(/./, { columns: ["a"], pages: [[[1]]], delayMs: 500 });
  const out = await c.run(okReq);
  expect(out.coverage).toMatchObject({ kind: "partial", reason: "timeout" });
  expect(out.rows).toEqual([]);
  expect(t.cancelled).toHaveLength(1);
});

test("an engine error is a ConnectorError with the engine's message", async () => {
  t.on(/./, { error: "Table 'iceberg.s.events' does not exist" });
  await expect(c.run(okReq)).rejects.toThrow(/Table 'iceberg\.s\.events' does not exist/);
  await expect(c.run(okReq)).rejects.toBeInstanceOf(ConnectorError);
});

test("a refused connection is a ConnectorError", async () => {
  const dead = startTrino();
  const url = dead.url;
  dead.stop();
  await Bun.sleep(20);
  await expect(make(url).run(okReq)).rejects.toBeInstanceOf(ConnectorError);
});

test("a password credential is sent as basic auth and never rendered", async () => {
  const cc = make(t.url, { credential: "LAKE_PW" }, { LAKE_PW: PW });
  t.on(/./, { columns: ["a"], pages: [[[1]]] });
  expect(cc.render(okReq)).not.toContain(PW);
  await cc.run(okReq);
  expect(t.statements[0]!.headers.authorization).toBe(`Basic ${btoa(`workbench:${PW}`)}`);
  await expect(make(t.url, { credential: "MISSING" }).run(okReq)).rejects.toBeInstanceOf(ConnectorError);
});

test("a secret in an engine error is scrubbed from the ConnectorError", async () => {
  const cc = make(t.url, { credential: "LAKE_PW" }, { LAKE_PW: PW });
  t.on(/./, { error: `bad password ${PW} and ${btoa(`workbench:${PW}`)}` });
  try {
    await cc.run(okReq);
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    expect((e as Error).message).not.toContain(PW);
    expect((e as Error).message).not.toContain(btoa(`workbench:${PW}`));
  }
});

test("a source without a user, or a secret that cannot be sent, is refused", async () => {
  await expect(make(t.url, { user: null }).run(okReq)).rejects.toBeInstanceOf(ConnectorError);
  await expect(make(t.url, { credential: "K" }, { K: "abcd\nefgh" }).run(okReq)).rejects.toBeInstanceOf(ConnectorError);
  expect(t.statements).toHaveLength(0);
});

test("a plain-http location off loopback and a location with credentials are refused", async () => {
  await expect(make("http://192.0.2.10:8080").run(okReq)).rejects.toBeInstanceOf(ConnectorError);
  await expect(make("https://u:p@lake.example").run(okReq)).rejects.toBeInstanceOf(ConnectorError);
});

test("a location with a query string or a fragment is refused before anything is sent", async () => {
  for (const loc of [`${t.url}?password=abcdefgh123`, `${t.url}#x`]) {
    await expect(make(loc).run(okReq)).rejects.toThrow(/must not contain a (query string|fragment)/);
  }
  expect(t.statements).toHaveLength(0);
});

test("tls verification is switched off only when the source says so", async () => {
  const seen: (RequestInit & { tls?: unknown })[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => { seen.push(init ?? {}); return realFetch(input, init); }) as typeof fetch;
  t.on(/./, { columns: ["a"], pages: [[[1]]] });
  await c.run(okReq);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(i => i.tls === undefined)).toBe(true);
  seen.length = 0;
  await make(t.url, { tls_verify: false }).run(okReq);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(i => JSON.stringify(i.tls) === JSON.stringify({ rejectUnauthorized: false }))).toBe(true);
  expect(seen.every(i => i.redirect === "manual")).toBe(true);
});

test("a redirect is not followed", async () => {
  const other = raw(() => new Response("hit", { status: 200 }));
  const s = raw(() => new Response(null, { status: 302, headers: { location: `${other.url}/v1/statement` } }));
  await expect(make(s.url).run(okReq)).rejects.toThrow(/redirect/);
  expect(other.hits).toEqual([]);
});

test("a nextUri on another origin stops the query without contacting it or cancelling", async () => {
  const other = raw(() => new Response("hit", { status: 200 }));
  const s = raw((_r, base) => json({ id: "q1", nextUri: `${other.url}/v1/statement/q1/1`, stats: { state: "QUEUED" }, base }));
  const cc = make(s.url, { credential: "K" }, { K: PW });
  try {
    await cc.run(okReq);
    throw new Error("should have thrown");
  } catch (e) {
    expect(e).toBeInstanceOf(ConnectorError);
    expect((e as Error).message).not.toContain(PW);
  }
  expect(other.hits).toEqual([]);
  expect(s.hits).toEqual(["POST /v1/statement"]);
  // the query is not left running: nothing to cancel here, the POST reply gave no usable URI
  // a different port on the same host is another origin too
  const s2 = raw((_r, base) => json({ id: "q1", nextUri: base.replace(/:\d+$/, ":1") + "/v1/statement/q1/1" }));
  await expect(make(s2.url).run(okReq)).rejects.toBeInstanceOf(ConnectorError);
  expect(s2.hits).toEqual(["POST /v1/statement"]);
});

test("a page over 16 MiB is refused and the query is cancelled", async () => {
  const s = raw(async (r, base) => {
    if (r.method === "DELETE") return new Response(null, { status: 204 });
    if (r.method === "POST") return json({ id: "q1", nextUri: `${base}/v1/statement/q1/1` });
    // chunked, no content-length, yielding between chunks
    const chunk = new TextEncoder().encode("x".repeat(1_048_576));
    let n = 0;
    return new Response(new ReadableStream({
      async pull(ctl) {
        await Bun.sleep(0);
        if (n++ >= 20) ctl.close(); else ctl.enqueue(chunk);
      },
    }));
  });
  const cc = make(s.url, {}, {});
  await expect(cc.run(req(TEXT, {}, win, { timeout_ms: 20_000 }))).rejects.toThrow(/16777216/);
  expect(s.hits).toContain("DELETE /v1/statement/q1/1");
});

test("a declared page size over 16 MiB is refused", async () => {
  const s = raw((r, base) => {
    if (r.method === "DELETE") return new Response(null, { status: 204 });
    if (r.method === "POST") return json({ id: "q1", nextUri: `${base}/v1/statement/q1/1` });
    return new Response(new Uint8Array(17_000_000)); // sent with a content-length
  });
  await expect(make(s.url).run(req(TEXT, {}, win, { timeout_ms: 20_000 }))).rejects.toThrow(/16777216/);
});

test("more than 64 MiB of pages in total is refused and the query is cancelled", async () => {
  const pad = "x".repeat(10 * 1_048_576);
  const s = raw((r, base) => {
    if (r.method === "DELETE") return new Response(null, { status: 204 });
    const k = r.method === "POST" ? 0 : Number(new URL(r.url).pathname.split("/").pop());
    return json({ id: "q1", stats: { pad }, nextUri: `${base}/v1/statement/q1/${k + 1}` });
  });
  await expect(make(s.url).run(req(TEXT, {}, win, { timeout_ms: 20_000 }))).rejects.toThrow(/67108864/);
  expect(s.hits.filter(h => h.startsWith("DELETE"))).toHaveLength(1);
}, 30_000);

test("a malformed page is a ConnectorError", async () => {
  const s = raw((r, base) => (r.method === "POST" ? json({ id: "q1", nextUri: `${base}/v1/statement/q1/1` }) : new Response("not json")));
  await expect(make(s.url).run(okReq)).rejects.toBeInstanceOf(ConnectorError);
  const s2 = raw(() => json({ id: "q1", data: "nope" }));
  await expect(make(s2.url).run(okReq)).rejects.toBeInstanceOf(ConnectorError);
});

test("estimate asks the engine for the plan and reads the row estimate", async () => {
  t.on(/^explain \(type io, format json\)/i, { columns: ["Query Plan"], pages: [[[JSON.stringify({ estimate: { outputRowCount: 1200 } })]]] });
  expect(await c.estimate(okReq)).toEqual({ amount: 1200, unit: "rows" });
  expect(t.statements[0]!.sql).toBe(`EXPLAIN (TYPE IO, FORMAT JSON) ${c.render(okReq)}`);
});

test("estimate is null when the engine cannot say", async () => {
  t.on(/^explain/i, { error: "nope" });
  expect(await c.estimate(okReq)).toBeNull();
  t.on(/^explain/i, { columns: ["Query Plan"], pages: [[[JSON.stringify({ estimate: {} })]]] });
  expect(await c.estimate(okReq)).toBeNull();
  t.on(/^explain/i, { columns: ["Query Plan"], pages: [[["not json"]]] });
  expect(await c.estimate(okReq)).toBeNull();
});

test("estimate still refuses a query the guard refuses, without sending anything", async () => {
  await expect(c.estimate(req("delete from iceberg.s.events"))).rejects.toThrow(GuardError);
  expect(t.statements).toHaveLength(0);
});

/** A server whose POST gives a good nextUri, GET 1 gives a good page with a nextUri to 2, and GET 2 is whatever `bad` makes. */
function failing(bad: (r: Request, base: string) => Response | Promise<Response>): { url: string; hits: string[] } {
  return raw((r, base) => {
    const path = new URL(r.url).pathname;
    if (r.method === "DELETE") return new Response(null, { status: 204 });
    if (r.method === "POST") return json({ id: "q1", nextUri: `${base}/v1/statement/q1/1` });
    if (path.endsWith("/1")) return json({ id: "q1", columns: [{ name: "a" }], data: [[1]], nextUri: `${base}/v1/statement/q1/2` });
    return bad(r, base);
  });
}
const deletes = (hits: string[]): string[] => hits.filter(h => h.startsWith("DELETE"));

test("a failure after paging has begun cancels the last same-origin URI", async () => {
  const other = raw(() => new Response("hit"));
  const cases: [string, string, (r: Request, base: string) => Response | Promise<Response>][] = [
    ["foreign nextUri", "2", () => json({ id: "q1", nextUri: `${other.url}/v1/statement/q1/3` })],
    ["malformed data", "3", (_r, base) => json({ id: "q1", data: "nope", nextUri: `${base}/v1/statement/q1/3` })],
    ["malformed columns", "3", (_r, base) => json({ id: "q1", columns: [1], nextUri: `${base}/v1/statement/q1/3` })],
    ["non-JSON body", "2", () => new Response("<html>")],
    ["HTTP 500", "2", () => new Response("no", { status: 500 })],
    ["HTTP 302", "2", () => new Response(null, { status: 302, headers: { location: `${other.url}/x` } })],
    ["malformed nextUri", "2", () => json({ id: "q1", nextUri: 7 })],
  ];
  for (const [label, last, bad] of cases) {
    const s = failing(bad);
    await expect(make(s.url).run(req(TEXT, {}, win, { timeout_ms: 5000 }))).rejects.toBeInstanceOf(ConnectorError);
    expect([label, deletes(s.hits)]).toEqual([label, [`DELETE /v1/statement/q1/${last}`]]);
  }
  expect(other.hits).toEqual([]);
});

test("a network failure mid-paging cancels the query", async () => {
  const s = failing(() => new Response("unused"));
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    (String(input).endsWith("/q1/2") && init?.method === "GET" ? Promise.reject(new TypeError("socket closed")) : realFetch(input, init))) as typeof fetch;
  await expect(make(s.url).run(req(TEXT, {}, win, { timeout_ms: 5000 }))).rejects.toBeInstanceOf(ConnectorError);
  expect(deletes(s.hits)).toEqual(["DELETE /v1/statement/q1/2"]);
});

test("an engine error page is not cancelled", async () => {
  const s = failing(() => json({ id: "q1", error: { message: "boom" } }));
  await expect(make(s.url).run(req(TEXT, {}, win, { timeout_ms: 5000 }))).rejects.toThrow(/boom/);
  expect(deletes(s.hits)).toEqual([]);
});

test("raw keeps every page's bytes exactly, large numbers and all", async () => {
  const post = '{"id":"q1",  "nextUri":"BASE/v1/statement/q1/1"}';
  const page = '{"id":"q1","columns":[{"name":"a"},{"name":"b"}],"data":[[12345678901234567890,1.0]]}';
  const s = raw((r, base) => new Response(r.method === "POST" ? post.replace("BASE", base) : page));
  const out = await make(s.url).run(okReq);
  expect(text(out.raw)).toBe(`[${post.replace("BASE", s.url)},${page}]`);
  expect(out.rows).toHaveLength(1);
});

test("a timeout after the POST reply cancels the query", async () => {
  const s = raw(async (r, base) => {
    if (r.method === "DELETE") return new Response(null, { status: 204 });
    if (r.method === "GET") { await Bun.sleep(400); return json({ id: "q1" }); }
    return json({ id: "q1", nextUri: `${base}/v1/statement/q1/1` });
  });
  const out = await make(s.url).run(okReq);
  expect(out.coverage).toMatchObject({ kind: "partial", reason: "timeout" });
  expect(deletes(s.hits)).toEqual(["DELETE /v1/statement/q1/1"]);
});

test("a source that echoes the credential has its result refused and the query cancelled", async () => {
  const tokenOf = btoa(`workbench:${PW}`);
  for (const echoed of [`Basic ${tokenOf}`, PW]) {
    // the echoing page names a next page, so the query is still running and must be cancelled at that URI
    const s = failing((r, base) => json({ id: "q1", columns: [{ name: "h" }], data: [[echoed ?? r.method]], nextUri: `${base}/v1/statement/q1/3` }));
    const cc = make(s.url, { credential: "LAKE_PW" }, { LAKE_PW: PW });
    try {
      await cc.run(req(TEXT, {}, win, { timeout_ms: 5000 }));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorError);
      expect((e as Error).message).toContain("echoed the credential");
      expect((e as Error).message).not.toContain(PW);
      expect((e as Error).message).not.toContain(tokenOf);
    }
    expect(deletes(s.hits)).toEqual(["DELETE /v1/statement/q1/3"]);
  }
});

test("a bound boolean, object or array is a ConnectorError naming the placeholder", () => {
  for (const v of [true, {}, [1]]) {
    expect(() => renderLiteral("thing", v as unknown as string)).toThrow(ConnectorError);
    expect(() => renderLiteral("thing", v as unknown as string)).toThrow(/\{thing\}/);
  }
  expect(() => c.render(req("select a from iceberg.s.events where ts >= {window.from} and h = {v}", { v: true as unknown as string }))).toThrow(ConnectorError);
});

// ---------- final review finding 10: encoded echoes, and an echo on the reply that names the query ----------
test("an echo in an encoded form is refused, and an echo on the POST reply still cancels the query it names", async () => {
  const uEscape = (x: string): string => [...x].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const escaped = failing(() => new Response(`{"id":"q1","columns":[{"name":"h"}],"data":[["${uEscape(PW)}"]]}`, { headers: { "content-type": "application/json" } }));
  await expect(make(escaped.url, { credential: "LAKE_PW" }, { LAKE_PW: PW }).run(req(TEXT, {}, win, { timeout_ms: 5000 }))).rejects.toThrow("the source echoed the credential; result refused");
  expect(deletes(escaped.hits)).toEqual([]); // the echoing page was the last one: the query has ended, there is nothing to cancel
  const onPost = raw((r, base) => {
    if (r.method === "DELETE") return new Response(null, { status: 204 });
    return json({ id: "q1", nextUri: `${base}/v1/statement/q1/1`, warning: btoa(PW) });
  });
  await expect(make(onPost.url, { credential: "LAKE_PW" }, { LAKE_PW: PW }).run(req(TEXT, {}, win, { timeout_ms: 5000 }))).rejects.toThrow("echoed the credential");
  expect(deletes(onPost.hits)).toEqual(["DELETE /v1/statement/q1/1"]);
});
