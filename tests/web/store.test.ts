import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import type { CaseSession } from "../../src/core/session";
import type { CaseState } from "../../src/core/state";
import type { Entry } from "../../src/core/types";
import { CaseStore, follow, SNAPSHOT_EVERY } from "../../src/web/store";
import type { EntrySource } from "../../src/web/api";
import { served } from "../helpers/served";

const SRC = resolve(import.meta.dir, "../../src");
const c = (s: unknown): string => canonical(s as Json);

/** A published sample run, made once for the file: its entries and the state the session's subscribers saw at each one. */
let run: { entries: Entry[]; live: Map<number, CaseState>; session: CaseSession };
let closeRun: () => Promise<void>;
let tmp: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "store-"));
  const s = await served();
  closeRun = async () => { await s.close(); };
  const id = await s.newCase();
  const session = s.app.hub.read(id);
  const live = new Map<number, CaseState>();
  for (let n = 1; n <= session.state.seq; n++) live.set(n, session.stateAt(n) as CaseState);
  session.subscribe((e, st) => { live.set(e.seq, st as CaseState); });
  await s.toPublishGate(id);
  const approved = await s.command(id, "approve");
  if (approved.status !== 200) throw new Error(`approve failed: ${JSON.stringify(approved)}`);
  await s.app.hub.idle();
  expect(session.state.skipped).toEqual([]);
  run = { entries: session.entries(0), live, session };
}, 120_000);
afterAll(async () => { await closeRun(); rmSync(tmp, { recursive: true, force: true }); });

test("the sample run is long enough to cross a snapshot", () => {
  expect(run.entries.length).toBeGreaterThan(SNAPSHOT_EVERY);
});

test("the bundled browser code folds every entry to the server's state", async () => {
  const out = await Bun.build({ entrypoints: [join(SRC, "web/store.ts")], target: "browser", format: "esm", outdir: tmp });
  expect(out.success).toBe(true);
  const { CaseStore: Bundled } = await import(out.outputs[0]!.path) as typeof import("../../src/web/store");
  const store = new Bundled(run.session.id);
  for (const e of run.entries) {
    expect(store.push(JSON.parse(JSON.stringify(e)))).toBe("applied");      // as it arrives over the wire
    expect(c(store.live)).toBe(c(run.live.get(e.seq)));
  }
  for (const n of [1, 2, 199, 200, 201, 399, 400, run.entries.length]) expect(c(store.stateAt(n))).toBe(c(run.session.stateAt(n)));
  expect(store.live.skipped).toEqual([]);
});

test("the store fed by the server's stream ends in the server's state", async () => {
  const s = await served({ listen: true });
  try {
    const id = await s.newCase();
    const source: EntrySource = {
      open(caseId, after, onEntry, onDrop) {
        const ctl = new AbortController();
        void (async () => {
          try {
            const res = await fetch(`${s.origin}/api/cases/${caseId}/entries?after=${after}`, { signal: ctl.signal });
            const reader = res.body!.getReader();
            const dec = new TextDecoder();
            let buf = "";
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              for (let end = buf.indexOf("\n\n"); end >= 0; end = buf.indexOf("\n\n")) {
                const block = buf.slice(0, end);
                buf = buf.slice(end + 2);
                const m = /^data: (.*)$/m.exec(block);
                if (m) onEntry(JSON.parse(m[1]!) as Entry);
              }
            }
            onDrop();
          } catch { if (!ctl.signal.aborted) onDrop(); }
        })();
        return () => ctl.abort();
      },
    };
    const store = new CaseStore(id);
    const stop = follow(store, source, undefined as never);
    await s.toPublishGate(id);
    const session = s.app.hub.read(id);
    const deadline = Date.now() + 10_000;
    while (store.live.seq < session.state.seq && Date.now() < deadline) await Bun.sleep(10);
    stop();
    expect(c(store.live)).toBe(c(session.state));
    expect(session.state.skipped).toEqual([]);
  } finally { await s.close(); }
});

test("a repeated entry is ignored and a skipped one is not applied", () => {
  const store = new CaseStore("CASE-1");
  store.push(run.entries[0]!);
  expect(store.push(run.entries[0]!)).toBe("duplicate");
  expect(store.push(run.entries[2]!)).toBe("gap");
  expect(store.live.seq).toBe(1);
  expect(store.entries.length).toBe(1);
});

