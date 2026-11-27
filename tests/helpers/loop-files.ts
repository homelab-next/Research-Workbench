import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SCRIPTED = { provider: "scripted", model: "sample-run", effort: null };

/** A loop manifest written into the root's loops/ folder as JSON (which is YAML). */
export function writeLoopFile(root: string, id: string, body: Record<string, unknown>): void {
  mkdirSync(join(root, "loops"), { recursive: true });
  writeFileSync(join(root, "loops", `${id}.yaml`), JSON.stringify({ kind: "loop", id, title: id, version: 1, profile: "investigation", entry: "frame", ...body }));
}
/** The two-stage triage loop: Frame, then a stage that runs the investigation loop as a child case. */
export function writeTriage(root: string): void {
  writeLoopFile(root, "triage", {
    title: "Triage", about: "Frame the question, then run an investigation as a child case.",
    stages: [
      { id: "frame", title: "Frame", order: 1, runs: "agent", role: "frame", tools: [], schema: "frame-output", model: SCRIPTED, on_pass: "investigate", on_fail: null },
      {
        id: "investigate", title: "Investigate", order: 2, runs: "loop", role: "subloop", loop: "investigation",
        inputs: { question: "case.question", observables: "case.observables", window: "case.window" },
        returns: { cards: { as: "cards" }, product: { as: "draft_section", section: "assessment" } }, on_pass: null, on_fail: null,
      },
    ],
    outputs: { findings: { from: "findings" } },
  });
}
