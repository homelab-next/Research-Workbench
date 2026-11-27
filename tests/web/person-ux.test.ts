import { afterEach, expect, test } from "bun:test";
import { latestDraft } from "../../src/core/state";
import type { Actor } from "../../src/core/types";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";

// Slice 10: where the person answers and overrules, without hunting for it. None of these controls passes a gate.
let p: Page;
afterEach(async () => {
  try { expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]); } finally { await p.close(); }
});

const researcher: Actor = { kind: "agent", id: "researcher-g1", stage: "research", profile: "investigation", model: "sample-run", effort: null, where: "machine" };
const human: Actor = { kind: "human", id: "analyst" };
const AP7 = "Where is the access point AP-7, and is a TV expected there?";
const state = () => p.s.app.hub.read("CASE-1").state;
const latest = () => latestDraft(state())!;
const settled = async (): Promise<void> => { await p.settle(); await p.settle(); await p.settle(); };
const gates = (): number => p.s.entries("CASE-1").filter((e) => e.type === "gate.passed" || e.type === "product.published").length;

/** A page on the sample case at the publish gate, no lens open. */
async function atGate(): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPublishGate(id);
  p.win.location.hash = `#/case/${id}`;
  await settled();
  return p;
}
function ask(text: string, opts: { why?: string; blocking?: boolean } = {}): string {
  const session = p.s.app.hub.read("CASE-1");
  let id = "";
  session.commit((st, ids) => {
    id = ids.next("question");
    return [
      { type: "model.request", actor: researcher, run: st.run.id, stage: "research", payload: { request: ids.next("request"), provider: "scripted", model: "sample-run", effort: null, where: "machine", marking: st.meta!.marking, pack: [], left_out: [], messages: session.blobs.put("{}"), tools: [] } },
      { type: "question.asked", actor: researcher, run: st.run.id, stage: "research", payload: { question: { id, text, why: opts.why ?? "it matters", cards: [], about: [], blocking: opts.blocking ?? false } } },
    ];
  });
  return id;
}
function sent(): { command: string; args: Record<string, unknown> }[] {
  const log: { command: string; args: Record<string, unknown> }[] = [];
  const real = p.ui.api.command.bind(p.ui.api);
  p.ui.api.command = (id, name, args) => { log.push({ command: name, args }); return real(id, name, args); };
  return log;
}
function overruled(finding: string, likelihood: string, note: string): void {
  p.s.app.hub.read("CASE-1").commit(() => [{ type: "finding.overruled", actor: human, payload: { finding, draft_hash: latest().hash, likelihood, confidence: null, stays: null, note } }]);
}

test("an open question is in Questions for you under the brief, with no lens open, with its text, why and an answer form", async () => {
  await atGate();
  ask(AP7, { why: "A TV there would explain the name.", blocking: true });
  await settled();
  expect(p.all(".lens-dock .lens").length).toBe(0);
  const panel = p.q(".stage-col .questions-panel");
  // between the brief and the lanes: the first thing under the brief
  expect(panel.previousElementSibling!.classList.contains("brief")).toBe(true);
  expect(panel.querySelector(".section-title")!.textContent).toBe("Questions for you (1)");
  expect(panel.querySelector('[data-question="ask-1"] .text')!.textContent).toBe(AP7);
  expect(panel.querySelector('[data-question="ask-1"] .why')!.textContent).toBe("Why it matters: A TV there would explain the name.");
  expect(panel.querySelector("[aria-label='Answer to ask-1']")!.tagName).toBe("TEXTAREA");
  expect(panel.querySelector("[aria-label='How you know the answer to ask-1']")!.tagName).toBe("SELECT");
  expect(panel.querySelector('[data-action=answer-question]')!.getAttribute("aria-label")).toBe("Answer ask-1");
});

