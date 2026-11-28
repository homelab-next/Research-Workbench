import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runUsage } from "../../src/core/state";
import type { Actor, Entry, Marking, Payloads } from "../../src/core/types";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";
import { startModelStandin } from "../helpers/model-standin";
import { improveCase } from "../helpers/improve-run";
import { withImproveLoop } from "../helpers/served";

let p: Page;
let standin: { url: string; stop(): void } | undefined;
afterEach(async () => {
  standin?.stop();
  standin = undefined;
  try { expect(p.s.app.hub.read("CASE-1").state.skipped).toEqual([]); } finally { await p.close(); }
});

const state = () => p.s.app.hub.read("CASE-1").state;
const session = () => p.s.app.hub.read("CASE-1");
const types = (): string[] => p.s.entries("CASE-1").map((e) => e.type);
const sys: Actor = { kind: "system", id: "test" };
const agent: Actor = { kind: "agent", id: "researcher-g1", stage: "assemble", profile: "investigation", model: "m", effort: null, where: "machine" };
const settled = async (): Promise<void> => { await p.settle(); await p.settle(); await p.settle(); };
/** Waits (a few turns of the event loop) until `ok()` holds. */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !ok(); i++) await p.settle();
}
/** Waits until the model list has come in: a real option reads "<model> · <where>". */
const modelsIn = (stage = "frame") => until(() => p.all(`[data-stage=${stage}] select[aria-label=Model] option`).some((o) => o.textContent!.includes(" · ")));
/** Chooses an option of a select as a person does: the value, then a change event. */
function choose(selector: string, value: string): void {
  const sel = p.q(selector) as HTMLSelectElement;
  sel.value = value;
  sel.dispatchEvent(new p.win.Event("change", { bubbles: true }) as unknown as Event);
}
const row = (stage: string) => `.lens-pipeline .stage-row[data-stage=${stage}]`;

/** Opens a stage row as a person does: the details open and fire their toggle. */
function openRow(stage: string): void {
  (p.q(row(stage)) as HTMLDetailsElement).open = true;
  p.q(row(stage)).dispatchEvent(new p.win.Event("toggle") as unknown as Event);
}
const openAll = (): void => { for (const r of p.all(".lens-pipeline .stage-row")) openRow(r.dataset.stage!); };

/** A page on the sample case with the run at the plan gate and the Pipeline lens open, every stage row open unless `closed`. */
async function atPlanGate(opts: { marking?: Marking; before?: (root: string) => void; closed?: boolean } = {}): Promise<Page> {
  p = await page(opts.before === undefined ? {} : { before: opts.before });
  const id = await p.s.newCase(opts.marking === undefined ? {} : { marking: opts.marking });
  await p.s.toPlanGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("q");
  if (opts.closed !== true) openAll();
  return p;
}
/** The same, run on to the publish gate. */
async function atPublishGate(): Promise<Page> {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPublishGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("q");
  openAll();
  return p;
}
const blob = (text: string) => session().blobs.put(text);
/** A model turn written straight into the ledger, in `stage`, as the loop would have. */
function turn(stage: string, over: { left_out?: Payloads["model.request"]["left_out"]; reply?: string; reasoning?: string; messages?: string } = {}): void {
  const s = session();
  const messages = blob(over.messages ?? JSON.stringify({ messages: [{ role: "system", content: "rules <i>here</i>" }, { role: "user", content: "do the task" }] }));
  const reply = over.reply === undefined ? null : blob(over.reply);
  const reasoning = over.reasoning === undefined ? null : blob(over.reasoning);
  const link = { run: s.state.run.id, stage };
  const who = { ...agent, stage };
  const item = (id: string, fixed: boolean) => ({ kind: "card", id, title: `Card ${id}`, hash: "b".repeat(64), chars: 1500, fixed });
  s.commit((_st, ids) => {
    const request = ids.next("request");
    const out: Parameters<typeof s.commit>[0] extends (a: never, b: never) => (infer R)[] ? R[] : never = [{
      type: "model.request", actor: who, ...link,
      payload: { request, provider: "scripted", model: "sample-run", effort: null, where: "machine", marking: "TLP:GREEN", pack: [item("c1", true), item("c2", false)], left_out: over.left_out ?? [], messages, tools: [] },
    }];
    if (reply !== null) out.push({ type: "model.response", actor: who, ...link, payload: { request, response: reply, stop: "end", usage: { input: 5, output: 7, reasoning: 0 }, served_by: "sample-run", reasoning } });
    return out;
  });
}

