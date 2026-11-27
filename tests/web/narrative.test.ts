import { afterEach, expect, test } from "bun:test";
import { latestDraft } from "../../src/core/state";
import type { Actor, Marking, Section } from "../../src/core/types";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";

let p: Page;
afterEach(async () => {
  try { expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]); } finally { await p.close(); }
});

/** A page on the sample case at the publish gate with the Narrative lens open. */
async function atGate(): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPublishGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("r");
  await p.settle();
  await p.settle();
  return p;
}
const state = () => p.s.app.hub.read("CASE-1").state;
const latest = () => latestDraft(state())!;
const settled = async (): Promise<void> => { await p.settle(); await p.settle(); await p.settle(); };
const adversary: Actor = { kind: "agent", id: "adversary", stage: "challenge", profile: "investigation", model: "m", effort: null, where: "machine" };
const agent: Actor = { kind: "agent", id: "assistant", stage: "agent", profile: "investigation", model: "m", effort: null, where: "machine" };
const SECTIONS = ["summary", "key_findings", "gaps_and_limits", "alternatives", "assessment"];

/** Raises a must-address challenge against the latest draft, by hand. */
async function blockerRaised(): Promise<string> {
  let id = "";
  p.s.app.hub.read("CASE-1").commit((_s, ids) => {
    id = ids.next("challenge");
    return [{ type: "challenge.raised", actor: adversary, payload: { challenge: { id, draft_hash: latest().hash, severity: "must_address", text: "The account was never confirmed.", cites: [] } } }];
  });
  await settled();
  return id;
}
/** Raises a narrative proposal by hand, as an agent would after its model request (at the given marking, the case's by default). */
function propose(section: Section, text: string, opts: { marking?: Marking; request?: boolean } = {}): string {
  const session = p.s.app.hub.read("CASE-1");
  if (opts.request !== false) {
    session.commit((_st, ids) => [{ type: "model.request", actor: agent, payload: {
      request: ids.next("request"), provider: "scripted", model: "m", effort: null, where: "machine", marking: opts.marking ?? session.state.meta!.marking, pack: [], left_out: [], messages: session.blobs.put("{}"), tools: [],
    } }]);
  }
  let made = "";
  session.commit((_st, ids) => {
    made = ids.next("proposal");
    return [{ type: "proposal.created", actor: agent, payload: { proposal: { id: made, kind: "narrative", title: `Proposed ${section}`, by: "assistant", section, text, cites: [] } } }];
  });
  return made;
}
const approve = (): HTMLButtonElement => p.q("[data-action=approve]") as HTMLButtonElement;

test("the draft is dashed, numbered and hashed, with five sections and citations as chips", async () => {
  await atGate();
  const d = latest();
  expect(p.q(".lens .draft").classList.contains("proposed")).toBe(true);
  expect(p.q(".lens .draft-head").textContent).toContain(`Draft ${d.n} · ${d.hash.slice(0, 8)} · by analyst`);
  expect(p.q(".lens .draft-head .marking").textContent).toBe("TLP:GREEN");
  expect(p.all(".lens [data-section]").map((e) => e.dataset.section)).toEqual(SECTIONS);
  expect(p.all(".lens [data-section] .section-title").map((e) => e.textContent)).toEqual(["Summary", "Key findings", "Gaps and limits", "Alternatives", "Assessment"]);
  expect(p.q("[data-section=summary]").textContent).toContain(d.product.summary);
  expect(p.q("[data-section=gaps_and_limits] .card-chip").textContent).toBe("c3");
  expect(p.q("[data-section=gaps_and_limits] p").textContent).toContain("(c3) was cut off");
  expect(p.q("[data-section=summary]").dataset.drop).toBe("cite");
  expect(p.all("[data-action=approve]").length).toBe(1);
});

test("a cited card that is not kept is a dashed chip, and a chip opens the card", async () => {
  await atGate();
  const chip = () => p.q("[data-section=gaps_and_limits] .card-chip");
  expect(chip().classList.contains("proposed")).toBe(true);
  expect((await p.s.command("CASE-1", "keep", { card: "c3" })).status).toBe(200);
  await settled();
  expect(chip().classList.contains("proposed")).toBe(false);
  p.click(chip());
  await settled();
  expect(p.q("[data-card=c3]").classList.contains("open")).toBe(true);
});

test("each finding shows its likelihood, confidence and basis, with assumptions apart from evidence", async () => {
  await atGate();
  const f = latest().product.key_findings[0]!;
  const el = p.q("[data-finding=f1]");
  expect(el.querySelector(".statement")!.textContent).toBe(f.statement);
  expect(el.textContent).toContain("Likelihood: very likely");
  expect(el.textContent).toContain(`Confidence: moderate — ${f.confidence_basis}`);
  expect([...el.querySelectorAll(".evidence .card-chip")].map((c) => c.textContent)).toEqual(["c3", "c4", "c5"]);
  expect([...el.querySelectorAll(".assumptions li")].map((c) => c.textContent)).toEqual(["The asset list is current."]);
  expect(el.querySelector(".evidence")!.textContent).not.toContain("The asset list is current.");
  expect(el.querySelector(".reasoning")!.textContent).toContain("judgment");
  expect(el.querySelector(".reasoning")!.textContent).toContain(f.reasoning);
});

test("check results, the evaluation and challenges with their answers are shown for this revision", async () => {
  await atGate();
  expect(p.all(".review .check-row").length).toBe(11);
  expect(p.all(".review .check-row").every((r) => r.textContent!.startsWith("✓ "))).toBe(true);
  expect(p.q(".review .check-row").textContent).toBe("✓ schema");
  expect(p.q(".review .evaluation-row").textContent).toBe("✓ Evaluation");
  const x1 = p.q("[data-challenge=x1]");
  expect(x1.textContent).toContain("consider");
  expect(x1.textContent).toContain("The hosts that connected to the address were cut off");
  expect(x1.querySelector("[aria-label='Answer to x1']")).not.toBeNull();
  // a failing check and an answered challenge, hand-made
  const s = p.s.app.hub.read("CASE-1");
  s.commit(() => [{ type: "check.run", actor: { kind: "system", id: "t" }, payload: {
    check: "citations", script_hash: "h", input: { blob: "a".repeat(64), bytes: 1 }, output: { blob: "a".repeat(64), bytes: 1 }, draft_hash: latest().hash, pass: false,
    findings: [{ check: "citations", where: "summary", message: "cites nothing" }],
  } }]);
  s.commit(() => [{ type: "challenge.answered", actor: { kind: "human", id: "analyst" }, payload: { challenge: "x1", answer: "Noted, the limit is stated.", action: "rebutted" } }]);
  await settled();
  expect(p.all(".review .check-row").find((r) => r.textContent!.startsWith("✗ citations"))!.textContent).toContain("summary: cites nothing");
  const after = p.q("[data-challenge=x1]");
  expect(after.textContent).toContain("rebutted");
  expect(after.textContent).toContain("Noted, the limit is stated.");
  expect(after.querySelector("textarea")).toBeNull();
});

