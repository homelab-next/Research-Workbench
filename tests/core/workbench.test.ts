import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyLedger } from "../../src/core/verify";
import { CaseNotFoundError, Workbench, WorkbenchLockedError } from "../../src/core/workbench";
import type { NewCase } from "../../src/core/workbench";
import type { Actor } from "../../src/core/types";
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
  a.commit(() => [
    { type: "lane.created", payload: { lane: "l1", title: "L", subgoal: null }, actor: human },
    { type: "card.created", payload: { card: { ...cardStub("c1") } }, actor: human },
    { type: "card.created", payload: { card: { ...cardStub("c2") } }, actor: human },
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
  const p = Bun.spawnSync(["bun", "run", "src/cli/verify.ts", join(dir, "cases", "CASE-1")], { cwd: join(import.meta.dir, "../..") });
  expect(p.exitCode).toBe(0);
});

test("a failed createCase leaves no directory and the number is reused", () => {
  const bad = { ...newCase, objective: NaN as unknown as null };
  expect(() => wb.createCase(bad, human)).toThrow();
  expect(readdirSync(join(dir, "cases"))).toEqual([]);
  expect(wb.listCases()).toEqual([]);
  expect(wb.createCase(newCase, human).id).toBe("CASE-1");
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
  expect(existsSync(join(dir, "workbench.lock"))).toBe(false);
  wb = Workbench.open(dir, { now, onError });
});

test("a lock left by a dead process is taken over", async () => {
  const child = Bun.spawn(["bun", "-e", "0"]);
  await child.exited;
  wb.close();
  writeFileSync(join(dir, "workbench.lock"), String(child.pid));
  wb = Workbench.open(dir, { now, onError });
  expect(wb.createCase(newCase, human).id).toBe("CASE-1");
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
  expect(existsSync(join(dir, "workbench.lock"))).toBe(false);
});

test("an empty or non-string data directory is a TypeError", () => {
  expect(() => Workbench.open("")).toThrow(TypeError);
  expect(() => Workbench.open(undefined as unknown as string)).toThrow(TypeError);
});
