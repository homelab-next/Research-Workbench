import { expect, test } from "bun:test";
import { assemblePack, mayGo, packBudget, renderPack, tooStrict } from "../../src/agents/pack";
import type { Pack } from "../../src/agents/pack";
import type { PackPart } from "../../src/agents/context";
import { sha256Hex } from "../../src/core/hash";
import type { Marking, Where } from "../../src/core/types";

const part = (id: string, chars: number, marking: Marking | null = null, fixed = false): PackPart =>
  ({ kind: "k", id, title: `T-${id}`, text: "x".repeat(chars), marking, fixed });
const fixed = (id: string, chars: number, marking: Marking | null = null): PackPart => part(id, chars, marking, true);
const open = { budget: 1000, case_marking: "TLP:GREEN" as Marking, max_marking: null };
const policy: Record<Marking, Where[]> = {
  "TLP:CLEAR": ["machine", "network", "hosted"], "TLP:GREEN": ["machine", "network", "hosted"],
  "TLP:AMBER": ["machine", "network"], "TLP:AMBER+STRICT": ["machine", "network"], "TLP:RED": ["machine"],
};

test("the budget is half the context at three characters a token", () => {
  expect(packBudget(131072)).toBe(196608);
});

test("every part that fits goes in, in order, with its hash and size", () => {
  const p = assemblePack([fixed("rules", 10), part("a", 20), part("b", 30)], open) as Pack;
  expect(p.items).toEqual([
    { kind: "k", id: "rules", title: "T-rules", hash: sha256Hex("x".repeat(10)), chars: 10, fixed: true },
    { kind: "k", id: "a", title: "T-a", hash: sha256Hex("x".repeat(20)), chars: 20, fixed: false },
    { kind: "k", id: "b", title: "T-b", hash: sha256Hex("x".repeat(30)), chars: 30, fixed: false },
  ]);
  expect(p.left_out).toEqual([]);
  expect(p.chars).toBe(60);
  expect(p.budget).toBe(1000);
});

test("a part that does not fit is left out and listed, and a later smaller part still goes in", () => {
  const p = assemblePack([fixed("rules", 100), part("big", 500), part("small", 50)], { budget: 200, case_marking: "TLP:CLEAR", max_marking: null }) as Pack;
  expect(p.items.map((i) => i.id)).toEqual(["rules", "small"]);
  expect(p.left_out.map((i) => i.id)).toEqual(["big"]);
});

test("fixed parts that do not fit mean no pack at all", () => {
  const r = assemblePack([fixed("a", 150), part("b", 10), fixed("c", 100)], { budget: 200, case_marking: "TLP:CLEAR", max_marking: null });
  expect("too_big" in r && r.too_big.map((i) => i.id)).toEqual(["a", "c"]);
});

test("a fixed part later in the order still has its room held back from earlier optional parts", () => {
  const p = assemblePack([part("a", 150), fixed("c", 100)], { budget: 200, case_marking: "TLP:CLEAR", max_marking: null }) as Pack;
  expect(p.items.map((i) => i.id)).toEqual(["c"]);
  expect(p.left_out.map((i) => i.id)).toEqual(["a"]);
});

test("the pack's marking is the strictest of the case and what went in", () => {
  const p = assemblePack([fixed("case", 5, "TLP:GREEN"), part("card", 5, "TLP:AMBER")], open) as Pack;
  expect(p.marking).toBe("TLP:AMBER");
});

test("a part with an unknown marking counts as the most restrictive", () => {
  const p = assemblePack([part("odd", 5, "TLP:PURPLE" as never)], open) as Pack;
  expect(p.marking).toBe("TLP:RED");
});

test("with a limit, stricter parts are left out and do not raise the marking", () => {
  const p = assemblePack([fixed("case", 5, "TLP:GREEN"), part("card", 5, "TLP:AMBER"), part("ok", 5, "TLP:CLEAR")], { ...open, max_marking: "TLP:GREEN" }) as Pack;
  expect(p.items.map((i) => i.id)).toEqual(["case", "ok"]);
  expect(p.left_out.map((i) => i.id)).toEqual(["card"]);
  expect(p.marking).toBe("TLP:GREEN");
});

test("with a limit, a part with an unknown marking is left out", () => {
  const p = assemblePack([part("odd", 5, "TLP:PURPLE" as never)], { ...open, max_marking: "TLP:AMBER" }) as Pack;
  expect(p.items).toEqual([]);
  expect(p.left_out.map((i) => i.id)).toEqual(["odd"]);
});

test("a limit never removes a fixed part", () => {
  const p = assemblePack([fixed("case", 5, "TLP:AMBER")], { ...open, case_marking: "TLP:AMBER", max_marking: "TLP:CLEAR" }) as Pack;
  expect(p.items.map((i) => i.id)).toEqual(["case"]);
  expect(p.marking).toBe("TLP:AMBER");
});

test("tooStrict is true only when a limit is set and the marking is stricter", () => {
  expect(tooStrict("TLP:AMBER", "TLP:GREEN")).toBe(true);
  expect(tooStrict("TLP:GREEN", "TLP:GREEN")).toBe(false);
  expect(tooStrict("TLP:RED", null)).toBe(false);
  expect(tooStrict(null, "TLP:CLEAR")).toBe(false);
  expect(tooStrict("TLP:PURPLE" as never, "TLP:AMBER")).toBe(true);
});

test("a limit that is not a marking keeps out every part that is not fixed", () => {
  const p = assemblePack([fixed("case", 5), part("a", 5, null), part("b", 5, "TLP:CLEAR")], { ...open, max_marking: "TLP:PURPLE" as never }) as Pack;
  expect(p.items.map((i) => i.id)).toEqual(["case"]);
  expect(p.left_out.map((i) => i.id)).toEqual(["a", "b"]);
  expect(tooStrict(null, "TLP:PURPLE" as never)).toBe(true);
});

test("mayGo follows the policy", () => {
  expect(mayGo("TLP:AMBER", "hosted", policy)).toBe(false);
  expect(mayGo("TLP:AMBER", "machine", policy)).toBe(true);
});

test("mayGo refuses a marking the policy does not know", () => {
  expect(mayGo("TLP:PURPLE" as never, "machine", policy)).toBe(false);
});

test("a card left out for its marking has neither title nor text in the rendered pack", () => {
  const secret = { kind: "card", id: "c3", title: "Payroll breach at Acme", text: "salary details", marking: "TLP:AMBER" as Marking, fixed: false };
  const p = assemblePack([fixed("case", 5, "TLP:GREEN"), secret], { ...open, max_marking: "TLP:GREEN" }) as Pack;
  const out = renderPack(p);
  expect(p.marking).toBe("TLP:GREEN");
  expect(out).toContain("Left out of this turn: card c3");
  expect(out).not.toContain("Payroll");
  expect(out).not.toContain("salary");
});

test("the rendered pack names what was left out", () => {
  const p = assemblePack([fixed("rules", 5), part("big", 5000), part("huge", 5000)], { budget: 100, case_marking: "TLP:CLEAR", max_marking: null }) as Pack;
  const out = renderPack(p);
  expect(out.startsWith("## T-rules\nxxxxx")).toBe(true);
  expect(out.endsWith("Left out of this turn: k big, k huge")).toBe(true);
  const all = renderPack(assemblePack([fixed("a", 3), part("b", 3)], open) as Pack);
  expect(all).toBe("## T-a\nxxx\n\n## T-b\nxxx");
});
