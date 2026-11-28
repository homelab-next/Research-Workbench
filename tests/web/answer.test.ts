import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import type { CaseState } from "../../src/core/state";
import { answerPanel } from "../../src/web/panels/answer";
import { page, testUi } from "../helpers/dom";
import type { Page } from "../helpers/dom";

// Task 19: the Known answer form under a published product of the Narrative lens. Over the sample served in process; the probe child, the
// improve case and a reader's view are the published case's own state with the one thing that differs.

let p: Page | null = null;
afterEach(async () => {
  try { if (p !== null) expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]); } finally { await p?.close(); p = null; }
});

const settled = async (q: Page): Promise<void> => { await q.settle(); await q.settle(); await q.settle(); };

/** The sample case at its publish gate with the Narrative lens open; `publish` approves it first. */
async function narrative(opts: { publish: boolean; marking?: string }): Promise<Page> {
  const q = await page();
  p = q;
  const id = await q.s.newCase(opts.marking === undefined ? {} : { marking: opts.marking as never });
  await q.s.toPublishGate(id);
  if (opts.publish) {
    expect((await q.s.command(id, "approve")).status).toBe(200);
    await q.s.app.hub.idle();
  }
  q.win.location.hash = `#/case/${id}`;
  await q.settle();
  q.press("r");
  await settled(q);
  return q;
}
const state = (q: Page): CaseState => q.s.app.hub.read("CASE-1").state;
const form = (q: Page): HTMLDetailsElement => q.q(".lens-narrative details.known-answer-form") as HTMLDetailsElement;
const field = <T extends HTMLElement = HTMLInputElement>(q: Page, label: string): T => q.q(`.known-answer [aria-label='${label}']`) as T;
const choose = (q: Page, label: string, value: string): void => {
  const el = field<HTMLSelectElement>(q, label);
  el.value = value;
  el.dispatchEvent(new q.win.Event("change", { bubbles: true }) as unknown as Event);
};
/** Records every send, then sends it. */
const recording = (q: Page): unknown[][] => {
  const sent: unknown[][] = [];
  const real = q.ui.send;
  q.ui.send = async (...a) => { sent.push(a); return real(...a); };
  return sent;
};

/** The panel drawn over `s`, by `role`, outside any page: what a probe child, an improve case or a reader would be shown. */
function panelOver(s: CaseState, role: "analyst" | "leader" | "requester" = "analyst", at: number | null = null): HTMLElement {
  const win = new Window({ url: "http://127.0.0.1:1/" });
  const base = testUi(win);
  const ui = testUi(win, { me: { ...base.me, role } });
  const view = answerPanel({ ui, store: { id: "CASE-1", shown: s, at } }, 1);
  view.update();
  return view.el;
}

test("a published product has a Known answer control; a draft, a probe child and a reader's view have none", async () => {
  const q = await narrative({ publish: false });
  expect(q.all(".lens-narrative .known-answer-form").length).toBe(0);
  const id = "CASE-1";
  expect((await q.s.command(id, "approve")).status).toBe(200);
  await settled(q);
  expect(form(q).querySelector("summary")!.textContent).toBe("Set the known answer");
  expect(q.q(".lens-narrative .draft .known-answer").dataset.product).toBe("1");
  const s = state(q);
  expect(panelOver(s).querySelector(".known-answer-form")).not.toBeNull();
  const probe = { ...s, improve: { ...s.improve, probe_of: { improve: "CASE-9", origin: "x", probe: "base/T1", candidate: "base", task: "T1", plan_gate: "accept" as const, max_lookups: 10 } } };
  expect(panelOver(probe).querySelector(".known-answer-form")).toBeNull();
  const improve = { ...s, improve: { ...s.improve, request: { target: "investigation", case_type: "unknown-device", tasks: 1, candidates: 1, by: "analyst" } } };
  expect(panelOver(improve).querySelector(".known-answer-form")).toBeNull();
  expect(panelOver(s, "leader").querySelector(".known-answer-form")).toBeNull();
  expect(panelOver(s, "requester").querySelector(".known-answer-form")).toBeNull();
  // replaying the case: the controls are drawn as live, and every one is off
  const replayed = panelOver(s, "analyst", s.seq);
  expect([...replayed.querySelectorAll(".known-answer-form button, .known-answer-form textarea, .known-answer-form input, .known-answer-form select")].every((c) => (c as HTMLButtonElement).disabled)).toBe(true);
  q.store()!.goTo(s.seq);
  await settled(q);
  expect(q.all(".lens-narrative .known-answer-form").length).toBe(1);
  expect((q.q(".known-answer [aria-label='Known answer text']") as HTMLTextAreaElement).disabled).toBe(true);
});

