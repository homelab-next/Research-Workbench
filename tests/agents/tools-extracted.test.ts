// Slice 9: what a pivot's result and a card say about the values the workbench extracted, on the sample's WiFi log.
import { afterEach, expect, test } from "bun:test";
import { runPivot } from "../../src/modules/pivots";
import { resultOf } from "../../src/agents/tools/research";
import { fixture, person, WINDOW } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
afterEach(() => { expect(f.s.state.skipped).toEqual([]); f.close(); });

const DEVICE = { type: "asset", value: "ws-17.example.net", column: "message", rule: "device", row: 0, by: "code" };

test("a lookup's result view and read_card list the values extracted from the WiFi message, code-derived", async () => {
  f = fixture(false);
  const ran = await runPivot(f.s, f.sample.deps, { pivot: "address_to_wifi", value: "192.0.2.61", window: WINDOW, why: "w", actor: person });
  const r = resultOf(f.ctx, ran, f.sample.registry.pivot("address_to_wifi"), "wifi");
  expect(r.ok).toBe(true);
  const view = r.view as { extracted: unknown[]; card: { id: string }[] };
  expect(view.extracted).toContainEqual(DEVICE);
  expect(view.extracted).toContainEqual({ type: "host", value: "ap-3", column: "message", rule: "access_point", row: 0, by: "code" });
  const read = await f.call("read_card", { why: "w", card: view.card[0]!.id });
  expect((read.view as { extracted: unknown[] }).extracted).toContainEqual(DEVICE);
});

test("a card with nothing extracted shows no extracted list", async () => {
  f = fixture(false);
  const ran = await runPivot(f.s, f.sample.deps, { pivot: "address_to_asset", value: "192.0.2.17", window: WINDOW, why: "w", actor: person });
  const r = resultOf(f.ctx, ran, f.sample.registry.pivot("address_to_asset"), "assets");
  expect("extracted" in (r.view as object)).toBe(false);
  const read = await f.call("read_card", { why: "w", card: (r.view as { card: { id: string }[] }).card[0]!.id });
  expect("extracted" in (read.view as object)).toBe(false);
});
