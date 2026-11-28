import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { page } from "../helpers/dom";
import type { Page } from "../helpers/dom";
import { parseCommand, perform } from "../../src/web/commands";
import type { Intent } from "../../src/web/commands";

const ctx = { cases: [{ id: "CASE-1", title: "Odd traffic" }, { id: "CASE-2", title: "Sign-in burst" }], in_case: true, cards: ["c1", "c12"] };
test.each<[string, Intent]>([
  ["CASE-2", { kind: "open_case", id: "CASE-2" }],
  ["open CASE-2", { kind: "open_case", id: "CASE-2" }],
  ["investigate case-1", { kind: "open_case", id: "CASE-1" }],
  ["investigate odd traffic", { kind: "open_case", id: "CASE-1" }],
  ["investigate", { kind: "go", to: "investigate" }],
  ["go to investigate", { kind: "go", to: "investigate" }],
  ["open investigate", { kind: "go", to: "investigate" }],
  ["go to home", { kind: "go", to: "home" }],
  ["home", { kind: "go", to: "home" }],
  ["open pipeline", { kind: "lens", id: "pipeline" }],
  ["go to jobs", { kind: "lens", id: "jobs" }],
  ["open graph", { kind: "lens", id: "graph" }],
  ["run", { kind: "run" }], ["Pause", { kind: "pause" }], ["accept plan", { kind: "accept_plan" }], ["approve", { kind: "approve" }],
  ["verify c12", { kind: "verify", card: "c12" }],
  ["verify c99", { kind: "say", text: "There is no card c99" }],
  ["replay", { kind: "replay", seq: null }], ["replay 137", { kind: "replay", seq: 137 }],
  ["summarize", { kind: "ask", text: "Give a synopsis of this case." }],
  ["what does investigate mean here?", { kind: "ask", text: "what does investigate mean here?" }],
  ["investigate why the host went quiet", { kind: "ask", text: "investigate why the host went quiet" }],
  ["open the pod bay doors", { kind: "ask", text: "open the pod bay doors" }],
  ["run the numbers again", { kind: "ask", text: "run the numbers again" }],
])("%s", (input, intent) => expect(parseCommand(input, ctx)).toEqual(intent));
test("outside a case a question does not go to the agent", () => expect(parseCommand("what is this?", { ...ctx, in_case: false })).toEqual({ kind: "say", text: "Open a case first: investigate CASE-1" }));
test("outside a case, a case command still opens the case and a run command asks for a case", () => {
  expect(parseCommand("investigate odd traffic", { ...ctx, in_case: false })).toEqual({ kind: "open_case", id: "CASE-1" });
  expect(parseCommand("run", { ...ctx, in_case: false })).toEqual({ kind: "say", text: "Open a case first: investigate CASE-1" });
});
test("a case that does not exist is said, not asked", () => expect(parseCommand("CASE-9", ctx)).toEqual({ kind: "say", text: "There is no case CASE-9" }));

test("run playbook <id> on <value> is one intent; outside a case it asks for a case", () => {
  expect(parseCommand("run playbook address-triage on 198.51.100.77", ctx)).toEqual({ kind: "playbook", id: "address-triage", value: "198.51.100.77" });
  expect(parseCommand("Run Playbook address-triage on Example.COM", ctx)).toEqual({ kind: "playbook", id: "address-triage", value: "Example.COM" });
  expect(parseCommand("run playbook address-triage on 198.51.100.77", { ...ctx, in_case: false })).toEqual({ kind: "say", text: "Open a case first: investigate CASE-1" });
});