test("Approve says what it will do, is enabled only when nothing blocks, and publishes", async () => {
  await atGate();
  expect(p.q("[data-action=approve]").textContent).toBe(`Approve: publish draft ${latest().n}`);
  expect(p.q(".review .blockers-none").textContent).toBe("Nothing blocks publishing");
  expect(approve().disabled).toBe(false);
  p.click("[data-action=approve]");
  await settled();
  expect(state().run.outcome).toBe("published");
  expect(p.q(".lens .draft").classList.contains("proposed")).toBe(false);
  expect(p.q(".lens .draft-head").textContent).toContain("Published as product 1");
  expect(p.all(".lens a[href*='/published/1/']").map((a) => a.textContent)).toEqual(["product.json", "product.md", "provenance.json", "provenance.md", "manifest.json"]);   // the order the manifest records
  expect(p.all("[data-action=approve]").length).toBe(0);
});

test("with a blocker, Approve is disabled and the blockers are listed", async () => {
  await atGate();
  const id = await blockerRaised();
  expect(id).toBe("x2");
  expect(approve().disabled).toBe(true);
  expect(approve().title).toContain("Challenge x2 must be addressed");
  expect(p.q(".review .blockers-title").textContent).toBe("Cannot be published yet");
  expect(p.all(".review .blockers li").map((l) => l.textContent)).toEqual(["Challenge x2 must be addressed"]);
  expect(p.q("[data-challenge=x2]").textContent).toContain("must address");
  const before = p.s.entries("CASE-1").length;
  p.click(approve());
  await settled();
  expect(p.s.entries("CASE-1").length).toBe(before);
});

test("answering the challenge removes the blocker", async () => {
  await atGate();
  await blockerRaised();
  const answer = (): HTMLButtonElement => p.q("[data-challenge=x2] [data-action=answer]") as HTMLButtonElement;
  expect(answer().disabled).toBe(true);
  p.fill("[aria-label='Answer to x2']", "It was confirmed by the sign-in record.");
  expect(answer().disabled).toBe(false);
  (p.q("[aria-label='Kind of answer to x2']") as HTMLSelectElement).value = "rebutted";
  p.click(answer());
  await settled();
  expect(state().challenges.x2).toMatchObject({ status: "answered", action: "rebutted", answer: "It was confirmed by the sign-in record." });
  expect(approve().disabled).toBe(false);
  expect(p.q(".review .blockers-none").textContent).toBe("Nothing blocks publishing");
});

test("the bundle preview shows the files approve would write", async () => {
  await atGate();
  const pv = (await (await p.s.get("/api/cases/CASE-1/preview")).json()) as { files: Record<string, string> };
  const names = [...Object.keys(pv.files), "manifest.json"];
  expect(p.all(".preview [data-tab]").map((t) => t.textContent)).toEqual(names);
  expect(p.q(".preview pre").textContent).toBe(pv.files[names[0]!]!);
  p.click(`.preview [data-tab='${names[1]}']`);
  expect(p.q(".preview pre").textContent).toBe(pv.files[names[1]!]!);
  // blocked: the server's reasons, as a list
  await blockerRaised();
  await settled();
  expect(p.all(".preview [data-tab]").length).toBe(0);
  expect(p.all(".preview .reasons li").map((l) => l.textContent)).toEqual(["Challenge x2 must be addressed"]);
});

test("an edit makes a new revision by the person and sends it back through review", async () => {
  await atGate();
  const before = latest();
  p.click("[data-action=edit]");
  expect(p.q("[data-action=save]").textContent).toBe(`Save as draft ${before.n + 1}`);
  p.fill("[aria-label=Summary]", "Edited summary [c1].");
  p.fill("[aria-label='Reason for the edit']", "clearer");
  p.click("[data-action=save]");
  await settled();
  const d = latest();
  expect(d.n).toBe(before.n + 1);
  expect(d.author).toEqual({ kind: "human", id: "analyst" });
  expect(d.reason).toBe("clearer");
  expect(d.product.summary).toBe("Edited summary [c1].");
  expect(d.product.assessment).toBe(before.product.assessment);
  expect(d.product.key_findings).toEqual(before.product.key_findings);
  expect(p.s.entries("CASE-1").filter((e) => e.type === "check.run" && e.payload.draft_hash === d.hash).length).toBe(11);
  // the form went away when the revision arrived, and the new draft is the one shown
  expect(p.all("[data-action=save]").length).toBe(0);
  expect(p.q(".lens .draft-head").textContent).toContain(`Draft ${d.n} · ${d.hash.slice(0, 8)} · by analyst`);
  expect(p.q("[data-section=summary]").textContent).toContain("Edited summary");
  expect(state().run.waiting).toBe("publish");
});

test("a finding can be edited field by field", async () => {
  await atGate();
  const before = latest();
  p.click("[data-action=edit]");
  p.fill("[aria-label='Statement of f1']", "A reworded statement.");
  (p.q("[aria-label='Confidence of f1']") as HTMLSelectElement).value = "high";
  p.fill("[aria-label='Cites of f1']", "c2, c3 ,");
  p.fill("[aria-label='Assumptions of f1']", "first\n\nsecond ");
  p.fill("[aria-label='Basis of f1']", "A new basis.");
  p.fill("[aria-label='Likelihood of f1']", "likely");
  p.fill("[aria-label='Reasoning of f1']", "New reasoning.");
  p.fill("[aria-label='Reason for the edit']", "tighten");
  p.click("[data-action=save]");
  await settled();
  const [f1, f2] = latest().product.key_findings;
  expect(f1).toEqual({ id: "f1", statement: "A reworded statement.", likelihood: "likely", confidence: "high", confidence_basis: "A new basis.", cites: ["c2", "c3"], assumptions: ["first", "second"], reasoning: "New reasoning." });
  expect(f2).toEqual(before.product.key_findings[1]!);
});

test("an edit with no reason is not sent", async () => {
  await atGate();
  p.click("[data-action=edit]");
  p.fill("[aria-label=Summary]", "Edited summary.");
  expect((p.q("[data-action=save]") as HTMLButtonElement).disabled).toBe(true);
  const before = p.s.entries("CASE-1").length;
  p.click("[data-action=save]");
  await settled();
  expect(p.s.entries("CASE-1").length).toBe(before);
  p.fill("[aria-label='Reason for the edit']", "   ");
  expect((p.q("[data-action=save]") as HTMLButtonElement).disabled).toBe(true);
});

