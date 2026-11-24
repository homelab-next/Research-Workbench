import { afterEach, beforeEach, expect, test } from "bun:test";
import { entryHash } from "../../src/core/ledger";
import type { Json } from "../../src/core/canonical";
import { canonical } from "../../src/core/canonical";
import type { Actor, Entry } from "../../src/core/types";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

const human: Actor = { kind: "human", id: "analyst" };
let s: Served;
beforeEach(async () => { s = await served(); });
afterEach(async () => { await s.close(); });

/** Reads events from a streaming response until `n` have arrived. */
async function take(res: Response, n: number, raw?: string[]): Promise<{ id: number; entry: Entry }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: { id: number; entry: Entry }[] = [];
  let buf = "";
  const deadline = Date.now() + 10_000;
  while (out.length < n) {
    if (Date.now() > deadline) throw new Error(`only ${out.length} of ${n} events arrived`);
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const end = buf.indexOf("\n\n");
      if (end < 0) break;
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      if (block.startsWith(":")) continue;
      raw?.push(block);
      const id = Number(/^id: (\d+)$/m.exec(block)![1]);
      const data = /^data: (.*)$/m.exec(block)![1]!;
      out.push({ id, entry: JSON.parse(data) as Entry });
    }
  }
  reader.releaseLock();
  return out;
}
const second = (id: string, lane = "l1"): void => {
  s.app.hub.read(id).commit(() => [{ type: "lane.target_set", actor: human, payload: { lane } }]);
};
const add = (id: string, n: number): void => {
  s.app.hub.read(id).commit(() => Array.from({ length: n }, (_, i) => ({ type: "lane.target_set" as const, actor: human, payload: { lane: `l${i}` } })));
};