let p: Page | null = null;
afterEach(async () => { await p?.close(); p = null; });
const performOn = async (q: Page, text: string) => {
  const opened: string[] = [];
  const intent = parseCommand(text, { cases: [], in_case: true, cards: [] });
  const out = await perform(intent, { ui: q.ui, nav: { openLens: (id: string) => { opened.push(id); } } as never, store: q.store() });
  return { out, opened };
};
test("perform: an unknown playbook is said; a playbook of two inputs is not started from the bar", async () => {
  p = await page({ before: (root) => writeFileSync(join(root, "playbooks", "two.yaml"), "kind: playbook\nid: two\ntitle: Two values\nabout: x\ninputs:\n  - { name: a, type: address }\n  - { name: b, type: domain }\nsteps:\n  - { id: s, pivot: address_to_domains, from: input.a }\nend: [s]\n") });
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  expect((await performOn(p, "run playbook nope on 198.51.100.77")).out).toEqual({ cleared: false, say: "There is no playbook nope" });
  expect((await performOn(p, "run playbook two on 198.51.100.77")).out).toEqual({ cleared: false, say: "Two values takes 2 values; start it from a card's Pivot panel" });
});
test("perform: a one-input playbook starts with the case window and opens the Jobs lens", async () => {
  p = await page();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  const { out, opened } = await performOn(p, "run playbook address-triage on 198.51.100.77");
  expect(out.cleared).toBe(true);
  expect(opened).toEqual(["jobs"]);
  const e = p.s.entries(id).find((x) => x.type === "playbook.started")!;
  expect(e.payload).toMatchObject({ playbook: "address-triage", inputs: [{ type: "address", value: "198.51.100.77" }], why: "run playbook address-triage on 198.51.100.77" });
  await p.s.app.hub.idle();
});

test("state <text> adds a statement, keeping the text's case; outside a case it says to open one", () => {
  expect(parseCommand("state The TV is in the lobby", ctx)).toEqual({ kind: "state", text: "The TV is in the lobby" });
  expect(parseCommand("  State   Two  spaces stay ", ctx)).toEqual({ kind: "state", text: "Two  spaces stay" });
  expect(parseCommand("state The TV is in the lobby", { ...ctx, in_case: false })).toEqual({ kind: "say", text: "Open a case first: investigate CASE-1" });
  expect(parseCommand("state", ctx)).toEqual({ kind: "ask", text: "state" });
  expect(parseCommand("statement of work", ctx)).toEqual({ kind: "ask", text: "statement of work" });
});
test("perform: state sends add_statement with basis unstated and clears the bar; a refusal leaves it", async () => {
  p = await page();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  const sent: unknown[][] = [];
  const real = p.ui.send;
  p.ui.send = async (...a) => { sent.push(a); return real(...a); };
  const { out } = await performOn(p, "state The TV is in the lobby");
  expect(out.cleared).toBe(true);
  expect(sent[0]!.slice(0, 2)).toEqual(["add_statement", { statement: "The TV is in the lobby", basis: "unstated" }]);
  await p.settle();
  expect(Object.values(p.s.app.hub.read(id).state.cards).filter((c) => c.person !== undefined).length).toBe(1);
  expect(p.s.app.hub.read(id).state.skipped).toEqual([]);
  // refused: the bar keeps the text and says why, in the server's words (slice 10)
  p.ui.send = async (_c, _a, _r, _f, refused) => { refused?.("a statement is at most 4000 characters"); return null; };
  expect((await performOn(p, "state again")).out).toEqual({ cleared: false, say: "Refused: a statement is at most 4000 characters" });
});

