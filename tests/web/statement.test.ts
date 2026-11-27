import { afterEach, expect, test } from "bun:test";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";

let p: Page | null = null;
afterEach(async () => {
  if (p !== null) expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]);
  await p?.close();
  p = null;
});
async function open(): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  return p;
}
const field = (q: Page, label: string): HTMLInputElement => q.q(`.statement-form [aria-label='${label}']`) as HTMLInputElement;
const choose = (q: Page, label: string, value: string): void => {
  const el = field(q, label) as unknown as HTMLSelectElement;
  el.value = value;
  el.dispatchEvent(new q.win.Event("change", { bubbles: true }) as unknown as Event);
};
const add = (q: Page): HTMLButtonElement => q.q(".statement-form [data-action=add-statement]") as HTMLButtonElement;
const form = (q: Page): HTMLDetailsElement => q.q("details.statement-form") as HTMLDetailsElement;

test("Add what you know opens the form; Add is off until there is text", async () => {
  const q = await open();
  expect(q.q("[data-area=incoming] .incoming-bar details.statement-form summary").textContent).toBe("Add what you know");
  expect(form(q).open).toBe(false);
  q.click("details.statement-form summary");
  form(q).open = true;
  expect(add(q).disabled).toBe(true);
  q.fill(field(q, "What you know"), "   ");
  expect(add(q).disabled).toBe(true);
  q.fill(field(q, "What you know"), "The TV is in the gym");
  expect(add(q).disabled).toBe(false);
  expect([...(field(q, "How you know") as unknown as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["saw it myself", "did it myself", "was told", "did not say how"]);
});

test("the form sends add_statement with the statement, the basis, the detail, each value it is about and the marking, then clears and closes", async () => {
  const q = await open();
  const sent: unknown[][] = [];
  const real = q.ui.send;
  q.ui.send = async (...a) => { sent.push(a); return real(...a); };
  form(q).open = true;
  q.fill(field(q, "What you know"), "The device at 192.0.2.17 is the meeting-room TV.");
  choose(q, "How you know", "did");
  q.fill(field(q, "How you know, in detail"), "I installed it");
  choose(q, "About type", "address");
  q.fill(field(q, "About value"), "192.0.2.17");
  q.click(add(q));
  await q.settle();
  expect(sent.map((s) => [s[0], s[1]]).flat()).toEqual(["add_statement", { statement: "The device at 192.0.2.17 is the meeting-room TV.", basis: "did", detail: "I installed it", about: [{ type: "address", value: "192.0.2.17" }], marking: null }]);
  const cards = Object.values(q.s.app.hub.read("CASE-1").state.cards).filter((c) => c.person !== undefined);
  expect(cards.length).toBe(1);
  expect(cards[0]!.person).toMatchObject({ basis: "did", detail: "I installed it", about: [{ type: "address", value: "192.0.2.17" }] });
  expect(field(q, "What you know").value).toBe("");
  expect(form(q).open).toBe(false);
  expect(q.all("[data-area=incoming] .tag").map((t) => t.textContent)).toContain("your statement");
});

test("more values can be added, at most 20, and an empty one is not sent", async () => {
  const q = await open();
  const sent: unknown[][] = [];
  q.ui.send = async (...a) => { sent.push(a); return null; };
  form(q).open = true;
  q.fill(field(q, "What you know"), "x");
  for (let i = 0; i < 25; i++) { const b = q.all(".statement-form [data-action=add-value]")[0]; if (b !== undefined && !(b as HTMLButtonElement).disabled) q.click(b); }
  expect(q.all(".statement-form .about-row").length).toBe(20);
  expect((q.q(".statement-form [data-action=add-value]") as HTMLButtonElement).disabled).toBe(true);
  q.fill(q.all(".statement-form [aria-label='About value']")[1]!, "192.0.2.18");
  q.click(add(q));
  await q.settle();
  expect((sent[0]![1] as { about: unknown[] }).about).toEqual([{ type: "address", value: "192.0.2.18" }]);
});

test("the marking list offers the case's marking and stricter ones only; the types are the root's", async () => {
  const q = await open();
  const caseMarking = q.s.app.hub.read("CASE-1").state.meta!.marking;
  const { MARKINGS } = await import("../../src/core/types");
  const offered = [...(field(q, "Marking") as unknown as HTMLSelectElement).options].map((o) => o.textContent);
  expect(offered).toEqual(["the case's marking", ...MARKINGS.slice(MARKINGS.indexOf(caseMarking) + 1)]);
  expect([...(field(q, "About type") as unknown as HTMLSelectElement).options].map((o) => o.value)).toEqual(q.ui.ref.types.map((t) => t.id));
  form(q).open = true;
  q.fill(field(q, "What you know"), "x");
  const stricter = MARKINGS.at(-1)!;
  if (stricter !== caseMarking) {
    const sent: unknown[][] = [];
    q.ui.send = async (...a) => { sent.push(a); return null; };
    choose(q, "Marking", stricter);
    q.click(add(q));
    await q.settle();
    expect((sent[0]![1] as { marking: string }).marking).toBe(stricter);
  }
});

test("a refusal leaves the form as typed; while replaying the form's controls are off", async () => {
  const q = await open();
  q.ui.send = async () => null;
  form(q).open = true;
  q.fill(field(q, "What you know"), "keep me");
  q.click(add(q));
  await q.settle();
  expect(field(q, "What you know").value).toBe("keep me");
  expect(form(q).open).toBe(true);
  expect(add(q).disabled).toBe(false);
  q.store()!.goTo(1);
  await q.settle();
  expect(field(q, "What you know").disabled).toBe(true);
  expect(add(q).disabled).toBe(true);
});