test("a refused edit keeps what was typed, and Cancel drops it", async () => {
  await atGate();
  p.click("[data-action=edit]");
  p.fill("[aria-label='Reason for the edit']", "no change at all");
  p.click("[data-action=save]");
  await settled();
  expect(p.toasts().at(-1)).toBe("the edit changes nothing in the latest draft");
  expect((p.q("[aria-label='Reason for the edit']") as HTMLInputElement).value).toBe("no change at all");
  p.fill("[aria-label=Summary]", "Half done");
  p.s.app.hub.read("CASE-1").commit(() => [{ type: "run.paused", actor: { kind: "system", id: "t" }, payload: { reason: "test" } }]);
  await settled();
  expect((p.q("[aria-label=Summary]") as HTMLTextAreaElement).value).toBe("Half done");
  p.click("[data-action=cancel]");
  expect(p.all("[data-action=save]").length).toBe(0);
  p.click("[data-action=edit]");
  expect((p.q("[aria-label=Summary]") as HTMLTextAreaElement).value).toBe(latest().product.summary);
});

test("# opens a picker of kept cards and inserts the citation; dropping a card on a section does the same", async () => {
  await atGate();
  p.click("[data-action=edit]");
  const summary = () => p.q("[aria-label=Summary]") as HTMLTextAreaElement;
  p.fill(summary(), "See #");
  expect(p.q(".picker").textContent).toContain("No kept cards");
  p.fill(summary(), "See ");
  expect(p.all(".picker").length).toBe(0);
  for (const card of ["c3", "c5"]) expect((await p.s.command("CASE-1", "keep", { card })).status).toBe(200);
  await settled();
  p.fill(summary(), "See #");
  const picks = p.all(".picker [data-pick]");
  expect(picks.map((b) => b.dataset.pick)).toEqual(["c3", "c5"]);
  expect(picks[1]!.textContent).toContain(state().cards.c5!.title);
  p.click("[data-pick=c5]");
  expect(summary().value).toBe("See [c5]");
  expect(p.all(".picker").length).toBe(0);
  // a drop on a section: the pointer events of the drag test, with the section under the pointer
  const c = p.q("[data-area=incoming] [data-card]");
  const id = c.dataset.card!;
  const zone = p.q("[data-section=assessment][data-drop=cite]");
  const ptr = (type: string, target: Element | Document, x: number, y: number): boolean =>
    target.dispatchEvent(new p.win.MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1, bubbles: true }) as unknown as Event);
  (p.doc as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => zone;
  ptr("pointerdown", c, 10, 110); ptr("pointermove", p.doc, 10, 150); ptr("pointerup", p.doc, 20, 160);
  await settled();
  expect((p.q("[aria-label=Assessment]") as HTMLTextAreaElement).value).toContain(`[${id}]`);
  expect(p.s.entries("CASE-1").filter((e) => e.type === "card.kept").length).toBe(2);   // citing kept nothing
});

test("a card's Cite button opens the edit and inserts the citation where the caret last was", async () => {
  await atGate();
  p.click("[data-area=incoming] [data-card=c2]");
  p.click("[data-card=c2] [data-action=cite]");
  await settled();
  expect(p.all("[data-action=save]").length).toBe(1);
  expect((p.q("[aria-label=Summary]") as HTMLTextAreaElement).value).toBe(`${latest().product.summary} [c2]`);
});

test("Reject needs a reason; with stop ticked the run ends", async () => {
  await atGate();
  p.click("[data-action=reject]");
  const confirm = () => p.q("[data-action=confirm-reject]") as HTMLButtonElement;
  expect(confirm().disabled).toBe(true);
  expect(p.q("[aria-label='and stop the run']").getAttribute("type")).toBe("checkbox");
  p.fill("[aria-label='Reason for rejecting the draft']", "not ready");
  p.click(confirm());
  await settled();
  expect(state().reviews[latest().hash]!.rejected).toMatchObject({ reason: "not ready", stop: false });
  expect(state().run.outcome).toBeNull();
});

test("with stop ticked, Reject ends the run", async () => {
  await atGate();
  p.click("[data-action=reject]");
  p.fill("[aria-label='Reason for rejecting the draft']", "enough");
  p.click("[aria-label='and stop the run']");
  p.click("[data-action=confirm-reject]");
  await settled();
  expect(state().reviews[latest().hash]!.rejected).toMatchObject({ reason: "enough", stop: true });
  expect(state().run).toMatchObject({ status: "finished", outcome: "stopped" });
});

test("a narrative proposal can be accepted, edited then accepted, or discarded", async () => {
  await atGate();
  const a = propose("summary", "Proposed summary [c1].");
  const b = propose("alternatives", "Proposed alternatives.");
  const c = propose("assessment", "Proposed assessment.");
  await settled();
  const block = (id: string) => p.q(`.proposal[data-proposal=${id}]`);
  expect(block(a).classList.contains("proposed")).toBe(true);
  expect(block(a).textContent).toContain("Proposed Summary · by assistant");
  expect(block(a).textContent).toContain("Proposed summary [c1].");
  p.click(`[data-proposal=${c}] [data-action=discard-proposal]`);
  await settled();
  expect(state().proposals[c]).toMatchObject({ status: "rejected", reason: "discarded" });
  expect(p.all(`[data-proposal=${c}]`).length).toBe(0);
  p.click(`[data-proposal=${b}] [data-action=edit-proposal]`);
  p.fill(`[aria-label='Text proposed in ${b}']`, "My alternatives.");
  p.click(`[data-proposal=${b}] [data-action=accept-edited]`);
  await settled();
  expect(latest().product.alternatives).toBe("My alternatives.");
  expect(state().proposals[b]!.status).toBe("accepted");
  // the revision went back through review; the next proposal is put in on top of it
  expect(state().run.waiting).toBe("publish");
  p.click(`[data-proposal=${a}] [data-action=accept-proposal]`);
  await settled();
  expect(latest().product.summary).toBe("Proposed summary [c1].");
  expect(latest().product.alternatives).toBe("My alternatives.");
  expect(latest().author).toEqual({ kind: "human", id: "analyst" });
  expect(p.all(".proposal").length).toBe(0);
});

