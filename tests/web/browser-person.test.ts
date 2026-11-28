import { afterEach, expect, test } from "bun:test";
import type { Actor } from "../../src/core/types";
import { findChrome, launch } from "../helpers/chrome";
import { served } from "../helpers/served";

// Slice 10 in a real browser: a case at the publish gate with an open question. The question and Overrule are on screen as the case opens, before anything
// is clicked; answering from the panel and overruling from it pass no gate.
const chrome = findChrome();
const NONE = "browser run skipped: no Chromium found (set WORKBENCH_CHROME)";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length > 0) await closers.pop()!(); });

const researcher: Actor = { kind: "agent", id: "researcher-g1", stage: "research", profile: "investigation", model: "sample-run", effort: null, where: "machine" };
/** True when the element is drawn, has a size, and starts inside the window. */
const shown = (selector: string): string => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (e === null) return false;
  const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
  return e.checkVisibility() && cs.visibility !== "hidden" && r.width > 0 && r.height > 0 && r.top >= 0 && r.top < innerHeight; })()`;

async function atTheGate(path: string): Promise<void> {
  const s = await served({ listen: true });
  closers.push(() => s.close());
  const id = await s.newCase();
  await s.toPublishGate(id);
  const session = s.app.hub.read(id);
  session.commit((st, ids) => [
    { type: "model.request", actor: researcher, run: st.run.id, stage: "research", payload: { request: ids.next("request"), provider: "scripted", model: "sample-run", effort: null, where: "machine", marking: "TLP:GREEN", pack: [], left_out: [], messages: session.blobs.put("{}"), tools: [] } },
    { type: "question.asked", actor: researcher, run: st.run.id, stage: "research", payload: { question: { id: ids.next("question"), text: "Where is the access point <b>AP-7</b>?", why: "A TV there would explain the name.", cards: [], about: [], blocking: false } } },
  ]);
  const types = (): string[] => s.entries(id).map((e) => e.type);
  const gates = (): string[] => types().filter((t) => t === "gate.passed" || t === "product.published");
  const passedBefore = gates();

  const browser = await launch(path);
  closers.push(() => browser.close());
  const tab = await browser.tab(`${s.origin}/#/case/${id}`);
  const text = (selector: string): Promise<string> => tab.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`);
  await tab.waitFor(`document.querySelector(".questions-panel [data-question='ask-1']") !== null`);

  // nothing clicked: no lens is open, and the question, its answer box and each finding's Overrule are in view
  expect(await tab.evaluate<number>(`document.querySelectorAll(".lens-dock .lens").length`)).toBe(0);
  expect(await tab.evaluate<boolean>(shown(".questions-panel"))).toBe(true);
  expect(await text(".questions-panel .questions-box .section-title")).toBe("Questions for you (1)");
  expect(await text(".questions-panel [data-question='ask-1'] .text")).toBe("Where is the access point <b>AP-7</b>?");
  expect(await tab.evaluate<number>(`document.querySelectorAll(".questions-panel b").length`)).toBe(0);
  expect(await tab.evaluate<boolean>(shown(".questions-panel [aria-label='Answer to ask-1']"))).toBe(true);
  expect(await tab.evaluate<boolean>(shown(".questions-panel [data-finding='f1'] [data-action=open-overrule]"))).toBe(true);

  // answered from the panel: the question folds to one line with its card
  await tab.click(".questions-panel [aria-label='Answer to ask-1']");
  await tab.type("In the lobby. A TV is expected there.");
  await tab.click(".questions-panel [data-question='ask-1'] [data-action=answer-question]");
  await tab.waitFor(`document.querySelector(".questions-panel [data-question='ask-1'].answered .card-chip") !== null`);
  expect(types().filter((t) => t === "question.answered").length).toBe(1);
  expect(await text(".questions-panel .questions-box .section-title")).toBe("Questions for you (0)");

  // Overrule from the panel: the Narrative lens opens with that finding's form open and its note focused; its own Overrule button is in view, not folded
  await tab.click(".questions-panel [data-finding='f1'] [data-action=open-overrule]");
  await tab.waitFor(`document.activeElement?.getAttribute("aria-label") === "Note on overruling f1"`);
  expect(await tab.evaluate<boolean>(`document.querySelector(".lens-narrative details.overrule-form") === null`)).toBe(true);
  expect(await tab.evaluate<boolean>(`(() => { const b = document.querySelector('.lens-narrative [data-finding="f2"] [data-action=open-overrule]'); return b !== null && b.checkVisibility(); })()`)).toBe(true);
  expect(await tab.evaluate<string | null>(`document.querySelector('.lens-narrative [data-finding="f1"] [data-action=open-overrule]').getAttribute("aria-expanded")`)).toBe("true");
  expect(await tab.evaluate<number>(`document.querySelectorAll(".questions-panel [data-question]").length`)).toBe(0);
  // the question is answered, so the gate names no open question next to Approve
  await tab.waitFor(`document.querySelector(".gate-box .gate-buttons") !== null`);
  expect(await tab.evaluate<number>(`document.querySelectorAll(".gate-box .gate-open-questions").length`)).toBe(0);
  await tab.evaluate(`(() => { const s = document.querySelector("[aria-label='Likelihood of f1']"); s.value = "almost certain"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await tab.click("[aria-label='Note on overruling f1']");
  await tab.type("It is the TV I installed.");
  await tab.waitFor(`!document.querySelector("[aria-label='Send the overrule of f1']").disabled`);
  await tab.click("[aria-label='Send the overrule of f1']");
  // an overrule at the gate sends the draft back to the analyst (it passes no gate): the finding says what was set
  await tab.waitFor(`document.querySelector('.lens-narrative [data-finding="f1"] .overrule-now') !== null`);
  expect(await text('.lens-narrative [data-finding="f1"] .overrule-now')).toBe("You overruled: likelihood almost certain. Note: It is the TV I installed.");
  expect(types().filter((t) => t === "finding.overruled").length).toBe(1);
  await s.app.hub.idle();

  expect(await tab.evaluate<number>(`document.querySelectorAll("script:not([src]), style, [style], [onclick]").length`)).toBe(0);
  expect(tab.requests().filter((u) => !u.startsWith(s.origin))).toEqual([]);
  expect(tab.problems()).toEqual([]);
  expect(gates()).toEqual(passedBefore);
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
}

/** Slice 10, second part: at the gate an overrule waits for the person's send-back; a refused overrule shows its reason at its form; finding ids are in view. */
async function refusedAtTheGate(path: string): Promise<void> {
  const s = await served({ listen: true });
  closers.push(() => s.close());
  const id = await s.newCase();
  await s.toPublishGate(id);
  const types = (): string[] => s.entries(id).map((e) => e.type);
  const gates = (): string[] => types().filter((t) => t === "gate.passed" || t === "product.published");
  const passedBefore = gates();
  const browser = await launch(path);
  closers.push(() => browser.close());
  const tab = await browser.tab(`${s.origin}/#/case/${id}`);
  const text = (selector: string): Promise<string> => tab.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`);
  const overrule = async (note: string): Promise<void> => {
    await tab.evaluate(`(() => { const s = document.querySelector("[aria-label='Likelihood of f1']"); s.value = "almost certain"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    await tab.evaluate(`(() => { const t = document.querySelector("[aria-label='Note on overruling f1']"); t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await tab.click("[aria-label='Note on overruling f1']");
    await tab.type(note);
    await tab.waitFor(`!document.querySelector("[aria-label='Send the overrule of f1']").disabled`);
    await tab.click("[aria-label='Send the overrule of f1']");
  };
  await tab.waitFor(`document.querySelector(".questions-panel [data-finding='f1']") !== null`);
  await tab.click(".questions-panel [data-finding='f1'] [data-action=open-overrule]");
  await tab.waitFor(`document.activeElement?.getAttribute("aria-label") === "Note on overruling f1"`);
  // each finding's id is a visible label at its start, and the form says which finding it overrules
  expect(await tab.evaluate<boolean>(`(() => { const e = document.querySelector('.lens-narrative [data-finding="f1"] > .finding-id'); return e !== null && e.checkVisibility() && e.textContent === "f1" && e.parentElement.firstElementChild === e; })()`)).toBe(true);
  expect(await text('.lens-narrative [data-finding="f1"] .overrule-heading')).toBe("Overrule f1");

  // accepted: the run stays at the gate, and the change is listed there with its finding id
  await overrule("It is the TV I installed.");
  await tab.waitFor(`document.querySelector(".gate-box .your-changes li") !== null`);
  expect(await text(".gate-box .your-changes li")).toBe("f1 overruled: likelihood almost certain. Note: It is the TV I installed.");
  expect(s.app.hub.read(id).state.run.waiting).toBe("publish");
  const sentBefore = types().filter((t) => t === "stage.sent_back").length;

  // refused: the same overrule again; the server's words are shown at the form that sent it, which keeps what was typed
  await tab.click('.lens-narrative [data-finding="f1"] [data-action=open-overrule]');
  await tab.waitFor(`!document.querySelector('.lens-narrative [data-finding="f1"] .overrule-body').hidden`);
  await overrule("It is the TV I installed.");
  await tab.waitFor(`document.querySelector('.lens-narrative [data-finding="f1"] .overrule-body .refusal') !== null`);
  expect(await text('.lens-narrative [data-finding="f1"] .overrule-body .refusal')).toBe("Refused: that is already the overrule of f1");
  expect(await tab.evaluate<boolean>(`document.querySelector('.lens-narrative [data-finding="f1"] .overrule-body .refusal').checkVisibility()`)).toBe(true);
  expect(await tab.evaluate<string>(`document.querySelector("[aria-label='Note on overruling f1']").value`)).toBe("It is the TV I installed.");
  expect(types().filter((t) => t === "finding.overruled").length).toBe(1);

  // the one send-back, in the person's name; it passes no gate
  await tab.click(".gate-box [data-action=send-back-changes]");
  await tab.waitFor(`document.querySelector(".gate-box .your-changes") === null`);
  await s.app.hub.idle();
  const back = s.entries(id).filter((e) => e.type === "stage.sent_back");
  expect(back.length).toBe(sentBefore + 1);
  expect(back.at(-1)!.actor.kind).toBe("human");
  // the one problem the browser logs is the refusal the test asked for (a 409 from the command)
  expect(tab.problems().filter((x) => !/status of 409 \(Conflict\).*\/api\/cases\/CASE-1\/commands$/.test(x))).toEqual([]);
  expect(gates()).toEqual(passedBefore);
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
}

if (chrome === null) {
  if (process.env.WORKBENCH_REQUIRE_BROWSER === "1") test("a refused overrule shows its reason at its form; the gate waits for Send back with my changes", () => { throw new Error(NONE); });
  else test.skip("a refused overrule shows its reason at its form; the gate waits for Send back with my changes", () => {});
} else {
  test("a refused overrule shows its reason at its form; the gate waits for Send back with my changes", async () => { await refusedAtTheGate(chrome); }, 120_000);
}

if (chrome === null) {
  if (process.env.WORKBENCH_REQUIRE_BROWSER === "1") test("the questions panel and Overrule are in view at the publish gate", () => { throw new Error(NONE); });
  else test.skip("the questions panel and Overrule are in view at the publish gate", () => {});
} else {
  test("the questions panel and Overrule are in view at the publish gate", async () => { await atTheGate(chrome); }, 120_000);
}
