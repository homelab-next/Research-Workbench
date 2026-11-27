// Slice 9: what a pivot's result and a card say about the values the workbench extracted, on the sample's WiFi log.
import { afterEach, expect, test } from "bun:test";
import { runPivot } from "../../src/modules/pivots";
import { resultOf } from "../../src/agents/tools/research";
import { EXTRACTED_SHOWN, extractedLines } from "../../src/agents/context";
import type { CardState } from "../../src/core/state";
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

test("a card's extracted values are listed at most 20 at a time in the pack, in read_card and in a lookup's result", async () => {
  f = fixture(false);
  expect(EXTRACTED_SHOWN).toBe(20);
  const many = Array.from({ length: 201 }, (_, i) => ({ type: "asset", value: `ws-${i}.example.net`, column: "message", rule: "device", row: i, by: "code" as const }));
  const lines = extractedLines({ extracted: many } as unknown as CardState);
  expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(20);
  expect(lines[lines.length - 1]).toBe("and 181 more extracted values, not listed");
  expect(lines.join("\n").length).toBeLessThan(2000);
  // the sample's card with its values: under the limit, all are listed and nothing more is said
  const ran = await runPivot(f.s, f.sample.deps, { pivot: "address_to_wifi", value: "192.0.2.61", window: WINDOW, why: "w", actor: person });
  const r = resultOf(f.ctx, ran, f.sample.registry.pivot("address_to_wifi"), "wifi");
  expect("extracted_more" in (r.view as object)).toBe(false);
  const card = f.s.state.cards[(r.view as { card: { id: string }[] }).card[0]!.id]!;
  // the same card with 201 values: the views carry 20 and say how many more
  (card as { extracted?: unknown }).extracted = many;
  const big = resultOf(f.ctx, ran, f.sample.registry.pivot("address_to_wifi"), "wifi").view as { extracted: unknown[]; extracted_more: number };
  expect(big.extracted).toHaveLength(20);
  expect(big.extracted_more).toBe(181);
  const read = (await f.call("read_card", { why: "w", card: card.id })).view as { extracted: unknown[]; extracted_more: number };
  expect(read.extracted).toHaveLength(20);
  expect(read.extracted_more).toBe(181);
});
