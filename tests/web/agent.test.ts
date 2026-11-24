import { afterEach, expect, test } from "bun:test";
import { latestDraft } from "../../src/core/state";
import type { Entry } from "../../src/core/types";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";

let p: Page;
afterEach(async () => {
  try { expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]); } finally { await p.close(); }
});

const settled = async (): Promise<void> => { await p.settle(); await p.settle(); await p.settle(); };
/** A page on the sample case at the publish gate with the Agent lens open. */
async function inLens(gate = true): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  if (gate) await p.s.toPublishGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("a");
  await settled();
  return p;
}
const state = () => p.s.app.hub.read("CASE-1").state;
const turns = (): HTMLElement[] => p.all(".lens-agent .turn");
const last = (sel: string): HTMLElement => p.q(`.lens-agent .turn:last-child ${sel}`);
const keydown = (el: Element, key: string, shiftKey = false): void => { el.dispatchEvent(new p.win.KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }) as unknown as Event); };
const entries = (): Entry[] => p.s.entries("CASE-1");

test("A opens the lens with the agent, the profile, tools: none and the loaded context as chips", async () => {
  await inLens();
  const head = p.q(".lens-agent .agent-head").textContent!;
  expect(head).toContain("agent: assistant · Profile: Investigation · serves Sample objective · tools: none");
  expect(p.q(".lens-agent .loaded").textContent).toMatch(/^Loaded for this turn \(\d+(\.\d)?k chars\):/);
  const chips = p.all(".lens-agent [data-part]").map((c) => c.dataset.part);
  expect(chips).toEqual(expect.arrayContaining(["rules:base-rules", "persona:assistant", "case:CASE-1"]));
  expect(p.q("[data-part='persona:assistant']").textContent).toContain("Assistant");
  expect(p.q(".lens-agent select[aria-label=Model]")).not.toBeNull();
  expect(p.q(".lens-agent select[aria-label=Effort]")).not.toBeNull();
  p.click("[data-part='persona:assistant'] .chip-pick");
  await settled();
  expect(p.q(".lens-agent .excerpt").textContent).toContain("You are the assistant");
});

test("the base rules and the case have no remove button; other chips do, and Restore brings them back", async () => {
  await inLens();
  expect(p.all("[data-part='rules:base-rules'] button[aria-label^='Leave out']")).toEqual([]);
  expect(p.all("[data-part='case:CASE-1'] button[aria-label^='Leave out']")).toEqual([]);
  expect(p.all("[data-action=restore]")).toEqual([]);
  p.click("button[aria-label='Leave out Assistant']");
  await settled();
  expect(p.all("[data-part='persona:assistant']")).toEqual([]);
  expect(p.q("[data-action=restore]").textContent).toBe("Restore 1 left out");
  p.click("[data-quick=weak]");
  await settled();
  const asked = entries().findLast((e) => e.type === "agent.asked")!;
  if (asked.type !== "agent.asked") throw new Error();
  expect(asked.payload.left_out).toEqual(["persona:assistant"]);
  p.click("[data-action=restore]");
  await settled();
  expect(p.q("[data-part='persona:assistant']")).not.toBeNull();
  expect(p.all("[data-action=restore]")).toEqual([]);
});

test("a skill, procedure or lesson can be added for the next turn", async () => {
  await inLens();
  const sel = p.q("select[aria-label='Add a skill, SOP or lesson']") as HTMLSelectElement;
  const options = [...sel.options].map((o) => o.value).filter((v) => v !== "");
  expect(options.length).toBeGreaterThan(0);
  sel.value = options[0]!;
  sel.dispatchEvent(new p.win.Event("change", { bubbles: true }) as unknown as Event);
  await settled();
  expect(p.q(`[data-part='${options[0]}']`)).not.toBeNull();
  p.click("[data-quick=synopsis]");
  await settled();
  const asked = entries().findLast((e) => e.type === "agent.asked")!;
  if (asked.type !== "agent.asked") throw new Error();
  expect(asked.payload.added).toEqual([options[0]!]);
});

test("a quick ask sends its question and the answer appears with citation chips", async () => {
  await inLens();
  p.click("[data-quick=synopsis]");
  await settled();
  expect(p.q(".turn:last-child .question").textContent).toBe("Give a synopsis of this case.");
  expect(p.q(".turn:last-child .answer [data-card-chip=c1]")).not.toBeNull();
  expect(p.q(".turn:last-child .answer").textContent).toContain("[c1]");
  expect(last(".byline").textContent).toMatch(/^your agent · Investigation profile · /);
  expect(last("details.turn-context summary").textContent).toBe("context");
  expect(last("details.turn-context").textContent).toContain("persona Assistant");
  expect(p.all("[data-quick]").map((b) => b.textContent)).toEqual(["Synopsis", "What next?", "Draft the response", "What's weak?"]);
});

test("each quick ask sends its fixed question", async () => {
  await inLens();
  const asks: string[] = [];
  for (const [key, question] of [["next", "What should be done next, and why?"], ["draft", "Draft the response to what was asked."]] as const) {
    p.click(`[data-quick=${key}]`);
    await settled();
    asks.push(state().conversation.at(-1)!.asked);
    expect(asks.at(-1)).toBe(question);
  }
  expect(p.q("[data-quick=weak]").textContent).toBe("What's weak?");
});

test("Enter sends the typed question and Shift+Enter is a new line", async () => {
  await inLens();
  const box = p.q("textarea[aria-label='Ask your agent']") as HTMLTextAreaElement;
  expect(box.getAttribute("placeholder")).toBe("ask your agent …");
  p.fill(box, "What is known?\nAnd what is not?");
  keydown(box, "Enter", true);
  await settled();
  expect(state().conversation).toEqual([]);
  keydown(box, "Enter");
  await settled();
  expect(state().conversation.at(-1)!.asked).toBe("What is known?\nAnd what is not?");
  expect(box.value).toBe("");
});