test("Q opens the lens with one row per stage and its state in words", async () => {
  await atPublishGate();
  const ids = state().run.stages.map((s) => s.id);
  expect(p.all(".lens-pipeline .stage-row").map((r) => r.dataset.stage)).toEqual(ids);
  expect(p.q(`${row("frame")} summary`).textContent).toContain("Frame");
  expect(p.q(`${row("frame")} summary .mark`).textContent).toBe("passed");
  expect(p.q(`${row("publish")} summary .mark`).textContent).toBe("waiting");
  expect(p.q(`${row("feedback")} summary .mark`).textContent).toBe("not started");
  expect(p.q(`${row("assemble")} summary .attempts`).textContent).toBe("2 attempts");
  expect(p.q(`${row("frame")} summary .attempts`).textContent).toBe("1 attempt");
  expect(p.q(`${row("checks")} .runs`).textContent).toBe("runs a script");
  expect(p.q(`${row("feedback")} .runs`).textContent).toBe("waits for you");
});

test("clicking a stage in the phase strip opens the lens at that stage", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  expect(p.all(".lens-pipeline").length).toBe(0);
  p.click(".stage-button[data-stage=research]");
  expect(p.all(".lens-pipeline").length).toBe(1);
  expect((p.q(row("research")) as HTMLDetailsElement).open).toBe(true);
  expect((p.q(row("frame")) as HTMLDetailsElement).open).toBe(false);
});

test("the run line says the run's status, its model use and its budget", async () => {
  await atPublishGate();
  const u = runUsage(state());
  expect(p.q(".lens-pipeline .run-status").textContent).toBe("waiting at the publish gate");
  expect(p.q(".lens-pipeline .model-use").textContent).toBe(`model use: ${u.usage.input} in · ${u.usage.output} out · ${u.usage.reasoning} reasoning · ${u.model_calls} calls`);
  expect(p.q(".lens-pipeline .budget-now").textContent).toBe("No budget");
  p.fill("[aria-label='Run budget, in tokens']", "9000");
  p.click("[data-action=set-budget]");
  await settled();
  expect(state().run.budget_tokens).toBe(9000);
  expect(p.q(".lens-pipeline .budget-now").textContent).toBe("Budget: 9000 tokens");
  p.click("[data-action=no-budget]");
  await settled();
  expect(state().run.budget_tokens).toBeNull();
  expect(types().filter((t) => t === "budget.set").length).toBe(2);
});