test("Answer in the panel sends answer_question as the Narrative lens does, once, passes no gate, and collapses the question to one line with its card", async () => {
  await atGate();
  ask(AP7, { blocking: true });
  ask("Is the printer new?");
  await settled();
  const before = gates();
  const log = sent();
  const panel = (): HTMLElement => p.q(".stage-col .questions-panel");
  expect(panel().querySelector(".section-title")!.textContent).toBe("Questions for you (2)");
  p.fill(".questions-panel [aria-label='Answer to ask-1']", "In the gym. A TV is expected there.");
  const basis = p.q(".questions-panel [aria-label='How you know the answer to ask-1']") as HTMLSelectElement;
  basis.value = "saw";
  basis.dispatchEvent(new p.win.Event("change", { bubbles: true }) as unknown as Event);
  const button = p.q('.questions-panel [data-question="ask-1"] [data-action=answer-question]') as HTMLButtonElement;
  p.click(button);
  p.click(button);
  await settled();
  expect(log.filter((c) => c.command === "answer_question").map((c) => c.args)).toEqual([{ question: "ask-1", answer: "In the gym. A TV is expected there.", basis: "saw", detail: "" }]);
  const card = state().questions["ask-1"]!.answer!.card;
  const row = panel().querySelector('[data-question="ask-1"]') as HTMLElement;
  expect(row.classList.contains("answered")).toBe(true);
  expect(row.querySelector(".tag")!.textContent).toBe("answered");
  expect(row.querySelector(".card-chip")!.textContent).toBe(card);
  expect(row.querySelectorAll("p, textarea, select").length).toBe(0);
  expect(panel().querySelector(".section-title")!.textContent).toBe("Questions for you (1)");
  expect(gates()).toBe(before);
  expect(state().run.waiting).toBe("publish");
});

test("with the Narrative lens open the panel gives way to the lens's own, the same component, so each form is on screen once", async () => {
  await atGate();
  ask(AP7);
  await settled();
  p.press("r");
  await settled();
  expect(p.all("[aria-label='Answer to ask-1']").length).toBe(1);
  expect(p.q(".lens-narrative > .questions-box .section-title").textContent).toBe("Questions for you (1)");
  expect(p.all(".stage-col [data-question]").length).toBe(0);
});

test("at the publish gate the panel lists each finding with a visible Overrule button that opens its form in the Narrative lens", async () => {
  await atGate();
  const ids = latest().product.key_findings.map((f) => f.id);
  const rows = p.all(".stage-col .gate-findings [data-finding]");
  expect(rows.map((r) => r.dataset.finding)).toEqual(ids);
  const go = rows[0]!.querySelector("[data-action=open-overrule]") as HTMLButtonElement;
  expect(go.textContent).toBe("Overrule");
  expect(go.getAttribute("aria-label")).toBe(`Overrule ${ids[0]} in the Narrative lens`);
  p.click(go);
  await settled();
  expect(p.navCalls).toContainEqual(["openLens", "narrative", `overrule:${ids[0]}`]);
  expect(p.doc.activeElement).toBe(p.q(`.lens-narrative [aria-label="Note on overruling ${ids[0]}"]`));
});

test("in the Narrative lens Overrule is a button on each finding, not a fold, and opens the form in place", async () => {
  await atGate();
  p.press("r");
  await settled();
  expect(p.all(".lens-narrative details.overrule-form").length).toBe(0);
  const toggle = (): HTMLButtonElement => p.q('.lens-narrative [data-finding="f1"] [data-action=open-overrule]') as HTMLButtonElement;
  expect(toggle().tagName).toBe("BUTTON");
  expect(toggle().textContent).toBe("Overrule");
  expect(toggle().getAttribute("aria-label")).toBe("Overrule f1");
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect((p.q('[data-finding="f1"] .overrule-body') as HTMLElement).hidden).toBe(true);
  p.click(toggle());
  await settled();
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect((p.q('[data-finding="f1"] .overrule-body') as HTMLElement).hidden).toBe(false);
  expect((p.q('[data-finding="f2"] .overrule-body') as HTMLElement).hidden).toBe(true);
  // the button that sends has a name of its own
  expect(p.q('[data-finding="f1"] [data-action=overrule]').getAttribute("aria-label")).toBe("Send the overrule of f1");
  expect(p.all(".lens-narrative [data-action=open-overrule]").length).toBe(latest().product.key_findings.length);
});

test("the gate box names the open questions and the active overrules next to Approve; neither passes the gate", async () => {
  await atGate();
  ask(AP7);
  overruled("f1", "almost certain", "It is the TV I installed.");
  await settled();
  p.press("r");
  await settled();
  const notes = p.q(".gate-box .gate-notes");
  expect(notes.previousElementSibling!.classList.contains("gate-buttons")).toBe(true);
  expect(notes.querySelector(".gate-open-questions")!.textContent).toBe(`1 question is still open: ask-1 (${AP7})`);
  expect(notes.querySelector(".gate-overrules")!.textContent).toBe("1 overrule is active: f1 (likelihood almost certain)");
  ask("Is the printer new?");
  await settled();
  expect(p.q(".gate-box .gate-open-questions").textContent).toBe(`2 questions are still open: ask-1 (${AP7}); ask-2 (Is the printer new?)`);
  expect(state().published.length).toBe(0);
  expect(state().run.waiting).toBe("publish");
});