test("a narrative proposal shows the marking of the text beside it, or that it is unknown", async () => {
  await atGate();
  // an agent's text with no request before it has no known marking; text after a request carries that request's
  const none = propose("assessment", "Words from nowhere.", { request: false });
  const red = propose("summary", "Red words.", { marking: "TLP:RED" });
  await settled();
  expect(p.q(`.proposal[data-proposal=${red}] .proposal-head`).textContent).toContain("TLP:RED");
  expect(p.q(`.proposal[data-proposal=${none}] .proposal-head`).textContent).toContain("marking unknown");
  expect((p.q(`[data-proposal=${none}] [data-action=accept-proposal]`) as HTMLButtonElement).disabled).toBe(true);
});

test("Shift+Enter from a card at the publish gate puts focus on Approve once it can be pressed", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPublishGate(id);
  p.win.location.hash = `#/case/${id}`;
  await settled();
  const card = p.q("[data-card]");
  card.focus();
  expect(p.doc.activeElement).toBe(card);
  p.press("Enter", { shift: true });
  for (let i = 0; i < 10 && (p.doc.activeElement as HTMLElement | null)?.dataset?.action !== "approve"; i++) await settled();
  expect((p.doc.activeElement as HTMLElement).dataset.action).toBe("approve");
  expect(state().published.length).toBe(0);
});

test("the publish gate's Approve does not take focus from the Command field when the lens was not asked for the gate", async () => {
  await atGate();
  const bar = p.q("[aria-label=Command]") as HTMLInputElement;
  bar.focus();
  // a new draft: the lens offers Approve again, but only to a person on the body or in the lens
  expect((await p.s.command("CASE-1", "revise", { product: { ...latest().product, summary: "A changed summary." }, reason: "edit" })).status).toBe(200);
  for (let i = 0; i < 5; i++) await settled();
  expect(approve().disabled).toBe(false);
  expect(p.doc.activeElement).toBe(bar);
});

test("a new draft offers Approve focus again to a person in the lens", async () => {
  await atGate();
  for (let i = 0; i < 5 && (p.doc.activeElement as HTMLElement | null)?.dataset?.action !== "approve"; i++) await settled();
  expect((p.doc.activeElement as HTMLElement).dataset.action).toBe("approve");
  const n = latest().n;
  expect((await p.s.command("CASE-1", "revise", { product: { ...latest().product, summary: "A changed summary." }, reason: "edit" })).status).toBe(200);
  (p.doc.activeElement as HTMLElement | null)?.blur();
  for (let i = 0; i < 10 && !(latest().n > n && !approve().disabled && (p.doc.activeElement as HTMLElement | null)?.dataset?.action === "approve"); i++) await settled();
  expect(latest().n).toBe(n + 1);
  expect(approve().disabled).toBe(false);
  expect((p.doc.activeElement as HTMLElement).dataset.action).toBe("approve");
});

test("'approve' typed at the plan gate does not arm the publish gate that arrives later", async () => {
  p = await page();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  await p.s.toPlanGate(id);
  await p.settle();
  const bar = p.q("[aria-label=Command]") as HTMLInputElement;
  bar.focus();
  p.fill(bar, "approve");
  p.press("Enter");
  await p.settle();
  bar.focus();
  p.fill(bar, "what do we kn");
  const plan = state().plan.current!;
  expect((await p.s.command(id, "accept_plan", { plan: plan.id, steps: plan.steps.map((x) => x.id), budgets: { s3: 5 } })).status).toBe(200);
  for (let i = 0; i < 10 && !(state().run.waiting === "publish" && !approve().disabled); i++) await settled();
  expect(state().run.waiting).toBe("publish");
  expect(approve().disabled).toBe(false);
  expect(p.doc.activeElement).toBe(bar);
  expect(state().published.length).toBe(0);
});

test("Approve never takes focus from a text field, even one in the lens", async () => {
  await atGate();
  for (let i = 0; i < 5 && (p.doc.activeElement as HTMLElement | null)?.dataset?.action !== "approve"; i++) await settled();
  const prop = propose("assessment", "Proposed words.");
  await settled();
  p.click(`[data-proposal=${prop}] [data-action=edit-proposal]`);
  await settled();
  const field = (): HTMLTextAreaElement => p.q(`[aria-label='Text proposed in ${prop}']`) as HTMLTextAreaElement;
  field().focus();
  expect(p.doc.activeElement).toBe(field());
  // a new draft arrives and is checked: Approve can be pressed again, and the person is still typing
  const n = latest().n;
  expect((await p.s.command("CASE-1", "revise", { product: { ...latest().product, summary: "A changed summary." }, reason: "edit" })).status).toBe(200);
  for (let i = 0; i < 10 && !(latest().n > n && state().run.waiting === "publish" && !approve().disabled); i++) await settled();
  expect(approve().disabled).toBe(false);
  expect((p.doc.activeElement as HTMLElement).tagName).toBe("TEXTAREA");
  expect(p.doc.activeElement).toBe(field());
});

test("Copy as Markdown puts the recorded text on the clipboard; when it cannot, the text is shown selected", async () => {
  await atGate();
  const written: string[] = [];
  Object.defineProperty(p.win.navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => { written.push(t); } } });
  p.click("[data-action=copy]");
  await settled();
  expect(written.length).toBe(1);
  expect(written[0]!.split("\n")[0]).toBe("TLP:GREEN");
  expect(written[0]).toContain(`## Summary\n\n${latest().product.summary}`);
  expect(p.all(".copy-fallback").length).toBe(0);
  Object.defineProperty(p.win.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
  p.click("[data-action=copy]");
  await settled();
  const box = p.q(".copy-fallback textarea") as HTMLTextAreaElement;
  expect(box.value).toBe(written[0]!);
  expect(box.hasAttribute("readonly")).toBe(true);
  expect(p.toasts().at(-1)).toBe("The clipboard refused the text; it is shown below to copy by hand");
  Object.defineProperty(p.win.navigator, "clipboard", { configurable: true, value: undefined });
  p.click("[data-action=copy]");
  await settled();
  expect((p.q(".copy-fallback textarea") as HTMLTextAreaElement).value).toBe(written[0]!);
});

test("the Markdown is text: markup in the draft is never made into elements", async () => {
  await atGate();
  p.s.app.hub.read("CASE-1");
  p.click("[data-action=edit]");
  p.fill("[aria-label=Summary]", "<img src=x onerror=alert(1)> and <b>bold</b>");
  p.fill("[aria-label='Reason for the edit']", "markup");
  p.click("[data-action=save]");
  await settled();
  expect(p.q("[data-section=summary]").textContent).toContain("<img src=x onerror=alert(1)>");
  expect(p.all(".lens img, .lens b").length).toBe(0);
});

