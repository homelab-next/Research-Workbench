import { expect, test } from "bun:test";
import { reopens } from "../../src/pipeline/conflict";
import type { ConflictState } from "../../src/core/state";

const ruled = (change: ConflictState["change"]): ConflictState => ({
  id: "k1", draft_hash: "h", finding: "f10", change, earlier: "moderate", now: "high", raised_by: "challenge", changed_for: "evaluate",
  asks: "moderate confidence", asked: "higher confidence", points: [], reason: "r", run: "run-1", seq: 1, ruling: { follow: "evaluate", note: "", by: "analyst", seq: 2, ts: "2026-11-26T00:00:00.000Z" },
} as ConflictState);

test("a point reopens a ruling only when it names the finding and speaks to what was ruled on, not to a field that shares a word", () => {
  const c = ruled("confidence");
  expect(reopens("f10: the draft keeps moderate confidence though the ruling said high", c)).toBe(true);
  expect(reopens("f10 is overconfident given one event", c)).toBe(true);
  // CASE-3: Evaluate names the confidence_basis field when it asks for more cards; that is a citation point
  expect(reopens("f10 cites only c1 and c3; c2 and c4 are named in the confidence_basis but not cited", c)).toBe(false);
  expect(reopens("f10 cites only c1", c)).toBe(false);
  expect(reopens("f11: moderate confidence is too low", c)).toBe(false);
});
