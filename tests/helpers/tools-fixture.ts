import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import type { CaseSession } from "../../src/core/session";
import { Workbench } from "../../src/core/workbench";
import type { Actor, Plan, PlanStep, TimeWindow } from "../../src/core/types";
import { execTool, parseCall, TOOL_NAMES } from "../../src/agents/tools";
import type { ToolContext, ToolName, ToolResult } from "../../src/agents/tools";
import { DEFAULT_LIMITS } from "../../src/modules/seeker";
import { sampleRoot } from "./sample-root";

export const agent: Extract<Actor, { kind: "agent" }> = { kind: "agent", id: "researcher-g1", stage: "research", profile: "investigation", model: "s", effort: null, where: "machine" };
export const person: Actor = { kind: "human", id: "analyst" };
export const WINDOW: TimeWindow = { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" };
export const START = "198.51.100.77";

const step = (id: string, subgoal: string, pivot: string, source: string, from: string, to: string, value: string, free: boolean, weight: number, empty: PlanStep["empty_means"], needs: boolean): PlanStep => ({
  id, subgoal, pivot, source, from: { type: from, value }, to, window: WINDOW, needs_window: needs, free, weight, estimate: null, empty_means: empty, warnings: [],
});

export const PLAN = (id: string): Plan => ({
  id, goal: "who is behind the address", window: WINDOW,
  subgoals: [
    { id: "g1", title: "Is it internal", question: "Is the address internal?", steps: ["s1"] },
    { id: "g2", title: "Who talks to it", question: "Which assets talk to it?", steps: ["s2", "s4"] },
    { id: "g3", title: "Reputation", question: "What is its reputation?", steps: ["s3"] },
  ],
  steps: [
    step("s1", "g1", "address_to_asset", "assets", "address", "asset", START, true, 0, "proven-negative", false),
    step("s2", "g2", "address_to_internal_peers", "flows", "address", "address", START, true, 0, "not-seen", true),
    step("s3", "g3", "address_to_verdict", "reputation", "address", "verdict", START, false, 5, "not-seen", false),
    step("s4", "g2", "address_to_asset", "assets", "address", "asset", "", true, 0, "proven-negative", false),
  ],
});

export interface Fixture {
  s: CaseSession; ctx: ToolContext; sample: ReturnType<typeof sampleRoot>;
  call(name: ToolName, args: Record<string, Json>, allowed?: readonly ToolName[]): Promise<ToolResult>;
  close(): void;
}

/** A workbench and a case on the sample root; `accepted` also proposes and accepts a hand-built plan. */
export function fixture(accepted = true): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "tools-"));
  const sample = sampleRoot(dir);
  const wb = Workbench.open(join(dir, "wb"), { onError: () => {} });
  const s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [{ type: "address", value: START }], window: WINDOW, objective: null, marking: "TLP:GREEN" }, person);
  if (accepted) {
    s.commit((_st, ids) => [{ type: "plan.proposed", actor: agent, payload: { plan: PLAN(ids.next("plan")) } }]);
    s.commit(() => [{ type: "plan.accepted", actor: person, payload: { plan: "plan-1", steps: ["s1", "s2", "s3", "s4"], budgets: {} } }]);
  }
  const ctx: ToolContext = { session: s, deps: sample.deps, seeker: sample.seeker, actor: agent, link: { run: null, stage: null, job: null }, draft: null, draft_hash: null, subgoal: null, window: WINDOW, limits: DEFAULT_LIMITS };
  return {
    s, ctx, sample,
    call: (name, args, allowed = TOOL_NAMES) => execTool(ctx, parseCall(allowed, name, JSON.stringify(args))),
    close(): void {
      try { wb.close(); } finally { sample.close(); rmSync(dir, { recursive: true, force: true }); }
    },
  };
}
