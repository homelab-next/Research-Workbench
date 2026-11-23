import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold } from "../../src/core/state";
import { isMarking, MARKINGS, strictest } from "../../src/core/types";
import type { Card, Payloads } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import type { NewCase } from "../../src/core/workbench";
import { card, EntryBuilder } from "../helpers/entries";

test("strictest treats a value outside MARKINGS as the most restrictive", () => {
  expect(strictest("TLP:RED ")).toBe("TLP:RED");
  expect(strictest(undefined)).toBe("TLP:RED");
  expect(strictest(null)).toBe("TLP:RED");
  expect(strictest("tlp:red", "TLP:GREEN")).toBe("TLP:RED");
  expect(strictest("TLP:GREEN", "SECRET//NOFORN")).toBe("TLP:RED");
  expect(strictest("TLP:GREEN", "TLP:AMBER")).toBe("TLP:AMBER");
  expect(strictest()).toBe("TLP:CLEAR");
});

test("isMarking accepts exactly the five markings", () => {
  for (const m of MARKINGS) expect(isMarking(m)).toBe(true);
  for (const m of ["TLP:RED ", "tlp:red", "", "TLP:WHITE", null, undefined, 5, {}]) expect(isMarking(m)).toBe(false);
});

const CASE: Payloads["case.created"] = {
  id: "CASE-1", title: "T", asked: "a", why: "w", starting: [{ type: "ip", value: "192.0.2.1" }],
  window: { from: null, to: null }, objective: null, marking: "TLP:AMBER",
};

test("the fold refuses a case.created whose marking is not a marking, or whose shape is wrong", () => {
  for (const bad of [
    { ...CASE, marking: "SECRET//NOFORN" }, { ...CASE, marking: undefined }, { ...CASE, title: 5 }, { ...CASE, starting: [{ type: "ip" }] },
    { ...CASE, window: null }, { ...CASE, objective: 3 }, { ...CASE, asked: undefined },
  ]) {
    const b = new EntryBuilder();
    b.add("case.created", bad as never);
    expect(fold(b.entries).meta).toBeNull();
  }
  const b = new EntryBuilder();
  b.add("case.created", CASE);
  expect(fold(b.entries).meta).toEqual(CASE);
});

test("the fold refuses a card without a valid marking or with any field of the wrong shape", () => {
  const wrong: [string, unknown][] = [
    ["only an id", { id: "c1" }],
    ["no marking", { ...card("c1"), marking: undefined }],
    ["unknown marking", card("c1", { marking: "TLP:RED " as never })],
    ["title", card("c1", { title: 5 as never })],
    ["kind", card("c1", { kind: "other" as never })],
    ["made_by", card("c1", { made_by: "robot" as never })],
    ["query", card("c1", { query: 5 as never })],
    ["columns", card("c1", { columns: [1] as never })],
    ["column_types", card("c1", { column_types: [1] as never })],
    ["rows", card("c1", { rows: ["x"] as never })],
    ["row_count", card("c1", { row_count: -1 })],
    ["coverage", card("c1", { coverage: { kind: "partial" } as never })],
    ["coverage reason", card("c1", { coverage: { kind: "partial", reason: "bored" } as never })],
    ["empty", card("c1", { empty: "maybe" as never })],
    ["why", card("c1", { why: null as never })],
    ["event_time", card("c1", { event_time: 1 as never })],
    ["quality_notes", card("c1", { quality_notes: "n" as never })],
  ];
  for (const [label, c] of wrong) {
    const b = new EntryBuilder();
    b.add("card.created", { card: c as Card });
    const s = fold(b.entries);
    expect(s.cards, label).toEqual({});
    expect(s.incoming, label).toEqual([]);
  }
  const ok = new EntryBuilder();
  ok.add("card.created", { card: card("c1", { coverage: { kind: "partial", reason: "row_limit", detail: "50 rows" }, empty: "not-seen" }) });
  expect(fold(ok.entries).incoming).toEqual(["c1"]);
});

test("a card keeps only the fields of a card", () => {
  const b = new EntryBuilder();
  b.add("card.created", { card: { ...card("c1"), api_key: "nope" } as Card });
  const s = fold(b.entries);
  expect(Object.hasOwn(s.cards.c1!, "api_key")).toBe(false);
  expect(s.cards.c1).toMatchObject(card("c1"));
});

// ---------- createCase ----------
let dir: string;
let wb: Workbench;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "markings-"));
  wb = Workbench.open(dir, { onError: () => {} });
});
afterEach(() => {
  wb.close();
  rmSync(dir, { recursive: true, force: true });
});

test("createCase refuses an unknown marking before anything is written", () => {
  const input: NewCase = { title: "T", asked: "a", why: "w", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:AMBER" };
  for (const marking of ["SECRET//NOFORN", "TLP:RED ", undefined]) {
    expect(() => wb.createCase({ ...input, marking: marking as never }, { kind: "human", id: "analyst" })).toThrow(/marking/);
  }
  expect(readdirSync(join(dir, "cases"))).toEqual([]);
  expect(existsSync(join(dir, "cases", "CASE-1"))).toBe(false);
  expect(wb.createCase(input, { kind: "human", id: "analyst" }).id).toBe("CASE-1");
});
