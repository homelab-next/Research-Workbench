import { expect, test } from "bun:test";
import type { Entry, Payloads } from "../../src/core/types";
import { stageRecord } from "../../src/web/stagerecord";
import { EntryBuilder } from "../helpers/entries";
import { served } from "../helpers/served";

const blob = (n: string) => ({ blob: n.padEnd(64, "0"), bytes: 10 });
const item = (id: string) => ({ kind: "card", id, title: `Card ${id}`, hash: "a".repeat(64), chars: 20, fixed: false });
const request = (id: string, over: Partial<Payloads["model.request"]> = {}): Payloads["model.request"] =>
  ({ request: id, provider: "scripted", model: "m", effort: null, where: "machine", marking: "TLP:GREEN", pack: [item("c1")], left_out: [], messages: blob("m" + id), tools: [], ...over });
const response = (id: string, over: Partial<Payloads["model.response"]> = {}): Payloads["model.response"] =>
  ({ request: id, response: blob("r" + id), stop: "end", usage: { input: 1, output: 1, reasoning: 0 }, served_by: "m", reasoning: null, ...over });
const agent = { kind: "agent", id: "researcher-g1", stage: "research", profile: "p", model: "m", effort: null, where: "machine" } as const;
const inStage = (stage: string) => ({ stage, run: "run-1", actor: agent });

/** A run with a research stage: started, and the first turn asked. */
function started(): EntryBuilder {
  const b = new EntryBuilder();
  b.add("run.started", { run: "run-1", pipeline: "p", pipeline_hash: "h", stages: [] });
  b.add("stage.started", { stage: "research", attempt: 1 }, inStage("research"));
  return b;
}

test("a stage's turns pair each request with its response, in order, with their tool calls", async () => {
  const s = await served();
  try {
    const id = await s.newCase();
    await s.toPublishGate(id);
    const rec = stageRecord(s.entries(id), "research");
    expect(rec.stage).toBe("research");
    expect(rec.turns.length).toBeGreaterThanOrEqual(2);
    expect(rec.turns.map((t) => t.seq)).toEqual([...rec.turns.map((t) => t.seq)].sort((a, b) => a - b));
    for (const t of rec.turns) {
      expect(t.outcome).toBe("answered");
      expect(t.response).not.toBeNull();
      expect(t.served_by).not.toBeNull();
      expect(t.marking).toBe("TLP:GREEN");
      expect(t.chars).toBe(t.pack.reduce((n, i) => n + i.chars, 0));
      for (const c of t.calls) { expect(c.ok).toBe(true); expect(c.summary).not.toBeNull(); expect(c.why).not.toBe(""); }
    }
    expect(rec.turns.some((t) => t.calls.length > 0)).toBe(true);
    expect(rec.attempts).toBe(1);
    // the checks stage sent the draft back to assemble once, and assemble ran twice
    const assemble = stageRecord(s.entries(id), "assemble");
    expect(assemble.attempts).toBe(2);
    expect(assemble.sendbacks.length).toBe(1);
    expect(assemble.sendbacks[0]).toMatchObject({ from: "checks", to: "assemble", count: 1 });
  } finally { await s.close(); }
});

test("a declined request, a blocked call and a failed response are each recorded as themselves", () => {
  const b = started();
  b.add("model.request", request("r1"), inStage("research"));
  b.add("model.declined", { request: "r1", reason: "the model refused to answer" }, inStage("research"));
  b.add("model.request", request("r2"), inStage("research"));
  b.add("model.response", response("r2", { stop: "error" }), inStage("research"));
  b.add("model.blocked", { stage: "research", marking: "TLP:RED", model: "m", where: "hosted" }, inStage("research"));
  b.add("model.request", request("r3"), inStage("research"));
  b.add("model.response", response("r3", { reasoning: blob("why") }), inStage("research"));
  const rec = stageRecord(b.entries, "research");
  expect(rec.turns.map((t) => t.outcome)).toEqual(["declined", "failed", "answered"]);
  expect(rec.turns[0]!.reason).toBe("the model refused to answer");
  expect(rec.turns[0]!.response).toBeNull();
  expect(rec.turns[2]!.reasoning).toEqual(blob("why"));
  expect(rec.blocked).toEqual([{ marking: "TLP:RED", model: "m", where: "hosted", ts: b.entries[6]!.ts }]);
});

