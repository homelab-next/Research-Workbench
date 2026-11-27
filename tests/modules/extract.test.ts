// Slice 9 goal 2: a card made from a result carries the values its field notes' extract rules pull out, recorded as code-derived.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbench } from "../../src/core/workbench";
import type { CaseSession } from "../../src/core/session";
import { verifyCase } from "../../src/core/verify";
import { fold, isCard } from "../../src/core/state";
import type { Actor, Card, TimeWindow } from "../../src/core/types";
import { loadRegistry } from "../../src/modules/registry-record";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import { ConnectorPool } from "../../src/modules/connectors";
import { runQuery } from "../../src/modules/runner";
import type { RunnerDeps } from "../../src/modules/runner";
import { runPivot } from "../../src/modules/pivots";
import { packPart } from "../../src/agents/context";
import type { Registry } from "../../src/modules/registry";

const human: Actor = { kind: "human", id: "analyst" };
const win: TimeWindow = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };

const TYPES = `kind: types
types:
  - { id: address, title: Address, pattern: '(?:\\d{1,3}\\.){3}\\d{1,3}' }
  - { id: host, title: Host, pattern: '[a-z]{2,6}-\\d{1,3}' }
  - { id: asset, title: Asset, pattern: '[a-z]{2,6}-\\d{1,3}\\.example\\.net' }
`;
const WIFI = `kind: source
id: wifi
title: WiFi controller log
connector: files
location: data
marking: "TLP:AMBER"
where: machine
adhoc: true
tables:
  - name: wifi
    file: wifi.jsonl
    format: jsonl
    time_column: ts
    columns:
      - { name: ts, meaning: When the controller logged the message. }
      - { name: address, type: address, meaning: The address the device held. }
      - name: message
        meaning: The controller's message, as free text.
        reveals: The host name the device announced, and the access point it joined.
        extract:
          - { id: device, type: asset, pattern: '^(\\S+) [0-9a-f]{2}:[0-9a-f]{2} connected to ' }
          - { id: access_point, type: host, pattern: ' connected to (\\S+?)\\. Connection Info:' }
`;
const PLAIN = `kind: source
id: plain
title: Plain list
connector: files
location: data
marking: "TLP:GREEN"
where: machine
tables:
  - name: plain
    file: plain.csv
    format: csv
    time_column: null
    columns: [{ name: address, type: address }, { name: note }]
`;
const PIVOTS = `kind: pivots
pivots:
  - { id: address_to_wifi, title: WiFi messages for the address, from: address, to: address, source: wifi, query: "select ts, address, message from wifi where address = {value}", empty_means: not-seen, yields: { address: address } }
  - { id: address_to_wifi_renamed, title: WiFi text renamed, from: address, to: address, source: wifi, query: "select address, message as said from wifi where address = {value}", empty_means: not-seen, yields: { address: address } }
  - { id: address_to_plain, title: Plain, from: address, to: address, source: plain, query: "select address, note from plain where address = {value}", empty_means: not-seen, yields: { address: address } }
`;
const ROWS = [
  { ts: "2026-01-03T10:00:00.000Z", address: "192.0.2.44", message: "ws-17.example.net 3f:9a connected to ap-9. Connection Info: band=5GHz" },
  { ts: "2026-01-03T11:00:00.000Z", address: "192.0.2.44", message: "ws-17.example.net 3f:9a disconnected" },
  { ts: "2026-01-04T10:00:00.000Z", address: "192.0.2.44", message: "ws-17.example.net 3f:9a connected to ap-12. Connection Info: band=2GHz" },
];

