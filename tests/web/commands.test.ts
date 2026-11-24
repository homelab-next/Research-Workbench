import { expect, test } from "bun:test";
import { parseCommand } from "../../src/web/commands";
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
