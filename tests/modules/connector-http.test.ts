import { afterEach, beforeEach, expect, test } from "bun:test";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import type { EndpointManifest, SourceManifest } from "../../src/modules/manifests";
import { ConnectorError, makeConnector } from "../../src/modules/connectors";
import type { QueryRequest } from "../../src/modules/connectors";
import { startStandin } from "../helpers/http-standin";
import type { Standin } from "../helpers/http-standin";

const SECRET = "s3cr3t-value";
const body = JSON.stringify({ results: [{ address: "198.51.100.77", verdict: "suspicious", first_seen: "2026-11-19", extra: 1 }] });
const json = (text: string, init: ResponseInit = {}): Response =>
  new Response(text, { ...init, headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) } });

const endpoints: EndpointManifest[] = [
  { name: "reputation", method: "GET", path: "/v1/reputation/{value}?days={days}", read: true, rows: "results", columns: ["address", "verdict", "first_seen"] },
  { name: "lookup", method: "POST", path: "/v1/lookup", read: true, rows: "", columns: ["a"] },
  { name: "mutate", method: "POST", path: "/v1/mutate", read: false, rows: "", columns: ["a"] },
  { name: "rows_missing", method: "GET", path: "/rows", read: true, rows: "results", columns: ["a", "b"] },
];

let s: Standin;
let extra: Standin[] = [];
const ctx = (env: Record<string, string> = { REP_KEY: SECRET }) => ({ secrets: new Secrets(env, null), observables: new Observables([]) });

function source(location: string, over: Partial<SourceManifest> = {}): SourceManifest {
  return {
    id: "rep", title: "Reputation", hash: "h1", dir: "/nonexistent", root: "/nonexistent", connector: "http", location, credential: "REP_KEY", user: null,
    tls_verify: true, marking: "TLP:AMBER", where: "hosted", confirmed: true, adhoc: false, cost: { weight: 5, unit: "lookups" },
    limits: { max_rows: 5, timeout_ms: 1000 }, quality: "", quality_notes: [], tables: [], endpoints, ...over,
  };
}
function req(text: string, bound: QueryRequest["bound"] = {}, over: Partial<QueryRequest> = {}): QueryRequest {
  return { text, bound, window: { from: null, to: null }, max_rows: 5, timeout_ms: 1000, budget: null, ...over };
}
const make = (over: Partial<SourceManifest> = {}, env?: Record<string, string>) => makeConnector(source(s.url, over), ctx(env));
const standin = (routes: Parameters<typeof startStandin>[0]): Standin => { const x = startStandin(routes); extra.push(x); return x; };

beforeEach(() => {
  s = startStandin({
    "GET /v1/reputation/198.51.100.77": () => json(body),
    "GET /v1/reputation/a%20b%2Fc": () => json(body),
    "POST /v1/lookup": () => json(JSON.stringify([{ a: 1 }])),
    "POST /v1/mutate": () => json("[]"),
    "GET /boom": () => new Response("no", { status: 500 }),
    "GET /rows": () => json(JSON.stringify({ results: [{ a: 1 }, { a: 2 }, { a: 3 }] })),
  });
});
afterEach(() => { s.stop(); for (const x of extra) x.stop(); extra = []; });

test("render shows the method and the full URL with values encoded", () => {
  const c = make();
  expect(c.render(req("reputation", { value: "198.51.100.77", days: 7 }))).toBe(`GET ${s.url}/v1/reputation/198.51.100.77?days=7`);
  expect(c.render(req("reputation", { value: "a b/c", days: 7 }))).toBe(`GET ${s.url}/v1/reputation/a%20b%2Fc?days=7`);
});

test("render refuses unbound, null and dot-segment values", () => {
  const c = make();
  expect(() => c.render(req("reputation", { value: "x" }))).toThrow(ConnectorError);
  expect(() => c.render(req("reputation", { value: null, days: 1 }))).toThrow(ConnectorError);
  expect(() => c.render(req("reputation", { value: "..", days: 1 }))).toThrow(ConnectorError);
});

test("run maps the response to rows and keeps the body bytes exactly", async () => {
  const out = await make().run(req("reputation", { value: "198.51.100.77", days: 7 }));
  expect(out.columns).toEqual(["address", "verdict", "first_seen"]);
  expect(out.rows).toEqual([["198.51.100.77", "suspicious", "2026-11-19"]]);
  expect(new TextDecoder().decode(out.raw)).toBe(body);
  expect(out.media).toContain("application/json");
  expect(out.coverage).toEqual({ kind: "full" });
});

test("missing keys are null and a body that is the array itself works", async () => {
  s.stop();
  s = startStandin({ "GET /rows": () => json(JSON.stringify({ results: [{ a: 1 }] })), "POST /v1/lookup": () => json(JSON.stringify([{ a: 7 }])) });
  expect((await make().run(req("rows_missing"))).rows).toEqual([[1, null]]);
  expect((await make().run(req("lookup"))).rows).toEqual([[7]]);
});

