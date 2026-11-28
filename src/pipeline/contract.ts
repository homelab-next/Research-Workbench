/**
 * The engine's contract for a server, in one place.
 *
 * - Commands write entries and never advance the run.
 * - The server calls `advance()` after the commands THEN_ADVANCE marks, and after no others.
 * - `summary()` is the read; it writes nothing.
 * - `session.subscribe` is the entry stream.
 * - Every refusal is a `Refused` (src/core/refused.ts).
 */
export type EngineCommand = "start" | "pause" | "resume" | "stop" | "acceptPlan" | "denyPlan" | "replan" | "revise" | "answerChallenge" | "approve" | "reject" | "feedback" | "setModel" | "setBudget" | "setPackLimit" | "rule" | "overrule" | "sendBack"
  | "adoptDecide" | "setKnownAnswer" | "withdrawKnownAnswer";

/**
 * Whether the server calls `advance()` after the command. `overrule` advances as `revise` does. `resume` drives by itself; `denyPlan` and `stop` end the run; `answerChallenge`
 * leaves a paused run paused; `rule` resumes by itself when it was the last open conflict (a ruling holds
 * until it is replaced). `sendBack` (the person's "Send back to Assemble with my changes") advances as `reject` does. `adoptDecide`
 * (a person's decision on the whole candidate at the adopt gate) advances: the decision passes the gate. `setKnownAnswer` and `withdrawKnownAnswer` touch a task case's
 * answers, not its run.
 */
export const THEN_ADVANCE: Readonly<Record<EngineCommand, boolean>> = {
  start: true, acceptPlan: true, replan: true, revise: true, overrule: true, approve: true, reject: true, sendBack: true, adoptDecide: true,
  pause: false, resume: false, stop: false, denyPlan: false, answerChallenge: false, feedback: false, setModel: false, setBudget: false, setPackLimit: false, rule: false,
  setKnownAnswer: false, withdrawKnownAnswer: false,
};