test("the lens edits nothing while replaying", async () => {
  await atGate();
  await blockerRaised();
  propose("summary", "Words.");
  await settled();
  p.store()!.goTo(p.store()!.live.seq);
  await settled();
  const sel = ["[data-action=approve]", "[data-action=edit]", "[data-action=reject]", "[data-action=accept-proposal]", "[data-action=edit-proposal]", "[data-action=discard-proposal]", "[data-action=answer]"];
  for (const s of sel) expect([s, (p.q(s) as HTMLButtonElement).disabled]).toEqual([s, true]);
  expect((p.q("[aria-label='Answer to x2']") as HTMLTextAreaElement).disabled).toBe(true);
  // reading is still allowed
  expect((p.q("[data-action=copy]") as HTMLButtonElement).disabled).toBe(false);
  const before = p.s.entries("CASE-1").length;
  p.click("[data-action=approve]");
  await settled();
  expect(p.s.entries("CASE-1").length).toBe(before);
});

test("with no draft the lens says so and shows open proposals", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("r");
  await p.settle();
  expect(p.q(".lens").textContent).toContain("No draft yet.");
  propose("summary", "Early words.");
  await settled();
  expect(p.q(".proposal").textContent).toContain("Early words.");
  expect(p.all("[data-action=approve]").length).toBe(0);
  expect(p.all("[data-action=edit]").length).toBe(0);
});

/** Records every command the page sends, and answers as the server does. */
function sent(): { command: string; args: Record<string, unknown> }[] {
  const log: { command: string; args: Record<string, unknown> }[] = [];
  const real = p.ui.api.command.bind(p.ui.api);
  p.ui.api.command = (id, name, args) => { log.push({ command: name, args }); return real(id, name, args); };
  return log;
}

test("the published files are the ones the recorded manifest lists, and no others", async () => {
  await atGate();
  const d = latest();
  const s = p.s.app.hub.read("CASE-1");
  const blob = s.blobs.put(JSON.stringify({ manifest: { files: [{ name: "product.md", sha256: "x", bytes: 1 }] }, files: { "product.md": "x" } }));
  s.commit(() => [{ type: "product.published", actor: { kind: "human", id: "analyst" }, payload: { n: 1, draft_hash: d.hash, head_hash: "h", dir: "published/1", bundle: blob } }]);
  await settled();
  expect(p.all(".lens a[href*='/published/1/']").map((a) => a.textContent)).toEqual(["product.md", "manifest.json"]);
});

test("Approve carries the draft it shows, and a second press while the first is in flight sends nothing", async () => {
  await atGate();
  const log = sent();
  const hash = latest().hash;
  p.click("[data-action=approve]");
  p.click("[data-action=approve]");
  await settled();
  expect(log.filter((c) => c.command === "approve")).toEqual([{ command: "approve", args: { draft_hash: hash } }]);
  expect(state().run.outcome).toBe("published");
});

test("Approve is disabled and says Checking while the preview has not come, and says it could not check when it failed", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPublishGate(id);
  const real = p.ui.api.preview.bind(p.ui.api);
  p.ui.api.preview = () => new Promise(() => {});
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("r");
  await settled();
  expect(approve().disabled).toBe(true);
  expect(approve().title).toBe("Checking…");
  p.ui.api.preview = () => Promise.reject(new Error("down"));
  await p.s.command("CASE-1", "keep", { card: "c1" });
  await settled();
  expect(approve().disabled).toBe(true);
  expect(approve().title).toBe("The draft could not be checked");
  // retried on focus
  p.ui.api.preview = real;
  p.q(".lens-narrative").dispatchEvent(new p.win.Event("focusin", { bubbles: true }) as unknown as Event);
  await settled();
  expect(approve().disabled).toBe(false);
});

test("a proposal's Accept is sent once while the answer is awaited, and is disabled with no draft to put it in", async () => {
  await atGate();
  const log = sent();
  const a = propose("summary", "Proposed summary.");
  await settled();
  p.click(`[data-proposal=${a}] [data-action=accept-proposal]`);
  p.click(`[data-proposal=${a}] [data-action=accept-proposal]`);
  await settled();
  expect(log.filter((c) => c.command === "accept_proposal").length).toBe(1);
});

test("Accept on a proposal is disabled, with the reason, while there is no draft", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("r");
  const a = propose("summary", "Early words.");
  await settled();
  const b = p.q(`[data-proposal=${a}] [data-action=accept-proposal]`) as HTMLButtonElement;
  expect(b.disabled).toBe(true);
  expect(b.title).toBe("There is no draft yet to put this in");
});

test("a failed non-blocking check is listed at the gate as a noted exception and does not disable Approve", async () => {
  await atGate();
  const s = p.s.app.hub.read("CASE-1");
  s.commit(() => [{ type: "check.run", actor: { kind: "system", id: "t" }, payload: {
    check: "change", script_hash: "h", input: { blob: "a".repeat(64), bytes: 1 }, output: { blob: "a".repeat(64), bytes: 1 }, draft_hash: latest().hash, pass: false, blocking: false,
    findings: [{ check: "change", where: "change", message: "the change is empty" }],
  } }]);
  await settled();
  expect(p.q(".review .blockers-none").textContent).toBe("Nothing blocks publishing");
  expect(p.q(".review .noted-title").textContent).toBe("Noted exceptions (not blocking)");
  expect(p.all(".review .noted li").map((l) => l.textContent)).toEqual(["change failed on this revision (noted, not blocking): the change is empty"]);
  expect(approve().disabled).toBe(false);
});

/** Records a conflict between Evaluate and Challenge on the latest draft's first finding, and the pause it makes, as the engine would. */
async function conflictRecorded(): Promise<string> {
  const s = p.s.app.hub.read("CASE-1");
  const d = latest();
  const f = d.product.key_findings[0]!.id;
  let id = "";
  s.commit((st, ids) => {
    id = ids.next("conflict");
    const reason = `Evaluate and Challenge disagree on ${f}: Evaluate asks almost certain, Challenge asked lower`;
    return [
      { type: "review.conflict", actor: { kind: "system", id: "engine" }, run: st.run.id, payload: { conflict: {
        id, draft_hash: d.hash, finding: f, change: "likelihood", earlier: "almost certain", now: "likely", raised_by: "evaluate", changed_for: "challenge",
        asks: "almost certain", asked: "lower", points: [`${f}: c1 shows it directly`], reason,
      } } },
      { type: "run.paused", actor: { kind: "system", id: "engine" }, run: st.run.id, payload: { reason: `${reason}. The person rules on it in the Narrative lens: follow one reviewer, or write a note.` } },
    ];
  });
  await settled();
  return id;
}