test("the credential goes in the Authorization header and nowhere else", async () => {
  const c = make();
  const r = req("reputation", { value: "198.51.100.77", days: 7 });
  const out = await c.run(r);
  expect(s.requests[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
  expect(s.requests[0]!.path).not.toContain(SECRET);
  expect(s.requests[0]!.body).toBe("");
  expect(c.render(r)).not.toContain(SECRET);
  expect(new TextDecoder().decode(out.raw)).not.toContain(SECRET);
  expect(JSON.stringify(out.rows)).not.toContain(SECRET);
});

test("no credential means no Authorization header; a missing secret names the credential and not a value", async () => {
  await make({ credential: null }).run(req("reputation", { value: "198.51.100.77", days: 7 }));
  expect(s.requests[0]!.headers.authorization).toBeUndefined();
  const err = await make({}, {}).run(req("reputation", { value: "198.51.100.77", days: 7 })).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectorError);
  expect((err as Error).message).toContain("REP_KEY");
  expect(s.requests).toHaveLength(1);
});

test("a secret that cannot be a header value is refused without echoing it", async () => {
  const bad = "bad\nvalue";
  const err = await make({}, { REP_KEY: bad }).run(req("reputation", { value: "198.51.100.77", days: 7 })).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectorError);
  expect((err as Error).message).toContain("REP_KEY");
  expect((err as Error).message).not.toContain("bad");
});

test("errors never contain the secret, even when the server echoes it", async () => {
  s.stop();
  s = startStandin({ "GET /boom": (r) => new Response(`echo ${r.headers.get("authorization")}`, { status: 500 }) });
  const e1 = await make({ endpoints: [{ ...endpoints[0]!, path: "/boom" }] }).run(req("reputation")).catch((e: unknown) => e);
  expect((e1 as Error).message).toContain("HTTP 500");
  expect((e1 as Error).message).not.toContain(SECRET);
  s.stop();
  s = startStandin({ "GET /boom": (r) => json(`{"echo": "${r.headers.get("authorization")}" oops`) });
  const e2 = await make({ endpoints: [{ ...endpoints[0]!, path: "/boom" }] }).run(req("reputation")).catch((e: unknown) => e);
  expect(e2).toBeInstanceOf(ConnectorError);
  expect((e2 as Error).message).not.toContain(SECRET);
});

test("a GET never has a body; a POST is refused unless the endpoint is marked read", async () => {
  const c = make();
  await c.run(req("reputation", { value: "198.51.100.77", days: 7 }));
  expect(s.requests[0]!.method).toBe("GET");
  expect(s.requests[0]!.body).toBe("");
  expect(() => c.render(req("mutate"))).toThrow(ConnectorError);
  await expect(c.run(req("mutate"))).rejects.toThrow(ConnectorError);
  expect(s.requests).toHaveLength(1);
  const out = await c.run(req("lookup", { q: "x" }));
  expect(out.rows).toEqual([[1]]);
  expect(s.requests[1]!.method).toBe("POST");
});

test("an unknown endpoint is a ConnectorError", async () => {
  const c = make();
  expect(() => c.render(req("nope"))).toThrow(ConnectorError);
  await expect(c.run(req("nope"))).rejects.toThrow(ConnectorError);
  await expect(c.estimate(req("nope"))).rejects.toThrow(ConnectorError);
});

test("a base URL with a query string or a fragment is refused, so nothing in it reaches the query text", async () => {
  for (const loc of [`${s.url}?api_key=abcdefgh123`, `${s.url}/?k=v`, `${s.url}#frag`, `${s.url}?`]) {
    const c = makeConnector(source(loc), ctx());
    expect(() => c.render(req("reputation", { value: "198.51.100.77" }))).toThrow(/must not contain a (query string|fragment)/);
    await expect(c.run(req("reputation", { value: "198.51.100.77" }))).rejects.toThrow(ConnectorError);
  }
  expect(s.requests).toHaveLength(0);
});

test("a non-https base URL is refused unless it is loopback", async () => {
  const bad = makeConnector(source("http://203.0.113.5"), ctx());
  expect(() => bad.render(req("lookup"))).toThrow(ConnectorError);
  await expect(bad.run(req("lookup"))).rejects.toThrow(ConnectorError);
  expect(() => makeConnector(source("ftp://127.0.0.1"), ctx()).render(req("lookup"))).toThrow(ConnectorError);
  expect(() => makeConnector(source("http://user:pw@127.0.0.1"), ctx()).render(req("lookup"))).toThrow(ConnectorError);
  expect(() => makeConnector(source("not a url"), ctx()).render(req("lookup"))).toThrow(ConnectorError);
  expect(make().render(req("lookup"))).toStartWith("POST http://127.0.0.1");
  expect(makeConnector(source("https://example.org"), ctx()).render(req("lookup"))).toStartWith("POST https://example.org/v1/lookup");
  expect(makeConnector(source("http://[::1]:9"), ctx()).render(req("lookup"))).toStartWith("POST http://[::1]:9/");
  expect(makeConnector(source("http://localhost:9"), ctx()).render(req("lookup"))).toStartWith("POST http://localhost:9/");
});

