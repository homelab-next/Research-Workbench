import { afterEach, beforeAll, afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../../src/core/hash";
import type { Actor, Payloads } from "../../src/core/types";
import type { Custody, Preview } from "../../src/core/wire";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

const sys: Actor = { kind: "system", id: "test" };
let s: Served;
let id: string;
let dir: string;
afterEach(() => { for (const f of cleanups.splice(0)) f(); });
const cleanups: (() => void)[] = [];
afterAll(async () => { expect(s.app.hub.read(id).state.skipped).toEqual([]); await s?.close(); });

/** One published case is shared by the read-only tests; tests that damage a case make their own. */
beforeAll(async () => {
  s = await served({ credential: { name: "SAMPLE_PLANTED_SECRET", value: "planted-secret-value-91d7" } });
  id = await s.newCase();
  await s.toPublishGate(id);
  expect((await s.command(id, "approve")).status).toBe(200);
  await s.app.hub.idle();
  dir = s.app.hub.read(id).dir;
}, 120000);

const resultRef = (): Payloads["query.result"]["result"] => (s.entries(id).find((e) => e.type === "query.result")!.payload as Payloads["query.result"]).result;
const bytes = async (res: Response): Promise<Uint8Array> => new Uint8Array(await res.arrayBuffer());
/** A tool.returned entry with a result blob of the given media, written by hand. */
function plant(caseId: string, data: string, media: string | undefined): string {
  const session = s.app.hub.read(caseId);
  const ref = session.blobs.put(data, media);
  session.commit(() => [{ type: "tool.returned", actor: sys, payload: { call: "t1", ok: true, summary: "planted", result: ref } }]);
  return ref.blob;
}

test("a result blob is served as an attachment with the type that was recorded", async () => {
  const ref = resultRef();
  const res = await s.get(`/api/cases/${id}/blobs/${ref.blob}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("content-disposition")).toStartWith("attachment;");
  expect(res.headers.get("content-disposition")).toContain(`${ref.blob.slice(0, 12)}.json`);
  expect(res.headers.get("content-security-policy")).toContain("sandbox");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(sha256Hex(await bytes(res))).toBe(ref.blob);
});

test("a blob recorded as text/html is served as octet-stream", async () => {
  const hash = plant(id, "<script>alert(1)</script>", "text/html");
  const res = await s.get(`/api/cases/${id}/blobs/${hash}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
  expect(res.headers.get("content-disposition")).toStartWith("attachment;");
  expect(res.headers.get("content-disposition")).toContain(".bin");
});

test("plain text types are served as text/plain, and a blob with no media as octet-stream", async () => {
  const a = plant(id, "a,b\n1,2\n", "text/csv");
  const b = plant(id, "no media here", undefined);
  const c = plant(id, "<svg onload=alert(1)/>", "image/svg+xml");
  const ra = await s.get(`/api/cases/${id}/blobs/${a}`);
  expect(ra.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(ra.headers.get("content-disposition")).toContain(".txt");
  expect((await s.get(`/api/cases/${id}/blobs/${b}`)).headers.get("content-type")).toBe("application/octet-stream");
  expect((await s.get(`/api/cases/${id}/blobs/${c}`)).headers.get("content-type")).toBe("application/octet-stream");
});

test("a hash that is not 64 lower-case hex characters is 400", async () => {
  for (const bad of ["..%2f..%2fledger.sqlite", "A".repeat(64), "abc", "a".repeat(65), `${"a".repeat(64)}%00`]) {
    expect((await s.get(`/api/cases/${id}/blobs/${bad}`)).status).toBe(400);
  }
});

test("an encoded dot-dot where a hash goes reaches no blob", async () => {
  expect([400, 404]).toContain((await s.get(`/api/cases/${id}/blobs/%2e%2e`)).status);
  expect([400, 404]).toContain((await s.get(`/api/cases/${id}/blobs/..`)).status);
});

test("a blob in the folder that no entry references is 404", async () => {
  const stray = s.app.hub.read(id).blobs.put("nobody names me").blob;
  const res = await s.get(`/api/cases/${id}/blobs/${stray}`);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ ok: false, refused: [`blob ${stray} is not part of this case`] });
});

test("a blob that sits at a position that is not a blob field is 404", async () => {
  const hidden = s.app.hub.read(id).blobs.put("only a tool argument names me").blob;
  const session = s.app.hub.read(id);
  session.commit(() => [{ type: "tool.returned", actor: sys, payload: { call: "t2", ok: true, summary: hidden, result: null } }]);
  expect((await s.get(`/api/cases/${id}/blobs/${hidden}`)).status).toBe(404);
});

test("a blob from another case is 404", async () => {
  const other = await s.newCase();
  const theirs = plant(other, "the other case's own bytes", "text/plain");
  expect((await s.get(`/api/cases/${other}/blobs/${theirs}`)).status).toBe(200);
  expect((await s.get(`/api/cases/${id}/blobs/${theirs}`)).status).toBe(404);
});

test("a corrupt blob is refused with a plain reason and never its bytes (500, as ruled)", async () => {
  const hash = plant(id, "good bytes", "text/plain");
  const path = join(dir, "blobs", hash);
  const keep = readFileSync(path);
  cleanups.push(() => writeFileSync(path, keep));
  writeFileSync(path, "tampered secret bytes");
  const res = await s.get(`/api/cases/${id}/blobs/${hash}`);
  expect(res.status).toBe(500);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ ok: false, refused: [`blob ${hash} is corrupt`] });
  expect(text).not.toContain("tampered");
});