/** A window with just the timers `follow` needs, run by hand. */
function fakeWin(): { win: Window; run(): void; delays: number[] } {
  const queue: (() => void)[] = [];
  const delays: number[] = [];
  const win = {
    setTimeout: (fn: () => void, ms: number) => { queue.push(fn); delays.push(ms); return queue.length; },
    clearTimeout: (n: number) => { queue[n - 1] = () => {}; },
  } as unknown as Window;
  return { win, run: () => { const f = queue.shift(); f?.(); }, delays };
}

test("follow reopens the stream after its own head on a gap and on a drop, and ends in the right state", () => {
  const entries = run.entries.slice(0, 12);
  const opened: number[] = [];
  let closed = 0;
  let feed: { onEntry(e: Entry): void; onDrop(): void } | null = null;
  const source: EntrySource = {
    open(_id, after, onEntry, onDrop) { opened.push(after); feed = { onEntry, onDrop }; return () => { closed++; }; },
  };
  const { win, run: tick, delays } = fakeWin();
  const store = new CaseStore(run.session.id);
  const stop = follow(store, source, win);
  expect(opened).toEqual([0]);
  for (const e of entries.slice(0, 4)) feed!.onEntry(e);
  feed!.onEntry(entries[5]!);                         // entry 5 skipped: a gap
  expect(store.connection).toBe("reconnecting");
  expect(closed).toBe(1);
  tick();                                             // after 1 s
  expect(delays[0]).toBe(1000);
  expect(opened).toEqual([0, 4]);
  for (const e of entries.slice(4, 8)) feed!.onEntry(e);
  expect(store.connection).toBe("live");
  feed!.onDrop();                                     // a drop at 8
  expect(store.connection).toBe("reconnecting");
  tick();
  expect(delays[1]).toBe(1000);
  expect(opened).toEqual([0, 4, 8]);
  feed!.onDrop();                                     // dropped again at once: 2 s, then 5 s
  tick();
  expect(delays.slice(2)).toEqual([2000]);
  feed!.onDrop();
  tick();
  feed!.onDrop();
  tick();
  expect(delays.slice(3)).toEqual([5000, 5000]);
  for (const e of entries.slice(8)) feed!.onEntry(e);
  expect(c(store.live)).toBe(c(run.session.stateAt(12)));
  stop();
  expect(feed).not.toBeNull();
  const before = opened.length;
  tick();
  expect(opened.length).toBe(before);
});

test("goTo shows the state at that entry and null returns to live", () => {
  const store = new CaseStore(run.session.id);
  for (const e of run.entries.slice(0, 20)) store.push(e);
  let calls = 0;
  const off = store.subscribe(() => { calls++; });
  store.goTo(7);
  expect(store.at).toBe(7);
  expect(c(store.shown)).toBe(c(run.session.stateAt(7)));
  store.push(run.entries[20]!);
  expect(c(store.shown)).toBe(c(run.session.stateAt(7)));
  expect(store.live.seq).toBe(21);
  store.goTo(null);
  expect(store.at).toBeNull();
  expect(store.shown).toBe(store.live);
  expect(calls).toBe(3);
  off();
  store.push(run.entries[21]!);
  expect(calls).toBe(3);
});

function longCase(n: number): CaseStore {
  const store = new CaseStore("CASE-9");
  const actor = { kind: "system", id: "t" } as const;
  for (let seq = 1; seq <= n; seq++) {
    const k = Math.ceil(seq / 3);
    const type = seq % 3 === 1 ? "card.created" : seq % 3 === 2 ? "card.kept" : "card.moved";
    const card = { id: `C-${k}`, title: "t", body: "b", kind: "result", made_by: "agent", query: null, columns: [], column_types: [], rows: [], row_count: 0, coverage: null, empty: null, marking: "TLP:GREEN", source: null, step: null, subgoal: null, why: "w", event_time: null, quality_notes: [] };
    const payload = type === "card.created" ? { card } : type === "card.kept" ? { card: `C-${k}`, lane: "L-1" } : { card: `C-${k}`, lane: "L-1", index: 0 };
    store.push({ seq, ts: "2026-11-23T20:00:00.000Z", case: "CASE-9", actor, type, payload, cause: null, run: null, stage: null, job: null, prev_hash: "x", hash: "y" } as unknown as Entry);
  }
  return store;
}

test("replay over a long case does not refold from the start", () => {
  const store = longCase(5000);
  expect(store.live.seq).toBe(5000);
  const t0 = performance.now();
  for (let seq = 5000; seq > 4900; seq--) store.stateAt(seq);
  expect(performance.now() - t0).toBeLessThan(1500);
  expect(store.stateAt(4321).seq).toBe(4321);
  expect(store.live.skipped).toEqual([]);
  expect(Object.keys(store.live.cards).length).toBe(1667);
});
