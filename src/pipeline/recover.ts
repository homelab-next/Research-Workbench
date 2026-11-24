import type { CaseSession } from "../core/session";
import type { Actor, EntryInput } from "../core/types";

const recovery: Actor = { kind: "system", id: "recovery" };

/**
 * Closes what a stopped process left half done, once, right after a case that was not created in this
 * process is opened: each running query fails as "interrupted" (caused by its query.issued), each running
 * job finishes as failed, each question to your agent with no answer is ended as interrupted, and a running run is marked interrupted. A waiting or paused run is left alone: it
 * is waiting for a person, not for this process. One commit; nothing is written when there is nothing to close.
 */
export function recoverSession(session: CaseSession): { queries: string[]; jobs: string[]; asks: string[]; interrupted: boolean } {
  const result = { queries: [] as string[], jobs: [] as string[], asks: [] as string[], interrupted: false };
  session.commit((state) => {
    const inputs: EntryInput[] = [];
    for (const q of Object.values(state.queries)) {
      if (q.status !== "running") continue;
      result.queries.push(q.id);
      inputs.push({ type: "query.failed", actor: recovery, payload: { query: q.id, error: "interrupted" }, cause: q.issued_seq });
    }
    for (const j of Object.values(state.jobs)) {
      if (j.status !== "running") continue;
      result.jobs.push(j.id);
      inputs.push({ type: "job.finished", actor: recovery, payload: { job: j.id, outcome: "failed" }, job: j.id });
    }
    // a question to your agent whose answer was being written when the process stopped is closed, so it never reads as pending
    for (const t of state.conversation) {
      if (t.answer !== null || t.ended !== null) continue;
      result.asks.push(t.turn);
      inputs.push({ type: "agent.ended", actor: recovery, payload: { asked: t.asked_seq, reason: "interrupted" }, cause: t.asked_seq });
    }
    if (state.run.status === "running") {
      result.interrupted = true;
      inputs.push({ type: "run.interrupted", actor: recovery, payload: {}, run: state.run.id });
    }
    return inputs;
  });
  return result;
}
