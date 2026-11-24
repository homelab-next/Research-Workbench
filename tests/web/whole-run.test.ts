import { afterEach, expect, test } from "bun:test";
import { canonical } from "../../src/core/canonical";
import { verifyCase } from "../../src/core/verify";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";

let p: Page | null = null;
afterEach(async () => { await p?.close(); p = null; });

/** Waits (the server's own work, then the screen's) until `ok` holds; the message says what never happened. */
async function until(what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !ok(); i++) await p!.settle();
  if (!ok()) throw new Error(`never happened: ${what}`);
}
const flush = async (): Promise<void> => { await p!.settle(); await p!.settle(); await p!.settle(); };

/** Every button, input, select and textarea on screen has a name a person (or a screen reader) is given, and no two elements share an id. */
function assertAccessible(where: string): void {
  const bad: string[] = [];
  for (const el of p!.all("button, input, select, textarea")) {
    if ((el as HTMLInputElement).type === "hidden") continue;
    const labelled = el.id !== "" && p!.root.querySelector(`label[for="${el.id}"]`) !== null;
    const wrapped = el.closest("label") !== null && (el.closest("label")!.textContent ?? "").trim() !== "";
    const named = (el.textContent ?? "").trim() !== "" || (el.getAttribute("aria-label") ?? "").trim() !== "" || labelled || wrapped;
    if (!named) bad.push(`${el.tagName.toLowerCase()}${el.id !== "" ? `#${el.id}` : ""}.${el.className}`);
  }
  expect({ where, unnamed: bad }).toEqual({ where, unnamed: [] });
  const ids = p!.all("[id]").map((e) => e.id);
  expect({ where, duplicates: ids.filter((id, i) => ids.indexOf(id) !== i) }).toEqual({ where, duplicates: [] });
}

/** A key as a person gives it with focus on the page itself (nothing focused), not in a field or a button. */
function onPage(key: string, mods: { shift?: boolean } = {}): void {
  (p!.doc.activeElement as HTMLElement | null)?.blur();
  p!.press(key, mods);
}
const nameOf = (stage: string): string => p!.q(`.stage-button[data-stage=${stage}]`).textContent ?? "";

test("the whole sample investigation, driven through the interface alone", async () => {
  p = await page();
  await p.settle();

  // 1. Home -> Investigate -> + New investigation; the form, then Create and frame the run
  p.click("[data-mode=investigate]");
  expect(p.win.location.hash).toBe("#/investigate");
  p.click("[aria-label='New investigation']");
  expect(p.win.location.hash).toBe("#/investigate/new");
  p.fill("[aria-label=Title]", "Traffic to 198.51.100.77");
  p.fill("[aria-label='What was asked']", "Who is behind the traffic to 198.51.100.77?");
  p.fill("[aria-label=Why]", "an unknown address was contacted overnight");
  (p.q("[aria-label='Starting type 1']") as HTMLSelectElement).value = SAMPLE_START.type;
  p.fill("[aria-label='Starting value 1']", SAMPLE_START.value);
  p.fill("[aria-label='Window from']", SAMPLE_WINDOW.from ?? "");
  p.fill("[aria-label='Window to']", SAMPLE_WINDOW.to ?? "");
  (p.q("[aria-label=Objective]") as HTMLSelectElement).value = "sample-objective";
  (p.q("[aria-label=Marking]") as HTMLSelectElement).value = "TLP:GREEN";
  p.click(".primary");
  await until("the brief reaches the plan gate", () => p!.root.querySelector(".stage-button[data-stage=plan]")?.textContent?.includes("◌ waiting") === true);
  expect(p.win.location.hash).toBe("#/case/CASE-1");
  expect(nameOf("plan")).toContain("◌ waiting");
  assertAccessible("step 1: the plan gate");

  // 2. Shift+Enter opens Steps (one step is costly); Estimate s3; budget 1; Accept
  onPage("Enter", { shift: true });
  await flush();
  expect(p.q(".lens-steps .plan").classList.contains("proposed")).toBe(true);
  expect(p.q(".lens-steps .counts").textContent).toBe("2 free steps · 1 costly steps");
  const accept = (): HTMLButtonElement => p!.q("[data-action=accept_plan]") as HTMLButtonElement;
  expect(accept().disabled).toBe(true);
  p.click("[data-step=s3] [data-action=estimate]");
  await until("the estimate is on screen", () => p!.root.querySelector("[data-step=s3] .estimate") !== null);
  expect(p.q("[data-step=s3] .estimate").textContent).toBe("1 lookups");
  p.fill("[aria-label='Budget for s3, in lookups']", "1");
  expect(accept().disabled).toBe(false);
  expect(accept().textContent).toBe("Accept: run 3 steps");

  // 3. while research runs, the jobs indicator counts above zero at least once
  let most = 0;
  const watch = new p.win.MutationObserver(() => {
    const n = Number(/\((\d+)\)/.exec(p!.root.querySelector(".jobs")?.textContent ?? "")?.[1] ?? 0);
    if (n > most) most = n;
  });
  watch.observe(p.root as never, { subtree: true, childList: true, characterData: true });
  p.click(accept());
  await until("the run reaches the publish gate", () => p!.root.querySelector(".stage-button[data-stage=publish]")?.textContent?.includes("◌ waiting") === true);
  watch.disconnect();
  expect(most).toBeGreaterThan(0);

  // 4. triage at the publish gate: J, Space, U, Space, X, D, Restore
  assertAccessible("step 4: the publish gate");
  const incoming = (): string[] => p!.all("[data-area=incoming] [data-card]").map((e) => e.dataset.card!);
  const lanes = (): Record<string, string[]> => Object.fromEntries(p!.all(".lane").map((l) => [l.dataset.lane!, [...l.querySelectorAll<HTMLElement>("[data-card]")].map((c) => c.dataset.card!)]));
  p.q("[data-area=incoming]").focus();
  p.press("j");
  expect(p.q("[data-card=c1]").classList.contains("card")).toBe(true);
  expect(p.doc.activeElement).toBe(p.q("[data-card=c1]"));
  p.press(" ");
  await flush();
  expect(lanes().l1).toEqual(["c1"]);
  expect(incoming()).not.toContain("c1");
  p.press("u");
  await flush();
  expect(lanes().l1).toEqual([]);
  expect(incoming()).toContain("c1");
  p.press("k");
  expect(p.doc.activeElement).toBe(p.q("[data-card=c1]"));
  p.press(" ");
  await flush();
  expect(lanes().l1).toEqual(["c1"]);
  expect(p.doc.activeElement).toBe(p.q("[data-card=c2]"));
  p.press("x");
  await flush();
  expect(incoming()).not.toContain("c2");
  p.press("d");
  await flush();
  expect(p.q(".lens-discarded [data-about=c2]").textContent).toContain("Asset with the address");
  p.click(".lens-discarded [data-about=c2] [data-action=restore]");
  await flush();
  expect(incoming()).toContain("c2");
  expect(p.all(".lens-discarded [data-about]").length).toBe(0);

  // 5. open a card: its provenance shows the exact query; Verify; the card is tagged validated
  p.q("[data-card=c4]").focus();
  p.press("Enter");
  await flush();
  const c4 = p.q("[data-card=c4]");
  expect(c4.classList.contains("open")).toBe(true);
  const recorded = p.store()!.live.queries[p.store()!.live.cards.c4!.query!]!.text;
  expect(c4.querySelector(".provenance .query")!.textContent).toBe(recorded);
  p.click("[data-card=c4] [data-action=verify]");
  await until("c4 is validated", () => [...p!.root.querySelectorAll("[data-card=c4] .tag")].some((t) => (t.textContent ?? "").startsWith("validated")));
  expect(p.all("[data-card=c4] .tag").some((t) => (t.textContent ?? "").startsWith("validated"))).toBe(true);

  // 6. Q: the Research row lists its turns and tool calls; the send-back is listed with its reason
  onPage("q");
  await flush();
  for (const r of p.all(".lens-pipeline .stage-row")) { (r as HTMLDetailsElement).open = true; r.dispatchEvent(new p.win.Event("toggle") as unknown as Event); }
  await flush();
  const research = p.q(".lens-pipeline [data-stage=research]");
  const asked = p.store()!.entries.filter((e) => e.type === "model.request" && e.stage === "research").length;
  expect(asked).toBeGreaterThan(5);
  expect(research.querySelectorAll(".turn").length).toBe(asked);
  for (const tool of ["run_step", "run_pivot", "find_routes"]) expect(research.textContent).toContain(tool);
  const back = [...new Set(p.all(".lens-pipeline .sendback").map((e) => (e.textContent ?? "").replace(/ \d\d:\d\d$/, "")))];
  expect(back).toEqual(["checks → assemble (1 of 3): confidence-and-likelihood failed: f1: a sentence of the statement gives both a confidence level and a likelihood"]);

  // 7. A: the quick ask Synopsis is answered with a citation chip; Propose as Summary is dashed in Narrative; discard it
  onPage("a");
  await flush();
  p.click("[data-quick=synopsis]");
  await until("the synopsis is answered", () => p!.root.querySelector(".lens-agent .turn:last-child .answer [data-card-chip=c1]") !== null);
  p.click(".lens-agent .turn:last-child [data-action=propose-summary]");
  await until("the proposal exists", () => Object.values(p!.store()!.live.proposals).some((x) => x.kind === "narrative" && x.status === "open"));
  onPage("r");
  await flush();
  const proposal = p.q(".lens-narrative .proposal, .lens .proposal[data-proposal]");
  expect(proposal.classList.contains("proposed")).toBe(true);
  expect(proposal.textContent).toContain("Summary");
  p.click(`[data-proposal=${proposal.dataset.proposal}] [data-action=discard-proposal]`);
  await until("the proposal is discarded", () => p!.root.querySelector(".lens .proposal[data-proposal]") === null);
  expect(Object.values(p.store()!.live.proposals).filter((x) => x.kind === "narrative").map((x) => x.status)).toEqual(["rejected"]);

  // 8. R: eleven checks pass; the preview lists five files; Shift+Enter reaches Approve, which publishes
  expect(p.all(".review .check-row").length).toBe(11);
  expect(p.all(".review .check-row").every((r) => (r.textContent ?? "").startsWith("✓ "))).toBe(true);
  expect(p.all(".preview [data-tab]").length).toBe(5);
  assertAccessible("step 8: the review");
  const draft = p.store()!.live.drafts.at(-1)!;
  onPage("Enter", { shift: true });
  await flush();
  // the lens asks the server to check this exact draft first, then enables the button and puts the focus on it
  await until("the Approve button has the focus", () => (p!.doc.activeElement as HTMLElement | null)?.dataset?.action === "approve");
  const approve = p.doc.activeElement as HTMLButtonElement;
  expect(approve.textContent).toBe(`Approve: publish draft ${draft.n}`);
  expect(approve.disabled).toBe(false);
  p.click(approve);
  await until("the bundle is published", () => (p!.root.querySelector(".lens .draft-head")?.textContent ?? "").includes("Published as product 1"));

  // 9. the Pipeline lens's feedback row: answered_the_question is recorded as true
  onPage("q");
  await flush();
  const feedback = p.q(".lens-pipeline [data-stage=feedback]") as HTMLDetailsElement;
  feedback.open = true;
  feedback.dispatchEvent(new p.win.Event("toggle") as unknown as Event);
  await flush();
  p.fill("[aria-label='Value for The product answered the question']", "true");
  p.click("[data-measure=answered_the_question] [data-action=record]");
  await until("the feedback is recorded", () => p!.store()!.live.feedback.some((f) => f.measure === "answered_the_question" && f.kind === "moe"));
  expect(p.store()!.live.feedback.find((f) => f.measure === "answered_the_question")!.value).toBe("true");

  // 10. E: step back to where the plan was proposed; the banner shows, Incoming is empty and the lanes are gone; Live returns
  onPage("e");
  await flush();
  const proposed = p.store()!.entries.find((e) => e.type === "plan.proposed")!.seq;
  p.fill("[aria-label='Go to entry']", String(proposed));
  p.q("[aria-label='Go to entry']").dispatchEvent(new p.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
  await flush();
  expect(p.q(".replay-banner").textContent).toContain(`Replay · entry ${proposed} of ${p.store()!.live.seq} · read-only`);
  expect(incoming()).toEqual([]);
  expect(p.all(".lane").length).toBe(0);
  p.click(".lens-replay [aria-label=Live]");
  await flush();
  expect(p.root.querySelector(".replay-banner")).toBeNull();
  expect(p.store()!.at).toBeNull();
  expect(incoming().length).toBeGreaterThan(0);
  expect(p.all(".lane").length).toBeGreaterThan(0);

  // 12. the record: custody reads intact, the case verifies with its published bundle, nothing was skipped, the screen's state is the server's
  await until("the custody chip is current", () => /^chain intact · \d+ entries$/.test(p!.root.querySelector(".custody")?.textContent ?? ""));
  const session = p.s.app.hub.read("CASE-1");
  expect(p.q(".custody").textContent).toBe(`chain intact · ${session.head().seq} entries`);
  const verified = verifyCase(session.dir);
  expect(verified.ok).toBe(true);
  expect(verified.published.bundles.map((b) => b.state)).toEqual(["ok"]);
  expect(verified.published.unrecorded).toEqual([]);
  expect(session.state.skipped).toEqual([]);
  expect(p.store()!.live.skipped).toEqual([]);
  expect(canonical(p.store()!.live as never)).toBe(canonical(session.state as never));
});