test("when reviewers conflict the lens shows both positions and the person follows one, and the ruling is shown", async () => {
  await atGate();
  const id = await conflictRecorded();
  const box = (): HTMLElement => p.q(`[data-conflict=${id}]`);
  expect(box().textContent).toContain("Evaluate and Challenge disagree on");
  expect(box().textContent).toContain("c1 shows it directly");
  const buttons = (): string[] => [...box().querySelectorAll("button")].map((b) => b.textContent ?? "");
  expect(buttons()).toEqual(["Follow Evaluate: almost certain", "Follow Challenge: keep likely", "Rule with this note"]);
  const log = sent();
  const passed = (): number => p.s.entries("CASE-1").filter((e) => e.type === "gate.passed").length;
  const gates = passed();
  p.click(box().querySelector("[data-action=follow-challenge]") as HTMLElement);
  await settled();
  expect(log.filter((c) => c.command === "rule_conflict")).toEqual([{ command: "rule_conflict", args: { conflict: id, follow: "challenge", note: "" } }]);
  expect(state().conflicts[id]!.ruling).toMatchObject({ follow: "challenge", by: p.s.config.user });
  expect(box().textContent).toContain("Ruled: follow Challenge: keep likely");
  // the buttons left are the ones to change the ruling, folded away
  expect([...box().querySelectorAll("button")].every((b) => b.closest("details.change-ruling") !== null)).toBe(true);
});

test("a ruling may be a note alone; with no note the note button does nothing", async () => {
  await atGate();
  const id = await conflictRecorded();
  const box = (): HTMLElement => p.q(`[data-conflict=${id}]`);
  const note = (): HTMLButtonElement => box().querySelector("[data-action=rule-note]") as HTMLButtonElement;
  expect(note().disabled).toBe(true);
  p.fill(`[aria-label='Ruling note on ${id}']`, "Say likely, and name the one event in gaps.");
  expect(note().disabled).toBe(false);
  p.click(note());
  await settled();
  expect(state().conflicts[id]!.ruling).toMatchObject({ follow: null, note: "Say likely, and name the one event in gaps." });
  expect(box().textContent).toContain("Ruled: Note: Say likely, and name the one event in gaps.");
});

test("while reviewers disagree the brief holds exactly one Settle the disagreement button", async () => {
  await atGate();
  await conflictRecorded();
  const settle = p.all(".brief button").filter((b) => b.textContent === "Settle the disagreement");
  expect(settle.length).toBe(1);
  expect(p.all(".brief button").some((b) => /^Resume/.test(b.textContent ?? ""))).toBe(false);
});

// ---------- questions put to the person (slice 8) ----------
const researcher: Actor = { kind: "agent", id: "researcher-g1", stage: "research", profile: "investigation", model: "sample-run", effort: null, where: "machine" };
/** A model request of the researcher, then a question it asks while answering it, as the agent's tool writes it. */
function ask(text: string, opts: { why?: string; blocking?: boolean; about?: { type: string; value: string }[]; cards?: string[] } = {}): string {
  const session = p.s.app.hub.read("CASE-1");
  let id = "";
  session.commit((st, ids) => {
    id = ids.next("question");
    return [
      { type: "model.request", actor: researcher, run: st.run.id, stage: "research", payload: { request: ids.next("request"), provider: "scripted", model: "sample-run", effort: null, where: "machine", marking: st.meta!.marking, pack: [], left_out: [], messages: session.blobs.put("{}"), tools: [] } },
      { type: "question.asked", actor: researcher, run: st.run.id, stage: "research", payload: { question: { id, text, why: opts.why ?? "it matters", cards: opts.cards ?? [], about: opts.about ?? [], blocking: opts.blocking ?? false } } },
    ];
  });
  return id;
}
const AP7 = "Where is the access point AP-7, and is a TV expected there?";

test("an open question is shown above the draft with why it matters, what it is about and who asked; a blocking one says the run waits on it", async () => {
  await atGate();
  ask(AP7, { why: "A TV there would explain the name.", blocking: true, about: [{ type: "address", value: "198.51.100.77" }] });
  ask("Is the printer new?");
  await settled();
  expect((p.q(".lens-narrative").firstElementChild as HTMLElement).classList.contains("questions-box")).toBe(true);
  expect(p.q('[data-question="ask-1"] .text').textContent).toBe(AP7);
  expect(p.q('[data-question="ask-1"] .why').textContent).toBe("Why it matters: A TV there would explain the name.");
  expect(p.q('[data-question="ask-1"] .about').textContent).toBe("About: address 198.51.100.77");
  expect(p.q('[data-question="ask-1"] .asked-by').textContent).toBe("asked by Research");
  expect(p.q('[data-question="ask-1"] .tag').textContent).toBe("the run waits on this");
  expect(p.q('[data-question="ask-2"] .tag').textContent).toBe("question");
});

test("the question box is there before any draft exists", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  ask(AP7, { blocking: true });
  p.s.app.hub.read(id).commit((st) => [{ type: "run.paused", actor: { kind: "system", id: "engine" }, run: st.run.id, payload: { reason: "waiting for the person's answer to ask-1", hold: { kind: "question", stage: "research" } } }]);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("r");
  await settled();
  const lens = p.q(".lens-narrative");
  expect((lens.firstElementChild as HTMLElement).classList.contains("questions-box")).toBe(true);
  expect(lens.querySelector('[data-question="ask-1"] .text')!.textContent).toBe(AP7);
  expect(lens.querySelector(".no-draft")!.textContent).toBe("No draft yet.");
  expect(lens.querySelector('[data-question="ask-1"] [data-action=answer-question]')).not.toBeNull();
  expect(lens.querySelector('[data-question="ask-1"] [data-action=answer-question]')!.getAttribute("aria-label")).toBe("Answer ask-1");
});

test("Answer sends answer_question with the text and how you know, once, and the answer's card replaces the form", async () => {
  await atGate();
  ask(AP7, { blocking: true });
  await settled();
  const log = sent();
  const button = (): HTMLButtonElement => p.q('[data-question="ask-1"] [data-action=answer-question]') as HTMLButtonElement;
  expect(button().disabled).toBe(true);
  p.fill("[aria-label='Answer to ask-1']", "In the gym. A TV is expected there.");
  const basis = p.q("[aria-label='How you know the answer to ask-1']") as HTMLSelectElement;
  basis.value = "saw";
  basis.dispatchEvent(new p.win.Event("change", { bubbles: true }) as unknown as Event);
  expect(button().disabled).toBe(false);
  p.click(button());
  p.click(button());
  await settled();
  expect(log.filter((c) => c.command === "answer_question").map((c) => [c.command, c.args])).toEqual([["answer_question", { question: "ask-1", answer: "In the gym. A TV is expected there.", basis: "saw", detail: "" }]]);
  const card = state().questions["ask-1"]!.answer!.card;
  expect(p.q('[data-question="ask-1"] .card-chip').textContent).toContain("c");
  expect(p.q('[data-question="ask-1"] .card-chip').textContent).toBe(card);
  expect(p.q('[data-question="ask-1"] .tag').textContent).toBe("answered");
  expect(p.all("[aria-label='Answer to ask-1']").length).toBe(0);
});