test("the ? card says where to answer and where to overrule", async () => {
  await atGate();
  p.press("?");
  await settled();
  expect(p.q(".help .where-to").textContent).toBe("Answer a question in Questions for you, under the brief. Overrule a finding with the Overrule button under it, in the Narrative lens or under Questions for you at the publish gate.");
});

// ---------- slice 10, second part: the person's changes at the gate wait for one send-back; refusals at the control; finding ids in view ----------
async function narrativeAtGate(): Promise<void> {
  await atGate();
  p.press("r");
  await settled();
}
/** Makes the server refuse `command` with `why`, once per call, for the rest of the test. */
function refuse(command: string, why: string): void {
  const real = p.ui.api.command.bind(p.ui.api);
  p.ui.api.command = (id, name, args) => (name === command ? Promise.resolve({ ok: false as const, refused: [why] }) : real(id, name, args));
}

test("the gate box lists Your changes since the draft, each with its finding id, and Send back to Assemble with my changes sends send_back_changes once", async () => {
  await narrativeAtGate();
  expect(p.all(".gate-box [data-action=send-back-changes]").length).toBe(0);
  overruled("f1", "almost certain", "It is the TV I installed.");
  ask(AP7);
  await settled();
  expect((await p.s.command("CASE-1", "answer_question", { question: "ask-1", answer: "In the gym." })).status).toBe(200);
  await settled();
  const card = state().questions["ask-1"]!.answer!.card;
  const items = p.all(".gate-box .your-changes li");
  expect(p.q(".gate-box .your-changes .label").textContent).toBe(`Your changes since draft ${latest().n} was made (not sent yet)`);
  expect(items.map((li) => li.querySelector(".finding-id")!.textContent)).toEqual(["f1", "ask-1"]);
  expect(items.map((li) => li.textContent)).toEqual(["f1 overruled: likelihood almost certain. Note: It is the TV I installed.", `ask-1 answered: card ${card}`]);
  // the overrule changed the run nothing: it is still at the gate
  expect(state().run.waiting).toBe("publish");
  const log = sent();
  const button = p.q(".gate-box [data-action=send-back-changes]") as HTMLButtonElement;
  expect(button.textContent).toBe("Send back to Assemble with my changes (2)");
  const hash = latest().hash;
  p.click(button);
  p.click(button);
  await settled();
  expect(log.filter((c) => c.command === "send_back_changes").map((c) => c.args)).toEqual([{ draft_hash: hash }]);
  expect(p.s.entries("CASE-1").filter((e) => e.type === "stage.sent_back").at(-1)!.actor.kind).toBe("human");
  expect(state().published.length).toBe(0);
  // the run is off the gate while Assemble works (the sample's script has no further turn, so no newer draft arrives here; the pipeline tests cover the new draft)
  await settled();
  expect(p.all(".gate-box .your-changes").length).toBe(0);
});

test("with changes not sent, Approve says plainly that it publishes the draft without them", async () => {
  await narrativeAtGate();
  ask(AP7);
  await settled();
  expect((await p.s.command("CASE-1", "answer_question", { question: "ask-1", answer: "In the gym." })).status).toBe(200);
  await settled();
  const d = latest();
  expect(p.q("[data-action=approve]").textContent).toBe(`Approve without my changes: publish draft ${d.n}`);
  expect(p.q(".gate-box .unsent-warning").textContent).toBe(`Your 1 change is not in draft ${d.n}. Approve publishes draft ${d.n} without it; send it back to Assemble first to have it taken in.`);
});

test("a refused overrule shows the refusal at its form, which stays open as typed", async () => {
  await narrativeAtGate();
  refuse("overrule_finding", "a newer draft arrived; look at it before overruling");
  p.click('[data-finding="f1"] [data-action=open-overrule]');
  await settled();
  const lik = p.q('[aria-label="Likelihood of f1"]') as HTMLSelectElement;
  lik.value = "almost certain";
  lik.dispatchEvent(new p.win.Event("change", { bubbles: true }) as unknown as Event);
  p.fill('[aria-label="Note on overruling f1"]', "It is the TV I installed.");
  p.click('[data-finding="f1"] [data-action=overrule]');
  await settled();
  expect(p.q('[data-finding="f1"] .overrule-body .refusal').textContent).toBe("Refused: a newer draft arrived; look at it before overruling");
  expect(p.q('[data-finding="f1"] .overrule-body .refusal').getAttribute("role")).toBe("alert");
  // a repaint of the same refusal is not announced again
  overruled("f2", "likely", "Another.");
  await settled();
  expect(p.q('[data-finding="f1"] .overrule-body .refusal').textContent).toBe("Refused: a newer draft arrived; look at it before overruling");
  expect(p.q('[data-finding="f1"] .overrule-body .refusal').getAttribute("role")).toBe("status");
  expect((p.q('[aria-label="Note on overruling f1"]') as HTMLTextAreaElement).value).toBe("It is the TV I installed.");
  expect((p.q('[data-finding="f1"] .overrule-body') as HTMLElement).hidden).toBe(false);
});