let dir: string;
let wb: Workbench;
let s: CaseSession;
let registry: Registry;
let pool: ConnectorPool;
let deps: RunnerDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "extract-"));
  const root = join(dir, "modules");
  mkdirSync(join(root, "sources", "data"), { recursive: true });
  writeFileSync(join(root, "types.yaml"), TYPES);
  writeFileSync(join(root, "sources", "wifi.yaml"), WIFI);
  writeFileSync(join(root, "sources", "plain.yaml"), PLAIN);
  writeFileSync(join(root, "pivots.yaml"), PIVOTS);
  writeFileSync(join(root, "sources", "data", "wifi.jsonl"), ROWS.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(root, "sources", "data", "plain.csv"), "address,note\n192.0.2.44,ws-17.example.net 3f:9a connected to ap-9. Connection Info: x\n");
  registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
  expect(registry.problems).toEqual([]);
  const observables = new Observables(registry.types());
  pool = new ConnectorPool({ secrets: new Secrets({}, null), observables });
  deps = { registry, pool, observables };
  wb = Workbench.open(join(dir, "data"), { onError: () => {} });
  s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [{ type: "address", value: "192.0.2.44" }], window: win, objective: null, marking: "TLP:GREEN" }, human);
});
afterEach(() => {
  expect(s.state.skipped).toEqual([]);
  pool.closeAll();
  try { wb.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

const cardOf = (r: Awaited<ReturnType<typeof runQuery>>): Card => {
  if (r.status !== "done" || r.card === null) throw new Error(JSON.stringify(r));
  return (s.entries().find((e) => e.type === "card.created" && (e.payload as { card: Card }).card.id === r.card)!.payload as { card: Card }).card;
};

test("a pivot's card carries the values its field notes extract, each code-derived with its rule and column", async () => {
  const c = cardOf(await runPivot(s, deps, { pivot: "address_to_wifi", value: "192.0.2.44", window: win, why: "what joined", actor: human }));
  expect(c.extracted).toEqual([
    { type: "asset", value: "ws-17.example.net", column: "message", rule: "device", row: 0, by: "code" },
    { type: "host", value: "ap-9", column: "message", rule: "access_point", row: 0, by: "code" },
    { type: "host", value: "ap-12", column: "message", rule: "access_point", row: 2, by: "code" },
  ]);
  // the fold keeps them as written, and the card's marking is what they carry
  expect(s.state.cards[c.id]!.extracted).toEqual(c.extracted!);
  expect(s.state.cards[c.id]!.marking).toBe("TLP:AMBER");
});

test("replay is exact and verify passes with extracted values on a card", async () => {
  await runPivot(s, deps, { pivot: "address_to_wifi", value: "192.0.2.44", window: win, why: "what joined", actor: human });
  const replayed = fold(s.entries());
  expect(replayed.cards).toEqual(s.state.cards);
  expect(verifyCase(s.dir).ok).toBe(true);
});

test("an ad-hoc query on the source extracts by the source column's notes", async () => {
  const c = cardOf(await runQuery(s, deps, { source: "wifi", text: "select message from wifi where address = {value}", bound: { value: "192.0.2.44" }, window: win, why: "w", actor: human }));
  expect(c.extracted!.map((x) => `${x.type} ${x.value}`)).toEqual(["asset ws-17.example.net", "host ap-9", "host ap-12"]);
});

test("a column renamed away from its source name inherits no rules, and a source with none gives no extracted field", async () => {
  const renamed = cardOf(await runPivot(s, deps, { pivot: "address_to_wifi_renamed", value: "192.0.2.44", window: win, why: "w", actor: human }));
  expect("extracted" in renamed).toBe(false);
  const plain = cardOf(await runPivot(s, deps, { pivot: "address_to_plain", value: "192.0.2.44", window: win, why: "w", actor: human }));
  expect("extracted" in plain).toBe(false);
});

test("a card's pack part lists what the workbench extracted, and says it is code-derived", async () => {
  const r = await runPivot(s, deps, { pivot: "address_to_wifi", value: "192.0.2.44", window: win, why: "w", actor: human });
  const part = packPart({ card: s.state.cards[cardOf(r).id]!, registry });
  expect(part.text).toContain("Extracted by the workbench (code-derived, from the field notes):");
  expect(part.text).toContain("- asset ws-17.example.net (rule device on column message, row 1)");
  expect(part.marking).toBe("TLP:AMBER");
});

test("the card shape refuses a malformed extracted list, and a card without one is as before", () => {
  const base = s.state.cards;
  expect(Object.keys(base)).toEqual([]);
  const card: Card = {
    id: "c9", title: "t", body: "b", kind: "result", made_by: "human", query: null, columns: [], column_types: [], rows: [], row_count: 0,
    coverage: null, empty: null, marking: "TLP:GREEN", source: null, step: null, subgoal: null, why: "w", event_time: null, quality_notes: [],
  };
  expect(isCard(card)).toBe(true);
  expect(isCard({ ...card, extracted: [] })).toBe(true);
  expect(isCard({ ...card, extracted: [{ type: "host", value: "ap-9", column: "message", rule: "access_point", row: 0, by: "code" }] })).toBe(true);
  expect(isCard({ ...card, extracted: [{ type: "host", value: "ap-9", column: "message", rule: "access_point", row: -1, by: "code" }] })).toBe(false);
  expect(isCard({ ...card, extracted: [{ type: "host", value: "ap-9", column: "message", rule: "access_point", row: 0, by: "model" }] })).toBe(false);
  expect(isCard({ ...card, extracted: "ap-9" })).toBe(false);
});
