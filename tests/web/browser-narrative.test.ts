import { afterEach, expect, test } from "bun:test";
import type { Actor } from "../../src/core/types";
import { findChrome, launch } from "../helpers/chrome";
import { served } from "../helpers/served";

// The Narrative lens's slice-8 parts in a real browser: a question answered, a finding overruled, a ruling changed. None passes a gate.
const chrome = findChrome();
const NONE = "browser run skipped: no Chromium found (set WORKBENCH_CHROME)";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length > 0) await closers.pop()!(); });

const researcher: Actor = { kind: "agent", id: "researcher-g1", stage: "research", profile: "investigation", model: "sample-run", effort: null, where: "machine" };

async function theLens(path: string): Promise<void> {
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
  const choose = (selector: string, value: string): Promise<unknown> =>
    tab.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await tab.waitFor(`document.querySelector("[data-area=incoming]") !== null`);
  expect(await text("[data-status=questions]")).toBe("1 question for you");
  await tab.click("[data-status=questions]");
  await tab.waitFor(`document.querySelector('.lens-narrative [data-question="ask-1"]') !== null`);

  // the question, drawn as text, first in the lens
  expect(await tab.evaluate<string>(`document.querySelector(".lens-narrative").firstElementChild.className`)).toBe("questions-box");
  expect(await text('[data-question="ask-1"] .text')).toBe("Where is the access point <b>AP-7</b>?");
  expect(await tab.evaluate<number>(`document.querySelectorAll(".questions-box b").length`)).toBe(0);

  // answered: typed, how you know chosen, sent once; the card replaces the form
  await tab.click("[aria-label='Answer to ask-1']");
  await tab.type("In the gym. A TV is expected there.");
  await choose("[aria-label='How you know the answer to ask-1']", "saw");
  await tab.click('[data-question="ask-1"] [data-action=answer-question]');
  await tab.waitFor(`document.querySelector('[data-question="ask-1"] .answer .card-chip') !== null`);
  expect(types().filter((t) => t === "question.answered").length).toBe(1);
  await tab.waitFor(`document.querySelector(".gate-box .answered-since") !== null`);
  expect(await text(".gate-box .answered-since")).toMatch(/^ask-1 was answered after draft \d+ was made \(card c\d+\)\. Send the draft back if the answer changes it\.$/);

  // overruled: the form opens, Overrule waits for a value and a note, and is sent once
  await tab.click('[data-finding="f1"] [data-action=open-overrule]');
  await tab.waitFor(`!document.querySelector('[data-finding="f1"] .overrule-body').hidden`);
  expect(await tab.evaluate<boolean>(`document.querySelector('[data-finding="f1"] [data-action=overrule]').disabled`)).toBe(true);
  await choose("[aria-label='Likelihood of f1']", "almost certain");
  await tab.click("[aria-label='Note on overruling f1']");
  await tab.type("It is the TV I installed.");
  await tab.waitFor(`!document.querySelector('[data-finding="f1"] [data-action=overrule]').disabled`);
  await tab.click('[data-finding="f1"] [data-action=overrule]');
  await tab.waitFor(`document.querySelector('[data-finding="f1"] .overrule-now') !== null`);
  expect(await text('[data-finding="f1"] .overrule-now')).toBe("You overruled: likelihood almost certain. Note: It is the TV I installed.");
  expect(types().filter((t) => t === "finding.overruled").length).toBe(1);
  await s.app.hub.idle();

  // a ruling changed: the form is folded under "Change the ruling" while the run is in progress
  session.commit((st, ids) => {
    const d = st.drafts[st.drafts.length - 1]!;
    const k = ids.next("conflict");
    return [
      { type: "review.conflict", actor: { kind: "system", id: "engine" }, run: st.run.id, payload: { conflict: {
        id: k, draft_hash: d.hash, finding: "f2", change: "confidence", earlier: "high", now: "moderate", raised_by: "evaluate", changed_for: "challenge",
        asks: "high confidence", asked: "lower", points: ["f2: c1 shows it directly"], reason: "Evaluate and Challenge disagree on f2",
      } } },
      { type: "review.ruled", actor: { kind: "human", id: s.config.user }, run: st.run.id, payload: { conflict: k, follow: "evaluate", note: "" } },
    ];
  });
  await tab.waitFor(`document.querySelector("[data-conflict=k1] details.change-ruling") !== null`);
  expect(await text("[data-conflict=k1] .ruling")).toBe("Ruled: follow Evaluate: high confidence");
  await tab.click("[data-conflict=k1] details.change-ruling summary");
  await tab.waitFor(`document.querySelector("[data-conflict=k1] details.change-ruling").open`);
  await tab.click("[data-conflict=k1] [data-action=follow-challenge]");
  await tab.waitFor(`document.querySelector("[data-conflict=k1] .ruling-earlier") !== null`);
  expect(await text("[data-conflict=k1] .ruling-earlier")).toBe("Earlier: follow Evaluate: high confidence (replaced)");
  expect(s.app.hub.read(id).state.conflicts.k1!.ruling).toMatchObject({ follow: "challenge" });
  await s.app.hub.idle();

  // what the page is, in the browser that enforces it; and no answer or overrule passed a gate
  expect(await tab.evaluate<number>(`document.querySelectorAll("script:not([src]), style, [style], [onclick]").length`)).toBe(0);
  expect(tab.requests().filter((u) => !u.startsWith(s.origin))).toEqual([]);
  expect(tab.problems()).toEqual([]);
  expect(gates()).toEqual(passedBefore);
  expect(s.app.hub.read(id).state.skipped).toEqual([]);
}

if (chrome === null) {
  if (process.env.WORKBENCH_REQUIRE_BROWSER === "1") test("the Narrative lens's questions and overrules in a browser", () => { throw new Error(NONE); });
  else test.skip("the Narrative lens's questions and overrules in a browser", () => {});
} else {
  test("the Narrative lens's questions and overrules in a browser", async () => { await theLens(chrome); }, 120_000);
}