test("left-out parts are kept apart from the pack", () => {
  const b = started();
  b.add("model.request", request("r1", { pack: [item("c1"), item("c2")], left_out: [item("c9")] }), inStage("research"));
  const t = stageRecord(b.entries, "research").turns[0]!;
  expect(t.pack.map((i) => i.id)).toEqual(["c1", "c2"]);
  expect(t.left_out.map((i) => i.id)).toEqual(["c9"]);
});

test("a request with no answer before run.interrupted reads interrupted; with a live run it reads pending", () => {
  const b = started();
  b.add("model.request", request("r1"), inStage("research"));
  expect(stageRecord(b.entries, "research").turns[0]!.outcome).toBe("pending");
  b.add("run.interrupted", {}, { run: "run-1" });
  expect(stageRecord(b.entries, "research").turns[0]!.outcome).toBe("interrupted");
  // a run resumed after the interruption is live again, but the old request is still not going to be answered
  b.add("run.resumed", {}, { run: "run-1" });
  expect(stageRecord(b.entries, "research").turns[0]!.outcome).toBe("interrupted");
  // a ledger that ends with the run finished leaves an open request interrupted too
  const c = started();
  c.add("model.request", request("r1"), inStage("research"));
  c.add("run.finished", { outcome: "stopped" }, { run: "run-1" });
  expect(stageRecord(c.entries, "research").turns[0]!.outcome).toBe("interrupted");
});

test("a tool call with no return before run.interrupted reads interrupted", () => {
  const b = started();
  b.add("model.request", request("r1"), inStage("research"));
  b.add("model.response", response("r1", { stop: "tool_calls" }), inStage("research"));
  b.add("tool.called", { request: "r1", call: "t1", tool: "run_step", args: {}, why: "to see" }, inStage("research"));
  let call = stageRecord(b.entries, "research").turns[0]!.calls[0]!;
  expect(call).toEqual({ call: "t1", tool: "run_step", why: "to see", ok: null, summary: null, open: "pending" });
  b.add("run.interrupted", {}, { run: "run-1" });
  const rec = stageRecord(b.entries, "research");
  call = rec.turns[0]!.calls[0]!;
  expect(call.ok).toBeNull();
  expect(call.open).toBe("interrupted");
  expect(rec.turns[0]!.outcome).toBe("answered");
  b.add("tool.returned", { call: "t1", ok: false, summary: "refused", result: null }, inStage("research"));
  expect(stageRecord(b.entries, "research").turns[0]!.calls[0]).toMatchObject({ ok: false, summary: "refused", open: null });
});

test("upTo cuts the record at that entry", () => {
  const b = started();
  b.add("model.request", request("r1"), inStage("research"));
  b.add("model.response", response("r1"), inStage("research"));
  b.add("model.request", request("r2"), inStage("research"));
  b.add("model.response", response("r2"), inStage("research"));
  expect(stageRecord(b.entries, "research", 3).turns.map((t) => t.outcome)).toEqual(["pending"]);
  expect(stageRecord(b.entries, "research", 4).turns.map((t) => t.outcome)).toEqual(["answered"]);
  expect(stageRecord(b.entries, "research").turns.length).toBe(2);
  expect(stageRecord(b.entries, "research", 2).turns).toEqual([]);
});

test("only the current run's turns are recorded, and other stages' are left out", () => {
  const b = started();
  b.add("model.request", request("r1"), inStage("research"));
  b.add("model.response", response("r1"), inStage("research"));
  b.add("model.request", request("r2"), inStage("frame"));
  b.add("run.finished", { outcome: "stopped" }, { run: "run-1" });
  b.add("run.started", { run: "run-2", pipeline: "p", pipeline_hash: "h", stages: [] });
  expect(stageRecord(b.entries, "research").turns).toEqual([]);
  expect(stageRecord(b.entries, "frame").turns).toEqual([]);
});

test("an odd entry never throws", () => {
  const b = started();
  b.add("model.request", { request: 3 } as unknown as Payloads["model.request"], inStage("research"));
  b.add("tool.called", null as unknown as Payloads["tool.called"], inStage("research"));
  const rec = stageRecord(b.entries as readonly Entry[], "research");
  expect(Array.isArray(rec.turns)).toBe(true);
});