test("the model list marks a model the case's marking may not go to as disabled, with the reason", async () => {
  standin = startModelStandin({ models: [{ id: "big-hosted" }], replies: [] });
  const url = standin;
  await atPlanGate({
    marking: "TLP:RED",
    before: (root) => writeFileSync(join(root, "models", "cloud.yaml"), `kind: model\nid: cloud\ntitle: cloud\nprovider: local\nwhere: hosted\nbase_url: ${url.url}\n`),
  });
  await modelsIn();
  await until(() => p.all("[data-stage=frame] select[aria-label=Model] option").some((o) => o.textContent!.startsWith("big-hosted")));
  const opt = p.q("[data-stage=frame] select[aria-label=Model] option[disabled]");
  expect(opt.textContent).toEndWith("(not allowed: TLP:RED may not go to a hosted model)");
  expect(opt.textContent).toStartWith("big-hosted · hosted");
  const allowed = p.all("[data-stage=frame] select[aria-label=Model] option:not([disabled])").map((o) => o.textContent);
  expect(allowed).toContain("sample-run · this machine");
  // the recorded setting is the one shown
  expect((p.q("[data-stage=frame] select[aria-label=Model]") as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("sample-run · this machine");
});

test("choosing a model writes stage.model_set, and effort is disabled for a model without one", async () => {
  standin = startModelStandin({ models: [{ id: "fast" }], replies: [] });
  const url = standin;
  await atPlanGate({ before: (root) => writeFileSync(join(root, "models", "near.yaml"), `kind: model\nid: near\ntitle: near\nprovider: local\nwhere: machine\nbase_url: ${url.url}\nefforts: [low, high]\n`) });
  await until(() => p.all("[data-stage=frame] select[aria-label=Model] option").some((o) => o.textContent!.startsWith("fast")));
  const effort = () => p.q("[data-stage=frame] select[aria-label=Effort]") as HTMLSelectElement;
  expect(effort().disabled).toBe(true);
  expect(effort().textContent).toBe("no effort setting");
  const mine = p.all("[data-stage=frame] select[aria-label=Model] option").find((o) => o.textContent!.startsWith("fast · "))!;
  const before = types().length;
  choose("[data-stage=frame] select[aria-label=Model]", (mine as HTMLOptionElement).value);
  // the recorded setting is shown only once the entry arrives
  expect(types().length).toBe(before);
  expect((p.q("[data-stage=frame] select[aria-label=Model]") as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("sample-run · this machine");
  await settled();
  expect(state().stage_models.frame).toEqual({ provider: "near", model: "fast", effort: null });
  expect(state().run.stages.find((s) => s.id === "frame")!.model).toEqual({ provider: "near", model: "fast", effort: null });
  expect((p.q("[data-stage=frame] select[aria-label=Model]") as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("fast · this machine");
  expect(effort().disabled).toBe(false);
  expect([...effort().options].map((o) => o.textContent)).toEqual(["Model default", "low", "high"]);
  choose("[data-stage=frame] select[aria-label=Effort]", "high");
  await settled();
  expect(state().stage_models.frame).toEqual({ provider: "near", model: "fast", effort: "high" });
  expect(effort().value).toBe("high");
  expect(p.q(`${row("frame")} .runs`).textContent).toContain("near");
});

test("a refused model change leaves the recorded setting showing and tells the person", async () => {
  await atPlanGate();
  await modelsIn();
  p.ui.api.command = async () => ({ ok: false, refused: ["no provider lists that model"] });
  choose("[data-stage=frame] select[aria-label=Model]", (p.q("[data-stage=frame] select[aria-label=Model] option") as HTMLOptionElement).value);
  await settled();
  expect(p.toasts()).toContain("no provider lists that model");
  expect((p.q("[data-stage=frame] select[aria-label=Model]") as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("sample-run · this machine");
});

test("in replay every control is disabled", async () => {
  await atPlanGate();
  await modelsIn();
  expect((p.q("[data-stage=frame] select[aria-label=Model]") as HTMLSelectElement).disabled).toBe(false);
  p.store()!.goTo(p.store()!.live.seq - 1);
  await settled();
  // reading the recorded text changes nothing, so Show stays available
  const controls = p.all(".lens-pipeline select, .lens-pipeline input, .lens-pipeline button:not([data-action=show])");
  expect(controls.length).toBeGreaterThan(3);
  for (const c of controls) expect((c as HTMLInputElement).disabled).toBe(true);
});

test("the context a stage was given is shown as chips with its size, and what was left out is named", async () => {
  await atPlanGate();
  turn("assemble", { left_out: [{ kind: "card", id: "c9", title: "Card c9", hash: "c".repeat(64), chars: 900, fixed: false }, { kind: "card", id: "c8", title: "Card c8", hash: "c".repeat(64), chars: 900, fixed: false }] });
  await settled();
  const chips = p.all(`${row("assemble")} .context .chip`).map((c) => c.textContent);
  expect(chips).toEqual(["card Card c1 fixed", "card Card c2"]);
  expect(p.q(`${row("assemble")} .context .context-size`).textContent).toBe("3k chars");
  const left = p.q(`${row("assemble")} .context .left-out`);
  expect(left.textContent).toBe("Left out: card c9, card c8");
  expect(left.classList.contains("attention")).toBe(true);
  // a stage with nothing yet has no context
  expect(p.all(`${row("evaluate")} .context .chip`).length).toBe(0);
  expect(p.q(`${row("evaluate")} .context`).textContent).toContain("no model turn yet");
});

test("Show fetches the transcript and renders it as text", async () => {
  await atPlanGate();
  turn("assemble", { reply: "<b>bold</b>", messages: JSON.stringify({ messages: [{ role: "system", content: "rules <i>here</i>" }, { role: "user", content: "do the task" }] }) });
  await settled();
  const head = p.q(`${row("assemble")} .turn`);
  expect(head.textContent).toContain("researcher-g1");
  expect(head.textContent).toContain("sample-run");
  expect(head.textContent).toContain("this machine");
  expect(head.textContent).toContain("TLP:GREEN");
  expect(head.textContent).toContain("answered");
  expect(p.all(`${row("assemble")} .transcript pre`).length).toBe(0);
  p.click(`${row("assemble")} .transcript [data-action=show]`);
  await until(() => p.all(`${row("assemble")} .transcript pre`).length >= 3);
  const text = p.q(`${row("assemble")} .transcript`);
  expect(text.querySelectorAll("b").length).toBe(0);
  expect(text.querySelectorAll("i").length).toBe(0);
  expect(text.textContent).toContain("<b>bold</b>");
  expect(text.textContent).toContain("rules <i>here</i>");
  expect(p.all(`${row("assemble")} .transcript .role`).map((r) => r.textContent)).toEqual(["system", "user", "reply"]);
  const raw = p.all(`${row("assemble")} .transcript a`).map((a) => a.textContent);
  expect(raw).toEqual(["raw bytes", "raw bytes"]);
  expect(p.q(`${row("assemble")} .transcript a`).getAttribute("href")).toMatch(/^\/api\/cases\/CASE-1\/blobs\/[0-9a-f]{64}$/);
  // pack parts are labelled by title and marking; a part left out reads "left out" with no content
  // the ledger records one marking for the pack, so it is shown once on the turn, and a part shows its title only
  expect(p.q(`${row("assemble")} .transcript .parts`).textContent).toContain("Card c1");
  expect(p.q(`${row("assemble")} .transcript .parts`).textContent).not.toContain("TLP");
  expect(p.q(`${row("assemble")} .turn-head .marking`).textContent).toBe("TLP:GREEN");
  // it keeps showing after other entries arrive
  session().commit(() => [{ type: "run.paused", actor: sys, payload: { reason: "later" } }]);
  await settled();
  expect(p.q(`${row("assemble")} .transcript`).textContent).toContain("<b>bold</b>");
});

test("a part the marking rule left out is shown as left out, with no content", async () => {
  await atPlanGate();
  turn("assemble", { left_out: [{ kind: "card", id: "c9", title: "Card c9", hash: "c".repeat(64), chars: 900, fixed: false }], reply: "ok" });
  await settled();
  const parts = p.q(`${row("assemble")} .transcript .parts`);
  const out = parts.querySelector(".part.left-out")!;
  expect(out.textContent).toBe("left out");
  expect(out.querySelector("pre")).toBeNull();
  // what the rule withheld is not named in the transcript at all
  expect(p.q(`${row("assemble")} .transcript`).textContent).not.toContain("Card c9");
});

test("reasoning is labelled as stated by the agent", async () => {
  await atPlanGate();
  turn("assemble", { reply: "answer", reasoning: "I looked at <u>c1</u>" });
  await settled();
  p.click(`${row("assemble")} .transcript [data-action=show]`);
  await until(() => p.all(`${row("assemble")} .transcript .reasoning pre`).length > 0);
  const r = p.q(`${row("assemble")} .transcript .reasoning`);
  expect(r.querySelector(".label")!.textContent).toBe("reasoning as stated by the agent");
  expect(r.querySelector("pre")!.textContent).toBe("I looked at <u>c1</u>");
  expect(r.querySelectorAll("u").length).toBe(0);
});

test("a tool call shows its why as the agent's own account, then how it ended", async () => {
  await atPublishGate();
  const first = p.q(`${row("research")} .tool-call`);
  expect(first.querySelector(".tool")!.textContent).not.toBe("");
  expect(first.querySelector(".why")!.textContent).toMatch(/^why \(the agent's own account\): .+/);
  expect(first.querySelector(".outcome")!.textContent).toMatch(/^(ok|failed)/);
  const entry = p.s.entries("CASE-1").find((e) => e.type === "tool.called" && e.stage === "research") as Extract<Entry, { type: "tool.called" }>;
  expect(p.q(`${row("research")} .tool-call[data-call=${entry.payload.call}] .why`).textContent).toContain(entry.payload.why);
});

test("a call with no return reads interrupted, or pending while the run is live", async () => {
  await atPlanGate();
  const s = session();
  s.commit((_st, ids) => {
    const request = ids.next("request");
    const call = ids.next("call");
    return [
      { type: "model.request", actor: agent, run: s.state.run.id, stage: "assemble", payload: { request, provider: "scripted", model: "sample-run", effort: null, where: "machine", marking: "TLP:GREEN", pack: [], left_out: [], messages: s.blobs.put("{}"), tools: [] } },
      { type: "tool.called", actor: agent, run: s.state.run.id, stage: "assemble", payload: { request, call, tool: "list_cards", args: {}, why: "see the cards" } },
    ];
  });
  await settled();
  expect(p.q(`${row("assemble")} .turn .outcome`).textContent).toBe("pending");
  expect(p.q(`${row("assemble")} .tool-call .outcome`).textContent).toBe("pending");
  s.commit(() => [{ type: "run.interrupted", actor: sys, payload: {} }]);
  await settled();
  expect(p.q(`${row("assemble")} .turn .outcome`).textContent).toBe("interrupted");
  expect(p.q(`${row("assemble")} .tool-call .outcome`).textContent).toBe("interrupted");
});

test("the send-back limit comes from the server's reference, and a count above it is shown as it is", async () => {
  await atPublishGate();
  expect(p.ui.ref.send_back_cap).toBe(3);
  p.ui.ref.send_back_cap = 2;
  p.press("Escape");
  p.press("q");
  openAll();
  expect(p.q(`${row("assemble")} .sendbacks .sendback`).textContent).toContain("(1 of 2)");
  const s = session();
  s.commit((st) => [{ type: "stage.sent_back", actor: sys, run: st.run.id, stage: "assemble", payload: { from: "checks", to: "assemble", reason: "again", count: 4 } }]);
  await settled();
  expect(p.all(`${row("assemble")} .sendbacks .sendback`).map((e) => e.textContent).join("|")).toContain("(4 of 2)");
});

test("a send-back is listed with its reason and count", async () => {
  await atPublishGate();
  const sent = p.q(`${row("assemble")} .sendbacks .sendback`);
  expect(sent.textContent).toMatch(/^checks → assemble \(1 of 3\): confidence-and-likelihood failed/);
  expect(sent.querySelector("time")).not.toBeNull();
  expect(p.q(`${row("checks")} .sendbacks .sendback`).textContent).toContain("checks → assemble (1 of 3)");
  expect(p.all(`${row("frame")} .sendbacks .sendback`).length).toBe(0);
});

test("a declined stage says so in amber and offers Resume", async () => {
  await atPlanGate();
  session().commit((s) => [{ type: "stage.finished", actor: sys, run: s.run.id, payload: { stage: "research", attempt: 1, outcome: "declined", draft_hash: null, output: null, reason: "the model would not answer" } }]);
  await settled();
  expect(p.q(`${row("research")} summary .mark`).textContent).toBe("declined");
  const line = p.q(`${row("research")} .declined`);
  expect(line.classList.contains("attention")).toBe(true);
  expect(line.textContent).toContain("The model declined: the model would not answer");
  expect(line.textContent).toContain("Choose another model above, then resume");
  expect(p.q(`${row("research")} summary .last-reason`).textContent).toBe("the model would not answer");
  const sent: string[] = [];
  p.ui.api.command = async (_id, name) => { sent.push(name); return { ok: true, seq: 1 }; };
  p.click(`${row("research")} .declined [data-action=resume]`);
  await settled();
  expect(sent).toEqual(["resume"]);
});

test("a blocked stage offers the pack limit and Resume", async () => {
  await atPlanGate();
  session().commit((s) => [
    { type: "model.blocked", actor: sys, run: s.run.id, stage: "research", payload: { stage: "research", marking: "TLP:RED", model: "sample-run", where: "hosted" } },
    { type: "run.paused", actor: sys, run: s.run.id, payload: { reason: "research was blocked: TLP:RED may not go to a hosted model" } },
  ]);
  await settled();
  expect(p.q(`${row("research")} summary .mark`).textContent).toBe("blocked");
  expect(p.q(`${row("research")} .blocked .pause-reason`).textContent).toBe("research was blocked: TLP:RED may not go to a hosted model");
  const limit = p.q(`${row("research")} select[aria-label='Strictest marking this stage may be given']`) as HTMLSelectElement;
  expect([...limit.options].map((o) => o.textContent)).toEqual(["No limit", ...p.ui.me.markings]);
  expect(limit.value).toBe("");
  choose(`${row("research")} select[aria-label='Strictest marking this stage may be given']`, "TLP:AMBER");
  await settled();
  expect(state().pack_limits.research).toBe("TLP:AMBER");
  expect((p.q(`${row("research")} select[aria-label='Strictest marking this stage may be given']`) as HTMLSelectElement).value).toBe("TLP:AMBER");
  choose(`${row("research")} select[aria-label='Strictest marking this stage may be given']`, "");
  await settled();
  expect(state().pack_limits.research).toBeUndefined();
  expect(p.all(`${row("research")} .blocked [data-action=resume]`).length).toBe(1);
  // a stage that is not blocked has no such limit control
  expect(p.all(`${row("frame")} select[aria-label='Strictest marking this stage may be given']`).length).toBe(0);
});

test("after publishing, measures of performance are listed and a measure of effectiveness can be recorded", async () => {
  p = await page();
  const id = await p.s.newCase();
  await p.s.toPublishGate(id);
  expect((await p.s.command(id, "approve")).status).toBe(200);
  await p.s.app.hub.idle();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("q");
  openAll();
  const mops = p.all(`${row("feedback")} .feedback .mop`).map((m) => m.textContent);
  expect(mops.length).toBe(7);
  expect(mops.some((m) => m!.startsWith("Queries run: "))).toBe(true);
  expect(p.q(`${row("feedback")} .feedback .mop[data-measure=send_backs]`).textContent).toBe("Send-backs: 1 · times work was sent back to an earlier stage");
  expect(p.all(`${row("feedback")} .feedback .moe-form`).length).toBe(2);
  const record = p.q(`${row("feedback")} [data-measure=time_saved] [data-action=record]`) as HTMLButtonElement;
  expect(record.disabled).toBe(true);
  p.fill("[aria-label='Value for Hours saved against doing it by hand']", "3");
  p.fill("[aria-label='Note for Hours saved against doing it by hand']", "it took ten minutes");
  expect(record.disabled).toBe(false);
  p.click(record);
  await settled();
  expect(state().feedback.at(-1)).toEqual({ measure: "time_saved", kind: "moe", value: 3, note: "it took ten minutes" });
  expect(p.q(`${row("feedback")} .feedback .moe[data-measure=time_saved]`).textContent).toBe("Hours saved against doing it by hand: 3 · it took ten minutes");
  expect((p.q("[aria-label='Value for Hours saved against doing it by hand']") as HTMLInputElement).value).toBe("");
  // a value that is not a number is sent as the text typed
  p.fill("[aria-label='Value for The product answered the question']", "yes");
  p.click(`${row("feedback")} [data-measure=answered_the_question] [data-action=record]`);
  await settled();
  expect(state().feedback.at(-1)).toMatchObject({ measure: "answered_the_question", value: "yes", note: "" });
});

test("text typed into a feedback field survives other entries arriving", async () => {
  await atPlanGate();
  p.fill("[aria-label='Value for Hours saved against doing it by hand']", "7");
  session().commit(() => [{ type: "run.paused", actor: sys, payload: { reason: "later" } }]);
  await settled();
  expect((p.q("[aria-label='Value for Hours saved against doing it by hand']") as HTMLInputElement).value).toBe("7");
});

test("a new turn does not rebuild the turns already on screen, and a closed row paints only its summary", async () => {
  await atPlanGate({ closed: true });
  const s = session();
  for (let i = 0; i < 60; i++) turn("assemble", { reply: `answer ${i}` });
  await settled();
  // the row is closed: its summary is painted and nothing of its body
  expect(p.all(`${row("assemble")} .turn`).length).toBe(0);
  openRow("assemble");
  await settled();
  const before = p.all(`${row("assemble")} .turn`);
  expect(before.length).toBe(60);
  turn("assemble", { reply: "one more" });
  await settled();
  const after = p.all(`${row("assemble")} .turn`);
  expect(after.length).toBe(61);
  for (let i = 0; i < 60; i++) expect(after[i]).toBe(before[i]!);
  expect(s.state.skipped).toEqual([]);
});

test("an empty model list says so in words and the select is disabled", async () => {
  p = await page();
  p.ui.api.models = async () => [];
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("q");
  openAll();
  await settled();
  expect(p.q(`${row("frame")} .models-note`).textContent).toBe("No models could be listed");
  expect((p.q(`${row("frame")} select[aria-label=Model]`) as HTMLSelectElement).disabled).toBe(true);
});

test("a failed model list is asked for again when a stage row is opened", async () => {
  p = await page();
  let calls = 0;
  const real = p.ui.api.models;
  p.ui.api.models = async (id) => { calls++; if (calls <= 2) throw new Error("down"); return real(id); };
  const id = await p.s.newCase();
  await p.s.toPlanGate(id);
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.press("q");
  await settled();
  expect(calls).toBe(1);
  openRow("frame");
  await settled();
  expect(calls).toBe(2);
  expect(p.q(`${row("frame")} .models-note`).textContent).toBe("The model list could not be read");
  // closing and opening the row again asks again
  (p.q(row("frame")) as HTMLDetailsElement).open = false;
  openRow("frame");
  await modelsIn();
  expect(calls).toBe(3);
});

test("the pipeline lens names the third gate, and next at the adopt gate opens the Improve lens", async () => {
  p = await page({ before: withImproveLoop });
  const id = await improveCase(p.s);
  expect(id).toBe("CASE-1");
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  p.q(".workarea").focus();
  p.press("q");
  await settled();
  expect(p.q(".lens-pipeline .run-status").textContent).toBe("waiting at the adopt gate");
  expect(p.q(`${row("adopt")} .stage-gate`).textContent).toBe("adopt gate");
  expect(p.all(".lens-pipeline .stage-gate").map((g) => g.textContent)).toEqual(["adopt gate"]);
  // Shift+Enter takes the person to the Improve lens; it passes nothing
  const before = p.s.entries(id).length;
  p.q(".workarea").focus();
  p.press("Enter", { shift: true });
  await settled();
  expect(p.q(".lens-dock .lens-improve")).toBeDefined();
  expect(p.q(".lens-improve [data-part=adopt] [data-action=adopt-accept]")).toBeDefined();
  expect(p.s.entries(id).length).toBe(before);
  expect(state().run).toMatchObject({ status: "waiting", waiting: "adopt" });
});
