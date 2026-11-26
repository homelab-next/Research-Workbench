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