test("a question the person went on without answering says so and can still be answered", async () => {
  await atGate();
  ask(AP7, { blocking: true });
  const session = p.s.app.hub.read("CASE-1");
  session.commit((st) => [{ type: "run.paused", actor: { kind: "system", id: "engine" }, run: st.run.id, payload: { reason: "waiting", hold: { kind: "question", stage: "research" } } }]);
  session.commit((st) => [{ type: "run.resumed", actor: { kind: "human", id: "analyst" }, run: st.run.id, payload: {} }]);
  await settled();
  expect(state().questions["ask-1"]!.waived).not.toBeNull();
  expect(p.q('[data-question="ask-1"] .tag').textContent).toBe("went on without your answer");
  expect(p.all("[aria-label='Answer to ask-1']").length).toBe(1);
});

test("a question written as markup is drawn as text; replay to before it shows no box; while replaying every control is off", async () => {
  await atGate();
  const before = p.s.entries("CASE-1").length;
  ask("<img src=x onerror=alert(1)> <b>where</b>?", { why: "<i>because</i>" });
  await settled();
  expect(p.q('[data-question="ask-1"] .text').textContent).toBe("<img src=x onerror=alert(1)> <b>where</b>?");
  expect(p.all(".questions-box img, .questions-box b, .questions-box i").length).toBe(0);
  p.store()!.goTo(before);
  await settled();
  expect(p.all("[data-question]").length).toBe(0);
  p.store()!.goTo(p.store()!.live.seq);
  await settled();
  const controls = [...p.q('[data-question="ask-1"]').querySelectorAll("textarea, select, input, button")] as HTMLInputElement[];
  expect(controls.length).toBeGreaterThan(3);
  expect(controls.filter((c) => !c.classList.contains("card-chip")).every((c) => c.disabled)).toBe(true);
});

test("an answer given after the latest draft was made is noted at the gate", async () => {
  await atGate();
  ask(AP7);
  await settled();
  expect(p.all(".gate-box .answered-since").length).toBe(0);
  expect((await p.s.command("CASE-1", "answer_question", { question: "ask-1", answer: "In the gym." })).status).toBe(200);
  await settled();
  const card = state().questions["ask-1"]!.answer!.card;
  expect(p.q(".gate-box .answered-since").textContent).toBe(`ask-1 was answered after draft ${latest().n} was made (card ${card}). Send the draft back if the answer changes it.`);
  // the answer passes no gate
  expect(state().run.waiting).toBe("publish");
  expect(state().published.length).toBe(0);
});

// ---------- overrules and revised rulings (slice 8) ----------
const human: Actor = { kind: "human", id: "analyst" };
/** Records an overrule by the person, by hand, as the command writes it. */
function overruled(finding: string, set: { likelihood?: string | null; confidence?: "low" | "moderate" | "high" | null; stays?: boolean | null }, note: string): void {
  p.s.app.hub.read("CASE-1").commit(() => [{ type: "finding.overruled", actor: human, payload: {
    finding, draft_hash: latest().hash, likelihood: set.likelihood ?? null, confidence: set.confidence ?? null, stays: set.stays ?? null, note,
  } }]);
}
const options = (sel: string): string[] => [...p.q(sel).querySelectorAll("option")].map((o) => o.textContent ?? "");
const choose = (sel: string, label: string): void => {
  const el = p.q(sel) as HTMLSelectElement;
  el.value = [...el.options].find((o) => o.textContent === label)!.value;
  el.dispatchEvent(new p.win.Event("change", { bubbles: true }) as unknown as Event);
};

test("each finding has Overrule: the likelihood terms of the standard, the three confidences, whether it stays, and a note", async () => {
  await atGate();
  const ref = p.ui.ref;
  expect(ref.likelihood.length).toBe(7);
  expect(p.q('[data-finding="f1"] details.overrule-form summary').textContent).toBe("Overrule");
  // each finding's form has its own name for a screen reader (final review m5)
  expect(p.q('[data-finding="f1"] details.overrule-form summary').getAttribute("aria-label")).toBe("Overrule f1");
  expect([...p.all('[data-finding="f1"] select[aria-label="Likelihood of f1"] option')].map((o) => o.textContent)).toEqual(["leave as it is", ...ref.likelihood]);
  expect(options('[data-finding="f1"] [aria-label="Confidence of f1"]')).toEqual(["leave as it is", "low", "moderate", "high"]);
  expect(options('[data-finding="f1"] [aria-label="Whether f1 stays"]')).toEqual(["leave as it is", "must stay", "drop it"]);
  expect(p.q('[data-finding="f1"] [aria-label="Note on overruling f1"]').tagName).toBe("TEXTAREA");
  expect(p.all("details.overrule-form").length).toBe(latest().product.key_findings.length);
  // choosing "drop it" clears and disables the two values
  choose('[aria-label="Likelihood of f1"]', "likely");
  choose('[aria-label="Whether f1 stays"]', "drop it");
  const lik = p.q('[aria-label="Likelihood of f1"]') as HTMLSelectElement;
  const conf = p.q('[aria-label="Confidence of f1"]') as HTMLSelectElement;
  expect([lik.value, lik.disabled, conf.value, conf.disabled]).toEqual(["", true, "", true]);
});

test("Overrule is off without a note, and sends overrule_finding for the draft on screen, once", async () => {
  await atGate();
  const log = sent();
  const go = (): HTMLButtonElement => p.q('[data-finding="f1"] [data-action=overrule]') as HTMLButtonElement;
  expect(go().disabled).toBe(true);                         // nothing set, no note
  choose('[aria-label="Likelihood of f1"]', "almost certain");
  expect(go().disabled).toBe(true);                         // no note
  p.fill('[aria-label="Note on overruling f1"]', "   ");
  expect(go().disabled).toBe(true);
  p.fill('[aria-label="Note on overruling f1"]', "It is the TV I installed.");
  expect(go().disabled).toBe(false);
  const hash = latest().hash;
  p.click(go());
  p.click(go());
  await settled();
  expect(log.filter((c) => c.command === "overrule_finding").map((c) => [c.command, c.args])).toEqual([["overrule_finding", { finding: "f1", draft_hash: hash, likelihood: "almost certain", confidence: null, stays: null, note: "It is the TV I installed." }]]);
  expect(state().overrules.f1).toMatchObject({ likelihood: "almost certain", note: "It is the TV I installed." });
  // the overrule passes no gate
  expect(state().published.length).toBe(0);
});