test("the stream replays from the start, then goes on live, in order and without repeats", async () => {
  const id = await s.newCase();
  const res = await s.get(`/api/cases/${id}/entries`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  second(id);
  const got = await take(res, 2);
  expect(got.map((g) => g.id)).toEqual([1, 2]);
  expect(got.map((g) => g.entry)).toEqual(s.entries(id));
  await res.body!.cancel();
});

test("entries appended after the backlog arrive live, once each, in seq order", async () => {
  const id = await s.newCase();
  const res = await s.get(`/api/cases/${id}/entries`);
  const reader = take(res, 6);
  await Bun.sleep(20);
  second(id, "a");
  add(id, 2);
  await Bun.sleep(5);
  second(id, "b");
  second(id, "c");
  expect((await reader).map((g) => g.id)).toEqual([1, 2, 3, 4, 5, 6]);
  await res.body!.cancel();
});

test("after=N and Last-Event-ID start after that entry; Last-Event-ID wins", async () => {
  const id = await s.newCase();
  add(id, 4);
  const a = await s.get(`/api/cases/${id}/entries?after=2`);
  expect((await take(a, 3)).map((g) => g.id)).toEqual([3, 4, 5]);
  await a.body!.cancel();
  const b = await s.get(`/api/cases/${id}/entries`, { "last-event-id": "3" });
  expect((await take(b, 2)).map((g) => g.id)).toEqual([4, 5]);
  await b.body!.cancel();
  const c = await s.get(`/api/cases/${id}/entries?after=1`, { "last-event-id": "4" });
  expect((await take(c, 1)).map((g) => g.id)).toEqual([5]);
  await c.body!.cancel();
  const d = await s.get(`/api/cases/${id}/entries?after=0`);
  expect((await take(d, 5)).map((g) => g.id)).toEqual([1, 2, 3, 4, 5]);
  await d.body!.cancel();
});

test("reconnecting from the last seen seq gives no gap and no duplicate", async () => {
  const id = await s.newCase();
  add(id, 3);
  const first = await s.get(`/api/cases/${id}/entries`);
  const seen = await take(first, 2);
  await first.body!.cancel();
  add(id, 2);
  const again = await s.get(`/api/cases/${id}/entries`, { "last-event-id": String(seen.at(-1)!.id) });
  const rest = await take(again, 4);
  await again.body!.cancel();
  expect([...seen, ...rest].map((g) => g.id)).toEqual([1, 2, 3, 4, 5, 6]);
});

test("an entry appended while the backlog is being sent is delivered once", async () => {
  const id = await s.newCase();
  add(id, 299); // 300 entries
  const res = await s.get(`/api/cases/${id}/entries`);
  const reading = take(res, 310);
  // commits race the read of the backlog, which goes in pages with a yield between them
  for (let i = 0; i < 10; i++) { second(id, `r${i}`); await Promise.resolve(); }
  const got = await reading;
  expect(got.map((g) => g.id)).toEqual(Array.from({ length: 310 }, (_, i) => i + 1));
  expect(got.map((g) => g.entry)).toEqual(s.entries(id));
  await res.body!.cancel();
});

test("the bytes of each event are the canonical JSON of the entry", async () => {
  const id = await s.newCase();
  second(id);
  const res = await s.get(`/api/cases/${id}/entries`);
  const raw: string[] = [];
  const got = await take(res, 2, raw);
  await res.body!.cancel();
  const recorded = s.entries(id);
  expect(raw[0]).toBe(`id: 1\ndata: ${canonical(recorded[0] as unknown as Json)}`);
  expect(raw[1]).toBe(`id: 2\ndata: ${canonical(recorded[1] as unknown as Json)}`);
  for (const g of got) {
    const { hash, ...rest } = g.entry;
    expect(entryHash(rest as Omit<Entry, "hash">)).toBe(hash);
  }
});

test("closing the response removes the subscription", async () => {
  const id = await s.newCase();
  const session = s.app.hub.read(id);
  let live = 0;
  const original = session.subscribe.bind(session);
  session.subscribe = (fn) => { live++; const off = original(fn); return () => { live--; off(); }; };
  const res = await s.get(`/api/cases/${id}/entries`);
  await take(res, 1);
  expect(live).toBe(1);
  await res.body!.cancel();
  expect(live).toBe(0);
  // an aborted request removes it as well
  const ctl = new AbortController();
  const aborted = await s.app.handle(new Request(`${s.origin}/api/cases/${id}/entries`, { headers: { host: new URL(s.origin).host }, signal: ctl.signal }));
  await take(aborted, 1);
  expect(live).toBe(1);
  ctl.abort();
  await Bun.sleep(10);
  expect(live).toBe(0);
});

test("closing the app closes the streams that are still open", async () => {
  const id = await s.newCase();
  const session = s.app.hub.read(id);
  let live = 0;
  const original = session.subscribe.bind(session);
  session.subscribe = (fn) => { live++; const off = original(fn); return () => { live--; off(); }; };
  const res = await s.get(`/api/cases/${id}/entries`);
  await take(res, 1);
  await s.app.close();
  expect(live).toBe(0);
});

test("a comment line goes out every 15 seconds", async () => {
  const id = await s.newCase();
  const realSetInterval = globalThis.setInterval;
  const ticks: (() => void)[] = [];
  const delays: number[] = [];
  globalThis.setInterval = ((fn: () => void, ms: number) => { ticks.push(fn); delays.push(ms); return realSetInterval(() => {}, 1 << 30); }) as unknown as typeof setInterval;
  let res: Response;
  try { res = await s.get(`/api/cases/${id}/entries`); } finally { globalThis.setInterval = realSetInterval; }
  expect(delays).toContain(15_000);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toStartWith("id: 1");
  ticks.at(-1)!();
  expect(decoder.decode((await reader.read()).value)).toBe(": keep\n\n");
  await reader.cancel();
});

test("after that is not a non-negative integer is 400", async () => {
  const id = await s.newCase();
  for (const bad of ["abc", "-1", "1.5", "", "1e3", "99999999999999999999"]) {
    const res = await s.get(`/api/cases/${id}/entries?after=${bad}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
  }
  expect((await s.get(`/api/cases/${id}/entries`, { "last-event-id": "abc" })).status).toBe(400);
});

test("a quiet stream over a real socket is not cut and sends what is appended", async () => {
  const l = await served({ listen: true });
  try {
    const id = await l.newCase();
    const res = await fetch(`${l.origin}/api/cases/${id}/entries`);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reading = take(res, 2);
    await Bun.sleep(50);
    l.app.hub.read(id).commit(() => [{ type: "lane.target_set", actor: human, payload: { lane: "x" } }]);
    expect((await reading).map((g) => g.id)).toEqual([1, 2]);
    await res.body!.cancel();
  } finally {
    await l.close();
  }
});

test("a position ahead of the case's head is 409 with a reason to reload, from after and from Last-Event-ID", async () => {
  const id = await s.newCase();
  for (const res of [await s.get(`/api/cases/${id}/entries?after=1000`), await s.get(`/api/cases/${id}/entries`, { "last-event-id": "1000" }), await s.get(`/api/cases/${id}/entries?after=2`)]) {
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, refused: ["the stream position is ahead of this case; reload from 0"] });
  }
  const at = await s.get(`/api/cases/${id}/entries?after=1`); // the head itself is fine: nothing to replay, then live
  expect(at.status).toBe(200);
  await at.body!.cancel();
});