test("a missing blob is 404 and says missing", async () => {
  const hash = plant(id, "soon gone", "text/plain");
  const path = join(dir, "blobs", hash);
  const keep = readFileSync(path);
  cleanups.push(() => writeFileSync(path, keep));
  rmSync(path);
  const res = await s.get(`/api/cases/${id}/blobs/${hash}`);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ ok: false, refused: [`blob ${hash} is missing`] });
});

test("each bundle file is served byte for byte as published", async () => {
  for (const f of ["product.md", "product.json", "provenance.md", "provenance.json", "manifest.json"]) {
    const res = await s.get(`/api/cases/${id}/published/1/${f}`);
    expect(res.status).toBe(200);
    expect(await bytes(res)).toEqual(new Uint8Array(readFileSync(join(dir, "published", "1", f))));
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${id}-1-${f}"`);
    expect(res.headers.get("content-type")).toBe(f.endsWith(".md") ? "text/markdown; charset=utf-8" : "application/json");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
  }
});

test("a bundle is still served after its folder is deleted", async () => {
  const t = await served();
  try {
    const own = await t.newCase();
    await t.toPublishGate(own);
    await t.command(own, "approve");
    await t.app.hub.idle();
    const folder = join(t.app.hub.read(own).dir, "published", "1");
    const want = readFileSync(join(folder, "product.md"));
    rmSync(folder, { recursive: true });
    const res = await t.get(`/api/cases/${own}/published/1/product.md`);
    expect(res.status).toBe(200);
    expect(await bytes(res)).toEqual(new Uint8Array(want));
  } finally {
    await t.close();
  }
});

