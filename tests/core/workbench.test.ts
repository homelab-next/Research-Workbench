import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyLedger } from "../../src/core/verify";
import { CaseNotFoundError, Workbench, WorkbenchClosedError, WorkbenchLockedError } from "../../src/core/workbench";
import type { NewCase } from "../../src/core/workbench";
import type { Actor } from "../../src/core/types";
import { cleanEnv } from "../helpers/clean-env";
import { card as cardStub } from "../helpers/entries";

const human: Actor = { kind: "human", id: "analyst" };
const newCase: NewCase = {
  title: "Beaconing", asked: "Is 192.0.2.10 beaconing?", why: "alert", starting: [{ type: "ip", value: "192.0.2.10" }],
  window: { from: null, to: null }, objective: null, marking: "TLP:AMBER",
};
let dir: string;
let wb: Workbench;
let tick = 0;
const errors: unknown[] = [];
const onError = (e: unknown) => void errors.push(e);
const now = () => new Date(Date.parse("2026-11-23T20:00:00.000Z") + tick++ * 1000).toISOString();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-"));
  tick = 0;
  errors.length = 0;
  wb = Workbench.open(dir, { now, onError });
});
afterEach(() => {
  try { wb.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

test("createCase makes CASE-1 with its own folder and a first entry", () => {
  const s = wb.createCase(newCase, human);
  expect(s.id).toBe("CASE-1");
  expect(existsSync(join(dir, "cases", "CASE-1", "ledger.sqlite"))).toBe(true);
  expect(existsSync(join(dir, "cases", "CASE-1", "blobs"))).toBe(true);
  expect(existsSync(join(dir, "cases", "CASE-1", "published"))).toBe(true);
  expect(s.entries()[0]).toMatchObject({ seq: 1, type: "case.created", actor: human, payload: { id: "CASE-1", title: newCase.title } });
  expect(s.state.meta?.marking).toBe(newCase.marking);
});

test("case ids count up and survive a restart", () => {
  expect(wb.createCase(newCase, human).id).toBe("CASE-1");
  expect(wb.createCase(newCase, human).id).toBe("CASE-2");
  wb.close();
  wb = Workbench.open(dir, { now, onError });
  expect(wb.createCase(newCase, human).id).toBe("CASE-3");
  expect(wb.session("CASE-1").state.meta?.id).toBe("CASE-1");
});

test("session returns the same object for the same id", () => {
  const s = wb.createCase(newCase, human);
  expect(wb.session("CASE-1")).toBe(s);
  expect(wb.session("CASE-1")).toBe(wb.session("CASE-1"));
  wb.close();
  wb = Workbench.open(dir, { now, onError });
  expect(wb.session("CASE-1")).toBe(wb.session("CASE-1"));
});

test("session of an unknown id throws CaseNotFoundError", () => {
  expect(() => wb.session("CASE-9")).toThrow(CaseNotFoundError);
  for (const bad of ["../x", "CASE-0", "CASE-01", "case-1", "CASE-1/..", "", "__proto__", "constructor", "CASE-1\n"]) {
    expect(() => wb.session(bad)).toThrow(CaseNotFoundError);
  }
  mkdirSync(join(dir, "cases", "CASE-5"));
  expect(() => wb.session("CASE-5")).toThrow(CaseNotFoundError);
});

test("listCases is newest first with a summary of each", () => {
  const a = wb.createCase(newCase, human);
  wb.createCase({ ...newCase, title: "Second", marking: "TLP:RED" }, human);
  a.commit((_st, ids) => [
    { type: "lane.created", payload: { lane: ids.next("lane"), title: "L", subgoal: null }, actor: human },
    { type: "card.created", payload: { card: cardStub(ids.next("card")) }, actor: human },
    { type: "card.created", payload: { card: cardStub(ids.next("card")) }, actor: human },
  ]);
  a.commit(() => [{ type: "card.kept", payload: { card: "c1", lane: "l1", index: null }, actor: human }]);
  const list = wb.listCases();
  expect(list.map((c) => c.id)).toEqual(["CASE-2", "CASE-1"]);
  expect(list[0]).toMatchObject({ title: "Second", marking: "TLP:RED", run_status: "none", phase: null, incoming: 0, kept: 0 });
  expect(list[1]).toMatchObject({ title: "Beaconing", marking: "TLP:AMBER", incoming: 1, kept: 1 });
  expect(list[1]!.created_ts).toBe(a.entries()[0]!.ts);
});

test("the workbench chain is its own verifiable ledger", () => {
  wb.chain.append({ type: "setting.changed", payload: { key: "k", value: 1 }, actor: human });
  wb.close();
  expect(verifyLedger(join(dir, "workbench.sqlite"), join(dir, "blobs")).ok).toBe(true);
});

test("a created case verifies from the command line", () => {
  wb.createCase(newCase, human);
  const p = Bun.spawnSync(["bun", "run", "src/cli/verify.ts", join(dir, "cases", "CASE-1")], { cwd: join(import.meta.dir, "../.."), env: cleanEnv(dir) });
  expect(p.exitCode).toBe(0);
});

test("a failed createCase leaves no directory and the number is reused", () => {
  const bad = { ...newCase, objective: NaN as unknown as null };
  expect(() => wb.createCase(bad, human)).toThrow();
  expect(readdirSync(join(dir, "cases"))).toEqual([]);
  expect(wb.listCases()).toEqual([]);
  expect(wb.createCase(newCase, human).id).toBe("CASE-1");
});

test("a refused second open in the same process does not release the lock", () => {
  expect(() => Workbench.open(dir, { onError })).toThrow(WorkbenchLockedError);
  // a child process must still be refused
  const child = Bun.spawnSync(["bun", "run", "tests/helpers/open-workbench.ts", dir]);
  expect(child.exitCode).toBe(3);
  wb.close();
  expect(Bun.spawnSync(["bun", "run", "tests/helpers/open-workbench.ts", dir]).exitCode).toBe(0);
  wb = Workbench.open(dir, { now, onError });
});

test("the in-process refusal names this process", () => {
  try {
    Workbench.open(dir, { onError });
    throw new Error("expected a refusal");
  } catch (err) {
    expect(err).toBeInstanceOf(WorkbenchLockedError);
    expect((err as WorkbenchLockedError).pid).toBe(process.pid);
  }
});

test("a second open through a symlink to the held directory is refused at once, as the same directory", () => {
  const link = join(mkdtempSync(join(tmpdir(), "wb-link-")), "data");
  symlinkSync(dir, link);
  try {
    const started = Date.now();
    let err: unknown;
    try { Workbench.open(link, { onError }).close(); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(WorkbenchLockedError);
    // the in-process check knows the directory without contending for the file lock (which retries for 100 ms)
    expect(Date.now() - started).toBeLessThan(60);
    expect(Bun.spawnSync(["bun", "run", "tests/helpers/open-workbench.ts", dir]).exitCode).toBe(3);
  } finally {
    rmSync(join(link, ".."), { recursive: true, force: true });
  }
});

test("a failed open does not leave the path marked as held", () => {
  const other = mkdtempSync(join(tmpdir(), "wb-fail-"));
  try {
    // "cases" is a file, so open fails after the lock is taken
    writeFileSync(join(other, "cases"), "in the way");
    let first: unknown;
    try { Workbench.open(other, { onError }); } catch (err) { first = err; }
    expect(first).toBeInstanceOf(Error);
    expect(first).not.toBeInstanceOf(WorkbenchLockedError);
    expect(Bun.spawnSync(["bun", "run", "tests/helpers/open-workbench.ts", other]).exitCode).toBe(1); // not locked by a leftover
    rmSync(join(other, "cases"));
    const again = Workbench.open(other, { onError });
    again.close();
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test("a second open of the same data directory throws until the first closes", () => {
  expect(() => Workbench.open(dir, { onError })).toThrow(WorkbenchLockedError);
  try {
    Workbench.open(dir, { onError });
  } catch (err) {
    expect((err as WorkbenchLockedError).pid).toBe(process.pid);
    expect((err as Error).message).toContain(String(process.pid));
  }
  wb.close();
  wb = Workbench.open(dir, { now, onError });
  expect(wb.createCase(newCase, human).id).toBe("CASE-1");
});

// ---------- final review, finding 2: the operating system holds the lock ----------
const OPENER = join(import.meta.dir, "..", "helpers", "workbench-opener.ts");

/** Reads lines from a child's stdout as they arrive. */
function lines(proc: { stdout: ReadableStream<Uint8Array> }): () => Promise<string> {
  const reader = proc.stdout.getReader();
  let buffered = "";
  return async () => {
    for (;;) {
      const i = buffered.indexOf("\n");
      if (i >= 0) {
        const line = buffered.slice(0, i);
        buffered = buffered.slice(i + 1);
        return line;
      }
      const { value, done } = await reader.read();
      if (done) return buffered;
      buffered += new TextDecoder().decode(value);
    }
  };
}

/** Leaves `data` as a crash would: a holder killed with SIGKILL while it held the lock. */
async function crashHolder(data: string): Promise<void> {
  const holder = Bun.spawn([process.execPath, OPENER, data, "-", "-"], { stdout: "pipe", stderr: "pipe" });
  const next = lines(holder);
  expect(await next()).toBe("ready");
  expect(await next()).toBe(`held ${holder.pid}`);
  holder.kill("SIGKILL");
  await holder.exited;
}

test("several processes opening at once after a crash: exactly one holds the lock, in every round", async () => {
  wb.close();
  for (let round = 0; round < 10; round++) {
    const data = join(dir, `round-${round}`);
    await crashHolder(data);
    const go = join(dir, `go-${round}`), release = join(dir, `release-${round}`);
    const procs = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, OPENER, data, go, release], { stdout: "pipe", stderr: "pipe" }));
    const next = procs.map(lines);
    expect(await Promise.all(next.map((n) => n()))).toEqual(Array(6).fill("ready"));
    writeFileSync(go, "");
    const said = await Promise.all(next.map((n) => n()));
    const held = said.filter((l) => l.startsWith("held "));
    expect(held, `round ${round}: ${said.join(", ")}`).toHaveLength(1);
    const holder = held[0]!.slice(5);
    // the losers name the holder, or no one if they looked before the new holder had written its pid,
    // but never the crashed process
    const named = said.filter((l) => l.startsWith("locked ")).map((l) => l.slice(7));
    expect(named, `round ${round}`).toHaveLength(5);
    for (const pid of named) expect(["null", holder], `round ${round}`).toContain(pid);
    writeFileSync(release, "");
    const codes = await Promise.all(procs.map((p) => p.exited));
    if (codes.some((c) => c !== 0)) throw new Error(await Promise.all(procs.map((p) => new Response(p.stderr).text())).then((e) => e.join("\n")));
  }
  wb = Workbench.open(dir, { now, onError });
}, 60000);

test("the lock goes when the holding process dies, however it dies", async () => {
  wb.close();
  const holder = Bun.spawn([process.execPath, OPENER, dir, "-", "-"], { stdout: "pipe", stderr: "pipe" });
  const next = lines(holder);
  expect(await next()).toBe("ready");
  expect(await next()).toBe(`held ${holder.pid}`);
  expect(() => Workbench.open(dir, { onError })).toThrow(WorkbenchLockedError);
  try {
    Workbench.open(dir, { onError });
  } catch (err) {
    expect((err as WorkbenchLockedError).pid).toBe(holder.pid);
  }
  holder.kill("SIGKILL");
  await holder.exited;
  wb = Workbench.open(dir, { now, onError });
  expect(wb.createCase(newCase, human).id).toBe("CASE-1");
});

test("the lock is a SQLite database in the data directory; there is no pid file", () => {
  expect(existsSync(join(dir, "workbench.lock.sqlite"))).toBe(true);
  expect(existsSync(join(dir, "workbench.lock"))).toBe(false);
  // a leftover pid file from an older version means nothing
  wb.close();
  writeFileSync(join(dir, "workbench.lock"), "1");
  wb = Workbench.open(dir, { now, onError });
});

test("listCases leaves out a case that cannot be loaded and reports it", () => {
  wb.createCase(newCase, human);
  wb.createCase({ ...newCase, title: "Third" }, human);
  mkdirSync(join(dir, "cases", "CASE-3"));
  writeFileSync(join(dir, "cases", "CASE-3", "ledger.sqlite"), "this is not a database");
  mkdirSync(join(dir, "cases", "CASE-4"));
  const list = wb.listCases();
  expect(list.map((c) => c.id)).toEqual(["CASE-2", "CASE-1"]);
  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toContain("CASE-3");
});

test("case ids of more than 9 digits are not cases and are not counted", () => {
  mkdirSync(join(dir, "cases", "CASE-12345678901234567890"));
  mkdirSync(join(dir, "cases", "CASE-123456789"));
  expect(() => wb.session("CASE-1234567890")).toThrow(CaseNotFoundError);
  expect(() => wb.session("CASE-12345678901234567890")).toThrow(CaseNotFoundError);
  expect(() => wb.session("CASE-123456789")).toThrow(CaseNotFoundError);
});

test("close closes everything even if one session fails, then rethrows", () => {
  const a = wb.createCase(newCase, human);
  const b = wb.createCase(newCase, human);
  a.close = () => { throw new Error("close failed"); };
  let bClosed = false, chainClosed = false;
  const bClose = b.close.bind(b), chainClose = wb.chain.close.bind(wb.chain);
  b.close = () => { bClosed = true; bClose(); };
  wb.chain.close = () => { chainClosed = true; chainClose(); };
  expect(() => wb.close()).toThrow("close failed");
  expect(bClosed).toBe(true);
  expect(chainClosed).toBe(true);
  // the lock was released: the data directory opens again
  Workbench.open(dir, { onError }).close();
});

test("an empty or non-string data directory is a TypeError", () => {
  expect(() => Workbench.open("")).toThrow(TypeError);
  expect(() => Workbench.open(undefined as unknown as string)).toThrow(TypeError);
});

// ---------- final review, finding 19: a damaged case still opens and shows what was skipped ----------
test("a case with an unparseable row opens, and the fold records the row as skipped", () => {
  const s = wb.createCase(newCase, human);
  s.commit(() => [{ type: "case.phase_changed", payload: { phase: "collect" }, actor: human }]);
  wb.close();
  const raw = new Database(join(dir, "cases", "CASE-1", "ledger.sqlite"));
  raw.exec(`UPDATE entries SET payload = 'garbage' WHERE seq = 2`);
  raw.close();
  errors.length = 0;
  wb = Workbench.open(dir, { now, onError });
  const again = wb.session("CASE-1");
  expect(again.state.meta?.id).toBe("CASE-1");
  expect(again.state.phase).toBeNull();
  expect(again.state.skipped).toEqual([{ seq: 2, type: "case.phase_changed", reason: "malformed payload" }]);
  expect(errors.some((e) => e instanceof Error && e.message.includes("entry 2"))).toBe(true);
});

// ---------- final review, finding 18: workbench edges ----------
test("createCase builds the payload from the case fields only, with its own id", () => {
  const input = { ...newCase, id: "CASE-999", api_key: "not-a-real-key" } as unknown as NewCase;
  const s = wb.createCase(input, human);
  expect(s.id).toBe("CASE-1");
  expect(s.state.meta?.id).toBe("CASE-1");
  const payload = s.entries()[0]!.payload as Record<string, unknown>;
  expect(Object.keys(payload).sort()).toEqual(["asked", "id", "marking", "objective", "starting", "title", "why", "window"]);
  expect(payload.id).toBe("CASE-1");
});

test("createCase refuses an input of the wrong shape before anything is written", () => {
  for (const bad of [{ ...newCase, title: 5 }, { ...newCase, starting: [{ type: "ip" }] }, { ...newCase, window: null }, { ...newCase, objective: undefined }]) {
    expect(() => wb.createCase(bad as never, human)).toThrow(TypeError);
  }
  expect(readdirSync(join(dir, "cases"))).toEqual([]);
});

test("after close the workbench refuses to work", async () => {
  wb.createCase(newCase, human);
  wb.close();
  expect(() => wb.createCase(newCase, human)).toThrow(WorkbenchClosedError);
  expect(() => wb.session("CASE-1")).toThrow(WorkbenchClosedError);
  expect(() => wb.listCases()).toThrow(WorkbenchClosedError);
  await expect(wb.unloadCase("CASE-1", { actor: human })).rejects.toThrow(WorkbenchClosedError);
  await expect(wb.loadCase(join(dir, "CASE-1.TLP-AMBER.tar.gz"), { actor: human })).rejects.toThrow(WorkbenchClosedError);
  // the mark of the highest id given out sits beside the cases, and is never one
  expect(readdirSync(join(dir, "cases")).sort()).toEqual([".high-water", "CASE-1"]);
  wb.close(); // closing twice is harmless
  wb = Workbench.open(dir, { now, onError });
});

test("the chain and case ledgers report through the workbench's onError", () => {
  wb.chain.subscribe(() => { throw new Error("chain listener broke"); });
  wb.chain.append({ type: "setting.changed", payload: { key: "k", value: 1 }, actor: human });
  expect(errors.map((e) => (e as Error).message)).toEqual(["chain listener broke"]);
});

test("the workbench chain has its own blob store under <dataDir>/blobs", () => {
  const ref = wb.chainBlobs.put("manifest bytes");
  expect(existsSync(join(dir, "blobs", ref.blob))).toBe(true);
  expect(wb.chainBlobs.text(ref.blob)).toBe("manifest bytes");
});

test("listCases reads summaries without opening and keeping sessions", () => {
  wb.createCase(newCase, human);
  wb.createCase(newCase, human);
  wb.close();
  wb = Workbench.open(dir, { now, onError });
  const cached = () => Object.keys((wb as unknown as { sessions: Record<string, unknown> }).sessions);
  expect(wb.listCases().map((c) => c.id)).toEqual(["CASE-2", "CASE-1"]);
  expect(cached()).toEqual([]);
  const one = wb.session("CASE-1");
  expect(cached()).toEqual(["CASE-1"]);
  // an open session is used as it is
  expect(wb.listCases().map((c) => c.id)).toEqual(["CASE-2", "CASE-1"]);
  expect(wb.session("CASE-1")).toBe(one);
});

test("a session closed directly is dropped from the cache and reopened on demand", () => {
  const s = wb.createCase(newCase, human);
  s.close();
  const again = wb.session("CASE-1");
  expect(again).not.toBe(s);
  again.commit(() => [{ type: "case.phase_changed", payload: { phase: "collect" }, actor: human }]);
  expect(again.state.phase).toBe("collect");
});