test("Propose as Summary puts a dashed proposal in the Narrative lens and leaves the draft alone", async () => {
  await inLens();
  p.click("[data-quick=synopsis]");
  await settled();
  const before = latestDraft(state())!;
  p.click(".turn:last-child [data-action=propose-summary]");
  await settled();
  expect(Object.values(state().proposals).at(-1)).toMatchObject({ kind: "narrative", section: "summary", status: "open" });
  expect(latestDraft(state())!.hash).toBe(before.hash);
  p.press("r");
  await settled();
  const proposal = p.q(".lens-narrative .proposal");
  expect(proposal.classList.contains("proposed")).toBe(true);
  expect(proposal.textContent).toContain("[c1]");
});

test("Keep as note makes a card in Incoming", async () => {
  await inLens();
  p.click("[data-quick=synopsis]");
  await settled();
  const incoming = state().incoming.length;
  p.click(".turn:last-child [data-action=keep-note]");
  await settled();
  expect(state().incoming.length).toBe(incoming + 1);
  const id = state().incoming.at(-1)!;
  expect(state().cards[id]).toMatchObject({ kind: "note", made_by: "agent", title: "Note: Give a synopsis of this case." });
  expect(p.q(`[data-card=${id}]`)).not.toBeNull();
});

test("free text in the command bar goes to the agent and does not leave the case", async () => {
  await inLens(false);
  p.press("Escape");
  await settled();
  const bar = p.q("[aria-label=Command]") as HTMLInputElement;
  p.fill(bar, "what do we know so far?");
  keydown(bar, "Enter");
  await settled();
  expect(p.win.location.hash).toBe("#/case/CASE-1");
  expect(p.q(".lens-agent")).not.toBeNull();
  expect(last(".question").textContent).toBe("what do we know so far?");
  expect(last(".answer").textContent).toContain("[c1]");
});

test("an answer holding markup is shown as text", async () => {
  await inLens();
  const provider = p.s.app.hub.deps.providers.get("scripted")!;
  const real = provider.turn.bind(provider);
  provider.turn = async (r) => { const out = await real(r); return out.kind === "answer" ? { ...out, content: "<script>alert(1)</script> <b>no</b>" } : out; };
  p.click("[data-quick=synopsis]");
  await settled();
  const answer = last(".answer");
  expect(answer.textContent).toContain("<script>alert(1)</script> <b>no</b>");
  expect(answer.querySelector("script")).toBeNull();
  expect(answer.querySelector("b")).toBeNull();
});

test("a declined, blocked or failed turn says so, and one that is pending says thinking", async () => {
  await inLens();
  const provider = p.s.app.hub.deps.providers.get("scripted")!;
  const real = provider.turn.bind(provider);
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  provider.turn = async (r) => { await gate; return { kind: "declined", reason: "not for this", served_by: "x", raw: new Uint8Array() }; };
  p.click("[data-quick=synopsis]");
  // the model is held, so the server is never idle: wait on the clock, not on it
  try {
    await new Promise((r) => setTimeout(r, 50));
    await p.win.happyDOM.waitUntilComplete();
    expect(last(".status").textContent).toBe("thinking…");
  } finally {
    open();
  }
  await settled();
  expect(last(".status").textContent).toBe("declined: not for this");
  provider.turn = async () => ({ kind: "error", message: "boom", raw: null });
  p.click("[data-quick=next]");
  await settled();
  expect(last(".status").textContent).toBe("failed: the model call failed");
  provider.turn = real;
  p.s.config.marking_policy["TLP:GREEN"] = [];
  p.click("[data-quick=weak]");
  await settled();
  expect(last(".status").textContent).toBe("blocked: the model may not receive TLP:GREEN");
  expect(turns().length).toBe(3);
  expect(p.all(".lens-agent [data-action=propose-summary]")).toEqual([]);
});

test("a turn whose request was left open is interrupted once a later turn has moved on", async () => {
  await inLens();
  const session = p.s.app.hub.read("CASE-1");
  const human = { kind: "human", id: "analyst" } as const;
  const agent = { kind: "agent", id: "assistant", stage: "agent", profile: "investigation", model: "sample-run", effort: null, where: "machine" } as const;
  let turn = "";
  session.commit((_s, ids) => { turn = ids.next("turn"); return [{ type: "agent.asked", actor: human, payload: { turn, text: "Left open", left_out: [], added: [] } }]; });
  session.commit((_s, ids) => [{ type: "model.request", actor: agent, payload: { request: ids.next("request"), provider: "scripted", model: "sample-run", effort: null, where: "machine", marking: "TLP:GREEN", pack: [], left_out: [], messages: session.blobs.put("{}"), tools: [] } }]);
  await settled();
  expect(last(".status").textContent).toBe("thinking…");
  session.commit((_s, ids) => [{ type: "agent.asked", actor: human, payload: { turn: ids.next("turn"), text: "Later", left_out: [], added: [] } }]);
  session.commit(() => [{ type: "model.blocked", actor: agent, payload: { stage: "agent", marking: "TLP:GREEN", model: "sample-run", where: "machine" } }]);
  await settled();
  expect(turns().at(-2)!.querySelector(".status")!.textContent).toBe("interrupted");
});

test("in replay asking is disabled", async () => {
  await inLens();
  p.click("[data-quick=synopsis]");
  await settled();
  p.store()!.goTo(3);
  await settled();
  expect((p.q("textarea[aria-label='Ask your agent']") as HTMLTextAreaElement).disabled).toBe(true);
  expect(p.all("[data-quick]").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  expect(p.all(".lens-agent .turn").length).toBe(0);
});