test("bundle paths cannot leave the bundle", async () => {
  const paths = ["1/..%2f..%2fledger.sqlite", "1/../../ledger.sqlite", "1/%2e%2e", "1/..", "1/%2e%2e%2fledger.sqlite", "1/..%5cledger.sqlite", "1/%5Cwindows", "1/%2Fetc%2Fpasswd",
    "1/product.md%00", "1/%00", "0/product.md", "9999999/product.md", "2/product.md", "1/ledger.sqlite", "1/PRODUCT.MD", "x/product.md", "01/product.md", "1/product.md/x"];
  for (const p of paths) {
    const res = await s.get(`/api/cases/${id}/published/${p}`);
    expect([400, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("SQLite");
  }
  // a name the pattern admits but the manifest does not list
  expect((await s.get(`/api/cases/${id}/published/1/..`)).status).toBe(404);
  expect((await s.get(`/api/cases/${id}/published/1/ledger.sqlite`)).status).toBe(404);
});

test("the preview at the publish gate is exactly what approve then writes", async () => {
  const t = await served();
  try {
    const id2 = await t.newCase();
    await t.toPublishGate(id2);
    const preview = (await (await t.get(`/api/cases/${id2}/preview`)).json()) as Preview;
    if ("reasons" in preview) throw new Error(`no preview: ${preview.reasons.join("; ")}`);
    expect(preview.manifest).toMatchObject({ n: 1, marking: expect.any(String), title: expect.any(String), note: expect.any(String) });
    expect(preview.manifest.files.map((f) => f.name).sort()).toEqual(Object.keys(preview.files).sort());
    const headBefore = t.app.hub.read(id2).head().seq;
    await t.get(`/api/cases/${id2}/preview`);
    expect(t.app.hub.read(id2).head().seq).toBe(headBefore); // the preview wrote nothing
    expect(readdirSync(join(t.app.hub.read(id2).dir, "published"), { withFileTypes: true }).length).toBe(0);
    await t.command(id2, "approve");
    for (const [name, text] of Object.entries(preview.files)) expect(readFileSync(join(t.app.hub.read(id2).dir, "published", "1", name), "utf8")).toBe(text);
    for (const f of preview.manifest.files) expect(sha256Hex(readFileSync(join(t.app.hub.read(id2).dir, "published", "1", f.name)))).toBe(f.sha256);
  } finally {
    await t.close();
  }
});

test("with no draft the preview gives the reason", async () => {
  const fresh = await s.newCase();
  const res = await s.get(`/api/cases/${fresh}/preview`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ reasons: ["there is no draft to publish"] });
});

test("custody of an untouched case is intact and counts its entries", async () => {
  const t = await served();
  try {
    const own = await t.newCase();
    await t.toPublishGate(own);
    await t.command(own, "approve");
    await t.app.hub.idle();
    const c = (await (await t.get(`/api/cases/${own}/custody`)).json()) as Custody;
    expect(c).toMatchObject({ ok: true, first_bad: null, bad_blobs: [], skipped: 0, line: `chain intact · ${t.entries(own).length} entries` });
    expect(c.published.ok).toBe(true);
    expect(c.head).toBe(t.app.hub.read(own).head().hash);
  } finally {
    await t.close();
  }
});

test("custody names the entry behind a deleted blob", async () => {
  const t = await served();
  try {
    const own = await t.newCase();
    await t.toPlanGate(own);
    const e = t.entries(own).find((x) => x.type === "stage.finished" && x.payload.output !== null)!;
    const hash = (e.payload as Payloads["stage.finished"]).output!.blob;
    rmSync(join(t.app.hub.read(own).dir, "blobs", hash));
    const c = (await (await t.get(`/api/cases/${own}/custody`)).json()) as Custody;
    expect(c.ok).toBe(false);
    expect(c.bad_blobs[0]).toMatchObject({ blob: hash, state: "missing" });
    expect(c.line).toBe(`${c.bad_blobs.length} blob(s) missing or corrupt, first at entry ${c.bad_blobs[0]!.seq}`);
  } finally {
    await t.close();
  }
});

test("custody names an edited published file", async () => {
  const t = await served();
  try {
    const own = await t.newCase();
    await t.toPublishGate(own);
    await t.command(own, "approve");
    await t.app.hub.idle();
    writeFileSync(join(t.app.hub.read(own).dir, "published", "1", "product.md"), "edited after the fact");
    const c = (await (await t.get(`/api/cases/${own}/custody`)).json()) as Custody;
    expect(c).toMatchObject({ ok: false, first_bad: null, bad_blobs: [], line: "published bundle 1 differs" });
    // the served copy is still the recorded one
    const res = await t.get(`/api/cases/${own}/published/1/product.md`);
    expect(await res.text()).not.toContain("edited after the fact");
  } finally {
    await t.close();
  }
});

test("custody is for the analyst's view only", async () => {
  const t = await served({ role: "requester" });
  try {
    for (const p of ["blobs/" + "a".repeat(64), "published/1/product.md", "preview", "custody"]) expect((await t.get(`/api/cases/x/${p}`)).status).toBe(403);
  } finally {
    await t.close();
  }
});

test("no response in a whole published run holds the planted credential", async () => {
  const bodies: string[] = [];
  const grab = async (path: string): Promise<void> => { bodies.push(Buffer.from(await bytes(await s.get(path))).toString("latin1")); };
  await grab("/api/me");
  await grab("/api/reference");
  await grab(`/api/cases/${id}/custody`);
  await grab(`/api/cases/${id}/preview`);
  bodies.push(JSON.stringify(s.entries(id)));
  const session = s.app.hub.read(id);
  const seen = new Set<string>();
  for (const e of session.entries()) {
    const refs = JSON.stringify(e.payload).match(/[0-9a-f]{64}/g) ?? [];
    for (const h of refs) if (!seen.has(h) && session.blobs.has(h)) { seen.add(h); await grab(`/api/cases/${id}/blobs/${h}`); }
  }
  for (const f of ["product.md", "product.json", "provenance.md", "provenance.json", "manifest.json"]) await grab(`/api/cases/${id}/published/1/${f}`);
  expect(seen.size).toBeGreaterThan(3);
  for (const body of bodies) {
    expect(body).not.toContain("planted-secret-value-91d7");
    expect(body).not.toContain("SAMPLE_PLANTED_SECRET");
  }
});
