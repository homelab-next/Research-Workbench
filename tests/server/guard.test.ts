import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served;
let host: string;
beforeEach(async () => { s = await served(); host = new URL(s.origin).host; });
afterEach(async () => { await s.close(); });

const ask = (path: string, headers: Record<string, string>, init: RequestInit = {}): Promise<Response> =>
  s.app.handle(new Request(`${s.origin}${path}`, { ...init, headers }));
const sampleCase = { title: "T", asked: "A", why: "W", starting: [], window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, objective: null, marking: "TLP:GREEN" };

test("a request with another Host is refused before anything else", async () => {
  const res = await s.app.handle(new Request(`${s.origin}/api/cases`, { headers: { host: "evil.example:4747" } }));
  expect(res.status).toBe(421);
  expect(await res.text()).toBe(`This workbench answers only at ${s.origin}.`);
});
test("localhost is not the server's origin", async () => {
  const res = await ask("/api/cases", { host: `localhost:${new URL(s.origin).port}` });
  expect(res.status).toBe(421);
  expect(await res.text()).toBe(`This workbench answers only at ${s.origin}.`);
});
test("a missing Host is refused", async () => {
  const res = await ask("/api/me", {});
  expect(res.status).toBe(421);
});
test("the Host must match exactly: another port or a suffix is refused", async () => {
  for (const h of [`127.0.0.1:${Number(new URL(s.origin).port) + 1}`, `${host}.evil.example`, "127.0.0.1", host.toUpperCase() + "x"]) {
    expect((await ask("/api/me", { host: h })).status).toBe(421);
  }
});
test("the Host check comes before the Origin check", async () => {
  expect((await ask("/api/me", { host: "evil.example", origin: "https://evil.example" })).status).toBe(421);
});
test("a GET from another origin is refused", async () => {
  const res = await ask("/api/cases", { host, origin: "https://example.net" });
  expect(res.status).toBe(403);
});
test("an Origin of null is refused", async () => {
  expect((await ask("/api/me", { host, origin: "null" })).status).toBe(403);
});
test("the server's own origin is accepted on a GET", async () => {
  expect((await ask("/api/me", { host, origin: s.origin })).status).toBe(200);
});
test("a POST with no Origin is refused and writes nothing", async () => {
  const before = s.wb.listCases().length;
  const res = await s.app.handle(new Request(`${s.origin}/api/cases`, { method: "POST", headers: { host, "content-type": "application/json" }, body: "{}" }));
  expect(res.status).toBe(403);
  expect(s.wb.listCases().length).toBe(before);
});
test("a POST from another origin writes nothing", async () => {
  const before = s.wb.listCases().length;
  const res = await s.post("/api/cases", sampleCase, { origin: "https://example.net" });
  expect(res.status).toBe(403);
  expect(s.wb.listCases().length).toBe(before);
});
test("a cross-site form post (text/plain) is refused", async () => {
  const before = s.wb.listCases().length;
  const res = await s.post("/api/cases", JSON.stringify(sampleCase), { "content-type": "text/plain" });
  expect(res.status).toBe(403);
  const noOrigin = await ask("/api/cases", { host, "content-type": "text/plain" }, { method: "POST", body: JSON.stringify(sampleCase) });
  expect(noOrigin.status).toBe(403);
  expect(s.wb.listCases().length).toBe(before);
});
test("Sec-Fetch-Site: cross-site is refused; same-origin and none are not", async () => {
  expect((await ask("/api/me", { host, "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await ask("/api/me", { host, "sec-fetch-site": "same-site" })).status).toBe(403);
  expect((await ask("/api/me", { host, "sec-fetch-site": "same-origin" })).status).toBe(200);
  expect((await ask("/api/me", { host, "sec-fetch-site": "none" })).status).toBe(200);
});
test("PUT, DELETE, PATCH and HEAD are 405", async () => {
  for (const method of ["PUT", "DELETE", "PATCH", "HEAD"]) {
    const res = await ask("/api/cases", { host, origin: s.origin, "content-type": "application/json" }, { method, ...(method === "HEAD" ? {} : { body: "{}" }) });
    expect(res.status).toBe(405);
  }
});
test("a body over 1 MiB is 413, by its length and when it is read", async () => {
  const big = "x".repeat(1_048_577);
  const before = s.wb.listCases().length;
  const declared = await s.post("/api/cases", big, { "content-length": String(big.length) });
  expect(declared.status).toBe(413);
  // no honest Content-Length: a stream the server must cut off itself
  const chunk = new TextEncoder().encode("y".repeat(65_536));
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { if (sent >= 17) c.close(); else { sent++; c.enqueue(chunk); } } });
  const streamed = await s.app.handle(new Request(`${s.origin}/api/cases`, { method: "POST", headers: { host, origin: s.origin, "content-type": "application/json" }, body, duplex: "half" } as RequestInit));
  expect(streamed.status).toBe(413);
  expect(s.wb.listCases().length).toBe(before);
});
test("every response carries nosniff, no-store and no CORS header; the page carries the content security policy", async () => {
  const responses = [
    await s.get("/"), await s.get("/app.js"), await s.get("/app.css"), await s.get("/api/me"), await s.get("/api/cases"), await s.get("/api/nowhere"),
    await s.get("/api/me", { host: "evil.example" }), await s.get("/api/me", { origin: "https://example.net" }), await s.post("/api/cases", "not json"),
    await s.get("/api/cases/CASE-9/models"),
  ];
  for (const res of responses) {
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    for (const [name] of res.headers) expect(name.toLowerCase().startsWith("access-control-")).toBe(false);
  }
  const page = await s.get("/");
  expect(page.headers.get("content-type")).toContain("text/html");
  expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'");
  expect(await page.text()).toContain(`<div id="app"></div><script type="module" src="/app.js"></script>`);
  expect((await s.get("/app.js")).headers.get("content-type")).toContain("javascript");
  expect((await s.get("/app.css")).headers.get("content-type")).toContain("text/css");
});
test("an OPTIONS preflight gets no CORS answer", async () => {
  const res = await ask("/api/cases", { host, origin: "https://example.net", "access-control-request-method": "POST" }, { method: "OPTIONS" });
  expect(res.status).toBe(403);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});
test("an unknown path is 404 and a known path with the wrong method is 405", async () => {
  expect((await s.get("/nowhere")).status).toBe(404);
  expect((await s.get("/api/cases/CASE-1/nothing")).status).toBe(404);
  expect((await s.post("/api/me", {})).status).toBe(405);
  expect((await s.post("/", {})).status).toBe(405);
});
test("the requester view may read the page and nothing else", async () => {
  const r = await served({ role: "requester" });
  try {
    expect((await r.get("/")).status).toBe(200);
    expect((await r.get("/api/me")).status).toBe(200);
    expect((await r.get("/api/cases")).status).toBe(403);
    expect(await (await r.get("/api/cases")).json()).toEqual({ ok: false, refused: ["the requester view may not read cases"] });
    for (const path of ["/api/reference", "/api/cases/CASE-1/models", "/api/cases/CASE-1/entries"]) expect((await r.get(path)).status).toBe(403);
    const before = r.wb.listCases().length;
    const post = await r.post("/api/cases", sampleCase);
    expect(post.status).toBe(403);
    expect((await post.json() as { refused: string[] }).refused[0]).toStartWith("the requester view may not do ");
    expect(r.wb.listCases().length).toBe(before);
  } finally {
    await r.close();
  }
});
test("the leader view may read the page and nothing else", async () => {
  const r = await served({ role: "leader" });
  try {
    expect((await r.get("/")).status).toBe(200);
    expect(await (await r.get("/api/reference")).json()).toEqual({ ok: false, refused: ["the leader view may not read reference"] });
  } finally {
    await r.close();
  }
});
test("the server listens on 127.0.0.1 only", async () => {
  const l = await served({ listen: true });
  try {
    expect(new URL(l.origin).hostname).toBe("127.0.0.1");
    expect((await fetch(`${l.origin}/api/me`)).status).toBe(200); // the runtime's fetch sets Host itself
    expect((await fetch(`${l.origin}/api/me`, { headers: { host: "evil.example" } })).status).toBe(421);
  } finally {
    await l.close();
  }
});
test("the source binds the loopback address and names no other", () => {
  const text = readFileSync(new URL("../../src/server/app.ts", import.meta.url), "utf8");
  expect(text).toContain('hostname: "127.0.0.1"');
  expect(text).not.toContain("0.0.0.0");
  expect(text).not.toMatch(/hostname:\s*["'](?!127\.0\.0\.1)/);
  expect(text).not.toContain('"::"');
});

test("every new route is refused for another Host, another Origin, a cross-site request, a non-JSON POST and a requester", async () => {
  const id = await s.post("/api/cases", sampleCase).then(async (r) => ((await r.json()) as { id: string }).id);
  const routes: { method: "GET" | "POST"; path: string; body: unknown }[] = [
    { method: "GET", path: "/api/store", body: null },
    { method: "POST", path: `/api/cases/${id}/unload`, body: {} },
    { method: "POST", path: "/api/store/load", body: { file: "CASE-1.TLP-GREEN.tar.gz" } },
    { method: "POST", path: "/api/store/delete", body: { file: "CASE-1.TLP-GREEN.tar.gz", id: "CASE-1" } },
    { method: "POST", path: "/api/settings", body: { key: "cases.on_complete", value: "unload" } },
  ];
  const r = await served({ role: "requester" });
  try {
    for (const route of routes) {
      const init = (extra: Record<string, string>): [Record<string, string>, RequestInit] => [
        { "content-type": "application/json", ...extra },
        route.method === "GET" ? {} : { method: "POST", body: JSON.stringify(route.body) },
      ];
      const go = (headers: Record<string, string>, i: RequestInit): Promise<Response> => ask(route.path, headers, i);
      expect((await go(...init({ host: "evil.example:4747", origin: s.origin }))).status).toBe(421);
      expect((await go(...init({ host, origin: "https://example.net" }))).status).toBe(403);
      expect((await go(...init({ host, origin: s.origin, "sec-fetch-site": "cross-site" }))).status).toBe(403);
      expect((await ask(route.path, { host, origin: s.origin, "content-type": "text/plain" }, { method: "POST", body: JSON.stringify(route.body ?? {}) })).status).toBe(403);
      const asRequester = route.method === "GET" ? await r.get(route.path) : await r.post(route.path, route.body);
      expect(asRequester.status).toBe(403);
    }
  } finally {
    await r.close();
  }
  expect(s.wb.listCases().map((c) => c.id)).toEqual([id]);
  expect(existsSync(join(s.dir, "wb", "store"))).toBe(false);
  expect(existsSync(s.config.write_path)).toBe(false);
  expect(s.wb.chain.read().some((e) => e.type === "setting.changed")).toBe(false);
});