test("saving sends set_known_answer with the product, the text, the rows and the marking", async () => {
  const q = await narrative({ publish: true });
  const sent = recording(q);
  form(q).open = true;
  const save = (): HTMLButtonElement => q.q(".known-answer [data-action=save-answer]") as HTMLButtonElement;
  expect(save().disabled).toBe(true);
  q.fill(field(q, "Known answer text"), "A printer on the guest network, set up by the help desk.");
  expect(save().disabled).toBe(false);
  q.fill(field(q, "Claim 1"), "the device is a printer");
  choose(q, "Likelihood 1", "very likely");
  choose(q, "Confidence 1", "high");
  q.click(".known-answer [data-action=add-finding]");
  q.fill(field(q, "Claim 2"), "the help desk set it up");
  choose(q, "Likelihood 2", "likely");
  choose(q, "Confidence 2", "low");
  q.click(".known-answer [data-action=add-finding]");          // a third row left empty is not sent
  choose(q, "Answer marking", "TLP:AMBER");
  q.click(save());
  await settled(q);
  expect(sent.map((s) => [s[0], s[1]])).toEqual([["set_known_answer", {
    product: 1, text: "A printer on the guest network, set up by the help desk.",
    findings: [{ claim: "the device is a printer", likelihood: "very likely", confidence: "high" }, { claim: "the help desk set it up", likelihood: "likely", confidence: "low" }],
    marking: "TLP:AMBER",
  }]]);
  expect(state(q).answers["1"]).toMatchObject({ product: 1, marking: "TLP:AMBER", by: q.s.config.user });
  expect(q.q(".known-answer .known-answer-text").textContent).toBe("A printer on the guest network, set up by the help desk.");
  expect(q.all(".known-answer .known-answer-findings li").map((li) => li.textContent)).toEqual(["the device is a printer · very likely · high confidence", "the help desk set it up · likely · low confidence"]);
  // at most twelve rows
  form(q).open = true;
  for (let i = 0; i < 15; i++) { const b = q.q(".known-answer [data-action=add-finding]") as HTMLButtonElement; if (!b.disabled) q.click(b); }
  expect(q.all(".known-answer .answer-row").length).toBe(12);
  expect((q.q(".known-answer [data-action=add-finding]") as HTMLButtonElement).disabled).toBe(true);
  // the likelihood terms are the standard's, least likely first
  expect([...field<HTMLSelectElement>(q, "Likelihood 1").options].map((o) => o.value)).toEqual(q.ui.ref.likelihood);
});