test("an overruled finding says what you set and why, with the earlier overrules under it, and offers Withdraw", async () => {
  await atGate();
  overruled("f1", { confidence: "high" }, "I checked it.");
  overruled("f1", { likelihood: "almost certain" }, "It is the TV I installed.");
  await settled();
  expect(p.q('[data-finding="f1"] .overrule-now').textContent).toBe("You overruled: likelihood almost certain. Note: It is the TV I installed.");
  expect(p.all('[data-finding="f1"] .overrule-earlier').map((e) => e.textContent)).toEqual(["Earlier: confidence high. Note: I checked it."]);
  const log = sent();
  const withdraw = (): HTMLButtonElement => p.q('[data-finding="f1"] [data-action=withdraw-overrule]') as HTMLButtonElement;
  expect(withdraw().disabled).toBe(true);
  p.fill('[aria-label="Note on overruling f1"]', "I was wrong about the room.");
  expect(withdraw().disabled).toBe(false);
  const hash = latest().hash;
  p.click(withdraw());
  await settled();
  expect(log.filter((c) => c.command === "overrule_finding").map((c) => c.args)).toEqual([{ finding: "f1", draft_hash: hash, likelihood: null, confidence: null, stays: null, note: "I was wrong about the room." }]);
  expect(state().overrules.f1).toMatchObject({ likelihood: null, confidence: null, stays: null });
  expect(p.all('[data-finding="f1"] .overrule-now').length).toBe(0);
  expect(p.all('[data-finding="f1"] [data-action=withdraw-overrule]').length).toBe(0);
});

test("a finding you dropped is listed under the findings with its overrule, so that it can be withdrawn", async () => {
  await atGate();
  const d = latest();
  expect(d.product.key_findings.map((f) => f.id)).toContain("f2");
  expect((await p.s.command("CASE-1", "revise", { product: { ...d.product, key_findings: d.product.key_findings.filter((f) => f.id !== "f2") }, reason: "f2 is not needed" })).status).toBe(200);
  await settled();
  overruled("f2", { stays: false }, "It was a test device.");
  await settled();
  expect(p.all("[data-section=key_findings] > .finding").map((e) => e.dataset.finding)).not.toContain("f2");
  const box = p.q(".dropped-findings [data-finding=f2]");
  expect(box.querySelector(".overrule-now")!.textContent).toBe("You overruled: dropped. Note: It was a test device.");
  expect(box.querySelector("[data-action=withdraw-overrule]")).not.toBeNull();
});

test("opened with overrule:f1, the lens opens that finding's form and puts focus in its note, once", async () => {
  await atGate();
  const bar = p.q("[aria-label=Command]") as HTMLInputElement;
  bar.focus();
  p.fill(bar, "overrule f1");
  p.press("Enter");
  await settled();
  expect((p.q('[data-finding="f1"] details.overrule-form') as HTMLDetailsElement).open).toBe(true);
  expect((p.q('[data-finding="f2"] details.overrule-form') as HTMLDetailsElement).open).toBe(false);
  expect(p.doc.activeElement).toBe(p.q('[aria-label="Note on overruling f1"]'));
  expect(p.toasts().concat(p.text()).some((t) => t.includes("Overrule f1 from the Narrative lens"))).toBe(true);
  // once: a later repaint does not take focus back
  bar.focus();
  overruled("f2", { confidence: "low" }, "Not sure.");
  await settled();
  expect(p.doc.activeElement).toBe(bar);
});

test("a ruled conflict shows the ruling, the rulings it replaced, and Change the ruling while its run is in progress", async () => {
  await atGate();
  const id = await conflictRecorded();
  const s = p.s.app.hub.read("CASE-1");
  s.commit((st) => [{ type: "review.ruled", actor: human, run: st.run.id, payload: { conflict: id, follow: "challenge", note: "" } }]);
  s.commit((st) => [{ type: "review.ruled", actor: human, run: st.run.id, payload: { conflict: id, follow: "evaluate", note: "" } }]);
  await settled();
  const box = (): HTMLElement => p.q(`[data-conflict=${id}]`);
  expect(box().querySelector(".ruling")!.textContent).toBe("Ruled: follow Evaluate: almost certain");
  expect([...box().querySelectorAll(".ruling-earlier")].map((e) => e.textContent)).toEqual(["Earlier: follow Challenge: keep likely (replaced)"]);
  expect(box().querySelector("details.change-ruling summary")!.textContent).toBe("Change the ruling");
  expect([...box().querySelectorAll("details.change-ruling button")].map((b) => b.textContent)).toEqual(["Follow Evaluate: almost certain", "Follow Challenge: keep likely", "Rule with this note"]);
  // a revised ruling at the gate is the person's instruction: it sends the work back, and passes no gate
  const log = sent();
  const passed = (): number => p.s.entries("CASE-1").filter((e) => e.type === "gate.passed").length;
  const gates = passed();
  p.click(box().querySelector("[data-action=follow-challenge]") as HTMLElement);
  await settled();
  expect(log.filter((c) => c.command === "rule_conflict").map((c) => c.args)).toEqual([{ conflict: id, follow: "challenge", note: "" }]);
  expect(state().conflicts[id]!.ruling).toMatchObject({ follow: "challenge" });
  expect(state().published.length).toBe(0);
  expect(passed()).toBe(gates);
  // once the run is over, the ruling stands and cannot be changed here
  expect((await p.s.command("CASE-1", "stop", { reason: "done" })).status).toBe(200);
  await settled();
  expect(state().run.status).toBe("finished");
  expect(box().querySelector("details.change-ruling")).toBeNull();
  expect(box().querySelectorAll(".ruling-earlier").length).toBe(2);
});

test("no ruling control says a ruling is fixed for the rest of the run", async () => {
  await atGate();
  const id = await conflictRecorded();
  const titles = (): string[] => p.all(`[data-conflict=${id}] [title]`).map((e) => e.getAttribute("title") ?? "");
  expect(titles().length).toBeGreaterThan(0);
  expect(titles().some((t) => t.includes("fixed for the rest of the run"))).toBe(false);
  expect(titles().filter((t) => t.includes("you can change it while the run is in progress")).length).toBe(3);
  p.s.app.hub.read("CASE-1").commit((st) => [{ type: "review.ruled", actor: human, run: st.run.id, payload: { conflict: id, follow: null, note: "Say likely." } }]);
  await settled();
  expect(titles().some((t) => t.includes("fixed for the rest of the run"))).toBe(false);
  expect(p.text()).not.toContain("fixed for the rest of the run");
});
