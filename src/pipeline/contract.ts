/**
 * The engine's contract for a server, in one place.
 *
 * - Commands write entries and never advance the run.
 * - The server calls `advance()` after the commands THEN_ADVANCE marks, and after no others.
 * - `summary()` is the read; it writes nothing.
 * - `session.subscribe` is the entry stream.
 * - Every refusal is a `Refused` (src/core/refused.ts).
 */
export type EngineCommand = "start" | "pause" | "resume" | "stop" | "acceptPlan" | "denyPlan" | "replan" | "revise" | "answerChallenge" | "approve" | "reject" | "feedback" | "setModel" | "setBudget" | "setPackLimit";

/**
 * Whether the server calls `advance()` after the command. `resume` drives by itself; `denyPlan` and `stop` end the run; `answerChallenge`
 * leaves a paused run paused.
 */
export const THEN_ADVANCE: Readonly<Record<EngineCommand, boolean>> = {
  start: true, acceptPlan: true, replan: true, revise: true, approve: true, reject: true,
  pause: false, resume: false, stop: false, denyPlan: false, answerChallenge: false, feedback: false, setModel: false, setBudget: false, setPackLimit: false,
};