test("a 500 is an error naming the status", async () => {
  const c = make({ endpoints: [{ ...endpoints[0]!, path: "/boom" }] });
  const err = await c.run(req("reputation")).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectorError);
  expect((err as Error).message).toContain("HTTP 500");
});

test("a body that is not JSON is an error", async () => {
  s.stop();
  s = startStandin({ "GET /rows": () => new Response("<html>", { headers: { "content-type": "text/html" } }) });
  await expect(make().run(req("rows_missing"))).rejects.toThrow(/not valid JSON/);
});

test("a response without the rows path, or with non-object rows, is an error", async () => {
  s.stop();
  s = startStandin({ "GET /rows": () => json(JSON.stringify({ other: [] })) });
  await expect(make().run(req("rows_missing"))).rejects.toThrow(ConnectorError);
  s.stop();
  s = startStandin({ "GET /rows": () => json(JSON.stringify({ results: [1, 2] })) });
  await expect(make().run(req("rows_missing"))).rejects.toThrow(ConnectorError);
});

test("a refused connection is an error, not a hang", async () => {
  const dead = startStandin({});
  const url = dead.url;
  dead.stop();
  const c = makeConnector(source(url), ctx());
  await expect(c.run(req("lookup"))).rejects.toThrow(ConnectorError);
});

test("a slow response times out as partial coverage", async () => {
  s.stop();
  s = startStandin({ "GET /rows": async () => { await Bun.sleep(300); return json("{}"); } });
  const out = await make().run(req("rows_missing", {}, { timeout_ms: 50 }));
  expect(out.rows).toEqual([]);
  expect(out.coverage).toEqual({ kind: "partial", reason: "timeout", detail: expect.any(String) });
});

test("a body that stalls half way also times out", async () => {
  s.stop();
  s = startStandin({
    "GET /rows": () => new Response(new ReadableStream({
      async start(ctl) { ctl.enqueue(new TextEncoder().encode('{"results":[')); await Bun.sleep(300); ctl.close(); },
    }), { headers: { "content-type": "application/json" } }),
  });
  const out = await make().run(req("rows_missing", {}, { timeout_ms: 80 }));
  expect(out.coverage).toMatchObject({ kind: "partial", reason: "timeout" });
});

test("more rows than the cap is partial coverage", async () => {
  const out = await make().run(req("rows_missing", {}, { max_rows: 2 }));
  expect(out.rows).toEqual([[1, null], [2, null]]);
  expect(out.coverage).toMatchObject({ kind: "partial", reason: "row_limit" });
  expect(new TextDecoder().decode(out.raw)).toContain('"a":3');
});

test("the cost is one lookup in the source's unit", async () => {
  const c = make();
  const r = req("reputation", { value: "198.51.100.77", days: 7 });
  expect(await c.estimate(r)).toEqual({ amount: 1, unit: "lookups" });
  expect((await c.run(r)).cost).toEqual({ amount: 1, unit: "lookups" });
  const free = make({ cost: { weight: 0, unit: "lookups" } });
  expect(await free.estimate(r)).toBeNull();
  expect((await free.run(r)).cost).toBeNull();
});

test("redirects are not followed", async () => {
  const target = standin({ "GET /landing": () => json("{}") });
  s.stop();
  s = startStandin({ "GET /rows": () => new Response(null, { status: 302, headers: { location: `${target.url}/landing` } }) });
  const err = await make().run(req("rows_missing")).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectorError);
  expect((err as Error).message).toContain("302");
  expect(target.requests).toHaveLength(0);
});

test("a body over 16 MiB is refused naming the limit, whether declared or streamed", async () => {
  const big = new Uint8Array(16 * 1024 * 1024 + 1).fill(32);
  s.stop();
  s = startStandin({ "GET /rows": () => new Response(big, { headers: { "content-type": "application/json" } }) });
  await expect(make().run(req("rows_missing"))).rejects.toThrow(/16777216/);
  s.stop();
  let sent = 0;
  s = startStandin({
    "GET /rows": () => new Response(new ReadableStream({
      // 17 MiB in 1 MiB chunks, yielding to the event loop between chunks so the client's timer can still fire.
      async pull(ctl) {
        sent += 1;
        ctl.enqueue(new Uint8Array(1024 * 1024).fill(32));
        if (sent >= 17) ctl.close();
        await Bun.sleep(0);
      },
    }), { headers: { "content-type": "application/json" } }),
  });
  await expect(make().run(req("rows_missing", {}, { timeout_ms: 5000 }))).rejects.toThrow(/16777216/);
});

test("a body of exactly 16 MiB is accepted", async () => {
  const text = `{"results":[{"a":1}]}`;
  const padded = text + " ".repeat(16 * 1024 * 1024 - text.length);
  s.stop();
  s = startStandin({ "GET /rows": () => json(padded) });
  const out = await make().run(req("rows_missing", {}, { timeout_ms: 5000 }));
  expect(out.rows).toEqual([[1, null]]);
  expect(out.raw.length).toBe(16 * 1024 * 1024);
});
