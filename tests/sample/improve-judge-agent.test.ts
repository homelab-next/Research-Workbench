// Final review I1: a Judge stage that runs an agent is shown the known answers, so it may have no tool that writes what a later stage reads; and a
// Judge agent's run leaves no answer text in any later stage's request.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

const CANARY = "canary-judge-5e1d";
const TASKS = [
  { address: "192.0.2.14", text: "The workstation ws-14.example.net holds this address under its lease.", findings: [{ claim: "ws-14.example.net was the device holding 192.0.2.14 by lease", likelihood: "very likely", confidence: "moderate" }] },
  { address: "192.0.2.61", text: `${CANARY}: the workstation ws-17.example.net joined the WiFi at this address without a lease.`, findings: [{ claim: `the device at 192.0.2.61 was ${CANARY} by its WiFi connection message`, likelihood: "very likely", confidence: "moderate" }] },
];
const JUDGE_TOOLS = "a judge stage has no tools: it is shown the known answers, and nothing it is shown may reach a later stage";

let s: Served | undefined;
afterEach(async () => { const d = s?.dir; await s?.close(); s = undefined; if (d) rmSync(d, { recursive: true, force: true }); });

/** The sample's improve loop with its Judge running an agent with these tools, and the scripted turns it is given. */
const judgeAgent = (tools: string[], turns: string[]) => (root: string): void => {
  const loop = join(root, "loops", "improve.yaml");
  const was = readFileSync(loop, "utf8");
  const now = was.replace(/(  - id: judge\n    title: Judge\n    order: 5\n)    runs: script\n(    role: judge\n    gate: null\n    reviews: false\n)    tools: \[\]\n(    schema: judge-output\n)    model: null\n/,
    `$1    runs: agent\n$2    tools: [${tools.join(", ")}]\n$3    model: { provider: scripted, model: sample-improve, effort: null }\n`);
  if (now === was) throw new Error("the sample's improve loop changed: its judge stage was not rewritten");
  writeFileSync(loop, now);
  appendFileSync(join(root, "context", "improve-profile.yaml"), "  judge:\n    agent: judge\n    persona: composer\n    goal: Match the findings.\n");
  appendFileSync(join(root, "scripts", "sample-improve.yaml"), [...turns, ""].join("\n"));
};
const ASKING_TURN = [
  "  - actor: judge", "    reply:", "      tool_calls:", "        - tool: ask_person", "          args:",
  `            question: "Is this right? ${CANARY}: the workstation ws-17.example.net joined the WiFi at this address without a lease."`,
  "            blocking: false", "            why: check",
];
const MATCHING_TURN = ["  - actor: judge", "    reply:", "      content: |", "        {\"matches\": [], \"texts\": []}"];

test("a judge stage that runs an agent with a tool that writes what a later stage reads is refused at load: the improve loop is not usable", async () => {
  s = await served({ before: judgeAgent(["ask_person", "note_memory"], [...ASKING_TURN, ...MATCHING_TURN]) });
  const deps = s.app.hub.deps;
  expect(deps.loops!.current("improve")).toBeNull();
  expect(deps.loops!.problems("improve").join(" | ")).toContain(JUDGE_TOOLS);
  const res = await s.post("/api/improve", { loop: "device-check", case_type: "device-check", tasks: 2, candidates: 3, marking: "TLP:GREEN" });
  expect(res.status).not.toBe(200);
}, 120_000);

test("a Judge that runs an agent with no tools is the only stage whose requests hold a known answer's text or a claim", async () => {
  const errors: unknown[] = [];
  s = await served({ onError: (e) => errors.push(e), before: judgeAgent([], MATCHING_TURN) });
  const t = s;
  for (const task of TASKS) {
    const id = await t.newCase({ loop: "device-check", title: `Device at ${task.address}`, asked: `Which device held ${task.address}?`, why: "sample", starting: [{ type: "address", value: task.address }], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" });
    await t.toPlanGate(id);
    expect((await t.command(id, "accept_plan")).status).toBe(200);
    await t.app.hub.idle();
    expect((await t.command(id, "approve")).status).toBe(200);
    await t.app.hub.idle();
    expect((await t.command(id, "set_known_answer", { product: 1, text: task.text, findings: task.findings, marking: "TLP:GREEN" })).status).toBe(200);
  }
  const res = await t.post("/api/improve", { loop: "device-check", case_type: "device-check", tasks: 2, candidates: 3, marking: "TLP:GREEN" });
  expect(res.status).toBe(200);
  const { id } = (await res.json()) as { id: string };
  expect((await t.command(id, "start_run")).status).toBe(200);
  await t.app.hub.idle();
  const session = t.app.hub.read(id);
  expect(session.state.skipped).toEqual([]);
  expect(errors).toEqual([]);
  const stages = new Set<string>();
  const holding: string[] = [];
  for (const e of session.entries()) {
    if (e.type !== "model.request") continue;
    stages.add(e.stage ?? "");
    const text = new TextDecoder().decode(session.blobs.get(e.payload.messages.blob)).toLowerCase();
    if (text.includes(CANARY)) holding.push(e.stage ?? "");
  }
  // the Judge's model was asked, Reflect's too, and only the Judge's request held the canary
  expect(stages.has("judge")).toBe(true);
  expect(stages.has("reflect")).toBe(true);
  expect(holding.length).toBeGreaterThan(0);
  expect([...new Set(holding)]).toEqual(["judge"]);
}, 300_000);