test("refused answers, rulings, statements and send-backs each show the refusal at their control, in the panel, the lens and Incoming", async () => {
  await atGate();
  ask(AP7);
  await settled();
  // the panel under the brief
  refuse("answer_question", "question ask-1 is already answered");
  p.fill(".questions-panel [aria-label='Answer to ask-1']", "In the gym.");
  p.click('.questions-panel [data-question="ask-1"] [data-action=answer-question]');
  await settled();
  expect(p.q('.questions-panel [data-question="ask-1"] .refusal').textContent).toBe("Refused: question ask-1 is already answered");
  expect((p.q(".questions-panel [aria-label='Answer to ask-1']") as HTMLTextAreaElement).value).toBe("In the gym.");
  // the statement form in Incoming
  refuse("add_statement", "a statement is at most 4000 characters");
  p.click(".statement-form summary");
  p.fill("[aria-label='What you know']", "The TV is in the gym.");
  p.click("[data-action=add-statement]");
  await settled();
  expect(p.q(".statement-form .refusal").textContent).toBe("Refused: a statement is at most 4000 characters");
  // the lens: a ruling and the send-back
  p.press("r");
  await settled();
  const d = latest();
  p.s.app.hub.read("CASE-1").commit((st, ids) => [{ type: "review.conflict", actor: { kind: "system", id: "engine" }, run: st.run.id, payload: { conflict: {
    id: ids.next("conflict"), draft_hash: d.hash, finding: "f2", change: "confidence", earlier: "high", now: "moderate", raised_by: "evaluate", changed_for: "challenge",
    asks: "high confidence", asked: "lower", points: ["f2: c1 shows it"], reason: "Evaluate and Challenge disagree on f2",
  } } }]);
  await settled();
  refuse("rule_conflict", "conflict k1 is from a run that is over");
  p.click("[data-conflict=k1] [data-action=follow-evaluate]");
  await settled();
  expect(p.q("[data-conflict=k1] .refusal").textContent).toBe("Refused: conflict k1 is from a run that is over");
  overruled("f1", "almost certain", "It is the TV I installed.");
  await settled();
  refuse("send_back_changes", "the run is not waiting at the publish gate");
  p.click(".gate-box [data-action=send-back-changes]");
  await settled();
  expect(p.q(".gate-box .your-changes .refusal").textContent).toBe("Refused: the run is not waiting at the publish gate");
});

test("each finding shows its id as a visible label: in the draft, in its Overrule form's heading, on a conflict, in the panel", async () => {
  await narrativeAtGate();
  const ids = latest().product.key_findings.map((f) => f.id);
  expect(p.all(".lens-narrative [data-section=key_findings] > .finding").map((e) => (e.firstElementChild as HTMLElement).textContent)).toEqual(ids);
  expect(p.all(".lens-narrative [data-section=key_findings] > .finding > .finding-id").length).toBe(ids.length);
  expect(p.q('[data-finding="f1"] .overrule-body .overrule-heading').textContent).toBe("Overrule f1");
  const d = latest();
  p.s.app.hub.read("CASE-1").commit((st, ids2) => [{ type: "review.conflict", actor: { kind: "system", id: "engine" }, run: st.run.id, payload: { conflict: {
    id: ids2.next("conflict"), draft_hash: d.hash, finding: "f2", change: "confidence", earlier: "high", now: "moderate", raised_by: "evaluate", changed_for: "challenge",
    asks: "high confidence", asked: "lower", points: ["f2: c1 shows it"], reason: "Evaluate and Challenge disagree on f2",
  } } }]);
  await settled();
  expect(p.q("[data-conflict=k1] .finding-id").textContent).toBe("f2");
  p.press("Escape");
  await settled();
  expect(p.all(".questions-panel .gate-finding .finding-id").map((e) => e.textContent)).toEqual(ids);
});