test("the marking offered is never below the product's", async () => {
  const q = await narrative({ publish: true, marking: "TLP:AMBER" });
  const offered = (): string[] => [...field<HTMLSelectElement>(q, "Answer marking").options].map((o) => o.value);
  expect(offered()).toEqual(["TLP:AMBER", "TLP:AMBER+STRICT", "TLP:RED"]);
  expect(field<HTMLSelectElement>(q, "Answer marking").value).toBe("TLP:AMBER");
  // a product marked more strictly than its case: the floor is the product's
  const s = state(q);
  const drafts = s.drafts.map((d) => ({ ...d, product: { ...d.product, marking: "TLP:AMBER+STRICT" as const } }));
  const el = panelOver({ ...s, drafts });
  expect([...(el.querySelector("[aria-label='Answer marking']") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["TLP:AMBER+STRICT", "TLP:RED"]);
});

test("a saved answer is drawn as text: markup in it is not an element", async () => {
  const q = await narrative({ publish: true });
  const text = `<img src=x onerror="alert(1)"><b>bold</b>`;
  const r = await q.s.command("CASE-1", "set_known_answer", { product: 1, text, findings: [{ claim: "<script>x()</script>", likelihood: "likely", confidence: "moderate" }], marking: "TLP:GREEN" });
  expect(r.status).toBe(200);
  await settled(q);
  const box = q.q(".known-answer .known-answer-saved");
  expect(box.querySelector(".known-answer-text")!.textContent).toBe(text);
  expect(box.querySelector("img, b, script")).toBeNull();
  expect(box.querySelector(".known-answer-findings li")!.textContent).toBe("<script>x()</script> · likely · moderate confidence");
  const known = state(q).answers["1"]!;
  expect(box.querySelector(".known-answer-by")!.textContent).toBe(`Set by ${known.by} at ${known.ts}`);
  expect(box.querySelector(".known-answer-by time")!.getAttribute("datetime")).toBe(known.ts);
  // the form opens on what was saved
  expect(form(q).querySelector("summary")!.textContent).toBe("Change the known answer");
  expect(field<HTMLTextAreaElement>(q, "Known answer text").value).toBe(text);
  expect(field(q, "Claim 1").value).toBe("<script>x()</script>");
});

test("Withdraw asks for a reason and sends withdraw_known_answer", async () => {
  const q = await narrative({ publish: true });
  expect(q.all(".known-answer [data-action=withdraw-answer]").length).toBe(0);
  await q.s.command("CASE-1", "set_known_answer", { product: 1, text: "A printer.", findings: [], marking: "TLP:GREEN" });
  await settled(q);
  const sent = recording(q);
  const withdraw = (): HTMLButtonElement => q.q(".known-answer [data-action=withdraw-answer]") as HTMLButtonElement;
  expect(withdraw().disabled).toBe(true);
  q.fill(field(q, "Reason to withdraw"), "   ");
  expect(withdraw().disabled).toBe(true);
  q.fill(field(q, "Reason to withdraw"), "the help desk was wrong about it");
  expect(withdraw().disabled).toBe(false);
  q.click(withdraw());
  await settled(q);
  expect(sent.map((s) => [s[0], s[1]])).toEqual([["withdraw_known_answer", { product: 1, reason: "the help desk was wrong about it" }]]);
  expect(state(q).answers).toEqual({});
  expect(q.all(".known-answer .known-answer-saved").length).toBe(0);
  expect(form(q).querySelector("summary")!.textContent).toBe("Set the known answer");
});

test("a refusal of the answer is shown beside Save and what was typed stays", async () => {
  const q = await narrative({ publish: true });
  form(q).open = true;
  q.fill(field(q, "Known answer text"), "x".repeat(10));
  q.fill(field(q, "Claim 1"), "y");
  q.ui.send = async (_c, _a, _r, _f, refused) => { refused?.("a known answer is marked at least as strictly as its case"); return null; };
  q.click(".known-answer [data-action=save-answer]");
  await settled(q);
  expect(q.q(".known-answer .save-row .refusal").textContent).toBe("Refused: a known answer is marked at least as strictly as its case");
  expect(field<HTMLTextAreaElement>(q, "Known answer text").value).toBe("x".repeat(10));
  expect(state(q).answers).toEqual({});
});

test("no element here is made by innerHTML and none has an inline style", () => {
  for (const file of ["panels/answer.ts", "views/loop.ts"]) {
    const src = readFileSync(join(import.meta.dir, "../../src/web", file), "utf8");
    expect([file, src]).not.toEqual([file, expect.stringMatching(/innerHTML|outerHTML|insertAdjacentHTML|createElement|setAttribute|\.style\b|cssText/)]);
  }
});

test("each expected finding has a checkbox, theirs to say (credit for asking): a checked row is sent with asks: true, an unchecked one without the key, and the saved list says so", async () => {
  const q = await narrative({ publish: true });
  const sent = recording(q);
  form(q).open = true;
  q.fill(field(q, "Known answer text"), "A printer the owner brought in.");
  q.fill(field(q, "Claim 1"), "the device belongs to the owner");
  const box = field(q, "Theirs to say 1");
  expect(box.type).toBe("checkbox");
  expect(box.checked).toBe(false);
  expect(box.closest("label")!.textContent).toBe("theirs to say (credit for asking)");
  q.click(box);
  expect(box.checked).toBe(true);
  q.click(".known-answer [data-action=add-finding]");
  q.fill(field(q, "Claim 2"), "the device is a printer");
  q.click(".known-answer [data-action=save-answer]");
  await settled(q);
  const findings = (sent[0]![1] as { findings: Record<string, unknown>[] }).findings;
  expect(findings[0]).toMatchObject({ claim: "the device belongs to the owner", asks: true });
  expect(Object.hasOwn(findings[1]!, "asks")).toBe(false);
  expect(state(q).answers["1"]!.findings[0]!.asks).toBe(true);
  expect(q.all(".known-answer .known-answer-findings li").map((li) => li.textContent)).toEqual([
    `the device belongs to the owner · ${findings[0]!.likelihood as string} · moderate confidence · theirs to say`, `the device is a printer · ${findings[1]!.likelihood as string} · moderate confidence`,
  ]);
  // the form filled again from the saved answer keeps the box checked
  form(q).open = true;
  expect(field(q, "Theirs to say 1").checked).toBe(true);
  expect(field(q, "Theirs to say 2").checked).toBe(false);
});
