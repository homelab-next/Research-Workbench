import { afterEach, expect, test } from "bun:test";
import { latestDraft } from "../../src/core/state";
import type { Actor, Section } from "../../src/core/types";
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
function propose(section: Section, text: string): string {
  let made = "";
  p.s.app.hub.read("CASE-1").commit((_st, ids) => {
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
  expect(p.all(".lens a[href*='/published/1/']").map((a) => a.textContent)).toEqual(["product.md", "product.json", "provenance.md", "provenance.json", "manifest.json"]);
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
  // again, this time stopping the run
  if (state().run.waiting === "publish") {
    p.click("[data-action=reject]");
    p.fill("[aria-label='Reason for rejecting the draft']", "enough");
    p.click("[aria-label='and stop the run']");
    p.click("[data-action=confirm-reject]");
    await settled();
    expect(state().run).toMatchObject({ status: "finished", outcome: "stopped" });
  }
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
