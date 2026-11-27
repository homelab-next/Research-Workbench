import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "../../src/core/types";
import { verifyCase } from "../../src/core/verify";
import { CaseNotFoundError, Workbench, WorkbenchClosedError } from "../../src/core/workbench";

const person: Actor = { kind: "human", id: "analyst" };
const builder: Actor = { kind: "agent", id: "builder", stage: "builder", profile: "loop-builder", model: "scripted-m", effort: null, where: "machine" };

let dir: string;
let wb: Workbench;
let tick = 0;
const errors: unknown[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-builders-"));
  tick = 0;
  errors.length = 0;
  wb = Workbench.open(dir, { now: () => new Date(Date.UTC(2026, 10, 27, 9, 0, tick++)).toISOString(), onError: (e) => void errors.push(e) });
});
afterEach(() => {
  wb.close();
  rmSync(dir, { recursive: true, force: true });
});

const NEW_CASE = {
  title: "Beaconing", asked: "Is 192.0.2.10 beaconing?", why: "alert", starting: [{ type: "ip", value: "192.0.2.10" }],
  window: { from: null, to: null }, objective: null, marking: "TLP:AMBER" as const,
};

test("createBuilder makes <data>/builders/BUILD-1 with a ledger whose first entry is case.created, and it verifies", () => {
  const s = wb.createBuilder({ loop: "investigation", marking: "TLP:GREEN" }, person);
  expect(s.id).toBe("BUILD-1");
  expect(s.dir).toBe(join(dir, "builders", "BUILD-1"));
  expect(existsSync(join(dir, "builders", "BUILD-1", "ledger.sqlite"))).toBe(true);
  const entries = s.entries();
  // the loop it is about is recorded in the same commit, as a case's loop is
  expect(entries.map((e) => e.type)).toEqual(["case.created", "case.loop_set"]);
  expect(entries[0]).toMatchObject({ seq: 1, case: "BUILD-1", type: "case.created", actor: person });
  expect(s.state.loop.id).toBe("investigation");
  expect(entries[0]!.payload).toMatchObject({ id: "BUILD-1", asked: "Build or change a loop", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN" });
  expect(s.state.skipped).toEqual([]);
  expect(verifyCase(s.dir)).toMatchObject({ entries: 2, firstBad: null });
  // the Loops page's own session, about no loop
  const t = wb.createBuilder({ loop: null, marking: "TLP:CLEAR" }, person);
  expect(t.id).toBe("BUILD-2");
  expect(t.entries().map((e) => e.type)).toEqual(["case.created"]);
  expect(t.state.loop.id).toBeNull();
  expect(t.state.skipped).toEqual([]);
  // the builder agent does not start a session; a marking that is not one is refused; nothing was made for either
  expect(() => wb.createBuilder({ loop: null, marking: "TLP:CLEAR" }, builder)).toThrow(TypeError);
  expect(() => wb.createBuilder({ loop: null, marking: "secret" as never }, person)).toThrow(TypeError);
  expect(() => wb.createBuilder({ loop: "" , marking: "TLP:CLEAR" }, person)).toThrow(TypeError);
  expect(readdirSync(join(dir, "builders")).filter((n) => n.startsWith("BUILD-")).sort()).toEqual(["BUILD-1", "BUILD-2"]);
  expect(errors).toEqual([]);
});

test("builder sessions are not cases: listCases does not list one, session('BUILD-1') is CaseNotFoundError, and builder('CASE-1') is too", () => {
  const b = wb.createBuilder({ loop: null, marking: "TLP:GREEN" }, person);
  const c = wb.createCase(NEW_CASE, person);
  expect(c.id).toBe("CASE-1");
  expect(wb.listCases().map((x) => x.id)).toEqual(["CASE-1"]);
  expect(() => wb.session("BUILD-1")).toThrow(CaseNotFoundError);
  expect(() => wb.builder("CASE-1")).toThrow(CaseNotFoundError);
  expect(() => wb.builder("BUILD-9")).toThrow(CaseNotFoundError);
  expect(() => wb.builder("BUILD-01")).toThrow(CaseNotFoundError);
  expect(() => wb.builder("../cases/CASE-1")).toThrow(CaseNotFoundError);
  expect(wb.builder("BUILD-1")).toBe(b);
  expect(wb.listBuilders().map((x) => x.id)).toEqual(["BUILD-1"]);
  // a case's numbers and a builder's are counted apart
  expect(wb.createBuilder({ loop: null, marking: "TLP:GREEN" }, person).id).toBe("BUILD-2");
  expect(wb.createCase(NEW_CASE, person).id).toBe("CASE-2");
  // reopened from disk, it is read again as a builder session
  wb.close();
  wb = Workbench.open(dir, { onError: (e) => void errors.push(e) });
  expect(wb.builder("BUILD-1").state.meta?.id).toBe("BUILD-1");
  expect(wb.listCases().map((x) => x.id)).toEqual(["CASE-2", "CASE-1"]);
  expect(errors).toEqual([]);
});

test("listBuilders gives each session's loop, marking, open changes, open probes and turns, newest first", () => {
  expect(wb.listBuilders()).toEqual([]);
  const a = wb.createBuilder({ loop: "investigation", marking: "TLP:GREEN" }, person);
  const b = wb.createBuilder({ loop: null, marking: "TLP:CLEAR" }, person);
  a.commit((_st, ids) => [{ type: "agent.asked", payload: { turn: ids.next("turn"), text: "Add a stage", left_out: [], added: [] }, actor: person }]);
  a.commit((_st, ids) => [{ type: "agent.asked", payload: { turn: ids.next("turn"), text: "And a check", left_out: [], added: [] }, actor: person }]);
  const bundle = a.blobs.put("{\"files\":[]}", "application/json");
  a.commit((_st, ids) => [{
    type: "builder.proposed",
    payload: {
      change: ids.next("change"), title: "One more stage", why: "asked", root: "sample", bundle,
      files: [{ path: "stages/extra.yaml", kind: "stage", id: "extra", before: null, after: "b".repeat(64) }, { path: "loops/investigation.yaml", kind: "loop", id: "investigation", before: "c".repeat(64), after: "d".repeat(64) }],
    },
    actor: builder,
  }]);
  a.commit((_st, ids) => [{
    type: "builder.probe_asked",
    payload: { probe: ids.next("probe"), kind: "query", source: "netflow", pivot: null, value: null, text: "SHOW TABLES", window: { from: null, to: null }, why: "tables" },
    actor: builder,
  }]);
  a.commit((_st, ids) => [{ type: "card.created", payload: { card: {
    id: ids.next("card"), title: "Tables", body: "", kind: "note", made_by: "system", query: null, columns: [], column_types: [], rows: [], row_count: 0, coverage: null, empty: null,
    marking: "TLP:AMBER", source: null, step: null, subgoal: null, why: "probe", event_time: null, quality_notes: [],
  } }, actor: { kind: "system", id: "workbench" } }]);
  const list = wb.listBuilders();
  expect(list.map((x) => x.id)).toEqual(["BUILD-2", "BUILD-1"]);
  expect(list[1]).toEqual({
    id: "BUILD-1", title: a.state.meta!.title, loop: "investigation", marking: "TLP:AMBER", created_ts: a.entries(0, 1)[0]!.ts, open_changes: 1, open_probes: 1, turns: 2,
  });
  expect(a.state.skipped).toEqual([]);
  expect(list[0]).toMatchObject({ id: "BUILD-2", loop: null, marking: "TLP:CLEAR", open_changes: 0, open_probes: 0, turns: 0 });
  // read from disk the same, with no session held
  wb.close();
  wb = Workbench.open(dir, { onError: (e) => void errors.push(e) });
  expect(wb.listBuilders()).toEqual(list);
  void b;
  expect(errors).toEqual([]);
});

test("a builder id is not reused after its folder was removed by hand", () => {
  wb.createBuilder({ loop: null, marking: "TLP:GREEN" }, person);
  wb.createBuilder({ loop: null, marking: "TLP:GREEN" }, person);
  expect(readFileSync(join(dir, "builders", ".high-water"), "utf8").trim()).toBe("2");
  wb.close();
  rmSync(join(dir, "builders", "BUILD-2"), { recursive: true, force: true });
  wb = Workbench.open(dir, { onError: (e) => void errors.push(e) });
  expect(() => wb.builder("BUILD-2")).toThrow(CaseNotFoundError);
  expect(wb.createBuilder({ loop: null, marking: "TLP:GREEN" }, person).id).toBe("BUILD-3");
  expect(wb.listBuilders().map((x) => x.id)).toEqual(["BUILD-3", "BUILD-1"]);
  expect(errors).toEqual([]);
});

test("the workbench closes its builder sessions when it closes", () => {
  const s = wb.createBuilder({ loop: null, marking: "TLP:GREEN" }, person);
  wb.close();
  expect(s.open).toBe(false);
  expect(() => wb.builder("BUILD-1")).toThrow(WorkbenchClosedError);
  expect(() => wb.listBuilders()).toThrow(WorkbenchClosedError);
  expect(() => wb.createBuilder({ loop: null, marking: "TLP:GREEN" }, person)).toThrow(WorkbenchClosedError);
  // the data folder can be opened again at once: the sessions let go of their ledgers
  wb = Workbench.open(dir, { onError: (e) => void errors.push(e) });
  expect(wb.builder("BUILD-1").entries().length).toBe(1);
  expect(errors).toEqual([]);
});