test("answer ask-1 <text> answers that question; overrule f1 opens the Narrative lens on that finding", () => {
  const inCase = ctx;
  expect(parseCommand("answer ask-1 In the lobby", inCase)).toEqual({ kind: "answer", question: "ask-1", text: "In the lobby" });
  expect(parseCommand("Answer  ASK-2   A TV is  expected ", inCase)).toEqual({ kind: "answer", question: "ask-2", text: "A TV is  expected" });
  expect(parseCommand("overrule f1", inCase)).toEqual({ kind: "overrule", finding: "f1" });
  expect(parseCommand("Overrule F2", inCase)).toEqual({ kind: "overrule", finding: "f2" });
  expect(parseCommand("answer ask-1 In the lobby", { ...ctx, in_case: false })).toEqual({ kind: "say", text: "Open a case first: investigate CASE-1" });
  expect(parseCommand("overrule f1", { ...ctx, in_case: false })).toEqual({ kind: "say", text: "Open a case first: investigate CASE-1" });
  expect(parseCommand("answer the question", inCase)).toEqual({ kind: "ask", text: "answer the question" });
  expect(parseCommand("overrule", inCase)).toEqual({ kind: "ask", text: "overrule" });
});
test("perform: answer sends answer_question with basis unstated; overrule opens the lens on the finding and says where to do it", async () => {
  p = await page();
  const id = await p.s.newCase();
  p.win.location.hash = `#/case/${id}`;
  await p.settle();
  const sent: unknown[][] = [];
  p.ui.send = async (...a) => { sent.push(a); return { ok: true, seq: 1 }; };
  expect((await performOn(p, "answer ask-1 In the lobby")).out).toEqual({ cleared: true });
  expect(sent[0]!.slice(0, 2)).toEqual(["answer_question", { question: "ask-1", answer: "In the lobby", basis: "unstated" }]);
  const opened: unknown[][] = [];
  const out = await perform(parseCommand("overrule f1", ctx), { ui: p.ui, nav: { openLens: (...a: unknown[]) => { opened.push(a); } } as never, store: p.store() });
  expect(out).toEqual({ cleared: false, say: "Overrule f1 from the Narrative lens" });
  expect(opened).toEqual([["narrative", "overrule:f1"]]);
});

test("store, unload and load CASE-3 parse to their intents; unload outside a case says to open one", () => {
  expect(parseCommand("store", ctx)).toEqual({ kind: "store" });
  expect(parseCommand("open store", { ...ctx, in_case: false })).toEqual({ kind: "store" });
  expect(parseCommand("case store", { ...ctx, in_case: false })).toEqual({ kind: "store" });
  expect(parseCommand("unload", ctx)).toEqual({ kind: "unload" });
  expect(parseCommand("Unload", { ...ctx, in_case: false })).toEqual({ kind: "say", text: "Open a case first: investigate CASE-1" });
  // a case that is not loaded is in the store: load names it whether or not the list has it
  expect(parseCommand("load CASE-3", { ...ctx, in_case: false })).toEqual({ kind: "load", id: "CASE-3" });
  expect(parseCommand("load case-3", ctx)).toEqual({ kind: "load", id: "CASE-3" });
  expect(parseCommand("load", ctx)).toEqual({ kind: "say", text: "Name the case to load, for example: load CASE-3" });
});

test("perform: store opens the view, unload unloads the case on screen and goes to the list, load CASE-1 loads the store's file and opens it", async () => {
  const q = await page(); p = q;
  const id = await q.s.newCase();
  q.win.location.hash = `#/case/${id}`; await q.settle();
  const env = (): Parameters<typeof perform>[1] => ({ ui: q.ui, nav: { go: (r: { screen: string }) => { q.win.location.hash = r.screen === "store" ? "#/investigate/store" : r.screen === "pick" ? "#/investigate" : `#/case/${(r as unknown as { id: string }).id}`; } } as never, store: q.store() });
  expect(await perform({ kind: "unload" }, env())).toEqual({ cleared: true });
  await q.settle();
  expect(q.win.location.hash).toBe("#/investigate");
  expect(q.toasts()).toContain("CASE-1 was unloaded to the case store");
  expect(await (await q.s.get("/api/cases")).json()).toEqual([]);
  expect(await perform({ kind: "load", id: "CASE-9" }, env())).toEqual({ cleared: false, say: "There is no CASE-9 in the case store" });
  expect(await perform({ kind: "load", id: "CASE-1" }, env())).toEqual({ cleared: true });
  await q.settle();
  expect(q.win.location.hash).toBe("#/case/CASE-1");
  expect(await perform({ kind: "load", id: "CASE-1" }, env())).toEqual({ cleared: false, say: "CASE-1 is loaded already" });
  expect(await perform({ kind: "store" }, env())).toEqual({ cleared: true });
  expect(q.win.location.hash).toBe("#/investigate/store");
});

